/**
 * Tests für Artefakte, Index und Retention (Task 06).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
