import {
  pgTable,
  type AnyPgColumn,
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
    sql`${t.exitReason} IN ('STOP_LOSS', 'TAKE_PROFIT', 'SIGNAL_EXIT', 'MAX_HOLDING', 'RISK_STOP', 'END_OF_DATA', 'SIGNAL_DECAY')`
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
   * Exit-Grund (Taxonomie, GAP-05 / v1.44.0, RMA-P5-05 / v1.69.0):
   *   STOP_LOSS | TAKE_PROFIT | TRAILING_STOP | TIME_STOP | SIGNAL_DECAY |
   *   MANUAL_FLATTEN | AGENT_CLOSE | RULE_EXECUTION | null bei offen.
   * SIGNAL_DECAY ist von TIME_STOP und von manuellen Freitext-Gründen
   * getrennt. Safety-Exits bleiben vorrangig.
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
  /**
   * RMA-P5-05 (v1.69.0): unveränderlicher Entry-Signal-Snapshot (`sig1`).
   * Einmal gesetzt, darf die Spalte nicht mehr geändert werden (Trigger
   * `positions_entry_signal_immutable`). NULL = Altbestand / nicht erfasst
   * — das ist MISSING, nie eine Stärke 0. Migration:
   * `drizzle/2026-09-22_signal_decay.sql`.
   */
  entrySignal: jsonb("entry_signal"),
  /** `sig1:<sha256>` des Entry-Snapshots. NULL solange kein Snapshot steht. */
  entrySignalHash: text("entry_signal_hash"),
  /**
   * Bestätigungszähler der Signal-Decay-Hysterese. Überlebt Neustarts.
   * Default 0 = keine laufende Bestätigung (verhaltensneutral).
   */
  signalDecayStreak: integer("signal_decay_streak").notNull().default(0),
  /** Observation-Key der letzten gezählten Beobachtung (`sdo1:<sha256>`). */
  signalDecayLastKey: text("signal_decay_last_key"),
  /** Policyversion, unter der die Zählung entstanden ist (`sdp1:<sha256>`). */
  signalDecayPolicyVersion: text("signal_decay_policy_version"),
  /**
   * Strategieklasse zum Entry (`mean-reversion` | `trend` | `breakout` |
   * `unclassified`). NULL = nicht ableitbar → Klasse `unclassified`
   * (Policy default-off).
   */
  strategyClass: text("strategy_class"),
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
// Deterministische Trade-PnL-Attribution (RMA-P1-06, v1.57.0)
//
// Zwei append-only Tabellen (Migration `drizzle/2026-09-21_trade_attribution.sql`;
// die SQL-Datei installiert zusätzlich UPDATE/DELETE/TRUNCATE-Sperren —
// `npx drizzle-kit push` allein legt die Sperr-Trigger NICHT an):
//
//   trade_attributions         EINE Kopfzeile je (journal_id, method_version)
//                              — Idempotenz-Schlüssel: Retry/Restart erzeugt
//                              keine zweite Attribution desselben Trades.
//   trade_attribution_entries  Beitragsposten (AGENT | RULE | COST), eindeutig
//                              je (attribution_id, source_type, source_id).
//
// Invariante (vom Modell erzwungen, siehe src/attribution/model.ts):
//   Σ Quellenbeiträge + Σ Kostenbeiträge + Residual = Netto-PnL (± 1e-6)
// mit Netto = Brutto (Journal `pnl`) − Gebühren + Funding (Kontosicht).
// `fees`/`funding` sind NULL-bare Fakten: NULL = unbekannt, NIE still 0 —
// unbekannte Komponenten stehen sichtbar in `unknown_costs`.
// Zeitsemantik: `closed_at` = Ereigniszeit des Trade-Closes (Journal-Zeile),
// `computed_at` = Berechnungszeitpunkt der Attribution. Abfragen filtern
// nach Ereigniszeit; Look-ahead ist konstruktiv ausgeschlossen, weil alle
// Eingaben aus dem unveränderlichen Entry-Snapshot bzw. den Close-Fakten
// stammen.
// ─────────────────────────────────────────────────────────────────────────────

/** Attributions-Kopf: deterministische Allokation eines geschlossenen Trades. */
export const tradeAttributions = pgTable(
  "trade_attributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Journal-Zeile des Trades (append-only-Vertrag, kein CASCADE). */
    journalId: uuid("journal_id")
      .notNull()
      .references(() => tradeJournal.id),
    /** Ops-Denormalisierung der Journal-Position (Journal position_id ist UNIQUE). */
    positionId: uuid("position_id").notNull(),
    /** Methode (ta1 = 1). Ein Wechsel schreibt NEUE Zeilen, nie Updates. */
    methodVersion: integer("method_version").notNull(),
    /** ATTRIBUTED | UNATTRIBUTABLE (fail-closed, sichtbarer Grund). */
    status: text("status").notNull(),
    /** Geschlossener Grund bei UNATTRIBUTABLE, sonst NULL. */
    unattributableReason: text("unattributable_reason"),
    /** Fingerprint des Entry-Snapshots (js…:<sha256>) — Verweis auf die Basis. */
    snapshotHash: text("snapshot_hash").notNull(),
    /** Schema-Version des Entry-Snapshots (0 = fehlend/unlesbar). */
    snapshotSchemaVersion: integer("snapshot_schema_version").notNull(),
    symbol: text("symbol").notNull(),
    /** LONG | SHORT */
    side: text("side").notNull(),
    /** Regime zum Eröffnungszeitpunkt (aus der Journal-Zeile). */
    regime: text("regime").notNull(),
    /** Ereigniszeit des Closes (Journal closed_at) — Zeitfilter der Queries. */
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    /** Realisiertes PnL der Buchungsquelle (Journal `pnl`, vor Gebühren). */
    pnlGross: numeric("pnl_gross").notNull(),
    /** Gebühren; NULL = unbekannt (kein stiller 0-Ersatz). */
    fees: numeric("fees"),
    /** Funding (Kontosicht, negativ = gezahlt); NULL = unbekannt. */
    funding: numeric("funding"),
    /** Slippage-Memo (bereits in Fill-Preisen enthalten, NICHT reconciliert). */
    slippageMemo: numeric("slippage_memo"),
    /** Reconciliationsziel: pnl_gross − fees??0 + funding??0. */
    pnlNet: numeric("pnl_net").notNull(),
    sourcesSum: numeric("sources_sum").notNull(),
    costsSum: numeric("costs_sum").notNull(),
    /** Explizites Residual (Konflikte + Rundung) — schließt exakt ab. */
    residual: numeric("residual").notNull(),
    /** Nicht quantifizierbare Kostenkomponenten (Teilmenge von [FEES, FUNDING]). */
    unknownCosts: text("unknown_costs").array().notNull().default(sql`'{}'::text[]`),
    /** Anzahl richtungsbelegter Quellen (aligned + opposing). */
    participants: integer("participants").notNull().default(0),
    /** Anzahl Enthaltungen (Beitrag exakt 0, sichtbar). */
    abstentions: integer("abstentions").notNull().default(0),
    /** Berechnungszeitpunkt (monoton nur Info; Zeitfilter ist closed_at). */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotenz: genau eine Attribution je Trade und Methode — Retries und
    // Restarts können keine zweite Kopfzeile (und damit keine zweiten
    // Beitragsposten) erzeugen.
    uniqueIndex("trade_attributions_journal_method_unique").on(t.journalId, t.methodVersion),
    index("trade_attributions_closed_idx").on(t.closedAt, t.id),
    index("trade_attributions_symbol_idx").on(t.symbol, t.closedAt),
    index("trade_attributions_regime_idx").on(t.regime, t.closedAt),
    index("trade_attributions_status_idx").on(t.methodVersion, t.status),
    index("trade_attributions_position_idx").on(t.positionId),
    check("trade_attributions_method_version_check", sql`${t.methodVersion} >= 1`),
    check("trade_attributions_status_check", sql`${t.status} IN ('ATTRIBUTED', 'UNATTRIBUTABLE')`),
    check(
      "trade_attributions_reason_check",
      sql`(${t.status} = 'UNATTRIBUTABLE' AND ${t.unattributableReason} IN ('SNAPSHOT_MISSING','SNAPSHOT_SCHEMA_V1','SNAPSHOT_INVALID','NO_SOURCES')) OR (${t.status} = 'ATTRIBUTED' AND ${t.unattributableReason} IS NULL)`
    ),
    check("trade_attributions_side_check", sql`${t.side} IN ('LONG', 'SHORT')`),
    check("trade_attributions_schema_version_check", sql`${t.snapshotSchemaVersion} >= 0`),
    check("trade_attributions_participants_check", sql`${t.participants} >= 0`),
    check("trade_attributions_abstentions_check", sql`${t.abstentions} >= 0`),
    check("trade_attributions_fees_check", sql`${t.fees} IS NULL OR ${t.fees} >= 0`),
    check(
      "trade_attributions_slippage_check",
      sql`${t.slippageMemo} IS NULL OR ${t.slippageMemo} >= 0`
    ),
    check(
      "trade_attributions_unknown_costs_check",
      sql`${t.unknownCosts} <@ ARRAY['FEES','FUNDING']::text[]`
    ),
  ]
);

/** Attributions-Posten: Quelle, Version, Alignment, Gewicht, Beitrag. */
export const tradeAttributionEntries = pgTable(
  "trade_attribution_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attributionId: uuid("attribution_id")
      .notNull()
      .references(() => tradeAttributions.id),
    /** AGENT | RULE | COST. */
    sourceType: text("source_type").notNull(),
    /**
     * Bounded Quellen-ID: Agentenname | rule_key | FEES | FUNDING. Bewusst
     * KEINE Instrument-/Order-/Trade-IDs und KEINE Metrics-Labels mit
     * unbeschränkter Kardinalität.
     */
    sourceId: text("source_id").notNull(),
    /** Promptversion des Agenten | Regelversion | Methoden-Tag ta1. */
    sourceVersion: text("source_version").notNull(),
    /** Agentenrolle (nur AGENT; sonst NULL). */
    role: text("role"),
    /** Richtungsrelation: 1 = gleichgerichtet, −1 = gegen, 0 = Enthaltung/Kosten. */
    alignment: integer("alignment").notNull(),
    /** Normalisierter Anteil [0,1] an der Teilnehmermasse; NULL für COST. */
    weight: numeric("weight"),
    /** Signierter Beitrag in Kontowährung (8 Nachkommastellen). */
    contribution: numeric("contribution").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trade_attribution_entries_source_unique").on(
      t.attributionId,
      t.sourceType,
      t.sourceId
    ),
    index("trade_attribution_entries_source_idx").on(t.sourceType, t.sourceId),
    check(
      "trade_attribution_entries_type_check",
      sql`${t.sourceType} IN ('AGENT', 'RULE', 'COST')`
    ),
    check("trade_attribution_entries_alignment_check", sql`${t.alignment} IN (-1, 0, 1)`),
    check("trade_attribution_entries_weight_check", sql`${t.weight} IS NULL OR (${t.weight} >= 0 AND ${t.weight} <= 1)`),
    check("trade_attribution_entries_source_id_check", sql`length(${t.sourceId}) > 0 AND length(${t.sourceId}) <= 200`),
  ]
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

// ─────────────────────────────────────────────────────────────────────────────
// Forecast-Ledger, Auflösung und Kalibrierung (RMA-P3-01, v1.55.0)
//
// Vier Tabellen, ausschließlich additiv (Migration
// `drizzle/2026-09-20_forecast_ledger.sql`):
//
//   forecasts                  immutable Forecast-Verträge (append-only)
//   forecast_resolutions       versionierte Auflösungen (RESOLVED | VOID)
//   forecast_resolution_runs   Lauf-Manifeste des Resolver-Jobs
//   forecast_resolver_cursors  Wasserstand des Resolver-Jobs
//
// Zeitsemantik je Forecast: `as_of` (Entstehung), `reference_time`
// (Schlusszeit der Referenzkerze), `resolves_at` (Schlusszeit der
// Outcome-Kerze), `availability_deadline` (= `resolves_at` + Settling-Frist).
// Die automatische Auflösung verwendet ausschließlich Kerzen mit
// `fetched_at <= availability_deadline` — später eintreffende oder
// korrigierte Daten sind für die Erstauflösung unsichtbar (kein Look-ahead).
// Eine Datenkorrektur erzeugt eine NEUE Resolution-Version (append-only),
// überschreibt aber niemals die Historie.
//
// Der Wirksstatus eines Forecasts ist ABGELEITET: die jüngste Resolution
// (höchstes `resolution_version`) bestimmt RESOLVED/VOID; ohne Resolution
// ist der Forecast PENDING. Die Forecast-Zeile selbst wird nie aktualisiert.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unveränderlicher Forecast-Vertrag (append-only).
 *
 * Natürlicher Schlüssel: `idempotency_key` = `fk1:<sha256>` über Vertrags-
 * und Inhaltsfelder (Rolle, Promptversion, Modell, Entity, Ziel-Event,
 * Horizont, As-of-Zeit, Wahrscheinlichkeitsinhalt). Retries oder doppelt
 * erfasste Analysen schreiben keinen zweiten Forecast.
 */
export const forecasts = pgTable(
  "forecasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `fk1:<sha256>` — natürlicher, inhaltlicher Schlüssel (Idempotenz). */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Rolle des erzeugenden Agenten (z. B. `TECHNICAL_ANALYST`). */
    agentRole: text("agent_role").notNull(),
    /** Prompt-Version (`agents.version`) zum Capture-Zeitpunkt. */
    promptVersion: integer("prompt_version").notNull(),
    /** Modelltag zum Capture-Zeitpunkt. */
    model: text("model").notNull(),
    /** Entity-Typ — aktuell ausschließlich `instrument`. */
    entityType: text("entity_type").notNull().default("instrument"),
    /** Kanonische Instrument-ID (z. B. `PAPER:BTC`). */
    entityId: text("entity_id").notNull(),
    /** Symbol, wie der Analyst es verwendet hat (Anzeige/Provenienz). */
    symbol: text("symbol").notNull(),
    /** Ziel-Event (abgeschlossene Liste, aktuell `CLOSE_DIRECTION`). */
    targetKind: text("target_kind").notNull(),
    /** Auflösungskategorien, z. B. `["DOWN","UP"]`. */
    categories: jsonb("categories").notNull().$type<readonly string[]>(),
    /** Wahrscheinlichkeitsvektor zu `categories`, Summe = 1 (validiert). */
    probabilities: jsonb("probabilities").notNull().$type<readonly number[]>(),
    /** Kategorie, deren Eintreten binär als „1“ gezählt wird. */
    targetCategory: text("target_category").notNull(),
    /** Target-Wahrscheinlichkeit als Skalar (binäre Sicht, SQL-tauglich). */
    probability: numeric("probability").notNull(),
    /** Horizont-ID (abgeschlossen: 4h | 24h | 72h). */
    horizonId: text("horizon_id").notNull(),
    /** Horizont in Minuten (redundant zu `horizon_id`, explizit für Queries). */
    horizonMinutes: integer("horizon_minutes").notNull(),
    /** Auflösungs-Timeframe der Kerzen-Schlusszeiten (fix `1h`). */
    timeframe: text("timeframe").notNull(),
    /** Entstehungszeit (Analysezeitpunkt). */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Schlusszeit der Referenzkerze (letzte geschlossene Kerze vor `as_of`). */
    referenceTime: timestamp("reference_time", { withTimezone: true }).notNull(),
    /** Referenzschlusskurs zum Capture-Zeitpunkt (Provenienz). */
    referenceClose: numeric("reference_close").notNull(),
    /** Schlusszeit der Outcome-Kerze. */
    resolvesAt: timestamp("resolves_at", { withTimezone: true }).notNull(),
    /** Verfügbarkeits-Deadline der automatischen Auflösung. */
    availabilityDeadline: timestamp("availability_deadline", { withTimezone: true }).notNull(),
    /** Adaptives Regime zum Capture-Zeitpunkt (`UNKNOWN` zulässig). */
    regime: text("regime").notNull().default("UNKNOWN"),
    /** Policyversion der Capture-/Auflösungsregeln (z. B. `fp1`). */
    policyVersion: text("policy_version").notNull(),
    /** Vertragsversion. */
    contractVersion: integer("contract_version").notNull(),
    /** Capture-Provenienz (Quelle, Referenzbar, Policy) — ohne Fremdtexte. */
    sourceManifest: jsonb("source_manifest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("forecasts_key_unique").on(t.idempotencyKey),
    // Segment-/Scorepfade (bounded Queries nach Rolle/Horizont/Entity/Zeitraum).
    index("forecasts_agent_asof_idx").on(t.agentRole, t.asOf),
    index("forecasts_entity_asof_idx").on(t.entityId, t.asOf),
    index("forecasts_horizon_asof_idx").on(t.horizonId, t.asOf),
    // Resolver: fällige Forecasts (Deadline erreicht, jüngste zuerst).
    index("forecasts_deadline_idx").on(t.availabilityDeadline),
    check("forecasts_entity_type_check", sql`${t.entityType} = 'instrument'`),
    check("forecasts_target_kind_check", sql`${t.targetKind} = 'CLOSE_DIRECTION'`),
    check("forecasts_horizon_check", sql`${t.horizonId} IN ('4h','24h','72h')`),
    check("forecasts_horizon_minutes_check", sql`${t.horizonMinutes} IN (240, 1440, 4320)`),
    check("forecasts_timeframe_check", sql`${t.timeframe} = '1h'`),
    check(
      "forecasts_probability_check",
      sql`${t.probability} >= 0 AND ${t.probability} <= 1`
    ),
    check("forecasts_prompt_version_check", sql`${t.promptVersion} >= 0`),
    check("forecasts_contract_version_check", sql`${t.contractVersion} >= 1`),
    check(
      "forecasts_time_order_check",
      sql`${t.referenceTime} <= ${t.asOf} AND ${t.resolvesAt} > ${t.asOf} AND ${t.availabilityDeadline} > ${t.resolvesAt}`
    ),
    check("forecasts_key_hash_check", sql`${t.idempotencyKey} ~ '^fk1:[0-9a-f]{64}$'`),
    check(
      "forecasts_regime_check",
      sql`${t.regime} IN ('NORMAL','ELEVATED','EXTREME','PERSISTED','UNKNOWN')`
    ),
    check(
      "forecasts_categories_json_check",
      sql`jsonb_typeof(${t.categories}) = 'array' AND jsonb_array_length(${t.categories}) >= 2`
    ),
    check(
      "forecasts_probabilities_json_check",
      sql`jsonb_typeof(${t.probabilities}) = 'array' AND jsonb_array_length(${t.probabilities}) = jsonb_array_length(${t.categories})`
    ),
  ]
);

/**
 * Versionierte Auflösung eines Forecasts (append-only).
 *
 * Eine Resolution wird genau einmal geschrieben: `UNIQUE(forecast_id,
 * outcome_hash)` macht Retries idempotent (identisches Ergebnis ⇒ no-op).
 * Ein ABWEICHENDES Ergebnis (Datenkorrektur, Operator-Eingriff) erhält die
 * nächste `resolution_version` — die Historie wird nie überschrieben.
 * Für das Scoring zählt stets die jüngste Version je Forecast.
 */
export const forecastResolutions = pgTable(
  "forecast_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    forecastId: uuid("forecast_id").notNull().references(() => forecasts.id),
    /** 1-basiert, strikt monoton je Forecast. */
    resolutionVersion: integer("resolution_version").notNull(),
    /** RESOLVED | VOID. */
    status: text("status").notNull(),
    /** Index der eingetretenen Kategorie (`null` bei VOID). */
    outcomeIndex: integer("outcome_index"),
    /** Label der eingetretenen Kategorie (`null` bei VOID). */
    outcomeLabel: text("outcome_label"),
    /** Binäre Sicht: 1 = Target-Kategorie eingetreten (`null` bei VOID). */
    outcomeBinary: integer("outcome_binary"),
    /** Autoritativer Referenzschlusskurs (`null` bei VOID ohne Daten). */
    referenceClose: numeric("reference_close"),
    /** Autoritativer Outcome-Schlusskurs (`null` bei VOID ohne Daten). */
    outcomeClose: numeric("outcome_close"),
    /** Geschlossener VOID-Grund (`null` bei RESOLVED). */
    voidReason: text("void_reason"),
    /** AUTOMATIC | OPERATOR. */
    resolutionKind: text("resolution_kind").notNull(),
    /** Berechnungszeitpunkt der Auflösung. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
    /** Policyversion der Auflösung. */
    policyVersion: text("policy_version").notNull(),
    /** `fo1:<sha256>` — Inhaltsfingerprint (Idempotenz-/Revisionskennung). */
    outcomeHash: text("outcome_hash").notNull(),
    /**
     * Datenmanifest: verwendete Kerzen (ts/close/volume/fetched_at),
     * Dataset-Hash, Qualitätszähler, Auflösungsweg — keine Secrets.
     */
    outcomeManifest: jsonb("outcome_manifest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("forecast_resolutions_version_unique").on(t.forecastId, t.resolutionVersion),
    uniqueIndex("forecast_resolutions_outcome_hash_unique").on(t.forecastId, t.outcomeHash),
    index("forecast_resolutions_status_idx").on(t.status, t.resolvedAt),
    check("forecast_resolutions_status_check", sql`${t.status} IN ('RESOLVED','VOID')`),
    check(
      "forecast_resolutions_exclusive_check",
      sql`(${t.status} = 'RESOLVED' AND ${t.outcomeIndex} IS NOT NULL AND ${t.voidReason} IS NULL)
        OR (${t.status} = 'VOID' AND ${t.outcomeIndex} IS NULL AND ${t.voidReason} IS NOT NULL)`
    ),
    check(
      "forecast_resolutions_binary_check",
      sql`${t.outcomeBinary} IS NULL OR ${t.outcomeBinary} IN (0, 1)`
    ),
    check(
      "forecast_resolutions_void_reason_check",
      sql`${t.voidReason} IS NULL OR ${t.voidReason} IN
        ('MISSING_DATA','INVALID_DATA','TRADING_HALT','STALE_DATA','CORPORATE_ACTION','DATA_CORRECTION')`
    ),
    check(
      "forecast_resolutions_kind_check",
      sql`${t.resolutionKind} IN ('AUTOMATIC','OPERATOR')`
    ),
    check("forecast_resolutions_version_check", sql`${t.resolutionVersion} >= 1`),
    check("forecast_resolutions_hash_check", sql`${t.outcomeHash} ~ '^fo1:[0-9a-f]{64}$'`),
  ]
);

/**
 * Lauf-Manifest des Resolver-Jobs (append-only, Idempotenzschlüssel).
 *
 * Ein Lauf dokumentiert Fenster, Politik, Codeversion und Zähler. Der
 * `idempotency_key` ist UNIQUE — ein identisch parametrisierter Retry
 * erzeugt kein zweites Manifest. Die Wirkungsidempotenz (keine doppelten
 * Resolutionen) garantieren zusätzlich die Unique-Keys der Resolutionen.
 */
export const forecastResolutionRuns = pgTable(
  "forecast_resolution_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `frk1:<sha256>` über Modus, Fenster, Policy, Codeversion, Limit. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** AUTOMATIC | OPERATOR. */
    mode: text("mode").notNull(),
    /** SUCCEEDED | FAILED. */
    status: text("status").notNull(),
    /** Zähler (dueConsidered, resolved, voided, duplicates, failed, …). */
    countsJson: jsonb("counts_json").notNull(),
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
    uniqueIndex("forecast_resolution_runs_key_unique").on(t.idempotencyKey),
    index("forecast_resolution_runs_finished_idx").on(t.finishedAt),
    check("forecast_resolution_runs_mode_check", sql`${t.mode} IN ('AUTOMATIC','OPERATOR')`),
    check("forecast_resolution_runs_status_check", sql`${t.status} IN ('SUCCEEDED','FAILED')`),
    check(
      "forecast_resolution_runs_error_check",
      sql`(${t.status} = 'FAILED' AND ${t.errorCode} IS NOT NULL)
        OR (${t.status} = 'SUCCEEDED' AND ${t.errorCode} IS NULL)`
    ),
    check("forecast_resolution_runs_key_hash_check", sql`${t.idempotencyKey} ~ '^frk1:[0-9a-f]{64}$'`),
  ]
);

/**
 * Wasserstand des Resolver-Jobs (Betriebsdiagnose, monotone Marke).
 *
 * `watermark_deadline` ist die höchste Verfügbarkeits-Deadline, bis zu der
 * alle fälligen Forecasts bearbeitet wurden. Die Marke bewegt sich nur
 * vorwärts (`GREATEST` im Upsert); Lag/Staleness ist damit direkt messbar
 * (`now − älteste offene Deadline` bzw. `now − watermark`).
 */
export const forecastResolverCursors = pgTable(
  "forecast_resolver_cursors",
  {
    /** Fester Schlüssel — aktuell ausschließlich `resolution`. */
    cursorId: text("cursor_id").primaryKey(),
    watermarkDeadline: timestamp("watermark_deadline", { withTimezone: true }).notNull(),
    lastRunId: uuid("last_run_id").references(() => forecastResolutionRuns.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("forecast_resolver_cursors_last_run_idx").on(t.lastRunId),
    check("forecast_resolver_cursors_id_check", sql`${t.cursorId} = 'resolution'`),
  ]
);

/** Canonical execution-quality ledger. SQL migration also installs immutability
 * triggers; apply drizzle/2026-09-20_execution_quality.sql, not only schema push. */
export const executionQualityIntents = pgTable("execution_quality_intents", {
  id: text("id").primaryKey(),
  venue: text("venue").notNull(),
  mode: text("mode").notNull(),
  scope: text("scope").notNull(),
  clientOrderId: text("client_order_id").notNull(),
  submitAt: timestamp("submit_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").$type<import("../executionQuality/model").Intent>().notNull(),
  parentIntentId:text("parent_intent_id").generatedAlwaysAs(sql`payload->>'parentIntentId'`).references(():AnyPgColumn=>executionQualityIntents.id),
}, t => [
  uniqueIndex("execution_quality_intents_client_idx").on(t.venue, t.mode, t.scope, t.clientOrderId),
  index("execution_quality_intents_time_idx").on(t.submitAt, t.id),
  index("execution_quality_parent_idx").on(t.parentIntentId),
  index("execution_quality_decision_idx").on(sql`(${t.payload}->>'decisionId')`),
  index("execution_quality_scope_idx").on(t.venue,t.mode,t.scope,t.id),
  check("execution_quality_intents_mode_check", sql`${t.mode} IN ('backtest','paper','testnet','live')`),
  check("execution_quality_intents_payload_check", sql`jsonb_typeof(${t.payload}) = 'object'`),
]);
export const executionQualityEvents = pgTable("execution_quality_events", {
  id: text("id").primaryKey(),
  intentId: text("intent_id").notNull().references(() => executionQualityIntents.id),
  externalKey: text("external_key").notNull().unique(),
  kind: text("kind").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").$type<import("../executionQuality/model").QualityEvent>().notNull(),
}, t => [
  index("execution_quality_events_intent_idx").on(t.intentId, t.availableAt),
  check("execution_quality_events_kind_check", sql`${t.kind} IN ('ack','fill','benchmark')`),
  check("execution_quality_events_payload_check", sql`jsonb_typeof(${t.payload}) = 'object'`),
]);

/** Durable send-once claims. Missing receipt means UNKNOWN, never retry send. */
export const executionQualitySubmissions = pgTable("execution_quality_submissions", {
  intentId: text("intent_id").primaryKey().references(() => executionQualityIntents.id),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
}, t => [check("execution_quality_submissions_request_hash_check", sql`${t.requestHash} ~ '^[a-f0-9]{64}$'`)]);
export const executionQualityReceipts = pgTable("execution_quality_receipts", {
  intentId: text("intent_id").primaryKey().references(() => executionQualitySubmissions.intentId),
  result: jsonb("result").$type<import("../contracts/broker").BrokerOrderResult>().notNull(),
  observedAt:timestamp("observed_at",{withTimezone:true}).notNull(),
  elapsedMs:numeric("elapsed_ms"),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
}, t => [check("execution_quality_receipts_elapsed_ms_check",sql`${t.elapsedMs} >= 0`),check("execution_quality_receipts_result_check", sql`jsonb_typeof(${t.result}) = 'object'`)]);

/** Minimal observed L1 mids, never raw broker bodies. */
export const executionQualityQuotes = pgTable("execution_quality_quotes", {
  id:text("id").primaryKey(), venue:text("venue").notNull(), mode:text("mode").notNull(),
  scope:text("scope").notNull(), instrument:text("instrument").notNull(), mid:numeric("mid").notNull(),
  eventAt:timestamp("event_at",{withTimezone:true}).notNull(), availableAt:timestamp("available_at",{withTimezone:true}).notNull(),
},t=>[
  index("execution_quality_quotes_asof_idx").on(t.venue,t.mode,t.scope,t.instrument,t.eventAt.desc(),t.availableAt),
  check("execution_quality_quotes_mode_check",sql`${t.mode} IN ('backtest','paper','testnet','live')`),
  check("execution_quality_quotes_mid_check",sql`${t.mid} > 0 AND ${t.mid} <= 1000000000000000`),
  check("execution_quality_quotes_check",sql`${t.eventAt} <= ${t.availableAt}`),
]);

export const executionQualityCompleted = pgTable("execution_quality_completed", {
  intentId:text("intent_id").primaryKey().references(()=>executionQualityIntents.id),
  completedAt:timestamp("completed_at",{withTimezone:true}).notNull().defaultNow(),
});

/**
 * Persistente Regime-Snapshots (RMA-P2-01, v1.61.0) — append-only Historie
 * der multidimensionalen Regime-Bewertungen für Stabilitäts-/Coverage- und
 * OOS-Auswertung (`src/lib/regimeEvaluation.ts`, `npm run regime:eval`).
 *
 * Idempotenz: `idempotency_key` (sha256 über Symbol|asOf|Rohklasse|
 * bestätigte Klasse|Coverage|Versionen) — Retries/Restarts derselben
 * Bewertung schreiben keine zweite Zeile. Neue Semantik ⇒ neue Keyteile,
 * keine Überschreibungen.
 */
export const regimeSnapshots = pgTable(
  "regime_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    symbol: text("symbol").notNull(),
    /** As-of der Bewertung (Ereigniszeit des Snapshots). */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Berechnungszeit (Persistenzzeitpunkt der Zeile). */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** Rohklassifikation vor Hysterese. */
    rawRegime: text("raw_regime").notNull(),
    /** Bestätigter Zustand der Hysterese (Gate-relevant). */
    confirmedRegime: text("confirmed_regime").notNull(),
    /** Confidence [0,1]; NULL bei UNKNOWN (kein stiller 0-Wert). */
    confidence: numeric("confidence"),
    /** Coverage des Feature-Vertrags [0,1]. */
    coverage: numeric("coverage").notNull(),
    degraded: boolean("degraded").notNull(),
    gateMode: text("gate_mode").notNull(),
    featureMode: text("feature_mode").notNull(),
    featureVersion: text("feature_version").notNull(),
    modelVersion: text("model_version").notNull(),
    /** Top-Treiber (≤5, gebounded) — keine Instrument-IDs als Metriklabels. */
    topDrivers: jsonb("top_drivers").notNull(),
    /** Familienstatus (≤5 Familien × Status/Reason). */
    familyStatus: jsonb("family_status").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("regime_snapshots_idem_unique").on(t.idempotencyKey),
    index("regime_snapshots_symbol_asof_idx").on(t.symbol, t.asOf),
    index("regime_snapshots_asof_idx").on(t.asOf),
    check(
      "regime_snapshots_regime_check",
      sql`${t.rawRegime} IN ('TREND_UP','TREND_DOWN','RANGE','HIGH_VOL','CRASH','UNKNOWN')
        AND ${t.confirmedRegime} IN ('TREND_UP','TREND_DOWN','RANGE','HIGH_VOL','CRASH','UNKNOWN')`
    ),
    check(
      "regime_snapshots_confidence_check",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`
    ),
    check("regime_snapshots_coverage_check", sql`${t.coverage} >= 0 AND ${t.coverage} <= 1`),
    check(
      "regime_snapshots_gate_mode_check",
      sql`${t.gateMode} IN ('off','monitor','enforce')`
    ),
    check(
      "regime_snapshots_feature_mode_check",
      sql`${t.featureMode} IN ('ohlcv','multidim')`
    ),
    check("regime_snapshots_idem_check", sql`${t.idempotencyKey} ~ '^[a-f0-9]{64}$'`),
  ]
);

/**
 * Point-in-Time Cross-Sectional Momentum Ranking (RMA-P2-04, v1.63.0) —
 * append-only Snapshots universumsweiter Momentum-Perzentile am gemeinsamen
 * As-of-Cutoff mit vollständiger Provenance (Universe-/Data-/Config-Hash).
 *
 * `crossSectionalSnapshots`: EINE Zeile je Snapshot-Lauf; `snapshotId`
 * (`xs1:<sha256>`) ist die DETERMINISTISCHE Snapshot-Identität und
 * `idempotencyKey` (derselbe Hex-Hash) macht Retries/Restarts zu No-Ops.
 * `stability` ist NULL beim ersten Snapshot, danach gebounded Turnover.
 *
 * `crossSectionalRankings`: EINE Zeile je (Snapshot, Instrument): RANKED
 * (Rang/Perzentil/Composite) oder EXCLUDED (geschlossener Grund; nie still 0).
 * FK mit ON DELETE CASCADE (Retention entfernt Snapshot + Mitglieder).
 */
export const crossSectionalSnapshots = pgTable(
  "cross_sectional_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Deterministische Snapshot-Identität `xs1:<sha256>`. */
    snapshotId: text("snapshot_id").notNull(),
    /** SHA-256-Idempotenz-Key (hex) über die fachliche Snapshot-Identität. */
    idempotencyKey: text("idempotency_key").notNull(),
    /** Gemeinsamer As-of-Cutoff (Ereigniszeit). */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Berechnungszeit (Persistenzzeitpunkt) — nie Zulässigkeitskriterium. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    codeVersion: text("code_version").notNull(),
    configVersion: integer("config_version").notNull(),
    configHash: text("config_hash").notNull(),
    universeHash: text("universe_hash").notNull(),
    dataHash: text("data_hash").notNull(),
    timeframe: text("timeframe").notNull(),
    availabilityPolicy: text("availability_policy").notNull(),
    universeSize: integer("universe_size").notNull(),
    rankedCount: integer("ranked_count").notNull(),
    excludedCount: integer("excluded_count").notNull(),
    /** `rankedCount / universeSize` ∈ [0,1]. */
    coverage: numeric("coverage").notNull(),
    /** Ausschlusszähler je Grund (gebounded, nur Gründe > 0). */
    exclusionCounts: jsonb("exclusion_counts").notNull(),
    /** Turnover-/Stabilitätsmessung; NULL beim ersten Snapshot. */
    stability: jsonb("stability"),
    /** Sichtbar dokumentierte Survivorship-Grenze. */
    survivorshipNote: text("survivorship_note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cross_sectional_snapshots_idem_unique").on(t.idempotencyKey),
    uniqueIndex("cross_sectional_snapshots_snapshot_id_unique").on(t.snapshotId),
    index("cross_sectional_snapshots_asof_idx").on(t.asOf),
    check("cross_sectional_snapshots_computed_check", sql`${t.computedAt} >= ${t.asOf}`),
    check("cross_sectional_snapshots_schema_check", sql`${t.schemaVersion} >= 1`),
    check(
      "cross_sectional_snapshots_counts_check",
      sql`${t.universeSize} >= 0 AND ${t.rankedCount} >= 0 AND ${t.excludedCount} >= 0
        AND ${t.rankedCount} <= ${t.universeSize}
        AND ${t.rankedCount} + ${t.excludedCount} = ${t.universeSize}`
    ),
    check("cross_sectional_snapshots_coverage_check", sql`${t.coverage} >= 0 AND ${t.coverage} <= 1`),
    check("cross_sectional_snapshots_snapshot_id_check", sql`${t.snapshotId} ~ '^xs1:[0-9a-f]{64}$'`),
    check("cross_sectional_snapshots_idem_check", sql`${t.idempotencyKey} ~ '^[0-9a-f]{64}$'`),
    check(
      "cross_sectional_snapshots_hash_check",
      sql`${t.configHash} ~ '^xc1:[0-9a-f]{64}$' AND ${t.universeHash} ~ '^xu1:[0-9a-f]{64}$'
        AND ${t.dataHash} ~ '^xd1:[0-9a-f]{64}$'`
    ),
    check(
      "cross_sectional_snapshots_timeframe_check",
      sql`${t.timeframe} IN ('1m','3m','5m','15m','30m','1h','2h','4h','1d','5d')`
    ),
    check("cross_sectional_snapshots_policy_check", sql`${t.availabilityPolicy} IN ('ingested','bar_close')`),
  ]
);

export const crossSectionalRankings = pgTable(
  "cross_sectional_rankings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => crossSectionalSnapshots.snapshotId, { onDelete: "cascade" }),
    instrumentId: text("instrument_id").notNull(),
    /** `RANKED` | `EXCLUDED` (geschlossene Liste, CHECK). */
    status: text("status").notNull(),
    /** Rang (1 = beste), nur bei RANKED. */
    rank: integer("rank"),
    /** Perzentil ∈ (0,1], nur bei RANKED. */
    percentile: numeric("percentile"),
    /** Composite (gewichtete z-Score-Summe), nur bei RANKED. */
    composite: numeric("composite"),
    /** Rohrenditen je Horizont (explizite NULLs, nie 0). */
    rawReturns: jsonb("raw_returns").notNull(),
    zScores: jsonb("z_scores").notNull(),
    winsorized: jsonb("winsorized").notNull(),
    /** Anteil verfügbarer Horizonte [0,1]. */
    horizonCoverage: numeric("horizon_coverage").notNull(),
    /** barEnd der jüngsten genutzten Kerze (Ereigniszeit). */
    lastBarTs: timestamp("last_bar_ts", { withTimezone: true }),
    /** availableAt (Ingestionszeit) dieser Kerze. */
    lastAvailableAt: timestamp("last_available_at", { withTimezone: true }),
    barsUsed: integer("bars_used").notNull().default(0),
    /** Geschlossener Ausschlussgrund, nur bei EXCLUDED. */
    exclusionReason: text("exclusion_reason"),
    /** SHA-256 der zeilengen Fachinhalte (Konflikt-Guard statt Überschreiben). */
    valueHash: text("value_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("cross_sectional_rankings_snapshot_instrument_unique").on(t.snapshotId, t.instrumentId),
    index("cross_sectional_rankings_snapshot_rank_idx").on(t.snapshotId, t.rank),
    check("cross_sectional_rankings_status_check", sql`${t.status} IN ('RANKED','EXCLUDED')`),
    check(
      "cross_sectional_rankings_ranked_check",
      sql`(${t.status} = 'RANKED') = (${t.rank} IS NOT NULL)
        AND ((${t.status} = 'EXCLUDED') = (${t.exclusionReason} IS NOT NULL))`
    ),
    check(
      "cross_sectional_rankings_percentile_check",
      sql`${t.percentile} IS NULL OR (${t.percentile} > 0 AND ${t.percentile} <= 1)`
    ),
    check("cross_sectional_rankings_coverage_check", sql`${t.horizonCoverage} >= 0 AND ${t.horizonCoverage} <= 1`),
    check(
      "cross_sectional_rankings_reason_check",
      sql`${t.exclusionReason} IS NULL OR ${t.exclusionReason} IN
        ('INACTIVE','NOT_IN_ASSET_CLASSES','NO_LIQUIDITY_DATA','BELOW_MIN_VOLUME',
         'UNIVERSE_CAP','NO_BARS_AT_CUTOFF','STALE_DATA','INSUFFICIENT_HISTORY',
         'INSUFFICIENT_HORIZON_COVERAGE','CROSS_SECTION_DEGENERATE','INVALID_INPUT')`
    ),
    check("cross_sectional_rankings_hash_check", sql`${t.valueHash} ~ '^[0-9a-f]{64}$'`),
    check("cross_sectional_rankings_bars_check", sql`${t.barsUsed} >= 0 AND (${t.lastBarTs} IS NULL OR ${t.barsUsed} > 0)`),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// RMA-P2-05 (v1.64.0): Kalibrierbare strukturierte Sentiment-Outputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persistente Sentiment-Forecast-Historie (append-only).
 *
 * Ein unveränderlicher Forecast-Envelope je (Entity, Auswertungszeitpunkt, Horizont)
 * mit strikter Trennung von direktionaler Wahrscheinlichkeit und Quellenabdeckung.
 *
 * Natürlicher Schlüssel: `forecast_id` (`sf1:<sha256>`).
 * Bei Retries/Restarts identischer Läufe sorgt der Unique-Constraint für Idempotenz.
 */
export const sentimentForecasts = pgTable(
  "sentiment_forecasts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `sf1:<sha256>` — deterministischer, natürlicher Schlüssel (Idempotenz). */
    forecastId: text("forecast_id").notNull(),
    /** Kanonische Entity-ID (z. B. `BINANCE:BTCUSDT` oder `PAPER:BTC`). */
    entityId: text("entity_id").notNull(),
    /** Symbol (z. B. `BTC` oder `BTCUSDT`). */
    symbol: text("symbol").notNull(),
    /** Richtung: `BULLISH` | `BEARISH` | `NEUTRAL` (NULL bei ABSTAIN). */
    direction: text("direction"),
    /** Status: `ACTIVE` | `ABSTAIN` (geschlossen). */
    status: text("status").notNull(),
    /** Direktionale Wahrscheinlichkeit UP ∈ [0.01, 0.99] (NULL bei ABSTAIN). */
    probability: numeric("probability"),
    /** Direktionale Konfidenz ∈ [0, 1] (0 bei ABSTAIN). */
    confidence: numeric("confidence").notNull(),
    /** Explizites Enthaltungsflag. */
    abstain: boolean("abstain").notNull().default(false),
    /** Geschlossener Grund für ABSTAIN (`NO_SOURCES` | `INSUFFICIENT_SOURCES` | `CONFLICTING_SIGNALS` | `LOW_QUALITY` | `STALE_SOURCES` | `FILTERED`). */
    abstainReason: text("abstain_reason"),
    /** Horizont-ID (`4h` | `24h` | `72h`). */
    horizon: text("horizon").notNull(),
    /** Horizont in Minuten (240 | 1440 | 4320). */
    horizonMinutes: integer("horizon_minutes").notNull(),
    /** Event-Typ (`MACRO` | `EARNINGS` | `REGULATORY` | `PRODUCT` | `SECURITY` | `MARKET_STRUCTURE` | `GENERAL`). */
    eventType: text("event_type").notNull().default("GENERAL"),
    /** Eindeutige, deduplizierte Quellen-Anzahl. */
    sourceCount: integer("source_count").notNull(),
    /** Rohe Quellen-Anzahl vor Syndikations-Deduplikation. */
    rawSourceCount: integer("raw_source_count").notNull(),
    /** Quellen-Abdeckung / Coverage ∈ [0, 1]. */
    coverage: numeric("coverage").notNull(),
    /** Veröffentlichungszeitpunkt der maßgeblichen Quelle (Ereigniszeit). */
    sourceEventTime: timestamp("source_event_time", { withTimezone: true }),
    /** Früheste Quellenzeit. */
    sourceEarliestAt: timestamp("source_earliest_at", { withTimezone: true }),
    /** Späteste Quellenzeit. */
    sourceLatestAt: timestamp("source_latest_at", { withTimezone: true }),
    /** Analyse- und Erfassungszeitpunkt (`as_of`). */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Horizontende / Auswertungszeitpunkt (`valid_until` = asOf + horizon). */
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    /** Prompt-Version des Agenten. */
    promptVersion: integer("prompt_version").notNull(),
    /** Modell-Tag des ausführenden LLM. */
    model: text("model").notNull(),
    /** Schema-Version (z. B. `sentiment@1`). */
    schemaVersion: text("schema_version").notNull(),
    /** Fingerprint der deduplizierten Quellen (`sd1:<sha256>`). */
    sourceDeduplicationHash: text("source_deduplication_hash").notNull(),
    /** Fachlicher Content-Hash (`sc1:<sha256>`). */
    contentHash: text("content_hash").notNull(),
    /** Optionaler Link zum P3.1 Forecast-Ledger (z. B. `fk1:<sha256>`). */
    ledgerForecastId: text("ledger_forecast_id"),
    /** Zusammenfassung / These. */
    summary: text("summary").notNull(),
    /** Risikoflags als JSON-Array (max. 5 Einträge). */
    riskFlags: jsonb("risk_flags").notNull().$type<readonly string[]>(),
    /** Numerischer Impact-Score ∈ [0, 100]. */
    impactScore: numeric("impact_score").notNull(),
    /** Provenienz / Metadaten (Deduplikationsdetails, Syndikationszähler, etc.). */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sentiment_forecasts_forecast_id_unique").on(t.forecastId),
    index("sentiment_forecasts_entity_asof_idx").on(t.entityId, t.asOf),
    index("sentiment_forecasts_asof_status_idx").on(t.asOf, t.status),
    index("sentiment_forecasts_status_horizon_idx").on(t.status, t.horizon),
    check("sentiment_forecasts_status_check", sql`${t.status} IN ('ACTIVE','ABSTAIN')`),
    check(
      "sentiment_forecasts_direction_check",
      sql`${t.direction} IS NULL OR ${t.direction} IN ('BULLISH','BEARISH','NEUTRAL')`
    ),
    check(
      "sentiment_forecasts_abstain_check",
      sql`(${t.status} = 'ABSTAIN') = (${t.abstain} = true)
        AND (${t.abstain} = true) = (${t.abstainReason} IS NOT NULL)
        AND (${t.abstain} = true) = (${t.probability} IS NULL)
        AND (${t.abstain} = true) = (${t.direction} IS NULL)`
    ),
    check(
      "sentiment_forecasts_probability_check",
      sql`${t.probability} IS NULL OR (${t.probability} >= 0.01 AND ${t.probability} <= 0.99)`
    ),
    check("sentiment_forecasts_confidence_check", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check("sentiment_forecasts_coverage_check", sql`${t.coverage} >= 0 AND ${t.coverage} <= 1`),
    check("sentiment_forecasts_horizon_check", sql`${t.horizon} IN ('4h','24h','72h')`),
    check("sentiment_forecasts_valid_until_check", sql`${t.validUntil} > ${t.asOf}`),
    check(
      "sentiment_forecasts_source_count_check",
      sql`${t.sourceCount} >= 0 AND ${t.rawSourceCount} >= ${t.sourceCount}`
    ),
    check(
      "sentiment_forecasts_forecast_id_check",
      sql`${t.forecastId} ~ '^sf1:[0-9a-f]{64}$'`
    ),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-Version-Metrikvergleich (RMA-P3-02, v1.65.0) — append-only
//
// Zwei Tabellen, ausschließlich additiv (Migration
// `drizzle/2026-09-22_prompt_performance.sql`):
//
//   prompt_artifacts        immutable Prompt-Versionen je Agent (hash + Text)
//   agent_prompt_runs       Provenanz je LLM-Aufruf (Artifact + Modell + Tokens)
//
// Zeitsemantik je Run: `started_at`/`ended_at` (Ereigniszeit des LLM-Aufrufs),
// `created_at` (Persistenz). Eine historische Analyse bleibt über ihren
// `prompt_hash` unverändert zuordenbar, auch nach späteren Prompt-Änderungen.
// `null` ist nie `0`: fehlende Tokens/Kosten bleiben null, nicht 0.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Immutable Prompt-Artefakt: eine Version eines Agenten-Prompts.
 *
 * Historische Zeilen werden nie überschrieben — ein Prompt-Update erzeugt
 * eine NEUE Zeile mit neuer Version und neuem Hash. Der Hash `pp1:<sha256>`
 * ist deterministisch kanonisiert (Zeilenenden → LF) und stabil über
 * Plattformen.
 */
export const promptArtifacts = pgTable(
  "prompt_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agents.id),
    role: text("role").notNull(),
    version: integer("version").notNull(),
    /** `pp1:<sha256>` über den kanonischen Prompttext. */
    promptHash: text("prompt_hash").notNull(),
    /** Kanonischer Prompttext (nur berechtigt abrufbar, nie als Metriklabel). */
    canonicalPrompt: text("canonical_prompt").notNull(),
    /** Template-Schemaversion (z. B. "1"), bounded. */
    templateSchemaVersion: text("template_schema_version").notNull().default("1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("prompt_artifacts_agent_version_unique").on(t.agentId, t.version),
    uniqueIndex("prompt_artifacts_agent_hash_unique").on(t.agentId, t.promptHash),
    index("prompt_artifacts_role_idx").on(t.role, t.version),
    index("prompt_artifacts_hash_idx").on(t.promptHash),
    check("prompt_artifacts_version_check", sql`${t.version} >= 1`),
    check("prompt_artifacts_hash_check", sql`${t.promptHash} ~ '^pp1:[0-9a-f]{64}$'`),
    check("prompt_artifacts_role_check", sql`length(${t.role}) > 0 AND length(${t.role}) <= 64`),
    check("prompt_artifacts_template_check", sql`length(${t.templateSchemaVersion}) > 0 AND length(${t.templateSchemaVersion}) <= 16`),
  ]
);

/**
 * Provenanz eines einzelnen LLM-Aufrufs (append-only).
 *
 * Jeder Agentenaufruf referenziert exakt ein Prompt-Artefakt (oder UNKNOWN bei
 * historischer Lücke) samt Provider/Modell, Sampling-Parametern, Tool-/Schema-
 * Version, Start/Ende, Tokenverbrauch, Kostenstatus und Success/Failure.
 * Geheimnisse und rohe sensitive Payloads werden nie gespeichert.
 *
 * Idempotenz: `idempotency_key` `pr1:<sha256>` über Artifact + Zeitpunkt +
 * Modell + Versuch — Retries/Restarts erzeugen keinen zweiten Run.
 */
export const agentPromptRuns = pgTable(
  "agent_prompt_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Artefakt-Referenz (null = UNKNOWN, historische Lücke sichtbar). */
    artifactId: uuid("artifact_id").references(() => promptArtifacts.id),
    agentId: uuid("agent_id").references(() => agents.id),
    role: text("role").notNull(),
    /** `pp1:<sha256>` oder `UNKNOWN` (bounded, nie voller Prompt). */
    promptHash: text("prompt_hash").notNull(),
    /** Prompt-Version (null = UNKNOWN). */
    promptVersion: integer("prompt_version"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    temperature: numeric("temperature"),
    maxTokens: integer("max_tokens"),
    toolSchemaVersion: text("tool_schema_version"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    latencyMs: integer("latency_ms").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: numeric("cost_usd"),
    /** billed | free | unknown — Einheit klar, bounded. */
    costStatus: text("cost_status").notNull(),
    success: boolean("success").notNull(),
    errorCode: text("error_code"),
    /** `pr1:<sha256>` — stabiler Retry-Schlüssel. */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_prompt_runs_idempotency_unique").on(t.idempotencyKey),
    index("agent_prompt_runs_role_version_idx").on(t.role, t.promptVersion, t.startedAt),
    index("agent_prompt_runs_hash_idx").on(t.promptHash, t.startedAt),
    index("agent_prompt_runs_artifact_idx").on(t.artifactId),
    index("agent_prompt_runs_started_idx").on(t.startedAt),
    check("agent_prompt_runs_version_check", sql`${t.promptVersion} IS NULL OR ${t.promptVersion} >= 0`),
    check("agent_prompt_runs_hash_check", sql`${t.promptHash} ~ '^(pp1:[0-9a-f]{64}|UNKNOWN)$'`),
    check("agent_prompt_runs_provider_check", sql`${t.provider} IN ('ollama','openai','gemini','anthropic','fallback','unknown')`),
    check("agent_prompt_runs_latency_check", sql`${t.latencyMs} >= 0`),
    check("agent_prompt_runs_time_check", sql`${t.endedAt} >= ${t.startedAt}`),
    check("agent_prompt_runs_tokens_check", sql`(${t.promptTokens} IS NULL OR ${t.promptTokens} >= 0) AND (${t.completionTokens} IS NULL OR ${t.completionTokens} >= 0) AND (${t.totalTokens} IS NULL OR ${t.totalTokens} >= 0)`),
    check("agent_prompt_runs_cost_check", sql`${t.costUsd} IS NULL OR ${t.costUsd}::numeric >= 0`),
    check("agent_prompt_runs_cost_status_check", sql`${t.costStatus} IN ('billed','free','unknown')`),
    check("agent_prompt_runs_idempotency_check", sql`${t.idempotencyKey} ~ '^pr1:[0-9a-f]{64}$'`),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// Portfolio-Volatility-Targeting (RMA-P5-01, v1.67.0) — append-only
//
// Eine Tabelle, ausschließlich additiv (Migration
// `drizzle/2026-09-22_volatility_targeting.sql`):
//
//   volatility_targeting_snapshots  EINE Zeile je Volatility-Targeting-Snapshot
//                                   (Forecast + angewendeter Multiplikator +
//                                   Soll-Ist-Abgleich), append-only.
//
// Zeitsemantik:
//   as_of        = Entscheidungszeitpunkt (ms-epoch, timestamptz). Alle
//                  Returns stammen aus Kerzen mit Event-Time ≤ as_of.
//   computed_at  = Berechnungszeit des Snapshots. NIEMALS älter als as_of.
//   event_time   = jüngstes Event der ÄLTESTEN Komponente (ms-epoch) —
//                  Frischegrenze des Forecasts. NULL ohne Daten (Fallback).
//
// Fail-closed: `forecast_annualized_vol` ist NULL bei Fallback (nicht 0);
// `raw_multiplier` ist NULL, wenn der rohe Wert nicht berechenbar ist.
// `applied_multiplier` ist IMMER endlich und ≤ 1 (CHECK-Constraint).
// ─────────────────────────────────────────────────────────────────────────────

export const volatilityTargetingSnapshots = pgTable(
  "volatility_targeting_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `vt1:<sha256>` — deterministischer Idempotency-Key (Retry ⇒ No-Op). */
    snapshotId: text("snapshot_id").notNull(),
    /** Betriebsmodus: `monitor` (keine Ordergrößenänderung) | `active`. */
    mode: text("mode").notNull(),
    /** `true` wenn Mode = `monitor` (redundant mit `mode`, CHECK-geprüft). */
    monitorOnly: boolean("monitor_only").notNull(),
    /** Status: `OK` | `FALLBACK` | `NO_EXPOSURE` (geschlossen). */
    status: text("status").notNull(),
    /** Geschlossener Grund-Code (bounded, z. B. `STALE_DATA`, `OK`). */
    reasonCode: text("reason_code").notNull(),
    /** Menschenlesbare Begründung (Audit/Status). */
    reason: text("reason").notNull(),
    /** Entscheidungszeitpunkt (timestamptz). */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Berechnungszeit (timestamptz), immer ≥ as_of. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** Jüngstes Event der ältesten Komponente (timestamptz) — NULL bei Fallback. */
    eventTime: timestamp("event_time", { withTimezone: true }),
    /** Annualisiertes Volatilitätsziel (dezimal, 0.30 = 30 % p. a.). */
    targetAnnualizedVol: numeric("target_annualized_vol").notNull(),
    /** Annualisierte Forecast-Volatilität (dezimal) — NULL bei Fallback. */
    forecastAnnualizedVol: numeric("forecast_annualized_vol"),
    /** Annualisierte realisierte Volatilität (dezimal) — NULL wenn nicht berechenbar. */
    realizedAnnualizedVol: numeric("realized_annualized_vol"),
    /** Target Error = realisiert − Ziel (dezimal) — NULL wenn realisiert null. */
    targetError: numeric("target_error"),
    /** Roher Multiplikator (vor Clamp/Smoothing/Step) — NULL bei Fallback. */
    rawMultiplier: numeric("raw_multiplier"),
    /** Letzter angewendeter Multiplikator (vor diesem Schritt). */
    prevMultiplier: numeric("prev_multiplier").notNull(),
    /** Tatsächlich angewendeter Multiplikator (IMMER endlich, ≤ 1, > 0). */
    appliedMultiplier: numeric("applied_multiplier").notNull(),
    /** Gewichtete Datenabdeckung ∈ [0, 1]. */
    coverage: numeric("coverage").notNull(),
    /** Anzahl Perioden T (0 bei Fallback). */
    observations: integer("observations").notNull(),
    /** Effektive Annualisierung (Perioden/Jahr). */
    annualization: numeric("annualization").notNull(),
    /** Angewendete Shrinkage κ. */
    shrinkage: numeric("shrinkage").notNull(),
    /** Angewendete Regularisierung: `none` | `ridge` | `skipped`. */
    regularization: text("regularization").notNull(),
    /** Normalisierte Zielgewichte (Instrument-ID → Anteil), jsonb. */
    weights: jsonb("weights").notNull().$type<Record<string, number>>(),
    /** Konfigurations-Hash `cfg1:<sha256>` (Reproduzierbarkeit). */
    configHash: text("config_hash").notNull(),
    /** Daten-Hash `data1:<sha256>` (Reproduzierbarkeit). */
    dataHash: text("data_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("volatility_targeting_snapshots_id_unique").on(t.snapshotId),
    index("volatility_targeting_snapshots_asof_idx").on(t.asOf),
    index("volatility_targeting_snapshots_status_idx").on(t.status),
    index("volatility_targeting_snapshots_mode_idx").on(t.mode),
    check("volatility_targeting_snapshots_mode_check", sql`${t.mode} IN ('monitor','active')`),
    check(
      "volatility_targeting_snapshots_monitor_only_check",
      sql`${t.monitorOnly} = (${t.mode} = 'monitor')`
    ),
    check(
      "volatility_targeting_snapshots_status_check",
      sql`${t.status} IN ('OK','FALLBACK','NO_EXPOSURE')`
    ),
    check(
      "volatility_targeting_snapshots_time_check",
      sql`${t.computedAt} >= ${t.asOf}`
    ),
    check(
      "volatility_targeting_snapshots_multiplier_check",
      sql`${t.appliedMultiplier} > 0 AND ${t.appliedMultiplier} <= 1`
    ),
    check(
      "volatility_targeting_snapshots_raw_multiplier_check",
      sql`${t.rawMultiplier} IS NULL OR ${t.rawMultiplier} > 0`
    ),
    check(
      "volatility_targeting_snapshots_prev_multiplier_check",
      sql`${t.prevMultiplier} > 0 AND ${t.prevMultiplier} <= 1`
    ),
    check(
      "volatility_targeting_snapshots_coverage_check",
      sql`${t.coverage} >= 0 AND ${t.coverage} <= 1`
    ),
    check(
      "volatility_targeting_snapshots_observations_check",
      sql`${t.observations} >= 0`
    ),
    check(
      "volatility_targeting_snapshots_regularization_check",
      sql`${t.regularization} IN ('none','ridge','skipped')`
    ),
    check(
      "volatility_targeting_snapshots_snapshot_id_check",
      sql`${t.snapshotId} ~ '^vt1:[0-9a-f]{64}$'`
    ),
    check(
      "volatility_targeting_snapshots_config_hash_check",
      sql`${t.configHash} ~ '^cfg1:[0-9a-f]{64}$'`
    ),
    check(
      "volatility_targeting_snapshots_data_hash_check",
      sql`${t.dataHash} ~ '^data1:[0-9a-f]{64}$'`
    ),
  ]
);

// ─────────────────────────────────────────────────────────────────────────────
// Hysteretisches Drawdown-Risk-Scaling (RMA-P5-04, v1.68.0) — append-only
//
// Eine Tabelle, ausschließlich additiv (Migration
// `drizzle/2026-09-22_drawdown_scaling.sql`):
//
//   drawdown_scaling_snapshots  EINE Zeile je Bewertung der Drawdown-Policy
//                               (Equity-Beobachtung + High-Water-Mark +
//                               Drawdown + Faktor + Stufe + Hysterese-Zustand),
//                               append-only und idempotent.
//
// Zeitsemantik (drei getrennte Zeitachsen — kein Look-ahead):
//   equity_available_at = Verfügbarkeitszeit der Equity (Snapshot-Zeit `ts`);
//                         nie in der Zukunft (Policy-Guard FUTURE_EQUITY).
//   as_of               = Entscheidungszeitpunkt (Monitor-Tick).
//   computed_at         = Berechnungszeit, immer ≥ as_of (CHECK).
//
// Zustands-Projektion (Neustart-Rekonstruktion): `last_equity`,
// `last_observation_at`, `last_trading_pnl`, `last_degrade_at`,
// `last_transition_at`, `recovery_streak` tragen den Policy-Zustand NACH
// dieser Bewertung — auch wenn die Beobachtung selbst fail-closed war. Aus der
// jüngsten Zeile rekonstruiert der Prozess nach einem Neustart denselben
// High-Water-Mark und denselben Faktor (kein Reset durch Deployment).
//
// Fail-closed: `drawdown_pct`/`target_factor` sind NULL, wenn keine gültige
// Messung möglich war (unbekannt ≠ 0); `applied_factor` ist IMMER endlich und
// in (0, 1] (CHECK-Constraint) — der Faktor kann das Basis-Risikobudget nie
// überschreiten.
// ─────────────────────────────────────────────────────────────────────────────

export const drawdownScalingSnapshots = pgTable(
  "drawdown_scaling_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** `dsc1:<sha256>` — deterministischer Idempotency-Key (Retry ⇒ No-Op). */
    snapshotId: text("snapshot_id").notNull(),
    /** Betriebsmodus: `monitor` (keine Größenänderung) | `active`. */
    mode: text("mode").notNull(),
    /** `BOOTSTRAP` (erste Bewertung) | `OK` | `CONSERVATIVE` (fail-closed). */
    status: text("status").notNull(),
    /** Geschlossener Reason-Code (bounded, z. B. `OK`, `STALE_EQUITY`). */
    reasonCode: text("reason_code").notNull(),
    /** Menschenlesbare Begründung (Audit/Status). */
    reason: text("reason").notNull(),
    /** Entscheidungszeitpunkt (timestamptz). */
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    /** Berechnungszeit (timestamptz), immer ≥ as_of. */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    /** Verfügbarkeitszeit der Equity (timestamptz) — NULL wenn nicht beobachtbar. */
    equityAvailableAt: timestamp("equity_available_at", { withTimezone: true }),
    /** Beobachtete Equity (Kontowährung) — NULL wenn nicht beobachtbar. */
    equity: numeric("equity"),
    /** Cashflow-bereinigte Equity (`equity − cumulative_net_flow`). */
    adjustedEquity: numeric("adjusted_equity"),
    /** Cashflow-bereinigter High-Water-Mark (nie fallend, neustartfest). */
    hwm: numeric("hwm"),
    /** Drawdown ∈ [0, 1] — NULL wenn nicht messbar (unbekannt ≠ 0). */
    drawdownPct: numeric("drawdown_pct"),
    /** Kurvenwert (Ziel-Faktor ∈ [0, 1]) — NULL wenn nicht berechenbar. */
    targetFactor: numeric("target_factor"),
    /** Vorheriger Faktor ∈ (0, 1]. */
    prevFactor: numeric("prev_factor").notNull(),
    /** Angewendeter Faktor ∈ (0, 1] — IMMER endlich (fail-closed). */
    appliedFactor: numeric("applied_factor").notNull(),
    /** Stufe: NORMAL | SOFT | DEEP | PAUSE. */
    stage: text("stage").notNull(),
    /** true = neue Einstiege blockiert (nur PAUSE-Stufe). */
    paused: boolean("paused").notNull(),
    /** Transition: NONE | DEGRADE | RECOVER | BOOTSTRAP. */
    transition: text("transition").notNull(),
    /** Stufe der Vorbewertung (NULL = Bootstrap). */
    prevStage: text("prev_stage"),
    /** Policyversion `ddp1:<sha256>` — Policyänderung ⇒ neue Version. */
    policyVersion: text("policy_version").notNull(),
    /** Daten-Hash `dd1:<sha256>` (Reproduzierbarkeit/Idempotenz). */
    dataHash: text("data_hash").notNull(),
    /** Kumulierte erkannte Netto-Externcashflows (+ = Einzahlung). */
    cumulativeNetFlow: numeric("cumulative_net_flow").notNull(),
    /** In dieser Bewertung erkannter Cashflow (Residuum). */
    cashflowDetected: numeric("cashflow_detected").notNull(),
    /** `verified` | `unverified` (ohne verifizierte Attribution keine Neutralisierung). */
    cashflowVerification: text("cashflow_verification").notNull(),
    /** Zeitpunkt des Reconciliation-Reports (NULL = keiner). */
    reconciliationAt: timestamp("reconciliation_at", { withTimezone: true }),
    /** true = letzter Reconciliation-Lauf ohne kritische Diskrepanz. */
    reconciliationClean: boolean("reconciliation_clean"),
    /** Alter des Reconciliation-Reports (ms) zum Berechnungszeitpunkt. */
    reconciliationAgeMs: numeric("reconciliation_age_ms"),
    /** Herkunft der Equity (Code-Konstante, z. B. `db-snapshot:TICK`). */
    equitySource: text("equity_source"),
    /** Alter der Equity (ms) zum Berechnungszeitpunkt. */
    equityAgeMs: numeric("equity_age_ms"),
    /** Equity der letzten gültigen Bewertung (Cashflow-Residuen-Basis). */
    lastEquity: numeric("last_equity"),
    /** Zeitpunkt der letzten gültigen Bewertung (Residuen-Frische). */
    lastObservationAt: timestamp("last_observation_at", { withTimezone: true }),
    /** Trading-PnL (realized+unrealized) der letzten Bewertung — NULL = unattributierbar. */
    lastTradingPnl: numeric("last_trading_pnl"),
    /** Zeitpunkt der letzten Degradation (Cooldown-Basis). */
    lastDegradeAt: timestamp("last_degrade_at", { withTimezone: true }),
    /** Zeitpunkt der letzten Faktor-/Stufentransition. */
    lastTransitionAt: timestamp("last_transition_at", { withTimezone: true }),
    /** Aufeinanderfolgende bestätigte Erholungsbewertungen. */
    recoveryStreak: integer("recovery_streak").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("drawdown_scaling_snapshots_id_unique").on(t.snapshotId),
    index("drawdown_scaling_snapshots_asof_idx").on(t.asOf),
    index("drawdown_scaling_snapshots_status_idx").on(t.status),
    index("drawdown_scaling_snapshots_stage_idx").on(t.stage),
    index("drawdown_scaling_snapshots_policy_idx").on(t.policyVersion),
    check("drawdown_scaling_snapshots_mode_check", sql`${t.mode} IN ('monitor','active')`),
    check(
      "drawdown_scaling_snapshots_status_check",
      sql`${t.status} IN ('BOOTSTRAP','OK','CONSERVATIVE')`
    ),
    check(
      "drawdown_scaling_snapshots_stage_check",
      sql`${t.stage} IN ('NORMAL','SOFT','DEEP','PAUSE')`
    ),
    check(
      "drawdown_scaling_snapshots_prev_stage_check",
      sql`${t.prevStage} IS NULL OR ${t.prevStage} IN ('NORMAL','SOFT','DEEP','PAUSE')`
    ),
    check(
      "drawdown_scaling_snapshots_transition_check",
      sql`${t.transition} IN ('NONE','DEGRADE','RECOVER','BOOTSTRAP')`
    ),
    check(
      "drawdown_scaling_snapshots_cashflow_verification_check",
      sql`${t.cashflowVerification} IN ('verified','unverified')`
    ),
    check("drawdown_scaling_snapshots_time_check", sql`${t.computedAt} >= ${t.asOf}`),
    check(
      "drawdown_scaling_snapshots_applied_factor_check",
      sql`${t.appliedFactor} > 0 AND ${t.appliedFactor} <= 1`
    ),
    check(
      "drawdown_scaling_snapshots_prev_factor_check",
      sql`${t.prevFactor} > 0 AND ${t.prevFactor} <= 1`
    ),
    check(
      "drawdown_scaling_snapshots_target_factor_check",
      sql`${t.targetFactor} IS NULL OR (${t.targetFactor} >= 0 AND ${t.targetFactor} <= 1)`
    ),
    check(
      "drawdown_scaling_snapshots_drawdown_check",
      sql`${t.drawdownPct} IS NULL OR (${t.drawdownPct} >= 0 AND ${t.drawdownPct} <= 1)`
    ),
    check(
      "drawdown_scaling_snapshots_pause_stage_check",
      sql`${t.paused} = (${t.stage} = 'PAUSE')`
    ),
    check("drawdown_scaling_snapshots_recovery_streak_check", sql`${t.recoveryStreak} >= 0`),
    check(
      "drawdown_scaling_snapshots_snapshot_id_check",
      sql`${t.snapshotId} ~ '^dsc1:[0-9a-f]{64}$'`
    ),
    check(
      "drawdown_scaling_snapshots_policy_version_check",
      sql`${t.policyVersion} ~ '^ddp1:[0-9a-f]{64}$'`
    ),
    check("drawdown_scaling_snapshots_data_hash_check", sql`${t.dataHash} ~ '^dd1:[0-9a-f]{64}$'`),
  ]
);

/**
 * Signal-Decay-Ereignisse (RMA-P5-05, v1.69.0).
 *
 * Append-only Nachweis jeder gezählten Beobachtung (Idempotenz über
 * `event_id` = `sde1:<sha256>` aus Position, Observation-Key und
 * Policyversion). Monitor-only-Counterfactuals und echte Exits teilen die
 * Tabelle. Keine Instrument-IDs als Metrik-Label — die Tabelle ist die
 * Audit-Quelle, Metriken bleiben auf geschlossene Reason-Codes beschränkt.
 *
 * Zeitsemantik: `as_of` = Entscheidungszeit, `available_at` /
 * `calculated_as_of` = Signalzeiten (nie nach `as_of`), `computed_at` =
 * Schreibzeit ≥ `as_of`. Migration: `drizzle/2026-09-22_signal_decay.sql`.
 */
export const signalDecayEvents = pgTable(
  "signal_decay_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: text("event_id").notNull(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id),
    strategyClass: text("strategy_class").notNull(),
    mode: text("mode").notNull(),
    outcome: text("outcome").notNull(),
    policyVersion: text("policy_version").notNull(),
    policyReason: text("policy_reason").notNull(),
    entryStrength: numeric("entry_strength"),
    currentStrength: numeric("current_strength"),
    entryConfidence: numeric("entry_confidence"),
    currentConfidence: numeric("current_confidence"),
    entryDirection: text("entry_direction"),
    currentDirection: text("current_direction"),
    coverage: numeric("coverage"),
    semanticsVersion: text("semantics_version"),
    featureVersion: text("feature_version"),
    modelVersion: text("model_version"),
    configVersion: text("config_version"),
    migrationId: text("migration_id"),
    confirmStreak: integer("confirm_streak").notNull(),
    confirmationRequired: integer("confirmation_required").notNull(),
    counterfactualPnl: numeric("counterfactual_pnl"),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }),
    calculatedAsOf: timestamp("calculated_as_of", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    entrySignalHash: text("entry_signal_hash"),
    observationKey: text("observation_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("signal_decay_events_event_id_unique").on(t.eventId),
    index("signal_decay_events_position_asof_idx").on(t.positionId, t.asOf),
    index("signal_decay_events_outcome_asof_idx").on(t.outcome, t.asOf),
    check("signal_decay_events_mode_check", sql`${t.mode} IN ('monitor', 'active')`),
    check(
      "signal_decay_events_outcome_check",
      sql`${t.outcome} IN ('MISSING_ENTRY', 'MISSING_CURRENT', 'STALE', 'INCOMPATIBLE', 'INVALID', 'FUTURE', 'LOW_COVERAGE', 'MIN_HOLD', 'HOLD', 'CONFIRMING', 'WOULD_EXIT', 'EXIT', 'SUPPRESSED_KILL_SWITCH')`,
    ),
    check(
      "signal_decay_events_class_check",
      sql`${t.strategyClass} IN ('mean-reversion', 'trend', 'breakout', 'unclassified')`,
    ),
    check("signal_decay_events_streak_check", sql`${t.confirmStreak} >= 0 AND ${t.confirmationRequired} >= 1`),
    check(
      "signal_decay_events_coverage_check",
      sql`${t.coverage} IS NULL OR (${t.coverage} >= 0 AND ${t.coverage} <= 1)`,
    ),
    check(
      "signal_decay_events_strength_check",
      sql`(${t.entryStrength} IS NULL OR (${t.entryStrength} >= 0 AND ${t.entryStrength} <= 1)) AND (${t.currentStrength} IS NULL OR (${t.currentStrength} >= 0 AND ${t.currentStrength} <= 1)) AND (${t.entryConfidence} IS NULL OR (${t.entryConfidence} >= 0 AND ${t.entryConfidence} <= 1)) AND (${t.currentConfidence} IS NULL OR (${t.currentConfidence} >= 0 AND ${t.currentConfidence} <= 1))`,
    ),
    check("signal_decay_events_time_check", sql`${t.computedAt} >= ${t.asOf}`),
    check(
      "signal_decay_events_available_check",
      sql`${t.availableAt} IS NULL OR ${t.availableAt} <= ${t.asOf}`,
    ),
    check(
      "signal_decay_events_calculated_check",
      sql`${t.calculatedAsOf} IS NULL OR ${t.availableAt} IS NULL OR ${t.calculatedAsOf} <= ${t.availableAt}`,
    ),
    check("signal_decay_events_event_id_check", sql`${t.eventId} ~ '^sde1:[0-9a-f]{64}$'`),
    check("signal_decay_events_policy_check", sql`${t.policyVersion} ~ '^sdp1:[0-9a-f]{64}$'`),
  ],
);
