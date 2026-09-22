/**
 * Deterministische Kerzen-Fixtures für die Konfluenz-Tests (RMA-P2-03).
 * Keine Uhr, kein Zufall — alle Zeitstempel sind epoch-aligniert.
 */
import type { ConfluenceCandle } from "../src/confluence/types";

/** Fester Entscheidungszeitpunkt (Montag 00:00 UTC, durch 15m/1h/4h teilbar). */
export const ASOF_MS = Date.parse("2026-01-05T00:00:00.000Z");

export const TF_MS: Record<string, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

/**
 * Baut `n` valide Kerzen mit linearer Drift. `driftPerBar > 0` = aufwärts,
 * `< 0` = abwärts, `0` = flach. Die letzte Bar öffnet bei `lastOpenMs`
 * (Default: letzte geschlossene Bar vor `ASOF_MS`).
 */
export function linearBars(opts: {
  timeframe: keyof typeof TF_MS;
  n: number;
  driftPerBar: number;
  base?: number;
  lastOpenMs?: number;
  availableAtMs?: number;
  volume?: number;
}): ConfluenceCandle[] {
  const stepMs = TF_MS[opts.timeframe];
  const base = opts.base ?? 100;
  const drift = opts.driftPerBar;
  const lastOpen = opts.lastOpenMs ?? ASOF_MS - stepMs;
  const out: ConfluenceCandle[] = [];
  for (let i = 0; i < opts.n; i++) {
    const close = base + drift * i;
    const open = base + drift * (i - 0.5);
    const pad = Math.abs(drift) * 0.6 + 0.05;
    out.push({
      time: lastOpen - (opts.n - 1 - i) * stepMs,
      open,
      high: Math.max(open, close) + pad,
      low: Math.min(open, close) - pad,
      close,
      volume: opts.volume ?? 1000,
      ...(opts.availableAtMs !== undefined ? { availableAtMs: opts.availableAtMs } : {}),
    });
  }
  return out;
}

/** Stark aufwärts (Trend/Momentum klemmen auf +1). */
export function upBars(
  timeframe: keyof typeof TF_MS,
  n = 30,
  extra: Partial<Parameters<typeof linearBars>[0]> = {},
): ConfluenceCandle[] {
  return linearBars({ timeframe, n, driftPerBar: 1, ...extra });
}

/** Stark abwärts (Trend/Momentum klemmen auf −1). */
export function downBars(
  timeframe: keyof typeof TF_MS,
  n = 30,
  extra: Partial<Parameters<typeof linearBars>[0]> = {},
): ConfluenceCandle[] {
  return linearBars({ timeframe, n, driftPerBar: -1, base: 200, ...extra });
}

/** Völlig flach (Trend/Momentum exakt 0). */
export function flatBars(
  timeframe: keyof typeof TF_MS,
  n = 30,
  extra: Partial<Parameters<typeof linearBars>[0]> = {},
): ConfluenceCandle[] {
  return linearBars({ timeframe, n, driftPerBar: 0, ...extra });
}
