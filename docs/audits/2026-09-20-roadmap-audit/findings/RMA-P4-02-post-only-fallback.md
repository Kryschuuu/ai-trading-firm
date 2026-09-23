# RMA-P4-02: Post-Only + Timeout + Market-Fallback

- **Antwort:** Ja (seit v1.70.0)
- **Tracking-Status:** `FIXED` (v1.70.0, [#168](https://github.com/Kryschuuu/ai-trading-firm/pull/168), Commit `548e901`)
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **0 PT** (Audit-Schätzung war 3–5 PT)
- **Umsetzungs-Prompt:** [`PROMPT-P4-02`](../prompts/PROMPT-P4-02-post-only-fallback.md)

## Verifizierte Fundstellen

- `src/contracts/broker.ts::BrokerOrderRequest` — gemeinsamer Ordervertrag.
- `src/brokers/bitunix/orders.ts` — Venue-Serialisierung von Ordertypen.
- `src/brokers/alpaca/orders.ts` — Limit-/Market-Orderaufbau.
- `src/brokers/*/execution.ts` — Platzierung ohne gemeinsame TTL-/Fallback-State-Machine.

## Bewertung und Abgrenzung

Limit- und Marketorders sind verfügbar; venueabhängige Parameter können serialisiert werden. Eine koordinierte Policy aus Maker-Versuch, Timeout, Cancel-Bestätigung und optionalem Taker-Fallback fehlt.

## Konkretes Delta

- gemeinsamer ExecutionPolicy-Vertrag mit Post-Only, TTL, Repricing und Fallback-Bounds
- persistente Zustandsmaschine für ACK, REJECT, PARTIAL, CANCEL_PENDING, CANCELLED und FALLBACK
- Idempotency über Netzwerkfehler und Prozessrestart
- Remaining-Quantity-Berechnung nach Partial Fill
- Notional-, Spread-, Slippage- und Kill-Switch-Gates vor Market-Fallback

## Akzeptanzkriterien für `FIXED`

- [x] Fallback kann niemals mehr als die offene Restmenge handeln
- [x] keine Marketorder vor bestätigtem Cancel oder venue-sicherem Replace
- [x] Post-Only-Reject ist explizit von sonstigen Rejects unterscheidbar
- [x] Restart setzt eine Order idempotent aus persistiertem Zustand fort

## Umsetzung (v1.70.0)

- **Execution-Policy-Controller `src/execution/`:** versionierte Maker-Policy `eop1`, State-Machine NEW→…→DONE, Market-Fallback nur Opt-in nach bestätigtem Cancel, Venue-Capabilities ohne stilles Dropping.
- **Persistenz:** `drizzle/2026-09-22_post_only_fallback.sql` (Workflows/Events/Fills, append-only, CHECK-Constraints).
- **API:** `/api/firm/execution/policy` hinter `EXECUTION_POLICY_ENABLED` (Default `false`).
- **Doku:** [`docs/POST_ONLY_FALLBACK.md`](../../../POST_ONLY_FALLBACK.md).

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`. Umsetzung auf v1.69.0 → Fix `v1.70.0`.
- Fix: Commit `548e901`, [PR #168](https://github.com/Kryschuuu/ai-trading-firm/pull/168).
- Tests: `tests/executionPolicy.unit.test.ts` (35), `tests/executionPolicy.controller.test.ts` (24), `tests/executionPolicy.db.test.ts` (7).
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
