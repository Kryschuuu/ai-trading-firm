# ASA-03 — Alpaca-Live-Adapter ist bei Positionsabfragen Fail-Open (`safeGetPositions` liefert `[]`, `verifyFlat()` meldet fälschlich `true`)

- **ID:** ASA-03
- **Severity:** CRITICAL
- **Bereich:** Sicherheit / Live-Execution-Zuverlässigkeit
- **Status:** OPEN
- **Datei(en):** `src/brokers/alpaca/execution.ts:154-175`, `src/brokers/alpaca/execution.ts:269-280`, `src/brokers/alpaca/execution.ts:296-316`, `src/brokers/alpaca/http.ts:201-225`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md`](../prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md)

## Beschreibung

`AlpacaExecutionAdapter.safeGetPositions()` schluckt sämtliche Netzwerk-, Timeout-, Rate-Limit- (`429`) und API-Fehler zu einem leeren Array `[]`. Dadurch arbeiten Konto-Risikoprüfung, Notfall-Glattstellung (`closeAllPositions`) und Glattstellungs-Verifikation (`verifyFlat`) im Fehlerfall **Fail-Open**.

## Technischer Nachweis

1. `safeGetPositions()` (`src/brokers/alpaca/execution.ts:269-280`) fängt jeden Fehler in `catch` ab und gibt `[]` zurück.
2. `getAccount()` (Zeile 171) setzt `openPositions: positions.length` und meldet bei API-Störung `0` offene Positionen.
3. `closeAllPositions()` (Zeile 296–305) ruft zuerst `const before = await this.getPositions()` auf und führt `DELETE /v2/positions` **nur** aus, wenn `before.length > 0` gilt. Schlägt der `GET` fehl, unterbleibt der Notfall-Close real offener Positionen komplett (`closedCount: 0, remainingOpen: 0`).
4. `verifyFlat()` (Zeile 312–315) gibt `(await this.getPositions()).length === 0` zurück — also `true` bei jedem Ausfall von `GET /v2/positions`.
5. `AlpacaHttp.request()` (`src/brokers/alpaca/http.ts:206-210`) ignoriert `Retry-After` bei `429` und wiederholt alle Methoden gleichermaßen ohne Idempotenzprüfung.

## Konkreter Lösungsvorschlag

```diff
--- a/src/brokers/alpaca/execution.ts
+++ b/src/brokers/alpaca/execution.ts
@@ -295,18 +295,15 @@ export class AlpacaExecutionAdapter implements ExecutionPort {
   async closeAllPositions(): Promise<CloseAllReport> {
     await this.cancelAllOrders().catch(() => undefined);
-    const before = await this.getPositions();
-    if (before.length > 0) {
-      await this.http.request<unknown>("DELETE", "/v2/positions", {
-        query: { cancel_orders: "true" },
-      });
-    }
-    const after = await this.getPositions();
+    const before = await this.fetchPositionsStrict().catch(() => null);
+    await this.http.request<unknown>("DELETE", "/v2/positions", {
+      query: { cancel_orders: "true" },
+    });
+    const after = await this.fetchPositionsStrict();
     return {
       venue: "alpaca",
-      closedCount: Math.max(0, before.length - after.length),
+      closedCount: before ? Math.max(0, before.length - after.length) : 0,
       remainingOpen: after.length,
     };
   }
```

- `safeGetPositions()` komplett durch `fetchPositionsStrict()` ersetzen, das `BrokerError` unverändert propagiert.
- `verifyFlat()` nutzt `fetchPositionsStrict()` und wirft bei API-Fehler (oder gibt gemäß Port-Vertrag `false` zurück — niemals `true` bei unbekanntem Zustand; Vertrag mit `BitunixExecutionAdapter` vereinheitlichen).
- `AlpacaHttp` parst `Retry-After` (Sekunden & HTTP-Date, gedeckelt auf max. Timeout) und wiederholt `POST` nur dann, wenn eine deterministische `client_order_id` gesetzt ist.

## Akzeptanzkriterien / Verifikation

- [ ] Wirft `GET /v2/positions` HTTP `503` oder `429`, schlagen `getAccount()` und `getPositions()` mit `BrokerError` fehl statt `0` / `[]` zu melden.
- [ ] `closeAllPositions()` sendet `DELETE /v2/positions?cancel_orders=true` auch dann, wenn der optionale Vorab-`GET` mit `429`/`500` fehlschlägt.
- [ ] `verifyFlat()` liefert bei fehlerhaftem `GET /v2/positions` niemals `true`.
- [ ] `AlpacaHttp` respektiert `Retry-After` bei `429` und wiederholt kein `POST` ohne `client_order_id`.
- [ ] Regressionstest `tests/asa03.alpacaFailClosed.test.ts` + `tests/brokerContracts.test.ts` grün.
