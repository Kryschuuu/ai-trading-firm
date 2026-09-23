/**
 * Harte Gates vor jedem Submit/Reprice/Fallback (RMA-P4-02).
 *
 * Prüfreihenfolge (fail-closed, erste Verletzung gewinnt):
 *   1. Kill-Switch (prozessweit) — ein scharfer Switch stoppt ALLES.
 *   2. Live-Gate (nur Modus live) — delegiert an den zentralen Enforcer.
 *   3. Quote vorhanden (null = kein Submit, nie 0 als Preis).
 *   4. Quote frisch (Alter ≤ policy.maxQuoteAgeMs; Zukunft ⇒ stale).
 *   5. Spread ≤ policy.maxSpreadBps.
 *   6. Risk-Guard (`validateOrder` gegen echte Equity/Positionen).
 *   7. Policy-Notional (wenn policy.maxNotional > 0).
 *   8. Venue-Minimum/-Step (qty ≥ minQuantity, step-konform).
 *   9. Fallback zusätzlich: opt-in + bestätigter Cancel + Slippage-Schranke.
 *
 * Alle Reason-Codes sind geschlossen (bounded) und damit metrikfähig.
 * Kein Gate wirft bei fehlenden Daten einen Zahlenwert — `null` bleibt `null`
 * und führt zu DENY.
 */
import type { BrokerVenueId, ExecutionMode } from "../contracts/broker";
import { killSwitch, validateOrder } from "../lib/riskGuard";

export type GateReasonCode =
  | "OK"
  | "KILL_SWITCH_ARMED"
  | "LIVE_GATE_DENY"
  | "LIFECYCLE_GATE_DENY"
  | "QUOTE_MISSING"
  | "QUOTE_STALE"
  | "QUOTE_FUTURE"
  | "SPREAD_TOO_WIDE"
  | "SPREAD_UNKNOWN"
  | "RISK_GUARD_BLOCK"
  | "RISK_GUARD_ERROR"
  | "NOTIONAL_POLICY_CAP"
  | "QTY_BELOW_MINIMUM"
  | "QTY_STEP_VIOLATION"
  | "FALLBACK_DISABLED"
  | "FALLBACK_NO_CONFIRMED_CANCEL"
  | "SLIPPAGE_TOO_HIGH"
  | "ACCOUNT_UNAVAILABLE";

export interface GateQuote {
  mid: number;
  bid: number;
  ask: number;
  /** Relativer Spread als Anteil (0.0004 = 4 bp); null = unbekannt. */
  spread: number | null;
  /** Ereigniszeit des Quotes (Venue-/Ingest-Zeit, ms-epoch). */
  eventTime: number;
  /** Verfügbarkeitszeit (wann der Quote im Prozess bekannt wurde, ms-epoch). */
  availableAt: number;
}

export interface GateAccount {
  equity: number;
  openPositions: number;
}

export interface GateContext {
  venue: BrokerVenueId;
  mode: ExecutionMode;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  /** Erwarteter Ausführungspreis (Limit bzw. Mid-Schätzung für Market). */
  price: number;
  hasStopLoss: boolean;
  quote: GateQuote | null;
  account: GateAccount | null;
  now: number;
  maxSpreadBps: number;
  maxQuoteAgeMs: number;
  /** Zusätzliche Policy-Schranke (0 = nur Risk-Guard). */
  maxNotional: number;
  minQuantity: number;
  quantityStep: number;
  /** Injizierbare Live-Gate-Prüfung (Default: zentraler Enforcer, nur live). */
  liveGateAllowed?: (venue: BrokerVenueId) => { allowed: boolean; code: string };
  /**
   * RMA-P1-05: Strategy-Lifecycle-Gate für Live-Orders (zusätzlich zum
   * Broker-/Risk-Gate). Default ohne Injektion: fail-closed nur, wenn der
   * Lifecycle-Modus `enforce` ist — `off`/`monitor` bleiben kompatibel.
   * Liefert die autorisierte Strategieversion + Lifecycle-Zustand für Audit.
   */
  lifecycleGate?: () => {
    allowed: boolean;
    code: string;
    strategyKey?: string | null;
    strategyVersion?: number | null;
    lifecycleState?: string | null;
  };
  /** Strategieversion, die diese Order referenziert (enforce: Pflicht). */
  strategyKey?: string | null;
  strategyVersion?: number | null;
}

export interface GateDecision {
  allowed: boolean;
  reason: GateReasonCode;
  detail: string;
  notional: number | null;
}

function deny(reason: GateReasonCode, detail: string, notional: number | null = null): GateDecision {
  return { allowed: false, reason, detail, notional };
}

/**
 * Bewertet die Submit-Gates für EINE Order (Erst-Submit, Reprice, Fallback).
 * `purpose` unterscheidet nur die Detail-Texte — die Schranken sind identisch;
 * der Fallback hat ZUSÄTZLICH `evaluateFallback Gates` zu bestehen.
 */
export function evaluateSubmitGates(ctx: GateContext, purpose: "SUBMIT" | "REPRICE" | "FALLBACK"): GateDecision {
  if (killSwitch.isArmed()) {
    return deny("KILL_SWITCH_ARMED", `${purpose}: Kill-Switch ist scharf — keine Order.`);
  }
  if (ctx.mode === "live") {
    const check = ctx.liveGateAllowed;
    if (!check) {
      return deny("LIVE_GATE_DENY", `${purpose}: keine Live-Gate-Prüfung injiziert (fail-closed).`);
    }
    const decision = check(ctx.venue);
    if (!decision.allowed) {
      return deny("LIVE_GATE_DENY", `${purpose}: Live-Gate verweigert (${decision.code}).`);
    }
    // RMA-P1-05: Strategy-Lifecycle zusätzlich zum Broker-/Risk-Gate.
    const lifecycle = ctx.lifecycleGate;
    if (lifecycle) {
      const life = lifecycle();
      if (!life.allowed) {
        return deny(
          "LIFECYCLE_GATE_DENY",
          `${purpose}: Lifecycle-Gate verweigert (${life.code}).`
        );
      }
    }
  }
  const q = ctx.quote;
  if (!q) {
    return deny("QUOTE_MISSING", `${purpose}: kein Quote verfügbar — kein Submit ohne Preis.`);
  }
  if (!Number.isFinite(q.mid) || q.mid <= 0) {
    return deny("QUOTE_MISSING", `${purpose}: Quote ohne gültigen Mid.`);
  }
  if (!Number.isSafeInteger(q.availableAt) || q.availableAt > ctx.now) {
    return deny("QUOTE_FUTURE", `${purpose}: Quote-Verfügbarkeit liegt in der Zukunft.`);
  }
  const age = ctx.now - q.availableAt;
  if (!Number.isFinite(age) || age < 0 || age > ctx.maxQuoteAgeMs) {
    return deny("QUOTE_STALE", `${purpose}: Quote ist ${Number.isFinite(age) ? age : "unbekannt"} ms alt (max ${ctx.maxQuoteAgeMs} ms).`);
  }
  if (q.spread === null || q.spread === undefined) {
    return deny("SPREAD_UNKNOWN", `${purpose}: Spread unbekannt — kein Submit ohne Liquiditätsmaß.`);
  }
  if (!Number.isFinite(q.spread) || q.spread < 0) {
    return deny("SPREAD_UNKNOWN", `${purpose}: Spread ungültig.`);
  }
  const spreadBps = q.spread * 10_000;
  if (spreadBps > ctx.maxSpreadBps) {
    return deny(
      "SPREAD_TOO_WIDE",
      `${purpose}: Spread ${spreadBps.toFixed(1)} bp > max ${ctx.maxSpreadBps} bp.`
    );
  }
  if (!Number.isFinite(ctx.qty) || ctx.qty <= 0) {
    return deny("QTY_BELOW_MINIMUM", `${purpose}: Menge ungültig.`);
  }
  if (ctx.qty < ctx.minQuantity) {
    return deny(
      "QTY_BELOW_MINIMUM",
      `${purpose}: Menge ${ctx.qty} < Venue-Minimum ${ctx.minQuantity}.`
    );
  }
  if (ctx.quantityStep > 0) {
    const steps = ctx.qty / ctx.quantityStep;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      return deny(
        "QTY_STEP_VIOLATION",
        `${purpose}: Menge ${ctx.qty} verletzt den Venue-Step ${ctx.quantityStep}.`
      );
    }
  }
  if (!Number.isFinite(ctx.price) || ctx.price <= 0) {
    return deny("QUOTE_MISSING", `${purpose}: kein gültiger Ausführungspreis.`);
  }
  const notional = ctx.qty * ctx.price;
  if (!Number.isFinite(notional) || notional <= 0) {
    return deny("NOTIONAL_POLICY_CAP", `${purpose}: Notional nicht berechenbar.`);
  }
  if (ctx.maxNotional > 0 && notional > ctx.maxNotional) {
    return deny(
      "NOTIONAL_POLICY_CAP",
      `${purpose}: Notional ${notional.toFixed(2)} > Policy-Cap ${ctx.maxNotional}.`,
      notional
    );
  }
  if (!ctx.account) {
    return deny("ACCOUNT_UNAVAILABLE", `${purpose}: kein Kontostand für den Risk-Guard.`, notional);
  }
  try {
    const guard = validateOrder({
      notional,
      equity: ctx.account.equity,
      openPositions: ctx.account.openPositions,
      side: ctx.side,
      leverage: 1,
      hasStopLoss: ctx.hasStopLoss,
      symbol: ctx.symbol,
    });
    if (!guard.allowed) {
      return deny("RISK_GUARD_BLOCK", `${purpose}: Risk-Guard: ${guard.reason}`, notional);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 80) : "Risk-Guard-Fehler";
    return deny("RISK_GUARD_ERROR", `${purpose}: ${msg}`, notional);
  }
  return { allowed: true, reason: "OK", detail: `${purpose}: alle Gates bestanden.`, notional };
}

export interface FallbackGateContext {
  fallbackAllowed: boolean;
  cancelConfirmed: boolean;
  /** Geschätzte Slippage der Market-Order in bp (halber Spread + Puffer). */
  estimatedSlippageBps: number | null;
  maxSlippageBps: number;
}

/**
 * Fallback-Sondergates (NACH den Submit-Gates): Opt-in, bestätigter Cancel,
 * Slippage-Schranke. Ein unklarer Cancel-Status (`cancelConfirmed=false`)
 * blockiert den Market-Fallback IMMER — kein aggressiver Fallback.
 */
export function evaluateFallbackGates(ctx: FallbackGateContext): GateDecision {
  if (!ctx.fallbackAllowed) {
    return deny("FALLBACK_DISABLED", "FALLBACK: Market-Fallback ist nicht opt-in aktiviert.");
  }
  if (!ctx.cancelConfirmed) {
    return deny(
      "FALLBACK_NO_CONFIRMED_CANCEL",
      "FALLBACK: kein bestätigter Cancel — unklarer Status blockiert den Market-Fallback."
    );
  }
  if (ctx.estimatedSlippageBps === null || ctx.estimatedSlippageBps === undefined) {
    return deny("SLIPPAGE_TOO_HIGH", "FALLBACK: Slippage nicht schätzbar (Spread unbekannt).");
  }
  if (!Number.isFinite(ctx.estimatedSlippageBps) || ctx.estimatedSlippageBps < 0) {
    return deny("SLIPPAGE_TOO_HIGH", "FALLBACK: Slippage ungültig.");
  }
  if (ctx.estimatedSlippageBps > ctx.maxSlippageBps) {
    return deny(
      "SLIPPAGE_TOO_HIGH",
      `FALLBACK: geschätzte Slippage ${ctx.estimatedSlippageBps.toFixed(1)} bp > max ${ctx.maxSlippageBps} bp.`
    );
  }
  return { allowed: true, reason: "OK", detail: "FALLBACK: alle Fallback-Gates bestanden.", notional: null };
}

/**
 * Slippage-Schätzung für eine Market-Order: halber Spread (Crossing-Kosten) in
 * bp. Bewusst konservativ-einfach und dokumentiert — kein Modell, das
 * Tiefe rät, die es nicht kennt.
 */
export function estimateMarketSlippageBps(spread: number | null): number | null {
  if (spread === null || spread === undefined) return null;
  if (!Number.isFinite(spread) || spread < 0) return null;
  return (spread / 2) * 10_000;
}
