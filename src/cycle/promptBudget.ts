/**
 * Prompt-Budget und Batch-Planung der Analysten-Schritte (CYCLE-BATCH-01).
 *
 * **Das Problem, das dieses Modul löst.** Der Technical Analyst soll bis zu
 * 40 Instrumente in EINEM Aufruf analysieren. Der Trust-Block dieses Aufrufs
 * (MTF-Konfluenz + Indikator-Messwerte je Instrument) wächst dabei linear mit
 * der Kandidatenzahl, der Prompt des Standes `v0.2.0` erreichte in einer
 * Messung mit 40 Kandidaten ~92 400 Zeichen ≈ 25 700 Tokens. Die Defaults
 * sind aber `OLLAMA_NUM_CTX=4096` (Fenster) und `LLM_MAX_TOKENS=512`
 * (Antwortlänge). Der Prompt passt also um den Faktor ~6 nicht ins Fenster,
 * und die Antwort passt nicht in die erlaubte Fertigungsänge.
 *
 * Die Folge war kein Fehler, sondern **stille Verschlechterung**: Ollama
 * kürzt die Eingabe am Fensterrand, die Antwort wird bei `num_predict`
 * abgeschnitten, das JSON ist unvollständig, der Agent-Port liefert
 * `spec.fallback` — und der Fallback des Schritts ist je Kandidat
 * `bias: NEUTRAL, technicalScore: 50`. „40 Märkte analysieren" produzierte
 * 40 neutrale Nichtaussagen, die wie Analyse aussahen. Mehr Märkte zu
 * versprechen, ohne das Budget zu teilen, bedeutet daher: mehr neutraler
 * Fallback, nicht mehr Erkenntnis.
 *
 * **Die Lösung:** Shortlist in Batches teilen, die nachweislich in Eingabe-
 * UND Ausgabebudget passen, die Batches sequenziell oder mit begrenzter
 * Nebenläufigkeit aufrufen, Ergebnisse in Eingabereihenfolge wieder
 * zusammenführen. Die Sicherheitsgrenzen bleiben unverändert (Code-Limit 40,
 * Schema-Validierung, serverseitige Überschreibung der Messwerte).
 *
 * Bewusst **keine** stillen Erhöhungen von `num_ctx` oder `LLM_MAX_TOKENS`:
 * beides bestimmt Latenz und Speicher auf der Inferenzbox des Betreibers.
 * Wer mehr pro Aufruf will, setzt die Flags selbst — der Schritt sagt ihm
 * laut, was er müsste.
 *
 * Reine Arithmetik: kein IO, keine DB, kein LLM, keine Uhr. Deterministisch
 * und damit offline testbar.
 */

import { envNumber } from "../lib/env";

/**
 * Zeichen→Token-Näherung. 3,6 Zeichen je Token ist für englisches Prosa-/
 * JSON-Gemisch eine konservative Mitte; gerundet wird **aufwärts** bei Tokens
 * und **abwärts** bei Zeichen, damit die Planung nie optimistischer ist als
 * das Modell tatsächlich Platz hat.
 */
export const CHARS_PER_TOKEN = 3.6;

/** Roboter-Kopf/JSON-Gerüst, das der Port zusätzlich anhängt (Puffer). */
export const DEFAULT_RESERVE_TOKENS = 256;

/** Untergrenze des Eingabebudgets — kleiner kann kein Batch sinnvoll sein. */
export const MIN_INPUT_TOKENS = 512;

/**
 * Erfundene Fertigungs-Tokens je Instrument-Analyse im Antwort-JSON
 * (`instrumentId`, `bias`, `technicalScore`, `trend`, `keyLevels`, `thesis`).
 * Kalibriert an der Schema-Form des Schritts; bewusst konservativ hoch, denn
 * ein zu niedriges `num_predict` ist genau der Abschneide-Fehler, den dieses
 * Modul verhindert.
 */
export const ESTIMATED_OUTPUT_TOKENS_PER_ANALYSIS = 90;

/** Auslastung des Ausgabebudgets (Abschneidesicherheit für `thesis`-Länge). */
export const OUTPUT_UTILISATION = 0.85;

/** Bounds der Steuer-Flags (Bounds-Disziplin wie `routing/turnBudget.ts`). */
export const CYCLE_BATCH_BOUNDS = {
  batchSize: [1, 40] as const,
  concurrency: [1, 8] as const,
  inputBudgetTokens: [512, 1_000_000] as const,
};

/** Alle Provider, deren Inferenz lokal in einer Box läuft (ein Slot). */
const LOCAL_PROVIDERS = new Set(["ollama"]);

/** Näherung der Tokens für `chars` Promptzeichen (aufgerundet). */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Größte Zeichenmenge, die noch in `tokens` passt (abgerundet). */
export function charsForTokens(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

export interface PromptBudget {
  /** Kontextfenster des Modells (`OLLAMA_NUM_CTX`). */
  numCtxTokens: number;
  /** Erlaubte Fertigungsänge (`LLM_MAX_TOKENS` → `num_predict`). */
  maxOutputTokens: number;
  /** Puffer für System-Prompt, Blöcke und Rundung. */
  reserveTokens: number;
  /** Davon abgeleitetes Eingabebudget je Aufruf. */
  inputTokens: number;
  /** {@link inputTokens} in Zeichen — die Kappe, die der Schritt plant. */
  inputChars: number;
  /** `env`: `CYCLE_PROMPT_INPUT_BUDGET_TOKENS` gesetzt, sonst aus num_ctx. */
  source: "derived" | "env";
}

/**
 * Liest das Budget aus der Umgebung. Bound-Verletzungen klemmt `envNumber`
 * und meldet sie laut (fail-laut-Muster GAP-02), denn ein geklemmtes Budget
 * verschiebt die Batch-Grenzen und ist Betriebsinformation.
 */
export function loadPromptBudget(env: Record<string, string | undefined> = process.env): PromptBudget {
  const numCtxTokens = envNumber("OLLAMA_NUM_CTX", 4096, 1024, 1_000_000, env);
  const maxOutputTokens = envNumber("LLM_MAX_TOKENS", 512, 32, 131_072, env);
  const reserveTokens = envNumber(
    "CYCLE_PROMPT_RESERVE_TOKENS",
    DEFAULT_RESERVE_TOKENS,
    0,
    8192,
    env,
  );
  const overrideRaw = env["CYCLE_PROMPT_INPUT_BUDGET_TOKENS"];
  const override =
    overrideRaw === undefined || overrideRaw.trim() === ""
      ? null
      : envNumber(
          "CYCLE_PROMPT_INPUT_BUDGET_TOKENS",
          MIN_INPUT_TOKENS,
          CYCLE_BATCH_BOUNDS.inputBudgetTokens[0],
          CYCLE_BATCH_BOUNDS.inputBudgetTokens[1],
          env,
        );
  const derived = Math.max(numCtxTokens - maxOutputTokens - reserveTokens, MIN_INPUT_TOKENS);
  const inputTokens = Math.trunc(override ?? derived);
  return {
    numCtxTokens,
    maxOutputTokens,
    reserveTokens,
    inputTokens,
    inputChars: charsForTokens(inputTokens),
    source: override === null ? "derived" : "env",
  };
}

/**
 * Wie viele Analysen passt in ein `num_predict`-Budget? Das ist bei den
 * Defaults (512 Tokens) der eigentlich bindingende Deckel — nicht das
 * Kontextfenster.
 */
export function maxItemsByOutput(budget: PromptBudget): number {
  const usable = budget.maxOutputTokens * OUTPUT_UTILISATION;
  return Math.max(1, Math.floor(usable / ESTIMATED_OUTPUT_TOKENS_PER_ANALYSIS));
}

export interface BatchFit {
  /** Größte zugelassene Batchgröße (Kandidaten je Aufruf). */
  maxItemsPerBatch: number;
  /** Zeichenkappe je Aufruf. */
  maxCharsPerBatch: number;
  /** Was begrenzt hat. */
  constrainedBy: "env-batch-size" | "output" | "input" | "unbounded";
  /** Empfohlene `LLM_MAX_TOKENS`, damit ALLE Kandidaten in einen Aufruf passen. */
  recommendedMaxOutputTokens: number;
}

/**
 * Leitet die Batch-Grenzen aus Budget und Kandidatenzahl ab.
 *
 * `CYCLE_ANALYST_BATCH_SIZE` (gesetzt) gewinnt immer: der Operator hat dann
 * typischerweise auch `num_ctx`/`LLM_MAX_TOKENS` hochgesetzt und übernimmt
 * die Verantwortung für die Antwortlänge.
 */
export function planBatchFit(
  itemCount: number,
  budget: PromptBudget = loadPromptBudget(),
  env: Record<string, string | undefined> = process.env,
  /**
   * Tatsächlich gemessene Prompt-Größe des Gesamtpakets (Zeichen), falls der
   * Aufrufer sie schon kennt. Nur damit ist ehrlich entscheidbar, ob das
   * Eingabefenster oder die Antwortlänge begrenzt hat — deshalb ist der Wert
   * ein Parameter und keine Schätzung dieses Moduls.
   */
  measuredChars?: number,
): BatchFit {
  const n = Math.max(0, Math.trunc(itemCount));
  const byOutput = maxItemsByOutput(budget);
  const inputIsTighter =
    typeof measuredChars === "number" && Number.isFinite(measuredChars) && measuredChars > budget.inputChars;
  const envRaw = env["CYCLE_ANALYST_BATCH_SIZE"];
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const size = envNumber(
      "CYCLE_ANALYST_BATCH_SIZE",
      byOutput,
      CYCLE_BATCH_BOUNDS.batchSize[0],
      CYCLE_BATCH_BOUNDS.batchSize[1],
      env,
    );
    return {
      maxItemsPerBatch: Math.trunc(size),
      maxCharsPerBatch: budget.inputChars,
      constrainedBy: inputIsTighter ? "input" : "env-batch-size",
      recommendedMaxOutputTokens: budget.maxOutputTokens,
    };
  }
  const itemsPerCall = n > 0 ? byOutput : 1;
  // Empfehlung: alles in einem Aufruf — wie viel `num_predict` dafür nötig wäre.
  const recommended = Math.ceil((n * ESTIMATED_OUTPUT_TOKENS_PER_ANALYSIS) / OUTPUT_UTILISATION);
  // `unbounded` heißt: in diesem Lauf hat nichts begrenzt — die Shortlist passt
  // so wohl ins Fenster als in die Antwortlänge. Das ist die Aussage, die ein
  // Operator sehen will („nichts zu tun"), nicht ein theoretischer Deckel.
  const limitedByOutput = n > byOutput;
  return {
    maxItemsPerBatch: Math.max(1, Math.min(itemsPerCall, n || 1)),
    maxCharsPerBatch: budget.inputChars,
    constrainedBy: inputIsTighter ? "input" : limitedByOutput ? "output" : "unbounded",
    recommendedMaxOutputTokens: Math.max(budget.maxOutputTokens, recommended),
  };
}

/**
 * Gieriges, deterministisches Packen in Reihenfolge der Eingabe.
 *
 * Ein Item, das allein über der Zeichenkappe liegt, wird NIEMALS verworfen —
 * es bekommt einen eigenen Batch und erscheint in {@link PackResult.oversized}
 * (sichtbar statt stillschweigend). Kein Kandidat darf durch die Planung
 * verloren gehen: wer fehlt, würde im Schritt als „nicht analysiert" enden.
 */
export interface PackOptions {
  maxItemsPerBatch: number;
  maxCharsPerBatch: number;
}

export interface PackResult<T> {
  batches: T[][];
  /** Zeichen je Batch (für Log/Metrik). */
  chars: number[];
  /** Items, die allein über der Kappe lagen. */
  oversized: T[];
}

export function packBatches<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  options: PackOptions,
): PackResult<T> {
  const maxItems = Math.max(1, Math.trunc(options.maxItemsPerBatch));
  const maxChars = Math.max(1, Math.trunc(options.maxCharsPerBatch));
  const batches: T[][] = [];
  const chars: number[] = [];
  const oversized: T[] = [];
  let current: T[] = [];
  let used = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    batches.push(current);
    chars.push(used);
    current = [];
    used = 0;
  };

  for (const item of items) {
    const size = Math.max(1, Math.trunc(sizeOf(item)) || 1);
    if (size > maxChars) oversized.push(item);
    const fits = current.length > 0 && current.length < maxItems && used + size <= maxChars;
    if (!fits) flush();
    current.push(item);
    used += size;
    // Volle Batch sofort schließen — nächstes Item startet einen neuen.
    if (current.length >= maxItems) flush();
  }
  flush();

  return { batches, chars, oversized };
}

export interface ConcurrencyDecision {
  concurrency: number;
  source: "env" | "provider";
  /** Menschlich lesbarer Grund (Log/Panel, nie ein Secret). */
  reason: string;
}

/**
 * Nebenläufigkeit der LLM-Aufrufe.
 *
 * Parallelisierung ist hier kein Gratis-Gewinn: eine lokale
 * Ollama-Instanz bedient standardmäßig EINEN Inferenz-Slot. Zwei gleichzeitige
 * Batches laufen dort nicht parallel, sie stehen in einer Warteschlange und
 * verdrängen sich gegenseitig im KV-Cache — die Wandzeit steigt eher. Für
 * Cloud-Provider (OpenAI/Gemini/Anthropic) dagegen ist Parallelität real.
 *
 * Deshalb: Default `1` bei lokalem Provider, `2` bei Remote-Providern,
 * `CYCLE_ANALYST_CONCURRENCY` (Bounds [1, 8]) übersteuert beides.
 */
export function resolveConcurrency(
  env: Record<string, string | undefined> = process.env,
  provider: string = "",
): ConcurrencyDecision {
  const raw = env["CYCLE_ANALYST_CONCURRENCY"];
  if (raw !== undefined && raw.trim() !== "") {
    const value = envNumber(
      "CYCLE_ANALYST_CONCURRENCY",
      1,
      CYCLE_BATCH_BOUNDS.concurrency[0],
      CYCLE_BATCH_BOUNDS.concurrency[1],
      env,
    );
    return {
      concurrency: Math.trunc(value),
      source: "env",
      reason: `CYCLE_ANALYST_CONCURRENCY=${raw.trim()}`,
    };
  }
  const normalized = provider.trim().toLowerCase();
  if (normalized === "" || LOCAL_PROVIDERS.has(normalized)) {
    return {
      concurrency: 1,
      source: "provider",
      reason: `Provider ${normalized || "ollama"} bedient einen Inferenz-Slot — Parallelität würde nur Schlange stehen`,
    };
  }
  return {
    concurrency: 2,
    source: "provider",
    reason: `Provider ${normalized} ist remote — 2 Batches parallel`,
  };
}

/**
 * Map mit begrenzter Nebenläufigkeit, ergebniserhaltend in Eingabereihenfolge.
 *
 * Fehler eines Items werden NICHT geschluckt: der Worker selbst entscheidet,
 * ob er wirft oder ein Ergebnis liefert (der Schritt wandelt Batch-Fehler in
 * seinen ehrlichen Fallback). Die Reihenfolge der Ergebnisse ist unabhängig
 * von der Fertigstellungsreihenfolge — sonst wäre das Artefakt
 * nicht-reproduzierbar.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let w = 0; w < width; w++) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next++;
          if (index >= items.length) return;
          results[index] = await worker(items[index], index);
        }
      })(),
    );
  }
  await Promise.all(runners);
  return results;
}
