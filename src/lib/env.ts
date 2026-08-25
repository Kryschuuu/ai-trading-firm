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
