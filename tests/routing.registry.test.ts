/**
 * Provider-Registry, Health-Poller und Audit-Senken (Task 09).
 *
 * Alles ohne echtes Netzwerk: `fetchFn` wird injiziert, lokale Basis-URLs
 * zeigen auf einen garantiert geschlossenen Port.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CompositeAuditSink,
  DatabaseAuditSink,
  createRoutingAuditSink,
  EnvProviderRegistry,
  FakeProviderRegistry,
  FileAuditSink,
  MemoryAuditSink,
  buildDefaultRegistry,
  buildProviderDescriptor,
  clearRoutingAuditForTests,
  createFakeProviderRegistry,
  createProviderRegistry,
  fetchOllamaContextSize,
  nextLatencyEma,
  probeProviderHealth,
  quotaFromBudget,
  readRoutingAudit,
  routingAuditRing,
  startHealthPoller,
  type ProviderDescriptor,
} from "../src/routing";
import type { RoutingAuditEntry } from "../src/routing/types";

const CLOSED_PORT = "http://127.0.0.1:1";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "routing-test-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  clearRoutingAuditForTests();
});

beforeEach(() => {
  clearRoutingAuditForTests();
});

// ─────────────────────────────────────────────────────────────────────────────
// Provider-Karten
// ─────────────────────────────────────────────────────────────────────────────

test("Registry: Karten aus der Umgebung (Preise, Kontext, Deployment)", () => {
  const env = {
    OLLAMA_BASE_URL: CLOSED_PORT,
    LLM_BASE_URL: CLOSED_PORT,
    OLLAMA_NUM_CTX: "8192",
    GEMINI_API_KEY: "gemini-key",
    LLM_COST_GEMINI_INPUT_PER_MTOK: "0.2",
    LLM_COST_GEMINI_OUTPUT_PER_MTOK: "1.0",
    ROUTING_BUDGET_OLLAMA_TOKENS: "1000",
  };
  const cards = buildDefaultRegistry(env);
  assert.equal(cards.length, 4);
  const byId = new Map(cards.map((c) => [c.id, c]));

  const ollama = byId.get("ollama")!;
  assert.equal(ollama.deployment, "local");
  assert.equal(ollama.contextSize, 8192);
  assert.equal(ollama.costPer1kIn, 0);
  assert.equal(ollama.tokenBudgetToday, 1000);
  assert.equal(ollama.healthStatus, "degraded", "lokal bis zur ersten Prüfung degraded");

  const gemini = byId.get("gemini")!;
  assert.equal(gemini.deployment, "cloud");
  assert.equal(gemini.healthStatus, "degraded", "Key vorhanden ⇒ nutzbar");
  assert.ok(Math.abs(gemini.costPer1kIn - 0.0002) < 1e-9);
  assert.ok(Math.abs(gemini.costPer1kOut - 0.001) < 1e-9);

  const anthropic = byId.get("anthropic")!;
  assert.equal(anthropic.healthStatus, "offline", "ohne Key nicht nutzbar");
  assert.match(anthropic.error ?? "", /Kein API-Key/);

  // Defaults ohne Env
  const plain = buildProviderDescriptor("gemini", {});
  assert.equal(plain.contextSize, 32768);
});

test("Registry: EnvProviderRegistry listet, bucht Verbrauch und überschreibt Zustand", () => {
  const registry = new EnvProviderRegistry({
    OLLAMA_BASE_URL: CLOSED_PORT,
    LLM_BASE_URL: CLOSED_PORT,
    ROUTING_BUDGET_OLLAMA_TOKENS: "1000",
  });

  assert.deepEqual(
    registry.list().map((p) => p.id),
    ["ollama", "openai", "gemini", "anthropic"]
  );
  assert.equal(registry.get("nope" as never), undefined);

  registry.recordUsage({ provider: "ollama", tokens: 250, latencyMs: 100 });
  const card = registry.get("ollama")!;
  assert.equal(card.tokensUsedToday, 250);
  assert.equal(card.quotaRest, 75);
  assert.equal(card.latencyEma, 100);

  registry.recordUsage({ provider: "ollama", tokens: 100, latencyMs: 300 });
  assert.equal(registry.get("ollama")?.latencyEma, 140); // 100*0.8 + 300*0.2
  registry.recordUsage({ provider: "ollama", tokens: Number.NaN });
  assert.equal(registry.get("ollama")?.tokensUsedToday, 350);

  const patched = registry.override("ollama", { healthStatus: "offline" });
  assert.equal(patched?.healthStatus, "offline");
  assert.equal(registry.override("nope" as never, {}), undefined);
});

test("Registry: refresh() markiert nicht erreichbare Provider als offline (ohne Werfen)", async () => {
  const registry = new EnvProviderRegistry({
    OLLAMA_BASE_URL: CLOSED_PORT,
    LLM_BASE_URL: CLOSED_PORT,
    ROUTING_HEALTH_TIMEOUT_MS: "200",
  });
  const cards = await registry.refresh();
  assert.equal(cards.length, 4);
  const ollama = cards.find((c) => c.id === "ollama")!;
  assert.equal(ollama.healthStatus, "offline");
  assert.ok((ollama.error ?? "").length > 0);
  assert.ok(ollama.lastCheckedAt);
  // Cloud ohne Key bleibt offline
  assert.equal(cards.find((c) => c.id === "gemini")?.healthStatus, "offline");
});

// ─────────────────────────────────────────────────────────────────────────────
// Health-Prüfung (fetch injiziert)
// ─────────────────────────────────────────────────────────────────────────────

function descriptor(id: ProviderDescriptor["id"], patch: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return { ...buildProviderDescriptor(id, { OLLAMA_BASE_URL: CLOSED_PORT, LLM_BASE_URL: CLOSED_PORT }), ...patch, id };
}

test("Health: Ollama erfolgreich ⇒ online + Modelle + Kontextgrösse aus /api/show", async () => {
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes("/api/tags")) {
      return Response.json({ models: [{ name: "qwen2.5:3b-instruct-q4_K_M" }, { name: "" }] });
    }
    if (target.includes("/api/show")) {
      assert.equal(init?.method, "POST");
      return Response.json({ model_info: { "qwen2.5": { context_length: 32768 } } });
    }
    throw new Error("unexpected url");
  }) as unknown as typeof fetch;

  const probed = await probeProviderHealth(descriptor("ollama", { latencyEma: 200 }), {
    env: { OLLAMA_BASE_URL: CLOSED_PORT },
    fetchFn,
    timeoutMs: 500,
  });
  assert.equal(probed.healthStatus, "online");
  assert.deepEqual(probed.models, ["qwen2.5:3b-instruct-q4_K_M"]);
  assert.equal(probed.contextSize, 32768);
  assert.ok(probed.latencyEma > 0 && probed.latencyEma <= 400);
  assert.equal(probed.error, undefined);
});

test("Health: Ollama ohne Modelle ⇒ degraded; Fehler ⇒ offline (niemals Werfen)", async () => {
  const empty = await probeProviderHealth(descriptor("ollama"), {
    env: { OLLAMA_BASE_URL: CLOSED_PORT },
    fetchFn: (async () => Response.json({ models: [] })) as unknown as typeof fetch,
  });
  assert.equal(empty.healthStatus, "degraded");

  const failing = await probeProviderHealth(descriptor("ollama"), {
    env: { OLLAMA_BASE_URL: CLOSED_PORT },
    fetchFn: (async () => Response.json({ error: "nope" }, { status: 500 })) as unknown as typeof fetch,
  });
  assert.equal(failing.healthStatus, "offline");
  assert.match(failing.error ?? "", /HTTP 500/);
});

test("Health: Cloud ohne Key ⇒ offline; mit Key ohne Fern-Check ⇒ online", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return Response.json({ models: [{ name: "models/gemini-2.0-flash" }] });
  }) as unknown as typeof fetch;

  const noKey = await probeProviderHealth(descriptor("gemini", { healthStatus: "degraded" }), {
    env: {},
    fetchFn,
  });
  assert.equal(noKey.healthStatus, "offline");
  assert.equal(noKey.quotaRest, 0);

  const withKey = await probeProviderHealth(descriptor("gemini", { healthStatus: "degraded" }), {
    env: { GEMINI_API_KEY: "k" },
    fetchFn,
  });
  assert.equal(withKey.healthStatus, "online");
  assert.equal(calls, 0, "Default 'local' prüft Cloud nicht remote");

  const forced = await probeProviderHealth(descriptor("gemini", { healthStatus: "degraded" }), {
    env: { GEMINI_API_KEY: "k", ROUTING_HEALTH_PROBE: "all" },
    fetchFn,
  });
  assert.equal(forced.healthStatus, "online");
  assert.deepEqual(forced.models, ["gemini-2.0-flash"]);
  assert.equal(calls, 1);

  const off = await probeProviderHealth(descriptor("gemini"), {
    env: {},
    fetchFn,
    force: true,
  });
  assert.equal(off.healthStatus, "offline");
});

test("Health: OpenAI-kompatibel und Anthropic werden über die Modellliste geprüft", async () => {
  const openai = await probeProviderHealth(descriptor("openai"), {
    env: { LLM_BASE_URL: CLOSED_PORT, LLM_API_KEY: "k" },
    fetchFn: (async () => Response.json({ data: [{ id: "local-model" }] })) as unknown as typeof fetch,
  });
  assert.equal(openai.healthStatus, "online");
  assert.deepEqual(openai.models, ["local-model"]);

  const anthropic = await probeProviderHealth(descriptor("anthropic"), {
    env: { ANTHROPIC_BASE_URL: CLOSED_PORT, ANTHROPIC_API_KEY: "k", ROUTING_HEALTH_PROBE: "all" },
    fetchFn: (async () => Response.json({ data: [{ id: "claude-3-5-haiku-latest" }] })) as unknown as typeof fetch,
  });
  assert.equal(anthropic.healthStatus, "online");
  assert.deepEqual(anthropic.models, ["claude-3-5-haiku-latest"]);
});

test("Health: fetchOllamaContextSize ist best-effort (null bei Fehler/ohne Modell)", async () => {
  assert.equal(await fetchOllamaContextSize("", { env: {} }), null);
  const ok = await fetchOllamaContextSize("qwen2.5", {
    env: { OLLAMA_BASE_URL: CLOSED_PORT },
    fetchFn: (async () => Response.json({ model_info: { a: { context_length: 4096 } } })) as unknown as typeof fetch,
  });
  assert.equal(ok, 4096);
  const broken = await fetchOllamaContextSize("qwen2.5", {
    env: { OLLAMA_BASE_URL: CLOSED_PORT },
    fetchFn: (async () => Response.json({ model_info: {} })) as unknown as typeof fetch,
  });
  assert.equal(broken, null);
  const failing = await fetchOllamaContextSize("qwen2.5", {
    env: { OLLAMA_BASE_URL: CLOSED_PORT },
    fetchFn: (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch,
  });
  assert.equal(failing, null);
});

test("Health: EMA und Kontingent sind deterministisch", () => {
  assert.equal(nextLatencyEma(0, 100), 100);
  assert.equal(nextLatencyEma(100, 300), 140);
  assert.equal(nextLatencyEma(100, Number.NaN), 100);
  assert.equal(nextLatencyEma(100, -5), 100);
  assert.equal(quotaFromBudget(0, 1000), 100);
  assert.equal(quotaFromBudget(250, 1000), 75);
  assert.equal(quotaFromBudget(5000, 1000), 0);
  assert.equal(quotaFromBudget(10, 0), 100);
});

// ─────────────────────────────────────────────────────────────────────────────
// Health-Poller
// ─────────────────────────────────────────────────────────────────────────────

test("Poller: Intervall 0 ⇒ kein Timer, aber sofortige Prüfung (immediate)", async () => {
  const registry = createFakeProviderRegistry();
  const handle = startHealthPoller({ registry, intervalMs: 0, immediate: true });
  assert.equal(handle.running, false);
  assert.equal(registry.refreshCount, 1);
  handle.stop();
  assert.equal(handle.running, false);
  await handle.pollNow();
  assert.equal(registry.refreshCount, 2);
});

test("Poller: konfigurierbares Intervall, stop() beendet ihn", async () => {
  const registry = createFakeProviderRegistry();
  const ticks: number[] = [];
  const handle = startHealthPoller({
    registry,
    intervalMs: 5,
    immediate: false,
    onTick: (providers) => ticks.push(providers.length),
  });
  assert.equal(handle.intervalMs, 5);
  assert.equal(handle.running, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  handle.stop();
  const afterStop = registry.refreshCount;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ticks.length >= 1);
  assert.equal(registry.refreshCount, afterStop, "nach stop() keine weiteren Prüfungen");
});

test("Poller: Fehler der Registry werden abgefangen (onError)", async () => {
  const registry = createFakeProviderRegistry({ refreshError: "boom" });
  const errors: unknown[] = [];
  const handle = startHealthPoller({ registry, intervalMs: 0, immediate: true, onError: (e) => errors.push(e) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(errors.length, 1);
  assert.equal(String((errors[0] as Error).message), "boom");
  handle.stop();
});

test("Poller: Fake-Registry simuliert Health/Quota/Timeout ohne Netzwerk", async () => {
  const registry = createFakeProviderRegistry({
    providers: { ollama: { healthStatus: "offline" }, gemini: { quotaRest: 2 } },
  });
  assert.equal(registry.get("ollama")?.healthStatus, "offline");
  assert.equal(registry.get("gemini")?.quotaRest, 2);
  registry.setHealth("ollama", "online");
  registry.setQuota("gemini", 100);
  assert.equal(registry.get("ollama")?.healthStatus, "online");
  assert.equal(registry.get("gemini")?.quotaRest, 100);

  const slow = createFakeProviderRegistry({ refreshDelayMs: 5 });
  const started = Date.now();
  await slow.refresh();
  assert.ok(Date.now() - started >= 4);
});

test("Registry: createProviderRegistry liefert die Env-Implementierung", () => {
  const registry = createProviderRegistry({ OLLAMA_BASE_URL: CLOSED_PORT, LLM_BASE_URL: CLOSED_PORT });
  assert.ok(registry instanceof EnvProviderRegistry);
  assert.equal(registry.get("ollama")?.contextSize, 4096);
  assert.ok(createFakeProviderRegistry() instanceof FakeProviderRegistry);
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit-Senken
// ─────────────────────────────────────────────────────────────────────────────

function entry(partial: Partial<RoutingAuditEntry> = {}): RoutingAuditEntry {
  return {
    ts: new Date("2026-08-28T10:00:00.000Z").toISOString(),
    agent: "RESEARCH",
    from: "MODEL_A:ollama:qwen2.5:3b-instruct-q4_K_M",
    to: "MODEL_C:gemini:gemini-2.0-flash",
    reason: "Eskalation genehmigt.",
    trigger: "ESCALATION_APPROVED",
    policyVersion: "1.0.0",
    outcome: "approved",
    ...partial,
  };
}

test("Audit: Memory- und Datei-Senke schreiben Ring + NDJSON", () => {
  const memory = new MemoryAuditSink();
  memory.write(entry());
  assert.equal(memory.entries.length, 1);

  const file = path.join(tmpDir(), "audit.ndjson");
  const sink = new FileAuditSink(file);
  sink.write(entry({ agent: "CEO", outcome: "denied" }));
  sink.write(entry({ agent: "NEWS_ANALYST", outcome: "fallback" }));

  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).agent, "CEO");
  assert.equal(routingAuditRing.length, 3, "Ring sammelt alle Senken");
  assert.equal(readRoutingAudit(2).length, 2);
  assert.equal(readRoutingAudit(1)[0].agent, "NEWS_ANALYST", "neueste zuerst");
});

test("Audit: Composite-Senke ist ausfalltolerant (eine defekte Senke stoppt nicht)", async () => {
  const ok = new MemoryAuditSink();
  const broken = {
    name: "broken",
    write() {
      throw new Error("sink down");
    },
  };
  const composite = new CompositeAuditSink([broken as never, ok]);
  await composite.write(entry());
  assert.equal(ok.entries.length, 1);
  assert.equal(routingAuditRing.at(-1)?.agent, "RESEARCH");
});

test("Audit: Datenbank-Senke ohne DATABASE_URL ist ein No-Op (best-effort)", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const sink = new DatabaseAuditSink();
    await sink.write(entry({ agent: "PORTFOLIO_ANALYST" }));
    assert.equal(routingAuditRing.at(-1)?.agent, "PORTFOLIO_ANALYST");
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});

test("Audit: Datei-Senke legt das Verzeichnis an (auch wenn es fehlt)", () => {
  const target = path.join(tmpDir(), "nested", "deep", "audit.ndjson");
  const sink = new FileAuditSink(target);
  sink.write(entry());
  assert.equal(existsSync(target), true);
});

test("Audit: createRoutingAuditSink kombiniert Datei + Datenbank", () => {
  const sink = createRoutingAuditSink(path.join(tmpDir(), "audit.ndjson"));
  assert.equal(sink.sinks.length, 2);
  assert.deepEqual(
    sink.sinks.map((entry) => entry.name),
    ["file", "database"]
  );
});
