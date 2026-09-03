# H3 — Live-Order wird als FILLED gemeldet, obwohl kein Fill vorliegt

- **Severity:** CRITICAL
- **Bereich:** Handelslogik / Broker
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/brokers/bitunix/execution.ts` (`BrokerExecutionEngine.submit` L142‑152),
  `src/contracts/broker.ts` (`BrokerOrderStatus` L204)

## Arena-Prompt (kopierbar)

```
TASK: Stop reporting live Bitunix orders as FILLED before a fill exists.

PROBLEM: BrokerExecutionEngine.submit does:
    const { orderId } = await this.privateClient.placeSerializedOrder(body);
    return { orderId, qty: req.qty, fillPrice: 0, status: "FILLED", ... };
A venue-accepted order is NOT a fill. Reporting FILLED + fillPrice:0 means downstream
bookkeeping can adopt a real position with entry price 0.

DO:
1. In src/contracts/broker.ts change:
     export type BrokerOrderStatus = "FILLED" | "REJECTED";
   to:
     export type BrokerOrderStatus =
       | "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "UNKNOWN";
   Keep "REJECTED" for the reject() path; paper engine may still return "FILLED" (synchronous sim).
2. In src/brokers/bitunix/execution.ts, return the ACCEPTANCE, not a fill:
     return { orderId, symbol, side, qty, fillPrice: 0, status: "NEW",
              stopLoss, takeProfit, reason: "ORDER_ACCEPTED" };
3. Add fill reconciliation: extend BitunixPrivateClient with
     getOrder(orderId): Promise<{ status, filledQty, avgPrice } | null>
     getExecutions(symbol?): Promise<Fill[]>
   and add BrokerExecutionEngine.reconcile(orderId) that fetches status/fills and returns a
   BrokerOrderResult with the REAL fillPrice/qty/status (NEW -> PARTIALLY_FILLED -> FILLED).
4. Wire reconciliation into the monitor/portfolio sync (where positions are adopted) so a
   position is only booked with a real avgPrice, never 0.
5. Update all consumers of BrokerOrderResult.status to handle the new union (Pattern: switch).

ACCEPTANCE: A placed live order returns status "NEW" with fillPrice 0; positions are only
booked after reconcile returns a real avgPrice. Unit test: submit() returns NEW; reconcile()
maps venue PARTIALLY_FILLED -> PARTIALLY_FILLED.
```

## Beweis (aktueller Code)

`src/brokers/bitunix/execution.ts` L142‑152:

```ts
const { orderId } = await this.privateClient.placeSerializedOrder(body);
return {
  orderId, symbol: req.symbol.toUpperCase(), side: req.side, qty: req.qty,
  // synchrone Rückgabe-Fill ist hier nicht verfügbar → 0, Status FILLED
  fillPrice: 0, status: "FILLED", stopLoss: req.stopLoss ?? null,
  takeProfit: req.takeProfit ?? null,
};
```

## Fix-Spezifikation

Status-Vertrag erweitern, `submit` liefert nur `NEW`, Fill-Daten danach über
`getOrder`/`getExecutions`/WebSocket abgleichen (siehe Audit H3-Fix-Skizze).

## Akzeptanzkriterien / Tests

- [ ] `submit()` live → `status:"NEW"`, `fillPrice:0`, gültige `orderId`.
- [ ] `reconcile()` übernimmt echten `avgPrice` (kein 0-Entry).
- [ ] Consumer handeln `NEW | PARTIALLY_FILLED | CANCELED | UNKNOWN`.

## Changelog-Blurb

`H3 (CRITICAL): Live-Order fälschlich als FILLED gemeldet — Status-Vertrag getrennt (NEW/…),
Fill-Reconciliation via getOrder/getExecutions; Positionen nur mit echtem avgPrice.`

## Versions-Hinweis

Contract-Änderung (neue Status) → PATCH (`1.36.3`), abwärtskompatibel (paper bleibt FILLED).
