/**
 * Zyklus-Integration der MTF-Konfluenz (RMA-P2-03):
 * technischer Step (Trusted-Data, serverseitige Anhängung, Fallback,
 * Flag-Pfad) gegen einen temporären Historical Store.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimulatedClock } from "../src/cycle/clock";
import { createTestPorts, type CyclePortsForTest } from "./confluence.cycle.helpers";
import { technicalStep } from "../src/cycle/steps/technicalStep";
import type { StepExecutionContext } from "../src/cycle/types";
import type { SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import type { MarketCandle } from "../src/lib/marketdata/types";
import { ASOF_MS, upBars } from "./confluence.helpers";

const PROV = { venue: "BITUNIX", feed: "BITUNIX:rest" };
const ID_A = "BITUNIX:BTCUSDT";
const ID_B = "BITUNIX:ETHUSDT";

let dir: string;
let savedHistoryDir: string | undefined;
let savedEnabled: string | undefined;
let savedConfigFile: string | undefined;

function toMarketCandles(tf: "15m" | "1h" | "4h"): MarketCandle[] {
  return upBars(tf, 30).map((c) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}

function seedStore(now: Date): void {
  const store = new HistoricalStore(dir);
  store.appendSeries(
    [ID_A, ID_B].flatMap((id) =>
      (["15m", "1h", "4h"] as const).map((tf) => ({
        candles: toMarketCandles(tf),
        instrumentId: id,
        provenance: PROV,
        timeframe: tf as SupportedTimeframe,
      })),
    ),
    now,
  );
}

function mockContext(
  input: { candidates?: Array<{ instrumentId: string }> },
  ports: CyclePortsForTest,
): StepExecutionContext<{ candidates?: Array<{ instrumentId: string }> }> {
  const clock = new SimulatedClock(new Date(ASOF_MS));
  return {
    cycleId: "test-cycle-confluence",
    date: "2026-01-05",
    asOf: clock.now(),
    clock,
    input,
    previousStepOutputs: {},
    ports,
    emitEscalation: () => {},
    log: () => {},
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "confluence-cycle-"));
  savedHistoryDir = process.env.PAPER_HISTORY_DIR;
  savedEnabled = process.env.CONFLUENCE_ENABLED;
  savedConfigFile = process.env.CONFLUENCE_CONFIG_FILE;
  process.env.PAPER_HISTORY_DIR = dir;
  delete process.env.CONFLUENCE_ENABLED;
  delete process.env.CONFLUENCE_CONFIG_FILE;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedHistoryDir === undefined) delete process.env.PAPER_HISTORY_DIR;
  else process.env.PAPER_HISTORY_DIR = savedHistoryDir;
  if (savedEnabled === undefined) delete process.env.CONFLUENCE_ENABLED;
  else process.env.CONFLUENCE_ENABLED = savedEnabled;
  if (savedConfigFile === undefined) delete process.env.CONFLUENCE_CONFIG_FILE;
  else process.env.CONFLUENCE_CONFIG_FILE = savedConfigFile;
});

test("technischer Step hängt autoritative Snapshots an (LLM + Meta intakt)", async () => {
  seedStore(new Date(ASOF_MS - 60_000));
  const ports = createTestPorts();
  ports.agent.setResponseForRole("TECHNICAL_ANALYST", {
    analyses: [
      {
        instrumentId: ID_A,
        bias: "BULLISH",
        technicalScore: 80,
        trend: "bullish",
        keyLevels: { support: 90, resistance: 140 },
        thesis: "Aufwärtstrend über alle Timeframes",
      },
      {
        instrumentId: ID_B,
        bias: "BULLISH",
        technicalScore: 78,
        trend: "bullish",
        keyLevels: { support: 80, resistance: 130 },
        thesis: "Aufwärtstrend über alle Timeframes",
      },
    ],
    analyzedCount: 2,
  });
  const ctx = mockContext({ candidates: [{ instrumentId: ID_A }, { instrumentId: ID_B }] }, ports);
  const out = await technicalStep.execute(ctx);

  assert.equal(out.analyses.length, 2);
  // LLM-Felder bleiben erhalten (additiv, kein Ersatz).
  assert.equal(out.analyses[0].technicalScore, 80);
  assert.equal(out.analyses[0].thesis, "Aufwärtstrend über alle Timeframes");
  // Autoritative Snapshots sind angehängt.
  for (const analysis of out.analyses) {
    assert.ok(analysis.confluence);
    assert.equal(analysis.confluence.formulaVersion, "mtf-confluence@1");
    assert.equal(analysis.confluence.configVersion, 1);
    assert.equal(analysis.confluence.status, "OK");
    assert.ok(analysis.confluence.direction !== null && analysis.confluence.direction > 0.5);
    assert.match(analysis.confluence.snapshotKey, /^mtf1:[0-9a-f]{16}$/);
  }
  assert.ok(out.confluenceMeta);
  assert.equal(out.confluenceMeta.computed, 2);
  assert.equal(out.confluenceMeta.ok, 2);
  assert.equal(out.confluenceMeta.abstained, 0);
  // Trusted-Payload wurde dem Agenten übergeben (getrennte trustedData).
  const spec = ports.agent.lastSpecFor("TECHNICAL_ANALYST");
  assert.ok(spec);
  assert.ok(spec.trustedData);
  const trusted = spec.trustedData as { kind: string; snapshots: unknown[]; lines: unknown[] };
  assert.equal(trusted.kind, "mtf-confluence");
  assert.equal(trusted.snapshots.length, 2);
  assert.equal(trusted.lines.length, 2);
});

test("gefälschter LLM-Snapshot wird durch den berechneten ersetzt (kein Override)", async () => {
  seedStore(new Date(ASOF_MS - 60_000));
  const ports = createTestPorts();
  ports.agent.setResponseForRole("TECHNICAL_ANALYST", {
    analyses: [
      {
        instrumentId: ID_A,
        bias: "BEARISH",
        technicalScore: 5,
        trend: "bearish",
        keyLevels: { support: 1, resistance: 2 },
        thesis: "Override-Versuch",
        confluence: {
          formulaVersion: "mtf-confluence@1",
          status: "OK",
          direction: -1,
          strength: 1,
          bias: "BEARISH",
          confidence: 1,
          coverage: 1,
          conflict: 0,
        },
      },
    ],
    analyzedCount: 1,
  });
  const ctx = mockContext({ candidates: [{ instrumentId: ID_A }] }, ports);
  const out = await technicalStep.execute(ctx);
  // Der angehängte Snapshot ist der BERECHNETE (aufwärts), nicht der gefälschte.
  assert.ok(out.analyses[0].confluence);
  assert.ok(out.analyses[0].confluence.direction !== null);
  assert.ok(out.analyses[0].confluence.direction > 0.5);
  assert.equal(out.analyses[0].confluence.bias, "BULLISH");
});

test("Fallback-Pfad trägt Snapshots (Fallback ≠ ohne Deterministik)", async () => {
  seedStore(new Date(ASOF_MS - 60_000));
  const ports = createTestPorts();
  ports.agent.setForceFallback(true);
  const ctx = mockContext({ candidates: [{ instrumentId: ID_A }] }, ports);
  const out = await technicalStep.execute(ctx);
  assert.equal(out.analyses[0].bias, "NEUTRAL");
  assert.ok(out.analyses[0].confluence);
  assert.equal(out.analyses[0].confluence.status, "OK");
  assert.ok(out.confluenceMeta);
  assert.equal(out.confluenceMeta.computed, 1);
});

test("leerer Store: ABSTAIN-Snapshots sind sichtbar angehängt (fail-closed)", async () => {
  // Kein Seed — der Store ist leer.
  const ports = createTestPorts();
  ports.agent.setResponseForRole("TECHNICAL_ANALYST", {
    analyses: [
      {
        instrumentId: ID_A,
        bias: "BULLISH",
        technicalScore: 90,
        trend: "bullish",
        keyLevels: { support: 1, resistance: 2 },
        thesis: "LLM ohne Daten",
      },
    ],
    analyzedCount: 1,
  });
  const ctx = mockContext({ candidates: [{ instrumentId: ID_A }] }, ports);
  const out = await technicalStep.execute(ctx);
  assert.ok(out.analyses[0].confluence);
  assert.equal(out.analyses[0].confluence.status, "ABSTAIN");
  assert.equal(out.analyses[0].confluence.direction, null);
  assert.equal(out.analyses[0].confluence.confidence, 0);
  assert.ok(out.confluenceMeta);
  assert.equal(out.confluenceMeta.abstained, 1);
  // Die LLM-These bleibt erhalten — aber das Null-Signal ist nicht zu übersehen.
  assert.equal(out.analyses[0].thesis, "LLM ohne Daten");
});

test("CONFLUENCE_ENABLED=false: Legacy-Output ohne Snapshot (Rollback-Pfad)", async () => {
  seedStore(new Date(ASOF_MS - 60_000));
  process.env.CONFLUENCE_ENABLED = "false";
  const ports = createTestPorts();
  ports.agent.setResponseForRole("TECHNICAL_ANALYST", {
    analyses: [
      {
        instrumentId: ID_A,
        bias: "BULLISH",
        technicalScore: 80,
        trend: "bullish",
        keyLevels: { support: 1, resistance: 2 },
        thesis: "Legacy",
      },
    ],
    analyzedCount: 1,
  });
  const ctx = mockContext({ candidates: [{ instrumentId: ID_A }] }, ports);
  const out = await technicalStep.execute(ctx);
  assert.ok(!("confluence" in out.analyses[0]));
  assert.equal(out.confluenceMeta, undefined);
  const trusted = ports.agent.lastSpecFor("TECHNICAL_ANALYST")?.trustedData as { kind?: string } | undefined;
  assert.equal(trusted?.kind, "trusted-indicators@1");
});

test("Artefakt-Roundtrip: Output mit Snapshots überlebt JSON-Persistenz", async () => {
  seedStore(new Date(ASOF_MS - 60_000));
  const ports = createTestPorts();
  ports.agent.setResponseForRole("TECHNICAL_ANALYST", {
    analyses: [
      {
        instrumentId: ID_A,
        bias: "BULLISH",
        technicalScore: 80,
        trend: "bullish",
        keyLevels: { support: 1, resistance: 2 },
        thesis: "Roundtrip",
      },
    ],
    analyzedCount: 1,
  });
  const ctx = mockContext({ candidates: [{ instrumentId: ID_A }] }, ports);
  const out = await technicalStep.execute(ctx);
  // JSON-Persistenz ist der Artefakt-Pfad: `undefined`-Felder entfallen beim
  // Schreiben — der deterministische Nachweis ist die Byte-Identität der
  // zweiten Serialisierung plus die erhaltenen Snapshot-Felder.
  const roundtripped = JSON.parse(JSON.stringify(out)) as typeof out;
  assert.equal(JSON.stringify(roundtripped), JSON.stringify(out));
  assert.equal(roundtripped.analyses[0].confluence?.formulaVersion, "mtf-confluence@1");
  assert.equal(roundtripped.analyses[0].confluence?.snapshotKey, out.analyses[0].confluence?.snapshotKey);
  assert.equal(roundtripped.confluenceMeta?.computed, 1);
});
