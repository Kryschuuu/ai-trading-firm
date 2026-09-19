/**
 * Turn-Budget-Hartdeckel (GAP-08, D3).
 *
 *   - Token-/Zeit-Bruch mit Fake-Provider → sauberer Abbruch mit
 *     strukturiertem Fehler + Audit (`llm-budget:tokens`/`llm-budget:time`).
 *   - Keine Teil-Results als Erfolg: Der Fehler propagiert (nie Fallback).
 *   - Konfiguration: Bounds + Defaults.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestRouter } from "./fixtures/routingTestUtil";
import {
  TurnBudget,
  TurnBudgetExceededError,
  createTurnBudget,
  loadTurnBudgetConfig,
  routeChat,
  turnBudgetAuditLabel,
} from "../src/routing";
import { DefaultAnalysisAgentPort } from "../src/cycle/ports";
import { validateResearchOutput } from "../src/cycle/schemas";

const RESEARCH_FALLBACK = {
  setups: [],
  totalSetups: 0,
  disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED" as const,
};

/** Stub-Provider mit steuerbarem Verbrauch (Fake-Provider). */
function stubChat(content: string, totalTokens: number) {
  return (async () => ({
    content,
    provider: "ollama",
    model: "stub-model",
    usage: { promptTokens: 10, completionTokens: totalTokens - 10, totalTokens },
    latencyMs: 5,
    attempt: 1,
  })) as never;
}

const VALID_RESEARCH_JSON = JSON.stringify({
  setups: [
    {
      instrumentId: "BINANCE:BTCUSDT",
      side: "LONG",
      entryPrice: 65400,
      stopLoss: 64000,
      takeProfit: 68500,
      riskScore: 0.4,
      timeframe: "4h",
      thesis: "Long-Fortsetzung am aufsteigenden Trendkanal mit klarem Stop unter dem letzten Tief.",
      isProposal: true,
    },
  ],
  totalSetups: 1,
  disclaimer: "PROPOSAL_ONLY_NO_ORDERS_PLACED",
});

// ─────────────────────────────────────────────────────────────────────────────
// Einheit: TurnBudget
// ─────────────────────────────────────────────────────────────────────────────

test("TurnBudget: Verbrauch im Limit ist OK, exakt am Limit noch kein Bruch", () => {
  const turn = new TurnBudget({ maxTokensPerTurn: 1000, maxTurnMs: 60_000 }, () => 0);
  turn.consume(600);
  turn.consume(400);
  assert.equal(turn.tokensUsed, 1000);
  turn.checkTime();
});

test("TurnBudget: Token-Bruch wirft strukturierten Fehler (tokens/max lesbar)", () => {
  const turn = new TurnBudget({ maxTokensPerTurn: 1000, maxTurnMs: 60_000 }, () => 0);
  assert.throws(() => turn.consume(1001), (e: unknown) => {
    assert.ok(e instanceof TurnBudgetExceededError);
    assert.equal(e.code, "LLM_TURN_BUDGET_EXCEEDED");
    assert.equal(e.reason, "tokens");
    assert.equal(e.tokensUsed, 1001);
    assert.equal(e.tokensMax, 1000);
    assert.match(e.message, /Turn-Budget überschritten/);
    return true;
  });
  assert.equal(turnBudgetAuditLabel("tokens"), "llm-budget:tokens");
  assert.equal(turnBudgetAuditLabel("time"), "llm-budget:time");
});

test("TurnBudget: Zeit-Bruch über injizierte Uhr (deterministisch)", () => {
  let now = 1_000_000;
  const turn = new TurnBudget({ maxTokensPerTurn: 20000, maxTurnMs: 5000 }, () => now);
  turn.checkTime();
  now += 5001;
  assert.throws(() => turn.checkTime(), (e: unknown) => {
    assert.ok(e instanceof TurnBudgetExceededError);
    assert.equal(e.reason, "time");
    assert.equal(e.elapsedMs, 5001);
    assert.equal(e.maxMs, 5000);
    return true;
  });
});

test("TurnBudget: ungültiger Verbrauch wird ignoriert (nie Negativbuchung)", () => {
  const turn = new TurnBudget({ maxTokensPerTurn: 1000, maxTurnMs: 60_000 }, () => 0);
  turn.consume(NaN);
  turn.consume(-50);
  turn.consume(0);
  assert.equal(turn.tokensUsed, 0);
});

test("TurnBudget: Konfiguration mit Bounds + Defaults", () => {
  assert.deepEqual(loadTurnBudgetConfig({}), { maxTokensPerTurn: 20000, maxTurnMs: 120000 });
  assert.deepEqual(loadTurnBudgetConfig({ LLM_MAX_TOKENS_PER_TURN: "50", LLM_MAX_TURN_MS: "5" }), {
    maxTokensPerTurn: 1000,
    maxTurnMs: 10000,
  });
  assert.deepEqual(
    loadTurnBudgetConfig({ LLM_MAX_TOKENS_PER_TURN: "999999999", LLM_MAX_TURN_MS: "999999999" }),
    { maxTokensPerTurn: 200000, maxTurnMs: 900000 },
  );
  assert.deepEqual(
    loadTurnBudgetConfig({ LLM_MAX_TOKENS_PER_TURN: "kaputt", LLM_MAX_TURN_MS: "" }),
    { maxTokensPerTurn: 20000, maxTurnMs: 120000 },
  );
  const fromEnv = createTurnBudget({ env: { LLM_MAX_TOKENS_PER_TURN: "5000" } });
  assert.equal(fromEnv.config.maxTokensPerTurn, 5000);
  assert.equal(fromEnv.config.maxTurnMs, 120000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: routeChat mit Turn
// ─────────────────────────────────────────────────────────────────────────────

test("TurnBudget: Token-Bruch im routeChat → Abbruch + Audit llm-budget:tokens", async () => {
  const { router, audit } = createTestRouter();
  const turn = new TurnBudget({ maxTokensPerTurn: 1000, maxTurnMs: 600_000 });
  await assert.rejects(
    routeChat(
      {
        agent: "RESEARCH",
        task: "research",
        complexity: "medium",
        messages: [{ role: "user", content: "test" }],
        json: true,
      },
      { router, chatFn: stubChat(VALID_RESEARCH_JSON, 5000), turn },
    ),
    (e: unknown) => {
      assert.ok(e instanceof TurnBudgetExceededError);
      assert.equal(e.reason, "tokens");
      return true;
    },
  );
  const entry = audit.entries.at(-1);
  assert.equal(entry?.trigger, "BUDGET_EXCEEDED");
  assert.equal(entry?.outcome, "budget_blocked");
  assert.match(entry?.reason ?? "", /^llm-budget:tokens/);
});

test("TurnBudget: Zeit-Bruch im routeChat → Abbruch VOR dem Provider-Aufruf", async () => {
  const { router, audit } = createTestRouter();
  let now = 1_000_000;
  const turn = new TurnBudget({ maxTokensPerTurn: 20000, maxTurnMs: 1000 }, () => now);
  now += 5000; // Turn läuft bereits über dem Zeitdeckel
  let providerCalls = 0;
  await assert.rejects(
    routeChat(
      {
        agent: "RESEARCH",
        messages: [{ role: "user", content: "test" }],
      },
      {
        router,
        chatFn: ((async () => {
          providerCalls += 1;
          return {
            content: "{}",
            provider: "ollama",
            model: "stub",
            usage: {},
            latencyMs: 1,
            attempt: 1,
          };
        }) as never),
        turn,
      },
    ),
    (e: unknown) => e instanceof TurnBudgetExceededError && e.reason === "time",
  );
  assert.equal(providerCalls, 0);
  assert.match(audit.entries.at(-1)?.reason ?? "", /^llm-budget:time/);
});

test("TurnBudget: Verbrauch im Limit → normaler Erfolg ohne Budget-Audit", async () => {
  const { router, audit } = createTestRouter();
  const before = audit.entries.length;
  const turn = new TurnBudget({ maxTokensPerTurn: 20000, maxTurnMs: 600_000 });
  const result = await routeChat(
    {
      agent: "RESEARCH",
      messages: [{ role: "user", content: "test" }],
      json: true,
    },
    { router, chatFn: stubChat(VALID_RESEARCH_JSON, 500), turn },
  );
  assert.equal(result.usedFallback, false);
  assert.equal(turn.tokensUsed, 500);
  assert.ok(
    audit.entries.slice(before).every((e) => !e.reason.startsWith("llm-budget:")),
    "kein Turn-Budget-Audit im grünen Pfad",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Port-Ebene: kein stiller Fallback bei Turn-Bruch
// ─────────────────────────────────────────────────────────────────────────────

test("TurnBudget: Agenten-Port wandelt Turn-Bruch NIE in Fallback um", async () => {
  const { router } = createTestRouter();
  const prev = process.env.LLM_MAX_TOKENS_PER_TURN;
  process.env.LLM_MAX_TOKENS_PER_TURN = "1000"; // Untergrenze → Stub sprengt den Turn
  try {
    const port = new DefaultAnalysisAgentPort({
      router,
      chatFn: stubChat(VALID_RESEARCH_JSON, 5000),
    });
    await assert.rejects(
      port.invokeAgent({
        role: "RESEARCH",
        systemPrompt: "test",
        userPrompt: "test",
        schemaValidator: validateResearchOutput,
        fallback: RESEARCH_FALLBACK,
      }),
      (e: unknown) => {
        assert.ok(e instanceof TurnBudgetExceededError);
        assert.equal(e.reason, "tokens");
        return true;
      },
    );
  } finally {
    if (prev === undefined) delete process.env.LLM_MAX_TOKENS_PER_TURN;
    else process.env.LLM_MAX_TOKENS_PER_TURN = prev;
  }
});
