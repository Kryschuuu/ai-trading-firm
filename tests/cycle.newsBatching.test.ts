/**
 * Batch-Aufteilung des News Analysten (CYCLE-BATCH-01).
 *
 * Der Schritt ist der heikelste Kandidat für Prompt-Überlauf: sein Input ist
 * fremder Text (Headlines), nicht kompakte Messwerte. Geprüft wird, dass die
 * Aufteilung die Sicherheits_Hülle_ unverändert lässt, jede Ganzmeldung in
 * jedem Batch landet und das systemische Risiko nach Schwere gemerged wird.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedClock } from "../src/cycle/clock";
import {
  FakeAnalysisAgentPort,
  MemoryCycleAuditPort,
  StubAnalyticsPort,
  StubScannerPort,
} from "../src/cycle/ports";
import type { AgentInvocationSpec } from "../src/cycle/types";
import { newsStep } from "../src/cycle/steps/newsStep";
import type { StepExecutionContext } from "../src/cycle/types";

const SYMS = ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT", "BINANCE:XRPUSDT"];
const ENV_KEYS = ["CYCLE_ANALYST_BATCH_SIZE", "CYCLE_ANALYST_CONCURRENCY", "CYCLE_PROMPT_INPUT_BUDGET_TOKENS"];

class RecordingAgentPort extends FakeAnalysisAgentPort {
  readonly specs: AgentInvocationSpec<unknown>[] = [];
  override async invokeAgent<T>(spec: AgentInvocationSpec<T>) {
    this.specs.push(spec as AgentInvocationSpec<unknown>);
    return super.invokeAgent(spec);
  }
}

function createPorts() {
  const agent = new RecordingAgentPort();
  return {
    agent,
    ports: {
      scanner: new StubScannerPort(),
      analytics: new StubAnalyticsPort(),
      agent,
      audit: new MemoryCycleAuditPort(),
    } as never,
  };
}

function context(ports: unknown, input: unknown): StepExecutionContext<never> {
  const clock = new SimulatedClock(new Date(Date.UTC(2026, 0, 5, 9)));
  return {
    cycleId: "test-news-batch",
    date: "2026-01-05",
    asOf: clock.now(),
    clock,
    input: input as never,
    previousStepOutputs: {},
    ports: ports as never,
    emitEscalation: () => {},
    log: () => {},
  };
}

function withEnv<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  return run().finally(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const newsFor = (symbol: string, index: number) => ({
  headline: `Headline Nummer ${index} für ${symbol} mit ausreichend Text, damit die Prompt-Grösse realistisch wächst`,
  source: "TestFeed",
  symbol,
  publishedAt: "2026-01-05T08:00:00.000Z",
});

const systemic = {
  headline: "Zinsentscheid überrascht den Markt — Risikoaversion in allen Klassen",
  source: "Wire",
  publishedAt: "2026-01-05T08:00:00.000Z",
};

function answer(level: "LOW" | "HIGH" | "CRITICAL", instrumentIds: readonly string[]) {
  return {
    analyses: instrumentIds.map((instrumentId) => ({
      instrumentId,
      sentiment: "BEARISH",
      direction: "BEARISH",
      confidence: 0.7,
      impactScore: 30,
      riskFlags: ["VOLATILITY"],
      summary: `Nachrichtenlast für ${instrumentId}`,
    })),
    systemicRisk: { level, headline: `Systemisch ${level}`, affectedSectors: ["all"] },
  };
}

test("News: zu grosses Budget teilt, jeder Batch sieht nur seine Instrumente", async () => {
  await withEnv({ CYCLE_ANALYST_BATCH_SIZE: "2" }, async () => {
    const { ports, agent } = createPorts();
    agent.setResponseSequenceForRole("NEWS_ANALYST", [
      answer("LOW", SYMS.slice(0, 2)),
      answer("LOW", SYMS.slice(2, 4)),
    ]);

    const out = await newsStep.execute(
      context(ports, { symbols: SYMS, externalNews: [...SYMS.map(newsFor), systemic] }),
    );

    assert.equal(agent.specs.length, 2, "zwei Batches = zwei Aufrufe");
    assert.ok(out.promptFit);
    assert.equal(out.promptFit.calls, 2);
    assert.equal(out.promptFit.failedBatches, 0);
    assert.equal(out.promptFit.incomplete, false);
    assert.equal(out.promptFit.systemicHeadlines, 1);

    const seenPerBatch = agent.specs.map((spec) => {
      const payload = spec.untrustedData as {
        monitoredSymbols: string[];
        externalHeadlines: Array<{ symbol?: string }>;
      };
      return {
        symbols: payload.monitoredSymbols,
        own: payload.externalHeadlines.filter((h) => h.symbol).map((h) => String(h.symbol)),
        all: payload.externalHeadlines,
      };
    });
    assert.deepEqual(seenPerBatch.map((b) => b.symbols), [SYMS.slice(0, 2), SYMS.slice(2, 4)]);
    assert.deepEqual(seenPerBatch.map((b) => b.own), [SYMS.slice(0, 2), SYMS.slice(2, 4)]);
    for (const batch of seenPerBatch) {
      assert.ok(
        batch.all.some((h) => !h.symbol),
        "die Ganzmeldung muss in JEDEM Batch stehen — sonst übersieht ein Batch die Krise",
      );
      // Injection-Hülle unverändert: externe Daten NUR im untrustedData-Block.
      assert.ok(
        !headlineLeaksIntoInstructions(specOf(agent, batch)),
        "Headline-Text darf nie im Instruktionstext stehen (nur untrustedData)",
      );
    }
  });
});

/** Injection-Schutz: Fremder Text lebt ausschliesslich im untrustedData-Block. */
function headlineLeaksIntoInstructions(spec: AgentInvocationSpec<unknown>): boolean {
  const payload = spec.untrustedData as { externalHeadlines: Array<{ headline: string }> };
  return payload.externalHeadlines.some((h) => spec.userPrompt.includes(h.headline.slice(0, 24)));
}

function specOf(agent: RecordingAgentPort, batch: { symbols: string[] }): AgentInvocationSpec<unknown> {
  return agent.specs.find((spec) => {
    const payload = spec.untrustedData as { monitoredSymbols: string[] };
    return payload.monitoredSymbols.join(",") === batch.symbols.join(",");
  })!;
}

test("News: systemisches Risiko wird nach Schwere gemerged, nicht nach Mehrheit", async () => {
  await withEnv({ CYCLE_ANALYST_BATCH_SIZE: "2" }, async () => {
    const { ports, agent } = createPorts();
    agent.setResponseSequenceForRole("NEWS_ANALYST", [
      answer("LOW", SYMS.slice(0, 2)),
      answer("CRITICAL", SYMS.slice(2, 4)),
    ]);

    const out = await newsStep.execute(
      context(ports, { symbols: SYMS, externalNews: SYMS.map(newsFor) }),
    );

    assert.equal(out.systemicRisk.level, "CRITICAL", "ein CRITICAL unter drei LOW ist CRITICAL");
    assert.equal(out.promptFit?.systemicRiskSource, "model");
  });
});

test("News: kaputter Batch wird ABSTAIN-fallback und ist zählbar", async () => {
  await withEnv({ CYCLE_ANALYST_BATCH_SIZE: "2" }, async () => {
    const { ports, agent } = createPorts();
    agent.setResponseSequenceForRole("NEWS_ANALYST", [answer("HIGH", SYMS.slice(0, 2)), "Prosa statt JSON"]);

    const out = await newsStep.execute(
      context(ports, { symbols: SYMS, externalNews: SYMS.map(newsFor) }),
    );

    assert.ok(out.promptFit);
    assert.equal(out.promptFit.failedBatches, 1);
    assert.equal(out.promptFit.fallbackInstruments, 2);
    // Der kaputte Batch darf seine Kandidaten nicht verschwinden lassen: ihr
    // Fallback-Eintrag muss da sein (ABSTAIN), sonst fehlt im Artefakt jede
    // Spur davon und „nicht bewertet" liest sich wie „nicht vorhanden".
    const ids = out.analyses.map((a) => a.instrumentId).sort();
    assert.deepEqual(ids, [...SYMS].sort(), "alle vier Instrumente bleiben im Output");
    assert.equal(out.promptFit.incomplete, false);
    // Das Modell hat HIGH geliefert, der andere Batch fiel zurück → Risiko bleibt sichtbar.
    assert.equal(out.systemicRisk.level, "HIGH");
  });
});

test("News: kleines Set bleibt ein Aufruf (kein Overhead durch die Planung)", async () => {
  await withEnv({ CYCLE_PROMPT_INPUT_BUDGET_TOKENS: "100000" }, async () => {
    const { ports, agent } = createPorts();
    agent.setResponseForRole("NEWS_ANALYST", answer("LOW", [SYMS[0]]));

    const out = await newsStep.execute(
      context(ports, { symbols: [SYMS[0]], externalNews: [newsFor(SYMS[0], 0)] }),
    );

    assert.equal(agent.specs.length, 1);
    assert.equal(out.promptFit?.calls, 1);
    assert.equal(out.promptFit?.constrainedBy, "unbounded", "Budget aus Env ⇒ keine künstliche Begrenzung");
  });
});
