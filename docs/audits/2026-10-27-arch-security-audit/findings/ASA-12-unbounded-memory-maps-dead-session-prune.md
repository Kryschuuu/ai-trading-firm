# ASA-12 — Unbegrenzte In-Memory-Maps, nie aufgerufenes `pruneRevokedSessions()` und nicht persistierte Session-Revocation

- **ID:** ASA-12
- **Severity:** MEDIUM
- **Bereich:** Performance / Zuverlässigkeit & Sicherheit
- **Status:** OPEN
- **Datei(en):** `src/lib/authSession.ts:520-630`, `src/lib/apiAuth.ts:152-170`, `src/brokers/control-plane/guard.ts:75-85`, `src/brokers/bitunix/execution.ts:106, 183, 217-296`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md`](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md)

## Beschreibung

Mehrere langlebige In-Memory-Maps wachsen im Dauerbetrieb ohne Obergrenze oder Bereinigung; zusätzlich geht die Liste widerrufener Browser-Sessions bei jedem Neustart des Web-Prozesses verloren.

## Technischer Nachweis

1. `pruneRevokedSessions()` (`src/lib/authSession.ts:560`) hat im gesamten `src/` keinen einzigen Produktions-Aufrufer; `revokedSessions` und `rotatedTokens` wachsen unbegrenzt. Da `revokedSessions` nur im RAM liegt, akzeptiert `verifySessionToken()` nach einem Service-Restart zuvor per Logout widerrufene Cookies bis zum regulären `exp` (8 h) erneut.
2. `buckets` in `src/lib/apiAuth.ts:152-170` und `rateBuckets` in `src/brokers/control-plane/guard.ts:75-85` besitzen im Gegensatz zu `src/lib/loginRateLimit.ts` weder `MAX_BUCKETS` noch periodisches Pruning abgelaufener Fenster.
3. `BitunixExecutionAdapter.openOrders` (`src/brokers/bitunix/execution.ts:106, 183`) fügt jede platzierte Order hinzu, löscht sie aber weder bei `FILLED`/`CANCELED` in `getOrderStatus()` noch in `cancelAllOrders()`.

## Konkreter Lösungsvorschlag

- `pruneRevokedSessions()` automatisch bei `revokeSession()`, `renewSession()` und gedrosselt (z. B. alle 60 s) in `verifySessionToken()` ausführen, auf `MAX_REVOKED = 10_000` deckeln und Revocations zusätzlich in einer kompakten Runtime-JSON-/DB-Ablage über Prozess-Restarts hinweg erhalten.
- `buckets` (`apiAuth.ts`) und `rateBuckets` (`control-plane/guard.ts`) auf `MAX_BUCKETS = 10_000` mit abgelaufenem Fenster-Sweep + ältester Eintrags-Eviction begrenzen.
- In `BitunixExecutionAdapter` abgeschlossene Orders (`FILLED`, `CANCELED`, `REJECTED`) aus `this.openOrders` löschen und `this.openOrders.clear()` in `cancelAllOrders()` nach erfolgreichem Cancel ausführen.

## Akzeptanzkriterien / Verifikation

- [ ] Ein ausgeloggtes Session-Token bleibt auch nach Re-Initialisierung des In-Memory-Caches / Neustart ungültig.
- [ ] Rate-Limit-Maps überschreiten unter simulierten 20.000 eindeutigen Schlüsseln niemals `MAX_BUCKETS`.
- [ ] `BitunixExecutionAdapter.openOrders` leert abgeschlossene und stornierte Orders zuverlässig.
