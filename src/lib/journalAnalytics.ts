/**
 * Trade-Journal — Auswertung & begrenzte Gewichts-Rückführung (GAP-03,
 * v1.43.0, D3/D4).
 *
 * Auswertung (D3):
 *   Trefferquote/Erwartungswert je Agent × Regime × Symbolgruppe aus den
 *   GESCHLOSSENEN Journal-Zeilen, mit Beta-Prior-Glättung
 *   (JOURNAL_BETA_PRIOR, α=β=2) und Mindest-Stichprobe
 *   (JOURNAL_MIN_TRADES, Default 20). Darunter: Kennzahl wird mit
 *   "insufficient-sample" ausgewiesen und NIEMALS als Faktor verwendet.
 *
 * Rückführung (D4, BEGRENZT):
 *   JOURNAL_FEEDBACK_MODE = off (Default, nur Auswertung) | monitor
 *   (vorgeschlagene Gewichte als Artefakt/Log) | enforce (Gewichte wirken im
 *   Approver-/Portfolio-Kontext: Prompt-Kontext der Engine + Persistenz in
 *   journal_agent_weights). Jede Gewichtsänderung: Bounds
 *   [JOURNAL_WEIGHT_MIN, JOURNAL_WEIGHT_MAX] (Default [0.5, 1.5]),
 *   maximale Änderung je Zyklus JOURNAL_MAX_WEIGHT_DELTA (Default 0.1) und
 *   revisionssicher im audit_log ("journal-weight:AGENT:REGIME:x→y").
 *
 * Sicherheitsbegründung des off-Defaults (siehe docs/HANDBUCH.md §13):
 * Der Lern-Loop ist genau dort am gefährlichsten, wo kleine Stichproben
 * Rauschen als Signal umsetzen würden. "off" hält den Entscheidungspfad
 * byte-identisch zu v1.42.x, bis die Auswertung geprüft wurde.
 */
import { db } from "../db";
import { journalAgentWeights, tradeJournal } from "../db/schema";
import { eq, isNotNull } from "drizzle-orm";
import { flagMissedAudit, writeAuditRecord } from "./auditSink";
import {
  JOURNAL_BETA_PRIOR,
  JOURNAL_WEIGHT_SCALE,
  loadJournalConfig,
  type JournalConfig,
} from "./journalConfig";
import type { DecisionSnapshot } from "./journal";
import { getProductionMarketDataManager } from "./marketdata/production";

// ── Reine Glättungs-/Gewichtsfunktionen (deterministisch, testbar) ─────────

/**
 * Beta-Prior-Glättung der Trefferquote:
 *   p = (wins + α) / (n + α + β),  α=β=2 (Default, JOURNAL_BETA_PRIOR)
 * n=0 → Prior-Mittelwert 0.5 (keine Evidenz = keine Aussage).
 */
export function smoothedWinRate(
  wins: number,
  n: number,
  alpha: number = JOURNAL_BETA_PRIOR.alpha,
  beta: number = JOURNAL_BETA_PRIOR.beta
): number {
  const w = Math.max(0, Math.floor(wins));
  const t = Math.max(0, Math.floor(n));
  return (w + alpha) / (t + alpha + beta);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type WeightBounds = Pick<JournalConfig, "weightMin" | "weightMax" | "maxWeightDelta">;

/**
 * Zielgewicht aus der glätteten Trefferquote:
 *   Ziel = 1.0 + (p − 0.5) × JOURNAL_WEIGHT_SCALE, geklemmt auf [min, max].
 * p=0.5 → 1.0 (neutral); p=1.0 → 1.5 bei Default-Bounds; p=0.0 → 0.5.
 */
export function targetWeight(smoothed: number, cfg: WeightBounds): number {
  return clamp(1 + (smoothed - 0.5) * JOURNAL_WEIGHT_SCALE, cfg.weightMin, cfg.weightMax);
}

/**
 * Schrittweise Annäherung: maximal JOURNAL_MAX_WEIGHT_DELTA je Zyklus,
 * Ergebnis immer innerhalb der Bounds (mehrere Zyklen → Annäherung,
 * nie Sprung).
 */
export function nextWeight(current: number, target: number, cfg: WeightBounds): number {
  const change = clamp(target - current, -cfg.maxWeightDelta, cfg.maxWeightDelta);
  return clamp(current + change, cfg.weightMin, cfg.weightMax);
}

// ── Gruppierung & Summary (D3) ──────────────────────────────────────────────

export interface JournalGroupStats {
  agent: string;
  regime: string;
  /** Symbolgruppe (Asset-Klasse) — `null` = Ebene „Agent × Regime“ (alle). */
  symbolGroup: string | null;
  trades: number;
  wins: number;
  /** Rohe Trefferquote (null bei 0 Trades). */
  winRate: number | null;
  /** Bayes-geglättete Trefferquote (immer definiert, n=0 → 0.5). */
  smoothedWinRate: number;
  sufficientSample: boolean;
  /** ok | insufficient-sample (darunter NIEMALS als Faktor). */
  status: "ok" | "insufficient-sample";
  /** Erwartungswert: mittleres P&L je Trade (null bei 0 Trades). */
  avgPnl: number | null;
  totalPnl: number;
  avgMaePct: number | null;
  avgMfePct: number | null;
  /** Vorgeschlagenes Gewicht — null wenn insufzient oder Modus "off". */
  proposedWeight: number | null;
  /** proposedWeight − currentWeight (geklammert auf maxWeightDelta). */
  weightChange: number | null;
}

export interface JournalWeightProposal {
  agent: string;
  regime: string;
  from: number;
  to: number;
  change: number;
  trades: number;
  smoothedWinRate: number;
  /** audit_log-Label: "journal-weight:AGENT:REGIME:x→y". */
  label: string;
}

export interface JournalSummary {
  schemaVersion: 1;
  asOf: string;
  config: {
    feedbackMode: string;
    minTrades: number;
    weightMin: number;
    weightMax: number;
    maxWeightDelta: number;
    betaAlpha: number;
    betaBeta: number;
  };
  totals: {
    closedTrades: number;
    attributedTrades: number;
    /** Attribution UNKNOWN (sichtbare Lücke, nicht geraten). */
    unattributedTrades: number;
    wins: number;
    totalPnl: number;
  };
  byAgentRegime: JournalGroupStats[];
  byAgentRegimeSymbol: JournalGroupStats[];
  weights: {
    mode: string;
    /** Aktuell wirksame Gewichte (journal_agent_weights; leere Liste = 1.0). */
    current: Array<{ agent: string; regime: string; weight: number; trades: number }>;
    /** Vorgeschlagene Änderungen (nur mit ausreichender Stichprobe; |Δ|>0). */
    proposed: JournalWeightProposal[];
  };
}

interface Accumulator {
  trades: number;
  wins: number;
  pnlSum: number;
  maeSum: number;
  maeCount: number;
  mfeSum: number;
  mfeCount: number;
}

function emptyAcc(): Accumulator {
  return { trades: 0, wins: 0, pnlSum: 0, maeSum: 0, maeCount: 0, mfeSum: 0, mfeCount: 0 };
}

function fmt3(x: number): string {
  return x.toFixed(3);
}

const EPSILON = 1e-9;

/**
 * Berechnet die vollständige Journal-Summary (geschlossene Zeilen,
 * Vollhistorie). Rein lesend — keine Schreibung.
 */
export async function computeJournalSummary(
  opts: { symbolGroupOf?: (symbol: string) => string } = {}
): Promise<JournalSummary> {
  const cfg = loadJournalConfig();
  const rows = await db
    .select()
    .from(tradeJournal)
    .where(isNotNull(tradeJournal.closedAt));

  const byAgentRegime = new Map<string, Accumulator>();
  const byAgentRegimeSymbol = new Map<string, Accumulator>();
  const totals: JournalSummary["totals"] = {
    closedTrades: 0,
    attributedTrades: 0,
    unattributedTrades: 0,
    wins: 0,
    totalPnl: 0,
  };

  for (const row of rows) {
    const pnl = Number(row.pnl ?? 0);
    const win = Number.isFinite(pnl) && pnl > 0;
    totals.closedTrades += 1;
    if (win) totals.wins += 1;
    totals.totalPnl += pnl;

    const snapshot = (row.decisionSnapshot ?? null) as DecisionSnapshot | null;
    const attribution = snapshot?.attribution === "PROPOSAL" || snapshot?.attribution === "RULE"
      ? snapshot.attribution
      : "UNKNOWN";
    if (attribution === "UNKNOWN") totals.unattributedTrades += 1;
    else totals.attributedTrades += 1;

    const regime = row.regime || "UNKNOWN";
    const symbolGroup = opts.symbolGroupOf?.(row.symbol) ?? "UNKNOWN";

    const votes = Array.isArray(snapshot?.votes) ? snapshot.votes : [];
    for (const v of votes) {
      const role = v && typeof v === "object" && typeof v.role === "string" && v.role ? v.role : "UNKNOWN";
      bump(byAgentRegime, `${role}::${regime}`, { pnl, win, mae: Number(row.maePct), mfe: Number(row.mfePct) });
      bump(byAgentRegimeSymbol, `${role}::${regime}::${symbolGroup}`, { pnl, win, mae: Number(row.maePct), mfe: Number(row.mfePct) });
    }
  }

  // Aktuell wirksame Gewichte (fehlende Tabelle = leer, nicht fatal).
  let current: JournalSummary["weights"]["current"] = [];
  try {
    const wRows = await db.select().from(journalAgentWeights);
    current = wRows
      .map((w) => ({
        agent: w.agentRole,
        regime: w.regime,
        weight: Number(w.weight),
        trades: w.trades,
      }))
      .sort((a, b) => (a.agent + a.regime < b.agent + b.regime ? -1 : 1));
  } catch {
    current = []; // Tabelle fehlt (vor Migration) → keine wirksamen Gewichte.
  }
  const currentMap = new Map(current.map((w) => [`${w.agent}::${w.regime}`, w.weight]));

  const buildStats = (map: Map<string, Accumulator>, withSymbolGroup: boolean): JournalGroupStats[] => {
    const out: JournalGroupStats[] = [];
    for (const [key, acc] of map) {
      const [agent, regime, symbolGroupRaw] = key.split("::");
      const sufficient = acc.trades >= cfg.minTrades;
      const p = smoothedWinRate(acc.wins, acc.trades);
      const currentWeight = currentMap.get(key) ?? 1.0;
      let proposedWeight: number | null = null;
      let weightChange: number | null = null;
      if (sufficient && cfg.feedbackMode !== "off") {
        proposedWeight = nextWeight(currentWeight, targetWeight(p, cfg), cfg);
        weightChange = proposedWeight - currentWeight;
      }
      out.push({
        agent,
        regime,
        symbolGroup: withSymbolGroup ? symbolGroupRaw ?? null : null,
        trades: acc.trades,
        wins: acc.wins,
        winRate: acc.trades > 0 ? acc.wins / acc.trades : null,
        smoothedWinRate: p,
        sufficientSample: sufficient,
        status: sufficient ? "ok" : "insufficient-sample",
        avgPnl: acc.trades > 0 ? acc.pnlSum / acc.trades : null,
        totalPnl: acc.pnlSum,
        avgMaePct: acc.maeCount > 0 ? acc.maeSum / acc.maeCount : null,
        avgMfePct: acc.mfeCount > 0 ? acc.mfeSum / acc.mfeCount : null,
        proposedWeight,
        weightChange,
      });
    }
    // Deterministische Sortierung: Stichprobe absteigend, dann Name.
    out.sort((a, b) => b.trades - a.trades || a.agent.localeCompare(b.agent) || a.regime.localeCompare(b.regime) || String(a.symbolGroup).localeCompare(String(b.symbolGroup)));
    return out;
  };

  const byAgentRegimeStats = buildStats(byAgentRegime, false);
  const byAgentRegimeSymbolStats = buildStats(byAgentRegimeSymbol, true);

  // Vorgeschlagene Gewichtsänderungen (nur ausreichende Stichprobe UND |Δ|>0).
  const proposed: JournalWeightProposal[] = [];
  for (const s of byAgentRegimeStats) {
    if (s.status !== "ok" || s.proposedWeight == null || Math.abs(s.weightChange ?? 0) <= EPSILON) continue;
    const from = currentMap.get(`${s.agent}::${s.regime}`) ?? 1.0;
    proposed.push({
      agent: s.agent,
      regime: s.regime,
      from,
      to: s.proposedWeight,
      change: s.weightChange as number,
      trades: s.trades,
      smoothedWinRate: s.smoothedWinRate,
      label: `journal-weight:${s.agent}:${s.regime}:${fmt3(from)}→${fmt3(s.proposedWeight)}`,
    });
  }

  return {
    schemaVersion: 1,
    asOf: new Date().toISOString(),
    config: {
      feedbackMode: cfg.feedbackMode,
      minTrades: cfg.minTrades,
      weightMin: cfg.weightMin,
      weightMax: cfg.weightMax,
      maxWeightDelta: cfg.maxWeightDelta,
      betaAlpha: JOURNAL_BETA_PRIOR.alpha,
      betaBeta: JOURNAL_BETA_PRIOR.beta,
    },
    totals,
    byAgentRegime: byAgentRegimeStats,
    byAgentRegimeSymbol: byAgentRegimeSymbolStats,
    weights: { mode: cfg.feedbackMode, current, proposed },
  };
}

function bump(
  map: Map<string, Accumulator>,
  key: string,
  d: { pnl: number; win: boolean; mae: number; mfe: number }
): void {
  const acc = map.get(key) ?? emptyAcc();
  acc.trades += 1;
  if (d.win) acc.wins += 1;
  acc.pnlSum += d.pnl;
  if (Number.isFinite(d.mae)) {
    acc.maeSum += d.mae;
    acc.maeCount += 1;
  }
  if (Number.isFinite(d.mfe)) {
    acc.mfeSum += d.mfe;
    acc.mfeCount += 1;
  }
  map.set(key, acc);
}

/**
 * Standard-Symbolgruppen-Resolver: Asset-Klasse aus der Instrument-Registry
 * (PAPER:BTC → "crypto", ALPACA:AAPL → "equity", …). Unbekanntes Symbol →
 * "UNKNOWN" (sichtbar, nicht geraten). Ergebnis pro Symbol gecacht.
 */
export function registrySymbolGroupResolver(): (symbol: string) => string {
  const cache = new Map<string, string>();
  return (symbol: string): string => {
    const hit = cache.get(symbol);
    if (hit) return hit;
    let group = "UNKNOWN";
    try {
      group = getProductionMarketDataManager().resolveInstrument(symbol)?.assetClass ?? "UNKNOWN";
    } catch {
      group = "UNKNOWN";
    }
    cache.set(symbol, group);
    return group;
  };
}

// ── Feedback (D4) ───────────────────────────────────────────────────────────

export interface JournalFeedbackResult {
  mode: string;
  /** true, wenn die Auswertung gelaufen ist (Modus ≠ off). */
  evaluated: boolean;
  changes: JournalWeightProposal[];
  errors: string[];
}

async function journalAudit(
  event: string,
  level: "INFO" | "WARN" | "CRITICAL",
  detail: Record<string, unknown>
): Promise<void> {
  try {
    const res = await writeAuditRecord({ event, level, detail, auditClass: "security" });
    if (!res.durable) {
      flagMissedAudit(event, { ...detail, reason: res.error ?? "audit nicht durable" });
    }
  } catch (e) {
    flagMissedAudit(event, { ...detail, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Einmal pro Zyklus (Daily-Cycle): Auswertung + modusabhängige
 * Gewichts-Rückführung.
 *
 *   off     → reine Auswertung (nichts geschrieben),
 *   monitor → vorgeschlagene Gewichte als audit_log-Events + Zyklus-Artefakt
 *             (entscheidungspfad bleibt UNBERÜHRT),
 *   enforce → Gewichte werden in journal_agent_weights persistiert und wirken
 *             im Approver-/Portfolio-Kontext (Prompt-Kontext der Engine);
 *             jede Änderung bounds- und delta-geklammert + audit_log.
 *
 * Wirft NICHT (ein Journal-Fehler darf den Zyklus nicht abbrechen).
 */
export async function evaluateJournalFeedback(): Promise<JournalFeedbackResult> {
  const cfg = loadJournalConfig();
  const result: JournalFeedbackResult = {
    mode: cfg.feedbackMode,
    evaluated: false,
    changes: [],
    errors: [],
  };
  if (cfg.feedbackMode === "off") return result;

  let summary: JournalSummary;
  try {
    summary = await computeJournalSummary({ symbolGroupOf: registrySymbolGroupResolver() });
    result.evaluated = true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`auswertung: ${msg}`);
    await journalAudit("JOURNAL_EVALUATION_FAILED", "CRITICAL", { error: msg.slice(0, 300), mode: cfg.feedbackMode });
    return result;
  }

  for (const p of summary.weights.proposed) {
    if (cfg.feedbackMode === "monitor") {
      await journalAudit("JOURNAL_WEIGHT_PROPOSED", "INFO", {
        agent: p.agent,
        regime: p.regime,
        from: p.from,
        to: p.to,
        change: round5(p.change),
        trades: p.trades,
        smoothedWinRate: round5(p.smoothedWinRate),
        label: p.label,
        source: "journal-feedback:monitor",
      });
      result.changes.push(p);
      continue;
    }
    // enforce: Persistieren + Audit (revisionssicher).
    try {
      const now = new Date();
      await db
        .insert(journalAgentWeights)
        .values({ agentRole: p.agent, regime: p.regime, weight: String(p.to), trades: p.trades, updatedAt: now })
        .onConflictDoUpdate({
          target: [journalAgentWeights.agentRole, journalAgentWeights.regime],
          set: { weight: String(p.to), trades: p.trades, updatedAt: now },
        });
      await journalAudit("JOURNAL_WEIGHT_APPLIED", "INFO", {
        agent: p.agent,
        regime: p.regime,
        from: p.from,
        to: p.to,
        change: round5(p.change),
        trades: p.trades,
        smoothedWinRate: round5(p.smoothedWinRate),
        label: p.label,
        source: "journal-feedback:enforce",
      });
      result.changes.push(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`${p.agent}/${p.regime}: ${msg}`);
      await journalAudit("JOURNAL_WEIGHT_APPLY_FAILED", "CRITICAL", {
        agent: p.agent,
        regime: p.regime,
        from: p.from,
        to: p.to,
        label: p.label,
        error: msg.slice(0, 300),
      });
    }
  }
  return result;
}

function round5(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

// ── Enforce-Kontext (Approver-/Portfolio-Prompt) ────────────────────────────

export interface EffectiveWeight {
  agent: string;
  weight: number;
  trades: number;
}

/**
 * Wirksame Gewichte für ein Regime — NUR im Modus "enforce" (off/monitor
 * liefern leer: der Entscheidungspfad bleibt in diesen Modi unverändert).
 * Fehlt die Tabelle → leer (sichtbar: keine Prompt-Zeile).
 */
export async function getEffectiveWeights(regime: string): Promise<EffectiveWeight[]> {
  const cfg = loadJournalConfig();
  if (cfg.feedbackMode !== "enforce") return [];
  try {
    const rows = await db
      .select()
      .from(journalAgentWeights)
      .where(eq(journalAgentWeights.regime, regime));
    return rows
      .map((r) => ({ agent: r.agentRole, weight: Number(r.weight), trades: r.trades }))
      .sort((a, b) => a.agent.localeCompare(b.agent));
  } catch {
    return [];
  }
}

/**
 * Deterministische Prompt-Zeile für den Engine-Prompt (Approver-/Portfolio-
 * Kontext) — leere Zeichenkette, wenn keine Gewichte wirken.
 */
export function formatJournalWeightsContext(weights: EffectiveWeight[], regime: string): string {
  if (!weights || weights.length === 0) return "";
  const lines = weights
    .slice()
    .sort((a, b) => a.agent.localeCompare(b.agent))
    .map((w) => `- ${w.agent}: ${w.weight.toFixed(2)} (aus ${w.trades} Trades)`);
  return [
    `JOURNAL-GEWICHTE (Regime ${regime || "UNKNOWN"}, aus dem Trade-Journal — Bayes-geglättet, Bounds [0.5, 1.5]):`,
    ...lines,
    "1.00 = neutral (kein Beleg). Auswertung: GET /api/firm/journal.",
  ].join("\n");
}
