/**
 * **Faktor `momentum` — Preisdynamik über mehrere Fenster.**
 *
 * Formel: je Fenster `L`: `roc_L = c_t / c_{t−L} − 1`;
 * `raw = Σ (w_L × roc_L) / Σ w_L` über alle Fenster, für die genug Historie
 * vorliegt (Defaults: 5/20/60 Perioden mit 0.2/0.3/0.5).
 *
 * Normalisierung: `absolute` (Default) bewertet die **Bewegungsstärke**
 * unabhängig von der Richtung — `|raw| / scale`, geklemmt auf `[0,1]`;
 * `directional` bewertet nur Aufwärtsbewegung (`raw / scale`). Das Vorzeichen
 * steht in jedem Fall in `detail.direction`.
 *
 * Datenbedarf: ≥ `min(lookbacks) + 1` Kerzen.
 */
import { clamp01, closesOf } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0. */
export const MOMENTUM_NEUTRAL = 0;

/** Momentum-Faktor (Score-Gewicht 10 %). */
export const momentumFactor: Factor = {
  id: "momentum",
  label: "Momentum (Rate of Change)",
  neutral: MOMENTUM_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.momentum;
    const closes = closesOf(input.candles);
    if (!closes) return unavailable("momentum", MOMENTUM_NEUTRAL, "unbrauchbare Kursreihe (NaN/≤ 0)");
    const n = closes.length;
    const current = closes[n - 1];

    let weighted = 0;
    let weightSum = 0;
    const used: number[] = [];
    for (let i = 0; i < cfg.lookbacks.length; i++) {
      const lookback = cfg.lookbacks[i];
      const weight = cfg.lookbackWeights[i];
      if (n < lookback + 1) continue;
      const past = closes[n - 1 - lookback];
      if (past <= 0) continue;
      weighted += weight * (current / past - 1);
      weightSum += weight;
      used.push(lookback);
    }
    if (weightSum <= 0) {
      return unavailable("momentum", MOMENTUM_NEUTRAL, `zu wenig Kurse (${n})`);
    }
    const raw = weighted / weightSum;
    const normalized =
      cfg.mode === "absolute" ? clamp01(Math.abs(raw) / cfg.scale) : clamp01(raw / cfg.scale);
    return factorValue("momentum", {
      raw,
      normalized,
      reason: `gewichtete Rendite ${(raw * 100).toFixed(2)} % (Fenster ${used.join("/")})`,
      detail: {
        mode: cfg.mode,
        direction: raw > 0 ? "up" : raw < 0 ? "down" : "flat",
        windowsUsed: used.length,
        scale: cfg.scale,
      },
    });
  },
};
