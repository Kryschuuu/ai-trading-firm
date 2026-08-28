/**
 * Budget-Deckel (Task 09, Regel 3).
 *
 * - Token-/Kosten-Deckel je Provider, Agent und Tag werden im Router erzwungen.
 * - Überschreitung ⇒ Zwangs-Fallback auf ein lokales Modell + Audit-Eintrag.
 * - Der Deckel gilt AUCH im manual-Modus (Ausnahme: explizite Admin-Freigabe
 *   `budgetExempt`, die wiederum auditiert wird).
 * - Cloud-Nutzung ist IMMER gedeckelt, niemals unbegrenzt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestRouter, ctx } from "./fixtures/routingTestUtil";
import { BudgetTracker, dayKey } from "../src/routing";
import { validateRoutingPolicy, DEFAULT_ROUTING_POLICY } from "../src/routing/policy";
import type { RoutingPolicy } from "../src/routing/policy";

/** Kleine Deckel, damit die Tests ohne Millionen Tokens auskommen. */
function tightBudgetPolicy(): Partial<RoutingPolicy> {
  return {
    budgets: {
      providers: {
        ollama: { tokensPerDay: 100_000, costUsdPerDay: 0 },
        openai: { tokensPerDay: 10_000, costUsdPerDay: 1 },
        gemini: { tokensPerDay: 1_000, costUsdPerDay: 0.5 },
        anthropic: { tokensPerDay: 1_000, costUsdPerDay: 0.5 },
      },
      agents: { RESEARCH: { tokensPerDay: 2_000 } },
      global: { tokensPerDay: 200_000, costUsdPerDay: 5 },
    },
  };
}

test("Budget: erschöpfter Cloud-Deckel ⇒ Zwangs-Rückstufung auf lokal + Audit", () => {
  const { router, audit } = createTestRouter({
    policy: tightBudgetPolicy(),
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true } },
  });

  const before = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(before.provider, "ollama", "Ollama ist erster Provider der großen Klasse");

  // Cloud-Deckel leeren (ohne Agenten-Buchung — der Agenten-Deckel bleibt frei)
  router.budget.consume({ provider: "gemini", tokens: 1_000 });
  router.budget.consume({ provider: "anthropic", tokens: 1_000 });
  assert.equal(router.budget.isExhausted("gemini"), true);
  assert.equal(router.budget.isExhausted("anthropic"), true);

  const after = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(after.provider, "ollama");
  assert.equal(after.modelClass, "MODEL_C");
});

test("Budget: komplett erschöpfte Provider ⇒ Rückstufung auf lokales Modell (Budget-Block auditiert)", () => {
  const { router, audit } = createTestRouter({
    policy: tightBudgetPolicy(),
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true } },
  });

  for (const provider of ["ollama", "openai", "gemini", "anthropic"] as const) {
    router.budget.consume({ provider, agent: "RESEARCH", tokens: 500_000 });
  }

  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.decision, "FALLBACK");
  assert.equal(decision.budgetBlocked, true);
  assert.equal(decision.provider, "none");

  const entry = audit.entries.at(-1);
  assert.equal(entry?.outcome, "budget_blocked");
  assert.match(entry?.reason ?? "", /Zwangs-Rückstufung|Kein nutzbarer Provider/);
  assert.match(entry?.reason ?? "", /Deckel/);
});

test("Budget: Agenten-Deckel greift providerunabhängig", () => {
  const { router, audit } = createTestRouter({
    policy: tightBudgetPolicy(),
    agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true } },
  });
  router.budget.consume({ provider: "ollama", agent: "RESEARCH", tokens: 2_000 });
  assert.equal(router.budget.agentExhausted("RESEARCH"), true);

  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.budgetBlocked, true, "Agenten-Deckel erzwingt Rückstufung");
  assert.equal(audit.entries.at(-1)?.outcome, "budget_blocked");

  // Anderer Agent ist nicht betroffen
  const other = router.resolve(ctx({ agent: "NEWS_ANALYST", complexity: "low" }));
  assert.equal(other.budgetBlocked, false);
  assert.equal(other.provider, "ollama");
});

test("Budget: Deckel gilt auch im manual-Modus", () => {
  const { router, audit } = createTestRouter({
    policy: tightBudgetPolicy(),
    agents: { RESEARCH: { mode: "manual", pinnedModel: "qwen2.5:14b-instruct-q4_K_M", defaultClass: "MODEL_C", allowCloud: true } },
  });

  for (const provider of ["ollama", "openai", "gemini", "anthropic"] as const) {
    router.budget.consume({ provider, agent: "RESEARCH", tokens: 500_000 });
  }

  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "low" }));
  assert.equal(decision.mode, "manual");
  assert.equal(decision.budgetBlocked, true);
  assert.notEqual(decision.model, "qwen2.5:14b-instruct-q4_K_M", "Pinned Model wird bei Deckel nicht bedient");
  assert.equal(audit.entries.at(-1)?.outcome, "budget_blocked");
});

test("Budget: Admin-Freigabe (budgetExempt) hebt den Deckel auf — und wird dokumentiert", () => {
  const { router } = createTestRouter({
    policy: tightBudgetPolicy(),
    agents: {
      RESEARCH: {
        mode: "manual",
        pinnedModel: "qwen2.5:14b-instruct-q4_K_M",
        defaultClass: "MODEL_C",
        allowCloud: true,
        budgetExempt: true,
      },
    },
  });
  for (const provider of ["ollama", "openai", "gemini", "anthropic"] as const) {
    router.budget.consume({ provider, agent: "RESEARCH", tokens: 500_000 });
  }
  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "low" }));
  assert.equal(decision.mode, "manual");
  assert.equal(decision.model, "qwen2.5:14b-instruct-q4_K_M");
  assert.equal(decision.budgetBlocked, false);
  assert.equal(router.policy.agents.RESEARCH.budgetExempt, true);
});

test("Budget: Verbrauch wird gebucht (Provider + Agent) und fließt in die Karten-Daten", () => {
  const { router, registry } = createTestRouter({ policy: tightBudgetPolicy() });
  router.consumeUsage({ provider: "gemini", agent: "RESEARCH", tokens: 250, costUsd: 0.01, latencyMs: 300 });

  assert.equal(router.budget.usagePercent("gemini"), 25);
  assert.equal(router.budget.snapshot().providers.gemini.tokens, 250);
  assert.equal(router.budget.snapshot().agents.RESEARCH?.tokens, 250);

  const card = registry.get("gemini");
  assert.equal(card?.tokensUsedToday, 250);
  assert.equal(card?.quotaRest, 75);
  assert.ok((card?.latencyEma ?? 0) > 0);
});

test("Budget: Tageswechsel setzt die Zähler deterministisch zurück", () => {
  let now = new Date("2026-08-28T23:59:59.000Z");
  const tracker = new BudgetTracker(
    {
      providers: { gemini: { tokensPerDay: 1_000, costUsdPerDay: 1 } },
      agents: {},
      global: { tokensPerDay: 10_000, costUsdPerDay: 5 },
    },
    { clock: { now: () => now } }
  );
  assert.equal(dayKey(now), "2026-08-28");
  tracker.consume({ provider: "gemini", tokens: 1_000 });
  assert.equal(tracker.isExhausted("gemini"), true);

  now = new Date("2026-08-29T00:00:01.000Z");
  assert.equal(tracker.isExhausted("gemini"), false, "neuer Tag ⇒ neue Kontingente");
  assert.equal(tracker.snapshot().day, "2026-08-29");
});

test("Budget: Eskalationen je Agent/Tag sind gedeckelt", () => {
  let now = new Date("2026-08-28T10:00:00.000Z");
  const tracker = new BudgetTracker(
    { providers: {}, agents: {}, global: { tokensPerDay: 1_000, costUsdPerDay: 1 } },
    { clock: { now: () => now }, maxApprovedPerAgentPerDay: 2 }
  );
  tracker.countApproval("RESEARCH");
  tracker.countApproval("RESEARCH");
  assert.equal(tracker.approvalsFor("RESEARCH").count, 2);
  now = new Date("2026-08-29T10:00:00.000Z");
  assert.equal(tracker.approvalsFor("RESEARCH").count, 0);
});

test("Budget: Policy verlangt für Cloud-Provider zwingend einen Deckel > 0", () => {
  const broken = structuredClone(DEFAULT_ROUTING_POLICY) as RoutingPolicy;
  broken.budgets.providers.gemini = { tokensPerDay: 0, costUsdPerDay: 0 };
  const result = validateRoutingPolicy(broken);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("Cloud-Provider brauchen einen Deckel")));

  // Lokale Provider dürfen ohne Deckel laufen (kostenlos) — bleibt valide.
  const local = structuredClone(DEFAULT_ROUTING_POLICY) as RoutingPolicy;
  local.budgets.providers.ollama = { tokensPerDay: 0, costUsdPerDay: 0 };
  assert.equal(validateRoutingPolicy(local).ok, true);
});

test("Budget: kein Cloud-Provider ohne Deckel in der Default-Policy", () => {
  for (const id of ["gemini", "anthropic"] as const) {
    const limit = DEFAULT_ROUTING_POLICY.budgets.providers[id];
    assert.ok(limit && limit.tokensPerDay > 0, `${id} muss gedeckelt sein`);
    assert.ok(limit.costUsdPerDay >= 0);
  }
});
