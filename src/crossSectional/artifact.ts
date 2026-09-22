/**
 * Artefakte des Cross-Sectional-Momentum-Rankings (RMA-P2-04) — die
 * DATEIBASIERTEN Persistenzform (parallel zur DB, gleiche Daten).
 *
 * ```text
 * artifacts/cross-sectional/YYYY-MM-DD/<snapshotId>.json
 * ```
 *
 * Eigenschaften (Konvention wie `src/scanner/artifacts.ts`):
 *   - **Deterministisch:** feste Feldreihenfolge (manuelle Serialisierung,
 *     keine Key-Reihenfolge von Map/Object), gerundete Zahlen ⇒ gleicher
 *     Input ⇒ byte-identische Datei (Golden-Test-Pflicht).
 *   - **Atomar:** `tmp` + `rename` (keine halben Dateien nach Absturz).
 *   - **Pfadsicher:** Datum `YYYY-MM-DD`, Snapshot-ID `xs1:<hex>` — beides
 *     wird gegen Traversal validiert.
 *
 * Das Artefakt ist zugleich das **Cross-Prozess-Medium der
 * Scanner-Integration**: das CLI-Skript (`npm run research:cross-sectional`)
 * berechnet + persistiert (DB) + schreibt das Artefakt; der Scanner-Service
 * (längerlebender Web-Prozess, sync Kontext) liest das jüngste Artefakt —
 * derselbe Muster wie das Perp-Derivate-Artefakt
 * (`data/perpdata/derivatives.json`).
 *
 * Artefakte sind generierte Daten und gehören NICHT in Git (`.gitignore`:
 * `/artifacts`); sie sind aus Registry + Historical Store + Config
 * reproduzierbar.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "../lib/appPaths";
import { OUTPUT_DECIMALS, roundTo } from "./math";
import {
  type CrossSectionalSnapshot,
  type CrossSectionalRankContext,
  type UniverseMember,
} from "./types";

/** Standard-Verzeichnis (relativ zum Projektstamm). */
export const CROSS_SECTIONAL_ARTIFACTS_DIR = "artifacts/cross-sectional";
/** Erlaubtes Datumsformat eines Artefakt-Ordners. */
const ARTIFACT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Snapshot-ID-Format (Traversal-Schutz). */
const SNAPSHOT_ID_RE = /^xs1:[0-9a-f]{64}$/;

/** Schema-Version der Artefakt-Dateiform. */
export const CROSS_SECTIONAL_ARTIFACT_SCHEMA_VERSION = 1;

/** Deterministische Zahlen-Serialisierung (fixe 10-Stellen, keine 1e-Notation). */
function num(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "null";
  const r = roundTo(value, OUTPUT_DECIMALS);
  return String(r);
}

/** Serialisiert EINEN Member (feste Feldreihenfolge). */
function serializeMember(m: UniverseMember, horizonIds: readonly string[]): string {
  const rawReturns = horizonIds
    .map((h) => {
      const hr = m.rawReturns[h];
      const val = hr
        ? `{total:${num(hr.total)},volAdjusted:${num(hr.volAdjusted)},barsUsed:${hr.barsUsed},available:${hr.available},reason:${hr.reason === null ? "null" : JSON.stringify(hr.reason)}}`
        : "null";
      return `${JSON.stringify(h)}:${val}`;
    })
    .join(",");
  const winsorized = horizonIds.map((h) => `${JSON.stringify(h)}:${num(m.winsorized[h] ?? null)}`).join(",");
  const zScores = horizonIds.map((h) => `${JSON.stringify(h)}:${num(m.zScores[h] ?? null)}`).join(",");
  return (
    `{instrumentId:${JSON.stringify(m.instrumentId)},status:${JSON.stringify(m.status)},` +
    `rank:${num(m.rank)},percentile:${num(m.percentile)},composite:${num(m.composite)},` +
    `rawReturns:{${rawReturns}},winsorized:{${winsorized}},zScores:{${zScores}},` +
    `horizonCoverage:${num(m.horizonCoverage)},lastBarTs:${num(m.lastBarTs)},` +
    `lastAvailableAt:${num(m.lastAvailableAt)},barsUsed:${m.barsUsed},` +
    `exclusionReason:${m.exclusionReason === null ? "null" : JSON.stringify(m.exclusionReason)}}`
  );
}

/**
 * Deterministische Serialisierung des gesamten Snapshots (feste
 * Feldreihenfolge; byte-identisch bei gleichem Input — Golden-Test).
 */
export function serializeCrossSectionalSnapshot(snapshot: CrossSectionalSnapshot): string {
  const horizonIds = snapshot.config.horizons.map((h) => h.id);
  const members = snapshot.members
    .map((m) => serializeMember(m, horizonIds))
    .join(",");
  const stability =
    snapshot.stability === null
      ? "null"
      : `{prevSnapshotId:${JSON.stringify(snapshot.stability.prevSnapshotId)},topK:${snapshot.stability.topK},topKOverlap:${num(snapshot.stability.topKOverlap)},rankShiftMean:${num(snapshot.stability.rankShiftMean)},commonCount:${snapshot.stability.commonCount}}`;
  const exclusionCounts = Object.entries(snapshot.exclusionCounts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${v}`)
    .join(",");
  return (
    `{schemaVersion:${snapshot.schemaVersion},artifactSchema:${CROSS_SECTIONAL_ARTIFACT_SCHEMA_VERSION},` +
    `asOf:${snapshot.asOf},computedAt:${snapshot.computedAt},` +
    `timeframe:${JSON.stringify(snapshot.timeframe)},availabilityPolicy:${JSON.stringify(snapshot.availabilityPolicy)},` +
    `provenance:{snapshotId:${JSON.stringify(snapshot.provenance.snapshotId)},universeHash:${JSON.stringify(snapshot.provenance.universeHash)},dataHash:${JSON.stringify(snapshot.provenance.dataHash)},configHash:${JSON.stringify(snapshot.provenance.configHash)},codeVersion:${JSON.stringify(snapshot.provenance.codeVersion)},configVersion:${snapshot.config.version}},` +
    `universeSize:${snapshot.universeSize},rankedCount:${snapshot.rankedCount},excludedCount:${snapshot.excludedCount},` +
    `coverage:${num(snapshot.coverage)},exclusionCounts:{${exclusionCounts}},` +
    `stability:${stability},survivorshipNote:${JSON.stringify(snapshot.survivorshipNote)},` +
    `config:${JSON.stringify(snapshot.config)},` +
    `members:[${members}]}`
  );
}

/** Parst ein Artefakt-JSON (validiert die Form; wirft bei Kaputtigkeit). */
export function parseCrossSectionalArtifact(raw: string): CrossSectionalSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`cross-sectional Artefakt ist kein gültiges JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const s = parsed as CrossSectionalSnapshot & { provenance?: { snapshotId?: unknown } };
  if (
    typeof s !== "object" ||
    s === null ||
    typeof s.provenance?.snapshotId !== "string" ||
    !Array.isArray(s.members) ||
    typeof s.asOf !== "number" ||
    typeof s.config !== "object" ||
    !Array.isArray(s.config.horizons)
  ) {
    throw new Error("cross-sectional Artefakt erfüllt nicht die erwartete Form");
  }
  if (!SNAPSHOT_ID_RE.test(s.provenance.snapshotId)) {
    throw new Error(
      `cross-sectional Artefakt: ungültige snapshotId-Form "${String(s.provenance.snapshotId).slice(0, 32)}"`,
    );
  }
  return s;
}

/** Pfad eines Artefakts (Datum + Snapshot-ID, beides validiert). */
export function artifactPath(snapshotId: string, asOfMs: number, dir = CROSS_SECTIONAL_ARTIFACTS_DIR): string {
  if (!SNAPSHOT_ID_RE.test(snapshotId)) {
    throw new Error(`artifactPath: ungültige snapshotId "${String(snapshotId).slice(0, 32)}"`);
  }
  const date = new Date(asOfMs).toISOString().slice(0, 10);
  if (!ARTIFACT_DATE_RE.test(date)) {
    throw new Error(`artifactPath: ungültiges Datum "${date}"`);
  }
  return path.join(resolveRuntimePath(dir), date, `${snapshotId}.json`);
}

/**
 * Schreibt das Artefakt atomar (tmp + rename, Mode 0600). Die Datei ist
 * deterministisch — ein zweiter Lauf mit gleichem Input ergibt byte-gleiche
 * Inhalte (Idempotenz der Dateiebene).
 */
export function writeCrossSectionalArtifact(snapshot: CrossSectionalSnapshot, dir = CROSS_SECTIONAL_ARTIFACTS_DIR): string {
  const out = artifactPath(snapshot.provenance.snapshotId, snapshot.asOf, dir);
  mkdirSync(path.dirname(out), { recursive: true });
  const body = serializeCrossSectionalSnapshot(snapshot) + "\n";
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, out);
  return out;
}

/** Alle Artefakt-Dateien (flach über Datumsordner), `null` ohne Verzeichnis. */
export function listCrossSectionalArtifacts(dir = CROSS_SECTIONAL_ARTIFACTS_DIR): string[] {
  const base = resolveRuntimePath(dir);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(base)) {
    const dateDir = path.join(base, entry);
    if (!statSync(dateDir).isDirectory() || !ARTIFACT_DATE_RE.test(entry)) continue;
    for (const file of readdirSync(dateDir)) {
      if (/^xs1:[0-9a-f]{64}\.json$/.test(file)) out.push(path.join(dateDir, file));
    }
  }
  return out;
}

/**
 * Lädt das JÜNGSTE Artefakt (nach `asOf` in der Datei, dann nach Name) und
 * prüft die Staleness-Grenze:
 *   - `null` ohne Artefakt,
 *   - `null` wenn `maxAgeMs > 0` und `nowMs − asOf > maxAgeMs` (Stale ⇒
 *     fail-closed: der Konsument behandelt den Rang als unavailable).
 */
export function loadLatestCrossSectionalArtifact(opts: {
  nowMs?: number;
  maxAgeMs?: number;
  dir?: string;
}): CrossSectionalSnapshot | null {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? 0;
  const files = listCrossSectionalArtifacts(opts.dir);
  if (files.length === 0) return null;
  let best: CrossSectionalSnapshot | null = null;
  let bestAsOf = -1;
  let bestPath = "";
  for (const file of files) {
    let s: CrossSectionalSnapshot;
    try {
      s = parseCrossSectionalArtifact(readFileSync(file, "utf8"));
    } catch {
      continue; // kaputtes Artefakt überspringen (nächste Quelle/CLI-Lauf repariert)
    }
    if (s.asOf > bestAsOf || (s.asOf === bestAsOf && file > bestPath)) {
      best = s;
      bestAsOf = s.asOf;
      bestPath = file;
    }
  }
  if (best === null) return null;
  if (maxAgeMs > 0 && nowMs - best.asOf > maxAgeMs) return null;
  return best;
}

/** Baut den Scanner-Faktor-Kontext aus einem geladenen Snapshot (oder null). */
export function rankContextOf(
  snapshot: CrossSectionalSnapshot,
  instrumentId: string,
): CrossSectionalRankContext | null {
  const member = snapshot.members.find((m) => m.instrumentId === instrumentId);
  if (!member || member.status !== "RANKED" || member.rank === null) return null;
  return {
    instrumentId,
    snapshotId: snapshot.provenance.snapshotId,
    asOf: snapshot.asOf,
    rank: member.rank,
    percentile: member.percentile as number,
    composite: member.composite as number,
  };
}
