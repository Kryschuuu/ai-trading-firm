/**
 * Fallback-Ketten (Task 09).
 *
 * Default-Konfiguration:
 *   ollama-timeout        → gemini → anthropic
 *   gemini-quota < 5 %    → ollama
 *   anthropic-offline     → ollama → gemini
 *   offline:*             → Kette laut Policy
 *
 * Jeder tatsächliche Wechsel wird auditiert (Assertion pro Fall).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestRouter, ctx } from "./fixtures/routingTestUtil";
import { routeChat } from "../src/routing/adapter";
import type { RoutingPolicy } from "../src/routing/policy";
import type { LlmChatResult, LlmChatRequest, LlmProviderName } from "../src/lib/llmProvider";
import type { ProviderId } from "../src/routing/types";

/**
 * Policy, in der MODEL_C genau EINEN Provider hat — damit die Fallback-Kette
 * (und nicht die Provider-Liste der Klasse) die Entscheidung trägt.
 */
function singleCloudProvider(id: ProviderId): Partial<RoutingPolicy> {
  return {
    classes: {
      MODEL_A: { label: "local-small", deployment: "local", minParamsB: 3, maxParamsB: 8, providers: [{ provider: "ollama" }] },
      MODEL_B: { label: "local-medium", deployment: "local", minParamsB: 8, maxParamsB: 30, providers: [{ provider: "ollama" }] },
      MODEL_C: { label: "large", deployment: "any", minParamsB: 30, maxParamsB: 1000, providers: [{ provider: id }] },
    },
  };
}

const RESEARCH_CLOUD = {
  agents: { RESEARCH: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true } },
} as const;

test("Fallback: Ollama offline ⇒ Kette liefert Gemini (offline:ollama → gemini)", () => {
  const { router, registry, audit } = createTestRouter({
    policy: singleCloudProvider("ollama"),
    ...RESEARCH_CLOUD,
  });
  registry.setHealth("ollama", "offline");

  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.provider, "gemini");
  assert.equal(decision.decision, "CLOUD");
  assert.equal(decision.trigger, "FALLBACK_CHAIN");
  assert.equal(decision.modelClass, "MODEL_C");
  assert.deepEqual(decision.providerChain, ["gemini", "anthropic"]);

  const entries = audit.entries.filter((e) => e.outcome === "fallback");
  assert.equal(entries.length, 1);
  assert.match(entries[0].reason, /Fallback-Kette nach PROVIDER_OFFLINE:ollama → gemini/);
  assert.equal(entries[0].from, "none");
  assert.equal(entries[0].to, "MODEL_C:gemini:gemini-2.0-flash");
  assert.equal(entries[0].policyVersion, router.policy.version);
});

test("Fallback: Ollama-Timeout im chat()-Pfad ⇒ Gemini antwortet, Wechsel auditiert", async () => {
  const { router, audit } = createTestRouter({
    policy: singleCloudProvider("ollama"),
    ...RESEARCH_CLOUD,
  });
  // Modell-Tag der großen Klasse für Ollama (Karten-Default ist 3b).
  router.registry.override("ollama", { defaultModel: "qwen2.5:14b-instruct-q4_K_M" });
  const timedOut = new Set<LlmProviderName>(["ollama"]);
  const chatFn = async (
    _req: LlmChatRequest,
    opts?: { providers?: LlmProviderName[] }
  ): Promise<LlmChatResult> => {
    for (const provider of opts?.providers ?? []) {
      if (timedOut.has(provider)) continue; // simuliert Timeout
      return {
        content: JSON.stringify({ ok: true }),
        provider,
        model: `model-${provider}`,
        usage: { totalTokens: 120 },
        latencyMs: 42,
        attempt: 1,
      };
    }
    throw new Error("timeout: alle Provider nicht erreichbar");
  };

  const result = await routeChat(
    {
      agent: "RESEARCH",
      task: "complex_research",
      complexity: "high",
      messages: [{ role: "user", content: "test" }],
      fallbackContent: JSON.stringify({ view: "NEUTRAL" }),
    },
    { router, chatFn: chatFn as never }
  );

  assert.equal(result.decision.provider, "ollama", "Ziel bleibt lokal (Policy-Reihenfolge)");
  assert.equal(result.provider, "gemini", "Timeout ⇒ nächster Provider der Kette");
  assert.equal(result.switched, true);
  assert.equal(result.usedFallback, false);

  const switchEntries = audit.entries.filter((e) => e.trigger === "FALLBACK_CHAIN");
  assert.equal(switchEntries.length, 1);
  assert.equal(switchEntries[0].outcome, "fallback");
  assert.equal(switchEntries[0].from, "MODEL_C:ollama:qwen2.5:14b-instruct-q4_K_M");
  assert.equal(switchEntries[0].to, "MODEL_C:gemini:model-gemini");
  assert.equal(switchEntries[0].detail?.chain, "ollama>gemini>anthropic");
});

test("Fallback: Gemini-Quota < 5 % ⇒ Ollama (Kette 'quota:gemini')", () => {
  const { router, registry, audit } = createTestRouter({
    policy: singleCloudProvider("gemini"),
    ...RESEARCH_CLOUD,
  });
  registry.override("ollama", { defaultModel: "qwen2.5:14b-instruct-q4_K_M" });
  registry.setQuota("gemini", 4);

  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.provider, "ollama");
  assert.equal(decision.trigger, "FALLBACK_CHAIN");
  assert.match(decision.reason, /Fallback-Kette nach QUOTA_BELOW_MIN:gemini → ollama/);

  const entry = audit.entries.at(-1);
  assert.equal(entry?.outcome, "fallback");
  assert.equal(entry?.to, "MODEL_C:ollama:qwen2.5:14b-instruct-q4_K_M");
});

test("Fallback: Quota genau 5 % bleibt nutzbar (Schwelle ist exklusiv)", () => {
  const { router, registry } = createTestRouter({
    policy: singleCloudProvider("gemini"),
    ...RESEARCH_CLOUD,
  });
  registry.setQuota("gemini", 5);
  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.provider, "gemini");
  assert.equal(decision.trigger, "DEFAULT_TABLE");
});

test("Fallback: Anthropic offline ⇒ Kette ollama → gemini", () => {
  const { router, registry, audit } = createTestRouter({
    policy: singleCloudProvider("anthropic"),
    ...RESEARCH_CLOUD,
  });
  registry.setHealth("anthropic", "offline");

  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.provider, "ollama");
  assert.equal(decision.trigger, "FALLBACK_CHAIN");

  const entry = audit.entries.at(-1);
  assert.equal(entry?.outcome, "fallback");
  assert.match(entry?.reason ?? "", /PROVIDER_OFFLINE:anthropic → ollama/);
});

test("Fallback: kompletter Provider-Ausfall ⇒ deterministische Regel-Engine + Audit", () => {
  const { router, registry, audit } = createTestRouter(RESEARCH_CLOUD);
  for (const id of ["ollama", "openai", "gemini", "anthropic"] as const) {
    registry.setHealth(id, "offline");
  }

  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(decision.decision, "FALLBACK");
  assert.equal(decision.provider, "none");
  assert.equal(decision.model, "rule-engine");
  assert.equal(decision.trigger, "NO_PROVIDER");

  const entry = audit.entries.at(-1);
  assert.equal(entry?.outcome, "fallback");
  assert.equal(entry?.to, "MODEL_C:none:rule-engine");
});

test("Fallback: Adapter liefert Fallback-Inhalt, wenn die gesamte Kette scheitert", async () => {
  const { router, audit } = createTestRouter(RESEARCH_CLOUD);
  const chatFn = async (): Promise<LlmChatResult> => {
    throw new Error("connection refused");
  };

  const result = await routeChat(
    {
      agent: "RESEARCH",
      messages: [{ role: "user", content: "test" }],
      fallbackContent: JSON.stringify({ view: "NEUTRAL", confidence: 0.5 }),
    },
    { router, chatFn: chatFn as never }
  );

  assert.equal(result.usedFallback, true);
  assert.equal(result.provider, "none");
  assert.equal(result.content, JSON.stringify({ view: "NEUTRAL", confidence: 0.5 }));
  const entry = audit.entries.at(-1);
  assert.equal(entry?.outcome, "fallback");
  assert.equal(entry?.to, "none:none:rule-engine");
  assert.match(entry?.reason ?? "", /Alle Provider der Kette fehlgeschlagen/);
});

test("Fallback: degraded-Provider bleibt nutzbar (nur offline fällt aus der Kette)", () => {
  const { router, registry } = createTestRouter({
    agents: { CEO: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: true } },
  });
  registry.setHealth("ollama", "degraded");
  const decision = router.resolve(ctx({ agent: "CEO", complexity: "high" }));
  assert.equal(decision.provider, "ollama");
  assert.equal(decision.trigger, "COMPLEXITY_FLOOR");
});

test("Fallback: Latenzverletzung erzwingt den Wechsel auf den schnelleren Provider", () => {
  const { router, registry, audit } = createTestRouter({
    policy: singleCloudProvider("ollama"),
    ...RESEARCH_CLOUD,
  });
  registry.override("ollama", { latencyEma: 9_000 });
  const decision = router.resolve(ctx({ agent: "RESEARCH", complexity: "high", latencyRequirementMs: 2_000 }));
  assert.equal(decision.provider, "gemini");
  assert.equal(decision.trigger, "FALLBACK_CHAIN");
  assert.equal(audit.entries.at(-1)?.outcome, "fallback");
});

test("Fallback: JEDER Wechsel der Kette hat genau einen Audit-Eintrag", () => {
  const { router, registry, audit } = createTestRouter({
    policy: singleCloudProvider("ollama"),
    ...RESEARCH_CLOUD,
  });

  const first = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(first.provider, "ollama");
  const initialAudits = audit.entries.length;

  registry.setHealth("ollama", "offline");
  const second = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(second.provider, "gemini");

  registry.setHealth("gemini", "offline");
  const third = router.resolve(ctx({ agent: "RESEARCH", complexity: "high" }));
  assert.equal(third.provider, "anthropic");

  const newAudits = audit.entries.slice(initialAudits);
  assert.equal(newAudits.length, 2, "zwei Wechsel ⇒ zwei Audit-Einträge");
  assert.deepEqual(
    newAudits.map((e) => e.to),
    ["MODEL_C:gemini:gemini-2.0-flash", "MODEL_C:anthropic:claude-3-5-haiku-latest"]
  );
  for (const entry of newAudits) {
    assert.equal(entry.agent, "RESEARCH");
    assert.equal(entry.outcome, "fallback");
    assert.ok(entry.reason.length > 0);
    assert.equal(entry.policyVersion, router.policy.version);
  }
});
