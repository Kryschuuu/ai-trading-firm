/**
 * Tests für die Step-Engine (Task 06).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { SimulatedClock } from "../src/cycle/clock";
import { executeCycle } from "../src/cycle/engine";
import { createTestPorts } from "../src/cycle/ports";
import type { StepDefinition } from "../src/cycle/types";

test("Engine: führt mehrere Schritte in gegebener Reihenfolge aus", async () => {
  const clock = new SimulatedClock();
  const testPorts = createTestPorts();

  const executionOrder: string[] = [];

  const step1: StepDefinition = {
    stepId: "step-1",
    name: "Erster Schritt",
    role: "MARKET_SCANNER",
    timeWindow: "00:00-06:00",
    llmAllowed: false,
    async execute() {
      executionOrder.push("step-1");
      return { step1Done: true };
    },
  };

  const step2: StepDefinition = {
    stepId: "step-2",
    name: "Zweiter Schritt",
    role: "MACRO_ANALYST",
    timeWindow: "06:00-07:00",
    llmAllowed: true,
    async execute(ctx) {
      executionOrder.push("step-2");
      assert.deepEqual(ctx.previousStepOutputs["step-1"], { step1Done: true });
      return { step2Done: true };
    },
  };

  const record = await executeCycle({
    cycleId: "test-cycle-1",
    type: "daily",
    date: "2026-08-27",
    steps: [step1, step2],
    ports: testPorts,
    clock,
  });

  assert.equal(record.status, "COMPLETED");
  assert.deepEqual(executionOrder, ["step-1", "step-2"]);
  assert.equal(record.steps.length, 2);
  assert.equal(record.steps[0].status, "COMPLETED");
  assert.equal(record.steps[1].status, "COMPLETED");

  const auditEvents = await testPorts.audit.getEvents("test-cycle-1");
  assert.ok(auditEvents.some((e) => e.event === "CYCLE_STARTED"));
  assert.ok(auditEvents.some((e) => e.event === "CYCLE_COMPLETED"));
});

test("Engine: sperrt LLM-Aufruf bei llmAllowed = false (Laufzeit-Gate)", async () => {
  const clock = new SimulatedClock();
  const testPorts = createTestPorts();

  const illegalLlmStep: StepDefinition = {
    stepId: "scanner-violator",
    name: "Scanner mit verbotenem LLM",
    role: "MARKET_SCANNER",
    timeWindow: "00:00-06:00",
    llmAllowed: false, // VERBOTEN
    async execute(ctx) {
      // Versuch, den Agent-Port aufzurufen
      await ctx.ports.agent.invokeAgent({
        role: "MARKET_SCANNER",
        systemPrompt: "test",
        userPrompt: "test",
        fallback: {},
        schemaValidator: () => ({ valid: true, data: {} }),
      });
      return { done: true };
    },
  };

  const record = await executeCycle({
    cycleId: "test-cycle-llm-gate",
    type: "daily",
    date: "2026-08-27",
    steps: [illegalLlmStep],
    ports: testPorts,
    clock,
  });

  assert.equal(record.status, "FAILED");
  assert.match(record.error?.message ?? "", /Architektur-Verletzung/);
  assert.equal(record.steps[0].status, "FAILED");
});

test("Engine: Retry-Policy wiederholt fehlgeschlagene Schritte bis maxAttempts", async () => {
  const clock = new SimulatedClock();
  const testPorts = createTestPorts();

  let attemptsRun = 0;

  const retryStep: StepDefinition = {
    stepId: "retry-step",
    name: "Flaky Step",
    role: "TECHNICAL_ANALYST",
    timeWindow: "08:00-09:00",
    llmAllowed: true,
    retryPolicy: {
      maxAttempts: 3,
      backoffMs: 1, // minimal für schnellen Test
    },
    async execute() {
      attemptsRun++;
      if (attemptsRun < 3) {
        throw new Error(`Temporärer Fehler bei Versuch ${attemptsRun}`);
      }
      return { successAt: attemptsRun };
    },
  };

  const record = await executeCycle({
    cycleId: "test-cycle-retry",
    type: "daily",
    date: "2026-08-27",
    steps: [retryStep],
    ports: testPorts,
    clock,
  });

  assert.equal(record.status, "COMPLETED");
  assert.equal(attemptsRun, 3);
  assert.equal(record.steps[0].attempts, 3);
  assert.equal(record.steps[0].status, "COMPLETED");

  const auditEvents = await testPorts.audit.getEvents("test-cycle-retry");
  const retries = auditEvents.filter((e) => e.event === "CYCLE_STEP_RETRY");
  assert.equal(retries.length, 2);
});

test("Engine: bricht bei dauerhaftem Schritt-Fehler kontrolliert ab", async () => {
  const clock = new SimulatedClock();
  const testPorts = createTestPorts();

  const step1: StepDefinition = {
    stepId: "step-1-ok",
    name: "Erfolgreicher Schritt",
    role: "MARKET_SCANNER",
    timeWindow: "00:00-06:00",
    llmAllowed: false,
    async execute() {
      return { ok: true };
    },
  };

  const failingStep: StepDefinition = {
    stepId: "failing-step",
    name: "Dauerhaft fehlerhafter Schritt",
    role: "MACRO_ANALYST",
    timeWindow: "06:00-07:00",
    llmAllowed: true,
    retryPolicy: { maxAttempts: 2, backoffMs: 1 },
    async execute() {
      throw new Error("Kritischer API-Absturz");
    },
  };

  const step3: StepDefinition = {
    stepId: "step-3-never-reached",
    name: "Nie erreichter Schritt",
    role: "TECHNICAL_ANALYST",
    timeWindow: "08:00-09:00",
    llmAllowed: true,
    async execute() {
      return { shouldNotRun: true };
    },
  };

  const record = await executeCycle({
    cycleId: "test-cycle-abort",
    type: "daily",
    date: "2026-08-27",
    steps: [step1, failingStep, step3],
    ports: testPorts,
    clock,
  });

  assert.equal(record.status, "FAILED");
  assert.equal(record.error?.stepId, "failing-step");
  assert.match(record.error?.message ?? "", /Kritischer API-Absturz/);

  // Bereits gelaufene Schritte bleiben intakt
  assert.equal(record.steps.length, 2);
  assert.equal(record.steps[0].status, "COMPLETED");
  assert.equal(record.steps[1].status, "FAILED");

  const auditEvents = await testPorts.audit.getEvents("test-cycle-abort");
  assert.ok(auditEvents.some((e) => e.event === "CYCLE_STEP_FAILED"));
  assert.ok(auditEvents.some((e) => e.event === "CYCLE_FAILED"));
});

test("Engine: erfasst und auditiert MODEL_ESCALATION_REQUEST-Events", async () => {
  const clock = new SimulatedClock();
  const testPorts = createTestPorts();

  const escalatingStep: StepDefinition = {
    stepId: "escalating-step",
    name: "Schritt mit Modell-Eskalation",
    role: "MACRO_ANALYST",
    timeWindow: "06:00-07:00",
    llmAllowed: true,
    async execute(ctx) {
      ctx.emitEscalation({
        agent: "MACRO_ANALYST",
        reason: "Sehr komplexe Marktphase mit multiplen geopolitischen Divergenzen",
        complexity: "high",
        confidence: 0.35,
      });
      return { thesis: "Abgewartet" };
    },
  };

  const record = await executeCycle({
    cycleId: "test-cycle-escalation",
    type: "daily",
    date: "2026-08-27",
    steps: [escalatingStep],
    ports: testPorts,
    clock,
  });

  assert.equal(record.status, "COMPLETED");
  assert.equal(record.escalations.length, 1);
  assert.equal(record.escalations[0].agent, "MACRO_ANALYST");
  assert.equal(record.escalations[0].complexity, "high");

  const auditEvents = await testPorts.audit.getEvents("test-cycle-escalation");
  assert.ok(auditEvents.some((e) => e.event === "MODEL_ESCALATION_REQUEST"));
});
