/**
 * Persistenz-, Versionierungs- und Feedback-Schicht für das Makro-Regelwerk.
 *
 * Diese Datei ist bewusst LLM-frei (kein Import von ollama/llmProvider/engine),
 * damit der Mikro-Executor-Prozess (scripts/micro-executor.ts) sie gefahrlos
 * nutzen kann, ohne versehentlich LLM-Code in den Ausführungspfad zu ziehen.
 *
 * Modell „immutable versions“:
 *   - Jede Zeile in `trade_rules` ist EINE unveränderliche Version.
 *   - `ruleKey` = logische Regel-Identität; `version` = aufsteigend.
 *   - `status` = DRAFT | ACTIVE | SUPERSEDED | PAUSED | ARCHIVED | REJECTED.
 *   - Aktivierung einer neuen Version superseded die alte atomar (DB-
 *     Transaktion + partieller UNIQUE-Index: max. 1 ACTIVE pro Regel).
 *   - Rollback = vorherige Version wieder aktivieren (Zeiger austauschen).
 *
 * Der Mikro-Executor liest ausschließlich ACTIVE-Zeilen und cached sie im RAM;
 * er sieht die Versionierung gar nicht — für ihn gibt es nur „die aktuelle
 * Regel“, wodurch er immer konsistent mit der letzten Aktivierung arbeitet.
 */
import { db } from "@/db";
import {
  tradeRules,
  ruleExecutions,
  ruleBacktests,
  positions as positionsTable,
  auditLog,
} from "@/db/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  ruleSignature,
  type RuleSpec,
  type BacktestResult,
} from "./ruleEngine";
import { getLimits } from "./riskGuard";

export type RuleRow = typeof tradeRules.$inferSelect;

/** Audit-Eintrag ohne Engine-Import (bleibt LLM-frei). */
export async function ruleAudit(
  event: string,
  level: "INFO" | "WARN" | "CRITICAL",
  detail: unknown,
  missionId?: string | null,
  agentId?: string | null
): Promise<void> {
  await db.insert(auditLog).values({
    event,
    level,
    detail: detail as object,
    missionId: missionId ?? null,
    agentId: agentId ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lesen
// ─────────────────────────────────────────────────────────────────────────────

export async function listRules(): Promise<RuleRow[]> {
  return db.select().from(tradeRules).orderBy(desc(tradeRules.createdAt));
}

export async function getRule(id: string): Promise<RuleRow | null> {
  const rows = await db.select().from(tradeRules).where(eq(tradeRules.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getActiveRules(): Promise<RuleRow[]> {
  return db.select().from(tradeRules).where(eq(tradeRules.status, "ACTIVE"));
}

export async function getRuleVersions(ruleKey: string): Promise<RuleRow[]> {
  return db
    .select()
    .from(tradeRules)
    .where(eq(tradeRules.ruleKey, ruleKey))
    .orderBy(desc(tradeRules.version));
}

export function rowToSpec(row: RuleRow): RuleSpec {
  return {
    name: row.name,
    symbol: row.symbol,
    missionId: row.missionId ?? null,
    condition: row.condition as unknown as RuleSpec["condition"],
    action: row.action as unknown as RuleSpec["action"],
    window: row.window as unknown as RuleSpec["window"],
    rationale: row.rationale ?? "",
    sourceRole: (["CEO", "RESEARCH", "MANUAL"].includes(row.sourceRole)
      ? row.sourceRole
      : "MANUAL") as RuleSpec["sourceRole"],
    riskScore: Number(row.riskScore ?? 0.5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Anlegen / Versionieren
// ─────────────────────────────────────────────────────────────────────────────

export type UpsertResult = {
  ok: boolean;
  rule?: RuleRow;
  /** true = neue Zeile/Version entstanden; false = idempotent, unverändert. */
  created?: boolean;
  changed?: boolean;
  reason?: string;
  error?: string;
};

/**
 * Idempotentes Upsert einer normalisierten Regel (nur SANITIZED specs!).
 *
 * Idempotenz: gleiche Signatur + bereits ACTIVE → keine neue Version.
 * Änderung:   gleiche Regel (symbol+mission+sourceRole) mit NEUER Signatur
 *             → neue Version (DRAFT) desselben ruleKey.
 * Neu:        keine aktive Regel für symbol+mission → ruleKey v1 (DRAFT).
 *
 * Neue Versionen landen bewusst als DRAFT: Die Aktivierung (menschlich oder
 * über REQUIRE_HUMAN_APPROVAL) ist ein expliziter, auditiertier Schritt.
 */
export async function upsertRuleSpec(
  spec: RuleSpec,
  sourceAgentId?: string | null
): Promise<UpsertResult> {
  const signature = ruleSignature(spec);
  const active = await db
    .select()
    .from(tradeRules)
    .where(
      and(
        eq(tradeRules.status, "ACTIVE"),
        eq(tradeRules.symbol, spec.symbol),
        spec.missionId ? eq(tradeRules.missionId, spec.missionId) : isNull(tradeRules.missionId)
      )
    )
    .limit(1);

  // Idempotenz: identische Regel ist bereits aktiv → nichts tun.
  if (active[0] && active[0].signature === signature) {
    return { ok: true, rule: active[0], created: false, changed: false, reason: "IDEMPOTENT" };
  }

  const newVersion = active[0]?.version != null ? active[0].version + 1 : 1;
  const ruleKey = active[0]?.ruleKey ?? crypto.randomUUID();

  const [row] = await db
    .insert(tradeRules)
    .values({
      ruleKey,
      version: newVersion,
      status: "DRAFT",
      name: spec.name,
      symbol: spec.symbol,
      missionId: spec.missionId,
      condition: spec.condition as unknown as object,
      action: spec.action as unknown as object,
      window: spec.window as unknown as object,
      signature,
      rationale: spec.rationale || null,
      sourceRole: spec.sourceRole,
      sourceAgentId: sourceAgentId ?? null,
      riskScore: String(spec.riskScore),
      previousVersionId: active[0]?.id ?? null,
    })
    .returning();

  await ruleAudit(
    "RULE_CREATED",
    "INFO",
    {
      ruleId: row.id,
      ruleKey,
      version: row.version,
      symbol: row.symbol,
      signature,
      sourceRole: row.sourceRole,
      previousVersionId: row.previousVersionId,
    },
    spec.missionId,
    sourceAgentId
  );
  return { ok: true, rule: row, created: true, changed: active[0]?.ruleKey === ruleKey, reason: "NEW_VERSION" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lebenszyklus
// ─────────────────────────────────────────────────────────────────────────────

export type RuleActionOutcome =
  | { ok: true; rule: RuleRow; detail: string }
  | { ok: false; error: string };

/**
 * Aktiviert eine Regel und superseded atomar alle anderen ACTIVE-Regeln
 * desselben Symbols/Mandats. Der Mikro-Executor sieht beim nächsten
 * Cache-Reload (oder per Invalidation) nur noch die neue Version.
 */
export async function activateRule(ruleId: string, by = "MANUAL"): Promise<RuleActionOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(tradeRules).where(eq(tradeRules.id, ruleId)).limit(1);
    if (!row) return { ok: false as const, error: "Regel nicht gefunden" };
    if (row.status === "ACTIVE") {
      return { ok: true, rule: row, detail: "bereits aktiv" };
    }
    if (row.status === "SUPERSEDED" || row.status === "ARCHIVED") {
      return { ok: false as const, error: `Regel ist ${row.status} — kann nicht reaktiviert werden (neue Version oder Rollback nutzen)` };
    }

    const others = await tx
      .select()
      .from(tradeRules)
      .where(
        and(
          eq(tradeRules.status, "ACTIVE"),
          eq(tradeRules.symbol, row.symbol),
          row.missionId ? eq(tradeRules.missionId, row.missionId) : isNull(tradeRules.missionId),
          sql`${tradeRules.id} <> ${row.id}`
        )
      );

    for (const other of others) {
      await tx
        .update(tradeRules)
        .set({
          status: "SUPERSEDED",
          deactivatedAt: new Date(),
          supersededById: row.id,
          updatedAt: new Date(),
        })
        .where(eq(tradeRules.id, other.id));
    }

    const [updated] = await tx
      .update(tradeRules)
      .set({ status: "ACTIVE", activatedAt: new Date(), deactivatedAt: null, updatedAt: new Date() })
      .where(eq(tradeRules.id, row.id))
      .returning();

    await ruleAudit(
      "RULE_ACTIVATED",
      "WARN",
      { ruleId: row.id, version: row.version, symbol: row.symbol, by, superseded: others.map((o) => `${o.id}@v${o.version}`) },
      row.missionId,
      row.sourceAgentId
    );
    return { ok: true, rule: updated, detail: `aktiviert (superseded ${others.length})` };
  });
}

/** Pausieren: Regel bleibt erhalten, wird aber nicht mehr ausgeführt. */
export async function pauseRule(ruleId: string, by = "MANUAL"): Promise<RuleActionOutcome> {
  const [row] = await db.select().from(tradeRules).where(eq(tradeRules.id, ruleId)).limit(1);
  if (!row) return { ok: false, error: "Regel nicht gefunden" };
  if (row.status !== "ACTIVE") return { ok: false, error: `Nur ACTIVE-Regeln können pausiert werden (Status: ${row.status})` };
  const [updated] = await db
    .update(tradeRules)
    .set({ status: "PAUSED", deactivatedAt: new Date(), updatedAt: new Date() })
    .where(eq(tradeRules.id, ruleId))
    .returning();
  await ruleAudit("RULE_PAUSED", "WARN", { ruleId, version: row.version, by }, row.missionId, row.sourceAgentId);
  return { ok: true, rule: updated, detail: "pausiert" };
}

export async function archiveRule(ruleId: string, by = "MANUAL"): Promise<RuleActionOutcome> {
  const [row] = await db.select().from(tradeRules).where(eq(tradeRules.id, ruleId)).limit(1);
  if (!row) return { ok: false, error: "Regel nicht gefunden" };
  if (row.status === "ACTIVE" || row.status === "SUPERSEDED") {
    return { ok: false, error: `Regel ist ${row.status} — erst pausieren bzw. Rollback der aktiven Version nutzen` };
  }
  const [updated] = await db
    .update(tradeRules)
    .set({ status: "ARCHIVED", deactivatedAt: new Date(), updatedAt: new Date() })
    .where(eq(tradeRules.id, ruleId))
    .returning();
  await ruleAudit("RULE_ARCHIVED", "INFO", { ruleId, version: row.version, by }, row.missionId, row.sourceAgentId);
  return { ok: true, rule: updated, detail: "archiviert" };
}

/** Abgelehnte (z. B. vom Risk-Gate verworfene) Regel-Entwürfe fürs Audit. */
export async function rejectRule(ruleId: string, reason: string, by = "RISK_GATE"): Promise<RuleActionOutcome> {
  const [row] = await db.select().from(tradeRules).where(eq(tradeRules.id, ruleId)).limit(1);
  if (!row) return { ok: false, error: "Regel nicht gefunden" };
  if (row.status !== "DRAFT") return { ok: false, error: `Nur DRAFT-Regeln können abgelehnt werden (Status: ${row.status})` };
  const [updated] = await db
    .update(tradeRules)
    .set({ status: "REJECTED", deactivatedAt: new Date(), updatedAt: new Date() })
    .where(eq(tradeRules.id, ruleId))
    .returning();
  await ruleAudit("RULE_REJECTED", "WARN", { ruleId, version: row.version, reason, by }, row.missionId, row.sourceAgentId);
  return { ok: true, rule: updated, detail: `abgelehnt: ${reason.slice(0, 200)}` };
}

/**
 * Rollback: die vorherige Version (−1) wird wieder ACTIVE, die aktuelle wird
 * SUPERSEDED. Atomar in einer Transaktion; danach sieht der Mikro-Executor
 * nach Cache-Reload wieder die alte Regel — der Stand der Welt ist die DB.
 */
export async function rollbackRule(ruleId: string, by = "MANUAL"): Promise<RuleActionOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(tradeRules).where(eq(tradeRules.id, ruleId)).limit(1);
    if (!current) return { ok: false as const, error: "Regel nicht gefunden" };
    if (current.status !== "ACTIVE") {
      return { ok: false as const, error: `Rollback nur für ACTIVE-Regeln (Status: ${current.status})` };
    }
    if (!current.previousVersionId) {
      return { ok: false as const, error: "Keine Vorgängerversion vorhanden — kann nicht rollbacken" };
    }
    const [prev] = await tx
      .select()
      .from(tradeRules)
      .where(eq(tradeRules.id, current.previousVersionId))
      .limit(1);
    if (!prev) return { ok: false as const, error: "Vorgängerversion nicht gefunden (inkonsistente Daten)" };

    await tx
      .update(tradeRules)
      .set({ status: "SUPERSEDED", deactivatedAt: new Date(), supersededById: prev.id, updatedAt: new Date() })
      .where(eq(tradeRules.id, current.id));
    const [rolledBack] = await tx
      .update(tradeRules)
      .set({ status: "ACTIVE", supersededById: null, activatedAt: new Date(), deactivatedAt: null, updatedAt: new Date() })
      .where(eq(tradeRules.id, prev.id))
      .returning();

    await ruleAudit(
      "RULE_ROLLED_BACK",
      "CRITICAL",
      { from: current.id, to: prev.id, version: `${current.version} → ${prev.version}`, by },
      current.missionId,
      current.sourceAgentId
    );
    return { ok: true, rule: rolledBack, detail: `Rollback auf v${prev.version} (${prev.id})` };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ausführungs-Feedback (Lern-Loop des Makro-Zyklus)
// ─────────────────────────────────────────────────────────────────────────────

export type RuleFeedbackStats = {
  ruleId: string;
  status: string;
  triggered24h: number;
  blocked24h: number;
  errors24h: number;
  closedTrades: number;
  realizedPnl: number;
  winRate: number | null;
  lastTriggeredAt: string | null;
};

/**
 * Aggregiert die Ausführungsrealität einer Regel: Trigger/Blöcke/Fehler der
 * letzten 24 h plus realisierte P&L aller durch sie eröffneten, geschlossenen
 * Positionen. Das ist der Rückkanal für den CEO („Was ist im Markt wirklich
 * passiert?“).
 */
export async function ruleFeedback(ruleIds?: string[]): Promise<RuleFeedbackStats[]> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const rules = await listRules();
  const executionsFilter =
    ruleIds && ruleIds.length > 0 ? inArray(ruleExecutions.ruleId, ruleIds) : undefined;
  const positionsFilter =
    ruleIds && ruleIds.length > 0 ? inArray(positionsTable.ruleId, ruleIds) : undefined;

  const [execRows, posRows] = await Promise.all([
    db
      .select({
        ruleId: ruleExecutions.ruleId,
        status: ruleExecutions.status,
        createdAt: ruleExecutions.createdAt,
      })
      .from(ruleExecutions)
      .where(and(sql`${ruleExecutions.createdAt} >= ${since}`, executionsFilter ?? sql`true`)),
    db
      .select({
        ruleId: positionsTable.ruleId,
        realizedPnl: positionsTable.realizedPnl,
        status: positionsTable.status,
      })
      .from(positionsTable)
      .where(and(
        sql`${positionsTable.ruleId} IS NOT NULL`,
        positionsFilter ?? sql`true`
      )),
  ]);

  const byRule = new Map<string, RuleFeedbackStats>();
  for (const rule of rules) {
    byRule.set(rule.id, {
      ruleId: rule.id,
      status: rule.status,
      triggered24h: 0,
      blocked24h: 0,
      errors24h: 0,
      closedTrades: 0,
      realizedPnl: 0,
      winRate: null,
      lastTriggeredAt: null,
    });
  }

  // Nur Regeln mit Feedback ausgeben, sonst Liste zu lang (Diagnose).
  const relevant = new Set<string>();
  for (const e of execRows) {
    const s = byRule.get(e.ruleId);
    if (!s) continue;
    relevant.add(e.ruleId);
    if (e.status === "TRIGGERED") {
      s.triggered24h++;
      s.lastTriggeredAt = e.createdAt.toISOString();
    } else if (e.status === "BLOCKED") s.blocked24h++;
    else if (e.status === "ERROR") s.errors24h++;
  }
  const winsByRule = new Map<string, number>();
  for (const p of posRows) {
    const s = p.ruleId ? byRule.get(p.ruleId) : undefined;
    if (!s || p.status !== "CLOSED") continue;
    relevant.add(p.ruleId as string);
    s.closedTrades++;
    s.realizedPnl += Number(p.realizedPnl ?? 0);
    if (Number(p.realizedPnl ?? 0) > 0) {
      winsByRule.set(p.ruleId as string, (winsByRule.get(p.ruleId as string) ?? 0) + 1);
    }
  }
  for (const s of byRule.values()) {
    if (s.closedTrades > 0) {
      s.winRate = Number(((winsByRule.get(s.ruleId) ?? 0) / s.closedTrades).toFixed(2));
    }
  }
  return [...byRule.values()].filter((s) => relevant.has(s.ruleId) || ruleIds?.includes(s.ruleId));
}

/** Aktuelle aktive Regeln um Live-Feedback angereichert (für CEO + API). */
export async function activeRulesWithFeedback(): Promise<
  (RuleRow & { feedback: RuleFeedbackStats | null })[]
> {
  const rules = await getActiveRules();
  const stats = await ruleFeedback(rules.map((r) => r.id));
  const map = new Map(stats.map((s) => [s.ruleId, s]));
  return rules.map((r) => ({ ...r, feedback: map.get(r.id) ?? null }));
}

/** Letzte Ausführungs-Feedback-Zeilen (Diagnose/API), optional je Regel. */
export async function listRuleExecutions(
  ruleId?: string,
  limit = 20
): Promise<typeof ruleExecutions.$inferSelect[]> {
  const q = db
    .select()
    .from(ruleExecutions)
    .orderBy(desc(ruleExecutions.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return ruleId ? q.where(eq(ruleExecutions.ruleId, ruleId)) : q;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backtests
// ─────────────────────────────────────────────────────────────────────────────

export async function saveBacktest(ruleId: string, result: BacktestResult): Promise<void> {
  await db.insert(ruleBacktests).values({
    ruleId,
    missionId: null,
    symbol: result.symbol,
    timeframe: result.timeframe,
    from: new Date(),
    to: new Date(),
    trades: result.stats.trades,
    wins: result.stats.wins,
    pnl: String(result.stats.pnl),
    profitFactor: result.stats.profitFactor != null ? String(result.stats.profitFactor) : null,
    maxDrawdownPct: String(result.stats.maxDrawdownPct),
    detail: result as unknown as object,
  });
  await ruleAudit("RULE_BACKTESTED", "INFO", {
    ruleId,
    symbol: result.symbol,
    trades: result.stats.trades,
    pnl: result.stats.pnl,
    profitFactor: result.stats.profitFactor,
  });
}

export async function listBacktests(ruleId?: string, limit = 10): Promise<typeof ruleBacktests.$inferSelect[]> {
  const where = ruleId ? eq(ruleBacktests.ruleId, ruleId) : undefined;
  const q = db.select().from(ruleBacktests).orderBy(desc(ruleBacktests.createdAt)).limit(limit);
  return where ? q.where(where) : q;
}

/** Sensible Grenze: Rule-Action darf nie über die aktuellen Limits hinausgehen. */
export function ruleWithinRuntimeLimits(spec: RuleSpec): string[] {
  const limits = getLimits();
  const issues: string[] = [];
  if (spec.action.riskBudgetPct > limits.maxRiskPerTrade) issues.push("riskBudgetPct über Limits");
  if (spec.action.maxPositionPct > limits.maxPositionPct) issues.push("maxPositionPct über Limits");
  if (spec.action.takeProfitRR > limits.takeProfitRR) issues.push("takeProfitRR über Limits");
  return issues;
}
