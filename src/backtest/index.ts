/**
 * Multi-Asset Backtest-Engine — Öffentlicher Modul-Export (Task 02).
 *
 * GAP-01 (v1.51.0): Walk-Forward-Validierung (`./walkforward`), Paper-
 * Ausführung über den Paper-Fill-Simulator (`./paperExecution`) und
 * Run-Persistenz (`./runStore`). `./simulator.ts` (Legacy) ist eingefroren.
 * RMA-P1-04 (v1.52.0): Trade-Ledger (`./tradeLedger`) — reine Abbildung,
 * Abgleich und Paging-Validatoren der persistierten `backtest_trades`.
 */

export * from "./types";
export * from "./simulator";
export * from "./portfolio";
export * from "./metrics";
export * from "./engine";
export * from "./paperExecution";
export * from "./walkforward";
export * from "./runStore";
export * from "./tradeLedger";
