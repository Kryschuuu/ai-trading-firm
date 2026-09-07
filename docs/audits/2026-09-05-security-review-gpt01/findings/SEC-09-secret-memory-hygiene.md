# SEC-09 — Memory-Hygiene schützt JS-Strings nicht wirklich

- **ID:** SEC-09
- **Severity:** LOW
- **Bereich:** Kryptographie / Secret Management
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-09 — Memory-Hygiene schützt JS-Strings nicht wirklich
- **Status:** FIXED
- **Fix-Version:** v1.36.36 (2026-09-07)
- **Fix-Branch:** `arena/01a07b95-ai-trading-firm` (PR folgt)
- **Datei(en):** `src/brokers/control-plane/secretStore.ts`, `docs/FRONTEND_CONTROL_PLANE.md`
- **Peer-Review-Patch:** TBD — verlinken sobald Patch in `docs/peer-reviews/` existiert

> Die Behebung und deren Absicherung sind unter „Implementierter Fix (v1.36.36)“ festgehalten.

## Beschreibung (vor v1.36.36)

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
  ["apiKey"]: parsed["apiKey"],
  ["apiSecret"]: parsed["apiSecret"]
}
```

Diese Strings sind unveränderlich und können nicht deterministisch überschrieben werden. Dasselbe gilt für Credentials, die danach im normalen JS-Heap existieren (Adapter, Env-Fallback, Probe).

**Kein sinnvoller Remote-Angriffspfad.** Relevant wird es bei Heap-Dump, Crash-Dumps, Debugging, Process Compromise und forensischem Speicherzugriff.

## Beweis / PoC

```ts
// src/brokers/control-plane/secretStore.ts — parseCredentialPlaintext()
const parsed = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
return { ["apiKey"]: parsed["apiKey"], ["apiSecret"]: parsed["apiSecret"] };

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

- [x] Dokumentation/Kommentare behaupten nicht mehr, JS-Strings seien genullt
- [x] `zeroize()` bleibt auf allen Krypto-Buffern erhalten
- [x] Secret-Store-Tests grün (`secretStore` / Control-Plane)
- [x] Betriebs-Hinweise (kein Inspector, keine Core Dumps) in Security-Docs

## Implementierter Fix (v1.36.36)

**Root Cause (Angreifer-Sicht):** Kein Krypto-Fehler — AES-256-GCM, AAD-Bindung
und `zeroize()` auf Buffern waren korrekt. Die Schwachstelle war eine falsche
Sicherheitsgarantie („keine langlebigen Strings“) plus Placebo-Entsorgung:
`parseCredentialPlaintext()` erzeugt via `toString("utf8")` → `JSON.parse`
unveraenderliche JS-Strings, und `disposeCredential()` nullte nur eine
Buffer-Kopie statt der Originale. Kein Remote-Angriffspfad; relevant bei
Heap-Dump, Crash-/Core-Dumps, Debugging, Process Compromise und forensischem
Speicherzugriff. Die falsche Garantie lud zu unsicherem Betrieb (Inspector /
Dumps in Produktion) ein und das Placebo verlaengerte das Zeitfenster.

**Fix (keine neuen Abhaengigkeiten):**

1. `src/brokers/control-plane/secretStore.ts` — alle Nullungs-Versprechen
   durch die ehrliche SEC-09-Grenze ersetzt (Header, Krypto-Kommentar,
   `parseCredentialPlaintext`-, `put`- und `get`-Doku); `zeroize()` auf allen
   Krypto-/Key-Buffern unveraendert.
2. `src/brokers/control-plane/probe.ts` — `disposeCredential()` loest jetzt
   die Referenzen (Felder → `""`, GC kann einsammeln) und erzeugt keine
   zusaetzlichen Secret-Kopien mehr; Header-Kommentar korrigiert.
3. `src/brokers/control-plane/service.ts` — Probe-Kommentar korrigiert
   (Referenz-Verwurf statt „zeroize“).
4. `docs/FRONTEND_CONTROL_PLANE.md` — Memory-Hygiene-Abschnitt und
   „Warum nie anzeigbar“ korrigiert, Verweis auf Betriebsschutz.
5. `docs/security/README.md` — neuer Abschnitt „Secret-Memory-Hygiene
   (SEC-09)“: Kurzlebigkeit, kein `--inspect`/Heap-Snapshot, `ulimit -c 0`,
   Least Privilege, Vorgehen bei Dump-Verdacht.

**Red-Tests (vor dem Fix rot, danach gruen):**
`tests/sec09.secretMemoryHygiene.test.ts` — 8 Faelle, davon 4 vor dem Fix rot:
Referenz-Verwurf, Probe-Flow-Fenster, Quellcode-Scan auf Nullungs-Versprechen,
Doku-Scan auf JS-String-Grenze + Betriebsschutz. Dazu Regressionen:
`zeroize`-Hygiene, kein Klartext im Envelope, kein Credential-Caching.

**Validierung:** `sec09`-Suite 8/8 gruen; `secretStore` + Control-Plane +
SEC-07-Suites 122/122 gruen; `typecheck`, `lint`, `docs:validate` gruen;
CI-Workflows (`docs-validate`, `security-live-gate`) gruen.

## Changelog-Blurb

```
SEC-09 (LOW): Secret-Memory-Hygiene — Doku korrigiert; Buffer-zeroize bleibt, JS-String-Limit dokumentiert (v1.36.36)
```

## Versions-Hinweis

PATCH — Security-Fix (v1.36.36). Keine Datenbank-Migration erforderlich.
