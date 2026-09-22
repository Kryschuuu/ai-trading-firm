/**
 * Numerik-Basis des Cross-Sectional-Momentum-Moduls (RMA-P2-04) — klein,
 * pure, deterministisch.
 *
 * Grundregeln (gelten für das ganze Modul):
 *   - Konvention wie `src/scanner/math.ts`: Standardabweichungen sind
 *     **Populations**-Standardabweichungen (÷ n); jede Ausgabe läuft durch
 *     {@link roundTo}, damit Gleitkomma-Rauschen die Byte-Identität von
 *     Artefakten/Snapshots nicht bricht.
 *   - Querschnittsstatistik (Mittelwert, σ, Quantile) wird immer über das
 *     **nach Instrument-ID sortierte** Universum berechnet — die
 *     Gleitkomma-Reihenfolge ist damit unabhängig von der Eingabe-Reihenfolge
 *     (Permutationsinvarianz ist ein Testpflichtpunkt).
 *   - Nicht endliche Werte (`NaN`/`Infinity`) sind nie gültige Eingaben oder
 *     Ausgaben: fail-closed, nie still `0`.
 */

import { createHash } from "node:crypto";

/** Anzahl Nachkommastellen, auf die Modul-Ausgaben gerundet werden. */
export const OUTPUT_DECIMALS = 10;

/** Rundet deterministisch auf `decimals` Nachkommastellen (Half-away-from-zero). */
export function roundTo(value: number, decimals = OUTPUT_DECIMALS): number {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** decimals;
  const scaled = value * f;
  const r = scaled >= 0 ? Math.round(scaled) : -Math.round(-scaled);
  return r / f;
}

/** Klemmt einen Wert in `[0, 1]`; nicht-endliche Werte werden zu 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** true, wenn der Wert eine endliche Zahl ist. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * SHA-256 (hex) — kanonischer Hash-Baustein des Moduls.
 * `prefix` erzeugt versionierte Fingerprints wie `xc1:<hex>` (Config-Hash),
 * `xu1:<hex>` (Universe-Hash) oder `xs1:<hex>` (Snapshot-ID).
 */
export function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Deterministische JSON-Serialisierung (recursiv, **sortierte** Objektkeys,
 * keine Whitespace-Variation). Basis aller Hashes, damit `same Input ⇒
 * byte-identischer Hash` gilt, unabhängig von der Key-Reihenfolge im Code.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("stableStringify: nicht endliche Zahl ist kein gültiger Hash-Input");
      // Zahlen über die JSON-Notation canonicalisieren (keine 1e-7-Variation).
      return String(value);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Populations-Mittelwert (÷ n). `null` bei leerer Eingabe (nie 0).
 * Reihenfolge ist für die Deterministik durch den Aufrufer fixiert (ID-Sort).
 */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / values.length;
}

/**
 * Populations-Standardabweichung (÷ n) — Repo-Konvention (vgl.
 * `src/scanner/math.ts`). `null` bei < 1 Wert oder nicht-endlichem Mittelwert.
 * Reihenfolge ist durch den Aufrufer fixiert (ID-Sort).
 */
export function stdDev(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const m = mean(values);
  if (m === null) return null;
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

/**
 * Quantil (Methode „Type 7", lineare Interpolation) über eine **bereits
 * aufsteigend sortierte** Menge. `q` muss in `[0,1]` liegen. `null` bei leerer
 * Menge. Deterministisch: gleiche Sortierung ⇒ gleiche Interpolation.
 */
export function quantileSorted(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new Error(`quantileSorted: q=${String(q)} muss in [0,1] liegen`);
  }
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * Kanonische Sortierung nach einem String-Schlüssel (aufsteigend) — die
 * Querschnittsreihenfolge. Rückgabe ist eine **neue** Array-Kopie; die
 * Sortierung ist total (keine gleichwertigen Nachbarschaften, die von der
 * Eingabe-Reihenfolge abhängen).
 */
export function canonicalSort<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Sortiert nach kanonischer Instrument-ID (`instrumentId`). */
export function byInstrumentId<T extends { instrumentId: string }>(rows: readonly T[]): T[] {
  return canonicalSort(rows, (r) => r.instrumentId);
}

/** Deterministisches Vergleichen zweier Strings (lexikografisch, UTF-16). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
