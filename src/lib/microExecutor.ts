/**
 * MIKRO-ZYKLUS — der LLM-freie, ereignisgetriebene Ausführungspfad.
 *
 * Garantien (per Test überwacht, siehe tests/microExecutor.test.ts):
 *   - KEIN Import von `ollama`, `llmProvider`, `engine` oder `analysts` —
 *     der Ausführungspfad kann prinzipbedingt keinen LLM-Call ausführen.
 *   - Hot-Path (jeder Preis-Tick): keine DB, kein Netzwerk, kein JSON-Parse.
 *     Regelbewertung = vor-kompilierte Closure über Zahlenvergleiche
 *     (typisch < 100 µs inkl. Indikator-Rolling).
 *   - Einzige DB-Berührung: beim Match (Order ausführen + Feedback schreiben).
 *
 * Datenfluss:
 *   WebSocket-Feed (Binance @trade/@kline oder Simulator)
 *     → RollingTimeframeSeries (1m-Aggregation, REST-Seed beim Start)
 *     → RuleSnapshot (Indikatoren, ~10–100 µs)
 *     → RuleCache.match() (kompilierte ACTIVE-Regeln, Cooldown/Tageslimit im RAM)
 *     → RuleExecutionAdapter (Kill-Switch, Sperren, Guardrails, Fill, Feedback)
 */
import { db, getPool } from "@/db";
import {
  tradeRules,
  ruleExecutions,
  missions as missionsTable,
  positions as positionsTable,
  riskConfig,
} from "@/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { PaperBroker } from "./broker";
import {
  ADAPTIVE_STATE_MAX_AGE_MS,
  applyAdaptiveRisk,
  getLimits,
  killSwitch,
  validateOrder,
  missionSizedNotional,
  applyRuntimeLimits,
  riskValidationReason,
  type RiskLimits,
} from "./riskGuard";
import { getCandles, sanitizeSymbol } from "./marketData";
import { MarketDataFetchError } from "./marketDataErrors";
import { structuredLog } from "./logger";
import { writeEquitySnapshot } from "./equity";
import {
  buildSnapshotFromCandles,
  compileRuleSpec,
  isWindowOpen,
  berlinDayKeyOf,
  type CandleLike,
  type RuleSnapshot,
  type RuleSpec,
  type CompiledRule,
} from "./ruleEngine";
import { ruleAudit } from "./ruleService";
import { startOfBerlinDay } from "./time";

// ─────────────────────────────────────────────────────────────────────────────
// Basistypen
// ─────────────────────────────────────────────────────────────────────────────

export type FeedTick =
  | { kind: "trade"; symbol: string; ts: number; price: number; qty: number }
  | { kind: "candle"; symbol: string; ts: number; candle: CandleLike; closed: boolean };

export interface FeedStatus {
  name: string;
  connected: boolean;
  url: string | null;
  lastTickAt: string | null;
  ticks: number;
  errors: number;
  detail?: string;
}

export interface MarketFeed {
  readonly name: string;
  readonly urlHint: string | null;
  start(onTick: (t: FeedTick) => void): Promise<void>;
  stop(): Promise<void>;
  status(): FeedStatus;
}

export type ExecutionOutcome = {
  status: "TRIGGERED" | "BLOCKED" | "ERROR";
  ruleId: string;
  symbol: string;
  reason?: string;
  orderId?: string;
  fill?: unknown;
  totalMicros?: number;
  at: string;
};

export type ExecuteContext = {
  ruleId: string;
  name: string;
  spec: RuleSpec;
  compiled: CompiledRule;
  snapshot: RuleSnapshot;
  missionId: string | null;
  executionsToday: number;
  /** Bewertungszeit des Hot-Paths in µs (ohne DB/Fill). */
  evalMicros: number;
};

export interface RuleExecutionAdapter {
  readonly name: string;
  execute(ctx: ExecuteContext): Promise<ExecutionOutcome>;
}

// ─────────────────────────────────────────────────────────────────────────────
// RollingTimeframeSeries — Kerzenhaltung + Aggregation ohne IO
// ─────────────────────────────────────────────────────────────────────────────

const TIMEFRAME_MS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
};

/**
 * Hält eine Kerzenreihe eines Symbols für EIN Timeframe im RAM.
 * Gestartet mit REST-Historie (Seed), danach live via Trade-Ticks und
 * 1m-Kerzen-Closes fortgeschrieben. Aggregation 1m → Nm ist deterministisch.
 */
export class RollingTimeframeSeries {
  readonly symbol: string;
  readonly timeframe: string;
  private readonly bucketMs: number;
  private finalized: CandleLike[] = [];
  /** Offene 1m-Kerze (wird von Trade-Ticks berührt). */
  private open1m: CandleLike | null = null;
  /** Aggregierte, aktuell laufende Kerze. */
  private openAgg: CandleLike | null = null;

  constructor(symbol: string, timeframe: string, history: CandleLike[] = []) {
    this.symbol = symbol.toUpperCase();
    this.timeframe = timeframe;
    this.bucketMs = TIMEFRAME_MS[timeframe] ?? TIMEFRAME_MS["15m"];
    this.finalized = history.slice(-160);
  }

  bucketStart(ts: number): number {
    return Math.floor(ts / this.bucketMs) * this.bucketMs;
  }

  /** Trade-Tick: aktuellen Preis/Volumen der offenen Kerzen fortschreiben. */
  touch(price: number, ts: number, qty = 0): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const start1m = Math.floor(ts / 60_000) * 60_000;
    if (!this.open1m || this.open1m.time !== start1m) {
      this.open1m = { time: start1m, open: price, high: price, low: price, close: price, volume: qty };
    } else {
      this.open1m.high = Math.max(this.open1m.high, price);
      this.open1m.low = Math.min(this.open1m.low, price);
      this.open1m.close = price;
      this.open1m.volume += qty;
    }
    this.mergeAgg(this.open1m);
  }

  /** Finale/partielle 1m-Kerze vom Feed (z. B. Binance kline). */
  applyCandle(candle: CandleLike, closed = true): void {
    if (!closed) {
      this.open1m = { ...candle };
      this.mergeAgg(this.open1m);
      return;
    }
    if (this.open1m && this.open1m.time === candle.time) {
      this.open1m = { ...candle };
      this.replaceAggVolume(candle);
    } else {
      if (this.open1m) {
        this.pushFinal(this.open1m);
        this.openAgg = null;
      }
      this.open1m = { ...candle };
      this.mergeAgg(this.open1m);
    }
  }

  private mergeAgg(c: CandleLike): void {
    const start = this.bucketStart(c.time);
    if (!this.openAgg || this.openAgg.time !== start) {
      if (this.openAgg) this.pushFinal(this.openAgg);
      this.openAgg = { ...c, time: start };
    } else {
      this.openAgg.high = Math.max(this.openAgg.high, c.high);
      this.openAgg.low = Math.min(this.openAgg.low, c.low);
      this.openAgg.close = c.close;
      this.openAgg.volume += c.volume;
    }
  }

  private replaceAggVolume(c: CandleLike): void {
    if (!this.openAgg || !this.open1m) return;
    // openAgg enthält den (aggregierten) Vorgänger derselben 1m-Kerze; Volumen
    // austauschen statt addieren — die Kline-Angabe ist autoritativ.
    this.openAgg.high = Math.max(this.openAgg.high, c.high);
    this.openAgg.low = Math.min(this.openAgg.low, c.low);
    this.openAgg.close = c.close;
    this.openAgg.volume = this.openAgg.volume - (this.open1m.volume - c.volume);
    this.open1m = { ...c };
  }

  private pushFinal(c: CandleLike): void {
    if (!Number.isFinite(c.close) || c.close <= 0) return;
    this.finalized.push({ ...c });
    if (this.finalized.length > 160) this.finalized = this.finalized.slice(-160);
  }

  /** Aktueller Snapshot (0–1 Kerzen Genauigkeit, keine IO). */
  snapshot(volumeWindow = 20): RuleSnapshot | null {
    const buf: CandleLike[] = this.finalized.slice(-159);
    if (this.openAgg) {
      buf.push({ ...this.openAgg, time: this.openAgg.time });
    }
    if (buf.length < 25) return null;
    return buildSnapshotFromCandles(this.symbol, buf, volumeWindow);
  }

  size(): number {
    return this.finalized.length + (this.openAgg ? 1 : 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RuleCache — kompilierte ACTIVE-Regeln im RAM, Refresh per Poll/Invalidation
// ─────────────────────────────────────────────────────────────────────────────

export type CachedRule = {
  rowId: string;
  ruleKey: string;
  version: number;
  symbol: string;
  missionId: string | null;
  name: string;
  spec: RuleSpec;
  compiled: CompiledRule;
  executionsToday: number;
  firedAt: number;
  cooldownMs: number;
};

export type RuleCacheStatus = {
  loadedAt: string | null;
  activeRules: number;
  symbols: number;
  executionsToday: Record<string, number>;
};

/**
 * Liest ACTIVE-Regeln aus der DB, kompiliert sie einmalig und matcht im
 * Hot-Path rein im RAM. Aktivierungen anderer Prozesse werden über den
 * Poll-Intervall übernommen (in derselben App: zusätzlich invalidate()).
 */
export class RuleCache {
  private bySymbol = new Map<string, CachedRule[]>();
  private missions = new Map<string, string>();
  private loadedAt: number | null = null;
  private dirty = true;
  private dayKey = "";
  private ramCounts = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly refreshMs = 30_000) {}

  invalidate(): void {
    this.dirty = true;
  }

  async start(): Promise<void> {
    this.refreshTimer = setInterval(() => void this.load(), this.refreshMs);
    this.refreshTimer.unref?.();
    await this.load();
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async load(): Promise<void> {
    // Frisch genug (oder per _seedForTest injiziert) → kein DB-Zugriff im
    // Hot-Path und kein unnötiges Polling.
    if (!this.dirty && this.loadedAt && Date.now() - this.loadedAt < this.refreshMs) return;
    try {
      const rows = await db.select().from(tradeRules).where(eq(tradeRules.status, "ACTIVE"));
      const missionRows = await db
        .select({ id: missionsTable.id, status: missionsTable.status })
        .from(missionsTable);
      const dayStart = startOfBerlinDay();
      const countRows = await db
        .select({
          ruleId: ruleExecutions.ruleId,
          c: sql<number>`count(*)::int`,
        })
        .from(ruleExecutions)
        .where(and(eq(ruleExecutions.status, "TRIGGERED"), gte(ruleExecutions.createdAt, dayStart)))
        .groupBy(ruleExecutions.ruleId);

      const counts = new Map<string, number>();
      for (const r of countRows) counts.set(r.ruleId, Number(r.c));

      const active: CachedRule[] = [];
      for (const row of rows) {
        const spec: RuleSpec = {
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
        active.push({
          rowId: row.id,
          ruleKey: row.ruleKey,
          version: row.version,
          symbol: row.symbol,
          missionId: row.missionId,
          name: row.name,
          spec,
          compiled: compileRuleSpec(spec),
          executionsToday: counts.get(row.id) ?? 0,
          firedAt: 0,
          cooldownMs: spec.window.cooldownMinutes * 60_000,
        });
      }

      this.bySymbol.clear();
      this.missions.clear();
      for (const m of missionRows) this.missions.set(m.id, m.status);
      for (const r of active) {
        const list = this.bySymbol.get(r.symbol) ?? [];
        list.push(r);
        this.bySymbol.set(r.symbol, list);
      }
      this.loadedAt = Date.now();
      this.dirty = false;
      const day = berlinDayKeyOf(Date.now());
      if (this.dayKey !== day) {
        this.dayKey = day;
        this.ramCounts.clear();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.split("\n")[0] || e.message : String(e);
      console.warn(
        "[micro] RuleCache-Load fehlgeschlagen (alte Regeln bleiben im RAM):",
        msg.slice(0, 160)
      );
    }
  }

  /** Kompilierte Regeln eines Symbols (ohne Auswertung). */
  candidatesBySymbol(symbol: string): CachedRule[] {
    return this.bySymbol.get(symbol.toUpperCase()) ?? [];
  }

  /** Alle kompilierten Regeln (für Series-Aufbau beim Start). */
  allRules(): CachedRule[] {
    return [...this.bySymbol.values()].flat();
  }

  /**
   * Test-/Injections-Hook: Regeln direkt in den RAM-Cache setzen, ohne DB.
   * Wird von den Unit-Tests genutzt (Hot-Path-Logik ohne PostgreSQL) und
   * dokumentiert zugleich, dass der Cache nur die DB als Quelle braucht.
   */
  _seedForTest(rules: CachedRule[], missionStatus: [string, string][] = []): void {
    this.bySymbol.clear();
    this.missions.clear();
    for (const [id, status] of missionStatus) this.missions.set(id, status);
    for (const r of rules) {
      const list = this.bySymbol.get(r.symbol) ?? [];
      list.push(r);
      this.bySymbol.set(r.symbol, list);
    }
    this.loadedAt = Date.now();
    this.dirty = false;
    this.dayKey = berlinDayKeyOf(Date.now());
  }

  /**
   * Auswertung gegen einen Snapshot: nur Regeln, deren Fenster offen ist,
   * deren Tages-/Cooldown-Limits noch nicht erschöpft sind UND deren
   * Bedingung im Snapshot wahr ist. Rein im RAM, kein IO.
   *
   * `timeframe` filtert auf exakt dieses Aggregations-Level — sonst würde
   * eine 5m-Regel auch gegen den 15m-Snapshot (und umgekehrt) geprüft.
   */
  match(snap: RuleSnapshot, now = Date.now(), timeframe?: string): CachedRule[] {
    const day = berlinDayKeyOf(now);
    if (this.dayKey !== day) {
      this.dayKey = day;
      this.ramCounts.clear();
    }
    const out: CachedRule[] = [];
    for (const rule of this.bySymbol.get(snap.symbol) ?? []) {
      if (timeframe && rule.spec.window.timeframe !== timeframe) continue;
      if (rule.missionId && this.missions.get(rule.missionId) === "KILLED") continue;
      const firedToday = rule.executionsToday + (this.ramCounts.get(rule.rowId) ?? 0);
      if (firedToday >= rule.spec.window.maxExecutionsPerDay) continue;
      if (rule.firedAt > 0 && now - rule.firedAt < rule.cooldownMs) continue;
      if (!isWindowOpen(rule.spec, now)) continue;
      if (rule.compiled.evaluate(snap)) out.push(rule);
    }
    return out;
  }

  noteFired(ruleId: string): void {
    const rule = [...this.bySymbol.values()].flat().find((r) => r.rowId === ruleId);
    if (rule) rule.firedAt = Date.now();
    // RAM-Zähler separat vom DB-Stand (kein Doppelzählen): firedToday =
    // executionsToday (DB, beim Load) + ramCounts (seit Load, reset pro Tag).
    this.ramCounts.set(ruleId, (this.ramCounts.get(ruleId) ?? 0) + 1);
  }

  status(): RuleCacheStatus {
    const executionsToday: Record<string, number> = {};
    for (const list of this.bySymbol.values()) {
      for (const r of list) executionsToday[r.rowId] = r.executionsToday;
    }
    return {
      loadedAt: this.loadedAt ? new Date(this.loadedAt).toISOString() : null,
      activeRules: [...this.bySymbol.values()].reduce((a, l) => a + l.length, 0),
      symbols: this.bySymbol.size,
      executionsToday,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paper-Adapter — Ausführung mit DB-Wahrheit + Advisory-Lock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Führt einen Regel-Match über den PaperBroker aus. Der Broker wird vor JEDER
 * Ausführung aus der DB re-hydriert (Single Source of Truth), und der gesamte
 * Check-Fill-Block läuft unter einem Postgres-Advisory-Lock pro Symbol —
 * damit können mehrere Executor-Instanzen einen Trade für dasselbe Symbol
 * nie doppelt eröffnen (Multi-Instanz-Skalierung, siehe ARCHITECTURE.md).
 */
/**
 * Lädt die Laufzeit-Limits (risk_config) in den Prozess — lokal implementiert,
 * KEIN Import von riskConfigService/engine (sonst zöge der Mikro-Prozess
 * LLM-Code). Fehlende DB → Code-Defaults bleiben (Fail-safe).
 */
async function ensureRuntimeLimitsLoaded(): Promise<void> {
  const G = globalThis as typeof globalThis & { __microLimitsLoadedAt?: number };
  if (G.__microLimitsLoadedAt && Date.now() - G.__microLimitsLoadedAt < 60_000) return;
  try {
    const rows = await db.select().from(riskConfig);
    const raw: Record<string, number> = {};
    let activeFactor: number | null = null;
    let activeAtMs: number | null = null;
    for (const r of rows) {
      const n = Number(r.value);
      if (!Number.isFinite(n)) continue;
      if (r.key === "adp.activeFactor") activeFactor = n;
      else if (r.key === "adp.activeAt") activeAtMs = n * 1000;
      else raw[r.key] = n;
    }
    applyRuntimeLimits(raw as Partial<RiskLimits>);

    // Adaptives Risk-Limit (v1.7.0): Der Main-Prozess persistiert den aktiven
    // Volatilitäts-Faktor (adp.activeFactor / adp.activeAt). Ist er frisch,
    // übernimmt der Mikro-Prozess die Reduktion, ohne selbst Märkte abfragen
    // zu müssen (LLM- und netzwerk-freier Pfad bleibt erhalten). Abgelaufen
    // (ADAPTIVE_STATE_MAX_AGE_MS) → Basis-Limit, kein uralter Faktor.
    if (activeFactor != null && activeAtMs != null && activeFactor > 0 && activeFactor < 1) {
      if (Date.now() - activeAtMs < ADAPTIVE_STATE_MAX_AGE_MS) {
        applyAdaptiveRisk({
          regime: "PERSISTED",
          factor: activeFactor,
          reason: "persistierter Faktor des Main-Prozesses (Volatilitäts-Engine)",
          at: new Date(activeAtMs).toISOString(),
          indicators: {},
        });
      } else {
        applyAdaptiveRisk(null);
      }
    }
    G.__microLimitsLoadedAt = Date.now();
  } catch {
    /* DB nicht bereit → Code-Defaults bleiben wirksam */
  }
}

export function createPaperRuleAdapter(opts?: {
  onFired?: (ruleId: string) => void;
}): RuleExecutionAdapter {
  const broker = new PaperBroker(Number(process.env.STARTING_EQUITY || 10_000));
  const startedProcess = Date.now();

  return {
    name: "PAPER_RULE",
    async execute(ctx): Promise<ExecutionOutcome> {
      const started = Date.now();
      const symbol = sanitizeSymbol(ctx.spec.symbol);
      if (!symbol) {
        return {
          status: "ERROR",
          ruleId: ctx.ruleId,
          symbol: ctx.spec.symbol,
          reason: "INVALID_SYMBOL",
          at: new Date().toISOString(),
        };
      }

      // Schneller, in-process Vorab-Check (kein DB-Zugriff).
      if (killSwitch.isArmed()) {
        return {
          status: "BLOCKED",
          ruleId: ctx.ruleId,
          symbol,
          reason: "KILL_SWITCH_ARMED",
          at: new Date().toISOString(),
        };
      }

      await ensureRuntimeLimitsLoaded();
      const client = await getPool().connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtext($1))", ["rule:" + symbol]);

        // Frische Wahrheit aus der DB (nicht aus dem RAM des Prozesses).
        const ks = await client.query<{ armed: boolean }>(
          "SELECT armed FROM kill_switches ORDER BY created_at DESC LIMIT 1"
        );
        if (ks.rows[0]?.armed) {
          if (!killSwitch.isArmed()) killSwitch.pull("restored:rule-executor");
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: "KILL_SWITCH_ARMED",
            at: new Date().toISOString(),
          };
        }

        const open = await client.query<{ id: string }>(
          "SELECT id FROM positions WHERE symbol = $1 AND status = 'OPEN' LIMIT 1",
          [symbol]
        );
        if (open.rows.length > 0) {
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: `POSITION_ALREADY_OPEN:${symbol}`,
            at: new Date().toISOString(),
          };
        }

        if (ctx.missionId) {
          const mission = await client.query<{ status: string }>(
            "SELECT status FROM missions WHERE id = $1",
            [ctx.missionId]
          );
          if (mission.rows[0]?.status === "KILLED") {
            return {
              status: "BLOCKED",
              ruleId: ctx.ruleId,
              symbol,
              reason: "MISSION_KILLED",
              at: new Date().toISOString(),
            };
          }
        }

        // Broker aus der DB re-hydrieren (Positionen + Cash-Hinweis).
        const posRows = await client.query<{
          symbol: string;
          side: string;
          qty: string;
          entry_price: string;
          stop_loss: string | null;
          take_profit: string | null;
        }>("SELECT symbol, side, qty, entry_price, stop_loss, take_profit FROM positions WHERE status = 'OPEN'");
        const cashRows = await client.query<{ cash: string }>(
          "SELECT cash FROM equity_snapshots ORDER BY ts DESC LIMIT 1"
        );
        const cashHint = Number(cashRows.rows[0]?.cash);
        broker.hydrate(
          posRows.rows.map((r) => ({
            symbol: r.symbol,
            side: r.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const),
            qty: Number(r.qty),
            entryPrice: Number(r.entry_price),
            stopLoss: r.stop_loss != null ? Number(r.stop_loss) : null,
            takeProfit: r.take_profit != null ? Number(r.take_profit) : null,
          })),
          { cashHint: Number.isFinite(cashHint) && cashHint >= 0 ? cashHint : undefined }
        );

        const equity = broker.accountEquity;
        const limits = getLimits();
        const stopPct = Math.min(ctx.spec.action.stopLossPct / 100, limits.defaultStopLossPct);
        const notional = missionSizedNotional(
          equity,
          stopPct,
          Math.min(ctx.spec.action.riskBudgetPct, limits.maxRiskPerTrade),
          ctx.spec.action.maxPositionPct,
          limits.maxPositionPct
        );
        const price = broker.quote(symbol);
        if (price === null || price <= 0) {
          return {
            status: "ERROR",
            ruleId: ctx.ruleId,
            symbol,
            reason: "NO_QUOTE",
            at: new Date().toISOString(),
          };
        }
        const qty = Number((notional / price).toFixed(6));
        const stopLoss = Number((price * (1 - stopPct)).toFixed(price > 100 ? 2 : 6));
        const tpDist = stopPct * Math.min(ctx.spec.action.takeProfitRR, limits.takeProfitRR);
        const takeProfit = Number((price * (1 + tpDist)).toFixed(price > 100 ? 2 : 6));

        // H9: validateOrder wirft bei NaN/Infinity/≤0 fail-closed
        // (RiskValidationError) — der Mikro-Executor übersetzt das in einen
        // BLOCKED-Result (INVALID_EQUITY etc.), bevor der Broker berührt wird.
        let guard;
        try {
          guard = validateOrder({
            notional,
            equity,
            openPositions: broker.openPositions,
            side: "LONG",
            leverage: 1,
            hasStopLoss: true,
            symbol,
          });
        } catch (e) {
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: `GUARDRAIL:${riskValidationReason(e)}`,
            at: new Date().toISOString(),
          };
        }
        if (!guard.allowed) {
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: `GUARDRAIL:${guard.reason}`,
            at: new Date().toISOString(),
          };
        }

        const fill = broker.submit({
          symbol,
          side: "LONG",
          qty,
          riskNotional: notional,
          stopLoss,
          takeProfit,
        });
        // H3: Position nur buchen bei echtem Fill mit belegtem Preis (>0).
        // NEW/REJECTED/UNKNOWN oder ein 0-Entry blockieren die Order.
        if (fill.status !== "FILLED" || !Number.isFinite(fill.fillPrice) || fill.fillPrice <= 0) {
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: `BROKER:${fill.reason ?? fill.status ?? "rejected"}`,
            at: new Date().toISOString(),
          };
        }

        await db.insert(positionsTable).values({
          symbol: fill.symbol,
          side: fill.side,
          qty: String(fill.qty),
          entryPrice: String(fill.fillPrice),
          currentPrice: String(fill.fillPrice),
          stopLoss: fill.stopLoss === null ? null : String(fill.stopLoss),
          takeProfit: fill.takeProfit === null ? null : String(fill.takeProfit),
          broker: broker.name,
          missionId: ctx.missionId,
          ruleId: ctx.ruleId,
          status: "OPEN",
        });

        if (ctx.missionId) {
          await db
            .update(missionsTable)
            .set({ status: "ACTIVE", updatedAt: new Date() })
            .where(eq(missionsTable.id, ctx.missionId));
        }
        try {
          await writeEquitySnapshot(broker.accountEquity, broker.freeCash, broker.openPositions, "TRADE");
        } catch {
          /* Kurvenpunkt optional */
        }

        const totalMicros = Math.round((Date.now() - started) * 1000);
        const evalMicros = Math.min(ctx.evalMicros, totalMicros);
        await db.insert(ruleExecutions).values({
          ruleId: ctx.ruleId,
          missionId: ctx.missionId,
          symbol,
          status: "TRIGGERED",
          triggerPrice: String(ctx.snapshot.price),
          triggerVolume: String(ctx.snapshot.volume),
          snapshot: ctx.snapshot as unknown as object,
          evaluated: { conditions: ctx.spec.condition },
          fill: fill as unknown as object,
          orderId: fill.orderId,
          latencyMicros: evalMicros,
        });
        await ruleAudit(
          "RULE_TRIGGERED",
          "INFO",
          {
            ruleId: ctx.ruleId,
            symbol,
            version: ctx.compiled ? 1 : 1,
            price: ctx.snapshot.price,
            orderId: fill.orderId,
            evalMicros,
            startedProcess,
          },
          ctx.missionId
        );
        opts?.onFired?.(ctx.ruleId);
        return {
          status: "TRIGGERED",
          ruleId: ctx.ruleId,
          symbol,
          orderId: fill.orderId,
          fill,
          totalMicros,
          at: new Date().toISOString(),
        };
      } catch (e) {
        console.error("[micro] Ausführung fehlgeschlagen:", e instanceof Error ? e.message : e);
        return {
          status: "ERROR",
          ruleId: ctx.ruleId,
          symbol,
          reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
          at: new Date().toISOString(),
        };
      } finally {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["rule:" + symbol]);
        } catch {
          /* Lock-Aufräumen ist best effort */
        }
        client.release();
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MicroExecutor — Orchestrierung des Hot-Paths
// ─────────────────────────────────────────────────────────────────────────────

export type MicroExecutorOptions = {
  refreshMs?: number;
  seedCandles?: boolean;
};

export type MicroStatus = {
  running: boolean;
  startedAt: string | null;
  feed: FeedStatus | null;
  cache: RuleCacheStatus;
  ticksProcessed: number;
  evaluations: number;
  matches: number;
  executions: number;
  blocked: number;
  errors: number;
  lastEvalMicros: number | null;
  avgEvalMicros: number | null;
  p95EvalMicros: number | null;
  series: { symbol: string; timeframe: string; candles: number }[];
  lastError: string | null;
  /** Warmstart (REST-Historie): Fehler sind sichtbar, nicht still verschluckt (MDERR-006). */
  seed: { requested: number; failed: number; lastError: string | null };
};

export class MicroExecutor {
  private readonly cache: RuleCache;
  private readonly adapter: RuleExecutionAdapter;
  private feeds: MarketFeed[] = [];
  private series = new Map<string, RollingTimeframeSeries>();
  private running = false;
  private ticks = 0;
  private evalCount = 0;
  private matchCount = 0;
  private execCount = 0;
  private blockedCount = 0;
  private errorCount = 0;
  private evalSamples: number[] = [];
  private lastError: string | null = null;
  private startedAt: number | null = null;
  private seedRequested = 0;
  private seedFailed = 0;
  private seedLastError: string | null = null;
  private readonly options: MicroExecutorOptions;

  constructor(opts?: {
    cache?: RuleCache;
    adapter?: RuleExecutionAdapter;
    options?: MicroExecutorOptions;
  }) {
    this.cache = opts?.cache ?? new RuleCache();
    this.adapter =
      opts?.adapter ?? createPaperRuleAdapter({ onFired: (id) => this.cache.noteFired(id) });
    this.options = opts?.options ?? {};
  }

  registerFeed(feed: MarketFeed): void {
    this.feeds.push(feed);
  }

  addSymbol(symbolRaw: string, timeframe: string, history: CandleLike[] = []): void {
    const symbol = sanitizeSymbol(symbolRaw);
    if (!symbol) return;
    const key = `${symbol}:${timeframe}`;
    if (!this.series.has(key)) {
      this.series.set(key, new RollingTimeframeSeries(symbol, timeframe, history));
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    await this.cache.load();

    // Für JEDE aktive Regel eine Rolling-Serie ihres Timeframes sicherstellen
    // (auch 30m/1h — nicht nur die Standard-Timeframes).
    for (const rule of this.cache.allRules()) {
      this.addSymbol(rule.symbol, rule.spec.window.timeframe);
    }

    // Seed: Historie pro (Symbol, Timeframe) aus dem REST-Cache holen, damit
    // die Indikatoren sofort warm sind (kein 25-Kerzen-Kaltstart).
    if (this.options.seedCandles !== false) {
      for (const [key, series] of this.series) {
        if (series.size() > 0) continue;
        const [symbol, timeframe] = key.split(":");
        this.seedRequested++;
        try {
          const candles = await getCandles(symbol, timeframe, 150);
          // WICHTIG (MDERR-006): Ein leeres Array ist keine Fehlermeldung —
          // die Venue hat nachweislich keine Bars geliefert. Ein
          // MarketDataFetchError dagegen ist ein echter Infrastrukturfehler
          // und wird unten protokolliert/gezählt — er darf nicht als
          // „offline, alles ok“ verschwinden. Live-Kerzen wärmen die Serie
          // trotzdem weiter auf, aber der Fehler bleibt beobachtbar.
          if (candles.length > 0) {
            this.series.set(
              key,
              new RollingTimeframeSeries(symbol, timeframe, candles)
            );
          }
        } catch (err) {
          this.seedFailed++;
          const reason = err instanceof MarketDataFetchError ? err.reason : "UNKNOWN";
          this.seedLastError =
            err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
          structuredLog("error", "micro_executor_seed_fetch_failed", {
            symbol,
            timeframe,
            reason,
            retryable: err instanceof MarketDataFetchError ? err.retryable : false,
            httpStatus: err instanceof MarketDataFetchError ? (err.httpStatus ?? null) : null,
          });
        }
      }
    }

    await this.cache.start();
    for (const feed of this.feeds) {
      await feed.start((tick) => this.handleTick(tick));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.cache.stop();
    for (const feed of this.feeds) await feed.stop();
  }

  private handleTick(tick: FeedTick): void {
    if (!this.running) return;
    this.ticks++;
    const symbol = sanitizeSymbol(tick.symbol);
    if (!symbol) return;

    // Keine Regel für dieses Symbol geladen → Zero-Cost-Tick.
    if (this.cache.candidatesBySymbol(symbol).length === 0) return;

    for (const [key, series] of this.series) {
      const [sym, timeframe] = key.split(":");
      if (sym !== symbol) continue;
      if (tick.kind === "trade") series.touch(tick.price, tick.ts, tick.qty);
      else series.applyCandle(tick.candle, tick.closed);

      const snap = series.snapshot();
      if (!snap) continue; // noch nicht genug Historie → weiter wärmen

      const t0 = performance.now();
      const matched = this.cache.match(snap, Date.now(), timeframe);
      const evalMicros = Math.max(1, Math.round((performance.now() - t0) * 1000));
      this.evalCount++;
      this.evalSamples.push(evalMicros);
      if (this.evalSamples.length > 1000) this.evalSamples = this.evalSamples.slice(-1000);

      for (const rule of matched) {
        this.matchCount++;
        void this.adapter
          .execute({
            ruleId: rule.rowId,
            name: rule.name,
            spec: rule.spec,
            compiled: rule.compiled,
            snapshot: snap,
            missionId: rule.missionId,
            executionsToday: rule.executionsToday,
            evalMicros,
          })
          .then((outcome) => {
            if (outcome.status === "TRIGGERED") this.execCount++;
            else if (outcome.status === "BLOCKED") this.blockedCount++;
            else this.errorCount++;
            if (outcome.status !== "TRIGGERED") {
              this.lastError = outcome.reason ?? null;
              console.warn(`[micro] ${outcome.status} ${rule.name}: ${outcome.reason ?? ""}`);
            }
          })
          .catch((e) => {
            this.errorCount++;
            this.lastError = e instanceof Error ? e.message : String(e);
          });
      }
    }
  }

  status(): MicroStatus {
    const samples = [...this.evalSamples].sort((a, b) => a - b);
    const avg = samples.length
      ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
      : null;
    const p95 = samples.length
      ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]
      : null;
    return {
      running: this.running,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      feed: this.feeds[0]?.status() ?? null,
      cache: this.cache.status(),
      ticksProcessed: this.ticks,
      evaluations: this.evalCount,
      matches: this.matchCount,
      executions: this.execCount,
      blocked: this.blockedCount,
      errors: this.errorCount,
      lastEvalMicros: this.evalSamples.length
        ? this.evalSamples[this.evalSamples.length - 1]
        : null,
      avgEvalMicros: avg,
      p95EvalMicros: p95,
      series: [...this.series.values()].map((s) => ({
        symbol: s.symbol,
        timeframe: s.timeframe,
        candles: s.size(),
      })),
      lastError: this.lastError,
      seed: {
        requested: this.seedRequested,
        failed: this.seedFailed,
        lastError: this.seedLastError,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Feeds
// ─────────────────────────────────────────────────────────────────────────────

type WsLike = {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: (() => void) | null;
  close(): void;
};

async function openWebSocket(url: string): Promise<WsLike> {
  const g = globalThis as unknown as { WebSocket?: new (u: string) => WsLike };
  if (typeof g.WebSocket === "function") return new g.WebSocket(url);
  try {
    const mod = (await import("ws")) as unknown as { default?: new (u: string) => WsLike };
    const Ws = mod.default ?? (mod as unknown as new (u: string) => WsLike);
    return new Ws(url);
  } catch {
    throw new Error(
      "WebSocket nicht verfügbar — Node ≥ 22 verwenden (global WebSocket) oder `ws` installieren."
    );
  }
}

/** Börsen-Whitelist für den Binance-Feed (Krypto, 24/7, ohne API-Key). */
const BINANCE_SYMBOLS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "DOGE", "AVAX", "LINK", "DOT"];

/**
 * Binance-Combined-Stream: @trade (ms-genaue Preis-Ticks) + @kline_1m
 * (autoritative Volumen- und Kerzendaten). Kein API-Key, keine LLM.
 */
export class BinanceTradeFeed implements MarketFeed {
  readonly name = "binance";
  readonly urlHint: string;
  private ws: WsLike | null = null;
  private connected = false;
  private lastTickAt: string | null = null;
  private tickCount = 0;
  private errorCount = 0;
  private stopped = false;
  private lastDetail: string | null = null;

  constructor(symbols: string[]) {
    const valid = symbols
      .map((s) => s.toUpperCase())
      .filter((s) => BINANCE_SYMBOLS.includes(s));
    const streams = valid.map(
      (s) => `${s.toLowerCase()}usdt@trade/${s.toLowerCase()}usdt@kline_1m`
    );
    this.urlHint = `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`;
  }

  async start(onTick: (t: FeedTick) => void): Promise<void> {
    this.stopped = false;
    this.connect(onTick, 0);
  }

  private connect(onTick: (t: FeedTick) => void, attempt: number): void {
    if (this.stopped) return;
    openWebSocket(this.urlHint)
      .then((ws) => {
        if (this.stopped) {
          ws.close();
          return;
        }
        this.ws = ws;
        ws.onopen = () => {
          this.connected = true;
          this.lastDetail = null;
          console.log("[micro] Binance-Feed verbunden:", this.urlHint.slice(0, 90));
        };
        ws.onmessage = (ev) => {
          try {
            const raw =
              typeof ev.data === "string"
                ? ev.data
                : Buffer.isBuffer(ev.data)
                  ? ev.data.toString()
                  : String(ev.data);
            const msg = JSON.parse(raw) as {
              data?: {
                e?: string;
                s?: string;
                p?: string;
                q?: string;
                T?: number;
                k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean };
              };
            };
            const data = msg.data;
            if (!data) return;
            const symbol = (data.s ?? "").toUpperCase().replace(/USDT$/, "");
            if (data.e === "trade" && data.p) {
              const ts = Number(data.T ?? Date.now());
              const tick: FeedTick = {
                kind: "trade",
                symbol,
                ts,
                price: Number(data.p),
                qty: Number(data.q ?? 0),
              };
              this.tickCount++;
              this.lastTickAt = new Date(ts).toISOString();
              onTick(tick);
            } else if (data.e === "kline" && data.k) {
              const k = data.k;
              const candle: CandleLike = {
                time: k.t,
                open: Number(k.o),
                high: Number(k.h),
                low: Number(k.l),
                close: Number(k.c),
                volume: Number(k.v),
              };
              const tick: FeedTick = {
                kind: "candle",
                symbol,
                ts: k.t,
                candle,
                closed: k.x,
              };
              this.tickCount++;
              this.lastTickAt = new Date(k.t).toISOString();
              onTick(tick);
            }
          } catch (e) {
            this.errorCount++;
            this.lastDetail = e instanceof Error ? e.message : String(e);
          }
        };
        ws.onerror = () => {
          this.errorCount++;
          this.connected = false;
          this.lastDetail = "WebSocket-Fehler";
        };
        ws.onclose = () => {
          this.connected = false;
          if (this.stopped) return;
          const delay = Math.min(30_000, 1000 * 2 ** attempt);
          this.lastDetail = `Reconnect in ${delay / 1000}s (Versuch ${attempt + 1})`;
          setTimeout(() => this.connect(onTick, attempt + 1), delay);
        };
      })
      .catch((e) => {
        this.errorCount++;
        this.lastDetail = e instanceof Error ? e.message : String(e);
      });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.connected = false;
    try {
      this.ws?.close();
    } catch {
      /* bereits geschlossen */
    }
  }

  status(): FeedStatus {
    return {
      name: this.name,
      connected: this.connected,
      url: this.urlHint,
      lastTickAt: this.lastTickAt,
      ticks: this.tickCount,
      errors: this.errorCount,
      detail: this.lastDetail ?? undefined,
    };
  }
}

/**
 * Deterministischer Simulator-Feed (Offline-Demo + Tests). Erzeugt Trade-
 * Ticks und alle `candleTicks` eine geschlossene 1m-Kerze. Ohne echten
 * Markt — aber mit reproduzierbaren Mustern (Sine + Rausch, Seed).
 */
export class SimulatedFeed implements MarketFeed {
  readonly name = "simulator";
  readonly urlHint = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private lastTickAt: string | null = null;
  private tickCount = 0;
  private errorCount = 0;
  private price: number;
  private readonly seed: number;
  private readonly intervalMs: number;
  private readonly candleTicks: number;
  private readonly symbols: string[];
  private candleOpen: number | null = null;
  private candleStart = 0;

  constructor(
    symbols: string[],
    opts?: { seed?: number; price?: number; intervalMs?: number; candleTicks?: number }
  ) {
    this.symbols = symbols.length ? symbols.map((s) => s.toUpperCase()) : ["BTC"];
    this.price = opts?.price ?? 100;
    this.seed = opts?.seed ?? 42;
    this.intervalMs = opts?.intervalMs ?? 250;
    this.candleTicks = opts?.candleTicks ?? 8;
  }

  async start(onTick: (t: FeedTick) => void): Promise<void> {
    this.connected = true;
    const rand = this.rand();
    let i = 0;
    const sym = this.symbols[0];
    this.candleStart = Math.floor(Date.now() / 60_000) * 60_000;
    this.candleOpen = this.price;
    this.timer = setInterval(() => {
      i++;
      const wave = Math.sin(i / 9) * 0.006 + Math.sin(i / 41) * 0.004;
      const noise = (rand() - 0.5) * 0.004;
      const drift = i % 120 < 60 ? 0.0005 : -0.0005;
      this.price = Math.max(1, this.price * (1 + wave + noise + drift));
      const ts = Date.now();
      const qty = 0.1 + rand() * 5;
      this.tickCount++;
      this.lastTickAt = new Date(ts).toISOString();
      onTick({ kind: "trade", symbol: sym, ts, price: Number(this.price.toFixed(2)), qty });
      if (i % this.candleTicks === 0) {
        const close = Number(this.price.toFixed(2));
        const open = this.candleOpen ?? close;
        const candle: CandleLike = {
          time: this.candleStart,
          open,
          high: Math.max(open, close) * 1.001,
          low: Math.min(open, close) * 0.999,
          close,
          volume: 100 + rand() * 400,
        };
        onTick({ kind: "candle", symbol: sym, ts: this.candleStart, candle, closed: true });
        this.candleStart += 60_000;
        this.candleOpen = close;
      }
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    this.connected = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): FeedStatus {
    return {
      name: this.name,
      connected: this.connected,
      url: null,
      lastTickAt: this.lastTickAt,
      ticks: this.tickCount,
      errors: this.errorCount,
    };
  }

  private rand(): () => number {
    let a = this.seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}

/** Deterministischer Test-Feed: spielt vorbereitete Ticks ab. */
export class SequenceFeed implements MarketFeed {
  readonly name = "sequence";
  readonly urlHint = null;
  private connected = false;
  private lastTickAt: string | null = null;
  private tickCount = 0;
  private errorCount = 0;

  constructor(private readonly ticks: FeedTick[]) {}

  async start(onTick: (t: FeedTick) => void): Promise<void> {
    this.connected = true;
    for (const t of this.ticks) {
      this.tickCount++;
      this.lastTickAt = new Date(t.ts).toISOString();
      onTick(t);
    }
  }

  async stop(): Promise<void> {
    this.connected = false;
  }

  status(): FeedStatus {
    return {
      name: this.name,
      connected: this.connected,
      url: null,
      lastTickAt: this.lastTickAt,
      ticks: this.tickCount,
      errors: this.errorCount,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Einstiegspunkt für Scripts (kein LLM-Import)
// ─────────────────────────────────────────────────────────────────────────────

export async function startMicroService(opts?: {
  symbols?: string[];
  feed?: MarketFeed;
  cache?: RuleCache;
  adapter?: RuleExecutionAdapter;
  options?: MicroExecutorOptions;
}): Promise<MicroExecutor> {
  const symbols = opts?.symbols?.length ? opts.symbols : ["BTC"];
  const executor = new MicroExecutor({
    cache: opts?.cache,
    adapter: opts?.adapter,
    options: opts?.options,
  });
  const feed = opts?.feed ?? new BinanceTradeFeed(symbols);
  executor.registerFeed(feed);
  for (const symbol of symbols) {
    executor.addSymbol(symbol, "5m");
    executor.addSymbol(symbol, "15m");
  }
  await executor.start();
  return executor;
}
