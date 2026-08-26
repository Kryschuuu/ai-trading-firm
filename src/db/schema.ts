import {
  pgTable,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Risikoparameter zur Anzeige/Dokumentation.
 * ACHTUNG: Die *wirksamen* Limits stehen in src/lib/riskGuard.ts (Code, nicht DB).
 * Diese Tabelle ist bewusst nur beschreibend — sonst könnte ein kompromittierter
 * Datenbankzugriff die Sicherheitsgrenzen aufweichen.
 */
export const riskConfig = pgTable("risk_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  value: numeric("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Eine Agentenrolle in der Firma. */
export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  /** CEO | RESEARCH | BACKTEST | RISK_MANAGER | APPROVER | EXECUTOR */
  role: text("role").notNull(),
  /** Ollama-Modelltag, z. B. qwen2.5:7b-instruct-q4_K_M */
  model: text("model").notNull(),
  /** IDLE | RUNNING | BLOCKED | STOPPED */
  status: text("status").notNull().default("IDLE"),
  systemPrompt: text("system_prompt").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Ein Handelsauftrag/Ziel für die Firma. */
export const missions = pgTable("missions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  objective: text("objective").notNull(),
  symbol: text("symbol"),
  riskBudget: numeric("risk_budget").notNull().default("0.02"),
  maxPositionPct: numeric("max_position_pct").notNull().default("0.25"),
  /** PENDING | ACTIVE | COMPLETED | KILLED */
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Regelwerk des Makro-Zyklus (CEO/Research) — die einzige Brücke zur
 * Ausführungsebene. Jede Zeile ist IMMUTABLE (eine Version); Aktivierung und
 * Superseding werden über Status + Zeiger abgebildet. Der Mikro-Executor
 * lädt ausschließlich `status='ACTIVE'`-Zeilen und liest sie in den RAM-Cache.
 *
 * Sicherheitsmodell: Das Feld `condition`/`action` ist ein JSONB-Objekt, aber
 * der Mikro-Executor wertet es NUR über die strikte, im Code verankerte
 * Whitelist aus `src/lib/ruleEngine.ts` aus. Unbekannte Felder/Operatoren
 * werden dort verworfen — eine manipulierte oder bösartige Regel kann nie
 * mehr auslösen, als die Code-Whitelist erlaubt.
 */
export const tradeRules = pgTable("trade_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Logische Regel-Identität über alle Versionen hinweg (v1 → v2 → …). */
  ruleKey: uuid("rule_key").notNull(),
  version: integer("version").notNull().default(1),
  /** DRAFT | ACTIVE | SUPERSEDED | PAUSED | ARCHIVED | REJECTED */
  status: text("status").notNull().default("DRAFT"),
  name: text("name").notNull(),
  symbol: text("symbol").notNull(),
  missionId: uuid("mission_id").references(() => missions.id),
  /** Normalisiertes, validiertes JSON (siehe ruleEngine.ts RuleCondition). */
  condition: jsonb("condition").notNull(),
  /** Normalisiertes, geklemmtes JSON (RuleAction). */
  action: jsonb("action").notNull(),
  /** Normalisiertes JSON (RuleWindow: timeframe, cooldown, maxExecutions …). */
  window: jsonb("window").notNull(),
  /** Kanonischer Hash über symbol+condition+action (Idempotenz + Diff). */
  signature: text("signature").notNull(),
  rationale: text("rationale"),
  /** CEO | RESEARCH | MANUAL */
  sourceRole: text("source_role").notNull().default("MANUAL"),
  sourceAgentId: uuid("source_agent_id").references(() => agents.id),
  /** SIGMA=LLM, FALLBACK=deterministische Regel-Engine. */
  sourceMode: text("source_mode").notNull().default("SIGMA"),
  // Selbstreferenzierende Versionierung bewusst OHNE DB-FK (TS-Zirkularität;
  // Integrität wird in ruleService in Transaktionen erzwungen).
  previousVersionId: uuid("previous_version_id"),
  supersededById: uuid("superseded_by_id"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  riskScore: numeric("risk_score").notNull().default("0.5"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /**
   * Partielle UNIQUE-Indizes: pro Regel (ruleKey) und pro Symbol/Mandat
   * höchstens EINE aktive Version — die Aktivierung ist damit atomar,
   * egal wie viele Prozessinstanzen gleichzeitig aktivieren.
   *
   * KORRIGIERT (v1.6.1):
   * 1) Der Index lag als EINE SQL-Zeile mit Tuple `("symbol", COALESCE(...))`
   *    an. Drizzle-Kit rendert daraus `USING btree (("symbol", ...))` — ein
   *    Row-Constructor im btree-Index, den PostgreSQL verweigert (syntax
   *    error 42601, `drizzle-kit push` brach ab).
   * 2) `mission_id` ist UUID → Platzhalter ist die NULL-UUID, nicht ''
   *    (invalid input syntax for type uuid).
   * 3) Beide Spalten werden als SQL-Chunks angegeben: Drizzle-Kit markiert
   *    Mixed-Index (Spalte + Expression) beim Introspektieren auf
   *    Index-Ebene als "expression index", was beim Push diff zu
   *    DROP/CREATE-Drift auf jedem Lauf führte. Zwei reine SQL-Chunks
   *    squashen auf beiden Seiten identisch → stabiler Push.
   *    Semantik: pro (Symbol, Mandat) höchstens EINE ACTIVE-Regel.
   */
  uniqueIndex("trade_rules_active_unique").on(t.ruleKey).where(sql`${t.status} = 'ACTIVE'`),
  uniqueIndex("trade_rules_active_symbol_unique")
    .on(sql`"symbol"`, sql`COALESCE(${t.missionId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
    .where(sql`${t.status} = 'ACTIVE'`),
]);

/**
 * Ausführungs-Feedback des Mikro-Zyklus: jede Trigger-Entscheidung, jeder
 * Block und jeder Fehler — die Grundlage für den Lern-Loop des CEO.
 * Bewusst NUR bei relevanten Ereignissen geschrieben (Trigger/Block/Fehler),
 * nie bei jedem Tick, sonst füllt der Hot-Path die Datenbank.
 */
export const ruleExecutions = pgTable("rule_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  ruleId: uuid("rule_id").notNull().references(() => tradeRules.id),
  missionId: uuid("mission_id").references(() => missions.id),
  symbol: text("symbol").notNull(),
  /** TRIGGERED | BLOCKED | ERROR | EXPIRED */
  status: text("status").notNull(),
  triggerPrice: numeric("trigger_price"),
  triggerVolume: numeric("trigger_volume"),
  snapshot: jsonb("snapshot"),
  /** Ausgewertete Bedingungen (Feld → tatsächlicher Wert) fürs Audit. */
  evaluated: jsonb("evaluated"),
  /** Order-/Fill-Informationen bei TRIGGERED, sonst der Block-Grund. */
  fill: jsonb("fill"),
  orderId: text("order_id"),
  /** Hot-Path-Latenz: reine Bewertungszeit in Mikrosekunden (ohne Fill). */
  latencyMicros: integer("latency_micros"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("rule_executions_rule_idx").on(t.ruleId, t.createdAt)]);

/** Backtest-Läufe einer Regel gegen historische Kerzen (deterministisch). */
export const ruleBacktests = pgTable("rule_backtests", {
  id: uuid("id").primaryKey().defaultRandom(),
  ruleId: uuid("rule_id").notNull().references(() => tradeRules.id),
  missionId: uuid("mission_id").references(() => missions.id),
  symbol: text("symbol").notNull(),
  timeframe: text("timeframe").notNull(),
  from: timestamp("from", { withTimezone: true }).notNull(),
  to: timestamp("to", { withTimezone: true }).notNull(),
  trades: integer("trades").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  pnl: numeric("pnl").notNull().default("0"),
  profitFactor: numeric("profit_factor"),
  maxDrawdownPct: numeric("max_drawdown_pct"),
  /** Vollständige Turn-Liste für die Prüfung im Detail. */
  detail: jsonb("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("rule_backtests_rule_idx").on(t.ruleId, t.createdAt)]);

/** Position (Paper oder real, je nach Broker-Adapter). */
export const positions = pgTable("positions", {
  id: uuid("id").primaryKey().defaultRandom(),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // LONG | SHORT
  qty: numeric("qty").notNull(),
  entryPrice: numeric("entry_price").notNull(),
  currentPrice: numeric("current_price"),
  stopLoss: numeric("stop_loss"),
  takeProfit: numeric("take_profit"),
  exitPrice: numeric("exit_price"),
  realizedPnl: numeric("realized_pnl"),
  /** STOP_LOSS | TAKE_PROFIT | MANUAL_FLATTEN | AGENT_CLOSE | RULE_EXECUTION | null bei offen */
  exitReason: text("exit_reason"),
  broker: text("broker").notNull(),
  status: text("status").notNull().default("OPEN"), // OPEN | CLOSED
  missionId: uuid("mission_id").references(() => missions.id),
  /** Regel (trade_rules) aus dem Mikro-Zyklus, die diese Position eröffnet hat. */
  ruleId: uuid("rule_id").references(() => tradeRules.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Kommunikation der Agenten — das „institutionelle Gedächtnis“ der Firma. */
export const agentMessages = pgTable("agent_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").references(() => agents.id),
  missionId: uuid("mission_id").references(() => missions.id),
  type: text("type").notNull(), // INSTRUCTION | REQUEST | APPROVAL | REJECTION | REPORT
  content: text("content").notNull(),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Revisionssicheres Protokoll: jede Entscheidung, jedes Guardrail-Urteil. */
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  event: text("event").notNull(),
  agentId: uuid("agent_id").references(() => agents.id),
  missionId: uuid("mission_id").references(() => missions.id),
  level: text("level").notNull().default("INFO"), // INFO | WARN | CRITICAL
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Vorschläge, die auf Freigabe warten (Approver-Workflow). */
export const proposals = pgTable("proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").references(() => missions.id),
  agentId: uuid("agent_id").references(() => agents.id),
  action: text("action").notNull(), // OPEN | CLOSE | ADJUST
  proposedDetail: jsonb("detail").notNull(),
  riskScore: numeric("risk_score").notNull().default("0"),
  status: text("status").notNull().default("PENDING"), // PENDING | APPROVED | REJECTED | AUTO_REJECTED
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

/** Historie des Not-Halts. Der jeweils neueste Eintrag bestimmt den Zustand. */
export const killSwitches = pgTable("kill_switches", {
  id: uuid("id").primaryKey().defaultRandom(),
  reason: text("reason").notNull().default("MANUAL"),
  triggeredBy: text("triggered_by").notNull(),
  armed: boolean("armed").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Equity-Kurve: ein Snapshot pro Monitor-Tick und pro ausgeführtem Trade.
 * Basis für die Kurve und die Tages-/Wochen-/Monatsreports.
 */
export const equitySnapshots = pgTable("equity_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  equity: numeric("equity").notNull(),
  cash: numeric("cash").notNull(),
  openPositions: integer("open_positions").notNull().default(0),
  /** Realisiertes P&L des laufenden Berliner Tages (Summe geschlossener Trades). */
  realizedPnlToday: numeric("realized_pnl_today").notNull().default("0"),
  /** Auslöser des Snapshots: TICK | TRADE | CLOSE | FLATTEN | BOOT */
  trigger: text("trigger").notNull().default("TICK"),
});
