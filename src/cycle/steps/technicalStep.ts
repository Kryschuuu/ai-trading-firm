/**
 * Step 4: Technical Analyst (08:00 UTC).
 *
 * Führt Multi-Timeframe-Technische-Analyse durch.
 * HARTE CODE-GRENZE: Nur die Top-40 der Daily Candidate List werden analysiert.
 * Wird ein 41. Instrument übergeben, schlägt die Validierung mit ShortlistLimitExceededError fehl.
 *
 * RMA-P2-03 (v1.62.0): Vor dem LLM berechnet der Step je Kandidat einen
 * deterministischen MTF-Konfluenzsnapshot (`mtf-confluence@1`, as-of-
 * ausgerichtet, nur geschlossene Bars). Der Snapshot läuft als GETRENNTE
 * `trustedData` in den Prompt (das Modell darf ihn erläutern, aber nicht
 * überschreiben) und wird nach der Validierung serverseitig an jede Analyse
 * angehängt (`analysis.confluence` + `confluenceMeta`, additiv, versioniert).
 * `CONFLUENCE_ENABLED=false` schaltet auf den Legacy-Output zurück.
 *
 * VBF-P2-01 (v0.2.0): Trusted RSI/ATR/ADX/MACD laufen unabhängig vom
 * Konfluenz-Flag; die Messwerte werden NACH der Validierung über die
 * Modellwerte geschrieben. Fehlt die Historie, bleiben die Felder leer.
 *
 * CYCLE-BATCH-01 (dieser Zyklus): Der Prompt je Aufruf wird am tatsächlichen
 * Token-Budget vermessen (`OLLAMA_NUM_CTX`, `LLM_MAX_TOKENS`). Passt die
 * ganze Shortlist nicht hinein, zerfällt der Schritt in deterministisch
 * gepackte Batches, die nacheinander oder mit begrenzter Nebenläufigkeit
 * laufen, und führt die Analysen in Eingabereihenfolge wieder zusammen.
 * Der Grund ist kein Komfort, sondern Korrektheit: ein über langes Prompt-
 * Material wird am Kontextfenster abgeschnitten, das JSON unvollständig, und
 * der Agent-Port antwortet dann mit dem Neutral-Fallback — für ALLE
 * Kandidaten. Ohne Aufteilung bedeutet „mehr Märkte" also „mehr neutrales
 * Nichts". Zusätzlich rauscht der Prompt nicht mehr doppelt: die
 * Voll-Snapshots bleiben im Artefakt (serverseitige Anhängung), wandern aber
 * nur noch ins Prompt-Material, solange das Budget es hergibt — die
 * kompakte `lines`-Form enthält dieselben Zahlen.
 * Der Schritt wirft nie still auf Neutral: jeder Fallback-Batch wird in
 * `promptFit.failedBatches` gezählt und laut geloggt.
 */

import { confluenceBatchFromStore } from "@/confluence/adapters";
import { formatConfluenceLine } from "@/confluence/confluence";
import { isConfluenceEnabled, loadConfluenceConfig } from "@/confluence/config";
import { CONFLUENCE_FORMULA_VERSION, type ConfluenceSnapshot } from "@/confluence/types";
import { HistoricalStore } from "@/lib/marketdata/historicalStore";
import { historyDir } from "@/lib/marketdata/config";
import { resolveProviderChain } from "@/lib/llmProvider";
import {
  applyTrustedReadings,
  indicatorPayload,
  loadTrustedIndicators,
  TRUSTED_INDICATOR_VERSION,
  type TrustedIndicatorPayload,
  type TrustedReading,
} from "@/cycle/trustedIndicators";
import { buildAgentPayloadPrompt } from "@/cycle/promptPayload";
import {
  estimateTokens,
  loadPromptBudget,
  mapBounded,
  packBatches,
  planBatchFit,
  resolveConcurrency,
} from "@/cycle/promptBudget";
import type { StepDefinition, StepExecutionContext } from "../types";
import {
  type TechnicalConfluenceMeta,
  type TechnicalPromptFitMeta,
  type TechnicalStepOutput,
  type InstrumentTechnicalAnalysis,
  validateTechnicalOutput,
} from "../schemas";
import { assertShortlistLimit } from "../security";
import type { SelectionStepOutput } from "../schemas";

export interface TechnicalStepInput {
  candidates?: Array<{ instrumentId: string; rank?: number; score?: number }>;
}

/** Kurz-Schema, das dem Modell die erwartete Form vorgibt (unverändert). */
const TECHNICAL_SCHEMA_HINT = `JSON schema:
{
  "analyses": [
    {
      "instrumentId": "string",
      "bias": "BULLISH|BEARISH|NEUTRAL",
      "technicalScore": 75.0,
      "rsi": 54.2,
      "atr": 1.5,
      "trend": "bullish",
      "keyLevels": { "support": 100, "resistance": 110 },
      "thesis": "string"
    }
  ],
  "analyzedCount": number
}`;

export const technicalStep: StepDefinition<TechnicalStepInput, TechnicalStepOutput> = {
  stepId: "04-technical-analyst",
  name: "Technical Analyst",
  role: "TECHNICAL_ANALYST",
  timeWindow: "08:00-09:00",
  llmAllowed: true,
  retryPolicy: {
    maxAttempts: 2,
    backoffMs: 200,
  },

  validateInput(input: unknown): TechnicalStepInput {
    let list: Array<{ instrumentId: string }> = [];
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      if (Array.isArray(obj.candidates)) {
        list = obj.candidates as Array<{ instrumentId: string }>;
      }
    }

    // HARTE CODE-GRENZE: 41+ Instrumente werden strikt abgewiesen
    assertShortlistLimit(list, 40);

    return { candidates: list };
  },

  async execute(context: StepExecutionContext<TechnicalStepInput>): Promise<TechnicalStepOutput> {
    const selection =
      context.input?.candidates ??
      (context.previousStepOutputs["03-market-selection"] as SelectionStepOutput | undefined)?.candidates ??
      [];

    // Erneute Prüfung der Code-Grenze am Ausführungspunkt
    assertShortlistLimit(selection, 40);

    context.log(`Starte Technische Analyse für ${selection.length} Instrumente (Code-Limit: max. 40) …`);

    // ── RMA-P2-03: Deterministische Konfluenz VOR dem LLM ───────────────────
    // Ein Batch über den Historical Store (genau EINE Datei-Ladung), as-of =
    // Step-Zeit. Fehlende/stale Reihen ergeben ehrliche ABSTAIN-Snapshots —
    // der Step läuft für die übrigen Kandidaten weiter (fail-closed je Reihe).
    const asOfMs = context.asOf instanceof Date ? context.asOf.getTime() : Date.now();
    let sharedStore: HistoricalStore | null = null;
    const openStore = (): HistoricalStore => (sharedStore ??= new HistoricalStore(historyDir()));
    let snapshots = new Map<string, ConfluenceSnapshot>();
    let confluenceMeta: TechnicalConfluenceMeta | undefined;
    const confluenceEnabled = isConfluenceEnabled(process.env, (line) =>
      context.log(`Konfluenz-Flag: ${line}`, "WARN"),
    );
    if (confluenceEnabled && selection.length > 0) {
      try {
        const config = loadConfluenceConfig();
        const store = openStore();
        snapshots = confluenceBatchFromStore(
          store,
          selection.map((c) => c.instrumentId),
          asOfMs,
          config,
          { source: "cycle", computedAtMs: context.clock.nowMs() },
        );
        let ok = 0;
        let degraded = 0;
        let abstained = 0;
        for (const snap of snapshots.values()) {
          if (snap.status === "OK") ok += 1;
          else if (snap.status === "DEGRADED") degraded += 1;
          else abstained += 1;
        }
        confluenceMeta = {
          formulaVersion: CONFLUENCE_FORMULA_VERSION,
          configVersion: config.version,
          asOf: new Date(asOfMs).toISOString(),
          computed: snapshots.size,
          ok,
          degraded,
          abstained,
        };
        context.log(
          `MTF-Konfluenz (${confluenceMeta.formulaVersion}, Config v${confluenceMeta.configVersion}): ` +
            `${snapshots.size} Snapshots (OK ${ok} / DEGRADED ${degraded} / ABSTAIN ${abstained}).`,
        );
      } catch (e) {
        // Die Konfluenz darf den Analysten nie zu Fall bringen: laut loggen
        // (kein stilles Schlucken) und ohne Snapshot fortfahren — der Output
        // bleibt additiv kompatibel (Felder fehlen statt zu lügen).
        context.log(
          `MTF-Konfluenz nicht berechenbar (${e instanceof Error ? e.message : String(e)}) — fahre ohne Snapshot fort.`,
          "WARN",
        );
        snapshots = new Map();
        confluenceMeta = undefined;
      }
    } else if (!confluenceEnabled) {
      context.log("MTF-Konfluenz via CONFLUENCE_ENABLED=false deaktiviert (Legacy-Output).");
    }

    // Trusted RSI/ATR/ADX/MACD unabhängig von CONFLUENCE_ENABLED. Ein
    // Store-Fehler löscht die Messung — er erfindet kein rsi: 50.
    let indicatorReadings = new Map<string, TrustedReading>();
    if (selection.length > 0) {
      try {
        indicatorReadings = loadTrustedIndicators(
          openStore(),
          selection.map((c) => c.instrumentId),
          asOfMs,
        );
        const measured = [...indicatorReadings.values()].filter((reading) => reading.rsi != null).length;
        context.log(
          `Trusted Indicators (${TRUSTED_INDICATOR_VERSION}): ${indicatorReadings.size} Instrumente, ` +
            `${measured} mit gemessenen RSI (geschlossene 1h-Bars).`,
        );
      } catch (e) {
        context.log(
          `Trusted Indicators nicht lesbar (${e instanceof Error ? e.message : String(e)}) — RSI/ATR werden nicht erfunden.`,
          "WARN",
        );
        indicatorReadings = new Map();
      }
    }

    // Standard-Fallback je Kandidat (mit autoritativen Snapshots).
    // Kein rsi: 50 — das wäre eine erfundene Neutralmessung.
    const defaultAnalysisFor = (instrumentId: string): InstrumentTechnicalAnalysis => ({
      instrumentId,
      bias: "NEUTRAL" as const,
      technicalScore: 50,
      trend: "neutral",
      keyLevels: { support: 0, resistance: 0 },
      thesis: "Reguläre Konsolidierung im 4h/1h-Chart (Deterministischer Fallback)",
      ...(snapshots.get(instrumentId) ? { confluence: snapshots.get(instrumentId)! } : {}),
    });

    if (selection.length === 0) {
      return {
        analyses: [],
        analyzedCount: 0,
        ...(confluenceMeta ? { confluenceMeta } : {}),
      };
    }

    const systemPrompt = `You are the Technical Analyst of an autonomous trading firm.
Analyze the provided shortlist of market instruments (strictly bounded to max 40).
Return EXACTLY ONE analysis object per listed instrument, in the listed order — no additions, no omissions.
For each instrument, determine:
- bias: BULLISH | BEARISH | NEUTRAL
- technicalScore: 0 to 100
- trend and key support/resistance levels
- concise technical thesis (max 2 sentences)
Do not invent RSI or ATR. Code overwrites those fields from closed 1h candles after validation. If trusted indicators are missing, omit the numbers — never substitute 50.
ADX, VWAP and MACD in the trusted block are measurements too. Explain them; do not recompute them.
${snapshots.size > 0 ? "A TRUSTED DETERMINISTIC DATA block carries the precomputed multi-timeframe confluence per instrument. Explain it in your thesis where relevant, but NEVER recompute or override its numbers — your bias/score must stay consistent with an ABSTAIN status (no signal) and must not contradict a high-confidence confluence direction without explicit justification." : ""}
Respond strictly with valid JSON conforming to the schema.`;

    const ids = selection.map((c) => c.instrumentId);

    // ── CYCLE-BATCH-01: Trusted-/Untrusted-Blöcke je Batch ──────────────────
    // Dieselben Bausteine, dieselbe Reihenfolge — nur die Teilmenge der
    // Kandidaten wechselt. Ein Batch enthält ausschließlich seine eigenen
    // Messwerte, damit das Modell nicht 40 Zeilen lesen muss, um 4 zu
    // beantworten (das war der Haupttreiber der Prompt-Größe).
    const trustedFor = (batchIds: readonly string[], includeFullSnapshots: boolean): unknown => {
      const snaps = batchIds
        .map((id) => snapshots.get(id))
        .filter((snap): snap is ConfluenceSnapshot => snap !== undefined);
      const readings = batchIds
        .map((id) => indicatorReadings.get(id))
        .filter((reading): reading is TrustedReading => reading !== undefined);
      const indicatorBlock: TrustedIndicatorPayload | undefined =
        readings.length > 0
          ? indicatorPayload(new Map(readings.map((reading) => [reading.instrumentId, reading])), asOfMs)
          : undefined;
      // Konfluenz behält `kind`. Indikatoren hängen darunter. Ohne Konfluenz
      // ist der Indikator-Block selbst trustedData — das Flag schaltet ihn nicht ab.
      const confluenceTrusted =
        snaps.length > 0
          ? {
              kind: "mtf-confluence" as const,
              formulaVersion: confluenceMeta?.formulaVersion ?? "mtf-confluence@1",
              configVersion: confluenceMeta?.configVersion ?? 1,
              asOf: new Date(asOfMs).toISOString(),
              lines: snaps.map(formatConfluenceLine),
              // Die Voll-Snapshots sind dieselben Zahlen wie `lines`, nur
              // ausführlich. Nur bei Platz im Budget im Prompt; im Artefakt
              // stehen sie immer (serverseitige Anhängung nach der Validierung).
              ...(includeFullSnapshots ? { snapshots: snaps } : {}),
            }
          : undefined;
      return confluenceTrusted
        ? { ...confluenceTrusted, ...(indicatorBlock ? { indicators: indicatorBlock } : {}) }
        : indicatorBlock;
    };

    const byId = new Map(selection.map((c) => [c.instrumentId, c] as const));
    const untrustedFor = (batchIds: readonly string[]) => ({
      instrumentsToAnalyze: batchIds.map((id) => byId.get(id) ?? { instrumentId: id }),
    });

    const userPromptFor = (batchIds: readonly string[]) =>
      `Analyze the following ${batchIds.length} instrument(s) — one analysis object each, same order:\n` +
      `${JSON.stringify(batchIds)}\n${TECHNICAL_SCHEMA_HINT}`;

    // ── Fit-Planung ────────────────────────────────────────────────────────
    // Reihenfolge ist Absicht: erst gemessen, dann geplant. Eine Planung ohne
    // Messung würde raten — und „raten, ob der Prompt passt" ist genau der
    // Fehler, den dieser Zyklus behebt.
    const budget = loadPromptBudget(process.env);
    // Baseline = Prompt OHNE Instrumentdaten; die Kosten je Kandidat sind die
    // Differenz. So addiert die Packung nur das, was der Kandidat wirklich
    // kostet, statt den Prompt-Kopf 40× zu zählen.
    const baseChars = buildAgentPayloadPrompt(userPromptFor([]), undefined, undefined).length;
    const measure = (batchIds: readonly string[], fullSnapshots: boolean): number =>
      baseChars +
      buildAgentPayloadPrompt("", trustedFor(batchIds, fullSnapshots), untrustedFor(batchIds)).length;

    const compactAllChars = measure(ids, false);
    const fit = planBatchFit(ids.length, budget, process.env, compactAllChars);
    const capacityChars = Math.max(1, budget.inputChars - baseChars);
    const marginalCache = new Map<string, number>();
    const marginalChars = (id: string): number => {
      const cached = marginalCache.get(id);
      if (cached !== undefined) return cached;
      const size = Math.max(1, measure([id], false) - baseChars);
      marginalCache.set(id, size);
      return size;
    };
    const singleFits = compactAllChars <= budget.inputChars && ids.length <= fit.maxItemsPerBatch;
    const packed = singleFits
      ? { batches: [ids], chars: [compactAllChars - baseChars], oversized: [] as string[] }
      : packBatches(ids, marginalChars, {
          maxItemsPerBatch: fit.maxItemsPerBatch,
          maxCharsPerBatch: capacityChars,
        });
    const batches: string[][] = packed.batches;

    // Redundanz-Hebel JE Batch: die Voll-Snapshots sind dieselben Zahlen wie
    // `lines`, nur ausführlich. Global zu streichen, weil die ganze Shortlist
    // nicht ins Fenster passt, würde Information vernichten, die im einzelnen
    // Aufruf sehr wohl Platz hätte.
    const fullSnapshotsFor = batches.map((batchIds) => measure(batchIds, true) <= budget.inputChars);
    const droppedSnapshotBatches = fullSnapshotsFor.filter((include) => !include).length;
    if (droppedSnapshotBatches > 0) {
      context.log(
        `Prompt-Budget ${budget.inputTokens} tok reicht in ${droppedSnapshotBatches}/${batches.length} ` +
          "Batch(es) nicht für die Voll-Snapshots — die Zeilenform enthält dieselben Werte (~6× kleiner).",
        "WARN",
      );
    }
    if (packed.oversized.length > 0) {
      context.log(
        `${packed.oversized.length} Kandidat(en) sprengen selbst die Kappe eines Leeraufrufs — sie laufen ` +
          "allein weiter, das Modell kann dort am Fensterrand geschnitten werden (sichtbar, nicht still).",
        "WARN",
      );
    }

    const provider = resolveProviderChain(process.env)[0] ?? "ollama";
    const concurrency = resolveConcurrency(process.env, provider);

    if (!singleFits) {
      context.log(
        `Prompt-Fit: ${batches.length} LLM-Aufruf/Aufrufe à ≤ ${fit.maxItemsPerBatch} Kandidaten ` +
          `(begrenzt durch ${fit.constrainedBy}; num_predict=${budget.maxOutputTokens}, ` +
          `num_ctx=${budget.numCtxTokens}${budget.source === "env" ? ", Eingabebudget via Env" : ""}). ` +
          `Nebenläufigkeit ${concurrency.concurrency} (${concurrency.reason}).` +
          (fit.recommendedMaxOutputTokens > budget.maxOutputTokens
            ? ` Ein einziger Aufruf bräuchte LLM_MAX_TOKENS≥${fit.recommendedMaxOutputTokens}.`
            : ""),
        "WARN",
      );
    } else {
      context.log(
        `Prompt-Fit: ${compactAllChars} chars ≈ ${estimateTokens(compactAllChars)} tok — ein Aufruf (Budget ${budget.inputTokens} tok).`,
      );
    }

    // Ein Batch-Aufruf: identische Port-Signatur wie vor der Änderung, nur
    // mit der Teilmenge der Kandidaten. Der Fallback je Batch ist der
    // Neutral-Fallback DIESER Kandidaten — nicht der ganzen Shortlist.
    type BatchResult = {
      /** Validierter (oder überdeckter) Output DIESER Kandidaten. */
      output: TechnicalStepOutput;
      /** `true` = kein Modellbeitrag, alles aus `defaultAnalysisFor`. */
      usedFallback: boolean;
    };
    const runBatch = async (batchIds: readonly string[], includeFullSnapshots: boolean): Promise<BatchResult> => {
      const fallback: TechnicalStepOutput = {
        analyses: batchIds.map((id) => defaultAnalysisFor(id)),
        analyzedCount: batchIds.length,
        ...(confluenceMeta ? { confluenceMeta } : {}),
      };
      const trusted = trustedFor(batchIds, includeFullSnapshots);
      const res = await context.ports.agent.invokeAgent<TechnicalStepOutput>({
        role: "TECHNICAL_ANALYST",
        systemPrompt,
        userPrompt: userPromptFor(batchIds),
        ...(trusted !== undefined ? { trustedData: trusted } : {}),
        untrustedData: untrustedFor(batchIds),
        schemaValidator: validateTechnicalOutput,
        fallback,
      });
      return {
        output: { ...res.output, analyses: res.output.analyses ?? fallback.analyses },
        usedFallback: res.usedFallback === true,
      };
    };

    let failedBatches = 0;
    let fallbackInstruments = 0;
    let thrownError: unknown = null;
    const batchResults = await mapBounded(batches, concurrency.concurrency, async (batchIds, index) => {
      try {
        const result = await runBatch(batchIds, fullSnapshotsFor[index] === true);
        if (result.usedFallback) {
          failedBatches += 1;
          fallbackInstruments += batchIds.length;
        }
        return result;
      } catch (err) {
        // EIN Batch (Heutiges Verhalten): der Wurf geht nach oben und der
        // Step-Retry/Cycle-Abbruch greift wie bisher. Mehrere Batches: ein
        // Batch-Fehler darf die übrigen nicht entwerten — der Batch wird auf
        // seinen Neutral-Fallback gesetzt und ist in `promptFit` zählbar.
        if (batches.length === 1) throw err;
        failedBatches += 1;
        fallbackInstruments += batchIds.length;
        thrownError ??= err;
        // Alles neutral = der Analyst hat nichts beigetragen. Das ist kein
        // Detail für eine Zeile im Log, sondern der Ausfall des Schritts.
        context.log(
          `Batch ${index + 1}/${batches.length} fehlgeschlagen ` +
            `(${err instanceof Error ? err.message.slice(0, 160) : String(err)}) — ` +
            `${batchIds.length} Kandidaten auf deterministischem Fallback.`,
          failedBatches === batches.length ? "CRITICAL" : "WARN",
        );
        return {
          output: {
            analyses: batchIds.map((id) => defaultAnalysisFor(id)),
            analyzedCount: batchIds.length,
          },
          usedFallback: true,
        };
      }
    });

    // Merge in Batch-Reihenfolge (= Eingabereihenfolge), erstes Vorkommen je
    // Instrument zählt (kein Modell kann durch Duplikate aufblähen).
    const merged: InstrumentTechnicalAnalysis[] = [];
    const seen = new Set<string>();
    for (const result of batchResults) {
      for (const analysis of result.output.analyses ?? []) {
        if (seen.has(analysis.instrumentId)) continue;
        seen.add(analysis.instrumentId);
        merged.push(analysis);
      }
    }

    // Validierung der Ausgabegrenze (unverändert, jetzt auf den Merge)
    assertShortlistLimit(merged, 40);

    // Autoritative Anhängung NACH der Validierung: was das LLM auch immer
    // zurückgab — der Snapshot je Instrument ist der codeseitig berechnete
    // (kein Override-Pfad, idempotent über snapshotKey).
    if (snapshots.size > 0) {
      for (const analysis of merged) {
        const snap = snapshots.get(analysis.instrumentId);
        if (snap) analysis.confluence = snap;
      }
    }
    applyTrustedReadings(merged, indicatorReadings);

    const incomplete = seen.size < ids.length;
    const promptFit: TechnicalPromptFitMeta = {
      inputTokens: budget.inputTokens,
      inputChars: budget.inputChars,
      maxOutputTokens: budget.maxOutputTokens,
      maxItemsPerBatch: fit.maxItemsPerBatch,
      constrainedBy: fit.constrainedBy,
      calls: batches.length,
      concurrency: concurrency.concurrency,
      droppedFullSnapshots: droppedSnapshotBatches > 0,
      failedBatches,
      fallbackInstruments,
      recommendedMaxOutputTokens: fit.recommendedMaxOutputTokens,
      incomplete,
    };

    if (failedBatches > 0) {
      context.log(
        `Hinweis: ${fallbackInstruments} von ${ids.length} Analysen stammen NICHT vom Modell, sondern ` +
          `aus dem deterministischen Fallback (${failedBatches} Batch/Batches). Diese Werte sind neutral ` +
          "und keine Messung — Forschung/Risk dürfen daraus keine Signale ableiten.",
        "WARN",
      );
    }
    if (incomplete) {
      context.log(
        `Unvollständig: ${ids.length - seen.size} Kandidaten ohne Analyse-Antwort (Prompt-Budget ${budget.inputTokens} tok).`,
        "WARN",
      );
    }
    if (thrownError !== null) {
      context.log(
        `Erster Batch-Fehler dieses Laufs: ${thrownError instanceof Error ? thrownError.message.slice(0, 160) : String(thrownError)}`,
        "WARN",
      );
    }

    return {
      analyses: merged,
      analyzedCount: merged.length,
      ...(confluenceMeta ? { confluenceMeta } : {}),
      promptFit,
    };
  },
};

