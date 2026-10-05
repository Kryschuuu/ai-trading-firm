/** Point-in-time-Makro-Kontext für die adaptive Risikodrossel (TASK 04). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MACRO_CONTEXT_MAX_AGE_MS,
  macroVolatilityFactor,
  readLatestMacroVolatilityFactor,
} from "../src/lib/macroRegimeContext";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

test("Makro-Regime-Faktor ist eine reine Drossel und LOW erhöht das Risiko nicht", () => {
  assert.equal(macroVolatilityFactor("EXTREME"), 0.5);
  assert.equal(macroVolatilityFactor("HIGH"), 0.75);
  assert.equal(macroVolatilityFactor("LOW"), 1);
  assert.equal(macroVolatilityFactor("NORMAL"), 1);
  assert.equal(macroVolatilityFactor("garbage"), 1);
});

test("liest das neueste abgeschlossene, frische Makro-Artefakt aus dem konfigurierten Cycle-Root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "macro-cycle-artifacts-"));
  try {
    const nowMs = Date.parse("2026-10-05T14:00:00.000Z");
    writeJson(path.join(root, "index.json"), {
      schemaVersion: 1,
      dailyRuns: [
        { id: "old", date: "2026-10-04", status: "COMPLETED", startedAt: "2026-10-04T12:00:00.000Z", completedAt: "2026-10-04T12:10:00.000Z" },
        { id: "latest", date: "2026-10-05", status: "COMPLETED", startedAt: "2026-10-05T13:00:00.000Z", completedAt: "2026-10-05T13:10:00.000Z" },
      ],
    });
    writeJson(path.join(root, "2026-10-04", "daily", "02-macro-analyst.json"), { volatilityRegime: "EXTREME" });
    writeJson(path.join(root, "2026-10-05", "daily", "02-macro-analyst.json"), { volatilityRegime: "HIGH" });

    assert.equal(readLatestMacroVolatilityFactor({ rootDir: root, nowMs }), 0.75);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ein neuerer fehlgeschlagener Cycle neutralisiert ältere gültige Makro-Daten", () => {
  const root = mkdtempSync(path.join(tmpdir(), "macro-cycle-failed-"));
  try {
    const nowMs = Date.parse("2026-10-05T14:00:00.000Z");
    writeJson(path.join(root, "index.json"), {
      schemaVersion: 1,
      dailyRuns: [
        { id: "older-valid", date: "2026-10-05", status: "COMPLETED", startedAt: "2026-10-05T12:00:00.000Z", completedAt: "2026-10-05T12:10:00.000Z" },
        { id: "newer-failed", date: "2026-10-05", status: "FAILED", startedAt: "2026-10-05T13:30:00.000Z", completedAt: "2026-10-05T13:40:00.000Z" },
      ],
    });
    writeJson(path.join(root, "2026-10-05", "daily", "02-macro-analyst.json"), { volatilityRegime: "EXTREME" });

    assert.equal(readLatestMacroVolatilityFactor({ rootDir: root, nowMs }), 1, "a newer failed run must not reuse an older completed macro snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ein fehlerhafter Abschlusszeitpunkt neutralisiert ältere Makro-Daten", () => {
  const root = mkdtempSync(path.join(tmpdir(), "macro-cycle-malformed-"));
  try {
    const nowMs = Date.parse("2026-10-05T14:00:00.000Z");
    writeJson(path.join(root, "index.json"), {
      schemaVersion: 1,
      dailyRuns: [
        { id: "older-valid", date: "2026-10-04", status: "COMPLETED", startedAt: "2026-10-04T12:00:00.000Z", completedAt: "2026-10-04T12:10:00.000Z" },
        { id: "newer-malformed", date: "2026-10-05", status: "COMPLETED", startedAt: "2026-10-05T13:30:00.000Z", completedAt: "not-a-timestamp" },
      ],
    });
    writeJson(path.join(root, "2026-10-04", "daily", "02-macro-analyst.json"), { volatilityRegime: "EXTREME" });
    writeJson(path.join(root, "2026-10-05", "daily", "02-macro-analyst.json"), { volatilityRegime: "HIGH" });

    assert.equal(readLatestMacroVolatilityFactor({ rootDir: root, nowMs }), 1, "a malformed newest completion must not reuse or trust a macro snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale, future, fehlende oder verworfene Makro-Artefakte bleiben neutral", () => {
  const root = mkdtempSync(path.join(tmpdir(), "macro-cycle-stale-"));
  try {
    const nowMs = Date.parse("2026-10-05T14:00:00.000Z");
    const staleAt = new Date(nowMs - MACRO_CONTEXT_MAX_AGE_MS - 1).toISOString();
    writeJson(path.join(root, "index.json"), {
      schemaVersion: 1,
      dailyRuns: [
        { id: "stale", date: "2026-10-04", status: "COMPLETED", startedAt: staleAt, completedAt: staleAt },
      ],
    });
    writeJson(path.join(root, "2026-10-04", "daily", "02-macro-analyst.json"), { volatilityRegime: "EXTREME" });
    assert.equal(readLatestMacroVolatilityFactor({ rootDir: root, nowMs }), 1, "stale macro output is neutral");

    const freshAt = new Date(nowMs - 60 * 60_000).toISOString();
    const futureAt = new Date(nowMs + 60 * 60_000).toISOString();
    writeJson(path.join(root, "index.json"), {
      schemaVersion: 1,
      dailyRuns: [
        { id: "future", date: "2026-10-05", status: "COMPLETED", startedAt: futureAt, completedAt: futureAt },
        { id: "fresh-older", date: "2026-10-04", status: "COMPLETED", startedAt: freshAt, completedAt: freshAt },
      ],
    });
    writeJson(path.join(root, "2026-10-04", "daily", "02-macro-analyst.json"), { volatilityRegime: "EXTREME" });
    assert.equal(readLatestMacroVolatilityFactor({ rootDir: root, nowMs }), 1, "a future result must not fall back to older risk context");

    writeJson(path.join(root, "index.json"), {
      schemaVersion: 1,
      dailyRuns: [
        { id: "skipped", date: "2026-10-05", status: "COMPLETED", startedAt: "2026-10-05T13:00:00.000Z", completedAt: "2026-10-05T13:10:00.000Z" },
        { id: "older-valid", date: "2026-10-04", status: "COMPLETED", startedAt: freshAt, completedAt: freshAt },
      ],
    });
    writeJson(path.join(root, "2026-10-05", "daily", "02-macro-analyst.json"), {
      volatilityRegime: "EXTREME",
      plausibility: { status: "SKIPPED" },
    });
    writeJson(path.join(root, "2026-10-04", "daily", "02-macro-analyst.json"), { volatilityRegime: "EXTREME" });
    assert.equal(readLatestMacroVolatilityFactor({ rootDir: root, nowMs }), 1, "a skipped result must not fall back to older risk context");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
