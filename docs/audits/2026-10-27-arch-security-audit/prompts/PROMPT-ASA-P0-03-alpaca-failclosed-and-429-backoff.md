# PROMPT-ASA-P0-03 — Alpaca-Live-Adapter Fail-Closed machen & HTTP-429/Retry-Idempotenz härten

- **Befund:** [`../findings/ASA-03-alpaca-fail-open-positions-verify-flat.md`](../findings/ASA-03-alpaca-fail-open-positions-verify-flat.md) (`CRITICAL`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Broker-Adapter-Architektur unter `src/brokers/*`).

AUFGABE: Behebe vollständig den kritischen Live-Execution-Befund `ASA-03` (Fail-Open-Positionsabfragen über `safeGetPositions()` im Alpaca-Adapter, übersprungener Notfall-Close bei Rate-Limit/Netzwerkfehler, falsch-positives `verifyFlat() === true` sowie fehlende `Retry-After`- und Idempotenz-Beachtung in `AlpacaHttp`).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-03-alpaca-fail-open-positions-verify-flat.md`
2. `src/brokers/alpaca/execution.ts` (insb. `getAccount` Zeilen 154–175, `getPositions` / `safeGetPositions` Zeilen 265–285, `closeAllPositions` & `verifyFlat` Zeilen 295–318)
3. `src/brokers/alpaca/http.ts` (insb. Retry-Schleife Zeilen 175–235)
4. Zum Vergleich des Port-Vertrags: `src/brokers/ports.ts`, `src/brokers/bitunix/execution.ts` und bestehende Tests `tests/alpaca*.test.ts`, `tests/brokerContracts.test.ts`

WARUM DER FEHLER KRITISCH IST:
- `safeGetPositions()` fängt in `src/brokers/alpaca/execution.ts:269-280` jeden Fehler ab und gibt `[]` zurück.
- Bei HTTP `429`, `503` oder Timeout meldet `getAccount()` `openPositions: 0`, `closeAllPositions()` überspringt wegen `if (before.length > 0)` das lebenswichtige `DELETE /v2/positions?cancel_orders=true` komplett, und `verifyFlat()` gibt `true` zurück („Konto ist glattgestellt“), obwohl reale Live-Positionen weiter offen sind.
- `AlpacaHttp` ignoriert bei HTTP `429` den `Retry-After`-Header und wiederholt auch nicht-idempotente `POST`-Requests ohne `client_order_id`.

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. Fail-Closed-Positionsabfragen in `src/brokers/alpaca/execution.ts`:
   - Entferne `safeGetPositions()` vollständig und ersetze es durch eine strikte Methode `fetchPositionsStrict()`, die HTTP-/Validierungsfehler als `BrokerError` unverfälscht durchreicht.
   - `getPositions()` und `getAccount()` müssen `fetchPositionsStrict()` verwenden, sodass `getAccount()` bei gestörtem Positions-Endpunkt fehlschlägt statt `openPositions: 0` vorzutäuschen.
   - `closeAllPositions()`:
     a) versuche `cancelAllOrders()` best-effort (Fehler protokollieren/merken, aber Ablauf nicht abbrechen),
     b) versuche optional `before = await fetchPositionsStrict().catch(() => null)` nur für die Zählstatistik,
     c) sende **unbedingt immer** `DELETE /v2/positions` mit `{ query: { cancel_orders: "true" } }` (beachte dabei auch den Alpaca-Fall HTTP `207 Multi-Status` bzw. leere Liste sauber),
     d) rufe anschließend `const after = await this.fetchPositionsStrict()` auf — schlägt die Nachkontrolle fehl, muss `closeAllPositions()` werfen (niemals `remainingOpen: 0` behaupten!).
   - `verifyFlat()`:
     Prüfe den `ExecutionPort`-Vertrag in `src/brokers/ports.ts` und `tests/brokerContracts.test.ts`: `verifyFlat()` darf bei einem Fehler von `fetchPositionsStrict()` **niemals** `true` zurückgeben (je nach Port-Vertrag Fehler werfen oder `false` liefern — prüfe die bestehenden Contract-Tests und verhalte dich konsistent zu `BitunixExecutionAdapter`).

2. `Retry-After` & sichere Retry-Idempotenz in `src/brokers/alpaca/http.ts`:
   - Werte bei HTTP `429` (und optional `503`) den Response-Header `Retry-After` aus (sowohl ganzzahlige/dezimal-Sekunden als auch HTTP-Date-Format), begrenzt durch eine sinnvolle Obergrenze (`maxRetryDelayMs`, z. B. 10_000 ms, konfigurierbar über die `AlpacaHttp`-Optionen für schnelle Unit-Tests).
   - Wiederhole bei Netzwerk-/Timeout-/5xx-Fehlern automatisch nur idempotente Anfragen (`GET`, `DELETE`) ODER `POST`-Anfragen, bei denen im Body nachweislich ein nicht-leeres `client_order_id` gesetzt ist (sodass Alpaca Duplikate serverseitig ablehnt). Ein `POST` ohne Idempotenzschlüssel darf bei unklarem Ausgang (Timeout nach Verbindungsaufbau) nicht blind erneut gesendet werden.

3. Audit-Tracking aktualisieren:
   - Setze `ASA-03` in `docs/audits/2026-10-27-arch-security-audit/findings/ASA-03-alpaca-fail-open-positions-verify-flat.md`, `README.md`, `remediation/TRACKING.md` und `docs/security/README.md` auf `FIXED`.

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa03.alpacaFailClosed.test.ts` (mit gemocktem `fetch`) und teste:
   - `GET /v2/positions` antwortet mit `503` oder `429` -> `getPositions()` und `getAccount()` werfen `BrokerError`; `verifyFlat()` liefert niemals `true`.
   - Vorab-`GET /v2/positions` schlägt mit `429` fehl, `DELETE /v2/positions` + Nach-`GET /v2/positions` (`[]`) gelingen -> `closeAllPositions()` hat `DELETE /v2/positions?cancel_orders=true` tatsächlich aufgerufen!
   - Nach-`GET /v2/positions` schlägt nach `DELETE` fehl -> `closeAllPositions()` wirft `BrokerError`.
   - `AlpacaHttp` wartet bei `429` + `Retry-After: 1` mindestens die angeforderte Backoff-Dauer ab; `POST` ohne `client_order_id` wird bei Timeout nicht blind gedoppelt, `POST` mit `client_order_id` hingegen darf kontrolliert wiederholt werden.
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa03.alpacaFailClosed.test.ts`
   - `npx tsx --test tests/alpaca*.test.ts tests/brokerContracts.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run docs:validate`
   - `npm test`
```
