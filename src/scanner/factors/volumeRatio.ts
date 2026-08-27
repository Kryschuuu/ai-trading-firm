/**
 * **Faktor `volumeRatio` — Volumenschub.**
 *
 * Formel: `raw = Ø Volumen der letzten recentPeriods / Ø Volumen der letzten
 * basePeriods` (Defaults 5 / 20). Ein Wert > 1 heißt: aktuell wird mehr
 * gehandelt als im Referenzfenster.
 *
 * Normalisierung: linear — `minRatio (0.5) → 0`, `maxRatio (2.0) → 1`.
 *
 * Datenbedarf: ≥ `basePeriods` Kerzen mit `volume ≥ 0`.
 */
import { linearNorm, mean, tail } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0. */
export const VOLUME_RATIO_NEUTRAL = 0;

/** Volumen-Verhältnis (Score-Gewicht 10 %). */
export const volumeRatioFactor: Factor = {
  id: "volumeRatio",
  label: "Volumen-Verhältnis (Schub)",
  neutral: VOLUME_RATIO_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.volumeRatio;
    const volumes: number[] = [];
    for (const c of input.candles) {
      if (!Number.isFinite(c.volume) || c.volume < 0) {
        return unavailable("volumeRatio", VOLUME_RATIO_NEUTRAL, "unbrauchbare Volumenreihe");
      }
      volumes.push(c.volume);
    }
    if (volumes.length < cfg.basePeriods) {
      return unavailable(
        "volumeRatio",
        VOLUME_RATIO_NEUTRAL,
        `zu wenig Kerzen (${volumes.length} < ${cfg.basePeriods})`
      );
    }
    const recent = mean(tail(volumes, cfg.recentPeriods));
    const base = mean(tail(volumes, cfg.basePeriods));
    if (recent === null || base === null || base <= 0) {
      return unavailable("volumeRatio", VOLUME_RATIO_NEUTRAL, "Referenzvolumen 0 — Verhältnis undefiniert");
    }
    const ratio = recent / base;
    return factorValue("volumeRatio", {
      raw: ratio,
      normalized: linearNorm(ratio, cfg.minRatio, cfg.maxRatio),
      reason: `Volumen ${ratio.toFixed(2)}× des ${cfg.basePeriods}-Perioden-Schnitts`,
      detail: { recentAverage: recent, baseAverage: base },
    });
  },
};
