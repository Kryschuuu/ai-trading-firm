/**
 * Integration des Model Routers (Task 09).
 *
 * 1. Golden-Flow über den Agenten-Port (src/cycle/ports.ts):
 *      Research/small + Confidence 0.58 + HIGH ⇒ MODEL_ESCALATION_REQUEST
 *      ⇒ Router ⇒ approved ⇒ großes Modell ⇒ Confidence 0.87 (Test-Kontext)
 * 2. Gegenfall: denied ⇒ kein Modellwechsel, Agent läuft mit aktuellem Modell.
 * 3. Audit-Vollständigkeit: 100 % der Wechsel haben einen Audit-Eintrag.
 * 4. Der Agent bestimmt sein Modell NICHT selbst (MODEL_*-Env wird ignoriert).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DefaultAnalysisAgentPort, ROLE_TASK_MAP, roleToRoutingTask } from "../src/cycle/ports";
import { resetModelRouterForTests } from "../src/routing";
import { createTestRouter, ctx } from "./fixtures/routingTestUtil";
import type { AgentInvocationSpec } from "../src/cycle/types";
import type { LlmChatRequest, LlmChatResult } from "../src/lib/llmProvider";
import type { RoutingAuditEntry } from "../src/routing/types";

after(() => {
  resetModelRouterForTests();
});

const SMALL_MODEL = "qwen2.5:3b-instruct-q4_K_M";
/** Task "research" liegt in MODEL_B ⇒ Startmodell der Research-Testfälle. */
const MEDIUM_MODEL = "qwen2.5:7b-instruct-q4_K_M";
const LARGE_MODEL = "qwen2.5:14b-instruct-q4_K_M";

/** Fake-Provider: antwortet je Modell mit definierter Confidence. */
function fakeChat(confidenceByModel: Record<string, number>): typeof import("../src/lib/llmProvider").chatLlm {
  const calls: LlmChatRequest[] = [];
  const fn = async (req: LlmChatRequest): Promise<LlmChatResult> => {
    calls.push(req);
    const confidence = confidenceByModel[req.model] ?? 0.5;
    return {
      content: JSON.stringify({ view: "BULLISH", confidence, thesis: `Antwort von ${req.model}` }),
      provider: "ollama",
      model: req.model,
      usage: { totalTokens: 512 },
      latencyMs: 120,
      attempt: 1,
    };
  };
  return Object.assign(fn, { calls }) as never;
}

function spec<T>(overrides: Partial<AgentInvocationSpec<T>> = {}): AgentInvocationSpec<T> {
  return {
    role: "RESEARCH",
    systemPrompt: "You are the research analyst.",
    userPrompt: "Analyze BTC.",
    schemaValidator: (data: unknown) => ({ valid: true, data: data as T }),
    fallback: { view: "NEUTRAL", confidence: 0.5 } as unknown as T,
    ...overrides,
  } as AgentInvocationSpec<T>;
}

test("Rollen-Tasks: Zuordnung ist vollständig und whitelist-basiert", () => {
  for (const [role, task] of Object.entries(ROLE_TASK_MAP)) {
    assert.equal(roleToRoutingTask(role), task);
    assert.equal(roleToRoutingTask(role.toLowerCase()), task);
  }
  assert.equal(roleToRoutingTask("UNBEKANNTE_ROLLE"), "default");
});

test("Integration GOLDEN: Port eskaliert (0.58/HIGH) → Router approved → großes Modell → 0.87", async () => {
  const { router, audit, registry } = createTestRouter({
    // Research startet klein (Test-Aufstellung) und darf lokal groß werden.
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false } },
  });
  registry.override("ollama", { defaultModel: SMALL_MODEL });

  const chat = fakeChat({ [MEDIUM_MODEL]: 0.58, [LARGE_MODEL]: 0.87 });
  const port = new DefaultAnalysisAgentPort({ router, chatFn: chat });

  const result = await port.invokeAgent<{ view: string; confidence: number }>(
    spec({
      role: "RESEARCH",
      complexity: "low",
      escalationCheck: (_raw, parsed) => {
        const data = (parsed ?? {}) as { confidence?: number };
        if (Number(data.confidence) < 0.7) {
          return {
            agent: "RESEARCH",
            reason: "Für diese Aufgabe reicht Modell A nicht.",
            complexity: "high",
            confidence: Number(data.confidence),
            requestedClass: "MODEL_C",
          };
        }
        return null;
      },
    })
  );

  // 1. Erstaufruf auf dem kleinen/mittleren lokalen Modell (Confidence 0.58)
  const calls = (chat as unknown as { calls: LlmChatRequest[] }).calls;
  assert.equal(calls[0].model, MEDIUM_MODEL);

  // 2. Eskalation genehmigt ⇒ zweiter Aufruf mit dem großen Modell
  assert.equal(calls.length, 2, "ein Erstaufruf + ein eskalierter Aufruf");
  assert.notEqual(calls[0].model, calls[1].model);
  assert.equal(calls[1].model, LARGE_MODEL);

  // 3. Ergebnis kommt vom großen Modell (Confidence 0.87)
  assert.equal(result.output.confidence, 0.87);
  assert.equal(result.modelUsed, LARGE_MODEL);
  assert.equal(result.usedFallback, false);
  assert.equal(result.routing?.escalationApproved, true);
  assert.equal(result.routing?.escalationTrigger, "APPROVED");

  // 4. Audit: genau ein approved-Eintrag mit vollständigem Wechsel
  const approvals = audit.entries.filter((e) => e.outcome === "approved");
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].agent, "RESEARCH");
  assert.match(approvals[0].from, /^MODEL_B:/);
  assert.match(approvals[0].to, /^MODEL_C:/);
  assert.equal(approvals[0].detail?.confidence, 0.58);
  assert.equal(approvals[0].detail?.agentReason, "Für diese Aufgabe reicht Modell A nicht.");
  assert.equal(approvals[0].policyVersion, router.policy.version);
});

test("Integration: denied-Eskalation ⇒ kein zweiter Aufruf, Agent läuft weiter (Audit vorhanden)", async () => {
  const { router, audit, registry } = createTestRouter({
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false } },
  });
  registry.override("ollama", { defaultModel: SMALL_MODEL });

  const chat = fakeChat({ [MEDIUM_MODEL]: 0.95 });
  const port = new DefaultAnalysisAgentPort({ router, chatFn: chat });

  const result = await port.invokeAgent<{ view: string; confidence: number }>(
    spec({
      role: "RESEARCH",
      complexity: "low",
      escalationCheck: (_raw, parsed) => {
        const data = (parsed ?? {}) as { confidence?: number };
        return {
          agent: "RESEARCH",
          reason: "unsicher",
          complexity: "low",
          confidence: Number(data.confidence),
          requestedClass: "MODEL_C",
        };
      },
    })
  );

  const calls = (chat as unknown as { calls: LlmChatRequest[] }).calls;
  assert.equal(calls.length, 1, "abgelehnt ⇒ kein Modellwechsel ⇒ kein zweiter Aufruf");
  assert.equal(calls[0].model, MEDIUM_MODEL);
  assert.equal(result.modelUsed, MEDIUM_MODEL);
  assert.equal(result.output.confidence, 0.95);
  assert.equal(result.routing?.escalationApproved, undefined);

  const denied = audit.entries.filter((e) => e.outcome === "denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].trigger, "COMPLEXITY_BELOW_THRESHOLD");
  assert.equal(denied[0].from, denied[0].to);
});

test("Integration: der Agent bestimmt sein Modell NICHT selbst (MODEL_*-Env wird ignoriert)", async () => {
  const previous = process.env.MODEL_RESEARCH;
  process.env.MODEL_RESEARCH = "evil-self-selected-model";
  try {
    const { router, registry } = createTestRouter({
      agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false } },
    });
    registry.override("ollama", { defaultModel: SMALL_MODEL });
    const chat = fakeChat({ [MEDIUM_MODEL]: 0.9 });
    const port = new DefaultAnalysisAgentPort({ router, chatFn: chat });
    await port.invokeAgent(spec({ role: "RESEARCH", complexity: "low" }));

    const calls = (chat as unknown as { calls: LlmChatRequest[] }).calls;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, MEDIUM_MODEL, "Modell kommt aus der Router-Entscheidung");
    assert.notEqual(calls[0].model, "evil-self-selected-model");
  } finally {
    if (previous === undefined) delete process.env.MODEL_RESEARCH;
    else process.env.MODEL_RESEARCH = previous;
  }
});

test("Audit-Vollständigkeit: 100 % der Modell-Wechsel haben einen Audit-Eintrag", () => {
  const { router, registry, audit } = createTestRouter({
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: true } },
  });
  registry.override("ollama", { defaultModel: SMALL_MODEL });

  const scenarios: Array<{ label: string; apply: () => void; context: Record<string, unknown> }> = [
    {
      label: "initial",
      apply: () => {},
      context: ctx({ agent: "RESEARCH", complexity: "low" }),
    },
    {
      label: "komplexer",
      apply: () => {},
      context: ctx({ agent: "RESEARCH", complexity: "high" }),
    },
    {
      label: "ollama offline ⇒ gemini",
      apply: () => registry.setHealth("ollama", "offline"),
      context: ctx({ agent: "RESEARCH", complexity: "high" }),
    },
    {
      label: "gemini quota ⇒ anthropic",
      apply: () => registry.setQuota("gemini", 1),
      context: ctx({ agent: "RESEARCH", complexity: "high" }),
    },
    {
      label: "anthropic offline ⇒ ollama wieder online",
      apply: () => {
        registry.setHealth("anthropic", "offline");
        registry.setHealth("ollama", "online");
      },
      context: ctx({ agent: "RESEARCH", complexity: "high" }),
    },
    {
      label: "alles offline ⇒ Regel-Engine",
      apply: () => registry.setHealth("ollama", "offline"),
      context: ctx({ agent: "RESEARCH", complexity: "high" }),
    },
  ];

  let previous = router.lastDecisionFor("RESEARCH");
  let changes = 0;

  for (const scenario of scenarios) {
    scenario.apply();
    const before = audit.entries.length;
    const decision = router.resolve(scenario.context);
    const signature = `${decision.modelClass}:${decision.provider}:${decision.model}`;
    const previousSignature = previous
      ? `${previous.modelClass}:${previous.provider}:${previous.model}`
      : "none";
    const changed = signature !== previousSignature;

    if (changed) {
      changes += 1;
      const fresh = audit.entries.slice(before) as RoutingAuditEntry[];
      assert.equal(
        fresh.length >= 1,
        true,
        `Wechsel ohne Audit-Eintrag: ${scenario.label} (${previousSignature} → ${signature})`
      );
      const match = fresh.find((e) => e.to === signature);
      assert.ok(match, `Audit-Eintrag mit Ziel ${signature} fehlt (${scenario.label})`);
      assert.equal(match.agent, "RESEARCH");
      assert.equal(match.policyVersion, router.policy.version);
      assert.ok(match.reason.length > 0);
      assert.ok(match.trigger.length > 0);
      assert.ok(["resolved", "approved", "denied", "fallback", "budget_blocked"].includes(match.outcome));
    }
    previous = decision;
  }

  assert.ok(changes >= 4, `mindestens vier Wechsel erwartet, erhalten: ${changes}`);

  // Kein Wechsel ⇒ kein zusätzlicher Eintrag (Audit ist kein Spam-Kanal)
  const stableBefore = audit.entries.length;
  router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(audit.entries.length, stableBefore);

  // Vollständigkeit: jeder Eintrag trägt die Pflichtfelder
  for (const entry of audit.entries) {
    assert.ok(entry.ts.length > 0);
    assert.ok(entry.agent.length > 0);
    assert.ok(entry.from.length > 0);
    assert.ok(entry.to.length > 0);
    assert.ok(entry.reason.length > 0);
    assert.ok(entry.trigger.length > 0);
    assert.ok(entry.policyVersion.length > 0);
  }
});

test("Audit: Fallback- und Budget-Ereignisse sind immer auditiert (auch ohne Klassenwechsel)", () => {
  const { router, registry, audit } = createTestRouter({
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true } },
  });
  // Erstaufruf lokal groß
  router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  const before = audit.entries.length;

  // Ollama fällt aus, Gemini übernimmt (Klasse bleibt C) ⇒ trotzdem Audit
  registry.setHealth("ollama", "offline");
  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.provider, "gemini");
  assert.equal(decision.modelClass, "MODEL_C");

  const fresh = audit.entries.slice(before);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].outcome, "fallback");
  assert.equal(fresh[0].to, "MODEL_C:gemini:gemini-2.0-flash");
});

test("Integration: Port liefert Routing-Trace in agent_messages-Meta", async () => {
  const { router, registry } = createTestRouter({
    agents: { NEWS_ANALYST: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false } },
  });
  registry.override("ollama", { defaultModel: SMALL_MODEL });
  const chat = fakeChat({ [SMALL_MODEL]: 0.8 });
  const port = new DefaultAnalysisAgentPort({ router, chatFn: chat });

  const result = await port.invokeAgent(spec({ role: "NEWS_ANALYST", complexity: "low" }));
  const routing = result.routing as Record<string, Record<string, unknown>>;
  assert.equal(routing.routing.agent, "NEWS_ANALYST");
  assert.equal(routing.routing.task, "news_categorization");
  assert.equal(routing.routing.modelClass, "MODEL_A");
  assert.equal(routing.routing.mode, "automatic");
  assert.equal(routing.provider, "ollama");
  assert.equal(routing.model, SMALL_MODEL);
  assert.equal(routing.usedFallback, false);
});
