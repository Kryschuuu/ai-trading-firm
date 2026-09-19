/**
 * VOL-BASIERTES POSITION-SIZING (GAP-04, v1.48.0, D1).
 *
 * Größe nach Volatilität, nie nach Bauchgefühl:
 *
 *   qty = (equity · riskPerTradePct) / |entry − stop|
 *
 * - Stop-Distanz: expliziter Stop (Agent/Regel) → dessen Abstand.
 *   Kein expliziter Stop → ATR-Fallback-Stop `entry − k·ATR` (SHORT gespiegelt),
 *   `k = RISK_ATR_STOP_MULT` (Default 2, Bounds [0.5, 6]).
 * - ATR fehlt oder ist nicht endliche Zahl → FAIL-CLOSED-Fallback auf die
 *   heutige Basis-Größe (Stop = `defaultStopLossPct`) + Kennzeichnung
 *   `unknown = true` + Audit-Notiz am Aufrufer (Muster adaptiveRisk v1.36.21:
 *   UNKNOWN ist ein eigener Zustand, kein stiller Wert). Kein Block.
 * - FRACTIONAL-KELLY als OBERGRENZE (kein Ersatz, kein Zwang):
 *   `RISK_KELLY_FRACTION` (Default 0 = aus, Bounds [0, 1]). Wirkt NUR, wenn
 *   Trefferquote/Payoff aus dem Trade-Journal (GAP-03) verfügbar sind
 *   (ausreichende Stichprobe, `JOURNAL_MIN_TRADES`); sonst wirkungslos —
 *   dokumentiert, kein stiller Zwangswert.
 *     f*        = (b·p − (1−p)) / b   (p = Win-Rate, b = Payoff = ØWin/ØLoss)
 *     maxNotional = equity · kellyFraction · f*
 *   f* ≤ 0 (kein positiver Edge) → Cap 0 → keine Größe (maschinell sichtbar).
 * - DAS ERGEBNIS WIRD IMMER AN DIE BESTEHENDEN GRENZEN GEKLEMT
 *   (maxPositionPct, maxRiskPerTrade via riskGuard/LIMIT_CEILINGS). Sizing
 *   kann die Limits nur verschärfen, nie lockern.
 *
 * Reinkern: `computePositionSize()` ist eine reine, deterministische Funktion
 * (kein I/O) — vollständig unit-testbar. Der Kelly-Edge-Loader (`resolveKellyEdge`)
 * ist der einzige I/O-Teil (DB + In-Memory-Cache, TTL 5 Min).
 */

import { and, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { tradeJournal } from "@/db/schema";
import { getLimits, requireFinitePositive } from "./riskGuard";
import { loadJournalConfig } from "./journalConfig";

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration (Env-Flags, Bounds + Defaults — s. CONFIGURATION.md)
// ─────────────────────────────────────────────────────────────────────────────

export type SizingConfig = {
  /** ATR-Stop-Multiplikator k für den Fallback-Stop (RISK_ATR_STOP_MULT). */
  atrStopMult: number;
  /** Fractional-Kelly-Anteil (RISK_KELLY_FRACTION); 0 = aus. */
  kellyFraction: number;
};

/** Erlaubtes Fenster pro Flag — Werte außerhalb werden geklemmt. */
export const SIZING_CONFIG_BOUNDS: Record<keyof SizingConfig, [min: number, max: number]> = {
  atrStopMult: [0.5, 6],
  kellyFraction: [0, 1],
};

/** Werkwerte = zugleich neutrale, sichere Defaults. */
export const DEFAULT_SIZING_CONFIG: SizingConfig = {
  atrStopMult: 2,
  kellyFraction: 0,
};

function clampTo(value: number, bounds: readonly [number, number]): number {
  if (!Number.isFinite(value)) return value;
  return Math.min(Math.max(value, bounds[0]), bounds[1]);
}

/**
 * Lädt und klemmt das Sizing-Setup aus der Umgebung. Ungültige Werte fallen
 * auf den Default (Fail-Safe in die neutrale Richtung, nie risikosteigernd).
 */
export function loadSizingConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): SizingConfig {
  const parse = (v: string | undefined): number | null => {
    if (v == null) return null;
    const s = String(v).trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const atrRaw = parse(env.RISK_ATR_STOP_MULT);
  const kellyRaw = parse(env.RISK_KELLY_FRACTION);
  return {
    atrStopMult: atrRaw != null
      ? clampTo(atrRaw, SIZING_CONFIG_BOUNDS.atrStopMult)
      : DEFAULT_SIZING_CONFIG.atrStopMult,
    kellyFraction: kellyRaw != null
      ? clampTo(kellyRaw, SIZING_CONFIG_BOUNDS.kellyFraction)
      : DEFAULT_SIZING_CONFIG.kellyFraction,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fractional-Kelly: Edge-Statistik aus dem Trade-Journal (GAP-03)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Edge-Statistik, die der Kelly-Deckel braucht. `fullKelly` ist die
 * UNVERKÜRZTE Kelly-Fraktion f* (kann negativ sein); das Fractional-
 * Multiplizieren mit `RISK_KELLY_FRACTION` passiert erst in
 * `computePositionSize`.
 */
export interface KellyEdge {
  source: "trade_journal";
  /** Geschlossene, mit P&L wertige Journal-Zeilen. */
  trades: number;
  wins: number;
  losses: number;
  /** Rohe Trefferquote (0…1). */
  winRate: number;
  /** Ø realisierte Gewinn-Position (Kontowährung, > 0). */
  avgWin: number;
  /** Ø realisierter Verlust in Betrag (Kontowährung, > 0). */
  avgLoss: number;
  /** Payoff b = avgWin / avgLoss (> 0). */
  payoff: number;
  /** f* = (b·p − (1−p)) / b — kann ≤ 0 sein (kein Edge). */
  fullKelly: number;
  at: string;
}

/** Cache-TTL für die Kelly-Statistik (Order-Pfad, kein Hintergrund-Job). */
export const KELLY_STATS_TTL_MS = 5 * 60_000;

const G = globalThis as typeof globalThis & {
  __kellyEdgeCache?: { at: number; value: KellyEdge | null };
};

/**
 * Ermittelt die Kelly-Edge aus dem Trade-Journal — mit In-Memory-Cache
 * (TTL `KELLY_STATS_TTL_MS`), damit der Order-Pfad nicht je Order die
 * Journaltabelle scannt.
 *
 * Liefert `null` (wirksam: Kelly-Deckel ist wirkungslos, nicht still):
 *   - `RISK_KELLY_FRACTION ≤ 0` (aus)
 *   - DB/Tabelle nicht erreichbar (fail-safe, sichtbar im Status-Endpunkt)
 *   - Stichprobe unter `JOURNAL_MIN_TRADES` (Default 20)
 *   - nur Gewinne oder nur Verluste (Payoff undefiniert — nie raten)
 *
 * Deterministisch bei unveränderter Journaltabelle; der Cache key-los,
 * weil die Statistik firmenweit (nicht je Symbol) gilt.
 */
export async function resolveKellyEdge(
  cfg: SizingConfig = loadSizingConfig(),
  now: number = Date.now()
): Promise<KellyEdge | null> {
  if (!(cfg.kellyFraction > 0)) return null;

  const cached = G.__kellyEdgeCache;
  if (cached && now - cached.at < KELLY_STATS_TTL_MS) return cached.value;

  let value: KellyEdge | null = null;
  try {
    const minTrades = loadJournalConfig().minTrades;
    const rows = await db
      .select({ pnl: tradeJournal.pnl })
      .from(tradeJournal)
      .where(and(isNotNull(tradeJournal.closedAt), isNotNull(tradeJournal.pnl)));

    let wins = 0;
    let losses = 0;
    let winSum = 0;
    let lossSum = 0;
    for (const r of rows) {
      const pnl = Number(r.pnl);
      if (!Number.isFinite(pnl)) continue;
      if (pnl > 0) {
        wins += 1;
        winSum += pnl;
      } else if (pnl < 0) {
        losses += 1;
        lossSum += -pnl;
      }
    }
    const trades = wins + losses;
    // Stichprobe zu klein oder Payoff undefiniert → kein Edge (kein Raten).
    if (trades >= minTrades && wins > 0 && losses > 0) {
      const avgWin = winSum / wins;
      const avgLoss = lossSum / losses;
      if (avgWin > 0 && avgLoss > 0) {
        const winRate = wins / trades;
        const payoff = avgWin / avgLoss;
        value = {
          source: "trade_journal",
          trades,
          wins,
          losses,
          winRate,
          avgWin,
          avgLoss,
          payoff,
          fullKelly: (payoff * winRate - (1 - winRate)) / payoff,
          at: new Date(now).toISOString(),
        };
      }
    }
  } catch {
    value = null; // DB nicht erreichbar / Tabelle fehlt → Deckel wirkungslos.
  }
  G.__kellyEdgeCache = { at: now, value };
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kern: reine Sizing-Funktion
// ─────────────────────────────────────────────────────────────────────────────

export type PositionSide = "LONG" | "SHORT";

export interface PositionSizeInput {
  /** Account-Equity in Kontowährung (muss > 0, sonst RiskValidationError). */
  equity: number;
  /** Risikobudget pro Trade als Dezimalzahl (0.02 = 2 %). Wird gegen
   *  `maxRiskPerTrade` (wirksames Limit) geklemmt — Sizing lockert nie. */
  riskPerTradePct: number;
  /** Eintrittskurs (muss > 0, sonst RiskValidationError). */
  entryPrice: number;
  /** ATR in PREISEINHEITEN (z. B. 350 $ bei BTC). null/undefined/NaN/≤0
   *  = nicht verfügbar → Fallback-Pfad. */
  atr?: number | null;
  /** Expliziter Stop in Preiseinheiten (null/undefined = keine Angabe →
   *  ATR-Fallback). Muss seitenkonsistent sein (LONG: unter, SHORT: über
   *  dem Entry) — ein seitenfalscher Stop wird verworfen. */
  stopLoss?: number | null;
  /** Handelsrichtung (Default LONG). */
  side?: PositionSide;
  /** Missions-Cap `maxPositionPct` — darf die globale Grenze nur
   *  verschärfen (Sandbox-Prinzip, wie missionSizedNotional). */
  missionMaxPositionPct?: number | null;
  /** Kelly-Edge aus `resolveKellyEdge` (null = Deckel wirkungslos). */
  kelly?: KellyEdge | null;
  /** Sizing-Konfiguration (Default `loadSizingConfig()`). */
  cfg?: SizingConfig;
}

export interface PositionSizeResult {
  /** Endgültiges Notional (Kontowährung) — an ALLE Grenzen geklemmt. */
  notional: number;
  /** qty = notional / entry, auf 6 Nachkommastellen (repo-konform). */
  qty: number;
  /** Stop in Preiseinheiten (je nach Quelle explizit / ATR / Fallback). */
  stopPrice: number;
  /** Stop-Distanz in Preiseinheiten (|entry − stop|). */
  stopDistance: number;
  /** Stop-Distanz als Anteil des Entry (Dezimal). */
  stopDistancePct: number;
  /** Woher der Stop stammt. */
  stopSource: "EXPLICIT" | "ATR" | "FALLBACK";
  /**
   * true = ATR UND expliziter Stop fehlten → Fallback auf die heutige
   *  Basis-Größe (defaultStopLossPct). Aufrufer kennzeichnet das im
   *  Entscheidungskontext + Audit-Notiz (fail-closed, kein Block).
   */
  unknown: boolean;
  /** Wirksam genutzter ATR-Stop-Multiplikator (nur bei stopSource ATR relevant). */
  atrStopMult: number;
  /** Wirksam genutztes Risikobudget (nach Clamp auf maxRiskPerTrade). */
  riskPerTrade: number;
  /** Wirksamer Positions-Cap (Mission ∩ global). */
  capPct: number;
  kelly: {
    /** RISK_KELLY_FRACTION > 0. */
    enabled: boolean;
    fraction: number;
    /** true = der Kelly-Deckel hat das Notional reduziert (oder auf 0). */
    applied: boolean;
    /** equity · fraction · f* (null = wirkungslos). Kann 0 sein (f* ≤ 0). */
    capNotional: number | null;
    /** f* (null = wirkungslos). */
    fullKelly: number | null;
    /** off | no-stats | neutral | applied | zero-edge (maschinenlesbar). */
    reason: "off" | "no-stats" | "neutral" | "applied" | "zero-edge";
  };
  /** Welche Deckel tatsächlich gegriffen haben (maschinell lesbar). */
  clampedBy: string[];
  /** Menschen-/Agenten-lesbare Notiz (Audit-/Trace-Zeile). */
  note: string;
}

/**
 * Berechnet die Positionsgröße nach Volatilität (reine Funktion).
 *
 * Reihenfolge der Klemmung: 1) Kelly-Deckel, 2) Positions-Cap
 * (Missions-Cap ∩ maxPositionPct). Der Risikobudget-Clamp auf
 * maxRiskPerTrade passiert VOR der Formel — das Ergebnis überschreitet die
 * Sandbox damit unter keinen Umständen.
 *
 * @throws RiskValidationError bei equity/entryPrice ≤ 0 oder nicht endlich
 *   (fail-closed, konsistent mit `validateOrder`).
 */
export function computePositionSize(input: PositionSizeInput): PositionSizeResult {
  const equity = requireFinitePositive(input.equity, "equity");
  const entry = requireFinitePositive(input.entryPrice, "entryPrice");
  const side: PositionSide = input.side === "SHORT" ? "SHORT" : "LONG";
  const limits = getLimits();
  const cfg = input.cfg ?? loadSizingConfig();
  const atrK = clampTo(Number.isFinite(cfg.atrStopMult) ? cfg.atrStopMult : DEFAULT_SIZING_CONFIG.atrStopMult, SIZING_CONFIG_BOUNDS.atrStopMult);
  const kellyFraction = clampTo(Number.isFinite(cfg.kellyFraction) ? cfg.kellyFraction : 0, SIZING_CONFIG_BOUNDS.kellyFraction);

  // 1) Risikobudget: immer ≤ wirksamer maxRiskPerTrade (nie lockern).
  const rawRisk = Number(input.riskPerTradePct);
  const riskPerTrade =
    Number.isFinite(rawRisk) && rawRisk > 0
      ? Math.min(rawRisk, limits.maxRiskPerTrade)
      : limits.maxRiskPerTrade;

  // 2) Positions-Cap: Mission darf nur verschärfen (Sandbox-Prinzip).
  const missionCap = Number(input.missionMaxPositionPct);
  const capPct =
    Number.isFinite(missionCap) && missionCap > 0
      ? Math.min(missionCap, limits.maxPositionPct)
      : limits.maxPositionPct;

  // 3) Stop-Distanz: explizit → ATR-Fallback → Basis-Fallback (UNKNOWN).
  const explicit = Number(input.stopLoss);
  const explicitOk =
    Number.isFinite(explicit) &&
    explicit > 0 &&
    explicit !== entry &&
    (side === "LONG" ? explicit < entry : explicit > entry);
  const atrValue = Number(input.atr);
  const atrOk = Number.isFinite(atrValue) && atrValue > 0;

  let stopDistance: number;
  let stopPrice: number;
  let stopSource: PositionSizeResult["stopSource"];
  let unknown = false;

  if (explicitOk) {
    stopDistance = Math.abs(entry - explicit);
    stopPrice = explicit;
    stopSource = "EXPLICIT";
  } else if (atrOk) {
    stopDistance = atrK * atrValue;
    stopPrice = side === "LONG" ? entry - stopDistance : entry + stopDistance;
    stopSource = "ATR";
  } else {
    // FAIL-CLOSED (Muster adaptiveRisk v1.36.21): keine ATR, kein Stop →
    // heutige Basis-Größe (defaultStopLossPct) + Kennzeichnung. Kein Block,
    // kein stiller Wert.
    const fallbackPct = limits.defaultStopLossPct;
    stopDistance = entry * fallbackPct;
    stopPrice = side === "LONG" ? entry * (1 - fallbackPct) : entry * (1 + fallbackPct);
    stopSource = "FALLBACK";
    unknown = true;
  }

  // 4) Risikoformel: qty = Risikobudget$ / Stop-Distanz.
  const baseNotional = (equity * riskPerTrade * entry) / stopDistance;

  // 5) Fractional-Kelly-Deckel (nur mit verfügbaren Statistiken wirksam).
  const kellyOn = kellyFraction > 0;
  let kellyCap: number | null = null;
  let kellyFull: number | null = null;
  let kellyReason: PositionSizeResult["kelly"]["reason"] = kellyOn ? "no-stats" : "off";
  if (kellyOn && input.kelly != null && Number.isFinite(input.kelly.fullKelly) && input.kelly.payoff > 0) {
    kellyFull = input.kelly.fullKelly;
    kellyCap = Math.max(0, equity * kellyFraction * kellyFull);
  }
  let notional = baseNotional;
  const clampedBy: string[] = [];
  let kellyApplied = false;
  if (kellyCap != null && kellyCap < notional) {
    notional = kellyCap;
    kellyApplied = true;
    clampedBy.push("kelly");
    kellyReason = kellyCap <= 0 ? "zero-edge" : "applied";
  } else if (kellyCap != null) {
    kellyReason = "neutral";
  }

  // 6) Positions-Cap (maxPositionPct ∩ Mission).
  const maxNotional = equity * capPct;
  if (notional > maxNotional) {
    notional = maxNotional;
    clampedBy.push("maxPositionPct");
  }
  if (!Number.isFinite(notional) || notional < 0) notional = 0;

  const qty = Number((notional / entry).toFixed(6));
  const stopDistancePct = stopDistance / entry;

  let note: string;
  if (stopSource === "ATR") {
    note = `ATR-Fallback-Stop ${atrK}×ATR=${stopDistance.toFixed(2)} (kein expliziter Stop)`;
  } else if (stopSource === "FALLBACK") {
    note = `UNKNOWN: ATR und expliziter Stop fehlen — Fallback auf Basis-Größe (Stop ${limits.defaultStopLossPct * 100} %)`;
  } else {
    note = `Expliziter Stop ${stopDistance.toFixed(2)} vom Entry`;
  }
  if (kellyApplied) note += ` + Kelly-Deckel (f*=${kellyFull!.toFixed(4)}, Cap ${kellyCap!.toFixed(2)})`;

  return {
    notional,
    qty,
    stopPrice,
    stopDistance,
    stopDistancePct,
    stopSource,
    unknown,
    atrStopMult: atrK,
    riskPerTrade,
    capPct,
    kelly: {
      enabled: kellyOn,
      fraction: kellyFraction,
      applied: kellyApplied,
      capNotional: kellyCap,
      fullKelly: kellyFull,
      reason: kellyReason,
    },
    clampedBy,
    note,
  };
}
