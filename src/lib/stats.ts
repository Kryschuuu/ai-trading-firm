/**
 * Kleine, reine Statistikhelfer ohne IO.
 *
 * Die Wilson-Formel lebt hier (nicht im Forecast-Ledger), damit Workshop
 * und Scoring dieselbe Funktion nutzen, ohne dass die Oberfläche das
 * Forecast-Modul in den Client zieht.
 */

/** Wilson-Quantil für 95 % (zweiseitig). */
export const WILSON_Z_95 = 1.959963984540054;

/**
 * Wilson-Score-Intervall einer binären Rate.
 *
 * Exakte Grenzfälle: k=0 ⇒ untere Schranke 0; k=n ⇒ obere Schranke 1.
 * @returns `null` für n=0 (keine Aussage) — niemals [0,0] oder [0.5,0.5].
 */
export function wilsonInterval(
  k: number,
  n: number,
  z: number = WILSON_Z_95,
): { lower: number; upper: number; center: number } | null {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n < 0 || k < 0 || k > n) return null;
  if (n === 0) return null;
  if (!Number.isFinite(z) || z <= 0) return null;
  const z2 = z * z;
  const denom = n + z2;
  const center = (k + z2 / 2) / denom;
  const half = (z * Math.sqrt((k * (n - k)) / n + z2 / 4)) / denom;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    center,
  };
}
