/**
 * Deterministischer PRNG (mulberry32) — Task 03.
 *
 * Simulator und Synthetic-Feed sind seed-basiert bit-identisch reproduzierbar
 * (Decoupling-Regel 1). Dieselbe Seed → dieselbe Folge → identische Fills und
 * identische synthetische Kurse.
 */

/** Liefert eine deterministische Zufallsfunktion `() -> [0,1)` aus einer Seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalisiert eine Seed auf eine nicht-negative 32-bit-Ganzzahl. */
export function normalizeSeed(raw: number | string | undefined): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw >>> 0;
  if (typeof raw === "string") {
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = (Math.imul(h, 31) + raw.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }
  return 0;
}
