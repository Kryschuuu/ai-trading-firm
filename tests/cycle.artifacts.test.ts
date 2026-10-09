/**
 * Tests für Artefakte, Index und Retention (Task 06).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveDailyCycleArtifacts,
  saveWeeklyCycleArtifacts,
  getArtifactIndex,
  getLatestDailyArtifact,
  getDailyArtifactByDate,
  getLatestWeeklyArtifact,
  pruneArtifacts,
} from "../src/cycle/artifacts";
import { getIsoWeekString } from "../src/cycle/clock";
import type { CycleRunRecord } from "../src/cycle/types";
import type { WeeklyReview } from "@/scanner/weekly";

function createTempArtifactsDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cycle-artifacts-test-"));
}

test("Artifacts: speichert Daily-Artefakte atomar und aktualisiert den Index", () => {
  const tmpDir = createTempArtifactsDir();
  try {
    const record: CycleRunRecord = {
      id: "daily-2026-08-27-001",
      type: "daily",
      date: "2026-08-27",
      status: "COMPLETED",
      startedAt: "2026-08-27T00:00:00.000Z",
      completedAt: "2026-08-27T00:05:00.000Z",
      durationMs: 300000,
      steps: [],
      escalations: [],
      artifacts: [],
    };

    const stepOutputs = {
      "01-market-scanner": { scanned: 100 },
      "02-macro-analyst": { regime: "RISK_ON" },
      "03-market-selection": { selectedCount: 15 },
      "07-research": { totalSetups: 5 },
    };

    const res = saveDailyCycleArtifacts(record, stepOutputs, tmpDir);
    assert.ok(existsSync(res.artifactsDir));
    assert.ok(res.filesWritten.length >= 4);

    // Index prüfen
    const index = getArtifactIndex(tmpDir);
    assert.equal(index.dailyRuns.length, 1);
    assert.equal(index.dailyRuns[0].id, "daily-2026-08-27-001");
    assert.equal(index.dailyRuns[0].candidatesCount, 15);
    assert.equal(index.dailyRuns[0].setupsCount, 5);

    // Lesefunktionen prüfen
    const latest = getLatestDailyArtifact(tmpDir);
    assert.ok(latest);
    assert.equal(latest?.cycleId, "daily-2026-08-27-001");

    const byDate = getDailyArtifactByDate("2026-08-27", tmpDir);
    assert.ok(byDate);
    assert.equal(byDate?.cycleId, "daily-2026-08-27-001");

    const notFound = getDailyArtifactByDate("2025-01-01", tmpDir);
    assert.equal(notFound, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Artifacts: speichert Weekly-Artefakte und aktualisiert den Index", () => {
  const tmpDir = createTempArtifactsDir();
  try {
    const record: CycleRunRecord = {
      id: "weekly-2026-W35-001",
      type: "weekly",
      date: "2026-08-30",
      week: "2026-W35",
      status: "COMPLETED",
      startedAt: "2026-08-30T00:00:00.000Z",
      completedAt: "2026-08-30T00:02:00.000Z",
      durationMs: 120000,
      steps: [],
      escalations: [],
      artifacts: [],
    };

    const review: WeeklyReview = {
      schemaVersion: 1,
      configVersion: 1,
      asOf: "2026-08-30T00:00:00.000Z",
      entries: [
        {
          instrumentId: "BINANCE:BTCUSDT",
          class: "CORE",
          reasons: ["score-80"],
          score: 80,
          asOf: "2026-08-30T00:00:00.000Z",
        },
      ],
      summary: { CORE: 1, ROTATION: 0, DISCOVERY: 0, EXCLUDED: 0 },
      changes: {
        newListings: [],
        delistings: [],
        liquidityDrops: [],
        feeIncreases: [],
        brokerUnavailable: [],
        regimeShifts: [],
        correlationClusters: [],
      },
      context: {
        regimeByInstrument: {},
        volume24hByInstrument: {},
        takerFeeByInstrument: {},
        paperAvailableByInstrument: {},
        persistence: {},
      },
    };

    saveWeeklyCycleArtifacts(record, { review }, tmpDir);

    const index = getArtifactIndex(tmpDir);
    assert.equal(index.weeklyRuns.length, 1);
    assert.equal(index.weeklyRuns[0].week, "2026-W35");
    assert.equal(index.weeklyRuns[0].coreCount, 1);

    const latestWeekly = getLatestWeeklyArtifact(tmpDir);
    assert.ok(latestWeekly);
    assert.equal(latestWeekly?.entries.length, 1);
    assert.equal(latestWeekly?.entries[0].class, "CORE");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Artifacts: pruneArtifacts bereinigt alte Ordner gemäß Retention", () => {
  const tmpDir = createTempArtifactsDir();
  try {
    // 1. Alten Ordner vor 40 Tagen anlegen
    const oldDateRecord: CycleRunRecord = {
      id: "daily-old",
      type: "daily",
      date: "2026-01-01",
      status: "COMPLETED",
      startedAt: "2026-01-01T00:00:00.000Z",
      steps: [],
      escalations: [],
      artifacts: [],
    };
    saveDailyCycleArtifacts(oldDateRecord, {}, tmpDir);

    // 2. Frischen Ordner von heute anlegen
    const today = new Date().toISOString().slice(0, 10);
    const todayRecord: CycleRunRecord = {
      id: "daily-today",
      type: "daily",
      date: today,
      status: "COMPLETED",
      startedAt: new Date().toISOString(),
      steps: [],
      escalations: [],
      artifacts: [],
    };
    saveDailyCycleArtifacts(todayRecord, {}, tmpDir);

    // Retention: 30 Tage
    const pruneRes = pruneArtifacts({ retentionDays: 30, rootDir: tmpDir });
    assert.ok(pruneRes.prunedDays.includes("2026-01-01"));
    assert.equal(pruneRes.prunedDays.includes(today), false);

    const indexAfter = getArtifactIndex(tmpDir);
    assert.equal(indexAfter.dailyRuns.some((r) => r.date === "2026-01-01"), false);
    assert.equal(indexAfter.dailyRuns.some((r) => r.date === today), true);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── DC-05 (2026-10-09): Retention per Env konfigurierbar ────────────────────

function daysAgoISO(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function saveDailyForDate(id: string, date: string, rootDir: string): void {
  const record: CycleRunRecord = {
    id,
    type: "daily",
    date,
    status: "COMPLETED",
    startedAt: `${date}T00:00:00.000Z`,
    steps: [],
    escalations: [],
    artifacts: [],
  };
  saveDailyCycleArtifacts(record, {}, rootDir);
}

/** Setzt CYCLE_RETENTION_DAYS/_WEEKS für die Dauer von `fn` (undefined = unset). */
function withRetentionEnv(days: string | undefined, weeks: string | undefined, fn: () => void): void {
  const prevDays = process.env.CYCLE_RETENTION_DAYS;
  const prevWeeks = process.env.CYCLE_RETENTION_WEEKS;
  if (days === undefined) delete process.env.CYCLE_RETENTION_DAYS;
  else process.env.CYCLE_RETENTION_DAYS = days;
  if (weeks === undefined) delete process.env.CYCLE_RETENTION_WEEKS;
  else process.env.CYCLE_RETENTION_WEEKS = weeks;
  try {
    fn();
  } finally {
    if (prevDays === undefined) delete process.env.CYCLE_RETENTION_DAYS;
    else process.env.CYCLE_RETENTION_DAYS = prevDays;
    if (prevWeeks === undefined) delete process.env.CYCLE_RETENTION_WEEKS;
    else process.env.CYCLE_RETENTION_WEEKS = prevWeeks;
  }
}

test("Artifacts: pruneArtifacts liest die Retention aus CYCLE_RETENTION_DAYS/_WEEKS", () => {
  const tmpDir = createTempArtifactsDir();
  try {
    const oldDay = daysAgoISO(40);
    const youngDay = daysAgoISO(10);
    saveDailyForDate("daily-old", oldDay, tmpDir);
    saveDailyForDate("daily-young", youngDay, tmpDir);
    saveDailyForDate("daily-today", daysAgoISO(0), tmpDir);

    // Wochenordner: sehr alt + aktuelle ISO-Woche (prune wertet nur den Namen)
    const oldWeek = "2020-W01";
    const currentWeek = getIsoWeekString(new Date());
    for (const w of [oldWeek, currentWeek]) {
      const dir = path.join(tmpDir, w, "weekly");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "weekly-summary.json"), "{}\n");
    }

    withRetentionEnv("30", "12", () => {
      const res = pruneArtifacts({ rootDir: tmpDir });
      // Alter Tages-Ordner entfernt, junge bleiben
      assert.ok(res.prunedDays.includes(oldDay));
      assert.equal(res.prunedDays.includes(youngDay), false);
      assert.equal(res.prunedDays.includes(daysAgoISO(0)), false);
      // Alte Woche entfernt, aktuelle Woche bleibt
      assert.ok(res.prunedWeeks.includes(oldWeek));
      assert.equal(res.prunedWeeks.includes(currentWeek), false);
      // Dateisystem und Index sind bereinigt
      assert.equal(existsSync(path.join(tmpDir, oldDay)), false);
      assert.ok(existsSync(path.join(tmpDir, youngDay)));
      assert.equal(existsSync(path.join(tmpDir, oldWeek)), false);
      assert.ok(existsSync(path.join(tmpDir, currentWeek)));
      const index = getArtifactIndex(tmpDir);
      assert.equal(index.dailyRuns.some((r) => r.date === oldDay), false);
      assert.equal(index.dailyRuns.some((r) => r.date === youngDay), true);
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Artifacts: CYCLE_RETENTION_DAYS überschreibt den Default (5 statt 30 Tage)", () => {
  const tmpDir = createTempArtifactsDir();
  try {
    const tenDays = daysAgoISO(10);
    const twentyDays = daysAgoISO(20);
    saveDailyForDate("daily-10", tenDays, tmpDir);
    saveDailyForDate("daily-20", twentyDays, tmpDir);

    // Ohne Env: Default 30 Tage — beide Ordner bleiben
    withRetentionEnv(undefined, undefined, () => {
      const res = pruneArtifacts({ rootDir: tmpDir });
      assert.equal(res.prunedDays.length, 0);
      assert.ok(existsSync(path.join(tmpDir, tenDays)));
      assert.ok(existsSync(path.join(tmpDir, twentyDays)));
    });

    // Env-Override 5: beide Ordner sind älter als 5 Tage → entfernt
    withRetentionEnv("5", undefined, () => {
      const res = pruneArtifacts({ rootDir: tmpDir });
      assert.ok(res.prunedDays.includes(tenDays));
      assert.ok(res.prunedDays.includes(twentyDays));
      assert.equal(existsSync(path.join(tmpDir, tenDays)), false);
      assert.equal(existsSync(path.join(tmpDir, twentyDays)), false);
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Artifacts: Defaults 30/12 ohne Env; Bounds [1, 3650] klemmen Ausreißer", () => {
  const tmpDir = createTempArtifactsDir();
  try {
    const fortyDays = daysAgoISO(40);
    saveDailyForDate("daily-40", fortyDays, tmpDir);

    // Ohne Env: Default 30 Tage → 40 Tage alter Ordner wird entfernt
    withRetentionEnv(undefined, undefined, () => {
      const res = pruneArtifacts({ rootDir: tmpDir });
      assert.ok(res.prunedDays.includes(fortyDays));
      assert.equal(existsSync(path.join(tmpDir, fortyDays)), false);
    });

    const tenDays = daysAgoISO(10);
    saveDailyForDate("daily-10", tenDays, tmpDir);

    // "0" wird auf das Minimum 1 geklemmt → 10 Tage alter Ordner wird entfernt
    withRetentionEnv("0", undefined, () => {
      const res = pruneArtifacts({ rootDir: tmpDir });
      assert.ok(res.prunedDays.includes(tenDays));
      assert.equal(existsSync(path.join(tmpDir, tenDays)), false);
    });

    const twentyDays = daysAgoISO(20);
    saveDailyForDate("daily-20", twentyDays, tmpDir);

    // "99999" wird auf das Maximum 3650 geklemmt → 20 Tage alter Ordner bleibt
    withRetentionEnv("99999", undefined, () => {
      const res = pruneArtifacts({ rootDir: tmpDir });
      assert.equal(res.prunedDays.length, 0);
      assert.ok(existsSync(path.join(tmpDir, twentyDays)));
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
