# PROMPT-ASA-P2-09 — Fail-Closed LLM-Fallback, Drawdown-Alert-Fix, Kern-DB-Indizes & Memory-Caps

- **Befunde:** [`../findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md`](../findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md) (`MEDIUM`), [`../findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md`](../findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md) (`MEDIUM`) & [`../findings/ASA-12-unbounded-memory-maps-dead-session-prune.md`](../findings/ASA-12-unbounded-memory-maps-dead-session-prune.md) (`MEDIUM`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Next.js, Drizzle ORM + PostgreSQL).

AUFGABE: Behebe in einer gebündelten Stabilitäts- und Performance-Session die drei mittleren Audit-Befunde `ASA-10` (LLM-Fallback kauft blind `LONG` + kaputte Einheiten/Peak-Logik in `checkEquityAlerts`), `ASA-11` (fehlende Indizes auf den 6 Kerntabellen, unbegrenzte `positions`-Loads, N+1-Updates & fehlendes `statement_timeout`) und `ASA-12` (nie aufgerufenes `pruneRevokedSessions()`, flüchtige Session-Revocation, unbegrenzte Rate-Limit-Maps & `BitunixExecutionAdapter.openOrders`-Leak).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md`
2. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md`
3. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-12-unbounded-memory-maps-dead-session-prune.md`
4. `src/lib/ollama.ts` (`ask` & `fallbackReason`, Zeilen 250–380), `src/lib/monitor.ts` (Zeilen 310–330, 545–595, 860–915)
5. `src/db/schema.ts` (Zeilen 15–180), `src/db/index.ts`, letzte Dateien in `drizzle/`, `src/lib/signalDecayRuntime.ts` (Zeilen 245–280), `src/app/api/firm/route.ts` (Zeilen 40–75)
6. `src/lib/authSession.ts` (Zeilen 515–635), `src/lib/apiAuth.ts` (Zeilen 145–175), `src/brokers/control-plane/guard.ts` (Zeilen 70–95), `src/brokers/bitunix/execution.ts` (Zeilen 100–305)

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. `ASA-10` — Fail-Closed LLM-Fallback & korrekte Equity-/Drawdown-Alerts:
   - Ändere `fallbackReason()` in `src/lib/ollama.ts` so, dass ein Ausfall/Timeout des LLM-Servers standardmäßig **Fail-Closed** antwortet (`SIGNAL: NEUTRAL`, `VERDICT: REJECT`, `ACTION: HOLD`, mit klarer Begründung `[FALLBACK: LLM unavailable — holding flat]`), statt automatisch `BUY` / `APPROVE` / `TRADE LONG` auszulösen! Prüfe vorher alle `tests/`, ob einzelne Offline-Pipeline-Tests bewusst den synthetischen Demo-Trade-Fallback erwarten, und gib solchen Tests ggf. einen expliziten Test-Hook/Parameter, ohne dass der Produktions-Default jemals blind kauft.
   - Repariere `checkEquityAlerts` in `src/lib/monitor.ts`:
     a) Rechne `const ddPct = broker.drawdownPct * 100` um (da `broker.drawdownPct` im Intervall `0..1` liegt, `DRAWDOWN_THRESHOLDS` aber `[5, 10, 20]` in Prozent sind!).
     b) Überschreibe `getEquityAlertState().peak` in `recordEquitySnapshot` (Zeile 554) NICHT vor dem Aufruf von `checkEquityAlerts`, damit neue Equity-Hochs (`equity > state.peak`) tatsächlich erkannt und erst danach in `state.peak` fortgeschrieben werden.

2. `ASA-11` — Sekundärindizes, Query-Limits, gebündelte Updates & Pool-Timeout:
   - Ergänze in `src/db/schema.ts` Sekundärindizes (`index(...)`) für die 6 Kerntabellen `positions` (`(status, opened_at)`, `(closed_at)`), `agentMessages` (`(run_id, created_at)`, `(created_at)`), `equitySnapshots` (`(recorded_at)`), `auditLog` (`(created_at)`, `(event, created_at)`), `missions` (`(status, created_at)`) und `tradeRules` (`(active, symbol)`), und lege eine passende idempotente append-only SQL-Migration in `drizzle/` (`CREATE INDEX IF NOT EXISTS ...`) gemäß der bestehenden Nummerierungskonvention in `drizzle/` an.
   - Begrenze `refreshDecayFromDb()` in `src/lib/signalDecayRuntime.ts` auf geschlossene Positionen mit sinnvollem Limit (`WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 2000`) statt die gesamte Tabelle ohne Filter zu laden; begrenze ebenso in `GET /api/firm` (`src/app/api/firm/route.ts`) die geladenen geschlossenen Positionen (alle `open`-Positionen + die jüngsten z. B. 200 `closed`-Positionen, bzw. SQL-Aggregation falls Gesamt-Zähler benötigt werden).
   - Ersetze die seriellen `for (... await db.update ...)`-Schleifen in `src/lib/monitor.ts` (Zeilen 318–323 & 574–590) durch gebündelte Updates (`inArray`), wo dieselben Zielspalten gesetzt werden.
   - Setze im `pg.Pool` (`src/db/index.ts`) ein `statement_timeout` (z. B. `15_000` ms) und sanitisiere `ensureDbConnection()`-Fehlermeldungen, damit keine Credentials/Interna aus Connection-Strings in Exceptions nach außen dringen.
   - Führe `npm run docs:inventories` aus, damit `docs/generated/schema-inventory.md` die neue Migration erfasst!

3. `ASA-12` — Speicherobergrenzen & persistente Session-Revocation:
   - Rufe `pruneRevokedSessions()` in `src/lib/authSession.ts` automatisch bei `revokeSession()`, `renewSession()` sowie gedrosselt (z. B. höchstens alle 60 s) in `verifySessionToken()` auf, begrenze `revokedSessions` und `rotatedTokens` mit `MAX_ENTRIES = 10_000` und persistiere aktive Session-Widerrufe zusätzlich über Prozess-Restarts hinweg in einer kompakten Runtime-Datei unter `resolveRuntimePath(...)` (mit atomarem Write + Pruning abgelaufener `exp`-Einträge beim Laden).
   - Begrenze `buckets` in `src/lib/apiAuth.ts` und `rateBuckets` in `src/brokers/control-plane/guard.ts` analog zu `src/lib/loginRateLimit.ts` auf `MAX_BUCKETS = 10_000` inkl. Bereinigung abgelaufener Zeitfenster.
   - Entferne in `BitunixExecutionAdapter` (`src/brokers/bitunix/execution.ts`) abgeschlossene/stornierte Orders (`FILLED`, `CANCELED`, `REJECTED`) in `getOrderStatus()`/`cancelOrder()` aus `this.openOrders` und leere `this.openOrders` nach erfolgreichem `cancelAllOrders()`.

4. Audit-Tracking aktualisieren:
   - Setze `ASA-10`, `ASA-11` und `ASA-12` in ihren Finding-Dateien, `docs/audits/2026-10-27-arch-security-audit/README.md` und `remediation/TRACKING.md` auf `FIXED`.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa10_11_12.stabilityAndMemory.test.ts` für:
   - `fallbackReason` liefert standardmäßig `HOLD` / `REJECT` statt `TRADE LONG`.
   - `checkEquityAlerts` feuert bei 6 %, 11 %, 21 % Drawdown (`drawdownPct = 0.06, 0.11, 0.21`) und erkennt ein neues Equity-Hoch zuverlässig.
   - `revokedSessions` überlebt ein Zurücksetzen des In-Memory-Caches (Reload von Disk) und pruned abgelaufene Tokens.
   - Rate-Limit-Maps bleiben bei > 10.000 eindeutigen Schlüsseln hart unter/auf `MAX_BUCKETS`; `BitunixExecutionAdapter` räumt `openOrders` bei Fill/Cancel ab.
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa10_11_12.stabilityAndMemory.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:inventories && npm run docs:inventories:check`
   - `npm run docs:validate`
   - `npm test`
```
