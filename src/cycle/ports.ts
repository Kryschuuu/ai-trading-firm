/**
 * Ports und Adapter für den Agenten-Zyklus (Task 06).
 *
 * Entkoppelt die Zyklus-Engine von konkreten Abhängigkeiten:
 *   - ScannerPort (Task-04 Scanner)
 *   - AnalyticsPort (Task-05 Portfolio-Analytics)
 *   - AnalysisAgentPort (LLM-Provider)
 *   - CycleAuditPort (DB + NDJSON-Audit)
 *
 * Enthält vollwertige Default-Implementierungen sowie Stubs/Fakes für Tests.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "@/lib/appPaths";
import { chatLlm } from "@/lib/llmProvider";
import {
  TurnBudgetExceededError,
  createTurnBudget,
  escalationFromRuntime,
  getModelRouter,
  routeChat,
  routingMeta,
  type ModelRouter,
  type RoutedChatResult,
  type RoutedChatSpec,
  type TurnBudget,
} from "@/routing";
import {
  formatPlausibilityFeedback,
  runPlausibilitySpec,
  type PlausibilityFinding,
  type PlausibilityOutcome,
} from "./plausibility";
import type { RoutingTask } from "@/routing/types";
import {
  type AnalysisAgentPort,
  type AnalyticsPort,
  type CycleAuditEvent,
  type CycleAuditPort,
  type CyclePorts,
  type ScannerPort,
  type AgentInvocationSpec,
  type AgentInvocationResult,
  type ModelEscalationRequest,
} from "./types";
import { safeExtractJson } from "./security";
import { buildAgentPayloadPrompt } from "./promptPayload";
import type { DailyUniverseArtifact } from "@/scanner/artifacts";
import { buildDailyArtifact } from "@/scanner/artifacts";
import { getScannerService, SCANNER_CANDLE_TIMEFRAME } from "@/scanner/service";
import { HistoricalStore } from "@/lib/marketdata/historicalStore";
import {
  computeCorrelation,
  computeAllMetrics,
  correlationClusters,
  classifyVolatilityRegime,
} from "@/portfolio";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Scanner-Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard-Implementierung des Scanner-Ports auf Basis von Task 04.
 * Führt den deterministischen 14-Faktoren-Scan ohne LLM aus.
 *
 * Delegiert bewusst an den prozessweiten {@link ScannerService}: Es gibt
 * damit nur noch EINEN Ort, an dem Registry/Store/Data-Error-Manifest
 * verdrahtet sind. Die frühere Kopie hier lief ohne
 * `dataErrors`/Readiness-Scope und mit einem nicht auflösbaren Benchmark,
 * sodass der Zyklus auch nach erfolgreichem Sync einen abweichenden,
 * leeren Trichter sah. Eigene, explizite Instanzen (Tests) sind über
 * `ScannerServiceOptions` weiter injizierbar.
 */
export class DefaultScannerPort implements ScannerPort {
  async runScan(asOf: Date): Promise<DailyUniverseArtifact> {
    const service = getScannerService();
    const scan = service.refresh(asOf);
    return buildDailyArtifact(scan);
  }
}

/**
 * Stub-Implementierung des Scanner-Ports für isolierte Tests.
 */
export class StubScannerPort implements ScannerPort {
  private fixtureArtifact: DailyUniverseArtifact;

  constructor(custom?: Partial<DailyUniverseArtifact>) {
    const asOfStr = new Date().toISOString();
    this.fixtureArtifact = {
      schemaVersion: 1,
      generator: "scanner/task-04-stub",
      configVersion: 1,
      asOf: asOfStr,
      // Der Stub beschreibt einen vollständig gewärmten Lauf; Tests, die
      // WARMING/ERROR brauchen, überschreiben das Feld per `custom`.
      readiness: {
        status: "READY",
        instruments: 100,
        warmed: 100,
        missing: 0,
        outOfScope: 0,
        requiredCandles: 61,
      },
      weights: {
        liquidity: 0.25,
        volatility: 0.15,
        trend: 0.15,
        momentum: 0.1,
        spread: 0.1,
        volume: 0.1,
        correlation: 0.05,
        news: 0.05,
        execution: 0.05,
      },
      funnel: {
        scanned: 100,
        eligible: 50,
        interesting: 30,
        daily: 20,
        deep: 10,
        droppedByCap: { eligible: 0, interesting: 0, daily: 0 },
        diversificationRelaxed: false,
        deepPerAssetClass: { crypto: 10 },
      },
      levels: {
        deep: [
          {
            rank: 1,
            instrumentId: "BINANCE:BTCUSDT",
            assetClass: "crypto",
            score: 85,
            regime: "NORMAL",
          },
          {
            rank: 2,
            instrumentId: "BINANCE:ETHUSDT",
            assetClass: "crypto",
            score: 80,
            regime: "NORMAL",
          },
          {
            rank: 3,
            instrumentId: "BINANCE:SOLUSDT",
            assetClass: "crypto",
            score: 75,
            regime: "NORMAL",
          },
        ],
        daily: [
          {
            rank: 1,
            instrumentId: "BINANCE:BTCUSDT",
            assetClass: "crypto",
            score: 85,
            regime: "NORMAL",
          },
          {
            rank: 2,
            instrumentId: "BINANCE:ETHUSDT",
            assetClass: "crypto",
            score: 80,
            regime: "NORMAL",
          },
          {
            rank: 3,
            instrumentId: "BINANCE:SOLUSDT",
            assetClass: "crypto",
            score: 75,
            regime: "NORMAL",
          },
          {
            rank: 4,
            instrumentId: "BINANCE:ADAUSDT",
            assetClass: "crypto",
            score: 70,
            regime: "NORMAL",
          },
          {
            rank: 5,
            instrumentId: "BINANCE:DOGEUSDT",
            assetClass: "crypto",
            score: 65,
            regime: "NORMAL",
          },
        ],
        interesting: [],
        eligible: ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT"],
      },
      rejections: { total: 0, byRule: {} },
      ...custom,
    };
  }

  async runScan(asOf: Date): Promise<DailyUniverseArtifact> {
    return {
      ...this.fixtureArtifact,
      asOf: asOf.toISOString(),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Analytics-Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard-Implementierung des Analytics-Ports auf Basis von Task 05 (src/portfolio/).
 */
export class DefaultAnalyticsPort implements AnalyticsPort {
  async computeCorrelationAndRisk(
    symbols: string[],
    asOf: Date,
  ): Promise<{
    correlations: Record<string, Record<string, number>>;
    clusters: string[][];
    regimes: Record<string, string>;
    exposureWarnings: string[];
  }> {
    if (symbols.length === 0) {
      return {
        correlations: {},
        clusters: [],
        regimes: {},
        exposureWarnings: [],
      };
    }

    const store = new HistoricalStore();
    const seriesMap = new Map<string, number[]>();
    const regimes: Record<string, string> = {};

    for (const sym of symbols) {
      // Korrelation/Regime laufen auf EINER Periodizität (Analyse-Timeframe
      // 1h) — ein Timeframe-freier Query würde 5m/15m/1h mischen und die
      // Kennzahlen unbemerkt verfälschen.
      const candles = store.query({
        instrumentId: sym,
        timeframe: SCANNER_CANDLE_TIMEFRAME,
      });
      const closes = candles
        .map((c: { close: number }) => c.close)
        .filter((c: number): c is number => Number.isFinite(c) && c > 0);
      if (closes.length >= 5) {
        seriesMap.set(sym, closes);
        try {
          const m = computeAllMetrics([{ symbol: sym, prices: closes }]);
          const metric = m.metrics[0];
          if (metric) {
            regimes[sym] = metric.regime;
          }
        } catch {
          regimes[sym] = "NORMAL";
        }
      } else {
        regimes[sym] = "NORMAL";
      }
    }

    const validSymbols = Array.from(seriesMap.keys());
    const correlations: Record<string, Record<string, number>> = {};
    for (const s of symbols) correlations[s] = {};

    let clusters: string[][] = [];
    const exposureWarnings: string[] = [];

    if (validSymbols.length >= 2) {
      try {
        const seriesInput = validSymbols.map((s) => ({
          symbol: s,
          prices: seriesMap.get(s)!,
        }));
        const corrResult = computeCorrelation(seriesInput, {
          method: "pearson",
          clusterThreshold: 0.75,
        });
        for (let i = 0; i < validSymbols.length; i++) {
          const symA = validSymbols[i];
          for (let j = 0; j < validSymbols.length; j++) {
            const symB = validSymbols[j];
            const val =
              corrResult.correlation.matrix[i]?.[j] ?? (i === j ? 1 : 0);
            correlations[symA][symB] = Number(val.toFixed(4));
          }
        }
        if (corrResult.clusters) {
          clusters = corrResult.clusters.clusters.map(
            (c: { symbols: string[] }) => c.symbols,
          );
          for (const cl of clusters) {
            if (cl.length >= 3) {
              exposureWarnings.push(
                `Hohe Korrelation (≥ 0.75) zwischen Cluster: ${cl.join(", ")}`,
              );
            }
          }
        }
      } catch {
        // Fallback bei ungenügender Überschneidung
      }
    }

    return { correlations, clusters, regimes, exposureWarnings };
  }
}

/**
 * Stub-Implementierung des Analytics-Ports für Tests.
 */
export class StubAnalyticsPort implements AnalyticsPort {
  async computeCorrelationAndRisk(
    symbols: string[],
    _asOf: Date,
  ): Promise<{
    correlations: Record<string, Record<string, number>>;
    clusters: string[][];
    regimes: Record<string, string>;
    exposureWarnings: string[];
  }> {
    const correlations: Record<string, Record<string, number>> = {};
    const regimes: Record<string, string> = {};
    for (const a of symbols) {
      correlations[a] = {};
      regimes[a] = "NORMAL";
      for (const b of symbols) {
        correlations[a][b] = a === b ? 1.0 : 0.4;
      }
    }
    return {
      correlations,
      clusters: symbols.length >= 2 ? [[symbols[0], symbols[1]]] : [],
      regimes,
      exposureWarnings: [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Analysis-Agent-Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Zuordnung Agentenrolle → Routing-Task (Whitelist des Model Routers).
 *
 * WICHTIG (Task 09, Regel 1): Der Task ist eine **vom Code vergebene** ID.
 * Sie stammt nie aus Prompt-Inhalten, sondern aus der Rolle des Schritts.
 */
/**
 * Erlaubte Dateinamen für das Zyklus-Audit-NDJSON.
 *
 * Bewusst dieselbe Form wie `AUDIT_FILE_RE` im Portfolio-Modul: nur ein
 * einzelnes Pfadsegment aus `[A-Za-z0-9._-]`, damit ein konfigurierter
 * Dateiname niemals als Pfad (Separator oder `..`) missbraucht werden kann.
 */
export const CYCLE_AUDIT_FILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const ROLE_TASK_MAP: Readonly<Record<string, RoutingTask>> = {
  MARKET_SCANNER: "market_ranking",
  MACRO_ANALYST: "regime_analysis",
  MARKET_SELECTION: "market_selection",
  TECHNICAL_ANALYST: "technical_analysis_standard",
  NEWS_ANALYST: "news_categorization",
  RISK_MANAGER: "simple_risk_decision",
  RESEARCH: "research",
  BACKTEST_VERIFICATION: "json_classification",
  DEVILS_ADVOCATE: "conflicting_evidence",
  WEEKLY_REVIEW: "weekly_report",
};

/** Routing-Task einer Rolle (unbekannte Rollen → "default"). */
export function roleToRoutingTask(role: string): RoutingTask {
  return ROLE_TASK_MAP[role.toUpperCase()] ?? "default";
}

/**
 * Baut den Payload-Prompt aus Nutzerprompt + Datenblöcken (reine Funktion).
 *
 * RMA-P2-03 (v1.62.0): Autoritative Deterministik (z. B. MTF-Konfluenz) läuft
 * als GETRENNTER Trusted-Block — strikt VOR den Untrusted-Daten, damit die
 * Rangfolge (trusted ⇒ erklären, untrusted ⇒ Daten) sichtbar bleibt. Der
 * Block ist Instruktion + Datum zugleich: das Modell darf die Werte
 * erläutern, aber weder neu berechnen noch überschreiben.
 *
 * CYCLE-BATCH-01: Die Definition liegt in `./promptPayload.ts` (blattes
 * Modul ohne Routing-/FS-Importe), damit ein Schritt seine Prompt-Größe vor
 * dem Aufruf mit DEMSELBEN Baustein vermisst, der ihn später sendet. Der
 * Export hier bleibt die bekannte Importquelle (unverändert).
 */
export { buildAgentPayloadPrompt } from "./promptPayload";

/**
 * Standard-Agent-Port (Task 09): Der LLM-Pfad läuft über den MODEL_ROUTER.
 *
 *   invokeAgent() → routeChat() → router.resolve() → chatLlm(Kette)
 *
 * Der Agent bestimmt das Modell NICHT selbst: `MODEL_*`-Environment-Werte
 * werden ignoriert (Governance), die Entscheidung kommt ausschliesslich aus der
 * versionierten Policy. Externe Daten bleiben strikt getrennt (Payload-Hülle),
 * Ausgaben werden gegen das Schema validiert.
 */
export class DefaultAnalysisAgentPort implements AnalysisAgentPort {
  /**
   * Injektionen für Tests: `chatFn` ersetzt den echten Provider-Aufruf,
   * `router` den Router-Singleton. Im Produktivbetrieb bleiben beide leer.
   */
  constructor(
    private readonly deps: {
      chatFn?: typeof chatLlm;
      router?: ModelRouter;
    } = {},
  ) {}

  async invokeAgent<T>(
    spec: AgentInvocationSpec<T>,
  ): Promise<AgentInvocationResult<T>> {
    const payloadPrompt = buildAgentPayloadPrompt(spec.userPrompt, spec.trustedData, spec.untrustedData);

    const routedSpec: RoutedChatSpec = {
      agent: spec.role,
      task: roleToRoutingTask(spec.role),
      complexity: spec.complexity ?? "medium",
      // Analyse-Schritte platzieren keine Orders ⇒ Risikostufe "low".
      risk: "low",
      messages: [
        {
          role: "system",
          content: `${spec.systemPrompt}\nRespond strictly with valid JSON conforming to the requested schema.`,
        },
        { role: "user", content: payloadPrompt },
      ],
      json: true,
      temperature: 0.1,
    };

    // GAP-08 (v1.49.0): EIN Turn-Budget je Aufruf — deckelt Hauptaufruf und
    // alle Retries (Eskalation, Plausibilität) gemeinsam als Hartdeckel.
    const turn = createTurnBudget();
    try {
      const routed = await routeChat(routedSpec, {
        ...(this.deps.router ? { router: this.deps.router } : {}),
        ...(this.deps.chatFn ? { chatFn: this.deps.chatFn } : {}),
        turn,
      });
      return await this.finishInvocation<T>(spec, routed, turn, payloadPrompt);
    } catch (e) {
      // Turn-Bruch ist ein sauberer Abbruch — NIEMALS ein Fallback-Erfolg.
      if (e instanceof TurnBudgetExceededError) throw e;
      return {
        output: spec.fallback,
        rawText: "",
        usedFallback: true,
        modelUsed: "fallback",
      };
    }
  }

  /**
   * Gemeinsame Nachbearbeitung: JSON-Extraktion, Schema-Validierung,
   * Plausibilitäts-Schicht (GAP-08: genau EIN Retry, danach Skip) und
   * Eskalationsprüfung. Eine Eskalation wird **nur vom Router** entschieden —
   * bei Genehmigung folgt genau EIN erneuter Aufruf mit dem eskalierten Modell.
   */
  private async finishInvocation<T>(
    spec: AgentInvocationSpec<T>,
    routed: RoutedChatResult,
    turn: TurnBudget,
    payloadPrompt: string,
  ): Promise<AgentInvocationResult<T>> {
    const parsedJson = safeExtractJson<unknown>(routed.content);
    const routingMetaOut = routingMeta(routed);

    if (!parsedJson.ok || parsedJson.data === undefined) {
      return {
        output: spec.fallback,
        rawText: routed.content,
        usedFallback: true,
        modelUsed: routed.model,
        escalation: toEscalation(spec, routed.content, undefined),
        routing: routingMetaOut,
      };
    }

    const validated = spec.schemaValidator(parsedJson.data);
    if (!validated.valid || validated.data === undefined) {
      return {
        output: spec.fallback,
        rawText: routed.content,
        usedFallback: true,
        modelUsed: routed.model,
        escalation: toEscalation(spec, routed.content, parsedJson.data),
        routing: routingMetaOut,
      };
    }

    // GAP-08: Plausibilitäts-Schicht — läuft NACH der Schema-Validierung.
    // Explizites `T` (statt inferiertem verengtem Generik), damit der Retry-
    // Output ohne Schnittmengen-Kunsttyp zuweisbar bleibt.
    let acceptedData: T = validated.data;
    let acceptedRaw = routed.content;
    let acceptedParsed: unknown = parsedJson.data;
    let acceptedModel = routed.model;
    let acceptedRouting = routingMetaOut;
    let acceptedFallback = routed.usedFallback;
    let plausibility: PlausibilityOutcome | undefined;

    if (spec.plausibility) {
      const first = runPlausibilitySpec(validated.data, spec.plausibility);
      if (first.findings.length === 0) {
        plausibility = {
          status: "OK",
          findings: [],
          attempts: 1,
          referenceMissingInstruments: first.referenceMissingInstruments,
        };
      } else {
        const retry = await this.retryPlausibility(spec, turn, payloadPrompt, first.findings);
        if (!retry.accepted) {
          return {
            output: spec.fallback,
            rawText: retry.rawText,
            usedFallback: true,
            modelUsed: retry.modelUsed,
            escalation: toEscalation(spec, retry.rawText, retry.parsed),
            routing: retry.routing,
            plausibility: retry.outcome,
          };
        }
        acceptedData = retry.data;
        acceptedRaw = retry.rawText;
        acceptedParsed = retry.parsed;
        acceptedModel = retry.modelUsed;
        acceptedRouting = retry.routing;
        acceptedFallback = retry.usedFallback;
        plausibility = retry.outcome;
      }
    }

    const escalation = toEscalation(spec, acceptedRaw, acceptedParsed);

    // Eskalation: der Agent beantragt, der ROUTER entscheidet (Regel 1).
    if (escalation) {
      const outcome = await this.requestEscalation(spec, escalation, turn, plausibility);
      if (outcome) return outcome;
    }

    return {
      output: acceptedData,
      rawText: acceptedRaw,
      usedFallback: acceptedFallback,
      modelUsed: acceptedModel,
      escalation,
      routing: acceptedRouting,
      ...(plausibility ? { plausibility } : {}),
    };
  }

  /**
   * Der genau EINE Plausibilitäts-Retry (GAP-08): wiederholt den Aufruf mit
   * Fehlermeldungs-Kontext im selben Turn-Budget. Ein Turn-Budget-Bruch
   * propagiert (fail-closed) — er wird nie in einen Fallback umgewandelt.
   */
  private async retryPlausibility<T>(
    spec: AgentInvocationSpec<T>,
    turn: TurnBudget,
    payloadPrompt: string,
    firstFindings: PlausibilityFinding[],
  ): Promise<
    | {
        accepted: true;
        data: T;
        rawText: string;
        parsed: unknown;
        modelUsed: string;
        routing: Record<string, unknown>;
        usedFallback: boolean;
        outcome: PlausibilityOutcome;
      }
    | {
        accepted: false;
        rawText: string;
        parsed: unknown;
        modelUsed: string;
        routing: Record<string, unknown>;
        outcome: PlausibilityOutcome;
      }
  > {
    const feedback = formatPlausibilityFeedback(firstFindings);
    const routed = await routeChat(
      {
        agent: spec.role,
        task: roleToRoutingTask(spec.role),
        complexity: spec.complexity ?? "medium",
        risk: "low",
        messages: [
          {
            role: "system",
            content: `${spec.systemPrompt}\nRespond strictly with valid JSON conforming to the requested schema.`,
          },
          { role: "user", content: `${payloadPrompt}\n\n${feedback}` },
        ],
        json: true,
        temperature: 0.1,
      },
      {
        ...(this.deps.router ? { router: this.deps.router } : {}),
        ...(this.deps.chatFn ? { chatFn: this.deps.chatFn } : {}),
        turn,
      },
    );
    const parsed = safeExtractJson<unknown>(routed.content);
    const meta = routingMeta(routed);
    const validated =
      parsed.ok && parsed.data !== undefined ? spec.schemaValidator(parsed.data) : null;
    if (!validated || !validated.valid || validated.data === undefined) {
      return {
        accepted: false,
        rawText: routed.content,
        parsed: parsed.data,
        modelUsed: routed.model,
        routing: meta,
        outcome: {
          status: "SKIPPED",
          // Der Retry lieferte keine bewertbare Struktur — die Befunde des
          // ersten Versuchs bleiben als Ursache erhalten (Nachvollziehbarkeit).
          findings: [...firstFindings],
          attempts: 2,
          skipReason: "invalid-retry",
          referenceMissingInstruments: [],
        },
      };
    }
    // `spec.plausibility` ist gesetzt — der Aufrufer prüft das vor dem Retry.
    const second = runPlausibilitySpec(validated.data, spec.plausibility!);
    if (second.findings.length > 0) {
      return {
        accepted: false,
        rawText: routed.content,
        parsed: parsed.data,
        modelUsed: routed.model,
        routing: meta,
        outcome: {
          status: "SKIPPED",
          findings: second.findings,
          attempts: 2,
          skipReason: "plausibility",
          referenceMissingInstruments: second.referenceMissingInstruments,
        },
      };
    }
    return {
      accepted: true,
      data: validated.data,
      rawText: routed.content,
      parsed: parsed.data,
      modelUsed: routed.model,
      routing: meta,
      usedFallback: routed.usedFallback,
      outcome: {
        status: "RETRIED",
        findings: [],
        attempts: 2,
        referenceMissingInstruments: second.referenceMissingInstruments,
      },
    };
  }

  /** Fragt den Router; bei Genehmigung folgt maximal EIN erneuter Aufruf. */
  private async requestEscalation<T>(
    spec: AgentInvocationSpec<T>,
    escalation: ModelEscalationRequest,
    turn: TurnBudget,
    plausibility?: PlausibilityOutcome,
  ): Promise<AgentInvocationResult<T> | null> {
    const router = this.deps.router ?? getModelRouter();
    const escalationDecision = router.requestEscalation(
      escalationFromRuntime({
        agent: spec.role,
        task: roleToRoutingTask(spec.role),
        complexity: escalation.complexity,
        confidence: escalation.confidence,
        currentModel: escalation.currentModel,
        currentClass: escalation.currentClass,
        requestedClass: escalation.requestedClass,
        tokenOvershoot: escalation.tokenOvershoot,
        latencyViolation: escalation.latencyViolation,
        reason: escalation.reason,
      }),
    );

    if (!escalationDecision.approved || !escalationDecision.decision) {
      return null; // denied ⇒ Agent läuft mit dem aktuellen Modell weiter
    }

    // Genehmigt: EIN erneuter Aufruf mit dem eskalierten Modell (im selben Turn).
    const routed = await routeChat(
      {
        agent: spec.role,
        task: roleToRoutingTask(spec.role),
        complexity: escalation.complexity,
        risk: "low",
        messages: [
          { role: "system", content: spec.systemPrompt },
          { role: "user", content: spec.userPrompt },
        ],
        json: true,
        temperature: 0.1,
      },
      {
        forcedDecision: escalationDecision.decision,
        ...(this.deps.router ? { router: this.deps.router } : {}),
        ...(this.deps.chatFn ? { chatFn: this.deps.chatFn } : {}),
        turn,
      },
    );

    const parsed = safeExtractJson<unknown>(routed.content);
    const validated =
      parsed.ok && parsed.data !== undefined
        ? spec.schemaValidator(parsed.data)
        : null;
    const validOutput =
      validated && validated.valid && validated.data !== undefined
        ? validated.data
        : null;
    // GAP-08: Auch die eskalierte Antwort muss plausibel sein — ohne weitere
    // Retries (das Kontingent ist verbraucht): Befund → Skip, nie still.
    if (validOutput !== null && spec.plausibility) {
      const check = runPlausibilitySpec(validOutput, spec.plausibility);
      if (check.findings.length > 0) {
        return {
          output: spec.fallback,
          rawText: routed.content,
          usedFallback: true,
          modelUsed: routed.model,
          escalation,
          routing: {
            ...routingMeta(routed),
            escalationApproved: true,
            escalationTrigger: escalationDecision.trigger,
          },
          plausibility: {
            status: "SKIPPED",
            findings: check.findings,
            attempts: plausibility?.attempts ?? 1,
            skipReason: "plausibility",
            referenceMissingInstruments: check.referenceMissingInstruments,
          },
        };
      }
    }
    return {
      output: validOutput ?? spec.fallback,
      rawText: routed.content,
      usedFallback: routed.usedFallback || !validated?.valid,
      modelUsed: routed.model,
      escalation,
      routing: {
        ...routingMeta(routed),
        escalationApproved: true,
        escalationTrigger: escalationDecision.trigger,
      },
      ...(plausibility ? { plausibility } : {}),
    };
  }
}

/**
 * Eskalationsprüfung aus Runtime-Daten (GAP-08-Hilfsfunktion): wertet
 * `spec.escalationCheck` auf der AKZEPTIERTEN Antwort aus (nach Schema- und
 * Plausibilitäts-Prüfung) — eine verworfene Antwort eskaliert nie.
 */
function toEscalation<T>(
  spec: AgentInvocationSpec<T>,
  rawText: string,
  parsed: unknown,
): ModelEscalationRequest | undefined {
  if (!spec.escalationCheck) return undefined;
  const esc = spec.escalationCheck(rawText, parsed);
  return esc ? { ...esc, timestamp: new Date().toISOString() } : undefined;
}

/**
 * Fake-Implementierung des AnalysisAgentPorts für Unit- und Integrationstests.
 */
export class FakeAnalysisAgentPort implements AnalysisAgentPort {
  private responsesByRole = new Map<string, unknown>();
  private defaultResponse: unknown = null;
  private forceFallback = false;
  private queuedEscalations: Omit<ModelEscalationRequest, "timestamp">[] = [];
  /**
   * GAP-08: Antwort-Sequenzen je Rolle (Plausibilitäts-Retry-Tests) und
   * kumulative Versuchszähler je Rolle (seit Port-Erzeugung).
   */
  private sequences = new Map<string, unknown[]>();
  private attempts = new Map<string, number>();

  setResponseForRole(role: string, response: unknown): void {
    this.responsesByRole.set(role, response);
  }

  setDefaultResponse(response: unknown): void {
    this.defaultResponse = response;
  }

  setForceFallback(force: boolean): void {
    this.forceFallback = force;
  }

  queueEscalation(esc: Omit<ModelEscalationRequest, "timestamp">): void {
    this.queuedEscalations.push(esc);
  }

  /**
   * GAP-08: Antwort-Folge je Rolle — jeder (Retry-)Versuch verbraucht genau
   * einen Eintrag; danach gilt wieder `setResponseForRole`/Default.
   */
  setResponseSequenceForRole(role: string, responses: unknown[]): void {
    this.sequences.set(role, [...responses]);
  }

  /** GAP-08: Kumulative Versuche je Rolle (1 = kein Retry, 2 = genau ein Retry). */
  attemptsFor(role: string): number {
    return this.attempts.get(role) ?? 0;
  }

  private takeResponse(role: string): unknown {
    const sequence = this.sequences.get(role);
    if (sequence && sequence.length > 0) return sequence.shift();
    return this.responsesByRole.get(role) ?? this.defaultResponse;
  }

  private countAttempt(role: string): void {
    this.attempts.set(role, (this.attempts.get(role) ?? 0) + 1);
  }

  private takeEscalation(
    spec: AgentInvocationSpec<unknown>,
    rawText: string,
    rawObj: unknown,
  ): ModelEscalationRequest | undefined {
    if (this.queuedEscalations.length > 0) {
      const nextEsc = this.queuedEscalations.shift()!;
      return { ...nextEsc, timestamp: new Date().toISOString() };
    }
    if (spec.escalationCheck) {
      const esc = spec.escalationCheck(rawText, rawObj);
      if (esc) return { ...esc, timestamp: new Date().toISOString() };
    }
    return undefined;
  }

  async invokeAgent<T>(
    spec: AgentInvocationSpec<T>,
  ): Promise<AgentInvocationResult<T>> {
    const rawObj = this.forceFallback ? null : this.takeResponse(spec.role);
    this.countAttempt(spec.role);

    const rawText = JSON.stringify(rawObj ?? {});
    const escalation = this.takeEscalation(spec, rawText, rawObj);

    if (this.forceFallback || rawObj === null || rawObj === undefined) {
      return {
        output: spec.fallback,
        rawText: "forced_fallback",
        usedFallback: true,
        modelUsed: "fake-model",
        escalation,
      };
    }

    const validated = spec.schemaValidator(rawObj);
    if (!validated.valid || validated.data === undefined) {
      return {
        output: spec.fallback,
        rawText,
        usedFallback: true,
        modelUsed: "fake-model",
        escalation,
      };
    }

    // GAP-08: Plausibilitäts-Schicht — spiegelt den Default-Port (genau EIN
    // Retry aus der Sequenz, danach deterministischer Skip). Ohne Spec exakt
    // das alte Verhalten (kein `plausibility`-Ergebnis).
    if (spec.plausibility) {
      const first = runPlausibilitySpec(validated.data, spec.plausibility);
      if (first.findings.length === 0) {
        return {
          output: validated.data,
          rawText,
          usedFallback: false,
          modelUsed: "fake-model",
          escalation,
          plausibility: {
            status: "OK",
            findings: [],
            attempts: 1,
            referenceMissingInstruments: first.referenceMissingInstruments,
          },
        };
      }
      const retryRaw = this.forceFallback ? null : this.takeResponse(spec.role);
      this.countAttempt(spec.role);
      const retryText = JSON.stringify(retryRaw ?? {});
      const retryValidated =
        retryRaw === null || retryRaw === undefined
          ? null
          : spec.schemaValidator(retryRaw);
      if (!retryValidated || !retryValidated.valid || retryValidated.data === undefined) {
        return {
          output: spec.fallback,
          rawText: retryText,
          usedFallback: true,
          modelUsed: "fake-model",
          escalation,
          plausibility: {
            status: "SKIPPED",
            findings: [...first.findings],
            attempts: 2,
            skipReason: "invalid-retry",
            referenceMissingInstruments: [],
          },
        };
      }
      const second = runPlausibilitySpec(retryValidated.data, spec.plausibility);
      if (second.findings.length > 0) {
        return {
          output: spec.fallback,
          rawText: retryText,
          usedFallback: true,
          modelUsed: "fake-model",
          escalation,
          plausibility: {
            status: "SKIPPED",
            findings: second.findings,
            attempts: 2,
            skipReason: "plausibility",
            referenceMissingInstruments: second.referenceMissingInstruments,
          },
        };
      }
      return {
        output: retryValidated.data,
        rawText: retryText,
        usedFallback: false,
        modelUsed: "fake-model",
        escalation,
        plausibility: {
          status: "RETRIED",
          findings: [],
          attempts: 2,
          referenceMissingInstruments: second.referenceMissingInstruments,
        },
      };
    }

    return {
      output: validated.data,
      rawText,
      usedFallback: false,
      modelUsed: "fake-model",
      escalation,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Audit-Port
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard-Audit-Port: Schreibt in DB (`audit_log`), falls verfügbar,
 * und zusätzlich in `data/cycle/audit.ndjson`.
 */
export class DefaultCycleAuditPort implements CycleAuditPort {
  private inMemoryEvents: CycleAuditEvent[] = [];
  private logFilePath: string;

  constructor(logDir = "data/cycle", fileName = "audit.ndjson") {
    // Pfadsicher: `logDir`/`fileName` können aus Konfiguration kommen.
    // `resolveRuntimePath()` verankert relativ im Projektstamm und wirft bei
    // `..`-Ausbruch; der Dateiname wird zusätzlich auf ein erlaubtes Muster
    // geprüft, damit nichts in fremde Verzeichnisse geschrieben wird.
    if (!CYCLE_AUDIT_FILE_RE.test(fileName)) {
      throw new Error(
        `cycle audit file name invalid: ${fileName.slice(0, 40)}`,
      );
    }
    this.logFilePath = path.join(resolveRuntimePath(logDir), fileName);
  }

  async logEvent(event: CycleAuditEvent): Promise<void> {
    this.inMemoryEvents.push(event);
    if (this.inMemoryEvents.length > 1000) {
      this.inMemoryEvents.shift();
    }

    // 1. Datei-Senke
    try {
      const dir = path.dirname(this.logFilePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
      appendFileSync(this.logFilePath, `${JSON.stringify(event)}\n`, {
        mode: 0o644,
      });
    } catch {
      // Ignorieren, In-Memory bleibt erhalten
    }

    // 2. DB-Senke (nur falls DB aktiv)
    if (process.env.CYCLE_AUDIT_DB === "1" || process.env.DATABASE_URL) {
      try {
        const [{ db }, { auditLog }] = await Promise.all([
          import("@/db"),
          import("@/db/schema"),
        ]);
        await db.insert(auditLog).values({
          event: event.event,
          level: event.level,
          detail: {
            ...event.detail,
            cycleId: event.cycleId,
            stepId: event.stepId,
            role: event.role,
          },
        });
      } catch {
        // Nicht blockierend
      }
    }
  }

  async getEvents(cycleId?: string): Promise<CycleAuditEvent[]> {
    if (cycleId) {
      return this.inMemoryEvents.filter((e) => e.cycleId === cycleId);
    }
    return [...this.inMemoryEvents];
  }
}

/**
 * Reiner Speicher-Audit-Port für Tests.
 */
export class MemoryCycleAuditPort implements CycleAuditPort {
  readonly events: CycleAuditEvent[] = [];

  async logEvent(event: CycleAuditEvent): Promise<void> {
    this.events.push(event);
  }

  async getEvents(cycleId?: string): Promise<CycleAuditEvent[]> {
    if (cycleId) {
      return this.events.filter((e) => e.cycleId === cycleId);
    }
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Erzeugt Standard-Ports für den Produktivbetrieb.
 */
export function createDefaultPorts(): CyclePorts {
  return {
    scanner: new DefaultScannerPort(),
    analytics: new DefaultAnalyticsPort(),
    agent: new DefaultAnalysisAgentPort(),
    audit: new DefaultCycleAuditPort(),
  };
}

/**
 * Erzeugt Fake-/Stub-Ports für Tests.
 */
export function createTestPorts(): CyclePorts & {
  agent: FakeAnalysisAgentPort;
  audit: MemoryCycleAuditPort;
  scanner: StubScannerPort;
  analytics: StubAnalyticsPort;
} {
  return {
    scanner: new StubScannerPort(),
    analytics: new StubAnalyticsPort(),
    agent: new FakeAnalysisAgentPort(),
    audit: new MemoryCycleAuditPort(),
  };
}
