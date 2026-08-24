import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LlmProviderError,
  backoffDelayMs,
  buildAnthropicBody,
  buildGeminiBody,
  buildOllamaBody,
  buildOpenaiBody,
  chatLlm,
  costPerMTok,
  createLlmClient,
  estimateCostUsd,
  normalizeProvider,
  parseAnthropicResponse,
  parseGeminiResponse,
  parseOllamaResponse,
  parseOpenaiResponse,
  resolveMaxTokens,
  resolveProviderChain,
  withRetry,
  clearModelListCache,
  type LlmChatRequest,
} from "../src/lib/llmProvider";

const REQ: LlmChatRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ],
  temperature: 0.2,
  json: true,
  schema: { type: "object" },
};

// Der Modelllisten-Cache ist global (Produktions-Cache) — für isolierte Tests
// wird er vor jedem Test geleert.
beforeEach(() => clearModelListCache());

// ── Provider-Kette ───────────────────────────────────────────────────────────

test("resolveProviderChain: Standard ist ollama, Parsing toleranter Fallbacks", () => {
  assert.deepEqual(resolveProviderChain({}), ["ollama"]);
  assert.deepEqual(
    resolveProviderChain({ LLM_PROVIDER: "gemini", LLM_FALLBACK_PROVIDERS: "anthropic, openai, gemini, kaputt" }),
    ["gemini", "anthropic", "openai"]
  );
});

test("normalizeProvider: ungültige Werte werden abgelehnt", () => {
  assert.equal(normalizeProvider("ollama"), "ollama");
  assert.equal(normalizeProvider(" OpenAI "), "openai");
  assert.equal(normalizeProvider(undefined), null);
  assert.equal(normalizeProvider("deepseek-was-auch-immer"), null);
});

test("resolveMaxTokens: Env-Wert mit Klemme, ungültige Werte → 512", () => {
  assert.equal(resolveMaxTokens(REQ, { LLM_MAX_TOKENS: "256" }), 256);
  assert.equal(resolveMaxTokens({ ...REQ, maxTokens: 42 }, {}), 42);
  assert.equal(resolveMaxTokens(REQ, { LLM_MAX_TOKENS: "abc" }), 512);
  assert.equal(resolveMaxTokens({ ...REQ, maxTokens: 1e9 }, {}), 32768);
});

// ── Request-Builder (Standardisierung) ───────────────────────────────────────

test("Ollama-Body: num_predict als Token-Limit, format=json mit Schema", () => {
  const body = buildOllamaBody(REQ, { provider: "ollama", baseUrl: "http://x", numCtx: 4096, keepAlive: "30m" }) as any;
  assert.equal(body.model, "test-model");
  assert.equal(body.stream, false);
  assert.equal(body.options.num_predict, 512);
  assert.equal(body.options.num_ctx, 4096);
  assert.equal(body.options.keep_alive, "30m");
  assert.equal(body.format, REQ.schema);
});

test("OpenAI-Body: max_tokens, temperature, response_format json_schema", () => {
  const body = buildOpenaiBody(REQ, { provider: "openai", baseUrl: "http://x" }) as any;
  assert.equal(body.max_tokens, 512);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "decision");
});

test("Gemini-Body: systemInstruction getrennt, role-Mapping, JSON-Mime", () => {
  const body = buildGeminiBody(REQ, { provider: "gemini", baseUrl: "http://x" }) as any;
  assert.equal(body.systemInstruction.parts[0].text, "sys");
  assert.equal(body.contents[0].role, "user");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.maxOutputTokens, 512);
  const withAssistant = buildGeminiBody(
    { ...REQ, messages: [{ role: "assistant" as const, content: "ok" }] },
    { provider: "gemini", baseUrl: "http://x" }
  ) as any;
  assert.equal(withAssistant.contents[0].role, "model");
});

test("Anthropic-Body: system getrennt, max_tokens Pflicht", () => {
  const body = buildAnthropicBody(REQ, { provider: "anthropic", baseUrl: "http://x" }) as any;
  assert.equal(body.system, "sys");
  assert.equal(body.messages[0].role, "user");
  assert.equal(body.max_tokens, 512);
  assert.equal(body.temperature, 0.2);
});

// ── Response-Parser ──────────────────────────────────────────────────────────

test("Parser: Ollama/OpenAI/Gemini/Anthropic liefern Inhalt + Usage", () => {
  assert.equal(parseOllamaResponse({ message: { content: "A" } }).content, "A");
  const oa = parseOpenaiResponse({
    choices: [{ message: { content: "B" } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.equal(oa.content, "B");
  assert.deepEqual(oa.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  const g = parseGeminiResponse({
    candidates: [{ content: { parts: [{ text: "C" }, { text: "D" }] } }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  });
  assert.equal(g.content, "CD");
  assert.deepEqual(g.usage, { promptTokens: 7, completionTokens: 3, totalTokens: 10 });
  const an = parseAnthropicResponse({
    content: [{ type: "text", text: "E" }, { type: "tool_use", id: "x" }],
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  assert.equal(an.content, "E");
  assert.deepEqual(an.usage, { promptTokens: 1, completionTokens: 2 });
});

// ── Retry / Backoff ──────────────────────────────────────────────────────────

test("backoffDelayMs: exponentiell, gedeckelt, deterministischer Jitter", () => {
  const noJitter = () => 0;
  assert.equal(backoffDelayMs(1, 500, 8000, noJitter), 500);
  assert.equal(backoffDelayMs(2, 500, 8000, noJitter), 1000);
  assert.equal(backoffDelayMs(3, 500, 8000, noJitter), 2000);
  assert.equal(backoffDelayMs(10, 500, 8000, noJitter), 8000);
  // Jitter liegt innerhalb baseMs
  const j = backoffDelayMs(1, 500, 8000, () => 0.5);
  assert.ok(j >= 500 && j <= 1000);
});

test("withRetry: versucht erneut und liefert beim 2. Versuch Erfolg", async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw new LlmProviderError("429", "openai", { retryable: true, status: 429 });
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 2);
});

test("withRetry: nicht-retryable Fehler (4xx) wird sofort geworfen", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new LlmProviderError("400", "openai", { retryable: false, status: 400 });
      },
      { maxAttempts: 3, sleep: async () => {} }
    ),
    /400/
  );
  assert.equal(calls, 1, "kein Retry bei 4xx");
});

test("withRetry: nach maxAttempts wird der Originalfehler geworfen", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new LlmProviderError("boom", "gemini", { retryable: true });
      },
      { maxAttempts: 3, sleep: async () => {} }
    ),
    (e: unknown) => e instanceof LlmProviderError && e.message === "boom"
  );
  assert.equal(calls, 3);
});

// ── Kosten ───────────────────────────────────────────────────────────────────

test("Costs: lokal = 0, Cloud-Tarife + Env-Overrides, ohne Usage = undefined", () => {
  assert.equal(estimateCostUsd("ollama", { promptTokens: 1000, completionTokens: 1000 }), 0);
  const cost = estimateCostUsd("openai", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
  assert.ok(cost != null && Math.abs(cost - 0.75) < 1e-6, `cost=${cost}`);
  assert.equal(estimateCostUsd("openai", {}), undefined);
  assert.equal(
    costPerMTok("openai", "input", { LLM_COST_OPENAI_INPUT_PER_MTOK: "2.5" }),
    2.5
  );
});

// ── Client + Kette (mit injiziertem Fake-fetch, offline) ─────────────────────

function fakeFetch(results: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const next = results.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("OpenAI-Client: korrekte URL/Headers/Body + Usage im Ergebnis", async () => {
  const { fn, calls } = fakeFetch([
    // 1) /models (Modellauflösung), 2) /chat/completions
    new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }),
    new Response(JSON.stringify({
      choices: [{ message: { content: "{\"type\":\"HOLD\"}" } }],
      usage: { prompt_tokens: 4, completion_tokens: 9, total_tokens: 13 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const client = createLlmClient("openai", {
    env: { LLM_API_KEY: "sk-test", LLM_BASE_URL: "http://llm:9999/v1" },
    fetchFn: fn,
  });
  const res = await client.chat(REQ);
  assert.equal(res.content, '{"type":"HOLD"}');
  assert.equal(res.provider, "openai");
  assert.equal(res.usage.totalTokens, 13);
  assert.match(calls[1].url, /\/chat\/completions$/);
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer sk-test");
  const body = JSON.parse(String(calls[1].init?.body)) as any;
  assert.equal(body.model, "m1");
  assert.equal(body.max_tokens, 512);
});

test("Anthropic-Client: x-api-key + anthropic-version Header, System-Prompt getrennt", async () => {
  const { fn, calls } = fakeFetch([
    new Response(JSON.stringify({
      content: [{ type: "text", text: "claude sagt ja" }],
      usage: { input_tokens: 2, output_tokens: 3 },
    }), { status: 200 }),
  ]);
  const client = createLlmClient("anthropic", {
    env: { ANTHROPIC_API_KEY: "sk-ant-test" },
    fetchFn: fn,
  });
  const res = await client.chat(REQ);
  assert.equal(res.content, "claude sagt ja");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "sk-ant-test");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(String(calls[0].init?.body)) as any;
  assert.equal(body.system, "sys");
});

test("OpenAI-Client: LLM_MODEL-Override hat Vorrang vor dem Agenten-Tag (Peer-Review-Fix)", async () => {
  const { fn, calls } = fakeFetch([
    new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { total_tokens: 1 },
    }), { status: 200 }),
  ]);
  const client = createLlmClient("openai", {
    env: { LLM_MODEL: "qwen-local", LLM_BASE_URL: "http://llm:9999/v1" },
    fetchFn: fn,
  });
  const res = await client.chat({ ...REQ, model: "qwen2.5:3b-instruct-q4_K_M" });
  const body = JSON.parse(String(calls[0].init?.body)) as any;
  assert.equal(body.model, "qwen-local");
  assert.equal(res.model, "qwen-local");
});

test("OpenAI-Client: ohne LLM_MODEL fällt er auf das erste angebotene Modell zurück", async () => {
  const { fn, calls } = fakeFetch([
    new Response(JSON.stringify({ data: [{ id: "llama-3.2-3b" }, { id: "qwen-7b" }] }), { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
  ]);
  const client = createLlmClient("openai", {
    env: { LLM_BASE_URL: "http://llm:9999/v1" },
    fetchFn: fn,
  });
  await client.chat({ ...REQ, model: "unbekannter-tag" });
  const body = JSON.parse(String(calls[1].init?.body)) as any;
  assert.equal(body.model, "llama-3.2-3b");
});

test("Ollama-Client: löst Familientag über die installierte Modellliste auf", async () => {
  const { fn, calls } = fakeFetch([
    new Response(JSON.stringify({ models: [{ name: "qwen2.5:3b-instruct-q4_K_M" }] }), { status: 200 }),
    new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 }),
  ]);
  const client = createLlmClient("ollama", {
    env: { OLLAMA_BASE_URL: "http://ollama:11434" },
    fetchFn: fn,
  });
  await client.chat({ ...REQ, model: "qwen2.5" });
  assert.match(calls[0].url, /\/api\/tags$/);
  const body = JSON.parse(String(calls[1].init?.body)) as any;
  assert.equal(body.model, "qwen2.5:3b-instruct-q4_K_M");
});

test("listModels wirft bei HTTP-Fehler — Status darf nie falsch 'verfügbar' melden", async () => {
  const { fn } = fakeFetch([new Response("kaputt", { status: 500 })]);
  const client = createLlmClient("ollama", { env: {}, fetchFn: fn });
  await assert.rejects(client.listModels(), (e: unknown) => e instanceof LlmProviderError);
});

test("chatLlm: Kette fallt auf zweiten Provider zurück, wenn der erste 500 liefert", async () => {
  const { fn } = fakeFetch([
    // Primary anthropic → 500 (retryable), dann Fallback openai → Erfolg.
    new Response("server error", { status: 500 }),
    new Response(JSON.stringify({
      choices: [{ message: { content: "fallback-antwort" } }],
      usage: { total_tokens: 1 },
    }), { status: 200 }),
  ]);
  const res = await chatLlm(
    { ...REQ, model: "irrelevant" },
    {
      // LLM_MODEL gesetzt → keine /models-Listenaufrufe, exakt zwei Fetches.
      providers: ["anthropic", "openai"],
      env: { LLM_MODEL: "cloud-model", ANTHROPIC_BASE_URL: "http://a:1/v1", LLM_BASE_URL: "http://o:1/v1" },
      fetchFn: fn,
      maxAttempts: 1,
    }
  );
  assert.equal(res.provider, "openai");
  assert.equal(res.content, "fallback-antwort");
});

test("chatLlm: wirft Fehler, wenn alle Provider scheitern", async () => {
  const { fn } = fakeFetch([
    new Response("server error", { status: 500 }),
    new Response("server error", { status: 503 }),
  ]);
  await assert.rejects(
    chatLlm(REQ, {
      providers: ["anthropic", "gemini"],
      env: { LLM_MODEL: "cloud-model", ANTHROPIC_BASE_URL: "http://a:1/v1", GEMINI_BASE_URL: "http://g:1/v1beta" },
      fetchFn: fn,
      maxAttempts: 1,
    }),
    (e: unknown) => e instanceof LlmProviderError
  );
});

test("chatLlm: Netzwerkfehler sind retryable und werden nach maxAttempts geworfen", async () => {
  const { fn } = fakeFetch([new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
  let attempts = 0;
  await assert.rejects(
    chatLlm(REQ, {
      providers: ["ollama"],
      env: {},
      fetchFn: fn,
      maxAttempts: 3,
      sleep: async () => { attempts++; },
    })
  );
  assert.equal(attempts, 2, "zwei Backoff-Pausen für 3 Versuche");
});
