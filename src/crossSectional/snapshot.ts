/**
 * Snapshot-Orchestrierung (RMA-P2-04) — die reine End-to-End-Funktion:
 * Kandidaten + cutoff-sichtbare Kerzen + Config ⇒ {@link CrossSectionalSnapshot}
 * mit vollständiger Provenance.
 *
 * **Determinismus-Vertrag:** gleiche Eingabe (Kandidaten, Kerzen, asOf,
 * Config, codeVersion) ⇒ byte-identisches Snapshot (inkl. `snapshotId`),
 * unabhängig von der Eingabe-Reihenfolge der Instrumente und Kerzen.
 * `computedAt` ist bewusst KEIN Teil der Snapshot-Identität (späte
 * Neuberechnung desselben As-of erzeugt kein neues Wissen — dieselbe
 * Regel wie Feature Store/Regime-Snapshots); ein Retry desselben Laufs
 * ist damit ein sichtbarer No-Op (Idempotenz).
 *
 * Die Berechnung ist reine CPU-Work — Persistenz (DB) und Artefakt (Datei)
 * liegen in getrennten, SERVER-seitigen Modulen (`./store.ts`, `./artifact.ts`).
 */

import type {
  CrossSectionalConfig,
  CrossSectionalInput,
  CrossSectionalSnapshot,
  ExclusionReason,
  HorizonReturn,
  UniverseMember,
} from "./types";
import { EXCLUSION_REASONS } from "./types";
import {
  CROSS_SECTIONAL_CODE_VERSION,
  CROSS_SECTIONAL_SCHEMA_VERSION,
  hashCrossSectionalConfig,
} from "./config";
import { SUPPORTED_TIMEFRAME_MS } from "../lib/marketdata/historicalStore";
import { assertCutoffContext, horizonReturn, maxWindowMs, pitVisibleCandles } from "./momentum";
import { selectUniverse } from "./universe";
import { applyRanking, transformCrossSection, type RankableRow } from "./rank";
import { byInstrumentId, canonicalSort, isFiniteNumber, roundTo, sha256Hex } from "./math";

/**
 * Berechnete, aber noch nicht persistierte Snapshot-Basis (ohne Stability,
 * die erst im Persistenzpfad gegen den Vorgänger gemessen wird).
 */
export type CrossSectionalSnapshotDraft = Omit<CrossSectionalSnapshot, "stability"> & {
  stability: null;
};

/** Sichtbare Kerzen + Verwendungs-Metadaten EINES Instruments (für Hash/Rang). */
interface InstrumentSeries {
  visible: { ts: number; close: number; fetchedAtMs: number }[];
  /** Anzahl unbrauchbarer Kerzen, die am Cutoff HÄTTEN bekannt sein müssen (0 = sauber). */
  invalidAtCutoff: number;
}

/**
 * Lädt die cutoff-sichtbaren Reihen für alle Kandidaten (einmalig, ID-sorted)
 * — die EINTRITTSTELLE der Look-ahead-Garantie des Snapshots.
 */
function loadSeries(
  input: CrossSectionalInput,
  tfMs: number,
  policy: CrossSectionalConfig["availabilityPolicy"],
): Map<string, InstrumentSeries> {
  const ctx = { asOf: input.asOf, tfMs, policy };
  assertCutoffContext(ctx);
  const out = new Map<string, InstrumentSeries>();
  for (const cand of canonicalSort(input.instruments, (c) => c.id)) {
    const raw = input.candles.get(cand.id) ?? [];
    const { visible, invalidAtCutoff } = pitVisibleCandles(raw, ctx);
    out.set(cand.id, { visible, invalidAtCutoff });
  }
  return out;
}

/**
 * `xu1:<sha256>` über die kandiierende Instrumentenpopulation (ID-sorted).
 * Jede Änderung der Population (Hinzunahme/Entfernen/Status/Volumen)
 * verändert den Hash.
 */
export function universeHashOf(
  candidates: readonly { id: string; status: string; assetClass: string; volume24h: number | null }[],
): string {
  const lines = canonicalSort(candidates, (c) => c.id).map((c) =>
    [c.id, c.status, c.assetClass, c.volume24h === null ? "-" : String(roundTo(c.volume24h))].join("|"),
  );
  return `xu1:${sha256Hex(lines.join("\n"))}`;
}

/**
 * `xd1:<sha256>` über die **tatsächlich konsumierten** Kerzen (die
 * cutoff-sichtbaren Reihen im Max-Fenster, ID-sorted; Closes mit fixer
 * 10-Stellen-Notation). Ändert sich nur, wenn der cutoffierte Datenstand
 * sich ändert — eine später ingestierte Kerze (fetchedAt > asOf) ändert den
 * Hash NICHT (Policy `ingested`).
 */
function dataHashOf(series: Map<string, InstrumentSeries>, maxWindowFrom: number): string {
  const lines: string[] = [];
  for (const [id, s] of [...series.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const inWindow = s.visible.filter((c) => c.ts >= maxWindowFrom);
    if (inWindow.length === 0) {
      lines.push(`${id}:0`);
      continue;
    }
    const closes = inWindow.map((c) => String(roundTo(c.close)));
    lines.push(
      `${id}:${inWindow.length}:${inWindow[0].ts}:${inWindow[inWindow.length - 1].ts}:${inWindow[inWindow.length - 1].fetchedAtMs}:${closes.join(",")}`,
    );
  }
  return `xd1:${sha256Hex(lines.join("\n"))}`;
}

/** Deterministische Snapshot-ID `xs1:<sha256>` über die fachliche Identität. */
export function snapshotIdOf(parts: {
  schemaVersion: number;
  timeframe: string;
  asOf: number;
  universeHash: string;
  dataHash: string;
  configHash: string;
  codeVersion: string;
}): { snapshotId: string; idempotencyKey: string } {
  const hex = sha256Hex(
    [
      `v${parts.schemaVersion}`,
      parts.timeframe,
      parts.asOf,
      parts.universeHash,
      parts.dataHash,
      parts.configHash,
      parts.codeVersion,
    ].join("|"),
  );
  return { snapshotId: `xs1:${hex}`, idempotencyKey: hex };
}

/** Stabilitäts-Vorgänger-Kontext (bereinigt auf gerankte Mitglieder). */
export interface StabilityPrev {
  snapshotId: string;
  /** Rang je Instrument (nur gerankte). */
  ranks: ReadonlyMap<string, number>;
}

/**
 * Reine Stabilitäts-/Turnover-Messung gegen den vorherigen Snapshot
 * (gleicher Timeframe; beliebige Universe-Zusammensetzung — der Vergleich
 * läuft über die gemeinsamen Instrumente). Gebounded: nur Zähler/Quotienten.
 */
export function computeStability(
  current: ReadonlyMap<string, number>,
  prev: StabilityPrev | null,
  topK: number,
): CrossSectionalSnapshot["stability"] {
  if (!prev) return null;
  const curTop = [...current.entries()]
    .filter(([, r]) => r <= topK)
    .map(([id]) => id)
    .sort();
  const prevTop = [...prev.ranks.entries()]
    .filter(([, r]) => r <= topK)
    .map(([id]) => id)
    .sort();
  const curSet = new Set(curTop);
  const prevSet = new Set(prevTop);
  const inter = curTop.filter((id) => prevSet.has(id)).length;
  const union = new Set([...curTop, ...prevTop]).size;
  const topKOverlap = union > 0 ? inter / union : null;

  let shiftSum = 0;
  let common = 0;
  for (const [id, r] of current) {
    const pr = prev.ranks.get(id);
    if (pr !== undefined) {
      shiftSum += Math.abs(r - pr);
      common += 1;
    }
  }
  return {
    prevSnapshotId: prev.snapshotId,
    topK,
    topKOverlap: topKOverlap === null ? null : roundTo(topKOverlap),
    rankShiftMean: common > 0 ? roundTo(shiftSum / common) : null,
    commonCount: common,
  };
}

/**
 * Baut den Snapshot (Formeln siehe Teilmodule). Wirft bei unsinnigen
 * Eingaben (asOf/timeframe) — ein Snapshot mit ungültigem Cutoff existiert
 * nicht (fail-loud).
 */
export function buildCrossSectionalSnapshot(input: CrossSectionalInput): CrossSectionalSnapshot {
  const { config } = input;
  const tfMs = SUPPORTED_TIMEFRAME_MS[config.timeframe];
  const ctx = { asOf: input.asOf, tfMs, policy: config.availabilityPolicy };
  assertCutoffContext(ctx);
  const codeVersion = input.codeVersion ?? CROSS_SECTIONAL_CODE_VERSION;

  // 1) Sichtbare Reihen (Look-ahead-Guard) — ID-sorted.
  const series = loadSeries(input, tfMs, config.availabilityPolicy);
  const maxWindow = maxWindowMs(config, tfMs);
  const maxWindowFrom = input.asOf - maxWindow;

  // 2) Provenance-Hashes (Population + konsumierte Daten + Config).
  const universeHash = universeHashOf(input.instruments);
  const dataHash = dataHashOf(series, maxWindowFrom);
  const configHash = hashCrossSectionalConfig(config);

  // 3) Eligibility (Membership + Exclusion Reasons).
  const selection = selectUniverse(input.instruments, input.candles, ctx, maxWindow, config);

  // 4) Momentum je Mitglied (nur Eligible; Horizons nach Config).
  const rankable: RankableRow[] = [];
  const memberBase = new Map<string, UniverseMember>();
  for (const verdict of selection.verdicts) {
    const s = series.get(verdict.instrumentId);
    const inWindow = s ? s.visible.filter((c) => c.ts >= maxWindowFrom) : [];
    const last = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null;
    const base: UniverseMember = {
      instrumentId: verdict.instrumentId,
      status: "EXCLUDED",
      rank: null,
      percentile: null,
      composite: null,
      rawReturns: {},
      winsorized: {},
      zScores: {},
      horizonCoverage: 0,
      lastBarTs: last ? last.ts + tfMs : null,
      lastAvailableAt: last ? last.fetchedAtMs : null,
      barsUsed: inWindow.length,
      exclusionReason: verdict.reason,
    };
    memberBase.set(verdict.instrumentId, base);
    if (!verdict.eligible) continue;

    const raw: Record<string, HorizonReturn | null> = {};
    let availableCount = 0;
    for (const h of config.horizons) {
      const hr = horizonReturn(s!.visible, h, ctx, config.minVolReturns);
      raw[h.id] = hr;
      if (hr.available) availableCount += 1;
    }
    base.rawReturns = raw;
    base.horizonCoverage = config.horizons.length > 0 ? availableCount / config.horizons.length : 0;
    rankable.push({
      instrumentId: verdict.instrumentId,
      raw: Object.fromEntries(config.horizons.map((h) => {
        const hr = raw[h.id];
        const v = hr && hr.available && config.valueMode === "total" ? hr.total : hr && hr.available ? hr.volAdjusted : null;
        return [h.id, v !== null && isFiniteNumber(v) ? v : null];
      })),
    });
  }

  // 5) Querschnitt (Winsorize → z → Composite → Rang/Perzentil).
  const crossResult = transformCrossSection(rankable, config);
  const rankedMemberBase = selection.memberIds.map((id) => memberBase.get(id)!);
  const members = applyRanking(rankedMemberBase, crossResult, config.horizons.map((h) => h.id));
  // Nicht-Eligible Mitglieder anhängen (ID-sorted Gesamtmenge).
  const excludedMembers = selection.verdicts
    .filter((v) => !v.eligible)
    .map((v) => memberBase.get(v.instrumentId)!);
  const allMembers = byInstrumentId([...members, ...excludedMembers]);

  // 6) Kennzahlen (bounded, deterministisch).
  const rankedCount = allMembers.filter((m) => m.status === "RANKED").length;
  const excludedCount = allMembers.length - rankedCount;
  const universeSize = allMembers.length;
  const exclusionCounts = {} as Record<ExclusionReason, number>;
  for (const r of EXCLUSION_REASONS) exclusionCounts[r] = 0;
  for (const m of allMembers) {
    if (m.status === "EXCLUDED" && m.exclusionReason) {
      exclusionCounts[m.exclusionReason] += 1;
    }
  }
  const coverage = universeSize > 0 ? rankedCount / universeSize : 1;

  // 7) Snapshot-ID (deterministisch; computedAt ist KEIN Teil der Identität).
  const { snapshotId } = snapshotIdOf({
    schemaVersion: CROSS_SECTIONAL_SCHEMA_VERSION,
    timeframe: config.timeframe,
    asOf: input.asOf,
    universeHash,
    dataHash,
    configHash,
    codeVersion,
  });

  return {
    schemaVersion: CROSS_SECTIONAL_SCHEMA_VERSION,
    asOf: input.asOf,
    computedAt: input.computedAt,
    timeframe: config.timeframe,
    availabilityPolicy: config.availabilityPolicy,
    config,
    provenance: {
      snapshotId,
      universeHash,
      dataHash,
      configHash,
      codeVersion,
    },
    universeSize,
    rankedCount,
    excludedCount,
    coverage: roundTo(coverage),
    exclusionCounts,
    members: allMembers,
    stability: null,
    survivorshipNote:
      "Membership aus der Registry zum Laufzeitpunkt: Point-in-Time-Membership " +
      "historischer Delistings ist aus den lokalen Daten NICHT rekonstruierbar. " +
      "Dieses Artefakt ist deshalb als survivorship-behaftet zu lesen (keine " +
      "Lücke, die dieses Artefakt behaupten zu schließen vermag).",
  };
}

/**
 * Wendet die Persistenz-Stabilität auf einen fertigen Draft an (reine
 * Kopie, keine Mutation) — der Persistenzpfad misst gegen den Vorgänger.
 */
export function withStability(
  draft: CrossSectionalSnapshot,
  stability: CrossSectionalSnapshot["stability"],
): CrossSectionalSnapshot {
  return { ...draft, stability };
}

/** Rang-Karte (Instrument → Rang) für Stabilitäts-/Konsumenten-Zwecke. */
export function rankMapOf(snapshot: CrossSectionalSnapshot): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  for (const member of snapshot.members) {
    if (member.status === "RANKED" && member.rank !== null) m.set(member.instrumentId, member.rank);
  }
  return m;
}
