/**
 * Claude Trading Indicator (CTI) — öffentlicher Modul-Export.
 *
 * Portierung des Pine-Skripts „Claude Trading Indicator" (`@version=6`,
 * shorttitle `CTI`) in TypeScript. Aufbau:
 *
 *   | Datei            | Rolle                                               |
 *   | ---------------- | --------------------------------------------------- |
 *   | `params.ts`      | Einstellbare Inputs + interne Komponenten-Perioden   |
 *   | `types.ts`       | Bar-/Votum-/Fehlertypen                             |
 *   | `runtime.ts`     | **Der Rechenkern** (ein einziger Zustandsautomat)    |
 *   | `dashboard.ts`   | Tabelle und Alert-Text wie im Skript                 |
 *   | `backtest.ts`    | Anbindung an die Multi-Asset-Backtest-Engine         |
 *   | `engine.ts`      | Trading-Engine (Intents, IO-frei, Port-basiert)      |
 *
 * Die Primitiven (`ta.ema`, `ta.supertrend`, `ta.dmi` …) liegen eine Ebene
 * höher in `../pine.ts`, weil sie nicht CTI-spezifisch sind.
 *
 * Dieses Modul ist bewusst frei von IO: kein `../../db`, kein Broker, kein
 * `next`. Es darf deshalb aus Skripten, Tests, der Backtest-Engine und dem
 * Live-Pfad gleichermaßen importiert werden.
 */

export * from "./params";
export * from "./types";
export * from "./runtime";
export * from "./dashboard";
export * from "./backtest";
export * from "./engine";
