/**
 * Routing-Policy (Task 09) — versionierte, schema-validierte Konfiguration.
 *
 * Regeln:
 *   - Die Policy ist eine **reine Datenstruktur** (JSON-serialisierbar). Sie liegt
 *     als Konstante im Code (`DEFAULT_ROUTING_POLICY`) und kann per
 *     `ROUTING_POLICY_PATH=/pfad/policy.json` überschrieben werden.
 *   - Ungültige Policy ⇒ **Startverweigerung** (`RoutingPolicyError`).
 *     Der Router arbeitet nie mit einer teilweise validen Policy.
 *   - Policy-Änderungen laufen ausschliesslich über Admin + Audit (siehe
 *     `PUT /api/routing/modes` und `docs/LLM_ROUTING.md`).
 *   - Determinismus: gleiche Policy + gleiche Eingaben ⇒ gleiche Entscheidung.
 *     Die Reihenfolge von `classes[*].providers` ist verbindlich.
 */
import { readFileSync } from "node:fs";
import {
  MODEL_CLASSES,
  PROVIDER_IDS,
  ROUTING_MODES,
  ROUTING_TASKS,
  TASK_COMPLEXITIES,
  RISK_TIERS,
  type ModelClass,
  type ModelClassLabel,
  type ProviderId,
  type RoutingMode,
  type RoutingTask,
  type TaskComplexity,
  type RiskTier,
} from "./types";

export const ROUTING_POLICY_ENV = "ROUTING_POLICY_PATH";

/** Cloud-Provider — für sie ist ein Budget-Deckel PFLICHT (Regel 3). */
const CLOUD_PROVIDER_IDS: readonly ProviderId[] = ["gemini", "anthropic"];

/** Version der Default-Policy — erscheint in JEDEM Audit-Eintrag. */
export const DEFAULT_POLICY_VERSION = "1.0.0";

export type RoutingPolicyProvider = {
  provider: ProviderId;
  /** Optionaler Modell-Tag; leer = Default-Modell des Providers. */
  model?: string;
};

export type RoutingPolicyClass = {
  label: ModelClassLabel;
  /** local = ausschliesslich lokale Provider; any = auch Cloud erlaubt. */
  deployment: "local" | "any";
  /** Dokumentierte Parametergrösse der Klasse (Billionen Parameter). */
  minParamsB: number;
  maxParamsB: number;
  /** Geordnete, deterministische Provider-Präferenz dieser Klasse. */
  providers: RoutingPolicyProvider[];
};

export type RoutingPolicyAgent = {
  mode: RoutingMode;
  /** Vorgegebene Klasse der Default-Tabelle (Startpunkt/hybrid-Grenze). */
  defaultClass?: ModelClass;
  /** Feste Modell-Tag-PINNUNG (nur Modus `manual`). */
  pinnedModel?: string;
  /** Obergrenze der Klasse (Admin-Deckel, gilt in allen Modi). */
  classCeiling?: ModelClass;
  /** Cloud explizit erlaubt (Default: true, aber IMMER budgetgedeckelt). */
  allowCloud?: boolean;
  /**
   * Admin-Freigabe: der Provider-Tagesdeckel greift nicht.
   * ACHTUNG: hebt NIE den Cloud-Gesamtdeckel auf und wird auditiert.
   */
  budgetExempt?: boolean;
};

export type RoutingPolicyBudget = {
  tokensPerDay: number;
  costUsdPerDay: number;
};

export type RoutingPolicyEscalation = {
  /** Mindestkomplexität für eine Genehmigung (Default: "high"). */
  minComplexity: TaskComplexity;
  /** Ab dieser Confidence gilt der Agent als sicher ⇒ Ablehnung. */
  maxConfidenceToApprove: number;
  /** Unter dieser Confidence ist eine Eskalation praktisch immer gerechtfertigt. */
  minConfidenceFloor: number;
  /** Klassen, die als Ziel beantragt werden dürfen. */
  allowedTargetClasses: ModelClass[];
  /** Maximal genehmigte Eskalationen je Agent und Tag. */
  maxApprovedPerAgentPerDay: number;
  /** Token-Überschuss/Latenzverletzung zählen als harte Trigger. */
  honorRuntimeTriggers: boolean;
};

export type RoutingPolicy = {
  version: string;
  /** Modus für Agenten ohne Tabelleneintrag. */
  defaultMode: RoutingMode;
  /** Klasse für Agenten/Tasks ohne Eintrag. */
  defaultClass: ModelClass;
  agents: Record<string, RoutingPolicyAgent>;
  classes: Record<ModelClass, RoutingPolicyClass>;
  /** Task → Klassen-Untergrenze („groß“ für Synthese/Selektion/Regime …). */
  taskOverrides: Partial<Record<RoutingTask, ModelClass>>;
  complexityFloor: Record<TaskComplexity, ModelClass>;
  riskFloor: Record<RiskTier, ModelClass>;
  escalation: RoutingPolicyEscalation;
  budgets: {
    providers: Partial<Record<ProviderId, RoutingPolicyBudget>>;
    agents: Record<string, { tokensPerDay: number }>;
    global: RoutingPolicyBudget;
  };
  /**
   * Fallback-Ketten. Schlüssel: `"<trigger>:<provider>"` (Trigger:
   * `timeout` · `quota` · `offline`) — Sonderfall `"default"`.
   */
  fallbackChains: Record<string, ProviderId[]>;
  /** Unter diesem Restkontingent (%) gilt ein Provider als nicht nutzbar. */
  quotaMinPercent: number;
  /** Intervall des Health-Pollers in ms (0 = aus). */
  healthPollerIntervalMs: number;
  /** Ab dieser EMA-Latenz (ms) gilt ein Provider als „zu langsam“. */
  maxLatencyEmaMs: number;
};

/** Fehler einer ungültigen Policy — führt zur Startverweigerung. */
export class RoutingPolicyError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(
      `Ungültige Routing-Policy (${errors.length} Fehler): ${errors.slice(0, 5).join("; ")}${
        errors.length > 5 ? "; …" : ""
      }`
    );
    this.name = "RoutingPolicyError";
    this.errors = errors;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default-Policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default-Routing-Tabelle (Vorgabe Task 09):
 *   CEO       → automatic          (Router entscheidet frei)
 *   RESEARCH  → large   (MODEL_C)
 *   TECHNICAL → local-small (MODEL_A)
 *   NEWS      → local-small (MODEL_A)
 *   RISK      → local-medium (MODEL_B)
 *   PORTFOLIO → local-medium (MODEL_B)
 */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: DEFAULT_POLICY_VERSION,
  defaultMode: "automatic",
  defaultClass: "MODEL_A",
  agents: {
    CEO: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: true },
    RESEARCH: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true },
    RESEARCH_ANALYST: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true },
    TECHNICAL: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false },
    TECHNICAL_ANALYST: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false },
    NEWS: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false },
    NEWS_ANALYST: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false },
    RISK: { mode: "automatic", defaultClass: "MODEL_B", allowCloud: false },
    RISK_MANAGER: { mode: "automatic", defaultClass: "MODEL_B", allowCloud: false },
    PORTFOLIO: { mode: "automatic", defaultClass: "MODEL_B", allowCloud: false },
    PORTFOLIO_ANALYST: { mode: "automatic", defaultClass: "MODEL_B", allowCloud: false },
    MACRO: { mode: "automatic", defaultClass: "MODEL_B", allowCloud: true },
    MACRO_ANALYST: { mode: "automatic", defaultClass: "MODEL_B", allowCloud: true },
    MARKET_SELECTION: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true },
    MARKET_SCANNER: { mode: "manual", pinnedModel: "none", defaultClass: "MODEL_A", allowCloud: false },
    BACKTEST: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false },
    BACKTEST_VERIFICATION: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false },
    APPROVER: { mode: "automatic", defaultClass: "MODEL_A", allowCloud: false },
    EXECUTOR: { mode: "manual", pinnedModel: "none", defaultClass: "MODEL_A", allowCloud: false },
    WEEKLY_REVIEW: { mode: "automatic", defaultClass: "MODEL_C", allowCloud: true },
  },
  classes: {
    MODEL_A: {
      label: "local-small",
      deployment: "local",
      minParamsB: 1,
      maxParamsB: 8,
      providers: [
        { provider: "ollama", model: "qwen2.5:3b-instruct-q4_K_M" },
        { provider: "openai" },
      ],
    },
    MODEL_B: {
      label: "local-medium",
      deployment: "local",
      minParamsB: 7,
      maxParamsB: 30,
      providers: [
        { provider: "ollama", model: "qwen2.5:7b-instruct-q4_K_M" },
        { provider: "openai" },
      ],
    },
    MODEL_C: {
      label: "large",
      deployment: "any",
      minParamsB: 30,
      maxParamsB: 1000,
      providers: [
        { provider: "ollama", model: "qwen2.5:14b-instruct-q4_K_M" },
        { provider: "gemini", model: "gemini-2.0-flash" },
        { provider: "anthropic", model: "claude-3-5-haiku-latest" },
      ],
    },
  },
  taskOverrides: {
    // klein
    json_classification: "MODEL_A",
    market_ranking: "MODEL_A",
    summarization: "MODEL_A",
    technical_analysis_standard: "MODEL_A",
    news_categorization: "MODEL_A",
    simple_risk_decision: "MODEL_A",
    // mittel
    research: "MODEL_B",
    // groß
    technical_news_synthesis: "MODEL_C",
    market_selection: "MODEL_C",
    portfolio_analysis: "MODEL_C",
    complex_research: "MODEL_C",
    regime_analysis: "MODEL_C",
    conflicting_evidence: "MODEL_C",
    strategy_development: "MODEL_C",
    weekly_report: "MODEL_C",
  },
  complexityFloor: {
    low: "MODEL_A",
    medium: "MODEL_B",
    high: "MODEL_C",
    critical: "MODEL_C",
  },
  riskFloor: {
    low: "MODEL_A",
    medium: "MODEL_B",
    high: "MODEL_C",
  },
  escalation: {
    minComplexity: "high",
    maxConfidenceToApprove: 0.75,
    minConfidenceFloor: 0.0,
    allowedTargetClasses: ["MODEL_B", "MODEL_C"],
    maxApprovedPerAgentPerDay: 12,
    honorRuntimeTriggers: true,
  },
  budgets: {
    providers: {
      ollama: { tokensPerDay: 5_000_000, costUsdPerDay: 0 },
      openai: { tokensPerDay: 500_000, costUsdPerDay: 5 },
      gemini: { tokensPerDay: 200_000, costUsdPerDay: 2 },
      anthropic: { tokensPerDay: 100_000, costUsdPerDay: 4 },
    },
    agents: {
      CEO: { tokensPerDay: 300_000 },
      RESEARCH: { tokensPerDay: 400_000 },
      TECHNICAL: { tokensPerDay: 200_000 },
      NEWS: { tokensPerDay: 200_000 },
      RISK: { tokensPerDay: 200_000 },
      PORTFOLIO: { tokensPerDay: 200_000 },
    },
    global: { tokensPerDay: 6_000_000, costUsdPerDay: 10 },
  },
  fallbackChains: {
    // Vorgabe Task 09: ollama-timeout → gemini; gemini-quota < 5 % → ollama; anthropic → ollama
    "timeout:ollama": ["gemini", "anthropic"],
    "quota:gemini": ["ollama"],
    "quota:anthropic": ["ollama"],
    "offline:anthropic": ["ollama", "gemini"],
    "offline:gemini": ["ollama", "anthropic"],
    "offline:ollama": ["gemini", "anthropic"],
    "offline:openai": ["ollama", "gemini"],
    default: ["ollama", "gemini", "anthropic"],
  },
  quotaMinPercent: 5,
  healthPollerIntervalMs: 60_000,
  maxLatencyEmaMs: 120_000,
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema-Validierung (rein, ohne externe Abhängigkeit)
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Prüft die Policy und liefert alle Fehler (leer = valide). */
export function validateRoutingPolicy(input: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const push = (msg: string): void => {
    errors.push(msg);
  };

  if (!isRecord(input)) {
    return { ok: false, errors: ["Policy muss ein Objekt sein."] };
  }

  // version
  if (typeof input.version !== "string" || input.version.trim().length === 0) {
    push("version: Pflichtfeld (nicht-leerer String).");
  } else if (!/^\d+\.\d+\.\d+/.test(input.version.trim())) {
    push(`version: erwartet SemVer (x.y.z), erhalten "${input.version}".`);
  }

  // defaultMode / defaultClass
  if (!ROUTING_MODES.includes(input.defaultMode as RoutingMode)) {
    push(`defaultMode: erwartet ${ROUTING_MODES.join("|")}, erhalten "${String(input.defaultMode)}".`);
  }
  if (!MODEL_CLASSES.includes(input.defaultClass as ModelClass)) {
    push(`defaultClass: erwartet ${MODEL_CLASSES.join("|")}, erhalten "${String(input.defaultClass)}".`);
  }

  // agents
  if (!isRecord(input.agents)) {
    push("agents: Objekt erwartet.");
  } else {
    for (const [agent, raw] of Object.entries(input.agents)) {
      if (agent.trim().length === 0) push("agents: leerer Agenten-Schlüssel.");
      if (!isRecord(raw)) {
        push(`agents.${agent}: Objekt erwartet.`);
        continue;
      }
      if (!ROUTING_MODES.includes(raw.mode as RoutingMode)) {
        push(`agents.${agent}.mode: erwartet ${ROUTING_MODES.join("|")}, erhalten "${String(raw.mode)}".`);
      }
      if (raw.defaultClass !== undefined && !MODEL_CLASSES.includes(raw.defaultClass as ModelClass)) {
        push(`agents.${agent}.defaultClass: erwartet ${MODEL_CLASSES.join("|")}.`);
      }
      if (raw.classCeiling !== undefined && !MODEL_CLASSES.includes(raw.classCeiling as ModelClass)) {
        push(`agents.${agent}.classCeiling: erwartet ${MODEL_CLASSES.join("|")}.`);
      }
      if (raw.pinnedModel !== undefined && typeof raw.pinnedModel !== "string") {
        push(`agents.${agent}.pinnedModel: String erwartet.`);
      }
      if (raw.mode === "manual" && (typeof raw.pinnedModel !== "string" || raw.pinnedModel.length === 0)) {
        push(`agents.${agent}: Modus manual verlangt ein pinnedModel (oder "none").`);
      }
      if (raw.allowCloud !== undefined && typeof raw.allowCloud !== "boolean") {
        push(`agents.${agent}.allowCloud: Boolean erwartet.`);
      }
      if (raw.budgetExempt !== undefined && typeof raw.budgetExempt !== "boolean") {
        push(`agents.${agent}.budgetExempt: Boolean erwartet.`);
      }
    }
  }

  // classes
  if (!isRecord(input.classes)) {
    push("classes: Objekt erwartet.");
  } else {
    for (const cls of MODEL_CLASSES) {
      const raw = (input.classes as Record<string, unknown>)[cls];
      if (!isRecord(raw)) {
        push(`classes.${cls}: Objekt erwartet.`);
        continue;
      }
      if (raw.deployment !== "local" && raw.deployment !== "any") {
        push(`classes.${cls}.deployment: erwartet local|any.`);
      }
      if (!isFiniteNumber(raw.minParamsB) || !isFiniteNumber(raw.maxParamsB) || raw.minParamsB > raw.maxParamsB) {
        push(`classes.${cls}: minParamsB/maxParamsB müssen Zahlen mit min <= max sein.`);
      }
      if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
        push(`classes.${cls}.providers: nicht-leere Liste erwartet.`);
      } else {
        const seen = new Set<string>();
        raw.providers.forEach((entry, index) => {
          const where = `classes.${cls}.providers[${index}]`;
          if (!isRecord(entry)) {
            push(`${where}: Objekt erwartet.`);
            return;
          }
          if (!PROVIDER_IDS.includes(entry.provider as ProviderId)) {
            push(`${where}.provider: erwartet ${PROVIDER_IDS.join("|")}, erhalten "${String(entry.provider)}".`);
            return;
          }
          if (seen.has(String(entry.provider))) {
            push(`${where}: Provider ${String(entry.provider)} doppelt in der Klasse.`);
          }
          seen.add(String(entry.provider));
          if (entry.model !== undefined && typeof entry.model !== "string") {
            push(`${where}.model: String erwartet.`);
          }
        });
      }
    }
  }

  // taskOverrides
  if (input.taskOverrides !== undefined) {
    if (!isRecord(input.taskOverrides)) {
      push("taskOverrides: Objekt erwartet.");
    } else {
      for (const [task, cls] of Object.entries(input.taskOverrides)) {
        if (!ROUTING_TASKS.includes(task as RoutingTask)) {
          push(`taskOverrides.${task}: unbekannte Task-ID (Whitelist: ${ROUTING_TASKS.join("|")}).`);
        }
        if (!MODEL_CLASSES.includes(cls as ModelClass)) {
          push(`taskOverrides.${task}: erwartet ${MODEL_CLASSES.join("|")}.`);
        }
      }
    }
  }

  // complexityFloor / riskFloor
  const checkFloor = (name: string, keys: readonly string[]): void => {
    const raw = (input as Record<string, unknown>)[name];
    if (!isRecord(raw)) {
      push(`${name}: Objekt erwartet.`);
      return;
    }
    for (const key of keys) {
      if (!MODEL_CLASSES.includes(raw[key] as ModelClass)) {
        push(`${name}.${key}: erwartet ${MODEL_CLASSES.join("|")}.`);
      }
    }
  };
  checkFloor("complexityFloor", TASK_COMPLEXITIES);
  checkFloor("riskFloor", RISK_TIERS);

  // escalation
  if (!isRecord(input.escalation)) {
    push("escalation: Objekt erwartet.");
  } else {
    const esc = input.escalation;
    if (!TASK_COMPLEXITIES.includes(esc.minComplexity as TaskComplexity)) {
      push(`escalation.minComplexity: erwartet ${TASK_COMPLEXITIES.join("|")}.`);
    }
    for (const key of ["maxConfidenceToApprove", "minConfidenceFloor"] as const) {
      if (!isFiniteNumber(esc[key]) || esc[key] < 0 || esc[key] > 1) {
        push(`escalation.${key}: Zahl im Bereich 0..1 erwartet.`);
      }
    }
    if (isFiniteNumber(esc.maxConfidenceToApprove) && isFiniteNumber(esc.minConfidenceFloor)) {
      if (esc.minConfidenceFloor > esc.maxConfidenceToApprove) {
        push("escalation: minConfidenceFloor darf nicht über maxConfidenceToApprove liegen.");
      }
    }
    if (!Array.isArray(esc.allowedTargetClasses) || esc.allowedTargetClasses.length === 0) {
      push("escalation.allowedTargetClasses: nicht-leere Liste erwartet.");
    } else {
      for (const cls of esc.allowedTargetClasses) {
        if (!MODEL_CLASSES.includes(cls as ModelClass)) {
          push(`escalation.allowedTargetClasses: unbekannte Klasse "${String(cls)}".`);
        }
      }
    }
    if (!isFiniteNumber(esc.maxApprovedPerAgentPerDay) || esc.maxApprovedPerAgentPerDay < 0) {
      push("escalation.maxApprovedPerAgentPerDay: Zahl >= 0 erwartet.");
    }
    if (typeof esc.honorRuntimeTriggers !== "boolean") {
      push("escalation.honorRuntimeTriggers: Boolean erwartet.");
    }
  }

  // budgets
  if (!isRecord(input.budgets)) {
    push("budgets: Objekt erwartet.");
  } else {
    const checkBudget = (where: string, raw: unknown, requireCost: boolean): void => {
      if (!isRecord(raw)) {
        push(`${where}: Objekt erwartet.`);
        return;
      }
      if (!isFiniteNumber(raw.tokensPerDay) || raw.tokensPerDay < 0) {
        push(`${where}.tokensPerDay: Zahl >= 0 erwartet.`);
      }
      if (requireCost && (!isFiniteNumber(raw.costUsdPerDay) || raw.costUsdPerDay < 0)) {
        push(`${where}.costUsdPerDay: Zahl >= 0 erwartet.`);
      }
    };
    checkBudget("budgets.global", (input.budgets as Record<string, unknown>).global, true);
    const providers = (input.budgets as Record<string, unknown>).providers;
    if (providers !== undefined) {
      if (!isRecord(providers)) {
        push("budgets.providers: Objekt erwartet.");
      } else {
        for (const [id, raw] of Object.entries(providers)) {
          if (!PROVIDER_IDS.includes(id as ProviderId)) {
            push(`budgets.providers.${id}: unbekannter Provider.`);
          }
          checkBudget(`budgets.providers.${id}`, raw, true);
          // REGEL 3: Cloud-Nutzung ist IMMER gedeckelt — niemals unbegrenzt.
          if (CLOUD_PROVIDER_IDS.includes(id as ProviderId) && isRecord(raw)) {
            const tokens = Number(raw.tokensPerDay);
            const cost = Number(raw.costUsdPerDay);
            if (!Number.isFinite(tokens) || tokens <= 0) {
              push(`budgets.providers.${id}.tokensPerDay: Cloud-Provider brauchen einen Deckel > 0 (nie unbegrenzt).`);
            }
            if (!Number.isFinite(cost) || cost < 0) {
              push(`budgets.providers.${id}.costUsdPerDay: Zahl >= 0 erwartet (Cloud immer gedeckelt).`);
            }
          }
        }
      }
    }
    const agents = (input.budgets as Record<string, unknown>).agents;
    if (agents !== undefined) {
      if (!isRecord(agents)) {
        push("budgets.agents: Objekt erwartet.");
      } else {
        for (const [agent, raw] of Object.entries(agents)) {
          checkBudget(`budgets.agents.${agent}`, raw, false);
        }
      }
    }
  }

  // fallbackChains
  if (!isRecord(input.fallbackChains)) {
    push("fallbackChains: Objekt erwartet.");
  } else {
    for (const [key, chain] of Object.entries(input.fallbackChains)) {
      if (!Array.isArray(chain)) {
        push(`fallbackChains.${key}: Liste von Provider-IDs erwartet.`);
        continue;
      }
      for (const id of chain) {
        if (!PROVIDER_IDS.includes(id as ProviderId)) {
          push(`fallbackChains.${key}: unbekannter Provider "${String(id)}".`);
        }
      }
      if (key !== "default") {
        const [trigger, provider] = key.split(":");
        if (!["timeout", "quota", "offline"].includes(trigger ?? "")) {
          push(`fallbackChains.${key}: Schlüssel erwartet "<timeout|quota|offline>:<provider>" oder "default".`);
        } else if (!PROVIDER_IDS.includes(provider as ProviderId)) {
          push(`fallbackChains.${key}: unbekannter Provider im Schlüssel.`);
        }
      }
    }
  }

  // Skalare
  if (!isFiniteNumber(input.quotaMinPercent) || input.quotaMinPercent < 0 || input.quotaMinPercent > 100) {
    push("quotaMinPercent: Zahl im Bereich 0..100 erwartet.");
  }
  if (!isFiniteNumber(input.healthPollerIntervalMs) || input.healthPollerIntervalMs < 0) {
    push("healthPollerIntervalMs: Zahl >= 0 erwartet.");
  }
  if (!isFiniteNumber(input.maxLatencyEmaMs) || input.maxLatencyEmaMs < 0) {
    push("maxLatencyEmaMs: Zahl >= 0 erwartet.");
  }

  return { ok: errors.length === 0, errors };
}

/** Wirft bei ungültiger Policy (Startverweigerung). */
export function assertRoutingPolicy(input: unknown): RoutingPolicy {
  const result = validateRoutingPolicy(input);
  if (!result.ok) throw new RoutingPolicyError(result.errors);
  return input as RoutingPolicy;
}

/**
 * Lädt die Policy: Default oder (wenn gesetzt) aus `ROUTING_POLICY_PATH`.
 * Eine ungültige Datei bricht den Start ab — keine stille Teilkonfiguration.
 */
export function loadRoutingPolicy(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8")
): RoutingPolicy {
  const path = env[ROUTING_POLICY_ENV];
  if (!path || path.trim().length === 0) {
    return assertRoutingPolicy(structuredClone(DEFAULT_ROUTING_POLICY));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFile(path.trim()));
  } catch (e) {
    throw new RoutingPolicyError([
      `Policy-Datei "${path}" nicht lesbar/parsbar: ${e instanceof Error ? e.message : String(e)}`,
    ]);
  }
  try {
    return assertRoutingPolicy(raw);
  } catch (e) {
    if (e instanceof RoutingPolicyError) {
      throw new RoutingPolicyError(e.errors.map((err) => `${path}: ${err}`));
    }
    throw e;
  }
}
