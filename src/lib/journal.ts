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
 *       (PnL, MAE/MFE aus Kerzen, Haltedauer, Exit-Reason, Qualität) — und
 *       seit v1.57.0 (RMA-P1-06) zusätzlich die deterministische Netto-PnL-
 *       Attribution (append-only `trade_attributions`; Quellen + Kosten +
 *       Residual = Netto, siehe src/attribution/).
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
  positions,
  tradeJournal,
  tradeRules as tradeRulesTable,
} from "../db/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { recordTradeAttribution } from "../attribution/store";
import { loadAttributionConfig } from "../attribution/config";
import { fingerprint } from "../attribution/hashes";
import { flagMissedAudit, writeAuditRecord } from "./auditSink";
import { JOURNAL_CHAIN_WINDOW_HOURS, loadJournalConfig } from "./journalConfig";
import { computeMaeMfe, type CandleLike, type MetricsQuality } from "./journalMetrics";
import { getLimits } from "./riskGuard";
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
  /** Agentenrolle (CEO | RESEARCH | BACKTEST | RISK_MANAGER | APPROVER | EXECUTOR | DEVILS_ADVOCATE | …). */
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
  /**
   * Ziel-Instrument der Entscheidung (`decision.symbol`), `null` wenn die
   * Stimme kein Ziel nennt. v2 (RMA-P1-06): Grundlage der Richtungs-Logik der
   * Trade-Attribution — Stimmen für fremde Instrumente sind Enthaltungen.
   */
  symbol: string | null;
  /** Ziel-Richtung der Entscheidung (`decision.side`), `null` wenn unbelegt. */
  side: "LONG" | "SHORT" | null;
  /** Modell-Tag des Turns (`meta.model`), `null` wenn nicht vorhanden. */
  model: string | null;
}

/**
 * Exakte Versionskette zum Eröffnungszeitpunkt (v2, RMA-P1-06). Teil des
 * unveränderlichen Snapshots — eine spätere Prompt-/Regel-/Policy-Änderung
 * kann historische Attributionen nicht umdeuten.
 */
export interface DecisionSnapshotVersions {
  /**
   * Promptversion des Proposers (`agents.version`, W2-Optimistic-Lock) zum
   * Snapshot-Zeitpunkt; `null` = nicht ermittelbar.
   */
  promptVersion: number | null;
  /**
   * Agentenname → Promptversion zum Snapshot-Bauzeitpunkt. Historische
   * Turn-Versionen werden nicht rekonstruiert — die Zuordnung ist ein
   * Punkt-in-Zeit-Foto des Eröffnungszeitpunkts.
   */
  agentVersions: Record<string, number>;
  /** Regelversion (`trade_rules.version`) — null bei Proposal-Pfad. */
  ruleVersion: number | null;
  /** Stabile logische Regel-Identität (`trade_rules.rule_key`). */
  ruleKey: string | null;
  /** Fingerprint der wirksamen Risk-Policy (`rp1:<sha256>` über getLimits()). */
  policyVersion: string | null;
  /**
   * Fingerprint der Entscheidungsdaten (`df1:<sha256>`, z. B. Markt-Snapshot
   * der Engine / Trigger-Snapshot des Mikro-Executors); `null` = Aufrufer
   * hat keine Daten übergeben (sichtbare Lücke, nichts geraten).
   */
  dataFingerprint: string | null;
  /**
   * RMA-P3-03: Devil's-Advocate-Falsifikationsnachweis (additiv, optional).
   */
  devilsAdvocate?: {
    schemaVersion: string;
    disagreementScore: number;
    recommendedAction: string;
    riskScaleFactor: number;
    abstain: boolean;
    counterThesis: string;
    falsifiers: string[];
    failureModes: string[];
  } | null;
}

/**
 * Unveränderliches Entscheidungs-Foto zum Eröffnungszeitpunkt.
 * `schemaVersion` erlaubt append-only Erweiterungen (neue Felder, alte
 * Lesbarkeit). v2 (RMA-P1-06) ergänzt die Versionskette und den
 * `snapshotHash` (kanonischer SHA-256 über den Snapshot ohne den Hash selbst)
 * — spätere Uminterpretation wird erkennbar.
 */
export interface DecisionSnapshot {
  schemaVersion: 2;
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
  /** Versionskette zum Eröffnungszeitpunkt (v2). */
  versions: DecisionSnapshotVersions;
  /** `js2:<sha256>` — kanonischer Fingerprint des Snapshots (ohne sich selbst). */
  snapshotHash: string;
}

/**
 * Fail-closed-Standard: Position ohne erkennbare Entscheidungskette.
 * Wird für Altbestand/Backfill und fehlgeschlagene Snapshots gebaut.
 */
export function unknownSnapshot(source: JournalSource = "UNKNOWN"): DecisionSnapshot {
  const snapshot: Omit<DecisionSnapshot, "snapshotHash"> = {
    schemaVersion: 2,
    attribution: "UNKNOWN",
    proposalId: null,
    ruleId: null,
    votes: [],
    proposer: null,
    regime: "UNKNOWN",
    rationaleHash: "unknown",
    source,
    versions: {
      promptVersion: null,
      agentVersions: {},
      ruleVersion: null,
      ruleKey: null,
      policyVersion: null,
      dataFingerprint: null,
      devilsAdvocate: null,
    },
  };
  return { ...snapshot, snapshotHash: fingerprint("js2", snapshot) };
}

/** Versionskette inkl. Policy-Fingerprint (wirksame Limits zum Eröffnungszeitpunkt). */
function buildVersions(overrides: Partial<DecisionSnapshotVersions>): DecisionSnapshotVersions {
  return {
    promptVersion: null,
    agentVersions: {},
    ruleVersion: null,
    ruleKey: null,
    policyVersion: safePolicyFingerprint(),
    dataFingerprint: null,
    devilsAdvocate: null,
    ...overrides,
  };
}

/** Fingerprint der wirksamen Risk-Limits; `null` bei Lesefehler (sichtbar). */
function safePolicyFingerprint(): string | null {
  try {
    return fingerprint("rp1", getLimits());
  } catch {
    return null;
  }
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

async function loadVotesForMission(
  missionId: string,
  openedAt: Date
): Promise<{ votes: JournalVote[]; agentVersions: Record<string, number> }> {
  const windowStart = new Date(openedAt.getTime() - JOURNAL_CHAIN_WINDOW_HOURS * 3_600_000);
  const rows = await db
    .select({
      createdAt: agentMessages.createdAt,
      meta: agentMessages.meta,
      agentName: agents.name,
      agentRole: agents.role,
      agentVersion: agents.version,
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
  const agentVersions: Record<string, number> = {};
  for (const r of rows) {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const decision = meta.decision as Record<string, unknown> | null | undefined;
    // Nur Turns mit strukturiertem `decision` sind Teil der Entscheidungskette
    // (Analysten-/Markt-Scans ohne Entscheidung bleiben außen vor).
    if (!decision || typeof decision.type !== "string") continue;
    const actor = (meta.actor ?? {}) as Record<string, unknown>;
    const name =
      typeof actor.name === "string" && actor.name ? actor.name : r.agentName ?? "UNKNOWN";
    if (r.agentName && typeof r.agentVersion === "number") {
      agentVersions[r.agentName] = r.agentVersion;
    }
    votes.push({
      name,
      role: typeof actor.role === "string" && actor.role ? actor.role : r.agentRole ?? "UNKNOWN",
      vote: decision.type,
      confidence: isFiniteNumber(meta.confidence) ? meta.confidence : null,
      riskScore: isFiniteNumber(decision.riskScore) ? decision.riskScore : null,
      at: r.createdAt.toISOString(),
      // v2 (RMA-P1-06): Richtungsbeleg der Stimme — null bleibt sichtbar null.
      symbol: typeof decision.symbol === "string" && decision.symbol ? decision.symbol : null,
      side: decision.side === "LONG" || decision.side === "SHORT" ? decision.side : null,
      model: typeof meta.model === "string" && meta.model ? meta.model : null,
    });
  }
  return { votes, agentVersions };
}

async function resolveAgent(
  agentId: string | null | undefined
): Promise<{ name: string; role: string; version: number | null } | null> {
  if (!agentId) return null;
  const [a] = await db
    .select({ name: agents.name, role: agents.role, version: agents.version })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return a
    ? { name: a.name, role: a.role, version: typeof a.version === "number" ? a.version : null }
    : { name: "UNKNOWN", role: "UNKNOWN", version: null };
}

/**
 * Snapshot aus einem genehmigten Vorschlag (Engine-Pfad). Stimmen =
 * Agenten-Turns der Mission im Kettenfenster; Regime = adaptives Regime zum
 * Eröffnungszeitpunkt (vom Aufrufer übergeben — die Engine kennt es).
 *
 * v2 (RMA-P1-06): `promptVersion` = Promptversion des vorschlagenden Agenten,
 * `decisionData` = die Entscheidungsdaten der Engine (Markt-Snapshot) für den
 * Daten-Fingerprint. Beide optional — fehlend bleibt sichtbar null.
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
  /** Promptversion des Proposers (agents.version) — Aufrufer der Engine kennt sie. */
  promptVersion?: number | null;
  /** Entscheidungsdaten der Engine (z. B. Markt-Snapshot) für den Fingerprint. */
  decisionData?: unknown;
  /** RMA-P3-03: Optionaler Devil's Advocate Falsifikations-Befund */
  devilsAdvocate?: DecisionSnapshotVersions["devilsAdvocate"];
}): Promise<DecisionSnapshot> {
  const loaded = await safe<{ votes: JournalVote[]; agentVersions: Record<string, number> }>(
    { votes: [], agentVersions: {} },
    () => loadVotesForMission(args.missionId ?? "", args.openedAt),
    "votes laden"
  );
  const proposer = await safe<{ name: string; role: string; version: number | null } | null>(
    null,
    () => resolveAgent(args.agentId),
    "proposer auflösen"
  );
  const rationaleHash = sha256Hex(JSON.stringify({ reason: args.reason ?? "", detail: args.detail ?? null }));
  const snapshot: Omit<DecisionSnapshot, "snapshotHash"> = {
    schemaVersion: 2,
    attribution: "PROPOSAL",
    proposalId: args.proposalId,
    ruleId: args.ruleId ?? null,
    votes: loaded.votes,
    proposer,
    regime: args.regime || "UNKNOWN",
    rationaleHash,
    source: args.source,
    versions: buildVersions({
      // Explizite Angabe (Engine kennt den Agenten) schlägt die Auflösung;
      // sonst gilt die Promptversion des PROPOSERS (nicht des Executors).
      promptVersion: args.promptVersion ?? proposer?.version ?? null,
      agentVersions: loaded.agentVersions,
      dataFingerprint:
        args.decisionData === undefined ? null : fingerprint("df1", args.decisionData),
      devilsAdvocate: args.devilsAdvocate ?? null,
    }),
  };
  return { ...snapshot, snapshotHash: fingerprint("js2", snapshot) };
}

/**
 * Snapshot für regelförmige Eröffnungen (Mikro-Executor): Die
 * Entscheidungskette einer Regel ist die Regel selbst (Kanonischer
 * `signature`-Hash + Begründung + Ursprungsrolle + Versionskette) — es gibt
 * keine Agenten-Stimmen pro Trigger (sichtbare Lücke, NICHT erfunden).
 */
export async function buildRuleSnapshot(args: {
  ruleId: string;
  missionId: string | null;
  regime: string;
  source: JournalSource;
  openedAt: Date;
  /** Trigger-Snapshot des Mikro-Executors für den Daten-Fingerprint. */
  decisionData?: unknown;
}): Promise<DecisionSnapshot> {
  const rule = await safe<{
    signature: string | null;
    sourceRole: string;
    sourceAgentId: string | null;
    version: number | null;
    ruleKey: string | null;
  } | null>(
    null,
    async () => {
      const [row] = await db
        .select({
          signature: tradeRulesTable.signature,
          sourceRole: tradeRulesTable.sourceRole,
          sourceAgentId: tradeRulesTable.sourceAgentId,
          version: tradeRulesTable.version,
          ruleKey: tradeRulesTable.ruleKey,
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
  const snapshot: Omit<DecisionSnapshot, "snapshotHash"> = {
    schemaVersion: 2,
    attribution: "RULE",
    proposalId: null,
    ruleId: args.ruleId,
    votes: [],
    proposer,
    regime: args.regime || "UNKNOWN",
    rationaleHash: rule?.signature ?? "unknown",
    source: args.source,
    versions: buildVersions({
      ruleVersion: rule?.version ?? null,
      ruleKey: rule?.ruleKey ?? null,
      dataFingerprint:
        args.decisionData === undefined ? null : fingerprint("df1", args.decisionData),
    }),
  };
  return { ...snapshot, snapshotHash: fingerprint("js2", snapshot) };
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
  /**
   * Bekannte Gebühren des Trades (Kontowährung); `null`/fehlt = unbekannt —
   * die Attribution weist sie dann als unknownCosts aus, statt 0 zu raten.
   */
  fees?: number | null;
  /**
   * Bekanntes Funding (Kontosicht, negativ = gezahlt); fehlt es, liest der
   * Close-Pfad `positions.funding_paid` (fail-closed: Lesefehler ⇒ unbekannt).
   */
  funding?: number | null;
  /** Slippage-Memo (bereits in Fill-Preisen enthalten; nur Dokumentation). */
  slippage?: number | null;
}

export interface JournalCloseResult {
  closed: boolean;
  quality: MetricsQuality | "ERROR";
  maePct: number | null;
  mfePct: number | null;
  /** true, wenn die Zeile beim Close nachträglich angelegt wurde (Altbestand). */
  backfilled: boolean;
  /**
   * Deterministische PnL-Attribution (RMA-P1-06): `null` = deaktiviert oder
   * nicht ausgeführt; `status` siehe AttributionStatus. Ein Fehler hier
   * bricht den Close NIE (Audit JOURNAL_ATTRIBUTION_FAILED bleibt sichtbar).
   */
  attribution?: {
    status: "ATTRIBUTED" | "UNATTRIBUTABLE";
    methodVersion: number;
    created: boolean;
  };
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
  } catch (e) {
    reportJournalError("close", input.positionId, e);
    return { closed: false, quality: "ERROR", maePct: null, mfePct: null, backfilled };
  }

  // 4) Deterministische PnL-Attribution (RMA-P1-06, v1.57.0) — additiv und
  //    fehlertolerant: Basis ist der UNVERÄNDERLICHE Entry-Snapshot der Zeile
  //    (rows[0], vor dem Update gelesen) plus die Close-Fakten. Funding: vom
  //    Aufrufer oder aus `positions.funding_paid` (Lesefehler ⇒ unbekannt,
  //    nie 0 geraten). Gebühren sind im Paper-Close nicht ermittelbar ⇒
  //    unbekannt (sichtbar in unknown_costs). Ein Fehler blockiert den Close
  //    NICHT — er bleibt als JOURNAL_ATTRIBUTION_FAILED-Audit sichtbar.
  let attribution: JournalCloseResult["attribution"] = undefined;
  const attributionCfg = loadAttributionConfig();
  if (attributionCfg.enabled) {
    try {
      let funding = input.funding ?? null;
      if (funding === null) {
        const [posRow] = await db
          .select({ fundingPaid: positions.fundingPaid })
          .from(positions)
          .where(eq(positions.id, input.positionId))
          .limit(1);
        const raw = posRow?.fundingPaid;
        const n = raw === null || raw === undefined ? NaN : Number(raw);
        funding = Number.isFinite(n) ? n : null;
      }
      const res = await recordTradeAttribution({
        journalId: rows[0].id,
        positionId: input.positionId,
        closedAt: input.closedAt,
        symbol: input.symbol,
        side: input.side,
        regime: rows[0].regime || "UNKNOWN",
        grossPnl: input.realizedPnl,
        fees: input.fees ?? null,
        funding,
        slippage: input.slippage ?? null,
        snapshot: rows[0].decisionSnapshot,
        methodVersion: attributionCfg.methodVersion,
      });
      attribution = { status: res.status, methodVersion: res.methodVersion, created: res.created };
    } catch (e) {
      reportAttributionError(input.positionId, e);
    }
  }

  return { closed: true, quality, maePct, mfePct, backfilled, attribution };
}

/** Fail-loud-Reporting eines Attribution-Fehlers (blockiert den Close nie). */
function reportAttributionError(positionId: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[journal] attribution fehlgeschlagen (position ${positionId}): ${msg}`);
  void writeAuditRecord({
    event: "JOURNAL_ATTRIBUTION_FAILED",
    level: "WARN",
    detail: { positionId, error: msg.slice(0, 300), via: "journal" },
    auditClass: "security",
  }).catch(() => {
    flagMissedAudit("JOURNAL_ATTRIBUTION_FAILED", { positionId });
  });
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
