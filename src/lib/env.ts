/**
 * Sicheres Lesen numerischer Umgebungsvariablen.
 * NaN/`abc`/leere Werte dürfen niemals in setInterval oder Limits durchsickern
 * (`Math.max(15000, Number("abc")) === NaN`).
 */
export function envInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: Record<string, string | undefined> = process.env
): number {
  const n = Number(env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Sicheres Lesen numerischer Umgebungsvariablen mit Nachkommastellen
 * (GAP-02, v1.42.0). Anders als `envInt` wird hier **laut** korrigiert:
 *
 *   - undefiniert/leer           → sicherer Default (kein Log — Normalfall)
 *   - keine endliche Zahl        → sicherer Default + Warnung
 *   - außerhalb [min, max]       → Clamp auf die Bound + Warnung
 *
 * Grund: Simulations- und Funding-Parameter (Gebühren, Slippage, Funding-
 * Rate) verändern das Paper-PnL. Eine still geklemmte oder still ersetzte
 * Zahl würde den Operator glauben lassen, er kalibriere das Modell, während
 * in Wahrheit ein anderer Wert wirksam ist — deshalb Warnung bei jeder
 * Korrektur (fail-laut, nicht still).
 */
export function envNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[env] ${name}="${raw.trim().slice(0, 40)}" ist keine Zahl → sicherer Default ${fallback}`);
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, n));
  if (clamped !== n) {
    console.warn(`[env] ${name}=${raw.trim().slice(0, 40)} außerhalb der Bounds [${min}, ${max}] → geklemmt auf ${clamped}`);
  }
  return clamped;
}
