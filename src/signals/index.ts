/**
 * Signal-Domäne — öffentlicher Export.
 *
 * Hier liegen Indikatoren, die als eigenständige Signalquelle arbeiten und
 * sich nicht als `RuleSpec` (`src/lib/ruleEngine.ts`) abbilden lassen, weil
 * sie Zustand über Bars hinweg halten und beide Richtungen handeln.
 *
 *   - `./pine` — Pine-Script-Primitiven (`ta.*`) als Streaming-Akkumulatoren.
 *   - `./cti`  — Claude Trading Indicator (Zwei-Stufen-Konsens, 4 Dimensionen).
 */

export * from "./pine";
export * from "./cti";
