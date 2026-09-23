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
 */

import { confluenceBatchFromStore } from "@/confluence/adapters";
import { formatConfluenceLine } from "@/confluence/confluence";
import { isConfluenceEnabled, loadConfluenceConfig } from "@/confluence/config";
import { CONFLUENCE_FORMULA_VERSION, type ConfluenceSnapshot } from "@/confluence/types";
import { HistoricalStore } from "@/lib/marketdata/historicalStore";
import { historyDir } from "@/lib/marketdata/config";
import {
  applyTrustedReadings,
  indicatorPayload,
  loadTrustedIndicators,
  type TrustedIndicatorPayload,
  type TrustedReading,
} from "@/cycle/trustedIndicators";
import type { StepDefinition, StepExecutionContext } from "../types";
import {
  type TechnicalConfluenceMeta,
  type TechnicalStepOutput,
  validateTechnicalOutput,
} from "../schemas";
import { assertShortlistLimit } from "../security";
import type { SelectionStepOutput } from "../schemas";

export interface TechnicalStepInput {
  candidates?: Array<{ instrumentId: string; rank?: number; score?: number }>;
}

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
    let indicatorBlock: TrustedIndicatorPayload | undefined;
    if (selection.length > 0) {
      try {
        indicatorReadings = loadTrustedIndicators(
          openStore(),
          selection.map((c) => c.instrumentId),
          asOfMs,
        );
        indicatorBlock = indicatorPayload(indicatorReadings, asOfMs);
        const measured = [...indicatorReadings.values()].filter((reading) => reading.rsi != null).length;
        context.log(
          `Trusted Indicators (${indicatorBlock.kind}): ${indicatorReadings.size} Instrumente, ` +
            `${measured} mit gemessenen RSI (geschlossene 1h-Bars).`,
        );
      } catch (e) {
        context.log(
          `Trusted Indicators nicht lesbar (${e instanceof Error ? e.message : String(e)}) — RSI/ATR werden nicht erfunden.`,
          "WARN",
        );
        indicatorReadings = new Map();
        indicatorBlock = undefined;
      }
    }

    // Standard-Fallback für alle Kandidaten (mit autoritativen Snapshots).
    // Kein rsi: 50 — das wäre eine erfundene Neutralmessung.
    const defaultAnalyses = selection.map((c) => ({
      instrumentId: c.instrumentId,
      bias: "NEUTRAL" as const,
      technicalScore: 50,
      trend: "neutral",
      keyLevels: { support: 0, resistance: 0 },
      thesis: "Reguläre Konsolidierung im 4h/1h-Chart (Deterministischer Fallback)",
      ...(snapshots.get(c.instrumentId) ? { confluence: snapshots.get(c.instrumentId)! } : {}),
    }));
    applyTrustedReadings(defaultAnalyses, indicatorReadings);

    const fallback: TechnicalStepOutput = {
      analyses: defaultAnalyses,
      analyzedCount: defaultAnalyses.length,
      ...(confluenceMeta ? { confluenceMeta } : {}),
    };

    if (selection.length === 0) {
      return fallback;
    }

    const systemPrompt = `You are the Technical Analyst of an autonomous trading firm.
Analyze the provided shortlist of market instruments (strictly bounded to max 40).
For each instrument, determine:
- bias: BULLISH | BEARISH | NEUTRAL
- technicalScore: 0 to 100
- trend and key support/resistance levels
- concise technical thesis
Do not invent RSI or ATR. Code overwrites those fields from closed 1h candles after validation. If trusted indicators are missing, omit the numbers — never substitute 50.
ADX and MACD in the trusted block are measurements too. Explain them; do not recompute them.
${snapshots.size > 0 ? "A TRUSTED DETERMINISTIC DATA block carries the precomputed multi-timeframe confluence per instrument. Explain it in your thesis where relevant, but NEVER recompute or override its numbers — your bias/score must stay consistent with an ABSTAIN status (no signal) and must not contradict a high-confidence confluence direction without explicit justification." : ""}
Respond strictly with valid JSON conforming to the schema.`;

    const userPrompt = `Analyze the following instruments (strictly max 40):
${JSON.stringify(selection.map((s) => s.instrumentId))}
JSON schema:
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

    // Trusted-Payload: kompakte Zeilen (Prompt-Ökonomie) + Voll-Snapshots
    // (Nachvollziehbarkeit). Das Schema kennt KEIN confluence-Feld — die
    // Validierung verwirft LLM-seitige Override-Versuche strukturell.
    const confluenceTrusted =
      snapshots.size > 0
        ? {
            kind: "mtf-confluence" as const,
            formulaVersion: confluenceMeta?.formulaVersion ?? "mtf-confluence@1",
            configVersion: confluenceMeta?.configVersion ?? 1,
            asOf: new Date(asOfMs).toISOString(),
            lines: [...snapshots.values()].map(formatConfluenceLine),
            snapshots: [...snapshots.values()],
          }
        : undefined;
    // Konfluenz behält `kind`. Indikatoren hängen darunter. Ohne Konfluenz
    // ist der Indikator-Block selbst trustedData — das Flag schaltet ihn nicht ab.
    const trustedData = confluenceTrusted
      ? { ...confluenceTrusted, ...(indicatorBlock ? { indicators: indicatorBlock } : {}) }
      : indicatorBlock;

    const res = await context.ports.agent.invokeAgent<TechnicalStepOutput>({
      role: "TECHNICAL_ANALYST",
      systemPrompt,
      userPrompt,
      ...(trustedData ? { trustedData } : {}),
      untrustedData: { instrumentsToAnalyze: selection },
      schemaValidator: validateTechnicalOutput,
      fallback,
    });

    // Validierung der Ausgabegrenze
    assertShortlistLimit(res.output.analyses, 40);

    // Autoritative Anhängung NACH der Validierung: was das LLM auch immer
    // zurückgab — der Snapshot je Instrument ist der codeseitig berechnete
    // (kein Override-Pfad, idempotent über snapshotKey).
    if (snapshots.size > 0) {
      for (const analysis of res.output.analyses) {
        const snap = snapshots.get(analysis.instrumentId);
        if (snap) analysis.confluence = snap;
      }
      // Fallback-Outputs tragen die Meta bereits; LLM-Outputs erhalten sie hier.
      if (!res.output.confluenceMeta && confluenceMeta) {
        res.output.confluenceMeta = confluenceMeta;
      }
    }
    applyTrustedReadings(res.output.analyses, indicatorReadings);

    return res.output;
  },
};
