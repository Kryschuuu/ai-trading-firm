# SEC-07 — Secret-Store fällt bei Fehlern auf Env-Credentials zurück

- **ID:** SEC-07
- **Severity:** MEDIUM
- **Bereich:** Secret Management / Trust Boundary
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-07 — Secret-Store fällt bei Fehlern auf Env-Credentials zurück
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/brokers/control-plane/secretStore.ts`, `src/brokers/bitunix/secrets.ts`, `src/brokers/alpaca/secrets.ts`
- **Peer-Review-Patch:** TBD

## Beschreibung

Der zentrale Control-Plane-Secret-Store ist AES-256-GCM-basiert und grundsätzlich sauber aufgebaut.

Die Bridge für Bitunix (und analog Alpaca) besitzt einen sicherheitsrelevanten Fallback:

```text
Control Plane credential store
        ↓ Fehler / kein Datensatz
Environment credentials
```

`createVenueBackedNamedStore()` fängt einen Fehler des verschlüsselten Stores ab und verwendet anschließend den Env-Fallback. Das wird im Bitunix-Adapter produktiv verwendet (`BITUNIX_API_KEY` / `BITUNIX_API_SECRET`).

Der Control Plane kann damit `configured = false` sagen, während der tatsächliche Broker-Adapter weiterhin Env-Credentials verwendet.

Noch problematischer: ein `AUTH_FAILED` bzw. korruptes Envelope wird nicht zwingend zu einem harten Credential-Stop, sondern kann in den Legacy-Fallback laufen.

Das erzeugt zwei Wahrheiten: **Control Plane ≠ tatsächliche Broker-Credentials.** Echter Trust-Boundary-Bruch.

## Beweis / PoC

```ts
// src/brokers/control-plane/secretStore.ts — createVenueBackedNamedStore()
try {
  const credential = await opts.store.get(opts.venue);
  if (credential) {
    return name === opts.keyName ? credential["apiKey"] : credential["apiSecret"];
  }
} catch {
  // Auth-Fehler/Store nicht bereit → Env-Fallback (task-07-Verhalten).
}
return opts.envFallback.get(name);

// src/brokers/bitunix/secrets.ts
// Fehlt SECRET_STORE_KEY oder der Datensatz, greift der Env-Fallback
```

Szenario: Control-Plane-UI zeigt Venue unkonfiguriert / Envelope korrupt → Adapter handelt trotzdem mit `BITUNIX_API_KEY` aus der Umgebung.

## Remediation (aus Audit + eigene Bewertung)

Produktiv: **kein Credential-Fallback nach Store-Fehlern.**

Zulässige Semantik:

```text
credential exists in secure store → use it
credential absent → no credential
store failure → HARD FAIL
```

Env-Credentials nur in einem expliziten `development/test`-Modus erlauben.

## Akzeptanzkriterien / Tests

- [ ] Store-Fehler (`AUTH_FAILED`, `STORAGE_UNAVAILABLE`) → kein Env-Fallback in Production
- [ ] Fehlender Datensatz → Adapter ohne Credential, nicht stilles Env
- [ ] Control-Plane-`configured` entspricht tatsächlichem Adapter-Verhalten
- [ ] Tests für Bitunix/Alpaca-Secret-Bridge (Fail-closed)
- [ ] Dev/Test-Env-Fallback nur hinter explizitem Flag

## Changelog-Blurb

```
SEC-07 (MEDIUM): Secret-Store — kein Env-Credential-Fallback nach Control-Plane-Fehlern in Produktion
```

## Versions-Hinweis

PATCH, vor weiterem Live-Ausbau.
