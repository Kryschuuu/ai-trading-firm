import type { AgentRow, MissionRow } from "@/lib/types";

export type ConfigEntry = {
  key: string;
  label: string;
  unit: "%" | "x" | "count" | "bool" | "rr" | "idx";
  description: string;
  value: number | boolean;
  min: number;
  max: number;
  locked: boolean;
  defaultValue: number | boolean;
};

/** Zustand des adaptiven Risk-Limit-Systems (GET /api/firm/risk/volatility). */
export type AdaptiveRiskStatus = {
  regime: "NORMAL" | "ELEVATED" | "EXTREME";
  enabled: boolean;
  factor: number;
  baseMaxRiskPerTrade: number;
  effectiveMaxRiskPerTrade: number;
  lastUpdate: string | null;
  lastChange: string | null;
  lastError: string | null;
  stale: boolean;
  reason: string;
  indicators: {
    name: string;
    label: string;
    value: number | null;
    threshold: number;
    available: boolean;
    triggered: boolean;
  }[];
  events: {
    at: string;
    prevRegime: string;
    regime: string;
    factor: number;
    baseMaxRiskPerTrade: number;
    effectiveMaxRiskPerTrade: number;
    triggered: string[];
    reason: string;
  }[];
  config: Record<string, number | boolean>;
  bounds: Record<string, [number, number]>;
};

export type FirmData = {
  agents: AgentRow[];
  missions: MissionRow[];
  positions: any[];
  proposals: any[];
  /**
   * Letzten Audit-Zeilen aus GET /api/firm. Die Übersicht rendert inzwischen
   * den gepagten Audit-Trail über GET /api/firm/log (AuditTrailPanel) — das
   * Feld bleibt Teil des API-Vertrags für andere Clients.
   */
  auditLog: any[];
  riskLimits: Record<string, any>;
  riskDefaults: Record<string, any>;
  riskCeilings: Record<string, [number, number]>;
  riskConfig: ConfigEntry[];
  volatilityConfig: ConfigEntry[];
  adaptiveRisk: AdaptiveRiskStatus | null;
  killSwitchArmed: boolean;
  killSwitches: any[];
  messages: any[];
  ollama: { available: boolean; baseUrl: string; models: string[]; error?: string };
  scheduler: { enabled: boolean; lastTickAt: string | null };
  account: {
    equity: number;
    startingEquity: number;
    freeCash: number;
    drawdownPct: number;
    openPositions: number;
    broker: string;
    paperMode: boolean;
    livePositions: any[];
  };
  brokers: Record<string, { label: string; assets: string; paperApi: boolean; openSource: boolean; note: string }>;
  requireHumanApproval: boolean;
  timestamp: string;
};

export const defaultData: FirmData = {
  agents: [], missions: [], positions: [], proposals: [],
  auditLog: [], riskLimits: {}, riskDefaults: {}, riskCeilings: {}, riskConfig: [],
  volatilityConfig: [], adaptiveRisk: null,
  killSwitchArmed: false,
  killSwitches: [], messages: [], ollama: { available: false, baseUrl: "", models: [] },
  scheduler: { enabled: false, lastTickAt: null },
  account: {
    equity: 0, startingEquity: 0, freeCash: 0, drawdownPct: 0,
    openPositions: 0, broker: "PAPER", paperMode: true, livePositions: [],
  },
  brokers: {},
  requireHumanApproval: false,
  timestamp: "",
};
