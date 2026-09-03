# B1 — Bitunix akzeptiert ungültige SL/TP-Geometrien

- **Severity:** HIGH
- **Bereich:** Brokers & Venues
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/brokers/bitunix/orders.ts` (`serializePlaceOrder`)

## Arena-Prompt (kopierbar)

```
TASK: Validate stop-loss / take-profit geometry in the Bitunix order serializer.

PROBLEM: orders.ts only checks finitePositive(req.stopLoss) / finitePositive(req.takeProfit). It does
not verify they are on the correct side of the entry. A formally positive but semantically wrong SL/TP
could be sent to the venue.

DO (in serializePlaceOrder, before building the body):
  const entry = finitePositive(req.limitPrice) ? req.limitPrice! : req.markPriceHint;
  // For MARKET orders there is no fixed entry; accept a mark-price hint or skip geometry when absent.
  if (req.side === "LONG") {
    if (req.stopLoss !== undefined && entry !== undefined && req.stopLoss >= entry)
      throw new OrderSerializationError("LONG stopLoss muss unter dem Entry liegen");
    if (req.takeProfit !== undefined && entry !== undefined && req.takeProfit <= entry)
      throw new OrderSerializationError("LONG takeProfit muss über dem Entry liegen");
  } else { // SHORT
    if (req.stopLoss !== undefined && entry !== undefined && req.stopLoss <= entry)
      throw new OrderSerializationError("SHORT stopLoss muss über dem Entry liegen");
    if (req.takeProfit !== undefined && entry !== undefined && req.takeProfit >= entry)
      throw new OrderSerializationError("SHORT takeProfit muss unter dem Entry liegen");
  }
  Prefer the quote/mark price (passed via req) when limitPrice is absent, since market orders have no
  fixed entry. Document the rule in docs/BITUNIX.md.
3. Add unit tests: LONG sl=entry+1 -> error; LONG tp=entry-1 -> error; correct geometry -> ok.

ACCEPTANCE: Invalid side-consistent SL/TP are rejected at serialization; the engine path still produces
correct values (regression), but the adapter never assumes callers are correct.
```

## Beweis (aktueller Code)

`src/brokers/bitunix/orders.ts`:

```ts
if (finitePositive(req.takeProfit)) { body.tpPrice = String(req.takeProfit); ... }
if (finitePositive(req.stopLoss))  { body.slPrice = String(req.stopLoss);  ... }
// Keine Prüfung von stopLoss < entry (LONG) / stopLoss > entry (SHORT) etc.
```

## Fix-Spezifikation

Geometrie-Check relativ zum Entry (limitPrice bzw. Mark/Quote bei Market-Orders) (siehe Audit B1).

## Akzeptanzkriterien / Tests

- [ ] LONG `stopLoss >= entry` → `OrderSerializationError`.
- [ ] LONG `takeProfit <= entry` → `OrderSerializationError`.
- [ ] SHORT entsprechend gespiegelt.
- [ ] Korrekte Geometrie wird akzeptiert (Regression des Engine-Pfads).

## Changelog-Blurb

`B1 (HIGH): Bitunix akzeptierte semantisch falsche SL/TP — Geometrie-Check (SL/TP relativ zum Entry)
in serializePlaceOrder; Adapter vertraut nicht auf korrekte Caller.`

## Versions-Hinweis

PATCH (`1.36.3`) — Validierungs-Härtung, keine API-Änderung.
