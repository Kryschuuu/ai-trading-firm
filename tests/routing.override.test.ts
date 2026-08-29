import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestRouter, ctx } from "./fixtures/routingTestUtil";

const OLLAMA_MODEL = "qwen2.5:3b-instruct-q4_K_M";

test("Provider/Modell-Override hat Vorrang vor dem konfigurierten Modus", () => {
  const { router } = createTestRouter({
    modes: { TECHNICAL_ANALYST: "automatic" },
    providers: { ollama: { models: [OLLAMA_MODEL] } },
  });
  const result = router.setOverrides({
    TECHNICAL_ANALYST: { provider: "ollama", model: OLLAMA_MODEL, fallbackMode: "automatic" },
  }, "admin");
  assert.equal(result.ok, true);
  const decision = router.resolve(ctx({ agent: "TECHNICAL_ANALYST", complexity: "critical" }));
  assert.equal(decision.provider, "ollama");
  assert.equal(decision.model, OLLAMA_MODEL);
  assert.equal(decision.trigger, "PROVIDER_MODEL_OVERRIDE");
});

test("fehlgeschlagener Override fällt in den konfigurierten Fallback-Modus zurück", () => {
  const { router } = createTestRouter({
    providers: { ollama: { models: [OLLAMA_MODEL], healthStatus: "offline" } },
  });
  router.setOverrides({
    TECHNICAL_ANALYST: { provider: "ollama", model: OLLAMA_MODEL, fallbackMode: "automatic" },
  }, "admin");
  const decision = router.resolve(ctx({ agent: "TECHNICAL_ANALYST" }));
  assert.notEqual(decision.trigger, "PROVIDER_MODEL_OVERRIDE");
  assert.equal(decision.mode, "automatic");
});

test("Override-Modelle werden gegen die Provider-Registry validiert", () => {
  const { router } = createTestRouter();
  const result = router.setOverrides({
    TECHNICAL_ANALYST: { provider: "ollama", model: "unregistered", fallbackMode: "automatic" },
  }, "admin");
  assert.equal(result.ok, false);
  assert.deepEqual(router.getOverrides(), {});
});
