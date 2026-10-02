/**
 * STX-06-05 — erklärender Validator-Agent.
 *
 * Diese Grenze ist absichtlich schmal: Die Funktion liest einen fertigen,
 * deterministischen Report, baut daraus eine feste Aggregat-Projektion und
 * gibt ausschließlich eine validierte Interpretation zurück. Sie enthält
 * keinen Evidence-Writer und keinen Lifecycle-Zugriff.
 */
import { buildProviderDescriptor } from "@/routing/registry";
import { filterEnabledProviders } from "@/routing/providerToggles";
import { telemetry } from "@/lib/telemetry";
import {
  chatLlm,
  type LlmChatRequest,
  type LlmProviderName,
} from "@/lib/llmProvider";
import {
  isValidationResult,
  type StrategyValidationReport,
  type ValidationResult,
} from "./report";
import {
  buildValidatorAgentUserPrompt,
  VALIDATOR_AGENT_SYSTEM_PROMPT,
  VALIDATOR_AGENT_FINDING_CODES,
  VALIDATOR_AGENT_OUTPUT_SCHEMA,
  VALIDATOR_AGENT_SEVERITIES,
} from "./agentPrompt";

export const VALIDATOR_AGENT_SHADOW_ENV = "VALIDATOR_AGENT_SHADOW" as const;
export const VALIDATOR_AGENT_ROUTING_POLICY_ENV = "VALIDATOR_AGENT_ROUTING_POLICY" as const;

const MAX_REPORT_PROMPT_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024;
const MAX_SCAN_CHARS = 32 * 1024;
const MAX_REPORT_ROWS = 16;
const MAX_NOTE_ROWS = 64;
const MAX_EVIDENCE_TEXT_LENGTH = 220;
const MAX_GATE_TEXT_LENGTH = 260;
const MAX_SUMMARY_LENGTH = 400;
const MAX_RESPONSE_FINDINGS = 12;
const MAX_RESPONSE_LIST_ITEMS = 8;

const LOCAL_FREE_PROVIDERS: LlmProviderName[] = ["ollama", "openai"];
const OPENCODE_FREE_PROVIDER_ORDER: LlmProviderName[] = ["opencode", ...LOCAL_FREE_PROVIDERS];
const REPORT_UNTRUSTED_DATA_TAG = "UNTRUSTED_VALIDATION_REPORT_DATA_JSON";

const ASSUMPTION_STATUSES = ["HOLDS", "VIOLATED", "UNKNOWN"] as const;
const GATE_STATUSES = ["PASS", "FAIL", "INCONCLUSIVE", "SKIPPED"] as const;
const HOLDOUT_STATUSES = ["CLEAN", "CONTAMINATED", "UNKNOWN"] as const;
const VALIDATION_RESULT_WORDS = /\b(?:PASS|FAIL|INCONCLUSIVE)\b/i;

/** Geschlossene Ergebnislabels; Freitext gelangt nie in diesen Counter. */
type ValidatorAgentRunResult = "ok" | "unavailable" | "schema_error" | "blocked";

export interface ValidatorAgentConfig {
  readonly shadowMode: boolean;
  /** Policy-Flag als Laufzeit-Konfiguration, bewusst kein neuer Routing-Typ. */
  readonly routingPolicy: string;
}

export interface AgentFinding {
  readonly code: (typeof VALIDATOR_AGENT_FINDING_CODES)[number];
  readonly severity: (typeof VALIDATOR_AGENT_SEVERITIES)[number];
  readonly summary: string;
  readonly evidenceRef: string;
}

export interface AgentInterpretationResult {
  readonly findings: readonly AgentFinding[];
  readonly missingEvidence: readonly string[];
  readonly contradicting: readonly string[];
  readonly overall: string;
}

/** Provider-/Schema-Ausfall ist kein Validierungsergebnis. */
export type AgentInterpretation = AgentInterpretationResult | Readonly<{ unavailable: true }>;

export interface RunValidatorAgentOptions {
  readonly env?: Record<string, string | undefined>;
  readonly fetchFn?: typeof fetch;
  /** Injektion für Tests; Produktion nutzt die bestehende Provider-Router-Funktion. */
  readonly chatFn?: typeof chatLlm;
}

interface AgentReportPayload {
  readonly result: ValidationResult;
  readonly strategy: {
    readonly templateId: string;
    readonly templateVersion: number;
    readonly strategyClass: string;
  };
  readonly dataQualityScore: number | null;
  readonly metrics: {
    readonly sharpe: number | null;
    readonly sortino: number | null;
    readonly maxDrawdownPct: number | null;
    readonly winRate: number | null;
    readonly profitFactor: number | null;
    readonly expectancy: number | null;
    readonly tradeCount: number;
    readonly netPnl: number | null;
  };
  readonly robustness: {
    readonly parameterSensitivity: number | null;
    readonly costStress: number | null;
    readonly slippageStress: number | null;
    readonly regimeStability: number | null;
  };
  readonly overfitting: {
    readonly trainOosGap: number | null;
    readonly parameterFragility: number | null;
    readonly multipleTestingWarning: boolean;
    readonly lookaheadWarning: boolean;
    readonly holdoutIntegrity: (typeof HOLDOUT_STATUSES)[number];
  };
  readonly assumptions: readonly {
    readonly id: string;
    readonly status: (typeof ASSUMPTION_STATUSES)[number];
    readonly evidence: string;
  }[];
  readonly regimes: readonly {
    readonly regime: string;
    readonly trades: number;
    readonly sharpe: number | null;
  }[];
  readonly gates: readonly {
    readonly id: string;
    readonly step: number;
    readonly status: (typeof GATE_STATUSES)[number];
    readonly evidence: string;
  }[];
  readonly regimeEvidence: {
    readonly tradesTotal: number;
    readonly attributedTrades: number;
    readonly unknownRegimeTrades: number;
    readonly unattributedTrades: number;
    readonly returnlessTrades: number;
    readonly minSampleTrades: number;
  };
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
}

class AgentInputSchemaError extends Error {
  constructor() {
    super("validator-agent:invalid-report");
    this.name = "AgentInputSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** Shadow ist standardmäßig an; ein unbekanntes Routing-Flag fällt lokal zurück. */
export function loadValidatorAgentConfig(
  env: Record<string, string | undefined> = process.env,
): ValidatorAgentConfig {
  const requestedPolicy = env[VALIDATOR_AGENT_ROUTING_POLICY_ENV]?.trim().toUpperCase();
  return {
    shadowMode: parseBooleanEnv(env[VALIDATOR_AGENT_SHADOW_ENV], true),
    routingPolicy: requestedPolicy === "OPENCODE_FREE" ? "OPENCODE_FREE" : "LOCAL_FREE",
  };
}

function recordRun(result: ValidatorAgentRunResult): void {
  telemetry.validatorAgent.runs.inc({ result });
}

function unavailable(): Readonly<{ unavailable: true }> {
  return Object.freeze({ unavailable: true as const });
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") throw new AgentInputSchemaError();
  return cleanText(value).slice(0, maxLength);
}

function requiredText(value: unknown, maxLength: number): string {
  const text = boundedText(value, maxLength).trim();
  if (!text) throw new AgentInputSchemaError();
  return text;
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AgentInputSchemaError();
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentInputSchemaError();
  }
  return value;
}

function boundedArray<T>(value: unknown, maxLength = MAX_REPORT_ROWS): readonly T[] {
  if (!Array.isArray(value) || value.length > maxLength) throw new AgentInputSchemaError();
  return value as readonly T[];
}

/**
 * Nur explizit aufgeführte, aggregierte Felder dürfen die Agentengrenze
 * passieren. `notes`, Freitext-Rationale, Roh-Kerzen und Trade-Logs werden
 * nicht kopiert; der Agent kann auch keine zusätzlichen Report-Keys mitnehmen.
 */
function toAgentReportPayload(report: StrategyValidationReport): AgentReportPayload {
  if (!isRecord(report) || !isValidationResult(report.result)) throw new AgentInputSchemaError();

  const metrics = report.metrics;
  const robustness = report.robustness;
  const overfitting = report.overfitting;
  const regimeEvidence = report.regimeEvidence;
  if (!isRecord(metrics) || !isRecord(robustness) || !isRecord(overfitting) || !isRecord(regimeEvidence)) {
    throw new AgentInputSchemaError();
  }

  const assumptions = boundedArray<Record<string, unknown>>(report.assumptions).map((row) => {
    if (!isRecord(row) || !isOneOf(row.status, ASSUMPTION_STATUSES)) throw new AgentInputSchemaError();
    return Object.freeze({
      id: requiredText(row.id, 80),
      status: row.status,
      evidence: boundedText(row.evidence, MAX_EVIDENCE_TEXT_LENGTH),
    });
  });

  const regimes = boundedArray<Record<string, unknown>>(report.regimes).map((row) => {
    if (!isRecord(row)) throw new AgentInputSchemaError();
    return Object.freeze({
      regime: requiredText(row.regime, 64),
      trades: nonNegativeInteger(row.trades),
      sharpe: finiteNumberOrNull(row.sharpe),
    });
  });

  const gates = boundedArray<Record<string, unknown>>(report.gates, 16).map((row) => {
    if (!isRecord(row) || !isOneOf(row.status, GATE_STATUSES)) throw new AgentInputSchemaError();
    if (typeof row.step !== "number" || !Number.isSafeInteger(row.step) || row.step < 1) {
      throw new AgentInputSchemaError();
    }
    return Object.freeze({
      id: requiredText(row.id, 64),
      step: row.step,
      status: row.status,
      evidence: boundedText(row.evidence, MAX_GATE_TEXT_LENGTH),
    });
  });

  if (!isOneOf(overfitting.holdoutIntegrity, HOLDOUT_STATUSES)) throw new AgentInputSchemaError();
  if (typeof overfitting.multipleTestingWarning !== "boolean" || typeof overfitting.lookaheadWarning !== "boolean") {
    throw new AgentInputSchemaError();
  }

  const tradeCount = nonNegativeInteger(metrics.tradeCount);
  const payload: AgentReportPayload = {
    result: report.result,
    strategy: Object.freeze({
      templateId: requiredText(report.templateId, 96),
      templateVersion: nonNegativeInteger(report.templateVersion),
      strategyClass: requiredText(report.class, 64),
    }),
    dataQualityScore: finiteNumberOrNull(report.dataQualityScore),
    metrics: Object.freeze({
      sharpe: finiteNumberOrNull(metrics.sharpe),
      sortino: finiteNumberOrNull(metrics.sortino),
      maxDrawdownPct: finiteNumberOrNull(metrics.maxDrawdownPct),
      winRate: finiteNumberOrNull(metrics.winRate),
      profitFactor: finiteNumberOrNull(metrics.profitFactor),
      expectancy: finiteNumberOrNull(metrics.expectancy),
      tradeCount,
      netPnl: finiteNumberOrNull(metrics.netPnl),
    }),
    robustness: Object.freeze({
      parameterSensitivity: finiteNumberOrNull(robustness.parameterSensitivity),
      costStress: finiteNumberOrNull(robustness.costStress),
      slippageStress: finiteNumberOrNull(robustness.slippageStress),
      regimeStability: finiteNumberOrNull(robustness.regimeStability),
    }),
    overfitting: Object.freeze({
      trainOosGap: finiteNumberOrNull(overfitting.trainOosGap),
      parameterFragility: finiteNumberOrNull(overfitting.parameterFragility),
      multipleTestingWarning: overfitting.multipleTestingWarning,
      lookaheadWarning: overfitting.lookaheadWarning,
      holdoutIntegrity: overfitting.holdoutIntegrity,
    }),
    assumptions: Object.freeze(assumptions),
    regimes: Object.freeze(regimes),
    gates: Object.freeze(gates),
    regimeEvidence: Object.freeze({
      tradesTotal: nonNegativeInteger(regimeEvidence.tradesTotal),
      attributedTrades: nonNegativeInteger(regimeEvidence.attributedTrades),
      unknownRegimeTrades: nonNegativeInteger(regimeEvidence.unknownRegimeTrades),
      unattributedTrades: nonNegativeInteger(regimeEvidence.unattributedTrades),
      returnlessTrades: nonNegativeInteger(regimeEvidence.returnlessTrades),
      minSampleTrades: nonNegativeInteger(regimeEvidence.minSampleTrades),
    }),
    summary: boundedText(report.summary, MAX_SUMMARY_LENGTH),
    evidenceRefs: Object.freeze([
      "metrics.sharpe",
      "metrics.sortino",
      "metrics.maxDrawdownPct",
      "metrics.winRate",
      "metrics.profitFactor",
      "metrics.expectancy",
      "metrics.tradeCount",
      "metrics.netPnl",
      "dataQualityScore",
      "robustness.parameterSensitivity",
      "robustness.costStress",
      "robustness.slippageStress",
      "robustness.regimeStability",
      "overfitting.trainOosGap",
      "overfitting.parameterFragility",
      "overfitting.multipleTestingWarning",
      "overfitting.lookaheadWarning",
      "overfitting.holdoutIntegrity",
      "regimeEvidence.tradesTotal",
      "regimeEvidence.attributedTrades",
      "regimeEvidence.unknownRegimeTrades",
      "regimeEvidence.unattributedTrades",
      "regimeEvidence.returnlessTrades",
      ...assumptions.map((row) => `assumptions.${row.id}`),
      ...regimes.map((row) => `regimes.${row.regime}`),
      ...gates.map((row) => `gates.${row.id}`),
      "summary",
    ]),
  };

  return Object.freeze(payload);
}

interface UntrustedTextSource {
  readonly ref: string;
  readonly value: string;
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|replace)\b.{0,100}\b(?:previous|prior|above|all|system|developer)\b.{0,80}\b(?:instructions?|prompts?|rules?)\b/i,
  /\b(?:result|outcome)\s*(?:=|:)\s*(?:PASS|FAIL|INCONCLUSIVE)\b/i,
  /\b(?:set|change|force|overwrite)\b.{0,60}\b(?:result|outcome)\b/i,
  /<\s*\/?\s*(?:system|developer|UNTRUSTED_VALIDATION_REPORT_DATA_JSON)\b/i,
];

/** Erkennt Overrides in Freitext, ohne diesen Freitext an ein Modell zu senden. */
function findInjectionAttempt(report: StrategyValidationReport): string | null {
  const sources: UntrustedTextSource[] = [];
  const add = (ref: string, value: unknown): void => {
    if (typeof value === "string") sources.push({ ref, value });
  };
  const notes = (report as unknown as Record<string, unknown>).notes;
  if (typeof notes === "string") add("report.notes", notes);
  else if (Array.isArray(notes)) {
    if (notes.length > MAX_NOTE_ROWS) throw new AgentInputSchemaError();
    notes.forEach((note, index) => add(`report.notes[${index}]`, note));
  }
  add("report.rationale", (report as unknown as Record<string, unknown>).rationale);
  add("report.templateId", report.templateId);
  add("report.class", report.class);
  add("report.summary", report.summary);

  for (const [index, row] of boundedArray<Record<string, unknown>>(report.assumptions).entries()) {
    if (!isRecord(row)) continue;
    add(`report.assumptions[${index}].id`, row.id);
    add(`report.assumptions[${index}].evidence`, row.evidence);
    add(`report.assumptions[${index}].statement`, row.statement);
    add(`report.assumptions[${index}].rationale`, row.rationale);
  }
  for (const [index, row] of boundedArray<Record<string, unknown>>(report.gates, 16).entries()) {
    if (!isRecord(row)) continue;
    add(`report.gates[${index}].id`, row.id);
    add(`report.gates[${index}].evidence`, row.evidence);
    add(`report.gates[${index}].rationale`, row.rationale);
  }
  for (const [index, row] of boundedArray<Record<string, unknown>>(report.regimes).entries()) {
    if (isRecord(row)) add(`report.regimes[${index}].regime`, row.regime);
  }
  const regimeEvidence: Record<string, unknown> = isRecord(report.regimeEvidence) ? report.regimeEvidence : {};
  add("report.regimeEvidence.summary", regimeEvidence.summary);

  let scannedChars = 0;
  for (const source of sources) {
    scannedChars += source.value.length;
    if (scannedChars > MAX_SCAN_CHARS) throw new AgentInputSchemaError();
    if (INJECTION_PATTERNS.some((pattern) => pattern.test(source.value))) return source.ref;
  }
  return null;
}

function injectionBlocked(sourceRef: string): AgentInterpretationResult {
  return Object.freeze({
    findings: Object.freeze([
      Object.freeze({
        code: "INJECTION_ATTEMPT" as const,
        severity: "critical" as const,
        summary: "Nicht vertrauenswürdiger Report-Text versucht, die Audit-Grenze zu überschreiben; der Modellaufruf wurde blockiert.",
        evidenceRef: sourceRef,
      }),
    ]),
    missingEvidence: Object.freeze([]),
    contradicting: Object.freeze([]),
    overall: "Der deterministische Report wurde nicht verändert; die Interpretation wurde wegen eines Grenz-Overrides blockiert.",
  });
}

function allowedProviderOrder(
  config: ValidatorAgentConfig,
  env: Record<string, string | undefined>,
): LlmProviderName[] {
  const candidates = config.routingPolicy === "OPENCODE_FREE"
    ? (env.OPENCODE_API_KEY?.trim() ? OPENCODE_FREE_PROVIDER_ORDER : LOCAL_FREE_PROVIDERS)
    : LOCAL_FREE_PROVIDERS;
  return filterEnabledProviders(candidates, env);
}

function stringArray(value: unknown, maxItems: number, maxLength: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > maxLength) return null;
    output.push(item.trim());
  }
  return Object.freeze(output);
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseAgentInterpretation(
  content: unknown,
  evidenceRefs: ReadonlySet<string>,
): AgentInterpretationResult | null {
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_RESPONSE_BYTES) return null;

  let parsed: unknown;
  try {
    // JSON.parse deliberately rejects markdown fences and any leading/trailing prose.
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !exactObjectKeys(parsed, ["findings", "missingEvidence", "contradicting", "overall"])) {
    return null;
  }
  if (!Array.isArray(parsed.findings) || parsed.findings.length > MAX_RESPONSE_FINDINGS) return null;

  const findings: AgentFinding[] = [];
  for (const item of parsed.findings) {
    if (!isRecord(item) || !exactObjectKeys(item, ["code", "severity", "summary", "evidenceRef"])) return null;
    if (!isOneOf(item.code, VALIDATOR_AGENT_FINDING_CODES) || !isOneOf(item.severity, VALIDATOR_AGENT_SEVERITIES)) {
      return null;
    }
    if (
      typeof item.summary !== "string" || item.summary.trim().length === 0 || item.summary.length > 320 ||
      typeof item.evidenceRef !== "string" || !evidenceRefs.has(item.evidenceRef)
    ) return null;
    findings.push(Object.freeze({
      code: item.code,
      severity: item.severity,
      summary: item.summary.trim(),
      evidenceRef: item.evidenceRef,
    }));
  }

  const missingEvidence = stringArray(parsed.missingEvidence, MAX_RESPONSE_LIST_ITEMS, 320);
  const contradicting = stringArray(parsed.contradicting, MAX_RESPONSE_LIST_ITEMS, 320);
  if (
    missingEvidence === null || contradicting === null ||
    typeof parsed.overall !== "string" || parsed.overall.trim().length === 0 || parsed.overall.length > 1000
  ) return null;
  // Even narrative text may not emit a second PASS/FAIL/INCONCLUSIVE verdict.
  if (
    VALIDATION_RESULT_WORDS.test(parsed.overall) ||
    [...findings.map((finding) => finding.summary), ...missingEvidence, ...contradicting]
      .some((text) => VALIDATION_RESULT_WORDS.test(text))
  ) return null;

  return Object.freeze({
    findings: Object.freeze(findings),
    missingEvidence,
    contradicting,
    overall: parsed.overall.trim(),
  });
}

function recordAndReturn(
  result: ValidatorAgentRunResult,
  interpretation: AgentInterpretation,
): AgentInterpretation {
  recordRun(result);
  return interpretation;
}

/**
 * Liest den finalen Report und gibt eine validierte, rein erläuternde Deutung
 * zurück. Fehler/Provider-Ausfall liefern nur `{ unavailable: true }`; sie
 * verändern weder den Report noch dessen deterministisches `result`.
 */
export async function runValidatorAgent(
  report: StrategyValidationReport,
  options: RunValidatorAgentOptions = {},
): Promise<AgentInterpretation> {
  const env = options.env ?? process.env;

  let payload: AgentReportPayload;
  let userPrompt: string;
  let injectionSource: string | null;
  let config: ValidatorAgentConfig;
  try {
    if (!report || typeof report !== "object") throw new AgentInputSchemaError();
    injectionSource = findInjectionAttempt(report);
    if (injectionSource !== null) {
      return recordAndReturn("blocked", injectionBlocked(injectionSource));
    }
    payload = toAgentReportPayload(report);
    userPrompt = buildValidatorAgentUserPrompt(payload);
    if (Buffer.byteLength(userPrompt, "utf8") >= MAX_REPORT_PROMPT_BYTES) {
      throw new AgentInputSchemaError();
    }
    config = loadValidatorAgentConfig(env);
  } catch {
    return recordAndReturn("schema_error", unavailable());
  }

  const providers = allowedProviderOrder(config, env);
  if (providers.length === 0) return recordAndReturn("unavailable", unavailable());

  const evidenceRefs = new Set(payload.evidenceRefs);
  const chat = options.chatFn ?? chatLlm;
  for (const provider of providers) {
    let response: Awaited<ReturnType<typeof chatLlm>>;
    try {
      const request: LlmChatRequest = {
        model: buildProviderDescriptor(provider, env).defaultModel,
        messages: [
          { role: "system", content: VALIDATOR_AGENT_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        maxTokens: 1024,
        timeoutMs: 30_000,
        json: true,
        schema: VALIDATOR_AGENT_OUTPUT_SCHEMA,
      };
      response = await chat(request, {
        env,
        fetchFn: options.fetchFn,
        providers: [provider],
        maxAttempts: 1,
      });
    } catch {
      // Provider-Ausfall ist Verfügbarkeit, kein neues Urteil und kein Freitext-Fallback.
      continue;
    }

    const interpretation = parseAgentInterpretation(response?.content, evidenceRefs);
    if (!interpretation) return recordAndReturn("schema_error", unavailable());
    return recordAndReturn("ok", interpretation);
  }

  return recordAndReturn("unavailable", unavailable());
}

/** Exportierter Test-/Betriebswert — der Agenten-Textblock selbst bleibt unter 8 KB. */
export const VALIDATOR_AGENT_MAX_REPORT_PROMPT_BYTES = MAX_REPORT_PROMPT_BYTES;

/** Nur für Quellenwächter: Die Nutzdaten-Tags sind absichtlich fest benannt. */
export const VALIDATOR_AGENT_UNTRUSTED_DATA_TAG = REPORT_UNTRUSTED_DATA_TAG;
