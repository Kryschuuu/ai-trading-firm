import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRouter, ctx } from "./fixtures/routingTestUtil";
import {
  ModelRouter,
  MemoryAuditSink,
  createFakeProviderRegistry,
  defaultRoutingPolicy,
} from "../src/routing";

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

test("Override kann per null deaktiviert werden (Löschung auditiert)", () => {
  const { router, audit } = createTestRouter({
    providers: { ollama: { models: [OLLAMA_MODEL] } },
  });
  router.setOverrides({
    TECHNICAL_ANALYST: { provider: "ollama", model: OLLAMA_MODEL, fallbackMode: "automatic" },
  }, "admin");
  assert.equal(Object.keys(router.getOverrides()).length, 1);
  const beforeLen = audit.entries.length;
  const clear = router.setOverrides({ TECHNICAL_ANALYST: null }, "admin");
  assert.equal(clear.ok, true);
  assert.deepEqual(router.getOverrides(), {});
  // Audit-Eintrag für die Deaktivierung
  const lastAudit = audit.entries[audit.entries.length - 1];
  assert.equal(lastAudit.to, "override:none");
  assert.equal(lastAudit.outcome, "admin");
  assert.ok(audit.entries.length > beforeLen);
});

test("Override-Persistenz schreibt und lädt korrekt (modesFile/overridesFile) ", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "routing-test-"));
  try {
    const modesFile = path.join(dir, "modes.json");
    const overridesFile = path.join(dir, "overrides.json");
    // Router mit echten Dateien bauen (createTestRouter setzt files auf null)
    const policy = defaultRoutingPolicy();
    const registry = createFakeProviderRegistry({ providers: { ollama: { models: [OLLAMA_MODEL] } } });
    const auditSink = new MemoryAuditSink();
    const clock = { now: () => new Date("2026-08-29T00:00:00Z") };
    const a = new ModelRouter({
      policy, registry, audit: auditSink, clock, modesFile, overridesFile, autoStartPoller: false, env: {},
    });
    a.setMode("RESEARCH", "hybrid", "admin");
    a.setOverrides({ RESEARCH: { provider: "ollama", model: OLLAMA_MODEL, fallbackMode: "automatic" } }, "admin");
    // Zweiter Router lädt Zustand aus den Dateien
    const b = new ModelRouter({
      policy, registry, audit: new MemoryAuditSink(), clock, modesFile, overridesFile, autoStartPoller: false, env: {},
    });
    assert.equal(b.effectiveMode("RESEARCH"), "hybrid");
    const overrides = b.getOverrides();
    assert.ok(overrides.RESEARCH);
    assert.equal(overrides.RESEARCH.provider, "ollama");
    assert.equal(overrides.RESEARCH.model, OLLAMA_MODEL);
    assert.equal(overrides.RESEARCH.fallbackMode, "automatic");
    // Cleanup über b.stopHealthPoller() ist nicht nötig (autoStartPoller:false)
    a.stopHealthPoller();
    b.stopHealthPoller();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Ungültige JSON-Dateien werden toleriert (best-effort Load)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "routing-bad-"));
  try {
    const overridesFile = path.join(dir, "overrides.json");
    writeFileSync(overridesFile, "{ this is not json", { mode: 0o600 });
    const router = new ModelRouter({
      policy: defaultRoutingPolicy(),
      registry: createFakeProviderRegistry(),
      audit: new MemoryAuditSink(),
      clock: { now: () => new Date() },
      modesFile: null,
      overridesFile,
      autoStartPoller: false,
      env: {},
    });
    // Ohne Crash, keine Overrides geladen
    assert.deepEqual(router.getOverrides(), {});
    router.stopHealthPoller();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fallback-Kette nach fehlgeschlagenem Override (Offline + Quota)", () => {
  // ollama offline → Override scheitert → fallbackMode automatic → wähle anderen Provider
  const altModel = "local-model";
  const { router } = createTestRouter({
    providers: {
      ollama: { models: [OLLAMA_MODEL], healthStatus: "offline" },
      openai: { models: [altModel], healthStatus: "online" },
    },
  });
  router.setOverrides({
    RESEARCH: { provider: "ollama", model: OLLAMA_MODEL, fallbackMode: "automatic" },
  }, "admin");
  const decision = router.resolve(ctx({
    agent: "RESEARCH", task: "research", complexity: "high",
  }));
  assert.notEqual(decision.provider, "ollama");
  assert.equal(decision.mode, "automatic");
});

test("Snapshot enthält overrides inkl. Policy-Metadaten", () => {
  const { router } = createTestRouter({
    providers: { ollama: { models: [OLLAMA_MODEL] } },
  });
  router.setOverrides({
    CEO: { provider: "ollama", model: OLLAMA_MODEL, fallbackMode: "hybrid" },
  }, "admin");
  const snap = router.snapshot();
  assert.ok(snap.overrides.CEO);
  assert.equal(snap.overrides.CEO.provider, "ollama");
  assert.equal(snap.overrides.CEO.model, OLLAMA_MODEL);
  assert.equal(snap.overrides.CEO.fallbackMode, "hybrid");
});
