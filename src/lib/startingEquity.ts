/**
 * Startkapital des Paper-Kontos — eine Quelle für alle Leser.
 *
 * `STARTING_EQUITY` (Default 10 000) ist die Basis für Prozentangaben im
 * Dashboard („Abstand zum Start“) und für die Risiko-Limits. Vorher lag
 * dieselbe Funktion dreimal im Code (`firmState.ts`, `drawdownScaling.ts`,
 * jetzt auch die Equity-API) — hier ist sie einmal definiert, damit ein
 * geänderter Default nicht an einer Stelle vergessen wird.
 *
 * Hinweis: Das ist **nicht** die Drawdown-Basis der Equity-Kurve. Der Drawdown
 * wird Peak-to-Trough gerechnet (laufender Höchststand); `STARTING_EQUITY` ist
 * nur der Bezugspunkt für „seit Start“ (siehe docs/EQUITY_CURVE.md).
 */
export const STARTING_EQUITY_ENV = "STARTING_EQUITY";
export const STARTING_EQUITY_DEFAULT = 10_000;

export function readStartingEquity(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env[STARTING_EQUITY_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : STARTING_EQUITY_DEFAULT;
}
