/** Copy-Trading — public module (Phase 7 · STX-07-01/02/03).
 *
 * `types`, `mapping`, `sizing`, `config` and `policy` hold domain/configuration
 * logic; `store` persists only idempotency links around existing follower
 * intents. It creates no second intent/receipt ledger and does not submit
 * orders. The follower's execution evidence remains owned by
 * `src/executionQuality/` and `src/brokers/reconciliation.ts`.
 *
 * STX-09 boundary: execution-quality intents are referenced by FK only; this
 * package is not a reconciler and does not duplicate reconciliation or fill
 * evidence. Realized deviation is measurement-only and never a slippage-cancel
 * trigger. STX-16: `SIMULATE_ONLY` is enforced by the database CHECK, enabled
 * defaults to false, and no flag or live-order path exists here.
 *
 * STX-07-03 adds the first runnable loop: `leader/bitunix.ts` reads a leader
 * account (WS events, never polling), `follower/simulated.ts` executes on the
 * existing `PaperBroker`, and `engine.ts` orchestrates the fail-closed
 * pipeline with persistent `leader_event_id` dedupe.
 */

export * from "./types";
export * from "./mapping";
export * from "./sizing";
export * from "./config";
export * from "./policy";
export * from "./store";
export * from "./leader/bitunix";
export * from "./follower/simulated";
export * from "./engine";
