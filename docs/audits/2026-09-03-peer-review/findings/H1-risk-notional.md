# H1 — Risk-Notional ≠ tatsächliche Ausführungskosten

- **Severity:** CRITICAL
- **Bereich:** Handelslogik
- **Status (validiert):** ✅ **Bereits gefixt** in **v1.36.2** (siehe `CHANGELOG.md` `[1.36.2]` und `docs/CHANGELOG.md`).
- **Datei(en):** `src/lib/broker.ts` (`PaperBroker.submit`), `src/brokers/bitunix/execution.ts` (`BrokerExecutionEngine.submit`)

## Arena-Prompt (kopierbar)

```
TASK: Verify & regression-test the H1 risk-notional fix in the ai-trading-firm repo.

CONTEXT: Audit claimed `Order.riskNotional` (qty×price) was trusted as a guardrail
input while actual debit was `qty×fillPrice + fees`, allowing a client to send
`riskNotional=1` with `qty=1000` and bypass the cash guard.

DO:
1. Open src/lib/broker.ts and confirm `PaperBroker.submit` computes
   `const estimatedNotional = order.qty * price;` and uses ONLY `estimatedNotional`
   for `validateOrder({ notional: estimatedNotional, ... })` and the pre-fill cash
   guard. Confirm the comment "riskNotional wird ... NICHT für Sicherheitsentscheidungen
   vertraut" is present.
2. Confirm src/brokers/bitunix/execution.ts BrokerExecutionEngine.submit likewise
   computes `estimatedNotional = req.qty * ticker.price` and validates against it.
3. ADD a regression test (tests/) that submits an order with `riskNotional: 1` but
   `qty: 1000, price: 5` (notional 5000) against a broker with cash 3000 and asserts
   the order is REJECTED (INSUFFICIENT_CASH / INVALID_ESTIMATED_NOTIONAL), proving the
   guard ignores the malicious riskNotional.
4. If the fix is missing, re-implement per docs/CHANGELOG.md [1.36.2] Fixed section.

ACCEPTANCE: Test passes; `grep -n "riskNotional" src/lib/broker.ts` shows it is used
only for the proposal payload, never for validateOrder/guards. No code change needed if
already fixed — only the regression test is new.
```

## Beweis (aktueller Code)

`src/lib/broker.ts` L274‑318:

```ts
// H1 FIX (CRITICAL 2026-09-02): Server-seitige Notional-/Cash-Berechnung.
// `order.riskNotional` wird validiert, aber NICHT für Sicherheitsentscheidungen vertraut.
const estimatedNotional = order.qty * price;
if (!Number.isFinite(estimatedNotional) || estimatedNotional <= 0) {
  return reject(order, `INVALID_ESTIMATED_NOTIONAL:${String(estimatedNotional)}`);
}
const guard = validateOrder({ notional: estimatedNotional, equity: this.accountEquity, ... });
```

## Fix-Spezifikation

Bereits umgesetzt. **Verbleibende Arbeit:** Eine isolierte Regressionstest-Suite, die den
Angriffsvektor (`riskNotional` manipuliert) reproduziert und sicherstellt, dass künftige
Refactorings den serverseitigen `estimatedNotional` nicht wieder durch das Client-Feld ersetzen.

## Akzeptanzkriterien / Tests

- [ ] Test: `riskNotional=1, qty=1000, price=5` bei `cash=3000` → Order REJECTED.
- [ ] `estimatedNotional` ist die einzige Quelle für `validateOrder` und Cash-Guard.
- [ ] Kein neuer Pfad, der `order.riskNotional` in eine Guardrail einspeist.

## Changelog-Blurb

`H1 (CRITICAL): Risk-Notional ≠ tatsächliche Ausführungskosten — bereits in v1.36.2 gefixt;
diese Version fügt einen isolierten Regressionstest für den Angriffsvektor hinzu.`

## Versions-Hinweis

Kein Code-Behaviour-Change → PATCH (`1.36.3`).
