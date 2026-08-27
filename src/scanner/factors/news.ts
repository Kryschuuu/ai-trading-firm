/**
 * **Faktor `news` — deterministische News-Risiko-Heuristik.**
 *
 * **Kein LLM.** Bewertet wird ausschließlich die *Struktur* des Nachrichtenflusses
 * (Zähler eines Feeds) plus die Frische der Registry-Daten:
 *
 * ```text
 * risiko = w24  × events24h
 *        + w7d  × events7d
 *        + wHi  × highImpact24h
 *        + wSched (falls ein Termin ≤ scheduledHorizonHours ansteht)
 *        + wStale (falls lastSeen älter als stalenessHours)
 * raw       = min(risiko, 1)
 * normalized = 1 − raw          (wenig Nachrichtenrisiko ⇒ hoher Score)
 * ```
 *
 * Ohne News-Kontext wird `neutralRisk` (Default 0.25) angesetzt — bewusst nicht
 * 0, weil „keine Daten“ nicht „kein Risiko“ heißt. Die inhaltliche Bewertung
 * von Schlagzeilen passiert später ausschließlich auf der Top-Shortlist.
 *
 * Datenbedarf: {@link NewsRiskContext} (optional) + `instrument.lastSeen`.
 */
import { clamp01 } from "../math";
import type { Factor, FactorInput, FactorValue } from "../types";
import { factorValue, unavailable } from "./helpers";

/** Millisekunden je Stunde. */
const HOUR_MS = 3_600_000;

/** Neutralwert ohne News-Kontext: `1 − neutralRisk` (Default 0.75). */
export const NEWS_NEUTRAL = 0.75;

/** Alter der Registry-Daten in Stunden (`null`, wenn `lastSeen` unbrauchbar). */
function stalenessHours(lastSeen: string, asOf: number): number | null {
  const seen = Date.parse(lastSeen);
  if (!Number.isFinite(seen)) return null;
  return (asOf - seen) / HOUR_MS;
}

/** News-Risiko-Faktor (Score-Gewicht 5 %). */
export const newsFactor: Factor = {
  id: "news",
  label: "News-Risiko (deterministische Heuristik)",
  neutral: NEWS_NEUTRAL,
  compute(input: FactorInput): FactorValue {
    const cfg = input.config.factors.news;
    const age = stalenessHours(input.instrument.lastSeen, input.asOf);
    const stale = age !== null && age > cfg.stalenessHours;
    const stalePenalty = stale ? cfg.weightStaleness : 0;

    const ctx = input.news;
    if (!ctx) {
      const risk = clamp01(cfg.neutralRisk + stalePenalty);
      return unavailable("news", 1 - risk, "kein News-Kontext — konservativer Neutralwert", {
        neutralRisk: cfg.neutralRisk,
        stale,
        ageHours: age,
      });
    }

    const events24h = Math.max(0, Number.isFinite(ctx.events24h) ? ctx.events24h : 0);
    const events7d = Math.max(0, Number.isFinite(ctx.events7d) ? ctx.events7d : 0);
    const highImpact = Math.max(0, Number.isFinite(ctx.highImpact24h) ? ctx.highImpact24h : 0);
    const scheduled =
      ctx.scheduledEventInHours !== null &&
      Number.isFinite(ctx.scheduledEventInHours) &&
      ctx.scheduledEventInHours >= 0 &&
      ctx.scheduledEventInHours <= cfg.scheduledHorizonHours;

    const risk = clamp01(
      events24h * cfg.weightEvents24h +
        events7d * cfg.weightEvents7d +
        highImpact * cfg.weightHighImpact +
        (scheduled ? cfg.weightScheduled : 0) +
        stalePenalty
    );

    return factorValue("news", {
      raw: risk,
      normalized: 1 - risk,
      reason: `News-Risiko ${(risk * 100).toFixed(0)} % (${events24h} Meldungen/24h, ${highImpact} high impact${scheduled ? ", Termin voraus" : ""})`,
      detail: { events24h, events7d, highImpact, scheduled, stale, ageHours: age },
    });
  },
};
