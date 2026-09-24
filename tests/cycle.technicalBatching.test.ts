/**
 * Batch-Aufteilung des Technical Analysten (CYCLE-BATCH-01).
 *
 * Geprüft wird das Verhalten, das der alte Einzelaufruf nicht hatte:
 *  1. passt der Prompt ins Budget → genau EIN Aufruf (unverändertes Verhalten),
 *  2. passt er nicht → mehrere Aufrufe, deren Ergebnisse in Eingabereihenfolge
 *     und vollständig zusammengeführt werden,
 *  3. jeder Aufruf sieht NUR die Kandidaten seines Batches (kein 40-Zeilen-
 *     Prompt für 2 Antworten),
 *  4. ein unbrauchbarer Batch wird neutral überdeckt und ist ZÄHLBAR, ohne
 *     dass die übrigen Batches verloren gehen,
 *  5. Redundanz (Voll-Snapshots ≡ Zeilenform) fliegt raus, BEVO-R geteilt wird.
 *
 * Kein echtes LLM, keine DB — der Fake-Port liefert vorgegebene Antworten.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SimulatedClock } from "../src/cycle/clock";
import {
  FakeAnalysisAgentPort,
  MemoryCycleAuditPort,
  StubAnalyticsPort,
  StubScannerPort,
} from "../src/cycle/ports";
import type { AgentInvocationResult, AgentInvocationSpec } from "../src/cycle/types";
import { technicalStep } from "../src/cycle/steps/technicalStep";
import type { StepExecutionContext } from "../src/cycle/types";
import { validateTechnicalOutput } from "../src/cycle/schemas";
import { HistoricalStore, type SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import type { MarketCandle } from "../src/lib/marketdata/types";
import { ASOF_MS, upBars } from "./confluence.helpers";

const PROV = { venue: "BITUNIX", feed: "BITUNIX:rest" };
const IDS = [
  "BITUNIX:BTCUSDT",
  "BITUNIX:ETHUSDT",
  "BITUNIX:SOLUSDT",
  "BITUNIX:XRPUSDT",
  "BITUNIX:ADAUSDT",
  "BITUNIX:DOGEUSDT",
];

/** Fake-Agent mit Mitschnitt ALLER Specs (Batch-Zusammensetzung pro Aufruf). */
class RecordingAgentPort extends FakeAnalysisAgentPort {
  readonly specs: AgentInvocationSpec<unknown>[] = [];
  /** Aufrufnummern (1-basiert), bei denen der Port wirft statt zu antworten. */
  throwsOn = new Set<number>();

  override async invokeAgent<T>(spec: AgentInvocationSpec<T>): Promise<AgentInvocationResult<T>> {
    this.specs.push(spec as AgentInvocationSpec<unknown>);
    if (this.throwsOn.has(this.specs.length)) {
      throw new Error("llm-budget:tokens je Turn überschritten");
    }
    return super.invokeAgent(spec);
  }
}

function createPorts() {
  const agent = new RecordingAgentPort();
  return {
    ports: {
      scanner: new StubScannerPort(),
      analytics: new StubAnalyticsPort(),
      agent,
      audit: new MemoryCycleAuditPort(),
    },
    agent,
  };
}

function mockContext(
  input: { candidates?: Array<{ instrumentId: string }> },
  ports: unknown,
): StepExecutionContext<{ candidates?: Array<{ instrumentId: string }> }> {
  const clock = new SimulatedClock(new Date(ASOF_MS));
  return {
    cycleId: "test-cycle-batch",
    date: "2026-01-05",
    asOf: clock.now(),
    clock,
    input,
    previousStepOutputs: {},
    ports: ports as never,
    emitEscalation: () => {},
    log: () => {},
  };
}

/** Antwort im Schema des Schritts: ein Analyseobjekt je übergebenes Instrument. */
function answerFor(ids: readonly string[], technicalScore = 77) {
  return {
    analyses: ids.map((instrumentId) => ({
      instrumentId,
      bias: "BULLISH",
      technicalScore,
      trend: "bullish",
      keyLevels: { support: 1, resistance: 2 },
      thesis: `Analyse ${instrumentId}`,
    })),
    analyzedCount: ids.length,
  };
}

let dir: string;
const saved = new Map<string, string | undefined>();
const ENV_KEYS = [
  "PAPER_HISTORY_DIR",
  "CONFLUENCE_ENABLED",
  "CONFLUENCE_CONFIG_FILE",
  "CYCLE_ANALYST_BATCH_SIZE",
  "CYCLE_ANALYST_CONCURRENCY",
  "CYCLE_PROMPT_INPUT_BUDGET_TOKENS",
  "OLLAMA_NUM_CTX",
  "LLM_MAX_TOKENS",
];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ta-batch-"));
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.PAPER_HISTORY_DIR = dir;
  // Deterministische Konfluenz: Snapshots müssen existieren, sonst testet
  // dieser Fall nur die halbe Wahrheit (Redundanz-Hebel braucht sie).
  const store = new HistoricalStore(dir);
  store.appendSeries(
    IDS.flatMap((instrumentId) =>
      (["15m", "1h", "4h"] as const).map((tf) => ({
        candles: upBars(tf, 30).map((c) => ({
          time: c.time,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })) as MarketCandle[],
        instrumentId,
        provenance: PROV,
        timeframe: tf as SupportedTimeframe,
      })),
    ),
    new Date(ASOF_MS - 60_000),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("Budget reicht: genau EIN Aufruf, volles Trusted-Material (altverhalten)", async () => {
  process.env.CYCLE_PROMPT_INPUT_BUDGET_TOKENS = "100000";
  const { ports, agent } = createPorts();
  agent.setResponseForRole("TECHNICAL_ANALYST", answerFor([IDS[0], IDS[1]]));

  const out = await technicalStep.execute(
    mockContext({ candidates: IDS.slice(0, 2).map((instrumentId) => ({ instrumentId })) }, ports),
  );

  assert.equal(agent.specs.length, 1, "kleine Shortlist darf nicht unnötig geteilt werden");
  assert.ok(out.promptFit);
  assert.equal(out.promptFit.calls, 1);
  assert.equal(out.promptFit.droppedFullSnapshots, false);
  assert.equal(out.promptFit.failedBatches, 0);
  assert.equal(out.promptFit.incomplete, false);
  assert.equal(out.analyzedCount, 2);
  // Die Voll-Snapshots sind bei Platz weiter im Prompt (Kompatibilität).
  const trusted = agent.specs[0].trustedData as { snapshots?: unknown[]; lines?: unknown[] };
  assert.equal(trusted.snapshots?.length, 2);
  assert.equal(trusted.lines?.length, 2);
});

test("Begrenztes Ausgabebudget: 6 Kandidaten → 3 Aufrufe à 2, Merge vollständig und sortiert", async () => {
  process.env.CYCLE_ANALYST_BATCH_SIZE = "2";
  const { ports, agent } = createPorts();
  agent.setResponseSequenceForRole("TECHNICAL_ANALYST", [
    answerFor([IDS[0], IDS[1]], 71),
    answerFor([IDS[2], IDS[3]], 72),
    answerFor([IDS[4], IDS[5]], 73),
  ]);

  const out = await technicalStep.execute(
    mockContext({ candidates: IDS.map((instrumentId) => ({ instrumentId })) }, ports),
  );

  assert.equal(agent.specs.length, 3, "drei Batches = drei LLM-Aufrufe");
  assert.deepEqual(
    out.analyses.map((a) => a.instrumentId),
    IDS,
    "Merge folgt der Eingabereihenfolge, nicht der Fertigstellungsreihenfolge",
  );
  assert.deepEqual(out.analyses.map((a) => a.technicalScore), [71, 71, 72, 72, 73, 73]);
  assert.equal(out.analyzedCount, 6);
  assert.ok(out.promptFit);
  assert.equal(out.promptFit.calls, 3);
  assert.equal(out.promptFit.maxItemsPerBatch, 2);
  assert.equal(out.promptFit.constrainedBy, "env-batch-size");
  assert.equal(out.promptFit.concurrency, 1, "lokaler Provider serialisiert per Default");
  assert.equal(out.promptFit.failedBatches, 0);
  assert.equal(out.promptFit.incomplete, false);
  // Autoritative Konfluenz bleibt auch über Batches hinweg angehängt.
  for (const analysis of out.analyses) assert.ok(analysis.confluence, analysis.instrumentId);
});

test("je Batch steht nur sein eigener Kandidatensatz im Prompt", async () => {
  process.env.CYCLE_ANALYST_BATCH_SIZE = "2";
  const { ports, agent } = createPorts();
  agent.setResponseSequenceForRole("TECHNICAL_ANALYST", [
    answerFor([IDS[0], IDS[1]]),
    answerFor([IDS[2], IDS[3]]),
    answerFor([IDS[4], IDS[5]]),
  ]);

  await technicalStep.execute(
    mockContext({ candidates: IDS.map((instrumentId) => ({ instrumentId })) }, ports),
  );

  const batches = [IDS.slice(0, 2), IDS.slice(2, 4), IDS.slice(4, 6)];
  assert.equal(agent.specs.length, 3);
  agent.specs.forEach((spec, index) => {
    const [mine, notMine] = [batches[index], batches[(index + 1) % 3]];
    const prompt = spec.userPrompt;
    for (const id of mine) assert.ok(prompt.includes(id), `${id} muss im Prompt von Batch ${index} stehen`);
    for (const id of notMine) assert.ok(!prompt.includes(id), `${id} gehört NICHT in Batch ${index}`);

    const untrusted = spec.untrustedData as { instrumentsToAnalyze: Array<{ instrumentId: string }> };
    assert.deepEqual(untrusted.instrumentsToAnalyze.map((c) => c.instrumentId), mine);

    const trusted = spec.trustedData as {
      lines: string[];
      snapshots: Array<{ instrumentId: string }>;
      indicators?: { readings: Array<{ instrumentId: string }> };
    };
    assert.equal(trusted.lines.length, 2, "nur zwei Konfluenz-Zeilen je Aufruf");
    assert.deepEqual(trusted.snapshots.map((s) => s.instrumentId), mine);
    if (trusted.indicators) {
      assert.deepEqual(
        trusted.indicators.readings.map((r) => r.instrumentId),
        mine,
        " Indikatorblock zeigt dem Modell nur die Kandidaten dieses Batches",
      );
    }
  });
});

test("unbrauchbarer Batch: neutral überdeckt und zählbar, die anderen bleiben erhalten", async () => {
  process.env.CYCLE_ANALYST_BATCH_SIZE = "2";
  const { ports, agent } = createPorts();
  agent.setResponseSequenceForRole("TECHNICAL_ANALYST", [
    answerFor([IDS[0], IDS[1]], 88),
    "Modell antwortet mit Prosa statt JSON",
  ]);

  const out = await technicalStep.execute(
    mockContext({ candidates: IDS.slice(0, 4).map((instrumentId) => ({ instrumentId })) }, ports),
  );

  assert.equal(out.analyses.length, 4, "kein Kandidat darf durch einen kaputten Batch verschwinden");
  assert.equal(out.analyses[0].technicalScore, 88, "Batch 1 bleibt Modellantwort");
  assert.equal(out.analyses[2].technicalScore, 50, "Batch 2 sitzt auf dem Neutral-Fallback");
  assert.match(out.analyses[2].thesis, /Deterministischer Fallback/);
  assert.ok(out.promptFit);
  assert.equal(out.promptFit.failedBatches, 1);
  assert.equal(out.promptFit.fallbackInstruments, 2);
});

test("Wurf in EINEM von mehreren Batches bricht den Lauf nicht — im Einzelfall doch", async () => {
  process.env.CYCLE_ANALYST_BATCH_SIZE = "2";
  const { ports, agent } = createPorts();
  agent.throwsOn.add(2);
  agent.setResponseSequenceForRole("TECHNICAL_ANALYST", [answerFor([IDS[0], IDS[1]], 91)]);

  const out = await technicalStep.execute(
    mockContext({ candidates: IDS.slice(0, 4).map((instrumentId) => ({ instrumentId })) }, ports),
  );
  assert.equal(out.analyses.length, 4);
  assert.equal(out.analyses[2].technicalScore, 50);
  assert.ok(out.promptFit && out.promptFit.failedBatches === 1);
  assert.ok(
    out.analyses[0].confluence,
    "Fallback-Analysen behalten ihre autoritativen Messwerte (Konfluenz)",
  );

  // Einzelbatch: identische Fehlersemantik wie vor der Änderung — der Wurf
  // geht nach oben, Retry-Policy/Cycle-Abbruch greifen wie bisher.
  const single = createPorts();
  single.agent.throwsOn.add(1);
  await assert.rejects(
    () =>
      technicalStep.execute(
        mockContext({ candidates: [{ instrumentId: IDS[0] }] }, single.ports),
      ),
    /Turn überschritten/,
  );
});

test("zu kleines Fenster: Redundanz raus UND Aufteilung, beides sichtbar", async () => {
  // 512 Tokens ≈ 1 843 Zeichen — selbst der Kompaktprompt von 4 Kandidaten
  // passt nicht hinein. Erwartet: Voll-Snapshots entfernt und mehrere Batches.
  process.env.CYCLE_PROMPT_INPUT_BUDGET_TOKENS = "512";
  const { ports, agent } = createPorts();
  agent.setResponseForRole("TECHNICAL_ANALYST", { analyses: [], analyzedCount: 0 });

  const out = await technicalStep.execute(
    mockContext({ candidates: IDS.slice(0, 4).map((instrumentId) => ({ instrumentId })) }, ports),
  );

  assert.ok(out.promptFit);
  assert.equal(out.promptFit.droppedFullSnapshots, true, "Zeilenform ersetzt die doppelten Voll-Snapshots");
  assert.equal(out.promptFit.constrainedBy, "input");
  assert.ok(out.promptFit.calls > 1, "nach dem Redundanz-Hebel wird zusätzlich geteilt");
  assert.equal(
    agent.specs.every((spec) => (spec.trustedData as { snapshots?: unknown[] }).snapshots === undefined),
    true,
    "kein einziger Prompt schickt die teure Doppelung",
  );
});

test("Prompt-Kürzung ändert die Sicherheitssemantik nicht: Code überschreibt RSI/ATR weiter", async () => {
  process.env.CYCLE_ANALYST_BATCH_SIZE = "2";
  const { ports, agent } = createPorts();
  agent.setResponseSequenceForRole("TECHNICAL_ANALYST", [
    { analyses: [{ instrumentId: IDS[0], bias: "BULLISH", technicalScore: 70, rsi: 12.3, atr: 999 }], analyzedCount: 1 },
    answerFor([IDS[1]]),
  ]);

  const out = await technicalStep.execute(
    mockContext({ candidates: IDS.slice(0, 2).map((instrumentId) => ({ instrumentId })) }, ports),
  );

  const first = out.analyses.find((a) => a.instrumentId === IDS[0]);
  assert.ok(first);
  // Der Store hat 30×1h-Bars mit konstanter Drift → gemessener RSI, nicht 12.3.
  assert.notEqual(first.rsi, 12.3, "erfundene Modell-RSI werden überschrieben");
  assert.equal(typeof first.rsi, "number");
});

test("validateTechnicalOutput lässt die Meta-Blöcke durch (Engine-Handoff, Artefakt)", () => {
  // Die Engine speichert das VALIDIERTE Output in `stepOutputs` — was die
  // Validierung schluckt, sieht weder der Research-Step noch das Artefakt.
  const validated = validateTechnicalOutput({
    analyses: [{ instrumentId: IDS[0], bias: "BULLISH", technicalScore: 60 }],
    analyzedCount: 1,
    confluenceMeta: {
      formulaVersion: "mtf-confluence@1",
      configVersion: 1,
      asOf: "2026-01-05T00:00:00.000Z",
      computed: 1,
      ok: 1,
      degraded: 0,
      abstained: 0,
    },
    promptFit: {
      inputTokens: 3328,
      inputChars: 11980,
      maxOutputTokens: 512,
      maxItemsPerBatch: 4,
      constrainedBy: "output",
      calls: 10,
      concurrency: 1,
      droppedFullSnapshots: true,
      failedBatches: 2,
      fallbackInstruments: 8,
      recommendedMaxOutputTokens: 4236,
      incomplete: false,
    },
  });

  assert.equal(validated.valid, true);
  assert.ok(validated.data?.confluenceMeta, "confluenceMeta überlebt die Validierung");
  assert.equal(validated.data?.promptFit?.calls, 10);
  assert.equal(validated.data?.promptFit?.droppedFullSnapshots, true);
});

test("eingeschleustes promptFit wird auf die Metrik reduziert (kein Freitext-Handoff)", () => {
  const validated = validateTechnicalOutput({
    analyses: [],
    analyzedCount: 0,
    promptFit: {
      constrainedBy: "MODEL_SAYS_TRADE",
      calls: -5,
      concurrency: 0,
      droppedFullSnapshots: "ja",
      recommendedMaxOutputTokens: Number.NaN,
      injected: { apiKey: "s-KrYtO" },
    },
  });
  assert.equal(validated.valid, true);
  const fit = validated.data?.promptFit;
  assert.ok(fit);
  assert.equal(fit.constrainedBy, "unbounded", "unbekanntes Label ⇒ harmloser Wert");
  assert.equal(fit.calls, 0, "negative Zähler ⇒ 0");
  assert.equal(fit.concurrency, 1, "Nebenläufigkeit nie < 1");
  assert.equal(fit.droppedFullSnapshots, false, "nur echtes true zählt");
  assert.equal(fit.recommendedMaxOutputTokens, 0, "NaN wird nicht durchgereicht");
  assert.equal((fit as unknown as Record<string, unknown>).injected, undefined, "unbekannte Keys bleiben draußen");
});
