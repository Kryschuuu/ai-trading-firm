# SEC-07 — Secret-Store fällt bei Fehlern auf Env-Credentials zurück

- **ID:** SEC-07
- **Severity:** HIGH (urspruenglich MEDIUM, auf HIGH hochgestuft wegen Trust-Boundary-Bruch + AUTH_FAILED → Env-Fallback)
- **Bereich:** Secret Management / Trust Boundary
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-07 — Secret-Store fällt bei Fehlern auf Env-Credentials zurück
- **Status:** FIXED
- **Fix-Version:** 1.36.32
- **Fix-Commit:** arena/01a07843-ai-trading-firm (PR folgt)
- **Datei(en):** `src/brokers/control-plane/secretStore.ts`, `src/brokers/bitunix/secrets.ts`, `src/brokers/alpaca/secrets.ts`, `src/brokers/control-plane/index.ts`
- **Peer-Review-Patch:** SEC-07-env-credential-fallback

## Beschreibung

Der zentrale Control-Plane-Secret-Store ist AES-256-GCM-basiert und grundsätzlich sauber aufgebaut.

Die Bridge für Bitunix (und analog Alpaca) besaß einen sicherheitsrelevanten Fallback:

```text
Control Plane credential store
        ↓ Fehler / kein Datensatz
Environment credentials
```

`createVenueBackedNamedStore()` fing einen Fehler des verschlüsselten Stores ab und verwendete anschließend den Env-Fallback. Das wurde im Bitunix-Adapter produktiv verwendet (`BITUNIX_API_KEY` / `BITUNIX_API_SECRET`).

Der Control Plane konnte damit `configured = false` sagen, während der tatsächliche Broker-Adapter weiterhin Env-Credentials verwendete.

Noch problematischer: ein `AUTH_FAILED` bzw. korruptes Envelope wurde nicht zwingend zu einem harten Credential-Stop, sondern konnte in den Legacy-Fallback laufen.

Das erzeugte zwei Wahrheiten: **Control Plane ≠ tatsächliche Broker-Credentials.** Echter Trust-Boundary-Bruch.

## Root Cause (vor Fix)

- `createVenueBackedNamedStore` catchte **alle** Store-Fehler (inkl. AUTH_FAILED, STORAGE_UNAVAILABLE, INVALID_ENVELOPE, KEY_MISSING) und fiel still auf `envFallback` zurück.
- `createDefault*SecretStore` fiel ohne `SECRET_STORE_KEY` immer auf Env zurück, auch in Produktion.
- Keine Trennung zwischen "fehlender Datensatz" (soll null sein) und "Store-Fehler" (soll HARD FAIL).
- Control-Plane `configured` (existiert Datensatz) entsprach nicht Adapter-Verhalten (Env konnte trotzdem liefern).

## Fix (v1.36.32)

- **Neue Gate-Funktion** `isEnvCredentialFallbackAllowed(env)` — erlaubt Env-Fallback nur wenn `BROKER_ALLOW_ENV_FALLBACK===true` UND `NODE_ENV!=production`.
- **Effektiver Guard** `effectiveAllowEnvFallback = !isProduction && allowEnvFallback===true` — Defense in Depth: in Produktion immer false, selbst wenn Flag gesetzt.
- **Semantik jetzt:**
  - credential exists in secure store → use it
  - credential absent (store.get → null) → no credential (null)
  - store failure (AUTH_FAILED, STORAGE_UNAVAILABLE, INVALID_ENVELOPE, KEY_MISSING, DB-Fehler) → HARD FAIL (throw), im Control-Plane-Flow als 503 SAFE sichtbar
- **Env-Fallback nur expliziter Dev/Test-Modus** mit Flag + Warn-Log `[secretStore] SEC-07: store failure ... falling back to env only because BROKER_ALLOW_ENV_FALLBACK=true and NODE_ENV!=production`.
- **Default-Factories** `createDefaultBitunixSecretStore` / `createDefaultAlpacaSecretStore`: ohne `SECRET_STORE_KEY` und ohne Flag → null-store (fail-closed, kein Credential); mit Flag in Dev/Test → EnvFallback.
- **Control-Plane configured** entspricht jetzt Adapter-Verhalten: beide lesen aus demselben Store, beide liefern null bei fehlendem Datensatz, beide werfen bei Store-Fehler.

## Beweis / PoC (historisch)

```ts
// vor Fix: src/brokers/control-plane/secretStore.ts — createVenueBackedNamedStore()
try {
  const credential = await opts.store.get(opts.venue);
  if (credential) {
    return name === opts.keyName ? credential["apiKey"] : credential["apiSecret"];
  }
} catch {
  // Auth-Fehler/Store nicht bereit → Env-Fallback (task-07-Verhalten).
}
return opts.envFallback.get(name);
```

Szenario: Control-Plane-UI zeigt Venue unkonfiguriert / Envelope korrupt → Adapter handelte trotzdem mit `BITUNIX_API_KEY` aus der Umgebung.

Nach Fix: gleiches Szenario → Adapter liefert null (kein Credential) bzw. wirft HARD FAIL, kein stilles Env.

## Remediation (erfuellt)

Produktiv: **kein Credential-Fallback nach Store-Fehlern.**

Zulässige Semantik (jetzt umgesetzt):

```text
credential exists in secure store → use it
credential absent → no credential
store failure → HARD FAIL
```

Env-Credentials nur in explizitem `development/test`-Modus hinter `BROKER_ALLOW_ENV_FALLBACK=true`.

## Akzeptanzkriterien / Tests

- [x] Store-Fehler (`AUTH_FAILED`, `STORAGE_UNAVAILABLE`) → kein Env-Fallback in Production (HARD FAIL throw)
- [x] Fehlender Datensatz → Adapter ohne Credential (null), nicht stilles Env
- [x] Control-Plane-`configured` entspricht tatsächlichem Adapter-Verhalten (beide null bei fehlendem Datensatz)
- [x] Tests für Bitunix/Alpaca-Secret-Bridge (Fail-closed) — `tests/sec07.envCredentialFallback.test.ts` 19 Faelle
- [x] Dev/Test-Env-Fallback nur hinter explizitem Flag `BROKER_ALLOW_ENV_FALLBACK=true` + `NODE_ENV!=production`

### Neue Tests

- `tests/sec07.envCredentialFallback.test.ts`:
  - isEnvCredentialFallbackAllowed truth table
  - Bitunix AUTH_FAILED → HARD FAIL
  - Alpaca STORAGE_UNAVAILABLE → HARD FAIL
  - INVALID_ENVELOPE → HARD FAIL
  - fehlender Datensatz Bitunix/Alpaca → null
  - Control-Plane configured == Adapter (Bitunix/Alpaca)
  - Dev ohne Flag → kein Fallback
  - Dev mit Flag → Fallback erlaubt
  - Prod mit Flag → trotzdem kein Fallback (Defense in Depth)
  - Dev mit Flag + Store-Fehler → Fallback erlaubt (expliziter Dev-Komfort)
  - createDefault* ohne SECRET_STORE_KEY ohne Flag → kein Credential
  - createDefault* ohne SECRET_STORE_KEY mit Flag in Dev → Env
  - Angriff: korrumpiertes Envelope → HARD FAIL, nicht Env
  - Angriff: gelöschtes Credential → null, nicht Env
  - Angriff: Angreifer setzt Env-Vars in Prod → ignoriert
- `tests/secretStore.test.ts` erweitert um 5 SEC-07 Faelle
- `tests/bitunix.unit.test.ts` / `tests/alpaca.unit.test.ts` korrigiert: vorher erwarteten sie stillen Fallback, jetzt fail-closed

## Changelog-Blurb

```
SEC-07 (HIGH): Secret-Store — kein Env-Credential-Fallback nach Control-Plane-Fehlern in Produktion; Env nur noch explizit in Dev/Test hinter BROKER_ALLOW_ENV_FALLBACK=true
```

## Versions-Hinweis

PATCH 1.36.32, vor weiterem Live-Ausbau. Keine neue Abhaengigkeit, minimale Datei-Aenderungen, klare Security-Kommentare.

## Referenzen

- Commit: arena/01a07843-ai-trading-firm branch (dieser Fix)
- PR: wird bei Erstellung verlinkt
- Tracking: `docs/audits/2026-09-05-security-review-gpt01/TRACKING.md` (falls vorhanden)
