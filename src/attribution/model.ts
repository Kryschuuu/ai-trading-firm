/**
 * Trade-PnL-Attribution — reine Berechnung (RMA-P1-06, v1.57.0).
 *
 * ── Spezifikation der Methode ta1 (DETERMINISTIC_ALLOCATION) ───────────────
 *
 * ZULÄSSIGE QUELLEN (v1):
 *   AGENT  Stimmen der Entscheidungskette (Entry-Snapshot) sowie der Proposer
 *          des ausgeführten Vorschlags. Quellen-ID = Agentenname, Version =
 *          Promptversion (agents.version) zum Snapshot-Zeitpunkt.
 *   RULE   Die Regel, die den Trade ausgelöst hat (rule_key + version). Die
 *          Entscheidungskette einer Regel ist die Regel selbst — es werden
 *          KEINE Agentenstimmen erfunden.
 *   COST   Bekannte Kostenkomponenten FEES (−fees) und FUNDING (+funding,
 *          Kontosicht). Slippage ist bewusst KEIN eigenständiger Posten: Sie
 *          ist bereits in den Fill-Preisen enthalten und würde doppelt
 *          gezählt; sie wird als Memo mitgeführt.
 *
 * VOTES / ABSTENTION / NEGATIVE BEITRÄGE:
 *   Richtungsbelegte TRADE-Stimmen (side UND symbol passen) erhalten
 *   Alignment +1 (gleichgerichtete Trade-Richtung) bzw. −1 (entgegengesetzte
 *   Richtung → negativer Beitrag bei Gewinn, positiver bei Verlust). Stimmen
 *   ohne side, mit fremdem Symbol oder mit nicht-richtungsbelegendem Typ
 *   (HOLD/REPORT/APPROVE/REJECT/KILL) sind ENTHALTUNGEN: Alignment 0,
 *   Beitrag exakt 0 — sichtbar als eigene Zeile. Ein REJECT/KILL wird NICHT
 *   spekulativ als Gegenstimme gewertet: Ohne Proposal-Verknüpfung ist nicht
 *   belegt, dass es DIESEN Trade betraf.
 *   Der PROPOSER ist über die proposalId fest an diesen Trade gebunden und
 *   erhält Alignment +1 — die Proposal-Verknüpfung schlägt die Turn-Auswertung.
 *   Mehrere Turns desselben Agenten: die chronologisch LETZTE Stimme gewinnt
 *   (stabile Sortierung nach `at`, dann Eingabereihenfolge).
 *
 * NORMALISIERTE GEWICHTE:
 *   w_i = clamp(confidence_i, 0, 1) je Teilnehmer; fehlende Confidence → 0.5
 *   (Beta(2,2)-Prior-Mittelwert, konsistent mit journalAnalytics).
 *   n_i = w_i / Σ w_j (Summe 1 über alle Teilnehmer). Beitrag:
 *
 *     contribution_i = round8(allocatable × alignment_i × n_i)
 *
 *   Die QUELLEN teilen immer das BRUTTO-PnL (allocatable = grossPnl); Kosten
 *   werden als eigene negative/signed Posten ausgewiesen. Widersprüchliche
 *   Stimmen reduzieren die erklärbare Masse: Σ alignment_i × n_i < 1, der
 *   Differenzbetrag verbleibt IM Residual (Konflikte werden nicht weggewichtet).
 *
 * RECONCILIATION (erzwungen):
 *     netPnl = grossPnl − (fees ?? 0) + (funding ?? 0)
 *     | Σ Quellen + Σ Kosten + Residual − netPnl | ≤ 1e-6
 *   Das Residual wird als letzte Größe aus den gerundeten Beiträgen berechnet
 *   und schluckt damit nur Rundungsreste (≤ 1e-8 je Posten). Verletzung der
 *   Toleranz ⇒ AttributionError (Ergebnis wird verworfen, nie still korrigiert).
 *
 * UNATTRIBUTABLE (fail-closed):
 *   Kein Snapshot, v1-Snapshot (keine Richtungsdaten der Stimmen, keine
 *   Versionskette), beschädigter Snapshot oder keine auswertbare Quelle ⇒
 *   Status UNATTRIBUTABLE mit geschlossenem Grund; bekannte Kosten werden
 *   trotzdem als Posten ausgewiesen, der Rest verbleibt im Residual. Es wird
 *   NIEMALS eine Quelle geschätzt.
 *
 * DETERMINISMUS:
 *   Rein: keine Uhr, kein Zufall, kein IO. Identische Eingabe ⇒ identische
 *   Ausgabe (Golden-Test). Point-in-Time: Alle Eingaben stammen aus dem
 *   unveränderlichen Entry-Snapshot bzw. den Close-Fakten; spätere
 *   Agenten-/Promptänderungen können historische Attribution nicht verändern.
 */

import {
  ATTRIBUTION_DECLARATION,
  ATTRIBUTION_DEFAULT_CONFIDENCE,
  ATTRIBUTION_DECIMALS,
  ATTRIBUTION_METHOD_TAG,
  ATTRIBUTION_RECONCILIATION_TOLERANCE,
  AttributionError,
  type AttributionAlignment,
  type AttributionEntry,
  type TradeAttribution,
  type TradeAttributionInput,
  type UnattributableReason,
  type UnknownCostComponent,
} from "./types";
import { fingerprint } from "./hashes";

// ── Schmale Sicht auf den Entry-Snapshot (strukturell, ohne DB-Import) ──────

interface VoteView {
  name: string;
  role: string;
  vote: string;
  confidence: number | null;
  at?: string;
  symbol?: string | null;
  side?: "LONG" | "SHORT" | null;
}

interface SnapshotView {
  schemaVersion: number;
  attribution?: unknown;
  votes?: unknown;
  proposer?: { name?: unknown; role?: unknown } | null;
  versions?: {
    promptVersion?: unknown;
    agentVersions?: unknown;
    ruleVersion?: unknown;
    ruleKey?: unknown;
  };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function roundDecimals(x: number): number {
  const f = 10 ** ATTRIBUTION_DECIMALS;
  return Math.round(x * f) / f;
}

// ── Alignment der Stimmen ───────────────────────────────────────────────────

/**
 * Richtungsrelation einer Stimme zum Trade. Nur TRADE-Stimmen mit belegter
 * Seite (und passendem/fehlendem Symbol) tragen Richtung; alles andere ist
 * Enthaltung (0). Siehe Modul-Docstring für die Begründung je Typ.
 */
export function voteAlignment(
  vote: VoteView,
  trade: { symbol: string; side: "LONG" | "SHORT" }
): AttributionAlignment {
  const type = typeof vote.vote === "string" ? vote.vote.toUpperCase() : "";
  if (type !== "TRADE") return 0;
  const voteSymbol =
    typeof vote.symbol === "string" && vote.symbol.trim() !== ""
      ? vote.symbol.toUpperCase()
      : null;
  if (voteSymbol !== null && voteSymbol !== trade.symbol.toUpperCase()) return 0;
  if (vote.side === trade.side) return 1;
  if (vote.side === "LONG" || vote.side === "SHORT") return -1;
  return 0;
}

/** Konfidenz einer Stimme: clamp [0,1]; fehlend/ungültig → dokumentierter Prior 0.5. */
export function effectiveConfidence(confidence: number | null): number {
  if (!isFiniteNumber(confidence)) return ATTRIBUTION_DEFAULT_CONFIDENCE;
  return Math.min(Math.max(confidence, 0), 1);
}

// ── Hauptfunktion ───────────────────────────────────────────────────────────

/**
 * Berechnet die deterministische Attribution eines geschlossenen Trades.
 * Rein und werfen bei invaliden Eingaben (AttributionError) — niemals still
 * korrigiert. Siehe Modul-Docstring für die vollständige Spezifikation.
 */
export function computeTradeAttribution(input: TradeAttributionInput): TradeAttribution {
  if (input.methodVersion !== 1) {
    throw new AttributionError(
      "unsupported-method-version",
      `Methodenversion ${input.methodVersion} ist nicht implementiert (erlaubt: 1).`
    );
  }
  if (typeof input.symbol !== "string" || input.symbol.trim() === "") {
    throw new AttributionError("invalid-symbol", "Symbol fehlt oder ist leer.");
  }
  if (input.side !== "LONG" && input.side !== "SHORT") {
    throw new AttributionError("invalid-side", `Seite "${String(input.side)}" ist nicht LONG/SHORT.`);
  }
  if (!isFiniteNumber(input.grossPnl)) {
    throw new AttributionError(
      "invalid-gross-pnl",
      "Realisiertes PnL ist keine endliche Zahl — Attribution wird verworfen (fail-closed).",
      { grossPnl: String(input.grossPnl) }
    );
  }
  if (input.fees !== null && (!isFiniteNumber(input.fees) || input.fees < 0)) {
    throw new AttributionError("invalid-fees", "Gebühren müssen ≥ 0 oder null (unbekannt) sein.");
  }
  if (input.funding !== null && !isFiniteNumber(input.funding)) {
    throw new AttributionError("invalid-funding", "Funding muss endlich oder null (unbekannt) sein.");
  }
  const slippageMemo = input.slippage ?? null;
  if (slippageMemo !== null && (!isFiniteNumber(slippageMemo) || slippageMemo < 0)) {
    throw new AttributionError("invalid-slippage", "Slippage-Memo muss ≥ 0 oder null sein.");
  }

  const fees = input.fees;
  const funding = input.funding;
  const netPnl = roundDecimals(input.grossPnl - (fees ?? 0) + (funding ?? 0));
  const unknownCosts: UnknownCostComponent[] = [];
  if (fees === null) unknownCosts.push("FEES");
  if (funding === null) unknownCosts.push("FUNDING");

  // Kosten-Posten (bekannte Komponenten; unbekannte bleiben sichtbar geflaggt).
  const entries: AttributionEntry[] = [];
  let costsSum = 0;
  if (fees !== null) {
    entries.push({
      sourceType: "COST",
      sourceId: "FEES",
      sourceVersion: ATTRIBUTION_METHOD_TAG,
      role: null,
      alignment: 0,
      weight: null,
      contribution: roundDecimals(-fees),
    });
    costsSum += roundDecimals(-fees);
  }
  if (funding !== null) {
    entries.push({
      sourceType: "COST",
      sourceId: "FUNDING",
      sourceVersion: ATTRIBUTION_METHOD_TAG,
      role: null,
      alignment: 0,
      weight: null,
      contribution: roundDecimals(funding),
    });
    costsSum += roundDecimals(funding);
  }
  costsSum = roundDecimals(costsSum);

  // Snapshot auswerten (fail-closed bei fehlender/beschädigter Struktur).
  const parsed = parseSnapshot(input.snapshot);

  if (parsed.kind === "unattributable") {
    const residual = roundDecimals(netPnl - costsSum);
    assertReconciliation(0, costsSum, residual, netPnl);
    return {
      methodVersion: input.methodVersion,
      methodTag: ATTRIBUTION_METHOD_TAG,
      declaration: ATTRIBUTION_DECLARATION,
      status: "UNATTRIBUTABLE",
      unattributableReason: parsed.reason,
      snapshotHash: parsed.snapshotHash,
      snapshotSchemaVersion: parsed.schemaVersion,
      symbol: input.symbol,
      side: input.side,
      grossPnl: input.grossPnl,
      fees,
      funding,
      slippageMemo,
      netPnl,
      sourcesSum: 0,
      costsSum,
      residual,
      unknownCosts,
      participants: 0,
      abstentions: 0,
      entries,
    };
  }

  // ── Quellen sammeln ──────────────────────────────────────────────────────
  const agents = new Map<
    string,
    { role: string; alignment: AttributionAlignment; confidence: number | null; version: string }
  >();

  // Bei REGEL-Trades ist die Regel die EINZIGE Entscheidungsquelle — Stimmen
  // werden nicht ausgewertet (buildRuleSnapshot legt ohnehin keine an; diese
  // Guard verhindert Doppel-Allokation, falls ein künftiger Writer doch
  // Stimmen in einen Regel-Snapshot schreibt).
  if (!parsed.ruleKey) {
    // Stimmen: letzte je Agent gewinnt (chronologisch nach `at`, stabil).
    const votes = [...parsed.votes]
      .map((v, index) => ({ v, index }))
      .sort((a, b) => (a.v.at ?? "").localeCompare(b.v.at ?? "") || a.index - b.index)
      .map(({ v }) => v);
    for (const vote of votes) {
      const alignment = voteAlignment(vote, { symbol: input.symbol, side: input.side });
      agents.set(vote.name, {
        role: vote.role,
        alignment,
        confidence: vote.confidence,
        version: parsed.agentVersions[vote.name] ?? "unknown",
      });
    }

    // Proposer: über die proposalId fest gebunden — schlägt die Turn-Auswertung.
    if (parsed.proposerName) {
      const existing = agents.get(parsed.proposerName);
      agents.set(parsed.proposerName, {
        role: existing?.role ?? parsed.proposerRole,
        alignment: 1,
        confidence: existing?.confidence ?? null,
        version: parsed.agentVersions[parsed.proposerName] ?? parsed.proposerVersion,
      });
    }
  }

  // Regel: einzige Entscheidungsquelle von Regel-Trades (keine erfundenen Stimmen).
  if (parsed.ruleKey) {
    entries.push({
      sourceType: "RULE",
      sourceId: parsed.ruleKey,
      sourceVersion: parsed.ruleVersion,
      role: null,
      alignment: 1,
      weight: 1,
      contribution: 0, // wird unten befüllt
    });
  }

  // Teilnehmer-Masse (Alignment ≠ 0). W = 0 ⇒ keine allocierbare Masse.
  const participants = [...agents.entries()].filter(([, a]) => a.alignment !== 0);
  const weightSum = participants.reduce(
    (sum, [, a]) => sum + effectiveConfidence(a.confidence),
    0
  );
  const allocatable = input.grossPnl; // Quellen teilen immer das Brutto-PnL.

  let sourcesSum = 0;
  if (parsed.ruleKey) {
    const ruleEntry = entries.find((e) => e.sourceType === "RULE");
    if (ruleEntry) {
      ruleEntry.contribution = roundDecimals(allocatable);
      sourcesSum += ruleEntry.contribution;
    }
  }
  if (participants.length > 0) {
    for (const [name, a] of participants) {
      // weightSum = 0 (alle Konfidenzen 0): Richtung bleibt belegt, aber
      // keine allocierbare Masse — Beitrag 0, Rest geht ins Residual.
      const share = weightSum > 0 ? effectiveConfidence(a.confidence) / weightSum : 0;
      const contribution = roundDecimals(allocatable * a.alignment * share);
      entries.push({
        sourceType: "AGENT",
        sourceId: name,
        sourceVersion: a.version,
        role: a.role,
        alignment: a.alignment,
        weight: roundDecimals(share),
        contribution,
      });
      sourcesSum += contribution;
    }
  } else if (!parsed.ruleKey) {
    // Weder Regel noch teilnehmende Stimmen: Quelle fehlt → UNATTRIBUTABLE.
    const residual = roundDecimals(netPnl - costsSum);
    assertReconciliation(0, costsSum, residual, netPnl);
    return {
      methodVersion: input.methodVersion,
      methodTag: ATTRIBUTION_METHOD_TAG,
      declaration: ATTRIBUTION_DECLARATION,
      status: "UNATTRIBUTABLE",
      unattributableReason: "NO_SOURCES",
      snapshotHash: parsed.snapshotHash,
      snapshotSchemaVersion: parsed.schemaVersion,
      symbol: input.symbol,
      side: input.side,
      grossPnl: input.grossPnl,
      fees,
      funding,
      slippageMemo,
      netPnl,
      sourcesSum: 0,
      costsSum,
      residual,
      unknownCosts,
      participants: 0,
      abstentions: agents.size,
      entries,
    };
  }

  // Enthaltungen: sichtbare Zeilen mit Beitrag exakt 0.
  const abstentions = [...agents.entries()].filter(([, a]) => a.alignment === 0);
  for (const [name, a] of abstentions) {
    entries.push({
      sourceType: "AGENT",
      sourceId: name,
      sourceVersion: a.version,
      role: a.role,
      alignment: 0,
      weight: 0,
      contribution: 0,
    });
  }

  sourcesSum = roundDecimals(sourcesSum);
  const residual = roundDecimals(netPnl - sourcesSum - costsSum);
  assertReconciliation(sourcesSum, costsSum, residual, netPnl);

  // Kanonische Reihenfolge der Posten (Determinismus über Eingabereihenfolge
  // hinaus): Typ AGENT < RULE < COST, dann Quellen-ID, dann Rolle.
  entries.sort(
    (a, b) =>
      sourceTypeOrder(a.sourceType) - sourceTypeOrder(b.sourceType) ||
      a.sourceId.localeCompare(b.sourceId) ||
      (a.role ?? "").localeCompare(b.role ?? "")
  );

  return {
    methodVersion: input.methodVersion,
    methodTag: ATTRIBUTION_METHOD_TAG,
    declaration: ATTRIBUTION_DECLARATION,
    status: "ATTRIBUTED",
    unattributableReason: null,
    snapshotHash: parsed.snapshotHash,
    snapshotSchemaVersion: parsed.schemaVersion,
    symbol: input.symbol,
    side: input.side,
    grossPnl: input.grossPnl,
    fees,
    funding,
    slippageMemo,
    netPnl,
    sourcesSum,
    costsSum,
    residual,
    unknownCosts,
    participants: participants.length,
    abstentions: abstentions.length,
    entries,
  };
}

// ── Snapshot-Parsing ────────────────────────────────────────────────────────

type ParsedSnapshot =
  | {
      kind: "unattributable";
      reason: UnattributableReason;
      snapshotHash: string;
      schemaVersion: number;
    }
  | {
      kind: "ok";
      snapshotHash: string;
      schemaVersion: number;
      votes: VoteView[];
      proposerName: string | null;
      proposerRole: string;
      proposerVersion: string;
      ruleKey: string | null;
      ruleVersion: string;
      agentVersions: Record<string, string>;
    };

function parseSnapshot(snapshot: unknown): ParsedSnapshot {
  if (snapshot === null || snapshot === undefined) {
    return {
      kind: "unattributable",
      reason: "SNAPSHOT_MISSING",
      snapshotHash: fingerprint("js", null),
      schemaVersion: 0,
    };
  }
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return {
      kind: "unattributable",
      reason: "SNAPSHOT_INVALID",
      snapshotHash: fingerprint("js", snapshot),
      schemaVersion: 0,
    };
  }
  const view = snapshot as SnapshotView;
  const schemaVersion = isFiniteNumber(view.schemaVersion) ? view.schemaVersion : 0;
  const snapshotHash = fingerprint("js", snapshot);
  if (schemaVersion < 2) {
    // v1-Snapshots tragen keine Richtungsdaten der Stimmen und keine
    // Versionskette — raten ist unzulässig (fail-closed, sichtbarer Grund).
    return {
      kind: "unattributable",
      reason: schemaVersion === 1 ? "SNAPSHOT_SCHEMA_V1" : "SNAPSHOT_INVALID",
      snapshotHash,
      schemaVersion,
    };
  }
  const rawVotes = Array.isArray(view.votes) ? view.votes : [];
  const votes: VoteView[] = [];
  for (const v of rawVotes) {
    if (v === null || typeof v !== "object") continue;
    const vote = v as Record<string, unknown>;
    const name = typeof vote.name === "string" && vote.name !== "" ? vote.name : "UNKNOWN";
    votes.push({
      name,
      role: typeof vote.role === "string" && vote.role !== "" ? vote.role : "UNKNOWN",
      vote: typeof vote.vote === "string" ? vote.vote : "",
      confidence: isFiniteNumber(vote.confidence) ? vote.confidence : null,
      at: typeof vote.at === "string" ? vote.at : "",
      symbol: typeof vote.symbol === "string" ? vote.symbol : null,
      side: vote.side === "LONG" || vote.side === "SHORT" ? vote.side : null,
    });
  }
  const versions = (view.versions ?? {}) as Record<string, unknown>;
  const rawAgentVersions = (versions.agentVersions ?? {}) as Record<string, unknown>;
  const agentVersions: Record<string, string> = {};
  for (const [name, version] of Object.entries(rawAgentVersions)) {
    if (isFiniteNumber(version)) agentVersions[name] = String(Math.trunc(version));
  }
  const proposerName =
    view.proposer &&
    typeof view.proposer === "object" &&
    typeof view.proposer.name === "string" &&
    view.proposer.name !== ""
      ? view.proposer.name
      : null;
  const proposerRole =
    view.proposer && typeof view.proposer.role === "string" && view.proposer.role !== ""
      ? view.proposer.role
      : "UNKNOWN";
  const attributionKind = typeof view.attribution === "string" ? view.attribution : "";
  const promptVersion = isFiniteNumber(versions.promptVersion) ? String(Math.trunc(versions.promptVersion)) : "unknown";
  const ruleKey = typeof versions.ruleKey === "string" && versions.ruleKey !== "" ? versions.ruleKey : null;
  const ruleVersion = isFiniteNumber(versions.ruleVersion) ? String(Math.trunc(versions.ruleVersion)) : "unknown";
  return {
    kind: "ok",
    snapshotHash,
    schemaVersion,
    votes,
    proposerName: attributionKind === "PROPOSAL" ? proposerName : null,
    proposerRole,
    proposerVersion: promptVersion,
    ruleKey: attributionKind === "RULE" ? ruleKey : null,
    ruleVersion,
    agentVersions,
  };
}

function assertReconciliation(
  sourcesSum: number,
  costsSum: number,
  residual: number,
  netPnl: number
): void {
  const delta = Math.abs(sourcesSum + costsSum + residual - netPnl);
  if (delta > ATTRIBUTION_RECONCILIATION_TOLERANCE) {
    throw new AttributionError(
      "reconciliation-failed",
      `Attribution reconciliert nicht: |Quellen ${sourcesSum} + Kosten ${costsSum} + Residual ${residual} − Netto ${netPnl}| = ${delta} > Toleranz ${ATTRIBUTION_RECONCILIATION_TOLERANCE}.`
    );
  }
}

function sourceTypeOrder(type: AttributionEntry["sourceType"]): number {
  return type === "AGENT" ? 0 : type === "RULE" ? 1 : 2;
}

// ── Backtest-Adapter ────────────────────────────────────────────────────────

/** Schmale Sicht auf einen Backtest-Trade (src/backtest/types.ts). */
export interface BacktestTradeLike {
  strategyId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  pnl: number;
  fees: number;
  /** Kontosicht: negativ = gezahlt; undefined = nicht ausgewiesen. */
  funding?: number;
  slippage: number;
}

/**
 * Attribution eines Backtest-Trades: Die Strategie/Regel des simulierten Trades
 * ist die EINZIGE Entscheidungsquelle (vollständige Alignment-Belege durch den
 * deterministischen Simulator) — semantisch dieselbe Methode wie im
 * Paper-/Live-Pfad: Quellen teilen das Brutto-PnL, Kosten werden separat
 * ausgewiesen, Netto = Brutto − Gebühren + Funding, Residual schließt exakt.
 *
 * Wichtig (RMA-P1-04): Der BacktestTradeLog wird dafür NICHT mutiert und nicht
 * erweitert — der Ledger-Hash bleibt eingefroren. Diese Funktion liefert das
 * Attributionsergebnis als Wert zurück.
 */
export function attributeBacktestTrade(
  trade: BacktestTradeLike,
  options: { methodVersion?: number } = {}
): TradeAttribution {
  return computeTradeAttribution({
    methodVersion: options.methodVersion ?? 1,
    symbol: trade.symbol,
    side: trade.side,
    grossPnl: trade.pnl,
    fees: Number.isFinite(trade.fees) ? trade.fees : null,
    funding: trade.funding !== undefined && Number.isFinite(trade.funding) ? trade.funding : null,
    slippage: Number.isFinite(trade.slippage) ? trade.slippage : null,
    snapshot: {
      schemaVersion: 2,
      attribution: "RULE",
      proposalId: null,
      ruleId: null,
      votes: [],
      proposer: null,
      regime: "BACKTEST",
      rationaleHash: "backtest-strategy",
      source: "BACKTEST",
      versions: {
        promptVersion: null,
        agentVersions: {},
        ruleVersion: null,
        ruleKey: trade.strategyId,
        policyVersion: null,
        dataFingerprint: null,
      },
      snapshotHash: "",
    },
  });
}
