/**
 * Trade-Journal — Schreibpfade (GAP-03, v1.43.0, D1/D2).
 *
 * Die fehlende VERKNÜPFUNG (Position ↔ Entscheidungskette der Agenten) wird
 * hier in einer append-only Tabelle `trade_journal` geschlossen:
 *
 *   (a) Bei Eröffnung (Engine-Orderpfad, Mikro-Executor) entsteht die Zeile
 *       mit `decisionSnapshot` — dem unveränderlichen Foto der
 *       Entscheidungskette zum Eröffnungszeitpunkt. Fehlt die Verknüpfung
 *       (Position ohne Proposal/Regel, Altbestand), trägt der Snapshot
 *       `attribution: "UNKNOWN"` — die Lücke ist SICHTBAR, nie still geraten
 *       (fail-closed).
 *   (b) Beim Close (Monitor, Flatten) werden die Metriken ergänzt
 *       (PnL, MAE/MFE aus Kerzen, Haltedauer, Exit-Reason, Qualität).
 *
 * Robustheitsvertrag: Ein Journal-Fehler darf den Handelspfad NIE abbrechen
 * (die Position ist bereits sicher gebucht) — Fehler werden CRITICAL in das
 * audit_log gemeldet und die Lücke bleibt in `trade_journal` sichtbar
 * (fehlende Zeile bzw. Metriken null + quality-Flag).
 *
 * Determinismus: Alle Funktionen nehmen Zeitpunkte als Parameter (keine
 * Date.now()-Lesen im Rechenweg außer `closedAt`-Default beim Close).
 */
import { createHash } from "node:crypto";
import { db } from "../db";
import {
  agentMessages,
  agents,
  tradeJournal,
  tradeRules as tradeRulesTable,
} from "../db/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { flagMissedAudit, writeAuditRecord } from "./auditSink";
import { JOURNAL_CHAIN_WINDOW_HOURS, loadJournalConfig } from "./journalConfig";
import { computeMaeMfe, type CandleLike, type MetricsQuality } from "./journalMetrics";
import {
  SUPPORTED_TIMEFRAME_MS,
  type SupportedTimeframe,
} from "./marketdata/historicalStore";
import { getProductionMarketDataManager } from "./marketdata/production";

// ── Snapshot-Typen (Struktur von trade_journal.decision_snapshot) ───────────

/** Herkunft des Eröffnungspfad. */
export type JournalSource = "ENGINE" | "MICRO_EXECUTOR" | "UNKNOWN";

/** Attribution: wie zuverlässig ist die Verknüpfung? UNKNOWN = Lücke (sichtbar). */
export type JournalAttribution = "PROPOSAL" | "RULE" | "UNKNOWN";

export interface JournalVote {
  /** Agentenname zum Zeitpunkt des Turns (Audit-Snapshot, rename-resistent). */
  name: string;
  /** Agentenrolle (CEO | RESEARCH | BACKTEST | RISK_MANAGER | APPROVER | EXECUTOR | …). */
  role: string;
  /** Entscheidungstyp des Turns (TRADE | HOLD | APPROVE | REJECT | REPORT | KILL | …). */
  vote: string;
  /**
   * Explizite Confidence des Messages (Analysten-Turns, `meta.confidence`),
   * `null` wenn nicht vorhanden — unbekannt bleibt sichtbar, wird NICHT
   * geraten.
   */
  confidence: number | null;
  /** Risiko-Score (0..1) der Modell-Entscheidung, `null` wenn nicht vorhanden. */
  riskScore: number | null;
  /** ISO-Zeitstempel des Turns. */
  at: string;
}

/**
 * Unveränderliches Entscheidungs-Foto zum Eröffnungszeitpunkt.
 * `schemaVersion` erlaubt append-only Erweiterungen (neue Felder, alte
 * Lesbarkeit).
 */
export interface DecisionSnapshot {
  schemaVersion: 1;
  attribution: JournalAttribution;
  proposalId: string | null;
  ruleId: string | null;
  /**
   * Entscheidungskette: alle Agenten-Turns der Mission im Fenster
   * [Eröffnung − JOURNAL_CHAIN_WINDOW_HOURS, Eröffnung] mit `meta.decision`,
   * chronologisch. Leere Liste = keine strukturierten Stimmen auffindbar
   * (z. B. Regel-Trigger oder Datenlücke) — sichtbar, nicht interpretiert.
   */
  votes: JournalVote[];
  /** Wer den ausgeführten Vorschlag bzw. die Regel eingebracht hat. */
  proposer: { name: string; role: string } | null;
  /** Adaptives Regime zum Eröffnungszeitpunkt (inkl. UNKNOWN). */
  regime: string;
  /** Kanonischer Hash der Entscheidungsbasis (Proposal: reason+detail; Regel: signature). */
  rationaleHash: string;
  /** Eröffnungspfad (ENGINE | MICRO_EXECUTOR | UNKNOWN bei Backfill). */
  source: JournalSource;
}

/**
 * Fail-closed-Standard: Position ohne erkennbare Entscheidungskette.
 * Wird für Altbestand/Backfill und fehlgeschlagene Snapshots gebaut.
 */
export function unknownSnapshot(source: JournalSource = "UNKNOWN"): DecisionSnapshot {
  return {
    schemaVersion: 1,
    attribution: "UNKNOWN",
    proposalId: null,
    ruleId: null,
    votes: [],
    proposer: null,
    regime: "UNKNOWN",
    rationaleHash: "unknown",
    source,
  };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** try/catch-Helfer: gibt bei Fehlern den Fallback zurück (fail-closed, laut geloggt). */
async function safe<T>(fallback: T, fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[journal] ${what} fehlgeschlagen — Fallback: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

// ── Snapshot-Bau (Eröffnung) ────────────────────────────────────────────────

async function loadVotesForMission(missionId: string, openedAt: Date): Promise<JournalVote[]> {
  const windowStart = new Date(openedAt.getTime() - JOURNAL_CHAIN_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({
      createdAt: agentMessages.createdAt,
      meta: agentMessages.meta,
      agentName: agents.name,
      agentRole: agents.role,
    })
    .from(agentMessages)
    .leftJoin(agents, eq(agentMessages.agentId, agents.id))
    .where(
      and(
        eq(agentMessages.missionId, missionId),
        gte(agentMessages.createdAt, windowStart),
        lte(agentMessages.createdAt, openedAt)
      )
    )
    .orderBy(asc(agentMessages.createdAt))
    .limit(500);

  const votes: JournalVote[] = [];
  for (const r of rows) {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const decision = meta.decision as Record<string, unknown> | null | undefined;
    // Nur Turns mit strukturiertem `decision` sind Teil der Entscheidungskette
    // (Analysten-/Markt-Scans ohne Entscheidung bleiben außen vor).
    if (!decision || typeof decision.type !== "string") continue;
    const actor = (meta.actor ?? {}) as Record<string, unknown>;
    votes.push({
      name: typeof actor.name === "string" && actor.name ? actor.name : r.agentName ?? "UNKNOWN",
      role: typeof actor.role === "string" && actor.role ? actor.role : r.agentRole ?? "UNKNOWN",
      vote: decision.type,
      confidence: isFiniteNumber(meta.confidence) ? meta.confidence : null,
      riskScore: isFiniteNumber(decision.riskScore) ? decision.riskScore : null,
      at: r.createdAt.toISOString(),
    });
  }
  return votes;
}

async function resolveAgent(agentId: string | null | undefined): Promise<{ name: string; role: string } | null> {
  if (!agentId) return null;
  const [a] = await db
    .select({ name: agents.name, role: agents.role })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return a ? { name: a.name, role: a.role } : { name: "UNKNOWN", role: "UNKNOWN" };
}

/**
 * Snapshot aus einem genehmigten Vorschlag (Engine-Pfad). Stimmen =
 * Agenten-Turns der Mission im Kettenfenster; Regime = adaptives Regime zum
 * Eröffnungszeitpunkt (vom Aufrufer übergeben — die Engine kennt es).
 */
export async function buildProposalSnapshot(args: {
  proposalId: string;
  missionId: string | null;
  agentId: string | null;
  reason: string | null | undefined;
  detail: unknown;
  regime: string;
  source: JournalSource;
  openedAt: Date;
  ruleId?: string | null;
}): Promise<DecisionSnapshot> {
  const votes = await safe<JournalVote[]>(
    [],
    () => loadVotesForMission(args.missionId ?? "", args.openedAt),
    "votes laden"
  );
  const proposer = await safe<{ name: string; role: string } | null>(
    null,
    () => resolveAgent(args.agentId),
    "proposer auflösen"
  );
  const rationaleHash = sha256Hex(JSON.stringify({ reason: args.reason ?? "", detail: args.detail ?? null }));
  return {
    schemaVersion: 1,
    attribution: "PROPOSAL",
    proposalId: args.proposalId,
    ruleId: args.ruleId ?? null,
    votes,
    proposer,
    regime: args.regime || "UNKNOWN",
    rationaleHash,
    source: args.source,
  };
}

/**
 * Snapshot für regelförmige Eröffnungen (Mikro-Executor): Die
 * Entscheidungskette einer Regel ist die Regel selbst (Kanonischer
 * `signature`-Hash + Begründung + Ursprungsrolle) — es gibt keine
 * Agenten-Stimmen pro Trigger (sichtbare Lücke, NICHT erfunden).
 */
export async function buildRuleSnapshot(args: {
  ruleId: string;
  missionId: string | null;
  regime: string;
  source: JournalSource;
  openedAt: Date;
}): Promise<DecisionSnapshot> {
  const rule = await safe<{
    signature: string | null;
    sourceRole: string;
    sourceAgentId: string | null;
  } | null>(
    null,
    async () => {
      const [row] = await db
        .select({
          signature: tradeRulesTable.signature,
          sourceRole: tradeRulesTable.sourceRole,
          sourceAgentId: tradeRulesTable.sourceAgentId,
        })
        .from(tradeRulesTable)
        .where(eq(tradeRulesTable.id, args.ruleId))
        .limit(1);
      return row ?? null;
    },
    "regel laden"
  );
  let proposer: { name: string; role: string } | null = null;
  if (rule) {
    proposer = rule.sourceAgentId
      ? await safe<{ name: string; role: string } | null>(null, () => resolveAgent(rule.sourceAgentId), "regel-source auflösen") ??
        { name: rule.sourceRole, role: rule.sourceRole }
      : { name: rule.sourceRole, role: rule.sourceRole };
  }
  return {
    schemaVersion: 1,
    attribution: "RULE",
    proposalId: null,
    ruleId: args.ruleId,
    votes: [],
    proposer,
    regime: args.regime || "UNKNOWN",
    rationaleHash: rule?.signature ?? "unknown",
    source: args.source,
  };
}

// ── Eröffnung (Schreibweg a) ────────────────────────────────────────────────

export interface JournalOpenInput {
  positionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  openedAt: Date;
  missionId: string | null;
  ruleId: string | null;
  snapshot: DecisionSnapshot;
}

/**
 * Schreibt die Journal-Zeile zur Positionseröffnung (idempotent über den
 * UNIQUE-Index auf position_id). Wirft NICHT: Fehler → CRITICAL-Audit +
 * sichtbare Lücke.
 */
export async function recordJournalOpen(input: JournalOpenInput): Promise<{ written: boolean }> {
  try {
    await db
      .insert(tradeJournal)
      .values({
        positionId: input.positionId,
        symbol: input.symbol,
        side: input.side,
        openedAt: input.openedAt,
        missionId: input.missionId,
        ruleId: input.ruleId,
        decisionSnapshot: input.snapshot,
        regime: input.snapshot.regime || "UNKNOWN",
      })
      .onConflictDoNothing({ target: tradeJournal.positionId });
    return { written: true };
  } catch (e) {
    reportJournalError("open", input.positionId, e);
    return { written: false };
  }
}

// ── Kerzen (MAE/MFE-Quelle) ─────────────────────────────────────────────────

/**
 * Lädt die MAE/MFE-Kerzen aus dem Produktions-Historical-Store
 * (append-only NDJSON, `src/lib/marketdata/historicalStore.ts`).
 * `resolveInstrument` übersetzt das Positions-Symbol in die Instrument-ID
 * (z. B. BTC → PAPER:BTC); bleibt das Symbol ungelöst, wird der Rohname
 * als ID probiert — trifft er nicht, liefert die Query 0 Kerzen
 * (→ NO_DATA, NICHT geraten).
 */
export async function loadJournalCandles(
  symbol: string,
  openedAtMs: number,
  closedAtMs: number,
  timeframe: SupportedTimeframe
): Promise<{ candles: CandleLike[]; error: string | null }> {
  try {
    const manager = getProductionMarketDataManager();
    const instrument = manager.resolveInstrument(symbol);
    const instrumentId = instrument?.id ?? symbol;
    const rows = manager.store.query({
      instrumentId,
      timeframe,
      from: openedAtMs,
      to: closedAtMs,
    });
    return {
      candles: rows.map((c) => ({ ts: c.ts, high: c.high, low: c.low })),
      error: null,
    };
  } catch (e) {
    return { candles: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Close (Schreibweg b) ────────────────────────────────────────────────────

export interface JournalCloseInput {
  positionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  openedAt: Date;
  entryPrice: number;
  exitPrice: number;
  realizedPnl: number;
  exitReason: string | null;
  closedAt: Date;
  missionId: string | null;
  ruleId: string | null;
  /** Test-Injection: Kerzen vorbeiladen (umgeht den Store). */
  candles?: CandleLike[];
  /** Test-/Ops-Override des Kerzen-Intervalls (Default: JOURNAL_CANDLES_TIMEFRAME). */
  timeframe?: SupportedTimeframe;
}

export interface JournalCloseResult {
  closed: boolean;
  quality: MetricsQuality | "ERROR";
  maePct: number | null;
  mfePct: number | null;
  /** true, wenn die Zeile beim Close nachträglich angelegt wurde (Altbestand). */
  backfilled: boolean;
}

/**
 * Ergänzt die Journal-Zeile beim Close (Monitor, Flatten): PnL, MAE/MFE aus
 * Kerzen (Zeitmaske + Lücken-Flag, nicht schätzen), Haltedauer, Exit-Reason.
 *
 * Backfill: Existiert für die Position noch keine Zeile (Altbestand,
 * manuelle Position ohne Eröffnungshook), wird sie mit `attribution:
 * "UNKNOWN"` ANGELEGT — die Lücke der Entscheidungskette bleibt sichtbar.
 *
 * Wirft NICHT: Fehler → CRITICAL-Audit + `quality: "ERROR"`.
 */
export async function completeJournalRow(input: JournalCloseInput): Promise<JournalCloseResult> {
  const cfg = loadJournalConfig();
  const timeframe = input.timeframe ?? cfg.candlesTimeframe;

  // 1) Zeile sicherstellen (Backfill mit UNKNOWN-Snapshot bei Fehlen).
  type JournalRow = (typeof tradeJournal.$inferSelect)[];
  const readRow = () =>
    db
      .select()
      .from(tradeJournal)
      .where(eq(tradeJournal.positionId, input.positionId))
      .limit(1);
  let rows: JournalRow = await safe<JournalRow>([], readRow, "journal-zeile lesen");
  let backfilled = false;
  if (rows.length === 0) {
    backfilled = true;
    await db
      .insert(tradeJournal)
      .values({
        positionId: input.positionId,
        symbol: input.symbol,
        side: input.side,
        openedAt: input.openedAt,
        missionId: input.missionId,
        ruleId: input.ruleId,
        decisionSnapshot: unknownSnapshot("UNKNOWN"),
        regime: "UNKNOWN",
      })
      .onConflictDoNothing({ target: tradeJournal.positionId });
    rows = await safe<JournalRow>([], readRow, "journal-zeile nach backfill lesen");
  }
  if (rows.length === 0) {
    reportJournalError("close", input.positionId, new Error("journal-zeile fehlt (insert fehlgeschlagen?)"));
    return { closed: false, quality: "ERROR", maePct: null, mfePct: null, backfilled };
  }

  // 2) MAE/MFE (Kerzen → Zeitmaske → Lücken-Flag → Excursions).
  let maePct: number | null = null;
  let mfePct: number | null = null;
  let quality: MetricsQuality | "ERROR" = "ERROR";
  try {
    const openedAtMs = input.openedAt.getTime();
    const closedAtMs = input.closedAt.getTime();
    const loaded =
      input.candles !== undefined
        ? { candles: input.candles, error: null as string | null }
        : await loadJournalCandles(input.symbol, openedAtMs, closedAtMs, timeframe);
    if (loaded.error) {
      reportJournalError("candles", input.positionId, new Error(loaded.error));
      quality = "NO_DATA";
    } else {
      const res = computeMaeMfe({
        candles: loaded.candles,
        side: input.side,
        entryPrice: input.entryPrice,
        openedAtMs,
        closedAtMs,
        timeframeMs: SUPPORTED_TIMEFRAME_MS[timeframe],
      });
      maePct = res.maePct;
      mfePct = res.mfePct;
      quality = res.quality;
    }
  } catch (e) {
    quality = "ERROR";
    reportJournalError("metrics", input.positionId, e);
  }

  // 3) Persistieren.
  try {
    await db
      .update(tradeJournal)
      .set({
        closedAt: input.closedAt,
        pnl: String(input.realizedPnl),
        maePct: maePct == null ? null : String(maePct),
        mfePct: mfePct == null ? null : String(mfePct),
        holdingMinutes: Math.round((input.closedAt.getTime() - input.openedAt.getTime()) / 60_000),
        exitReason: input.exitReason,
        quality,
      })
      .where(eq(tradeJournal.positionId, input.positionId));
    return { closed: true, quality, maePct, mfePct, backfilled };
  } catch (e) {
    reportJournalError("close", input.positionId, e);
    return { closed: false, quality: "ERROR", maePct: null, mfePct: null, backfilled };
  }
}

// ── Fehlermeldung (fail-loud) ───────────────────────────────────────────────

function reportJournalError(phase: string, positionId: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[journal] ${phase} fehlgeschlagen (position ${positionId}): ${msg}`);
  void writeAuditRecord({
    event: "JOURNAL_WRITE_FAILED",
    level: "CRITICAL",
    detail: { phase, positionId, error: msg.slice(0, 300), via: "journal" },
    auditClass: "security",
  }).catch(() => {
    flagMissedAudit("JOURNAL_WRITE_FAILED", { phase, positionId });
  });
}
