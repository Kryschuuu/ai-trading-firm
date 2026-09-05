# SEC-09 — Memory-Hygiene schützt JS-Strings nicht wirklich

- **ID:** SEC-09
- **Severity:** LOW
- **Bereich:** Kryptographie / Secret Management
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-09 — Memory-Hygiene schützt JS-Strings nicht wirklich
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `src/brokers/control-plane/secretStore.ts`, `docs/FRONTEND_CONTROL_PLANE.md`
- **Peer-Review-Patch:** TBD — verlinken sobald Patch in `docs/peer-reviews/` existiert

## Beschreibung

Der Secret Store bemüht sich ausdrücklich um `Buffer`-basierte Secret-Verarbeitung und `zeroize()`. Das ist positiv.

Die Dokumentation und der Dateikopf von `secretStore.ts` behaupten jedoch:

> Memory-Hygiene: Secret-Buffer werden nach Nutzung genullt (zeroize), es entstehen keine langlebigen Strings.

Das ist in JavaScript nur teilweise wahr. Der Parse-Pfad erzeugt immutable Strings:

```ts
plaintext.toString("utf8")
```

und gibt anschließend ein Objekt mit JS-Strings zurück:

```ts
return {
  apiKey: parsed.apiKey,
  apiSecret: parsed.apiSecret
}
```

Diese Strings sind unveränderlich und können nicht deterministisch überschrieben werden. Dasselbe gilt für Credentials, die danach im normalen JS-Heap existieren (Adapter, Env-Fallback, Probe).

**Kein sinnvoller Remote-Angriffspfad.** Relevant wird es bei Heap-Dump, Crash-Dumps, Debugging, Process Compromise und forensischem Speicherzugriff.

## Beweis / PoC

```ts
// src/brokers/control-plane/secretStore.ts — parseCredentialPlaintext()
const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret };

// AesGcmSecretStore.get() gibt dieses Objekt an Aufrufer weiter.
// createVenueBackedNamedStore() reicht apiKey/apiSecret als string an Adapter.
```

Erwartete Doku: Klartext existiert nach `get()` als JS-String im Heap.  
Tatsächliche Doku: „es entstehen keine langlebigen Strings.“

## Remediation (aus Audit + eigene Bewertung)

1. Vorhandene Buffer-Hygiene (`zeroize` auf IV/Tag/CT/Key/Plaintext-Buffer) **beibehalten**.
2. Die Behauptung „Klartext existiert nicht als langlebiger String“ aus Code-Kommentaren und `docs/FRONTEND_CONTROL_PLANE.md` entfernen bzw. korrekt einschränken.
3. Zusätzlich betrieblich:
   - Heap Dumps deaktivieren,
   - Debug Inspector nicht exponieren,
   - Core Dumps minimieren,
   - Credentials möglichst kurzlebig halten (sofort nach Probe verwerfen).

## Akzeptanzkriterien / Tests

- [ ] Dokumentation/Kommentare behaupten nicht mehr, JS-Strings seien genullt
- [ ] `zeroize()` bleibt auf allen Krypto-Buffern erhalten
- [ ] Secret-Store-Tests grün (`secretStore` / Control-Plane)
- [ ] Betriebs-Hinweise (kein Inspector, keine Core Dumps) in Security-Docs

## Changelog-Blurb

```
SEC-09 (LOW): Secret-Memory-Hygiene — Doku korrigiert; Buffer-zeroize bleibt, JS-String-Limit dokumentiert
```

## Versions-Hinweis

PATCH, Dokumentation / Hardening.
