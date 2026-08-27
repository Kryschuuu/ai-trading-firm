/**
 * Tests für die read-only Analysis API-Routen (Task 06).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as getDailyLatest } from "../src/app/api/analysis/daily/latest/route";
import { GET as getDailyByDate } from "../src/app/api/analysis/daily/[date]/route";
import { GET as getWeeklyLatest } from "../src/app/api/analysis/weekly/latest/route";
import { GET as getRuns } from "../src/app/api/analysis/runs/route";
import { getCycleService, resetCycleServiceForTests, CycleService } from "../src/cycle/service";
import { saveDailyCycleArtifacts, saveWeeklyCycleArtifacts } from "../src/cycle/artifacts";
import type { CycleRunRecord } from "../src/cycle/types";
import type { WeeklyReview } from "@/scanner/weekly";

test("API: GET /api/analysis/daily/latest liefert 404 wenn leer, 200 mit Daten", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "api-daily-latest-"));
  const prevEnv = process.env.CYCLE_ARTIFACTS_DIR;
  process.env.CYCLE_ARTIFACTS_DIR = tmpDir;
  resetCycleServiceForTests(new CycleService());

  try {
    // 1. Noch keine Daten
    const resEmpty = await getDailyLatest();
    assert.equal(resEmpty.status, 404);
    const bodyEmpty = await resEmpty.json();
    assert.equal(bodyEmpty.ok, false);
    assert.equal(bodyEmpty.error, "NOT_FOUND");

    // 2. Daten speichern
    const record: CycleRunRecord = {
      id: "daily-test",
      type: "daily",
      date: "2026-08-27",
      status: "COMPLETED",
      startedAt: "2026-08-27T00:00:00.000Z",
      steps: [],
      escalations: [],
      artifacts: [],
    };
    saveDailyCycleArtifacts(record, { "01-market-scanner": { scanned: 50 } }, tmpDir);

    // 3. Erneut abrufen
    const resSuccess = await getDailyLatest();
    assert.equal(resSuccess.status, 200);
    const bodySuccess = await resSuccess.json();
    assert.equal(bodySuccess.ok, true);
    assert.equal(bodySuccess.cycleId, "daily-test");
  } finally {
    process.env.CYCLE_ARTIFACTS_DIR = prevEnv;
    resetCycleServiceForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("API: GET /api/analysis/daily/{date} validiert Format und liefert Daten", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "api-daily-date-"));
  const prevEnv = process.env.CYCLE_ARTIFACTS_DIR;
  process.env.CYCLE_ARTIFACTS_DIR = tmpDir;
  resetCycleServiceForTests(new CycleService());

  try {
    // 1. Ungültiges Datumsformat
    const resBadDate = await getDailyByDate(new Request("http://localhost"), {
      params: Promise.resolve({ date: "invalid-date" }),
    });
    assert.equal(resBadDate.status, 400);

    // 2. Nicht gefunden
    const resNotFound = await getDailyByDate(new Request("http://localhost"), {
      params: Promise.resolve({ date: "2026-08-27" }),
    });
    assert.equal(resNotFound.status, 404);

    // 3. Vorhandener Tag
    const record: CycleRunRecord = {
      id: "daily-dated",
      type: "daily",
      date: "2026-08-27",
      status: "COMPLETED",
      startedAt: "2026-08-27T00:00:00.000Z",
      steps: [],
      escalations: [],
      artifacts: [],
    };
    saveDailyCycleArtifacts(record, {}, tmpDir);

    const resFound = await getDailyByDate(new Request("http://localhost"), {
      params: Promise.resolve({ date: "2026-08-27" }),
    });
    assert.equal(resFound.status, 200);
    const body = await resFound.json();
    assert.equal(body.ok, true);
    assert.equal(body.date, "2026-08-27");
  } finally {
    process.env.CYCLE_ARTIFACTS_DIR = prevEnv;
    resetCycleServiceForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("API: GET /api/analysis/weekly/latest liefert Weekly Review", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "api-weekly-latest-"));
  const prevEnv = process.env.CYCLE_ARTIFACTS_DIR;
  process.env.CYCLE_ARTIFACTS_DIR = tmpDir;
  resetCycleServiceForTests(new CycleService());

  try {
    const resEmpty = await getWeeklyLatest();
    assert.equal(resEmpty.status, 404);

    const record: CycleRunRecord = {
      id: "weekly-test",
      type: "weekly",
      date: "2026-08-30",
      week: "2026-W35",
      status: "COMPLETED",
      startedAt: "2026-08-30T00:00:00.000Z",
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
          reasons: ["top"],
          score: 85,
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

    const resSuccess = await getWeeklyLatest();
    assert.equal(resSuccess.status, 200);
    const body = await resSuccess.json();
    assert.equal(body.ok, true);
    assert.equal(body.review.entries.length, 1);
  } finally {
    process.env.CYCLE_ARTIFACTS_DIR = prevEnv;
    resetCycleServiceForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("API: GET /api/analysis/runs paginiert und filtert", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "api-runs-"));
  const prevEnv = process.env.CYCLE_ARTIFACTS_DIR;
  process.env.CYCLE_ARTIFACTS_DIR = tmpDir;
  resetCycleServiceForTests(new CycleService());

  try {
    // Ungültige Paginierungs-Parameter
    const badRes1 = await getRuns(new Request("http://localhost/api/analysis/runs?page=0"));
    assert.equal(badRes1.status, 400);

    const badRes2 = await getRuns(new Request("http://localhost/api/analysis/runs?pageSize=200"));
    assert.equal(badRes2.status, 400);

    // 2 Läufe anlegen
    const r1: CycleRunRecord = {
      id: "run-1",
      type: "daily",
      date: "2026-08-26",
      status: "COMPLETED",
      startedAt: "2026-08-26T00:00:00.000Z",
      steps: [],
      escalations: [],
      artifacts: [],
    };
    const r2: CycleRunRecord = {
      id: "run-2",
      type: "daily",
      date: "2026-08-27",
      status: "FAILED",
      startedAt: "2026-08-27T00:00:00.000Z",
      steps: [],
      escalations: [],
      artifacts: [],
    };
    saveDailyCycleArtifacts(r1, {}, tmpDir);
    saveDailyCycleArtifacts(r2, {}, tmpDir);

    // Alle abfragen
    const allRes = await getRuns(new Request("http://localhost/api/analysis/runs?pageSize=10"));
    assert.equal(allRes.status, 200);
    const allBody = await allRes.json();
    assert.equal(allBody.total, 2);
    assert.equal(allBody.items.length, 2);

    // Nach Status filtern
    const failedRes = await getRuns(new Request("http://localhost/api/analysis/runs?status=FAILED"));
    const failedBody = await failedRes.json();
    assert.equal(failedBody.total, 1);
    assert.equal(failedBody.items[0].id, "run-2");
  } finally {
    process.env.CYCLE_ARTIFACTS_DIR = prevEnv;
    resetCycleServiceForTests();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
