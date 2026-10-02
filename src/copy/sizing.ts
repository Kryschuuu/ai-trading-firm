/**
 * Copy-Trading — Sizing & Hebel-Politik (Phase 7 · Paket 00-02 · STX-07-01).
 *
 * **Rein**, keine IO/DB/Netz. Berechnet das Follower-Notional aus der
 * Leader-Handlabsicht und wendet die Hebel-Politik an.
 *
 * Fail-closed-Prinzip (durchgängig): jeder nicht auflösbare Zustand endet in
 * `{ok:false}` mit **benanntem** Grund. Es gibt **keinen** stillen Moduswechsel
 * (z. B. EQUITY_RATIO ohne leaderEquity darf NICHT auf FIXED_RATIO zurückfallen
 * — das ist genau der Fehler, den niemand findet).
 */

import type {
  LeveragePolicy,
  SizingMode,
  TradeAction,
} from "./types";

/** Eingabe für die Follower-Notional-Berechnung. */
export interface SizingInput {
  mode: SizingMode;
  /** Leader-Handlungsabsicht (CLOSE erzwingt Notional 0, Intent bleibt bestehen). */
  action: TradeAction;
  /** Leader-Notional in Quote-Währung — nötig für FIXED_RATIO & EQUITY_RATIO. */
  leaderNotional: number | null;
  /** Leader-Equity — nötig für EQUITY_RATIO (explizit vom Adapter). */
  leaderEquity: number | null;
  /** Follower-Equity — nötig für EQUITY_RATIO. */
  followerEquity: number | null;
  /** FIXED_AMOUNT: absolute Notional-Größe für den Follower. */
  fixedAmount: number;
  /** FIXED_RATIO: Multiplikator auf das Leader-Notional. */
  ratio: number;
  /** EQUITY_RATIO: zusätzlicher Risiko-Multiplikator (Default 1). */
  multiplier: number;
}

/** Ergebnis der Notional-Berechnung (fail-closed). */
export type SizingResult =
  | {
      ok: true;
      notional: number;
      mode: SizingMode;
      leaderNotional: number | null;
      leaderEquity: number | null;
      followerEquity: number | null;
      multiplier: number;
      leverageApplied: number | null;
    }
  | {
      ok: false;
      reason: string;
    };

function finiteOrDefault(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

function okResult(input: SizingInput, notional: number): SizingResult {
  return {
    ok: true,
    notional,
    mode: input.mode,
    leaderNotional: input.leaderNotional,
    leaderEquity: input.leaderEquity,
    followerEquity: input.followerEquity,
    multiplier: finiteOrDefault(input.multiplier, 1),
    leverageApplied: null,
  };
}

/**
 * Berechnet das Follower-Notional.
 *
 * | Modus         | Formel                                              |
 * |---------------|-----------------------------------------------------|
 * | FIXED_AMOUNT  | `fixedAmount` (konstante Follower-Größe)            |
 * | FIXED_RATIO   | `leaderNotional × ratio` (skaliert nicht mit Follower) |
 * | EQUITY_RATIO  | `followerEquity × (leaderNotional / leaderEquity) × multiplier` |
 *
 * Fail-closed-Regeln:
 *  - `leaderEquity <= 0` (EQUITY_RATIO) ⇒ `{ok:false}` (kein Undefined-Divisor).
 *  - `leaderNotional <= 0` bei OPEN ⇒ `{ok:false}` (keine Größe ohne Notional).
 *  - `CLOSE` ⇒ Notional = 0, aber der Intent **existiert** (Position zugeteilt).
 *  - `EQUITY_RATIO` ohne `leaderEquity` ⇒ `{ok:false}` — **kein** Fallback.
 */
export function computeFollowerNotional(input: SizingInput): SizingResult {
  const { mode, action } = input;

  // CLOSE: die Position muss zugeteilt/geschlossen werden. Notional ist 0,
  // aber der Intent bleibt bestehen (niemals still verwerfen).
  if (action === "CLOSE") {
    return {
      ok: true,
      notional: 0,
      mode,
      leaderNotional: input.leaderNotional,
      leaderEquity: input.leaderEquity,
      followerEquity: input.followerEquity,
      multiplier: finiteOrDefault(input.multiplier, 1),
      leverageApplied: null,
    };
  }

  if (mode === "FIXED_AMOUNT") {
    const amount = input.fixedAmount;
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, reason: "FIXED_AMOUNT_REQUIRES_POSITIVE_AMOUNT" };
    }
    return okResult(input, amount);
  }

  if (mode === "FIXED_RATIO") {
    const leaderNotional = input.leaderNotional;
    if (leaderNotional == null || !Number.isFinite(leaderNotional) || leaderNotional <= 0) {
      return { ok: false, reason: "FIXED_RATIO_REQUIRES_POSITIVE_LEADER_NOTIONAL" };
    }
    if (!Number.isFinite(input.ratio)) {
      return { ok: false, reason: "FIXED_RATIO_REQUIRES_FINITE_RATIO" };
    }
    return okResult(input, leaderNotional * input.ratio);
  }

  // EQUITY_RATIO
  const leaderEquity = input.leaderEquity;
  if (leaderEquity == null || !Number.isFinite(leaderEquity) || leaderEquity <= 0) {
    // Fehlendes leaderEquity wird NICHT auf FIXED_RATIO zurückgeführt.
    return { ok: false, reason: "EQUITY_RATIO_REQUIRES_LEADER_EQUITY" };
  }
  const followerEquity = input.followerEquity;
  if (followerEquity == null || !Number.isFinite(followerEquity) || followerEquity <= 0) {
    return { ok: false, reason: "EQUITY_RATIO_REQUIRES_FOLLOWER_EQUITY" };
  }
  const leaderNotional = input.leaderNotional;
  if (leaderNotional == null || !Number.isFinite(leaderNotional) || leaderNotional <= 0) {
    // leaderNotional <= 0 (bes. bei OPEN) ⇒ nicht auflösbar.
    return { ok: false, reason: "EQUITY_RATIO_REQUIRES_POSITIVE_LEADER_NOTIONAL" };
  }
  const multiplier = finiteOrDefault(input.multiplier, 1);
  const notional = followerEquity * (leaderNotional / leaderEquity) * multiplier;
  return okResult(input, notional);
}

/** Ergebnis der Hebel-Politik-Anwendung. */
export interface LeverageDecision {
  leverage: number | null;
  /** true, wenn der Leader-Hebel auf den Follower-Cap geklemmt wurde. */
  adjusted: boolean;
  /** Benannter Grund (für Audit/UI). */
  reason: string;
}

/**
 * Wendet die Hebel-Politik an.
 *
 * - `FOLLOW_LEADER`: übernimmt den Leader-Hebel. Ist `leaderLeverage > cap`,
 *   wird auf `cap` **geklemmt** (nicht abgelehnt) und `adjusted: true`.
 * - `CAP`: verwendet zwingend den Follower-Cap.
 * - `IGNORE`: kein Hebel (null).
 * - `RISK_NORMALIZED`: risikonormalisiert — klemmt den Leader-Hebel auf den
 *   Follower-Risiko-Cap (fail-closed; ohne Cap kein Klemmen).
 */
export function applyLeveragePolicy(
  policy: LeveragePolicy,
  leaderLeverage: number | null,
  followerCap: number | null
): LeverageDecision {
  switch (policy) {
    case "FOLLOW_LEADER": {
      if (leaderLeverage == null || !Number.isFinite(leaderLeverage) || leaderLeverage <= 0) {
        return { leverage: null, adjusted: false, reason: "FOLLOW_LEADER_MISSING_LEADER_LEVERAGE" };
      }
      if (
        followerCap != null &&
        Number.isFinite(followerCap) &&
        followerCap > 0 &&
        leaderLeverage > followerCap
      ) {
        return { leverage: followerCap, adjusted: true, reason: "FOLLOW_LEADER_CLAMPED_TO_CAP" };
      }
      return { leverage: leaderLeverage, adjusted: false, reason: "FOLLOW_LEADER" };
    }
    case "CAP": {
      if (followerCap == null || !Number.isFinite(followerCap) || followerCap <= 0) {
        return { leverage: null, adjusted: false, reason: "CAP_MISSING_CAP" };
      }
      return { leverage: followerCap, adjusted: false, reason: "CAP" };
    }
    case "IGNORE": {
      return { leverage: null, adjusted: false, reason: "IGNORE" };
    }
    case "RISK_NORMALIZED": {
      if (leaderLeverage == null || !Number.isFinite(leaderLeverage) || leaderLeverage <= 0) {
        return { leverage: null, adjusted: false, reason: "RISK_NORMALIZED_MISSING_LEADER_LEVERAGE" };
      }
      if (
        followerCap != null &&
        Number.isFinite(followerCap) &&
        followerCap > 0 &&
        leaderLeverage > followerCap
      ) {
        return { leverage: followerCap, adjusted: true, reason: "RISK_NORMALIZED_CLAMPED_TO_CAP" };
      }
      return { leverage: leaderLeverage, adjusted: false, reason: "RISK_NORMALIZED" };
    }
    default: {
      // Exhaustiveness guard (LeveragePolicy ist ein abgeschlossenes Union).
      return { leverage: null, adjusted: false, reason: "UNKNOWN_LEVERAGE_POLICY" };
    }
  }
}
