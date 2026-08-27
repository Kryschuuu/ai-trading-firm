/**
 * Artefakte des Scanners (Task 04).
 *
 * Jeder Scan kann als **versionierter Tages-Snapshot** abgelegt werden:
 *
 * ```text
 * artifacts/YYYY-MM-DD/universe.json   Trichter-Ebenen + Score-Breakdowns
 * artifacts/YYYY-MM-DD/weekly.json     Weekly-Klassifikation (falls erzeugt)
 * ```
 *
 * Eigenschaften:
 *   - **Deterministisch:** feste Feldreihenfolge, gerundete Zahlen, keine
 *     Laufzeitmessungen im Artefakt ⇒ gleicher Input ⇒ byte-identische Datei.
 *   - **Atomar:** `tmp` + `rename`, damit ein Absturz keine halbe Datei hinterlässt.
 *   - **Pfadsicher:** das Datum muss `YYYY-MM-DD` sein (kein Path-Traversal).
 *
 * Artefakte sind generierte Daten und gehören nicht in Git (siehe
 * `.gitignore`), aber sie sind reproduzierbar aus Registry + Historie.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ScannerConfig, ScoreWeights } from "./config";
import type { ScanResult } from "./pipeline";
import type { InstrumentScore, ScoreBreakdownEntry } from "./types";
import { validateWeeklyReview, type WeeklyReview } from "./weekly";

/** Standard-Verzeichnis der Artefakte (relativ zum Projektstamm). */
export const DEFAULT_ARTIFACTS_DIR = "artifacts";
/** Dateiname des Tages-Snapshots. */
export const DAILY_FILE = "universe.json";
/** Dateiname des Weekly-Reviews. */
export const WEEKLY_FILE = "weekly.json";
/** Erlaubtes Datumsformat eines Artefakt-Ordners. */
export const ARTIFACT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Schema-Version der Artefakte. */
export const ARTIFACT_SCHEMA_VERSION = 1;

/** Ein Eintrag der Daily-/Deep-Ebene inklusive Breakdown. */
export interface ArtifactScoreEntry {
  /** 1-basierte Rangposition innerhalb der Ebene. */
  rank: number;
  /** Kanonische Instrument-ID. */
  instrumentId: string;
  /** Anlageklasse. */
  assetClass: string;
  /** Market Score. */
  score: number;
  /** Volatilitäts-Regime. */
  regime: string;
  /** Beiträge je Score-Komponente (nur bei detaillierten Ebenen). */
  breakdown?: ScoreBreakdownEntry[];
}

/** Der Tages-Snapshot. */
export interface DailyUniverseArtifact {
  /** Schema-Version. */
  schemaVersion: number;
  /** Erzeuger (Modul + Task). */
  generator: string;
  /** Version der Scanner-Konfiguration. */
  configVersion: number;
  /** Auswertungszeitpunkt (ISO-8601-UTC). */
  asOf: string;
  /** Verwendete Score-Gewichte (Nachvollziehbarkeit alter Snapshots). */
  weights: ScoreWeights;
  /** Trichter-Kennzahlen. */
  funnel: {
    scanned: number;
    eligible: number;
    interesting: number;
    daily: number;
    deep: number;
    droppedByCap: { eligible: number; interesting: number; daily: number };
    diversificationRelaxed: boolean;
    deepPerAssetClass: Record<string, number>;
  };
  /** Ebenen: `deep`/`daily` mit Breakdown, `interesting` kompakt, `eligible` nur IDs. */
  levels: {
    deep: ArtifactScoreEntry[];
    daily: ArtifactScoreEntry[];
    interesting: ArtifactScoreEntry[];
    eligible: string[];
  };
  /** Ablehnungen der Eignungsfilter (Zähler je Regel). */
  rejections: { total: number; byRule: Record<string, number> };
}

function entry(score: InstrumentScore, rank: number, withBreakdown: boolean): ArtifactScoreEntry {
  const base: ArtifactScoreEntry = {
    rank,
    instrumentId: score.instrumentId,
    assetClass: score.assetClass,
    score: score.score,
    regime: score.regime,
  };
  if (withBreakdown) base.breakdown = score.breakdown;
  return base;
}

/** Baut den Tages-Snapshot aus einem Scan-Ergebnis (ohne Datei-IO). */
export function buildDailyArtifact(scan: ScanResult): DailyUniverseArtifact {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    generator: "scanner/task-04",
    configVersion: scan.config.version,
    asOf: scan.asOf,
    weights: { ...scan.config.weights },
    funnel: {
      scanned: scan.funnel.scanned,
      eligible: scan.funnel.eligible.length,
      interesting: scan.funnel.interesting.length,
      daily: scan.funnel.daily.length,
      deep: scan.funnel.deep.length,
      droppedByCap: { ...scan.funnel.droppedByCap },
      diversificationRelaxed: scan.funnel.diversificationRelaxed,
      deepPerAssetClass: { ...scan.funnel.deepPerAssetClass },
    },
    levels: {
      deep: scan.funnel.deep.map((s, i) => entry(s, i + 1, true)),
      daily: scan.funnel.daily.map((s, i) => entry(s, i + 1, true)),
      interesting: scan.funnel.interesting.map((s, i) => entry(s, i + 1, false)),
      eligible: scan.funnel.eligible.map((s) => s.instrumentId),
    },
    rejections: { total: scan.rejections.length, byRule: { ...scan.rejectionsByRule } },
  };
}

/** Löst das Artefakt-Verzeichnis auf (`SCANNER_ARTIFACTS_DIR` überschreibt den Default). */
export function resolveArtifactsDir(dir?: string): string {
  const raw = dir ?? process.env.SCANNER_ARTIFACTS_DIR ?? DEFAULT_ARTIFACTS_DIR;
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

/** Tagesordner `YYYY-MM-DD` aus einem ISO-Zeitstempel. */
export function artifactDateOf(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) throw new Error("artifactDateOf: ungültiger Zeitstempel");
  return new Date(ms).toISOString().slice(0, 10);
}

function assertDate(date: string): string {
  if (!ARTIFACT_DATE_RE.test(date)) throw new Error(`Artefakt-Datum ungültig: "${date.slice(0, 20)}"`);
  return date;
}

function writeJsonAtomic(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, target);
}

/** Schreibt `artifacts/YYYY-MM-DD/universe.json` und liefert Pfad + Artefakt. */
export function writeDailyArtifact(
  scan: ScanResult,
  options: { dir?: string; date?: string } = {}
): { path: string; artifact: DailyUniverseArtifact } {
  const artifact = buildDailyArtifact(scan);
  const date = assertDate(options.date ?? artifactDateOf(scan.asOf));
  const target = path.join(resolveArtifactsDir(options.dir), date, DAILY_FILE);
  writeJsonAtomic(target, artifact);
  return { path: target, artifact };
}

/** Schreibt `artifacts/YYYY-MM-DD/weekly.json` und liefert den Pfad. */
export function writeWeeklyArtifact(
  review: WeeklyReview,
  options: { dir?: string; date?: string } = {}
): { path: string; review: WeeklyReview } {
  const date = assertDate(options.date ?? artifactDateOf(review.asOf));
  const target = path.join(resolveArtifactsDir(options.dir), date, WEEKLY_FILE);
  writeJsonAtomic(target, review);
  return { path: target, review };
}

/** Alle vorhandenen Artefakt-Tage, aufsteigend sortiert. */
export function listArtifactDates(dir?: string): string[] {
  const root = resolveArtifactsDir(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ARTIFACT_DATE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** Liest einen Tages-Snapshot (`null`, wenn er nicht existiert). */
export function readDailyArtifact(date: string, dir?: string): DailyUniverseArtifact | null {
  const target = path.join(resolveArtifactsDir(dir), assertDate(date), DAILY_FILE);
  if (!existsSync(target)) return null;
  return JSON.parse(readFileSync(target, "utf8")) as DailyUniverseArtifact;
}

/** Liest einen Weekly-Review und validiert ihn (`null`, wenn er nicht existiert). */
export function readWeeklyArtifact(date: string, dir?: string): WeeklyReview | null {
  const target = path.join(resolveArtifactsDir(dir), assertDate(date), WEEKLY_FILE);
  if (!existsSync(target)) return null;
  return validateWeeklyReview(JSON.parse(readFileSync(target, "utf8")));
}

/** Jüngster Artefakt-Tag (`null`, wenn keiner existiert). */
export function latestArtifactDate(dir?: string): string | null {
  const dates = listArtifactDates(dir);
  return dates.length ? dates[dates.length - 1] : null;
}

/** Nur Doku/Tests: die Konfiguration, mit der ein Artefakt erzeugt wurde. */
export function artifactMatchesConfig(artifact: DailyUniverseArtifact, config: ScannerConfig): boolean {
  return artifact.configVersion === config.version;
}
