/**
 * **Faktor `liquidity` — handelbares Volumen.**
 *
 * Formel: `raw = volume24h` (Quote-Währung, aus der Instrument-Registry).
 * Fehlt der Registry-Wert, wird ersatzweise das Quote-Volumen der letzten
 * Kerze verwendet (`volume × close`) und im `detail` als `source: "candle"`
 * ausgewiesen.
 *
 * Normalisierung: logarithmisch, weil Volumen über viele Zehnerpotenzen
 * streut — `minVolume24h → 0`, `maxVolume24h → 1`
 * (`log10(v/min) / log10(max/min)`).
 *
 * Datenbedarf: `MarketInstrument.volume24h` **oder** ≥ 1 Kerze.
 */
import { last, logNorm } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Neutralwert ohne Datenlage: 0 — unbekannte Liquidität ist kein Pluspunkt. */
export const LIQUIDITY_NEUTRAL = 0;

/** Liquiditäts-Faktor (Score-Gewicht 25 %). */
export const liquidityFactor: Factor = {
  id: "liquidity",
  label: "Liquidität (24h-Volumen)",
  neutral: LIQUIDITY_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const { instrument, candles, config } = input;
    const cfg = config.factors.liquidity;

    let volume = instrument.volume24h;
    let source = "registry";
    if (volume === null || !Number.isFinite(volume) || volume <= 0) {
      const lastCandle = last(candles);
      if (lastCandle && Number.isFinite(lastCandle.volume) && Number.isFinite(lastCandle.close)) {
        const quoteVolume = lastCandle.volume * lastCandle.close;
        if (quoteVolume > 0) {
          volume = quoteVolume;
          source = "candle";
        }
      }
    }
    if (volume === null || !Number.isFinite(volume) || volume <= 0) {
      return unavailable("liquidity", LIQUIDITY_NEUTRAL, "kein 24h-Volumen bekannt");
    }
    return factorValue("liquidity", {
      raw: volume,
      normalized: logNorm(volume, cfg.minVolume24h, cfg.maxVolume24h),
      reason: `24h-Volumen ${volume.toFixed(0)} (${source})`,
      detail: { source, minVolume24h: cfg.minVolume24h, maxVolume24h: cfg.maxVolume24h },
    });
  },
};
