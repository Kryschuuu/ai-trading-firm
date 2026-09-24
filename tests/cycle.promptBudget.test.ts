/**
 * Tests der Prompt-Budget- und Batch-Planung (CYCLE-BATCH-01).
 *
 * Rein rechnerisch, ohne LLM, ohne DB, ohne Uhr: genau das ist der Zweck des
 * Moduls — die Planung muss deterministisch sein, sonst ist ein Zyklus-Artefakt
 * nicht reproduzierbar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARS_PER_TOKEN,
  ESTIMATED_OUTPUT_TOKENS_PER_ANALYSIS,
  OUTPUT_UTILISATION,
  charsForTokens,
  estimateTokens,
  loadPromptBudget,
  mapBounded,
  maxItemsByOutput,
  packBatches,
  planBatchFit,
  resolveConcurrency,
} from "../src/cycle/promptBudget";

const ENV_KEYS = [
  "OLLAMA_NUM_CTX",
  "LLM_MAX_TOKENS",
  "CYCLE_PROMPT_RESERVE_TOKENS",
  "CYCLE_PROMPT_INPUT_BUDGET_TOKENS",
  "CYCLE_ANALYST_BATCH_SIZE",
  "CYCLE_ANALYST_CONCURRENCY",
];

function withEnv<T>(values: Record<string, string>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Schätzung ────────────────────────────────────────────────────────────────

test("estimateTokens/charsForTokens: Rundung ist immer zur sicheren Seite", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(-10), 0);
  // aufgerundet: ein halber Token darf nicht als ganzer durchgehen
  assert.equal(estimateTokens(CHARS_PER_TOKEN * 10 + 1), 11);
  // abgerundet: ein halbes Zeichen passt nicht mehr ins Budget
  assert.equal(charsForTokens(10), Math.floor(CHARS_PER_TOKEN * 10));
  // Hin und zurück bleibt die KappeUnterschreitung erhalten
  const chars = 12_345;
  assert.ok(chars <= charsForTokens(estimateTokens(chars)) + CHARS_PER_TOKEN);
});

test("loadPromptBudget: Default- Konfiguration lässt 40-Instrumente-PROMPT nicht zu", () => {
  const budget = withEnv({}, () => loadPromptBudget({}));
  assert.equal(budget.numCtxTokens, 4096);
  assert.equal(budget.maxOutputTokens, 512);
  assert.equal(budget.source, "derived");
  assert.equal(budget.inputTokens, 4096 - 512 - 256);
  assert.equal(budget.inputChars, charsForTokens(budget.inputTokens));
  // Der gemessene 40er-Prompt aus v0.2.0 (≈92 400 Zeichen) wäre damit unzulässig.
  assert.ok(92_400 > budget.inputChars, "Prompt wäre über dem Budget — genau der Befund");
});

test("loadPromptBudget: sehr kleines num_ctx bleibt bei der Untergrenze stehen", () => {
  const budget = loadPromptBudget({ OLLAMA_NUM_CTX: "1024", LLM_MAX_TOKENS: "900" });
  assert.equal(budget.inputTokens, 512, "1024−900−256 wäre negativ → Mindestbudget");
});

test("loadPromptBudget: Env-Override schlägt die Herleitung, Unsinn wird geklemmt", () => {
  const overridden = loadPromptBudget({ CYCLE_PROMPT_INPUT_BUDGET_TOKENS: "9000" });
  assert.equal(overridden.inputTokens, 9000);
  assert.equal(overridden.source, "env");

  const tiny = loadPromptBudget({ CYCLE_PROMPT_INPUT_BUDGET_TOKENS: "10" });
  assert.equal(tiny.inputTokens, 512, "unter der Untergrenze → Bound statt Chaos");

  // Ein unlesbarer Override wird NICHT auf „ignoriert ⇒ großes Budget"
  // gedreht, sondern auf die konservative Untergrenze: ein Tippfehler darf
  // den Prompt nicht größer machen als vorher, er macht ihn kleiner (mehr
  // Batches, gleiche Korrektheit) und `envNumber` meldet ihn laut.
  const junk = loadPromptBudget({ CYCLE_PROMPT_INPUT_BUDGET_TOKENS: "abc", OLLAMA_NUM_CTX: "" });
  assert.equal(junk.inputTokens, 512);
  assert.equal(junk.source, "env");
});

// ── Ausgabebudget ────────────────────────────────────────────────────────────

test("maxItemsByOutput: num_predict=512 deckt 4 Analysen ab, nicht 40", () => {
  const budget = loadPromptBudget({});
  assert.equal(maxItemsByOutput(budget), 4);
  const roomy = loadPromptBudget({ LLM_MAX_TOKENS: "4096" });
  assert.equal(
    maxItemsByOutput(roomy),
    Math.floor((4096 * OUTPUT_UTILISATION) / ESTIMATED_OUTPUT_TOKENS_PER_ANALYSIS),
  );
});

test("planBatchFit: ohne Messung begrenzt das Ausgabebudget; mit Messung das Fenster", () => {
  const budget = loadPromptBudget({});
  const blind = planBatchFit(40, budget, {});
  assert.equal(blind.maxItemsPerBatch, 4, "num_predict=512 ⇒ 4 Analysen je Aufruf");
  assert.equal(blind.constrainedBy, "output", "ohne Messung wird nicht behauptet, das Fenster sei schuld");
  assert.equal(blind.recommendedMaxOutputTokens, Math.ceil((40 * 90) / OUTPUT_UTILISATION));

  // Gemessener 40er-Prompt (v0.2.0: ~92 400 Zeichen) übersteigt 11 980 Zeichen
  // Kappe ⇒ der Schritt sagt „input" und teilt zusätzlich nach Zeichen auf.
  const measured = planBatchFit(40, budget, {}, 92_400);
  assert.equal(measured.constrainedBy, "input");
  assert.equal(measured.maxCharsPerBatch, budget.inputChars);
});

test("planBatchFit: kleine Shortlist passt unbegrenzt, Env-Override gewinnt", () => {
  const small = planBatchFit(2, loadPromptBudget({}), {});
  assert.equal(small.maxItemsPerBatch, 2, "nie mehr Items als Kandidaten");
  assert.equal(small.constrainedBy, "unbounded", "nichts hat begrenzt ⇒ kein Deckel behaupten");

  const forced = planBatchFit(40, loadPromptBudget({}), { CYCLE_ANALYST_BATCH_SIZE: "40" });
  assert.equal(forced.maxItemsPerBatch, 40);
  assert.equal(forced.constrainedBy, "env-batch-size");

  // Bound: 99 wird auf das Code-Shortlist-Limit 40 geklemmt, nicht durchgereicht.
  const clamped = planBatchFit(40, loadPromptBudget({}), { CYCLE_ANALYST_BATCH_SIZE: "99" });
  assert.equal(clamped.maxItemsPerBatch, 40);
});

// ── Packung ──────────────────────────────────────────────────────────────────

test("packBatches: Reihenfolge und Vollständigkeit bleiben erhalten", () => {
  const ids = Array.from({ length: 11 }, (_, i) => `I${i}`);
  const packed = packBatches(ids, () => 100, { maxItemsPerBatch: 4, maxCharsPerBatch: 1000 });
  assert.deepEqual(packed.batches.flat(), ids);
  assert.deepEqual(packed.batches.map((b) => b.length), [4, 4, 3]);
  assert.equal(packed.oversized.length, 0);
});

test("packBatches: Zeichenkappe teilt, bevor das Item-Limit erreicht ist", () => {
  const sizes = new Map([
    ["A", 600],
    ["B", 600],
    ["C", 100],
  ]);
  const packed = packBatches(["A", "B", "C"], (id) => sizes.get(id) ?? 0, {
    maxItemsPerBatch: 40,
    maxCharsPerBatch: 1000,
  });
  assert.deepEqual(packed.batches, [["A"], ["B", "C"]]);
  assert.deepEqual(packed.chars, [600, 700]);
});

test("packBatches: ein einzelnes Riesen-Item wird nicht verworfen, sondern gemeldet", () => {
  const packed = packBatches(["klein", "RIESIG", "klein2"], (id) => (id === "RIESIG" ? 5000 : 10), {
    maxItemsPerBatch: 40,
    maxCharsPerBatch: 100,
  });
  assert.deepEqual(packed.batches.flat(), ["klein", "RIESIG", "klein2"]);
  assert.deepEqual(packed.oversized, ["RIESIG"]);
});

test("packBatches: leere Eingabe erzeugt keine Batch (kein Leerlauf-Aufruf)", () => {
  const packed = packBatches([] as string[], () => 1, { maxItemsPerBatch: 4, maxCharsPerBatch: 10 });
  assert.deepEqual(packed.batches, []);
  assert.deepEqual(packed.chars, []);
});

// ── Nebenläufigkeit ──────────────────────────────────────────────────────────

test("resolveConcurrency: lokale Inferenz serialisiert, Remote liefert 2, Env überstimmt", () => {
  assert.equal(resolveConcurrency({}, "ollama").concurrency, 1);
  assert.equal(resolveConcurrency({}, "").concurrency, 1, "ohne Provider-Angabe: sicher serialisieren");
  assert.match(resolveConcurrency({}, "ollama").reason, /Inferenz-Slot/);
  assert.equal(resolveConcurrency({}, "openai").concurrency, 2);
  assert.equal(resolveConcurrency({ CYCLE_ANALYST_CONCURRENCY: "6" }, "ollama").concurrency, 6);
  assert.equal(resolveConcurrency({ CYCLE_ANALYST_CONCURRENCY: "99" }, "ollama").concurrency, 8);
  assert.equal(resolveConcurrency({ CYCLE_ANALYST_CONCURRENCY: "0" }, "openai").concurrency, 1);
});

test("mapBounded: Ergebnisse stehen in Eingabereihenfolge, auch wenn spätes Item früher fertig ist", async () => {
  const order = [5, 1, 3, 2, 4];
  const out = await mapBounded(order, 3, async (delay) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return delay;
  });
  assert.deepEqual(out, order);
});

test("mapBounded: Nie-mehr-als-limit laufen gleichzeitig", async () => {
  let live = 0;
  let peak = 0;
  await mapBounded(Array.from({ length: 9 }, (_, i) => i), 3, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 2));
    live -= 1;
    return null;
  });
  assert.equal(peak, 3, `Peak ${peak} sollte genau die Limit sein`);
});

test("mapBounded: ein Fehler wirft (der Aufrufer entscheidet über Fallback)", async () => {
  await assert.rejects(
    () =>
      mapBounded([1, 2, 3], 1, async (n) => {
        if (n === 2) throw new Error("turn budget bruch");
        return n;
      }),
    /turn budget bruch/,
  );
});

test("mapBounded: leere Liste kostet keinen Worker", async () => {
  let calls = 0;
  const out = await mapBounded([] as number[], 4, async () => {
    calls += 1;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
