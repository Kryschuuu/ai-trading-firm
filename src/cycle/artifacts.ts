/**
 * Artefakt- und Speicherverwaltung für den Agenten-Zyklus (Task 06).
 *
 * Verwaltet versionierte und datierte Artefakte:
 *   - artifacts/YYYY-MM-DD/daily/*.json
 *   - artifacts/YYYY-Www/weekly/*.json
 *   - artifacts/index.json (Gesamt-Index / Manifest aller Läufe)
 *
 * Unterstützt:
 *   - Atomares Schreiben (.tmp + rename)
 *   - Konfigurierbare Retention (Aufbewahrungsfristen für Daily & Weekly)
 *   - Read-only Zugriffsfunktionen für APIs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath, resolveStoredPath } from "@/lib/appPaths";
import { formatDateYYYYMMDD, getIsoWeekString } from "./clock";
import type { CycleRunRecord } from "./types";
import type { WeeklyReview } from "@/scanner/weekly";

export const DEFAULT_CYCLE_ARTIFACTS_DIR = "artifacts";
export const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
export const WEEK_FOLDER_RE = /^\d{4}-W\d{2}$/;

export interface DailyRunIndexEntry {
  id: string;
  date: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  artifactsDir: string;
  summaryPath: string;
  candidatesCount?: number;
  setupsCount?: number;
  error?: string;
}

export interface WeeklyRunIndexEntry {
  id: string;
  week: string;
  date: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  artifactsDir: string;
  reviewPath: string;
  coreCount?: number;
  rotationCount?: number;
  discoveryCount?: number;
  excludedCount?: number;
  error?: string;
}

export interface ArtifactIndexManifest {
  schemaVersion: number;
  updatedAt: string;
  dailyRuns: DailyRunIndexEntry[];
  weeklyRuns: WeeklyRunIndexEntry[];
}

/**
 * Wurzelverzeichnis der Zyklus-Artefakte.
 *
 * `resolveRuntimePath()` (src/lib/appPaths.ts) ersetzt das frühere
 * `path.join(process.cwd(), dir)`: gleiche Semantik, plus Path-Traversal-Schutz
 * und ohne Turbopack-Projekt-Tracing.
 */
export function resolveArtifactsRoot(customDir?: string): string {
  const dir = customDir ?? process.env.CYCLE_ARTIFACTS_DIR ?? process.env.SCANNER_ARTIFACTS_DIR ?? DEFAULT_CYCLE_ARTIFACTS_DIR;
  return resolveRuntimePath(dir);
}

export function writeJsonAtomic(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  renameSync(tmpPath, targetPath);
}

export function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Liest den globalen Index (artifacts/index.json) oder initialisiert ihn.
 */
export function getArtifactIndex(rootDir?: string): ArtifactIndexManifest {
  const root = resolveArtifactsRoot(rootDir);
  const indexPath = path.join(root, "index.json");
  const existing = readJsonSafe<ArtifactIndexManifest>(indexPath);
  if (existing && existing.schemaVersion === 1) {
    return existing;
  }
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    dailyRuns: [],
    weeklyRuns: [],
  };
}

/**
 * Aktualisiert den globalen Index atomar.
 */
export function updateArtifactIndex(
  updater: (current: ArtifactIndexManifest) => void,
  rootDir?: string
): ArtifactIndexManifest {
  const root = resolveArtifactsRoot(rootDir);
  const current = getArtifactIndex(root);
  updater(current);
  current.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(root, "index.json"), current);
  return current;
}

/**
 * Speichert alle Artefakte eines täglichen Zykluslaufs.
 */
export function saveDailyCycleArtifacts(
  record: CycleRunRecord,
  stepOutputs: Record<string, unknown>,
  rootDir?: string
): { artifactsDir: string; filesWritten: string[] } {
  const root = resolveArtifactsRoot(rootDir);
  const dailyDir = path.join(root, record.date, "daily");
  const filesWritten: string[] = [];

  // 1. Jeden Step-Output als eigene Datei ablegen
  const stepFileMapping: Record<string, string> = {
    "01-market-scanner": "01-market-scanner.json",
    "02-macro-analyst": "02-macro-analyst.json",
    "03-market-selection": "03-market-selection.json",
    "04-technical-analyst": "04-technical-analyst.json",
    "05-news-analyst": "05-news-analyst.json",
    "06-risk-manager": "06-risk-manager.json",
    "07-research": "07-research.json",
    "08-backtest-verification": "08-backtest-verification.json",
  };

  for (const [stepId, fileName] of Object.entries(stepFileMapping)) {
    const output = stepOutputs[stepId];
    if (output !== undefined) {
      const filePath = path.join(dailyDir, fileName);
      writeJsonAtomic(filePath, output);
      filesWritten.push(filePath);
    }
  }

  // 2. Gesamt-Summary schreiben
  const summaryPath = path.join(dailyDir, "daily-summary.json");
  const summaryPayload = {
    schemaVersion: 1,
    cycleId: record.id,
    type: record.type,
    date: record.date,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    steps: record.steps,
    escalations: record.escalations,
    artifacts: filesWritten.map((f) => path.relative(root, f)),
    error: record.error,
  };
  writeJsonAtomic(summaryPath, summaryPayload);
  filesWritten.push(summaryPath);

  // 3. Im Index registrieren
  updateArtifactIndex((idx) => {
    const existingIndex = idx.dailyRuns.findIndex((r) => r.id === record.id);
    const sel = stepOutputs["03-market-selection"] as { selectedCount?: number } | undefined;
    const res = stepOutputs["07-research"] as { totalSetups?: number } | undefined;

    const entry: DailyRunIndexEntry = {
      id: record.id,
      date: record.date,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      artifactsDir: path.relative(process.cwd(), dailyDir),
      summaryPath: path.relative(process.cwd(), summaryPath),
      candidatesCount: sel?.selectedCount,
      setupsCount: res?.totalSetups,
      error: record.error?.message,
    };

    if (existingIndex >= 0) {
      idx.dailyRuns[existingIndex] = entry;
    } else {
      idx.dailyRuns.unshift(entry);
    }
  }, rootDir);

  return { artifactsDir: dailyDir, filesWritten };
}

/**
 * Speichert alle Artefakte eines wöchentlichen Universe-Review-Laufs.
 */
export function saveWeeklyCycleArtifacts(
  record: CycleRunRecord,
  reviewOutput: { review: WeeklyReview; synthesis?: unknown },
  rootDir?: string
): { artifactsDir: string; filesWritten: string[] } {
  const root = resolveArtifactsRoot(rootDir);
  const weekStr = record.week ?? getIsoWeekString(new Date(record.date));
  const weeklyDir = path.join(root, weekStr, "weekly");
  const filesWritten: string[] = [];

  // 1. review.json schreiben
  const reviewPath = path.join(weeklyDir, "weekly-review.json");
  writeJsonAtomic(reviewPath, reviewOutput.review);
  filesWritten.push(reviewPath);

  // 2. universe-classification.json (kompakte Liste mit Klassen und Begründungen)
  const classificationPath = path.join(weeklyDir, "universe-classification.json");
  const classificationPayload = {
    schemaVersion: 1,
    asOf: reviewOutput.review.asOf,
    summary: reviewOutput.review.summary,
    changes: reviewOutput.review.changes,
    entries: reviewOutput.review.entries,
    synthesis: reviewOutput.synthesis,
  };
  writeJsonAtomic(classificationPath, classificationPayload);
  filesWritten.push(classificationPath);

  // 3. weekly-summary.json
  const summaryPath = path.join(weeklyDir, "weekly-summary.json");
  const summaryPayload = {
    schemaVersion: 1,
    cycleId: record.id,
    type: record.type,
    week: weekStr,
    date: record.date,
    status: record.status,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    artifacts: filesWritten.map((f) => path.relative(root, f)),
    error: record.error,
  };
  writeJsonAtomic(summaryPath, summaryPayload);
  filesWritten.push(summaryPath);

  // 4. Im Index registrieren
  updateArtifactIndex((idx) => {
    const existingIndex = idx.weeklyRuns.findIndex((r) => r.id === record.id);
    const entry: WeeklyRunIndexEntry = {
      id: record.id,
      week: weekStr,
      date: record.date,
      status: record.status,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMs: record.durationMs,
      artifactsDir: path.relative(process.cwd(), weeklyDir),
      reviewPath: path.relative(process.cwd(), reviewPath),
      coreCount: reviewOutput.review.summary.CORE,
      rotationCount: reviewOutput.review.summary.ROTATION,
      discoveryCount: reviewOutput.review.summary.DISCOVERY,
      excludedCount: reviewOutput.review.summary.EXCLUDED,
      error: record.error?.message,
    };

    if (existingIndex >= 0) {
      idx.weeklyRuns[existingIndex] = entry;
    } else {
      idx.weeklyRuns.unshift(entry);
    }
  }, rootDir);

  return { artifactsDir: weeklyDir, filesWritten };
}

/**
 * Liest den jüngsten Tageslauf.
 */
export function getLatestDailyArtifact(rootDir?: string): Record<string, unknown> | null {
  const root = resolveArtifactsRoot(rootDir);
  const index = getArtifactIndex(root);
  const latestEntry = index.dailyRuns[0];
  if (!latestEntry) {
    // Fallback: Dateisystem durchsuchen
    if (!existsSync(root)) return null;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && DATE_FOLDER_RE.test(d.name))
      .map((d) => d.name)
      .sort();
    const latestDate = dirs[dirs.length - 1];
    if (!latestDate) return null;
    return getDailyArtifactByDate(latestDate, rootDir);
  }
  return getDailyArtifactByDate(latestEntry.date, rootDir);
}

/**
 * Liest einen Tageslauf nach Datum YYYY-MM-DD.
 */
export function getDailyArtifactByDate(date: string, rootDir?: string): Record<string, unknown> | null {
  const root = resolveArtifactsRoot(rootDir);
  const dailyDir = path.join(root, date, "daily");
  const summaryPath = path.join(dailyDir, "daily-summary.json");
  const summary = readJsonSafe<Record<string, unknown>>(summaryPath);
  if (!summary) return null;

  // Einzelne Step-Artefakte dazuladen falls vorhanden
  const steps: Record<string, unknown> = {};
  if (existsSync(dailyDir)) {
    for (const f of readdirSync(dailyDir)) {
      if (f.endsWith(".json") && f !== "daily-summary.json") {
        const stepKey = f.replace(".json", "");
        steps[stepKey] = readJsonSafe(path.join(dailyDir, f));
      }
    }
  }

  return {
    ...summary,
    stepsData: steps,
  };
}

/**
 * Liest den jüngsten wöchentlichen Universe Review.
 */
export function getLatestWeeklyArtifact(rootDir?: string): WeeklyReview | null {
  const root = resolveArtifactsRoot(rootDir);
  const index = getArtifactIndex(root);
  const latestEntry = index.weeklyRuns[0];
  if (!latestEntry) {
    // Fallback Dateisystem
    if (!existsSync(root)) return null;
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && WEEK_FOLDER_RE.test(d.name))
      .map((d) => d.name)
      .sort();
    const latestWeek = dirs[dirs.length - 1];
    if (!latestWeek) return null;
    const reviewPath = path.join(root, latestWeek, "weekly", "weekly-review.json");
    return readJsonSafe<WeeklyReview>(reviewPath);
  }
  // `reviewPath` ist ein VON DIESEM MODUL persistierter Eintrag
  // (`path.relative(process.cwd(), …)` beim Schreiben). Liegt das
  // Artefakt-Verzeichnis außerhalb des Projekts, ist der Wert zwingend
  // `../../../…` — `resolveStoredPath()` ist genau für diese app-eigenen
  // Index-Werte da (siehe src/lib/appPaths.ts). Fremd-/HTTP-Eingaben laufen
  // stattdessen über `resolveRuntimePath()` mit Ausbruch-Schutz.
  const reviewPath = resolveStoredPath(latestEntry.reviewPath);
  return readJsonSafe<WeeklyReview>(reviewPath);
}

/**
 * Bereinigt alte Artefakte gemäß Aufbewahrungsrichtlinie (Retention).
 */
export function pruneArtifacts(
  options: {
    retentionDays?: number; // Standard: 30 Tage
    retentionWeeks?: number; // Standard: 12 Wochen
    rootDir?: string;
  } = {}
): { prunedDays: string[]; prunedWeeks: string[] } {
  const root = resolveArtifactsRoot(options.rootDir);
  if (!existsSync(root)) return { prunedDays: [], prunedWeeks: [] };

  const retentionDays = options.retentionDays ?? 30;
  const retentionWeeks = options.retentionWeeks ?? 12;

  const nowMs = Date.now();
  const maxDayAgeMs = retentionDays * 86_400_000;
  const maxWeekAgeMs = retentionWeeks * 7 * 86_400_000;

  const prunedDays: string[] = [];
  const prunedWeeks: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(root, entry.name);

    if (DATE_FOLDER_RE.test(entry.name)) {
      const folderDateMs = Date.parse(entry.name);
      if (Number.isFinite(folderDateMs) && nowMs - folderDateMs > maxDayAgeMs) {
        rmSync(fullPath, { recursive: true, force: true });
        prunedDays.push(entry.name);
      }
    } else if (WEEK_FOLDER_RE.test(entry.name)) {
      // z. B. 2026-W30
      const parts = entry.name.split("-W");
      const year = Number(parts[0]);
      const week = Number(parts[1]);
      if (Number.isFinite(year) && Number.isFinite(week)) {
        // Schätzung Zeitstempel aus Jahr + Woche
        const approxMs = new Date(year, 0, 1 + (week - 1) * 7).getTime();
        if (nowMs - approxMs > maxWeekAgeMs) {
          rmSync(fullPath, { recursive: true, force: true });
          prunedWeeks.push(entry.name);
        }
      }
    }
  }

  // Index nachbereinigen
  if (prunedDays.length > 0 || prunedWeeks.length > 0) {
    updateArtifactIndex((idx) => {
      idx.dailyRuns = idx.dailyRuns.filter((r) => !prunedDays.includes(r.date));
      idx.weeklyRuns = idx.weeklyRuns.filter((r) => !prunedWeeks.includes(r.week));
    }, options.rootDir);
  }

  return { prunedDays, prunedWeeks };
}
