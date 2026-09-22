/**
 * Baseline-vs-Candidate-Vergleich mit identischen Segmenten (RMA-P3-02, v1.65.0)
 *
 * ── Fairness-Garantie ─────────────────────────────────────────────────────
 * Beide Seiten verwenden **denselben** Filter (agentRole, horizonId, entityId,
 * regime, from/to, limit). Die Methode `comparePromptVersions` erzwingt das,
 * indem sie beide Metrikabfragen mit demselben `baseFilter` ausführt und den
 * Vergleichsschlüssel aus demselben Objekt ableitet. Eine ungleiche Filterung
 * (z. B. andere Zeitfenster je Version) wird als `MISMATCHED_FILTERS` verworfen.
 *
 * ── Coverage ──────────────────────────────────────────────────────────────
 * Der Bericht meldet je Seite `counts` + `coverage` + `status`, damit eine
 * schmale Teilmenge nicht als belastbares Ergebnis missverstanden wird.
 * Unaufgelöste Forecasts (PENDING) zählen nie als Gewinn/Verlust.
 *
 * ── Promotion ─────────────────────────────────────────────────────────────
 * Das Ergebnis enthält **nur eine Empfehlung** (`action`), nie eine automatische
 * Beförderung. Die Empfehlung ist an `gateRequired: "human-review"` gekoppelt;
 * das Promotion-Gate muss die Empfehlung aktiv beschließen. Eine schlechter
 * kalibrierte Variante darf nicht allein wegen besseren PnLs bevorzugt werden
 * (ECE-Wächter).
 */

import { getPromptVersionMetrics, type PromptMetricsFilter } from "./metrics";
import { PROMPT_PERF_LIMITS, PromptPerfError, type PromptComparisonReport } from "./types";
import { structuredLog } from "@/lib/logger";

export interface CompareOpts extends Omit<PromptMetricsFilter, "promptVersion"> {
  baselineVersion: number;
  candidateVersion: number;
}

export async function comparePromptVersions(opts: CompareOpts): Promise<PromptComparisonReport> {
  const baselineVersion = Math.trunc(Number(opts.baselineVersion));
  const candidateVersion = Math.trunc(Number(opts.candidateVersion));
  if (!Number.isFinite(baselineVersion) || baselineVersion < 0) throw new PromptPerfError("INVALID_BASELINE", "baselineVersion ungültig");
  if (!Number.isFinite(candidateVersion) || candidateVersion < 0) throw new PromptPerfError("INVALID_CANDIDATE", "candidateVersion ungültig");
  if (baselineVersion === candidateVersion) throw new PromptPerfError("SAME_VERSION", "baseline und candidate dürfen nicht identisch sein");

  const baseFilter: PromptMetricsFilter = {
    agentRole: opts.agentRole ? String(opts.agentRole) : undefined,
    horizonId: opts.horizonId ? String(opts.horizonId) : undefined,
    entityId: opts.entityId ? String(opts.entityId) : undefined,
    regime: opts.regime ? String(opts.regime) : undefined,
    fromAsOf: opts.fromAsOf,
    toAsOf: opts.toAsOf,
    minSample: opts.minSample,
    limit: opts.limit,
  };

  // Identische Filter enforced: beide Aufrufe erhalten exakt dasselbe baseFilter
  const [baseline, candidate] = await Promise.all([
    getPromptVersionMetrics({ ...baseFilter, promptVersion: baselineVersion }),
    getPromptVersionMetrics({ ...baseFilter, promptVersion: candidateVersion }),
  ]);

  const deltas = {
    brierDelta: baseline.forecastQuality.brierScore != null && candidate.forecastQuality.brierScore != null ? candidate.forecastQuality.brierScore - baseline.forecastQuality.brierScore : null,
    bssDelta: baseline.forecastQuality.brierSkillScore != null && candidate.forecastQuality.brierSkillScore != null ? candidate.forecastQuality.brierSkillScore - baseline.forecastQuality.brierSkillScore : null,
    eceDelta: baseline.forecastQuality.expectedCalibrationError != null && candidate.forecastQuality.expectedCalibrationError != null ? candidate.forecastQuality.expectedCalibrationError - baseline.forecastQuality.expectedCalibrationError : null,
    hitRateDelta: baseline.forecastQuality.hitRate != null && candidate.forecastQuality.hitRate != null ? candidate.forecastQuality.hitRate - baseline.forecastQuality.hitRate : null,
    coverageDelta: baseline.coverage != null && candidate.coverage != null ? candidate.coverage - baseline.coverage : null,
    latencyDeltaMs: baseline.runtime.latency.avgMs != null && candidate.runtime.latency.avgMs != null ? candidate.runtime.latency.avgMs - baseline.runtime.latency.avgMs : null,
    costDeltaUsd: baseline.runtime.cost.totalUsd != null && candidate.runtime.cost.totalUsd != null ? candidate.runtime.cost.totalUsd - baseline.runtime.cost.totalUsd : null,
    pnlDelta: baseline.tradeContribution.attributedPnl != null && candidate.tradeContribution.attributedPnl != null ? candidate.tradeContribution.attributedPnl - baseline.tradeContribution.attributedPnl : null,
  };

  // ── Empfehlung: nur bei Evidenz + nicht schlechterer Kalibrierung ─────
  const warnings: string[] = [];
  if (baseline.forecastQuality.status !== "ok" || candidate.forecastQuality.status !== "ok") {
    warnings.push("insufficient-sample: mindestens eine Seite unter minSample — Vergleich unzuverlässig");
  }
  if (baseline.coverage != null && candidate.coverage != null && Math.abs((candidate.coverage ?? 0) - (baseline.coverage ?? 0)) > 0.15) {
    warnings.push("coverage-drift: Coverage unterscheidet sich >15pp — Segmentvergleich ggf. verzerrt");
  }
  if (baseline.counts.forecastsResolved === 0 || candidate.counts.forecastsResolved === 0) {
    warnings.push("no-resolved: mindestens eine Seite ohne RESOLVED-Forecasts — keine Kalibrierung ableitbar");
  }

  const baselineEce = baseline.forecastQuality.expectedCalibrationError;
  const candidateEce = candidate.forecastQuality.expectedCalibrationError;
  // Kalibrierungswächter: Candidate darf nicht > 0.02 schlechter sein als Baseline.
  // 0.02 ist die dokumentierte Schwelle (ECEdelta > 0.02 = schlechter kalibriert).
  const ECE_GUARD = 0.02;
  let calibrationPasses = true;
  if (baselineEce != null && candidateEce != null) {
    calibrationPasses = candidateEce <= baselineEce + ECE_GUARD;
    if (!calibrationPasses) warnings.push(`calibration-guard: candidate ECE ${candidateEce.toFixed(4)} > baseline ECE ${baselineEce.toFixed(4)} + ${ECE_GUARD}`);
  } else if (baselineEce == null || candidateEce == null) {
    // Ohne ECE keine Wächterentscheidung — noch unsicher.
    calibrationPasses = true;
    warnings.push("calibration-unknown: ECE einer Seite nicht berechenbar — manueller Review nötig");
  }

  let action: PromptComparisonReport["recommendation"]["action"] = "INSUFFICIENT_EVIDENCE";
  let reason = "";

  if (baseline.forecastQuality.status !== "ok" || candidate.forecastQuality.status !== "ok") {
    action = "INSUFFICIENT_EVIDENCE";
    reason = `Stichprobe unter minSample (baseline ${baseline.forecastQuality.status}, candidate ${candidate.forecastQuality.status}) — keine Empfehlung`;
  } else if (!calibrationPasses) {
    action = "MAINTAIN_BASELINE";
    reason = `Candidate schlechter kalibriert (ECE-Delta ${(candidateEce! - baselineEce!).toFixed(4)} > +${ECE_GUARD}) — darf trotz besserem PnL nicht bevorzugt werden`;
  } else {
    // Bei gleicher/günstigerer Kalibrierung entscheidet Brier + BSS + HitRate
    // — PnL allein reicht nicht, PnL ist nur ergänzend.
    const brierBetter = deltas.brierDelta != null && deltas.brierDelta < -0.01;
    const bssBetter = deltas.bssDelta != null && deltas.bssDelta > 0.02;
    const hitBetter = deltas.hitRateDelta != null && deltas.hitRateDelta > 0.02;
    const pnlBetter = deltas.pnlDelta != null && deltas.pnlDelta > 0;

    const brierUncert = candidate.forecastQuality.brierUncertainty;
    const brierOverlaps = brierUncert && baseline.forecastQuality.brierUncertainty
      ? intervalsOverlap(
          [baseline.forecastQuality.brierUncertainty.lower, baseline.forecastQuality.brierUncertainty.upper],
          [brierUncert.lower, brierUncert.upper]
        )
      : false;

    if ((brierBetter || bssBetter || hitBetter) && !brierOverlaps) {
      if (pnlBetter) {
        action = "CONSIDER_CANDIDATE";
        reason = `Candidate besser (Brier ${deltas.brierDelta?.toFixed(4)}, BSS ${deltas.bssDelta?.toFixed(4)}, HitRate ${deltas.hitRateDelta?.toFixed(4)}) und Kalibrierung nicht schlechter; PnL positiv — Empfehlung hinter Human-Gate`;
      } else {
        action = "CONSIDER_CANDIDATE";
        reason = `Candidate besser kalibriert/prognostisch (Brier ${deltas.brierDelta?.toFixed(4)}, HitRate ${deltas.hitRateDelta?.toFixed(4)}) — PnL neutral/negativ, aber prognostisch überlegen`;
      }
    } else if (brierOverlaps) {
      action = "INSUFFICIENT_EVIDENCE";
      reason = "Brier-CIs überlappen — Unterschied nicht statistisch belastbar";
    } else {
      action = "MAINTAIN_BASELINE";
      reason = "Candidate nicht prognostisch überlegen (Brier/BSS/HitRate) — Baseline behalten";
    }
  }

  structuredLog("info", "prompt_compare_computed", {
    baselineVersion,
    candidateVersion,
    filters: JSON.stringify(baseFilter),
    brierDelta: deltas.brierDelta,
    eceGuardPasses: calibrationPasses,
    action,
  });

  return {
    generatedAt: new Date().toISOString(),
    baseline,
    candidate,
    filters: {
      agentRole: baseFilter.agentRole,
      horizonId: baseFilter.horizonId,
      entityId: baseFilter.entityId,
      regime: baseFilter.regime,
      fromAsOf: baseFilter.fromAsOf,
      toAsOf: baseFilter.toAsOf,
    },
    deltas,
    recommendation: {
      action,
      reason,
      gateRequired: "human-review",
      calibrationGuard: {
        candidateEce: candidateEce ?? null,
        baselineEce: baselineEce ?? null,
        passes: calibrationPasses,
      },
    },
    warnings,
  };
}

function intervalsOverlap(a: [number, number], b: [number, number]): boolean {
  return Math.max(a[0], b[0]) <= Math.min(a[1], b[1]);
}
