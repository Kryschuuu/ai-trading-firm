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
  primaryKey,
  check,
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
  /**
   * Optimistic-Lock-Version (W2, v1.36.24): wird bei JEDEM Prompt-Update
   * inkrementiert (`version = version + 1`). Der Prompt-Editor sendet die
   * geladene `expectedVersion` mit; ein veralteter Stand erhält 409 statt
   * stillen Überschreibens (last-write-wins). Default 1 hält
   * Alt-Installationen abwärtskompatibel.
   */
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ein Handelsauftrag/Ziel für die Firma.
 *
 * Seit v1.35.0 kennt eine Mission zwei Typen (`scope`):
 *
 *   * `SINGLE_SYMBOL` — ein Instrument (`symbol` Pflicht). Verhalten wie vor
 *     v1.35.0; der Default-Wert hält Alt-Installationen unverändert lauffähig.
 *   * `SCAN_UNIVERSE` — die Mission scannt ein **Marktsegment** (`segment`,
 *     z. B. `INDICES`, `PENNY`, `ALL`). Die Kandidaten werden zur Laufzeit aus
 *     der Instrument-Registry bestimmt (`src/lib/missionUniverse.ts`), stehen
 *     also nie als kopierte Liste in der Datenbank.
 *
 * `templateId` dokumentiert, aus welcher Vorlage (`src/lib/missionTemplates.ts`)
 * die Mission entstanden ist — reine Nachvollziehbarkeit, keine FK-Beziehung
 * (der Vorlagenkatalog lebt im Code, nicht in der DB).
 *
 * Migration: `npx drizzle-kit push` ergänzt die drei Spalten mit Defaults;
 * bestehende Zeilen bleiben unverändert (siehe CHANGELOG 1.35.0).
 */
export const missions = pgTable("missions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  objective: text("objective").notNull(),
  /** Einzel-Symbol bei `scope = SINGLE_SYMBOL`, sonst NULL. */
  symbol: text("symbol"),
  /** SINGLE_SYMBOL | SCAN_UNIVERSE (Allowlist in src/lib/missionTemplates.ts). */
  scope: text("scope").notNull().default("SINGLE_SYMBOL"),
  /** Marktsegment bei `scope = SCAN_UNIVERSE` (z. B. ALL, INDICES, PENNY). */
  segment: text("segment"),
  /** Vorlagen-Slug, aus dem die Mission entstand (nullable, ohne FK). */
  templateId: text("template_id"),
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

/**
 * Vergleichbar persistierte Walk-Forward-Runs (GAP-01, v1.51.0).
 * Append-only (insert-only, kein Update-Pfad): ein Lauf = EINE Zeile mit
 * Regel-Referenz + Kostenprofil (`params_json`), Aggregaten (`metrics_json`)
 * und Fensterdetails (`windows_json`). Runs entstehen NUR via CLI
 * (`scripts/run-backtest.ts`); Lesen via `GET /api/firm/backtests*`
 * (`firm.read`). Migration: `drizzle/2026-09-19_backtest_runs.sql`
 * (append-only, idempotent; alternativ `npx drizzle-kit push`).
 *
 * RMA-P1-04 (v1.52.0) — Trade-Ledger-Spalten (additiv, Migration
 * `drizzle/2026-09-20_backtest_trades.sql`): `idempotency_key` (stabiler
 * Schlüssel des Laufs; Retry ⇒ derselbe Run, partieller UNIQUE-Index),
 * `trade_count` (Anzahl persistierter `backtest_trades`-Zeilen),
 * `reconciliation_status` + `reconciliation_json` (Abgleich Trade-Zeilen ↔
 * Run-Aggregate, siehe `src/backtest/tradeLedger.ts`). Alle vier Spalten
 * sind NULL für Alt-Runs (vor v1.52.0): NULL = „kein Trade-Ledger
 * persistiert“ — bewusst NICHT 0 (Fail-closed-Regel: unavailable ≠ 0).
 */
export const backtestRuns = pgTable("backtest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  instrumentId: text("instrument_id").notNull(),
  timeframe: text("timeframe").notNull(),
  fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
  toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
  /** Regel-Ref + Regel-Spezifikation + Fenster + Kostenprofil. */
  paramsJson: jsonb("params_json").notNull(),
  /** Aggregate OOS/IS (Kennzahlen je Aggregat). */
  metricsJson: jsonb("metrics_json").notNull(),
  /** Kennzahlen + Trade-Hash je IS/OOS-Fenster. */
  windowsJson: jsonb("windows_json").notNull(),
  /** Code-Version des Laufs (APP_VERSION, Vergleichbarkeit). */
  codeVersion: text("code_version").notNull(),
  /**
   * Stabiler Idempotency-Key des Laufs (RMA-P1-04): `wf1:<sha256>` über die
   * Lauf-Identität (Instrument, Zeitraum, Regel-Signatur, Fenster, Kosten,
   * Code-Version, Trade-Hashes). Ein Retry mit gleichem Key liefert den
   * bestehenden Run zurück statt einen zweiten zu schreiben. NULL = Alt-Run.
   */
  idempotencyKey: text("idempotency_key"),
  /** Anzahl persistierter Trade-Zeilen (NULL = kein Ledger, Alt-Run). */
  tradeCount: integer("trade_count"),
  /** `RECONCILED` (Ledger gegen Aggregate geprüft) oder NULL (Alt-Run). */
  reconciliationStatus: text("reconciliation_status"),
  /** Abgleich-Evidenz (Checks, Deltas, Toleranzen, Fenster-Hashes). */
  reconciliationJson: jsonb("reconciliation_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("backtest_runs_instrument_idx").on(t.instrumentId, t.createdAt),
  uniqueIndex("backtest_runs_idempotency_key_unique")
    .on(t.idempotencyKey)
    .where(sql`${t.idempotencyKey} IS NOT NULL`),
  check("backtest_runs_trade_count_check", sql`${t.tradeCount} IS NULL OR ${t.tradeCount} >= 0`),
  check(
    "backtest_runs_reconciliation_status_check",
    sql`${t.reconciliationStatus} IS NULL OR ${t.reconciliationStatus} IN ('RECONCILED')`
  ),
]);

/**
 * Trade-Level-Wahrheitsquelle eines Walk-Forward-Runs (RMA-P1-04, v1.52.0).
 *
 * Eine Zeile je abgeschlossenem Trade eines Evaluations-Laufs
 * (Fenster × Segment IS/OOS). Append-only: Zeilen entstehen ausschließlich
 * atomar zusammen mit ihrem Run (`persistBacktestRun`, eine Transaktion);
 * es gibt keinen Update- und keinen Code-Löschpfad.
 *
 * Einheiten/Semantik (siehe docs/BACKTESTING.md §5):
 *   - Preise (`entry_price`, `exit_price`) in Kontowährung je Basiseinheit,
 *     `qty` in Basiseinheiten, `notional`/PnL/Gebühren/Funding/Slippage in
 *     Kontowährung. `pnl_pct` in Prozent des Notionals.
 *   - `pnl_net = pnl_gross − fees + funding` (Kontosicht: Funding negativ =
 *     gezahlt). `pnl_net`, `fees`, `slippage`, `notional`, `pnl_pct` tragen
 *     die 4-Nachkommastellen-Rundung der Engine, `funding` 8 Stellen,
 *     Preise/`qty` sind ungerundete Simulator-Doubles (exakter Roundtrip
 *     über `numeric`, daraus reproduzierbarer Trade-Hash).
 *   - `funding` NULL = Engine ohne Funding-Ausweis (nicht 0).
 *   - Zeit: `entry_ts`/`exit_ts` = Ereigniszeit (Open-Zeitstempel der Kerze,
 *     auf deren Schlusskurs der Fill simuliert wurde); Berechnungszeit des
 *     Laufs = `backtest_runs.created_at` bzw. `params_json.createdAt`.
 *   - `seq` = stabile Reihenfolge im Run (1..N): Fenster aufsteigend, IS vor
 *     OOS, darin Engine-Schließreihenfolge. `trade_ref` = Engine-ID
 *     (`POS-n`, eindeutig je Evaluations-Lauf).
 *
 * FK ohne Cascade (Repo-Konvention): ein Run mit Trades kann nur gelöscht
 * werden, wenn seine Trades zuvor explizit gelöscht wurden — kein stilles
 * Mitlöschen einer Wahrheitsquelle. Migration:
 * `drizzle/2026-09-20_backtest_trades.sql` (append-only, idempotent).
 */
export const backtestTrades = pgTable("backtest_trades", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => backtestRuns.id),
  /** Stabile Sequenz im Run (1..N, kanonische Reihenfolge). */
  seq: integer("seq").notNull(),
  /** Walk-Forward-Fensterindex (0-basiert). */
  windowIndex: integer("window_index").notNull(),
  /** IS | OOS */
  segment: text("segment").notNull(),
  /** Engine-Trade-ID innerhalb des Evaluations-Laufs (`POS-n`). */
  tradeRef: text("trade_ref").notNull(),
  strategyId: text("strategy_id").notNull(),
  symbol: text("symbol").notNull(),
  /** LONG | SHORT */
  side: text("side").notNull(),
  qty: numeric("qty").notNull(),
  notional: numeric("notional").notNull(),
  entryTs: timestamp("entry_ts", { withTimezone: true }).notNull(),
  exitTs: timestamp("exit_ts", { withTimezone: true }).notNull(),
  entryPrice: numeric("entry_price").notNull(),
  exitPrice: numeric("exit_price").notNull(),
  /** Brutto-PnL = qty × (Exit − Entry) (LONG) bzw. qty × (Entry − Exit) (SHORT). */
  pnlGross: numeric("pnl_gross").notNull(),
  /** Netto-PnL der Engine (Brutto − Gebühren + Funding), 4 Nachkommastellen. */
  pnlNet: numeric("pnl_net").notNull(),
  pnlPct: numeric("pnl_pct").notNull(),
  fees: numeric("fees").notNull(),
  /** Funding in Kontosicht (negativ = gezahlt); NULL = nicht ausgewiesen. */
  funding: numeric("funding"),
  slippage: numeric("slippage").notNull(),
  exitReason: text("exit_reason").notNull(),
  durationBars: integer("duration_bars").notNull(),
  /** Herkunft (Fenstergrenzen, Regel-Signatur, Simulator-Seed, Engine-ID). */
  provenanceJson: jsonb("provenance_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("backtest_trades_run_seq_unique").on(t.runId, t.seq),
  uniqueIndex("backtest_trades_run_window_ref_unique").on(t.runId, t.windowIndex, t.segment, t.tradeRef),
  index("backtest_trades_run_window_idx").on(t.runId, t.windowIndex, t.segment, t.seq),
  index("backtest_trades_run_symbol_idx").on(t.runId, t.symbol, t.seq),
  check("backtest_trades_seq_check", sql`${t.seq} >= 1`),
  check("backtest_trades_window_index_check", sql`${t.windowIndex} >= 0`),
  check("backtest_trades_segment_check", sql`${t.segment} IN ('IS', 'OOS')`),
  check("backtest_trades_side_check", sql`${t.side} IN ('LONG', 'SHORT')`),
  check("backtest_trades_qty_check", sql`${t.qty} > 0`),
  check("backtest_trades_notional_check", sql`${t.notional} >= 0`),
  check("backtest_trades_prices_check", sql`${t.entryPrice} > 0 AND ${t.exitPrice} > 0`),
  check("backtest_trades_time_check", sql`${t.exitTs} >= ${t.entryTs}`),
  check("backtest_trades_fees_check", sql`${t.fees} >= 0`),
  check("backtest_trades_slippage_check", sql`${t.slippage} >= 0`),
  check("backtest_trades_duration_check", sql`${t.durationBars} >= 1`),
  check(
    "backtest_trades_exit_reason_check",
    sql`${t.exitReason} IN ('STOP_LOSS', 'TAKE_PROFIT', 'SIGNAL_EXIT', 'MAX_HOLDING', 'RISK_STOP', 'END_OF_DATA')`
  ),
]);

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
  /**
   * GAP-02 (v1.42.0): kumuliertes Funding dieser Position (Perpetuals) in
   * Kontowährung. Vorzeichenkonvention (Kontosicht/Cashflow, siehe
   * src/lib/funding.ts): negativ = gezahlt (LONG bei positiver Funding-Rate),
   * positiv = erhalten (SHORT bei positiver Rate). Default 0 = neutral
   * (PAPER_FUNDING_RATE_PCT_PER_8H=0) — Alt-Installationen und bestehende
   * Tests bleiben unverändert. Wert bleibt nach Schließen stehen
   * (Historie/Lifetime-Ausweis, z. B. SUM in GET /api/firm).
   * Migration: drizzle/2026-09-18_positions_funding.sql (append-only,
   * idempotent; alternativ `npx drizzle-kit push`).
   */
  fundingPaid: numeric("funding_paid").notNull().default("0"),
  /**
   * Exit-Grund (Taxonomie, GAP-05 / v1.44.0 erweitert):
   *   STOP_LOSS | TAKE_PROFIT | TRAILING_STOP | TIME_STOP |
   *   MANUAL_FLATTEN | AGENT_CLOSE | RULE_EXECUTION | null bei offen.
   * TRAILING_STOP / TIME_STOP sind neu (server-seitiges Exit-Management).
   */
  exitReason: text("exit_reason"),
  /**
   * GAP-05 (v1.44.0): persistierter Trailing-Stop-Level (absoluter Kurs).
   * NULL = (noch) nicht bewaffnet / nicht aktiv. Wird im Monitor-Tick
   * ratcheted (LONG: nur nach oben, SHORT: nur nach unten) und ist die
   * einzige Wahrheit für den Trailing-Auslöser — Prozess-Neustart verliert
   * keinen Stop, weil der Monitor ihn aus dieser Spalte liest (kein Memory-
   * Only-Zustand). Migration: `drizzle/2026-09-18_exit_management.sql`
   * (append-only, idempotent) oder `npx drizzle-kit push`.
   */
  trailingStop: numeric("trailing_stop"),
  /**
   * GAP-05 (v1.44.0): ist der Trailing-Stop für diese Position bewaffnet?
   * NOT NULL DEFAULT false — Alt-Installationen und bestehende Tests zeigen
   * per Default „nicht bewaffnet“ (Verhaltensneutralität). Zusammen mit
   * `trailing_stop` crash-safe persistiert.
   */
  trailingArmed: boolean("trailing_armed").notNull().default(false),
  broker: text("broker").notNull(),
  status: text("status").notNull().default("OPEN"), // OPEN | CLOSED
  missionId: uuid("mission_id").references(() => missions.id),
  /** Regel (trade_rules) aus dem Mikro-Zyklus, die diese Position eröffnet hat. */
  ruleId: uuid("rule_id").references(() => tradeRules.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // RESTORE-01 (v1.36.37, MEDIUM): Der Restore des Firmenzustands
  // (`getBroker()`), der Monitor-Tick und der Mikro-Executor fragen alle nach
  // `status = 'OPEN'`. Ohne Index war das ein Sequenz-Scan über die
  // append-only wachsende Tabelle (20.000+ Zeilen sind im Regelbetrieb
  // normal) — bei jedem Kaltstart und, vor dem Fix, bei jedem einzelnen
  // Aufruf. Der partielle Index enthält nur die offenen Zeilen und bedient
  // zugleich die Symbol-Lookups (`WHERE status = 'OPEN' AND symbol = …`).
  index("positions_open_idx")
    .on(t.symbol)
    .where(sql`${t.status} = 'OPEN'`),
]);

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

/**
 * Broker-Credentials der Control Plane (Task 08) — IMMER verschluesselt.
 *
 * `envelope` enthaelt NIE Klartext: AES-256-GCM-Envelope (Version, IV,
 * Auth-Tag, Ciphertext, Base64) mit AAD = Venue-ID. Schluessel ausschliesslich
 * aus Env/KMS (SECRET_STORE_KEY). Kein keyHint, kein Feldname, der einen
 * Schluessel verraet — die Antworten der Credential-API sind status-only.
 * Migration: `npx drizzle-kit push` (siehe CHANGELOG 1.16.0).
 */
export const brokerCredentials = pgTable("broker_credentials", {
  venue: text("venue").primaryKey(),
  envelope: text("envelope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Persistierter Control-Plane-Zustand je Venue (C4, v1.36.16).
 *
 * Vorher lebte `VenueControlState` nur in `globalThis.__controlPlaneStates`
 * (Map): Credentials waren persistent, der Zustand nicht — nach einem
 * Prozess-Neustart zeigte der Broker-Tab `configured=true, connected=false`
 * (INITIAL), bis jemand erneut testete. Jetzt ist die Map nur noch Cache,
 * diese Tabelle die Wahrheit: jedes `writeState()` upsertet die Zeile, ein
 * kalter `readState()` laedt sie.
 *
 * Inhalt ist status-only (Ebenen, Rechte-NAMEN, Zaehler, Zeitstempel,
 * SAFE-Fehlercodes) — NIE Secret-Inhalt, kein Envelope, kein keyHint.
 * `live_enabled` ist eine informative Momentaufnahme; die Wahrheit bleibt
 * der Live-Gate-Enforcer (readGateState) und wird beim Laden neu projiziert.
 * `layers` ist der vollstaendige 6-Ebenen-Snapshot (verlustfreie
 * Rehydrierung); die Einzelspalten sind die abfragbare Projektion.
 * Additiv, kein Bruch: `npx drizzle-kit push` (oder
 * `drizzle/2026-09-04_c4_venue_control_state.sql`).
 */
export const venueControlState = pgTable("venue_control_state", {
  venue: text("venue").primaryKey(),
  configured: boolean("configured").notNull().default(false),
  connected: boolean("connected").notNull().default(false),
  permissions: jsonb("permissions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  liveEnabled: boolean("live_enabled").notNull().default(false),
  lastProbe: timestamp("last_probe", { withTimezone: true }),
  connectionState: text("connection_state").notNull().default("off"),
  discoveryState: text("discovery_state").notNull().default("off"),
  discoveryCount: integer("discovery_count").notNull().default(0),
  discoveryLastSync: timestamp("discovery_last_sync", { withTimezone: true }),
  lastError: text("last_error"),
  /** Vollstaendiger Ebenen-Snapshot `{ connection, marketDiscovery, permissions, paper, testnet, live }`. */
  layers: jsonb("layers").$type<Record<string, { state: string; at: string | null; detail?: string | null }>>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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

/**
 * Order-Intents (H2, v1.36.19) — der DB-seitige Reservierungsschritt, der die
 * Broker-Ausführungsschleuse über mehrere Node-Prozesse hinweg atomar macht.
 *
 * PROBLEM (Audit H2): `PaperBroker` hält Positionen/Cash im Prozessspeicher.
 * Zwei Next.js-Worker (oder Next.js + Mikro-Executor) können denselben
 * Offene-Positionen-Stand hydratisieren, beide die Guardrails bestehen und
 * beide eine Position in die DB schreiben — `globalThis` ist kein verteiltes
 * Schloss. Diese Tabelle + `withAccountLock` (`src/lib/broker.ts`,
 * `pg_advisory_xact_lock`) machen die Sequenz Reserve → Guard → Fill →
 * Persist zu EINER exklusiven Postgres-Transaktion je Konto.
 *
 * Ablauf: `PaperBroker.submitAtomic()` legt VOR der In-Memory-Änderung eine
 * Zeile mit `status='RESERVED'` an (in derselben Transaktion wie Guard +
 * Cash-Debit + Positions-Insert). Bei Ablehnung → `REJECTED`; bei Erfolg →
 * `FILLED`. Der partielle UNIQUE-Index erzwingt „höchstens eine offene
 * Reservierung pro Symbol" — ein zweiter, gleichzeitiger Reservierungs-
 * versuch für dasselbe Symbol schlägt mit Postgres-Fehlercode 23505 fehl
 * (Mapping → `POSITION_ALREADY_OPEN`), selbst wenn zwei Prozesse den
 * `pg_advisory_xact_lock` aus irgendeinem Grund nicht seriell durchlaufen.
 *
 * `account` ist bewusst text (nicht FK) — heute nur `"PAPER"`, aber additiv
 * für künftige Live-Konten ohne Schema-Bruch.
 */
export const orderIntents = pgTable("order_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  account: text("account").notNull().default("PAPER"),
  symbol: text("symbol").notNull(),
  side: text("side").notNull(), // LONG | SHORT
  qty: numeric("qty").notNull(),
  /** RESERVED | FILLED | REJECTED | CANCELED */
  status: text("status").notNull().default("RESERVED"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Höchstens EINE offene Reservierung pro Symbol — unabhängig vom Konto,
  // spiegelt die bestehende Broker-Regel „ein Symbol, eine offene Position".
  uniqueIndex("order_intents_reserved_symbol_unique")
    .on(t.symbol)
    .where(sql`${t.status} = 'RESERVED'`),
  index("order_intents_account_idx").on(t.account, t.createdAt),
]);

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

/**
 * Trade-Journal mit Agenten-Attribution (GAP-03, v1.43.0).
 *
 * VERKNÜPFUNG, die bisher fehlte: Position ↔ Entscheidungskette der Agenten.
 * Eine Zeile pro Position (UNIQUE `position_id`), append-only in der
 * Lebenszyklus-Semantik:
 *
 *   1. Bei Eröffnung (Engine-/Mikro-Executor-Pfad) entsteht die Zeile mit
 *      `decisionSnapshot` — dem unveränderlichen Foto der Entscheidungskette
 *      zum Eröffnungszeitpunkt (Stimmen, Confidence/RiskScore, Regime,
 *      rationaleHash). Fehlt die Attribution (z. B. Position ohne Proposal,
 *      Altbestand), trägt der Snapshot `attribution: "UNKNOWN"` — die Lücke
 *      ist SICHTBAR, nie still geraten (fail-closed).
 *   2. Beim Close (Monitor/Flatten) werden die Metriken ergänzt
 *      (`closedAt`, `pnl`, `maePct`, `mfePct`, `holdingMinutes`,
 *      `exitReason`, `quality`).
 *
 * `decisionSnapshot` (jsonb, Strukturschema in `src/lib/journal.ts`):
 *   {
 *     schemaVersion: 1,
 *     attribution: "PROPOSAL" | "RULE" | "UNKNOWN",
 *     proposalId: string | null,
 *     ruleId: string | null,
 *     votes: [{ name, role, vote, confidence, riskScore, at }],
 *     proposer: { name, role } | null,
 *     regime: string,
 *     rationaleHash: string,
 *     source: "ENGINE" | "MICRO_EXECUTOR"
 *   }
 *
 * Bestehende Tabellen bleiben UNVERÄNDERT (Schema append-only; Migration:
 * `drizzle/2026-09-18_trade_journal.sql` oder `npx drizzle-kit push`).
 */
export const tradeJournal = pgTable(
  "trade_journal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: uuid("position_id").notNull().references(() => positions.id),
    symbol: text("symbol").notNull(),
    /** LONG | SHORT */
    side: text("side").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    missionId: uuid("mission_id").references(() => missions.id),
    ruleId: uuid("rule_id").references(() => tradeRules.id),
    /** Unveränderliches Entscheidungs-Foto zum Eröffnungszeitpunkt (siehe TSDoc oben). */
    decisionSnapshot: jsonb("decision_snapshot").notNull(),
    /**
     * Adaptives Regime zum Eröffnungszeitpunkt
     * (NORMAL | ELEVATED | EXTREME | PERSISTED | UNKNOWN — UNKNOWN erlaubt,
     * z. B. fehlende Bewertung oder Regime-Quelle außerhalb der Engine).
     */
    regime: text("regime").notNull().default("UNKNOWN"),
    /** Realisiertes P&L nach Close (Kontowährung). */
    pnl: numeric("pnl"),
    /** Maximaler ungünstiger Excursion in Prozent (negativ bei Verlust, sonst 0). */
    maePct: numeric("mae_pct"),
    /** Maximaler günstiger Excursion in Prozent (positiv bei Gewinn, sonst 0). */
    mfePct: numeric("mfe_pct"),
    holdingMinutes: integer("holding_minutes"),
    /** STOP_LOSS | TAKE_PROFIT | MANUAL_FLATTEN | AGENT_CLOSE | RULE_EXECUTION | … */
    exitReason: text("exit_reason"),
    /**
     * Datenqualität der MAE/MFE-Berechnung: OK | CANDLE_GAP | NO_DATA | ERROR.
     * `null` = Position noch offen (Metriken noch nicht berechnet). Kerzenlücken
     * werden NICHT geschätzt — Metriken bleiben null + Flag (GAP-03, D2).
     */
    quality: text("quality"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Eine Journal-Zeile pro Position: idempotente Closes, keine Duplikate
    // (Close-Pfad upsertet über diesen Index).
    uniqueIndex("trade_journal_position_unique").on(t.positionId),
    index("trade_journal_regime_idx").on(t.regime, t.closedAt),
  ]
);

/**
 * Journal-Feedback-Gewichte (GAP-03, v1.43.0) — begrenzte Rückführung.
 *
 * Gewicht je (Agentenrolle, Regime), aus glättungsgeprüften Trefferquoten
 * abgeschlossener Journal-Trades abgeleitet (`src/lib/journalAnalytics.ts`).
 * Harte Invarianten:
 *   - Bounds [JOURNAL_WEIGHT_MIN, JOURNAL_WEIGHT_MAX] (Default [0.5, 1.5]),
 *   - maximale Änderung je Zyklus JOURNAL_MAX_WEIGHT_DELTA (Default 0.1),
 *   - geschrieben NUR im Modus `enforce` (Default `off`: keine Schreibung
 *     überhaupt, reine Auswertung),
 *   - jede Änderung revisionssicher im audit_log
 *     ("journal-weight:AGENT:REGIME:x→y").
 */
export const journalAgentWeights = pgTable(
  "journal_agent_weights",
  {
    /** Agentenrolle (CEO | RESEARCH | BACKTEST | RISK_MANAGER | APPROVER | …). */
    agentRole: text("agent_role").notNull(),
    /** Regime (aus dem Journal, inkl. UNKNOWN). */
    regime: text("regime").notNull(),
    /** Gewicht inkl. Bounds; 1.0 = neutral. */
    weight: numeric("weight").notNull(),
    /** Stichprobe (abgeschlossene Trades) zum Zeitpunkt des Updates. */
    trades: integer("trades").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentRole, t.regime] })]
);

// ─────────────────────────────────────────────────────────────────────────────
// Point-in-Time Feature Store (RMA-P6-01, v1.53.0)
//
// Fünf Tabellen, ausschließlich additiv (Migration
// `drizzle/2026-09-20_feature_store.sql`):
//
//   feature_definitions           immutables Verzeichnis je (feature_id, version)
//   feature_values                Werte mit event_time/available_at/computed_at
//   feature_materialization_runs  Backfill-Manifeste je Lauf (Idempotency-Key)
//   feature_materialization_cursors  Wasserstand je (feature, entity, timeframe)
//   feature_data_revisions        protokollierte, NICHT übernommene Revisionen
//
// Zeit-Semantik: `event_time` = Schlusszeit der Kerze, `available_at` = ab wann
// der Wert bekannt sein konnte, `computed_at` = Berechnungszeitpunkt. Eine
// Point-in-Time-Abfrage prüft `event_time <= target` UND `available_at <= as_of`
// — `computed_at` ist bewusst kein Zulässigkeitskriterium.
//
// `null` ist nie `0`: eine Zeile trägt entweder einen Wert oder einen
// `null_reason` (CHECK `feature_values_value_exclusive_check`).
// ─────────────────────────────────────────────────────────────────────────────

/** Featuredefinition (immutable). Änderung ⇒ neue `version`, nie ein Update. */
export const featureDefinitions = pgTable(
  "feature_definitions",
  {
    /** Stabile logische ID, z. B. `scanner.rsi`. */
    featureId: text("feature_id").notNull(),
    /** Semantikversion (≥ 1). */
    version: integer("version").notNull(),
    label: text("label").notNull(),
    /** Semantik, Einheiten, Zeitbezug — Teil der Definition, nicht optional. */
    description: text("description").notNull(),
    /** number | boolean | enum (geschlossene Aufzählung). */
    dtype: text("dtype").notNull(),
    /** Geschlossene Werteliste bei `dtype = 'enum'`, sonst NULL. */
    enumValues: jsonb("enum_values").$type<readonly string[] | null>(),
    /** Einheit des Rohwerts (`fraction_of_close`, `index_0_100`, …). */
    unit: text("unit"),
    /** Nachkommastellen der gerundeten Ausgabe (`dtype = 'number'`). */
    valueDecimals: integer("value_decimals"),
    /** Entity-Typ (aktuell ausschließlich `instrument`). */
    entityType: text("entity_type").notNull().default("instrument"),
    timeframe: text("timeframe").notNull(),
    /** Benötigte geschlossene Bars (Lookback). */
    lookbackBars: integer("lookback_bars").notNull(),
    /** Abhängigkeiten als `[{featureId, version}]` (exakte Versionen). */
    dependencies: jsonb("dependencies").notNull().$type<readonly { featureId: string; version: number }[]>(),
    /** Schlüssel der Executor-Tabelle (`src/features/compute.ts`). */
    computeKey: text("compute_key").notNull(),
    /** Kanonisch gehashte Berechnungsparameter. */
    config: jsonb("config").notNull().$type<Readonly<Record<string, number | string | boolean | null>>>(),
    owner: text("owner").notNull(),
    /** `fc1:<sha256>` — Implementierungs-/Vertrags-Fingerprint. */
    codeHash: text("code_hash").notNull(),
    /** `fg1:<sha256>` — Fingerprint der Berechnungsparameter. */
    configHash: text("config_hash").notNull(),
    /** `fd1:<sha256>` — Gesamtfingerprint der Semantik. */
    definitionHash: text("definition_hash").notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.featureId, t.version] }),
    index("feature_definitions_latest_idx").on(t.featureId, t.version),
    check("feature_definitions_version_check", sql`${t.version} >= 1`),
    check("feature_definitions_dtype_check", sql`${t.dtype} IN ('number', 'boolean', 'enum')`),
    check(
      "feature_definitions_enum_check",
      sql`(${t.dtype} = 'enum' AND ${t.enumValues} IS NOT NULL) OR (${t.dtype} <> 'enum' AND ${t.enumValues} IS NULL)`
    ),
    check("feature_definitions_lookback_check", sql`${t.lookbackBars} >= 1`),
    check("feature_definitions_entity_type_check", sql`${t.entityType} = 'instrument'`),
    check("feature_definitions_code_hash_check", sql`${t.codeHash} ~ '^fc1:[0-9a-f]{64}$'`),
    check("feature_definitions_config_hash_check", sql`${t.configHash} ~ '^fg1:[0-9a-f]{64}$'`),
    check("feature_definitions_hash_check", sql`${t.definitionHash} ~ '^fd1:[0-9a-f]{64}$'`),
  ]
);

/**
 * Materialisierungslauf (Backfill-Manifest, append-only).
 *
 * Ein Lauf wird genau einmal geschrieben: `SUCCEEDED` atomar mit seinen
 * Wertezeilen und Cursorn (eine Transaktion), `FAILED` als einzelnes Manifest
 * (ohne Werte) für die Betriebsdiagnose. `idempotency_key` ist UNIQUE — ein
 * Retry mit identischen Eingaben liefert das bestehende Manifest zurück.
 */
export const featureMaterializationRuns = pgTable(
  "feature_materialization_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `fm1:<sha256>` über Definitionen, Scope, Politik, Datasets, Version. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** INCREMENTAL | BACKFILL */
    mode: text("mode").notNull(),
    /** SUCCEEDED | FAILED */
    status: text("status").notNull(),
    timeframe: text("timeframe").notNull(),
    /** bar_close | ingested (Zeitsemantik der Verfügbarkeit). */
    availabilityPolicy: text("availability_policy").notNull(),
    /** `["scanner.rsi@1", …]` — beteiligte Featureversionen. */
    featureRefs: jsonb("feature_refs").notNull().$type<readonly string[]>(),
    /** Entity-Scope (Instrument-IDs) des Laufs. */
    entityIds: jsonb("entity_ids").notNull().$type<readonly string[]>(),
    fromTs: timestamp("from_ts", { withTimezone: true }),
    toTs: timestamp("to_ts", { withTimezone: true }),
    /** Zähler (barsConsidered, valuesWritten, duplicates, revisions, …). */
    countsJson: jsonb("counts_json").notNull(),
    /** `featureId@version → fd1:<sha256>` (Reproduzierbarkeit). */
    definitionHashes: jsonb("definition_hashes").notNull().$type<Readonly<Record<string, string>>>(),
    /** `entityId → Source-Manifest` (Rohdatenmanifest je Entity). */
    sourceManifests: jsonb("source_manifests").notNull().$type<Readonly<Record<string, unknown>>>(),
    cursorBefore: jsonb("cursor_before").notNull(),
    cursorAfter: jsonb("cursor_after").notNull(),
    codeVersion: text("code_version").notNull(),
    /** Bounded Fehlercode bei FAILED, sonst NULL. */
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feature_materialization_runs_key_unique").on(t.idempotencyKey),
    index("feature_materialization_runs_finished_idx").on(t.finishedAt),
    check("feature_materialization_runs_mode_check", sql`${t.mode} IN ('INCREMENTAL', 'BACKFILL')`),
    check("feature_materialization_runs_status_check", sql`${t.status} IN ('SUCCEEDED', 'FAILED')`),
    check(
      "feature_materialization_runs_policy_check",
      sql`${t.availabilityPolicy} IN ('bar_close', 'ingested')`
    ),
    check(
      "feature_materialization_runs_error_check",
      sql`(${t.status} = 'FAILED' AND ${t.errorCode} IS NOT NULL) OR (${t.status} = 'SUCCEEDED' AND ${t.errorCode} IS NULL)`
    ),
  ]
);

/**
 * Featurewert (append-only Wahrheitsquelle).
 *
 * Logischer Schlüssel: `(feature_id, feature_version, entity_id, timeframe,
 * event_time)` — UNIQUE. Ein identischer Wert wird nicht erneut geschrieben
 * (Idempotenz); ein **abweichender** Wert zum selben Schlüssel wird nicht
 * überschrieben, sondern in `feature_data_revisions` protokolliert.
 */
export const featureValues = pgTable(
  "feature_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lauf, der die Zeile geschrieben hat (Manifest-Retention berührt Werte nie). */
    runId: uuid("run_id").references(() => featureMaterializationRuns.id),
    featureId: text("feature_id").notNull(),
    featureVersion: integer("feature_version").notNull(),
    entityType: text("entity_type").notNull().default("instrument"),
    entityId: text("entity_id").notNull(),
    timeframe: text("timeframe").notNull(),
    /** Schlusszeit der Kerze, aus der der Wert stammt. */
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    /** Ab wann der Wert bekannt sein konnte (`>= event_time`). */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    /** Berechnungszeitpunkt (`>= available_at`). */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    dtype: text("dtype").notNull(),
    /** Wertspalten: GENAU EINE ist gesetzt — oder `null_reason`. */
    valueNum: numeric("value_num"),
    valueBool: boolean("value_bool"),
    valueText: text("value_text"),
    /** Geschlossene Begründung der Nichtverfügbarkeit (NULL = Wert vorhanden). */
    nullReason: text("null_reason"),
    /** Source-Quality-Status (OK | GAP | OUTLIER | INVALID | DUPLICATE | CROSSCHECK | UNKNOWN). */
    qualityStatus: text("quality_status").notNull(),
    definitionHash: text("definition_hash").notNull(),
    /** `fv1:<sha256>` — inhaltlicher Fingerprint (Duplikat-/Revisionserkennung). */
    valueHash: text("value_hash").notNull(),
    /** Rohdatenmanifest (Quelle, Kerzen, Ingestion, Dataset-Hash, Politik). */
    sourceManifest: jsonb("source_manifest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feature_values_key_unique").on(
      t.featureId,
      t.featureVersion,
      t.entityId,
      t.timeframe,
      t.eventTime
    ),
    // PIT-Lesepfad: entity-major, jüngste Eventzeit zuerst.
    index("feature_values_pit_idx").on(
      t.entityId,
      t.featureId,
      t.featureVersion,
      t.timeframe,
      t.eventTime,
      t.availableAt
    ),
    // Coverage-/Status-/Paritätspfad: feature-major.
    index("feature_values_feature_event_idx").on(t.featureId, t.featureVersion, t.eventTime),
    index("feature_values_run_idx").on(t.runId),
    check("feature_values_available_check", sql`${t.availableAt} >= ${t.eventTime}`),
    check("feature_values_computed_check", sql`${t.computedAt} >= ${t.availableAt}`),
    check(
      "feature_values_value_exclusive_check",
      sql`((CASE WHEN ${t.valueNum} IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN ${t.valueBool} IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN ${t.valueText} IS NOT NULL THEN 1 ELSE 0 END) + (CASE WHEN ${t.nullReason} IS NOT NULL THEN 1 ELSE 0 END)) = 1`
    ),
    check(
      "feature_values_dtype_check",
      sql`(${t.dtype} = 'number' AND (${t.valueNum} IS NOT NULL OR ${t.nullReason} IS NOT NULL)) OR (${t.dtype} = 'boolean' AND (${t.valueBool} IS NOT NULL OR ${t.nullReason} IS NOT NULL)) OR (${t.dtype} = 'enum' AND (${t.valueText} IS NOT NULL OR ${t.nullReason} IS NOT NULL))`
    ),
    check(
      "feature_values_null_reason_check",
      sql`${t.nullReason} IS NULL OR ${t.nullReason} IN ('INSUFFICIENT_LOOKBACK', 'INVALID_INPUT', 'MISSING_BARS', 'NOT_COMPUTABLE', 'DEPENDENCY_NULL', 'DEPENDENCY_MISSING')`
    ),
    check(
      "feature_values_quality_check",
      sql`${t.qualityStatus} IN ('OK', 'GAP', 'OUTLIER', 'INVALID', 'DUPLICATE', 'CROSSCHECK', 'UNKNOWN')`
    ),
    check("feature_values_definition_hash_check", sql`${t.definitionHash} ~ '^fd1:[0-9a-f]{64}$'`),
    check("feature_values_hash_check", sql`${t.valueHash} ~ '^fv1:[0-9a-f]{64}$'`),
  ]
);

/**
 * Materialisierungs-Cursor (Wasserstand je Featurereihe).
 *
 * Der Wasserstand ist monoton: ein Recompute darf ihn nur vorwärts bewegen
 * (`GREATEST(alt, neu)` im Upsert). Ein Rücksprung würde Bars erneut
 * materialisieren — das ist ausschließlich über einen expliziten
 * `--reset-cursor`-Pfad mit Audit-Event erlaubt.
 */
export const featureMaterializationCursors = pgTable(
  "feature_materialization_cursors",
  {
    featureId: text("feature_id").notNull(),
    featureVersion: integer("feature_version").notNull(),
    entityId: text("entity_id").notNull(),
    timeframe: text("timeframe").notNull(),
    watermarkEventTime: timestamp("watermark_event_time", { withTimezone: true }).notNull(),
    watermarkAvailableAt: timestamp("watermark_available_at", { withTimezone: true }).notNull(),
    lastRunId: uuid("last_run_id").references(() => featureMaterializationRuns.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.featureId, t.featureVersion, t.entityId, t.timeframe] }),
    index("feature_materialization_cursors_last_run_idx").on(t.lastRunId),
    check(
      "feature_materialization_cursors_watermark_check",
      sql`${t.watermarkAvailableAt} >= ${t.watermarkEventTime}`
    ),
  ]
);

/**
 * Beobachtete Datenrevision (append-only Protokoll).
 *
 * Entsteht, wenn ein Recompute zum **selben Schlüssel** einen anderen Inhalt
 * liefert (z. B. korrigierte Rohkerzen). Der historische Wert bleibt gültig und
 * wird nicht überschrieben; der Befund ist die Grundlage für die Entscheidung,
 * ob eine neue Featureversion materialisiert wird. UNIQUE über
 * `(Schlüssel, incoming_value_hash)` macht die Erkennung selbst idempotent —
 * derselbe Befund wird nicht zweimal protokolliert.
 */
export const featureDataRevisions = pgTable(
  "feature_data_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    featureId: text("feature_id").notNull(),
    featureVersion: integer("feature_version").notNull(),
    entityId: text("entity_id").notNull(),
    timeframe: text("timeframe").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    existingValueHash: text("existing_value_hash").notNull(),
    incomingValueHash: text("incoming_value_hash").notNull(),
    runId: uuid("run_id").references(() => featureMaterializationRuns.id),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feature_data_revisions_key_unique").on(
      t.featureId,
      t.featureVersion,
      t.entityId,
      t.timeframe,
      t.eventTime,
      t.incomingValueHash
    ),
    index("feature_data_revisions_series_idx").on(t.featureId, t.entityId, t.eventTime),
    check("feature_data_revisions_existing_hash_check", sql`${t.existingValueHash} ~ '^fv1:[0-9a-f]{64}$'`),
    check("feature_data_revisions_incoming_hash_check", sql`${t.incomingValueHash} ~ '^fv1:[0-9a-f]{64}$'`),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// Historische Perpetual-Daten (RMA-P2-02, v1.54.0) — append-only
//
// Drei Datenquellen + Betriebsmetadaten, äquivalent zu
// `drizzle/2026-09-20_perpetual_data.sql`:
//
//   perp_funding_rates   Funding-Sätze je Intervall (signiert)
//   perp_open_interest   Open Interest mit **expliziter** Einheit
//   perp_liquidations    Zwangsschließungen als Ereignisse
//   perp_sync_runs       Lauf-Manifeste (Idempotenzschlüssel)
//   perp_sync_cursors    Wasserstand je (Venue, Instrument, Reihenart)
//
// Zeitsemantik in jeder Datenzeile: `event_time` (Ereignis), `available_at`
// (ab wann der Satz wahrheitsgemäß bekannt sein durfte), `fetched_at` (Abruf).
// Eine as-of-Abfrage ist nur zulässig mit
//
//     event_time <= as_of  AND  available_at <= as_of
//
// Verfügbarkeit ist damit Bestandteil der Daten, nicht einer
// Consumer-Disziplin. `null` ist nie `0`: jede Größe ist nullable und trägt
// bei `null` einen `missing_reason` — die CHECK-Constraints erzwingen genau
// eines von beidem.
// ─────────────────────────────────────────────────────────────────────────────

/** Erlaubte Qualitätsstatus (identisch zu `src/perpdata/types.ts`). */
const PERP_QUALITY_STATUSES = "('OK','GAP','OUTLIER','INVALID','DUPLICATE','CROSSCHECK','STALE','UNKNOWN')";

/** Funding-Historie: ein Satz je (Venue, Instrument, Settlement-Zeit). */
export const perpFundingRates = pgTable(
  "perp_funding_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Lauf, der die Zeile geschrieben hat (`null` bei Direkteinspielung). */
    runId: uuid("run_id").references(() => perpSyncRuns.id),
    venue: text("venue").notNull(),
    /** Kanonische Instrument-ID in Speicherform (`BITUNIX:BTCUSDT`). */
    instrumentId: text("instrument_id").notNull(),
    /** Venue-natives Symbol (`BTCUSDT`). */
    symbol: text("symbol").notNull(),
    /** Endpunkt/Kanal (`bitunix:funding_history`) — nie ein Secret. */
    sourceId: text("source_id").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    /** Settlement-Zeit des Satzes. */
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    /** Ab wann der Satz bekannt sein durfte (Politik, `>= event_time`). */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    /** Abrufzeit (Transport, keine Entscheidungsgrundlage). */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** Rate je Intervall als Dezimalanteil; `null` = unbekannt (nie 0). */
    fundingRate: numeric("funding_rate"),
    /** Funding-Intervall in Stunden, wenn die Quelle es meldet. */
    intervalHours: numeric("interval_hours"),
    /** Nächstes Settlement (nur Snapshot-Endpunkte melden das). */
    nextFundingTime: timestamp("next_funding_time", { withTimezone: true }),
    markPrice: numeric("mark_price"),
    /** Einheit der Rate (fix; eine Umschreibung wäre eine neue Semantik). */
    unit: text("unit").notNull().default("fraction_per_interval"),
    qualityStatus: text("quality_status").notNull(),
    missingReason: text("missing_reason"),
    /** `pv1:<sha256>` über die Fachfelder (Inhalt, nicht Quelle). */
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Natürlicher Schlüssel: ein Settlement je Instrument und Zeitpunkt.
    uniqueIndex("perp_funding_rates_key_unique").on(t.venue, t.instrumentId, t.eventTime),
    // As-of-Lesepfad (Point-in-Time) und Coverage-Pfad (venue-major).
    index("perp_funding_rates_pit_idx").on(t.instrumentId, t.eventTime, t.availableAt),
    index("perp_funding_rates_venue_event_idx").on(t.venue, t.eventTime),
    index("perp_funding_rates_run_idx").on(t.runId),
    check("perp_funding_rates_event_check", sql`${t.availableAt} >= ${t.eventTime}`),
    check("perp_funding_rates_fetched_check", sql`${t.fetchedAt} >= ${t.eventTime}`),
    check("perp_funding_rates_schema_check", sql`${t.schemaVersion} >= 1`),
    check("perp_funding_rates_unit_check", sql`${t.unit} = 'fraction_per_interval'`),
    // Genau eines: Wert oder begründete Nichtverfügbarkeit.
    check(
      "perp_funding_rates_value_exclusive_check",
      sql`${t.fundingRate} IS NULL AND ${t.missingReason} IS NOT NULL
        OR ${t.fundingRate} IS NOT NULL AND ${t.missingReason} IS NULL`
    ),
    check(
      "perp_funding_rates_missing_reason_check",
      sql`${t.missingReason} IS NULL OR ${t.missingReason} IN
        ('NOT_REPORTED','OUT_OF_BOUNDS','SOURCE_ERROR','NOT_APPLICABLE')`
    ),
    check("perp_funding_rates_quality_check", sql`${t.qualityStatus} IN ${sql.raw(PERP_QUALITY_STATUSES)}`),
    // Harte Plausibilität: |Rate| ≤ 30 % je Intervall (Venue-Kappe) und
    // Intervall zwischen 1 und 24 Stunden.
    check(
      "perp_funding_rates_rate_bound_check",
      sql`${t.fundingRate} IS NULL OR abs(${t.fundingRate}) <= 0.3`
    ),
    check(
      "perp_funding_rates_interval_check",
      sql`${t.intervalHours} IS NULL OR (${t.intervalHours} > 0 AND ${t.intervalHours} <= 24)`
    ),
    check("perp_funding_rates_hash_check", sql`${t.contentHash} ~ '^pv1:[0-9a-f]{64}$'`),
    check("perp_funding_rates_venue_check", sql`${t.venue} ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'`),
    check("perp_funding_rates_symbol_check", sql`${t.symbol} ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'`),
  ]
);

/**
 * Open Interest — `basis` sagt, welche Größe die Quelle **autoritativ**
 * gemeldet hat; die übrigen sind nur mit `converted = true` erlaubt (bis zu
 * zwei abgeleitete Felder, nie ein drittes geratenes). Damit ist eine
 * Vermischung von Contracts/Base/Quote strukturell ausgeschlossen.
 */
export const perpOpenInterest = pgTable(
  "perp_open_interest",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => perpSyncRuns.id),
    venue: text("venue").notNull(),
    instrumentId: text("instrument_id").notNull(),
    symbol: text("symbol").notNull(),
    sourceId: text("source_id").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** Offene Kontrakte (Einheit `contracts`). */
    contracts: numeric("contracts"),
    /** Offene Menge in Basiseinheit (Einheit `base_units`). */
    baseQuantity: numeric("base_quantity"),
    /** Offener Wert in Quote-Währung (Einheit `quote_units`). */
    quoteValue: numeric("quote_value"),
    /** Autoritative Größe der Quelle. */
    basis: text("basis").notNull(),
    /** Kontraktgröße in Basiseinheit (Basis für Contracts ↔ Base). */
    contractSize: numeric("contract_size"),
    /** Pflicht, sobald `quote_value` gesetzt ist. */
    quoteCurrency: text("quote_currency"),
    markPrice: numeric("mark_price"),
    /** `true` = mindestens ein Feld ist gerechnet, nicht gemeldet. */
    converted: boolean("converted").notNull().default(false),
    unit: text("unit").notNull(),
    qualityStatus: text("quality_status").notNull(),
    missingReason: text("missing_reason"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("perp_open_interest_key_unique").on(t.venue, t.instrumentId, t.eventTime),
    index("perp_open_interest_pit_idx").on(t.instrumentId, t.eventTime, t.availableAt),
    index("perp_open_interest_venue_event_idx").on(t.venue, t.eventTime),
    index("perp_open_interest_run_idx").on(t.runId),
    check("perp_open_interest_event_check", sql`${t.availableAt} >= ${t.eventTime}`),
    check("perp_open_interest_fetched_check", sql`${t.fetchedAt} >= ${t.eventTime}`),
    check("perp_open_interest_schema_check", sql`${t.schemaVersion} >= 1`),
    check(
      "perp_open_interest_basis_check",
      sql`(${t.basis} = 'contracts' AND ${t.contracts} IS NOT NULL)
        OR (${t.basis} = 'base_units' AND ${t.baseQuantity} IS NOT NULL)
        OR (${t.basis} = 'quote_units' AND ${t.quoteValue} IS NOT NULL)`
    ),
    check("perp_open_interest_unit_matches_basis_check", sql`${t.unit} = ${t.basis}`),
    // Mehr als ein gemessener Wert ⇒ nur als Ableitung gekennzeichnet.
    check(
      "perp_open_interest_conversion_check",
      sql`${t.converted}
        OR ((CASE WHEN ${t.contracts} IS NOT NULL THEN 1 ELSE 0 END)
          + (CASE WHEN ${t.baseQuantity} IS NOT NULL THEN 1 ELSE 0 END)
          + (CASE WHEN ${t.quoteValue} IS NOT NULL THEN 1 ELSE 0 END)) <= 1`
    ),
    // Negative OI ist fachlich unmöglich (0 = „kein offenes Interesse“ ist erlaubt).
    check(
      "perp_open_interest_non_negative_check",
      sql`(${t.contracts} IS NULL OR ${t.contracts} >= 0)
        AND (${t.baseQuantity} IS NULL OR ${t.baseQuantity} >= 0)
        AND (${t.quoteValue} IS NULL OR ${t.quoteValue} >= 0)`
    ),
    check(
      "perp_open_interest_currency_check",
      sql`${t.quoteValue} IS NULL OR ${t.quoteCurrency} IS NOT NULL`
    ),
    check(
      "perp_open_interest_contract_size_check",
      sql`${t.contractSize} IS NULL OR ${t.contractSize} > 0`
    ),
    check(
      "perp_open_interest_missing_reason_check",
      sql`${t.missingReason} IS NULL OR ${t.missingReason} IN
        ('NOT_REPORTED','OUT_OF_BOUNDS','SOURCE_ERROR','NOT_APPLICABLE')`
    ),
    check("perp_open_interest_quality_check", sql`${t.qualityStatus} IN ${sql.raw(PERP_QUALITY_STATUSES)}`),
    check("perp_open_interest_hash_check", sql`${t.contentHash} ~ '^pv1:[0-9a-f]{64}$'`),
    check(
      "perp_open_interest_currency_format_check",
      sql`${t.quoteCurrency} IS NULL OR ${t.quoteCurrency} ~ '^[A-Z][A-Z0-9]{1,6}$'`
    ),
  ]
);

/** Liquidationsereignisse (kein Reihenbegriff → keine Staleness-Regel). */
export const perpLiquidations = pgTable(
  "perp_liquidations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").references(() => perpSyncRuns.id),
    venue: text("venue").notNull(),
    instrumentId: text("instrument_id").notNull(),
    symbol: text("symbol").notNull(),
    sourceId: text("source_id").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    eventTime: timestamp("event_time", { withTimezone: true }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    /** Betroffene Positionsseite (kanonisiert, nicht Order-Richtung). */
    side: text("side").notNull(),
    /** Zwangsgeschlossene Menge in Basiseinheit. */
    quantityBase: numeric("quantity_base"),
    /** Ausführungspreis (`quote_per_base`). */
    price: numeric("price"),
    /** Notional in Quote-Währung (`null` = nicht gemeldet, nicht 0). */
    notionalQuote: numeric("notional_quote"),
    quoteCurrency: text("quote_currency"),
    /** Venue-Ereignis-ID oder deterministischer Payload-Hash (`h1:…`). */
    sourceEventId: text("source_event_id").notNull(),
    /** Venue-Bündelung: Anzahl Einzelereignisse dieses Satzes. */
    aggregateCount: integer("aggregate_count"),
    unit: text("unit").notNull().default("base_units"),
    qualityStatus: text("quality_status").notNull(),
    missingReason: text("missing_reason"),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotenz über die Ereignis-ID: derselbe Satz wird nie zweimal gebucht.
    uniqueIndex("perp_liquidations_key_unique").on(
      t.venue,
      t.instrumentId,
      t.eventTime,
      t.sourceEventId
    ),
    index("perp_liquidations_pit_idx").on(t.instrumentId, t.eventTime, t.availableAt),
    index("perp_liquidations_venue_event_idx").on(t.venue, t.eventTime),
    index("perp_liquidations_run_idx").on(t.runId),
    check("perp_liquidations_event_check", sql`${t.availableAt} >= ${t.eventTime}`),
    check("perp_liquidations_fetched_check", sql`${t.fetchedAt} >= ${t.eventTime}`),
    check("perp_liquidations_schema_check", sql`${t.schemaVersion} >= 1`),
    check(
      "perp_liquidations_side_check",
      sql`${t.side} IN ('LONG_LIQUIDATED','SHORT_LIQUIDATED')`
    ),
    check(
      "perp_liquidations_positive_check",
      sql`(${t.quantityBase} IS NULL OR ${t.quantityBase} > 0)
        AND (${t.price} IS NULL OR ${t.price} > 0)
        AND (${t.notionalQuote} IS NULL OR ${t.notionalQuote} > 0)`
    ),
    // Menge oder Notional muss bekannt sein — sonst ist das Ereignis wertlos.
    check(
      "perp_liquidations_measure_check",
      sql`${t.quantityBase} IS NOT NULL OR ${t.notionalQuote} IS NOT NULL`
    ),
    check(
      "perp_liquidations_currency_check",
      sql`${t.notionalQuote} IS NULL OR ${t.quoteCurrency} IS NOT NULL`
    ),
    check(
      "perp_liquidations_aggregate_check",
      sql`${t.aggregateCount} IS NULL OR ${t.aggregateCount} >= 1`
    ),
    check("perp_liquidations_unit_check", sql`${t.unit} = 'base_units'`),
    check("perp_liquidations_quality_check", sql`${t.qualityStatus} IN ${sql.raw(PERP_QUALITY_STATUSES)}`),
    check("perp_liquidations_hash_check", sql`${t.contentHash} ~ '^pv1:[0-9a-f]{64}$'`),
    check(
      "perp_liquidations_event_id_check",
      sql`${t.sourceEventId} ~ '^[A-Za-z0-9:._-]{1,64}$'`
    ),
  ]
);

/**
 * Sync-Manifest je Lauf.
 *
 * `idempotency_key` (`prk1:<sha256>` über Venue, Modus, Fenster, Instrumente,
 * Reihenarten, Politik und Code-Version) macht den Lauf selbst idempotent:
 * ein Retry mit identischen Eingaben findet das bestehende Manifest und
 * schreibt nichts erneut.
 */
export const perpSyncRuns = pgTable(
  "perp_sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    venue: text("venue").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull(),
    availabilityPolicy: text("availability_policy").notNull(),
    /** Abrufbare `from`/`to` des Fensters (Backfill-Dokumentation). */
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    /** Reihenarten dieses Laufs. */
    kinds: jsonb("kinds").notNull(),
    /** Instrumente im Scope (begrenzte Liste, Betriebsmetadaten). */
    instrumentIds: jsonb("instrument_ids").notNull(),
    /** Zähler je Reihenart + Qualitätsbefunde (JSON, nicht Spalten-Drift). */
    counts: jsonb("counts_json").notNull(),
    /** Capability-Antwort der Venue (macht `UNSUPPORTED` nachvollziehbar). */
    capabilities: jsonb("capabilities_json").notNull(),
    /** Klassifizierte Fehlbefunde (keine Vendor-Rohtexte). */
    failures: jsonb("failures_json").notNull(),
    /** Code-Version des Schreibers (Reproduzierbarkeit, nicht dupliziert). */
    codeVersion: text("code_version").notNull(),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("perp_sync_runs_key_unique").on(t.idempotencyKey),
    index("perp_sync_runs_venue_finished_idx").on(t.venue, t.finishedAt),
    check("perp_sync_runs_mode_check", sql`${t.mode} IN ('INCREMENTAL','BACKFILL')`),
    check("perp_sync_runs_status_check", sql`${t.status} IN ('SUCCEEDED','PARTIAL','FAILED')`),
    check(
      "perp_sync_runs_policy_check",
      sql`${t.availabilityPolicy} IN ('ingested','settlement')`
    ),
    check("perp_sync_runs_window_check", sql`${t.toTs} > ${t.fromTs}`),
    check(
      "perp_sync_runs_error_check",
      sql`(${t.status} = 'FAILED' AND ${t.errorCode} IS NOT NULL)
        OR (${t.status} <> 'FAILED' AND ${t.errorCode} IS NULL)`
    ),
  ]
);

/** Wasserstand je (Venue, Instrument, Reihenart) — Restart-/Retry-Anker. */
export const perpSyncCursors = pgTable(
  "perp_sync_cursors",
  {
    venue: text("venue").notNull(),
    instrumentId: text("instrument_id").notNull(),
    kind: text("kind").notNull(),
    /** Höchste geschriebene Ereigniszeit (nächstes Fenster beginnt hier). */
    watermarkEventTime: timestamp("watermark_event_time", { withTimezone: true }).notNull(),
    /** Höchste geschriebene Verfügbarkeit (As-of-Grenze des Bestands). */
    watermarkAvailableAt: timestamp("watermark_available_at", { withTimezone: true }).notNull(),
    lastRunId: uuid("last_run_id").references(() => perpSyncRuns.id),
    /** Fehlschläge in Folge (Betrieb: Dauerstörung sichtbar, ohne still zu werden). */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastStatus: text("last_status").notNull().default("OK"),
    /** Typisierter Grund, wenn die Venue die Reihe nicht liefert (sonst `null`). */
    unsupportedReason: text("unsupported_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.venue, t.instrumentId, t.kind] }),
    index("perp_sync_cursors_venue_kind_idx").on(t.venue, t.kind),
    check("perp_sync_cursors_kind_check", sql`${t.kind} IN ('funding','openInterest','liquidations')`),
    check(
      "perp_sync_cursors_watermark_check",
      sql`${t.watermarkAvailableAt} >= ${t.watermarkEventTime}`
    ),
    check(
      "perp_sync_cursors_status_check",
      sql`${t.lastStatus} IN ('OK','PARTIAL','FAILED','UNSUPPORTED')`
    ),
    check("perp_sync_cursors_failures_check", sql`${t.consecutiveFailures} >= 0`),
  ]
);
