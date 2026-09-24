/**
 * Versionierte Promotion-Gate-Policies der Strategy-Lifecycle (RMA-P1-05).
 *
 * Eine Promotion (DRAFT→…→PAPER→LIVE_LIMITED→LIVE) ist NUR mit frischer,
 * strukturierter Evidenz erlaubt. Fehlende, stale oder zu kleine Stichproben
 * blockieren (fail-closed) — `null/unavailable` wird nie als 0 gewertet.
 *
 * Policy-Änderungen erzeugen bewusst eine NEUE `policyVersion`
 * (`slp1:<sha256>` über die kanonische Policy-JSON) — Vergangenheitsurteile
 * bleiben reproduzierbar, weil jede Transition ihre Policy-Version mit speichert.
 */
import { createHash } from "node:crypto";

/** Kanonische aktive Policy (Werte sind harte Defaults, nicht Env-tunable). */
export interface PromotionPolicy {
  readonly version: string;
  /** Mindestanzahl OOS-Trades im Backtest-Fenster. */
  readonly backtestMinTrades: number;
  /** Mindestdauer des Backtest-Zeitraums in ms (Eventzeit to−from). */
  readonly backtestMinDurationMs: number;
  /** Maximal erlaubte OOS-Drawdown-Schwelle in % des Kapitals (0–100). */
  readonly backtestMaxDrawdownPct: number;
  /** Mindest-Win-Rate OOS in [0,1]; null = keine Schwelle. */
  readonly backtestMinWinRate: number | null;
  /** Mindest-Profit-Faktor OOS; null = keine Schwelle. */
  readonly backtestMinProfitFactor: number | null;
  /** Mindest-Datenqualitäts-Score in [0,1] (0 = blockiere nie darüber). */
  readonly backtestMinDataQuality: number;
  /** Max. Alter einer Backtest-Evidenz ab `availableAt` (ms). */
  readonly backtestEvidenceMaxAgeMs: number;

  /** Mindestanzahl Trades im Paper-Fenster. */
  readonly paperMinTrades: number;
  /** Mindestdauer des Paper-Fensters in ms. */
  readonly paperMinDurationMs: number;
  /** Paper-Reconciliation muss innerhalb der Max.-Alter frisch und sauber sein. */
  readonly paperRequireCleanRecon: boolean;
  readonly paperReconMaxAgeMs: number;
  /** Max. durchschnittlicher Execution-Slippage im Paper (bp); null = aus. */
  readonly paperMaxAvgSlippageBps: number | null;
  /** Max. Alter einer Paper-Evidenz (ms). */
  readonly paperEvidenceMaxAgeMs: number;

  /** Mindeststichprobe für Drift-Bewertungen. */
  readonly driftMinSample: number;
  /** Recovery-Cooldown nach Degradation/Pause (ms) — nie automatisch kürzer. */
  readonly recoveryCooldownMs: number;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Roh-Objekt OHNE `version` — die Version wird daraus abgeleitet (kein Kreis). */
const POLICY_BODY = {
  backtestMinTrades: 100,
  backtestMinDurationMs: 14 * 24 * 60 * 60 * 1000,
  backtestMaxDrawdownPct: 25,
  backtestMinWinRate: null as number | null,
  backtestMinProfitFactor: 0.9 as number | null,
  backtestMinDataQuality: 0.8,
  backtestEvidenceMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  paperMinTrades: 100,
  paperMinDurationMs: 7 * 24 * 60 * 60 * 1000,
  paperRequireCleanRecon: true,
  paperReconMaxAgeMs: 24 * 60 * 60 * 1000,
  paperMaxAvgSlippageBps: 25 as number | null,
  paperEvidenceMaxAgeMs: 14 * 24 * 60 * 60 * 1000,
  driftMinSample: 100,
  recoveryCooldownMs: 6 * 60 * 60 * 1000,
} as const;

function policyVersion(body: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(body)
      .sort()
      .map((k) => [k, body[k]])
  );
  return `slp1:${sha256(canonical)}`;
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = Object.freeze({
  ...POLICY_BODY,
  version: policyVersion(POLICY_BODY),
});

/** Bounds für optionale Overrides (Tests/Experimente) — fail-closed Klemmung. */
export const PROMOTION_POLICY_BOUNDS = {
  backtestMinTrades: [1, 10_000] as const,
  backtestMinDurationMs: [60_000, 365 * 24 * 60 * 60 * 1000] as const,
  backtestMaxDrawdownPct: [1, 100] as const,
  backtestMinDataQuality: [0, 1] as const,
  backtestEvidenceMaxAgeMs: [60_000, 365 * 24 * 60 * 60 * 1000] as const,
  paperMinTrades: [1, 10_000] as const,
  paperMinDurationMs: [60_000, 365 * 24 * 60 * 60 * 1000] as const,
  paperReconMaxAgeMs: [60_000, 30 * 24 * 60 * 60 * 1000] as const,
  paperEvidenceMaxAgeMs: [60_000, 90 * 24 * 60 * 60 * 1000] as const,
  driftMinSample: [1, 10_000] as const,
  recoveryCooldownMs: [0, 30 * 24 * 60 * 60 * 1000] as const,
} as const;

function clamp(v: number, [min, max]: readonly [number, number]): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

/**
 * Baut eine Policy aus Overrides; unbekannte Werte werden bewusst ignoriert,
 * numerische Overrides geklemmt. `version` wird IMMER aus dem RESULTIERENDEN
 * Körper abgeleitet — zwei identische Körper teilen die Version.
 */
export function resolvePromotionPolicy(
  overrides: Partial<Omit<PromotionPolicy, "version">> = {}
): PromotionPolicy {
  const body: Record<string, unknown> = { ...POLICY_BODY };
  const b = PROMOTION_POLICY_BOUNDS;
  if (overrides.backtestMinTrades !== undefined)
    body.backtestMinTrades = clamp(overrides.backtestMinTrades, b.backtestMinTrades);
  if (overrides.backtestMinDurationMs !== undefined)
    body.backtestMinDurationMs = clamp(overrides.backtestMinDurationMs, b.backtestMinDurationMs);
  if (overrides.backtestMaxDrawdownPct !== undefined)
    body.backtestMaxDrawdownPct = clamp(overrides.backtestMaxDrawdownPct, b.backtestMaxDrawdownPct);
  if (overrides.backtestMinWinRate !== undefined)
    body.backtestMinWinRate =
      overrides.backtestMinWinRate === null
        ? null
        : clamp(overrides.backtestMinWinRate, [0, 1]);
  if (overrides.backtestMinProfitFactor !== undefined)
    body.backtestMinProfitFactor =
      overrides.backtestMinProfitFactor === null
        ? null
        : Math.max(0, overrides.backtestMinProfitFactor);
  if (overrides.backtestMinDataQuality !== undefined)
    body.backtestMinDataQuality = clamp(overrides.backtestMinDataQuality, b.backtestMinDataQuality);
  if (overrides.backtestEvidenceMaxAgeMs !== undefined)
    body.backtestEvidenceMaxAgeMs = clamp(overrides.backtestEvidenceMaxAgeMs, b.backtestEvidenceMaxAgeMs);
  if (overrides.paperMinTrades !== undefined)
    body.paperMinTrades = clamp(overrides.paperMinTrades, b.paperMinTrades);
  if (overrides.paperMinDurationMs !== undefined)
    body.paperMinDurationMs = clamp(overrides.paperMinDurationMs, b.paperMinDurationMs);
  if (overrides.paperRequireCleanRecon !== undefined)
    body.paperRequireCleanRecon = overrides.paperRequireCleanRecon === true;
  if (overrides.paperReconMaxAgeMs !== undefined)
    body.paperReconMaxAgeMs = clamp(overrides.paperReconMaxAgeMs, b.paperReconMaxAgeMs);
  if (overrides.paperMaxAvgSlippageBps !== undefined)
    body.paperMaxAvgSlippageBps =
      overrides.paperMaxAvgSlippageBps === null
        ? null
        : clamp(overrides.paperMaxAvgSlippageBps, [0, 1000]);
  if (overrides.paperEvidenceMaxAgeMs !== undefined)
    body.paperEvidenceMaxAgeMs = clamp(overrides.paperEvidenceMaxAgeMs, b.paperEvidenceMaxAgeMs);
  if (overrides.driftMinSample !== undefined)
    body.driftMinSample = clamp(overrides.driftMinSample, b.driftMinSample);
  if (overrides.recoveryCooldownMs !== undefined)
    body.recoveryCooldownMs = clamp(overrides.recoveryCooldownMs, b.recoveryCooldownMs);

  return Object.freeze({ ...(body as Omit<PromotionPolicy, "version">), version: policyVersion(body) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidenz-Instruktionen (rein, gegen die Policy bewertbar)
// ─────────────────────────────────────────────────────────────────────────────

export type GateCheckStatus = "PASS" | "FAIL" | "STALE" | "MISSING" | "INVALID";

export interface GateCheck {
  readonly id: string;
  readonly status: GateCheckStatus;
  readonly message: string;
  /** Beobachteter Wert (nie still 0 — null = unbekannt). */
  readonly observed: number | null;
  readonly required: number | null;
}

export interface GateEvaluation {
  readonly ok: boolean;
  readonly policyVersion: string;
  readonly checks: readonly GateCheck[];
}

function check(
  id: string,
  status: GateCheckStatus,
  message: string,
  observed: number | null,
  required: number | null
): GateCheck {
  return { id, status, message, observed, required };
}

function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface BacktestEvidenceInput {
  /** Eventzeit Start/Ende des Fensters (ms-epoch). */
  windowStartMs: number | null;
  windowEndMs: number | null;
  /** Verfügbarkeitszeit der Evidenz (ms-epoch). */
  availableAtMs: number;
  trades: number | null;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  dataQualityScore: number | null;
}

/**
 * Bewertet Backtest-Evidenz gegen die Policy. Jede fehlende Kennzahl ist
 * FAIL/MISSING — niemals ein stiller Bestehenwert 0.
 */
export function evaluateBacktestGate(
  ev: BacktestEvidenceInput,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
  nowMs: number = Date.now()
): GateEvaluation {
  const checks: GateCheck[] = [];

  // Frische (available_at → now)
  const age = nowMs - ev.availableAtMs;
  if (!Number.isFinite(ev.availableAtMs) || ev.availableAtMs <= 0) {
    checks.push(check("evidence.freshness", "INVALID", "availableAt fehlt/ist ungültig.", null, null));
  } else if (!Number.isFinite(age) || age < 0 || age > policy.backtestEvidenceMaxAgeMs) {
    checks.push(
      check(
        "evidence.freshness",
        "STALE",
        `Evidenzalter ${Number.isFinite(age) ? age : "unbekannt"} ms überschreitet ${policy.backtestEvidenceMaxAgeMs} ms.`,
        Number.isFinite(age) ? age : null,
        policy.backtestEvidenceMaxAgeMs
      )
    );
  } else {
    checks.push(check("evidence.freshness", "PASS", "Evidenz frisch.", age, policy.backtestEvidenceMaxAgeMs));
  }

  // Fensterdauer (Eventzeit)
  const duration =
    ev.windowStartMs !== null && ev.windowEndMs !== null && ev.windowEndMs >= ev.windowStartMs
      ? ev.windowEndMs - ev.windowStartMs
      : null;
  if (duration === null) {
    checks.push(check("window.duration", "MISSING", "Fensterzeiten fehlen/inkonsistent.", null, policy.backtestMinDurationMs));
  } else if (duration < policy.backtestMinDurationMs) {
    checks.push(check("window.duration", "FAIL", `Fenster zu kurz (${duration} ms).`, duration, policy.backtestMinDurationMs));
  } else {
    checks.push(check("window.duration", "PASS", "Fensterdauer erfüllt.", duration, policy.backtestMinDurationMs));
  }

  // Stichprobe
  const trades = finiteOrNull(ev.trades);
  if (trades === null || trades <= 0) {
    checks.push(check("sample.trades", "MISSING", "Trade-Anzahl fehlt — keine null-als-0-Wertung.", trades, policy.backtestMinTrades));
  } else if (trades < policy.backtestMinTrades) {
    checks.push(check("sample.trades", "FAIL", `Zu kleine Stichprobe (${trades}).`, trades, policy.backtestMinTrades));
  } else {
    checks.push(check("sample.trades", "PASS", "Mindeststichprobe erfüllt.", trades, policy.backtestMinTrades));
  }

  // Drawdown (niedriger = besser; Grenze ist Maximalwert)
  const dd = finiteOrNull(ev.maxDrawdownPct);
  if (dd === null || dd < 0) {
    checks.push(check("risk.maxDrawdownPct", "MISSING", "Drawdown fehlt/ungültig.", dd, policy.backtestMaxDrawdownPct));
  } else if (dd > policy.backtestMaxDrawdownPct) {
    checks.push(check("risk.maxDrawdownPct", "FAIL", `Drawdown ${dd}% > ${policy.backtestMaxDrawdownPct}%.`, dd, policy.backtestMaxDrawdownPct));
  } else {
    checks.push(check("risk.maxDrawdownPct", "PASS", "Drawdown im Rahmen.", dd, policy.backtestMaxDrawdownPct));
  }

  // Win-Rate (optional)
  if (policy.backtestMinWinRate !== null) {
    const wr = finiteOrNull(ev.winRate);
    if (wr === null || wr < 0 || wr > 1) {
      checks.push(check("perf.winRate", "MISSING", "Win-Rate fehlt/ungültig.", wr, policy.backtestMinWinRate));
    } else if (wr < policy.backtestMinWinRate) {
      checks.push(check("perf.winRate", "FAIL", `Win-Rate ${wr} < ${policy.backtestMinWinRate}.`, wr, policy.backtestMinWinRate));
    } else {
      checks.push(check("perf.winRate", "PASS", "Win-Rate erfüllt.", wr, policy.backtestMinWinRate));
    }
  }

  // Profit-Faktor (optional)
  if (policy.backtestMinProfitFactor !== null) {
    const pf = finiteOrNull(ev.profitFactor);
    if (pf === null) {
      checks.push(check("perf.profitFactor", "MISSING", "Profit-Faktor fehlt (null ≠ 0).", null, policy.backtestMinProfitFactor));
    } else if (pf < policy.backtestMinProfitFactor) {
      checks.push(check("perf.profitFactor", "FAIL", `Profit-Faktor ${pf} < ${policy.backtestMinProfitFactor}.`, pf, policy.backtestMinProfitFactor));
    } else {
      checks.push(check("perf.profitFactor", "PASS", "Profit-Faktor erfüllt.", pf, policy.backtestMinProfitFactor));
    }
  }

  // Datenqualität
  const dq = finiteOrNull(ev.dataQualityScore);
  if (dq === null || dq < 0 || dq > 1) {
    checks.push(check("data.quality", "MISSING", "Datenqualitäts-Score fehlt/ungültig.", dq, policy.backtestMinDataQuality));
  } else if (dq < policy.backtestMinDataQuality) {
    checks.push(check("data.quality", "FAIL", `Datenqualität ${dq} < ${policy.backtestMinDataQuality}.`, dq, policy.backtestMinDataQuality));
  } else {
    checks.push(check("data.quality", "PASS", "Datenqualität erfüllt.", dq, policy.backtestMinDataQuality));
  }

  return {
    ok: checks.every((c) => c.status === "PASS"),
    policyVersion: policy.version,
    checks,
  };
}

export interface PaperEvidenceInput {
  windowStartMs: number | null;
  windowEndMs: number | null;
  availableAtMs: number;
  trades: number | null;
  /** Letzte Reconciliation: clean=null (unbekannt), true, false. */
  reconClean: boolean | null;
  reconAtMs: number | null;
  avgSlippageBps: number | null;
}

/** Paper-Fenster-Gate: Mindestanzahl Trades, Dauer, saubere Reconciliation. */
export function evaluatePaperGate(
  ev: PaperEvidenceInput,
  policy: PromotionPolicy = DEFAULT_PROMOTION_POLICY,
  nowMs: number = Date.now()
): GateEvaluation {
  const checks: GateCheck[] = [];

  const age = nowMs - ev.availableAtMs;
  if (!Number.isFinite(ev.availableAtMs) || ev.availableAtMs <= 0) {
    checks.push(check("evidence.freshness", "INVALID", "availableAt fehlt/ist ungültig.", null, null));
  } else if (!Number.isFinite(age) || age < 0 || age > policy.paperEvidenceMaxAgeMs) {
    checks.push(
      check("evidence.freshness", "STALE", `Paper-Evidenz zu alt (${Number.isFinite(age) ? age : "?"} ms).`, Number.isFinite(age) ? age : null, policy.paperEvidenceMaxAgeMs)
    );
  } else {
    checks.push(check("evidence.freshness", "PASS", "Paper-Evidenz frisch.", age, policy.paperEvidenceMaxAgeMs));
  }

  const duration =
    ev.windowStartMs !== null && ev.windowEndMs !== null && ev.windowEndMs >= ev.windowStartMs
      ? ev.windowEndMs - ev.windowStartMs
      : null;
  if (duration === null) {
    checks.push(check("window.duration", "MISSING", "Paper-Fenster fehlt.", null, policy.paperMinDurationMs));
  } else if (duration < policy.paperMinDurationMs) {
    checks.push(check("window.duration", "FAIL", `Paper-Fenster zu kurz (${duration} ms).`, duration, policy.paperMinDurationMs));
  } else {
    checks.push(check("window.duration", "PASS", "Paper-Dauer erfüllt.", duration, policy.paperMinDurationMs));
  }

  const trades = finiteOrNull(ev.trades);
  if (trades === null || trades <= 0) {
    checks.push(check("sample.trades", "MISSING", "Paper-Trades fehlen.", trades, policy.paperMinTrades));
  } else if (trades < policy.paperMinTrades) {
    checks.push(check("sample.trades", "FAIL", `Zu kleine Paper-Stichprobe (${trades}).`, trades, policy.paperMinTrades));
  } else {
    checks.push(check("sample.trades", "PASS", "Paper-Stichprobe erfüllt.", trades, policy.paperMinTrades));
  }

  if (policy.paperRequireCleanRecon) {
    if (ev.reconClean === null || ev.reconAtMs === null) {
      checks.push(check("recon.clean", "MISSING", "Reconciliation unbekannt — fail-closed.", null, null));
    } else {
      const reconAge = nowMs - ev.reconAtMs;
      if (!Number.isFinite(reconAge) || reconAge < 0 || reconAge > policy.paperReconMaxAgeMs) {
        checks.push(
          check("recon.clean", "STALE", `Reconciliation zu alt (${Number.isFinite(reconAge) ? reconAge : "?"} ms).`, Number.isFinite(reconAge) ? reconAge : null, policy.paperReconMaxAgeMs)
        );
      } else if (!ev.reconClean) {
        checks.push(check("recon.clean", "FAIL", "Reconciliation meldet Diskrepanzen.", 0, 1));
      } else {
        checks.push(check("recon.clean", "PASS", "Reconciliation sauber und frisch.", 1, 1));
      }
    }
  }

  if (policy.paperMaxAvgSlippageBps !== null) {
    const s = finiteOrNull(ev.avgSlippageBps);
    if (s === null || s < 0) {
      checks.push(check("exec.avgSlippageBps", "MISSING", "Execution-Slippage fehlt.", s, policy.paperMaxAvgSlippageBps));
    } else if (s > policy.paperMaxAvgSlippageBps) {
      checks.push(check("exec.avgSlippageBps", "FAIL", `Slippage ${s} bp > ${policy.paperMaxAvgSlippageBps} bp.`, s, policy.paperMaxAvgSlippageBps));
    } else {
      checks.push(check("exec.avgSlippageBps", "PASS", "Execution-Qualität im Rahmen.", s, policy.paperMaxAvgSlippageBps));
    }
  }

  return {
    ok: checks.every((c) => c.status === "PASS"),
    policyVersion: policy.version,
    checks,
  };
}

/**
 * Evidenz-Alter-Check für bereits persistierte Evidence-Referenzen.
 * `null`/unbekannte `availableAt` ⇒ STALE (fail-closed, nie „frisch“).
 */
export function evidenceAgeStatus(
  availableAtMs: number | null,
  maxAgeMs: number,
  nowMs: number
): GateCheckStatus {
  if (availableAtMs === null || !Number.isFinite(availableAtMs) || availableAtMs <= 0) {
    return "MISSING";
  }
  const age = nowMs - availableAtMs;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return "STALE";
  return "PASS";
}
