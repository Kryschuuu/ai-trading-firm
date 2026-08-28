/**
 * Token-/Kosten-Deckel (Task 09, Regel 3).
 *
 * Harte Budgets je **Provider**, je **Agent** und **global** — konfigurierbar in
 * der Policy (`budgets`). Der Router erzwingt sie: ist das Budget eines Providers
 * erschöpft, wird auf ein lokales Modell zurückgestuft (Zwangsfallback) und der
 * Vorfall auditiert. Cloud-Nutzung ist damit **immer** gedeckelt, nie unbegrenzt.
 *
 * Tageswechsel: Der Tracker arbeitet auf einem Tages-Schlüssel (UTC), der aus der
 * injizierten Uhr stammt — deterministisch testbar, kein `Date.now()` im Kern.
 */
import { PROVIDER_IDS, type ProviderId } from "./types";
import type { RoutingPolicyBudget } from "./policy";

export type BudgetUsage = {
  tokens: number;
  costUsd: number;
};

export type BudgetSnapshot = {
  day: string;
  global: BudgetUsage & { tokensPerDay: number; costUsdPerDay: number };
  providers: Record<ProviderId, BudgetUsage & { tokensPerDay: number; costUsdPerDay: number }>;
  agents: Record<string, { tokens: number; tokensPerDay: number }>;
  escalations: Record<string, { approved: number; max: number }>;
};

export type BudgetClock = { now(): Date };

export type BudgetInput = {
  providers: Partial<Record<ProviderId, RoutingPolicyBudget>>;
  agents: Record<string, { tokensPerDay: number }>;
  global: RoutingPolicyBudget;
};

const DEFAULT_GLOBAL: RoutingPolicyBudget = { tokensPerDay: 6_000_000, costUsdPerDay: 10 };

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Führt die Tageszähler. Alle Methoden sind deterministisch bzgl. (Policy,
 * Uhr, Verbrauch) — keine Zufallswerte, keine versteckte Zeitquelle.
 */
export class BudgetTracker {
  private readonly providers: BudgetInput["providers"];
  private readonly agents: Record<string, { tokensPerDay: number }>;
  private readonly global: RoutingPolicyBudget;
  private readonly clock: BudgetClock;
  private readonly maxApprovedPerAgentPerDay: number;

  private day: string;
  private providerUsage: Record<ProviderId, BudgetUsage>;
  private agentUsage: Record<string, { tokens: number }>;
  private globalUsage: BudgetUsage;
  private approvals: Record<string, { day: string; count: number }>;

  constructor(input: Partial<BudgetInput>, opts: { clock?: BudgetClock; maxApprovedPerAgentPerDay?: number } = {}) {
    this.providers = input.providers ?? {};
    this.agents = input.agents ?? {};
    this.global = input.global ?? DEFAULT_GLOBAL;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.maxApprovedPerAgentPerDay = opts.maxApprovedPerAgentPerDay ?? 12;

    this.day = dayKey(this.clock.now());
    this.providerUsage = PROVIDER_IDS.reduce(
      (acc, id) => {
        acc[id] = { tokens: 0, costUsd: 0 };
        return acc;
      },
      {} as Record<ProviderId, BudgetUsage>
    );
    this.agentUsage = {};
    this.globalUsage = { tokens: 0, costUsd: 0 };
    this.approvals = {};
  }

  /** Setzt alle Zähler zurück, wenn ein neuer Tag begonnen hat. */
  private rollover(): void {
    const today = dayKey(this.clock.now());
    if (today === this.day) return;
    this.day = today;
    this.providerUsage = PROVIDER_IDS.reduce(
      (acc, id) => {
        acc[id] = { tokens: 0, costUsd: 0 };
        return acc;
      },
      {} as Record<ProviderId, BudgetUsage>
    );
    this.agentUsage = {};
    this.globalUsage = { tokens: 0, costUsd: 0 };
    this.approvals = {};
  }

  private limitFor(provider: ProviderId): RoutingPolicyBudget {
    return this.providers[provider] ?? { tokensPerDay: 0, costUsdPerDay: 0 };
  }

  private agentLimit(agent: string): number {
    return Number.isFinite(this.agents[agent]?.tokensPerDay) ? Number(this.agents[agent].tokensPerDay) : 0;
  }

  /**
   * Verbleibende Tokens eines Providers.
   * `tokensPerDay <= 0` bedeutet **kein Deckel** (nur für lokale Provider
   * sinnvoll) — niemals „0 Tokens übrig".
   */
  remainingTokens(provider: ProviderId): number {
    this.rollover();
    const limit = this.limitFor(provider);
    if (!Number.isFinite(limit.tokensPerDay) || limit.tokensPerDay <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit.tokensPerDay - this.providerUsage[provider].tokens);
  }

  /** Verbleibendes Kostenbudget in USD (`<= 0` = kein Deckel). */
  remainingCost(provider: ProviderId): number {
    this.rollover();
    const limit = this.limitFor(provider);
    if (!Number.isFinite(limit.costUsdPerDay) || limit.costUsdPerDay <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit.costUsdPerDay - this.providerUsage[provider].costUsd);
  }

  /** Verbleibendes Token-Budget eines Agenten (`<= 0` = kein Deckel). */
  remainingAgentTokens(agent: string): number {
    this.rollover();
    const limit = this.agentLimit(agent);
    if (limit <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit - (this.agentUsage[agent]?.tokens ?? 0));
  }

  /** true, wenn der Deckel (Tokens oder Kosten) erreicht ist. */
  isExhausted(provider: ProviderId): boolean {
    return this.remainingTokens(provider) <= 0 || this.remainingCost(provider) <= 0;
  }

  agentExhausted(agent: string): boolean {
    const limit = this.agentLimit(agent);
    if (limit <= 0) return false; // kein Deckel konfiguriert ⇒ nicht blockierend
    return this.remainingAgentTokens(agent) <= 0;
  }

  /** Prozentualer Verbrauch eines Providers (0..100, > 100 = über dem Deckel). */
  usagePercent(provider: ProviderId): number {
    this.rollover();
    const limit = this.limitFor(provider);
    if (!Number.isFinite(limit.tokensPerDay) || limit.tokensPerDay <= 0) return 0;
    return Math.round((this.providerUsage[provider].tokens / limit.tokensPerDay) * 1000) / 10;
  }

  /** Bucht Verbrauch; Werte <= 0 werden ignoriert (nie Negativbuchung). */
  consume(input: { provider: ProviderId; agent?: string; tokens?: number; costUsd?: number }): void {
    this.rollover();
    const tokens = Number.isFinite(input.tokens) && Number(input.tokens) > 0 ? Math.trunc(Number(input.tokens)) : 0;
    const cost = Number.isFinite(input.costUsd) && Number(input.costUsd) > 0 ? Number(input.costUsd) : 0;
    const p = this.providerUsage[input.provider];
    this.providerUsage[input.provider] = { tokens: p.tokens + tokens, costUsd: round6(p.costUsd + cost) };
    this.globalUsage = {
      tokens: this.globalUsage.tokens + tokens,
      costUsd: round6(this.globalUsage.costUsd + cost),
    };
    if (input.agent) {
      const a = this.agentUsage[input.agent] ?? { tokens: 0 };
      this.agentUsage[input.agent] = { tokens: a.tokens + tokens };
    }
  }

  /** Genehmigte Eskalationen je Agent/Tag (Policy-Deckel). */
  approvalsFor(agent: string): { count: number; max: number } {
    this.rollover();
    const entry = this.approvals[agent];
    return { count: entry && entry.day === this.day ? entry.count : 0, max: this.maxApprovedPerAgentPerDay };
  }

  countApproval(agent: string): void {
    this.rollover();
    const entry = this.approvals[agent];
    this.approvals[agent] = {
      day: this.day,
      count: (entry && entry.day === this.day ? entry.count : 0) + 1,
    };
  }

  snapshot(): BudgetSnapshot {
    this.rollover();
    const providers = PROVIDER_IDS.reduce(
      (acc, id) => {
        const limit = this.limitFor(id);
        acc[id] = {
          tokens: this.providerUsage[id].tokens,
          costUsd: this.providerUsage[id].costUsd,
          tokensPerDay: Number.isFinite(limit.tokensPerDay) ? limit.tokensPerDay : 0,
          costUsdPerDay: Number.isFinite(limit.costUsdPerDay) ? limit.costUsdPerDay : 0,
        };
        return acc;
      },
      {} as BudgetSnapshot["providers"]
    );
    const agents: BudgetSnapshot["agents"] = {};
    for (const agent of Object.keys({ ...this.agents, ...this.agentUsage })) {
      agents[agent] = {
        tokens: this.agentUsage[agent]?.tokens ?? 0,
        tokensPerDay: this.agentLimit(agent),
      };
    }
    const escalations: BudgetSnapshot["escalations"] = {};
    for (const agent of Object.keys(this.approvals)) {
      const entry = this.approvals[agent];
      if (entry.day !== this.day) continue;
      escalations[agent] = { approved: entry.count, max: this.maxApprovedPerAgentPerDay };
    }
    return {
      day: this.day,
      global: {
        tokens: this.globalUsage.tokens,
        costUsd: this.globalUsage.costUsd,
        tokensPerDay: this.global.tokensPerDay,
        costUsdPerDay: this.global.costUsdPerDay,
      },
      providers,
      agents,
      escalations,
    };
  }

  /** Nur Tests: Zähler auf einen Schlag leeren. */
  reset(): void {
    this.day = dayKey(this.clock.now());
    this.providerUsage = PROVIDER_IDS.reduce(
      (acc, id) => {
        acc[id] = { tokens: 0, costUsd: 0 };
        return acc;
      },
      {} as Record<ProviderId, BudgetUsage>
    );
    this.agentUsage = {};
    this.globalUsage = { tokens: 0, costUsd: 0 };
    this.approvals = {};
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
