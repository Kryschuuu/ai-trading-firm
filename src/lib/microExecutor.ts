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
 *
 * Ausführungsintervall (STX-01, v0.6.2): Der Loop bewertet eine Regel gegen den
 * Snapshot ihres Timeframes — inklusive der noch laufenden Kerze. Das trägt
 * Intraday (Default-Obergrenze `1h`); eine `2h`/`4h`/`1d`/`5d`-Regel bekäme einen
 * teilweise abgelaufenen Snapshot. Der Timeframe-Guard (`ruleTimeframeBlockReason`)
 * weist sie fail-closed ab — sichtbar (Counter, Log, `status().ruleGuard`), nie still.
 */
import { digest as executionInputHash } from "../executionQuality/model";
import { db } from "@/db";
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
  applyDrawdownScaling,
  applyVolatilityTargeting,
  getAdaptiveRiskState,
  getLimits,
  killSwitch,
  validateOrder,
  applyRuntimeLimits,
  riskValidationReason,
  type DrawdownRiskState,
  type RiskLimits,
} from "./riskGuard";
import { resolveVolTargetingMode } from "./volatilityTargeting";
import { resolveDrawdownScalingMode } from "./drawdownScaling";
import type { DrawdownStage } from "@/portfolio/drawdownScaling";
// GAP-04 (v1.48.0): Vol-basiertes Sizing (ATR-Fallback-Stop + Fractional-Kelly)
// und Cluster-Exposure-Guardrail (Schicht 3) — LLM-frei (nur Portfolio-Mathe,
// LocalStore, DB/Audit).
import { computePositionSize, loadSizingConfig, resolveKellyEdge } from "./positionSizing";
import { checkClusterExposure, loadClusterLimitsConfig } from "./clusterExposure";
import { computeBookDepth, type BookLevelInput } from "./bookDepth";
import { bookDepthVerdict } from "./bookDepthProvenance";
import { getCandles, sanitizeSymbol } from "./marketData";
import { MarketDataFetchError } from "./marketDataErrors";
import {
  SUPPORTED_TIMEFRAME_MS,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "./marketdata/timeframes";
import { structuredLog } from "./logger";
import { writeEquitySnapshot } from "./equity";
// GAP-03 (v1.43.0): Journal-Attribution für regelförmige Eröffnungen.
// Bewusst NICHT `./engine` (LLM-freier Ausführungspfad, Guard-Test oben);
// `./journal` ist I/O-Only (DB + audit_log) ohne Modell-Abhängigkeit.
import { buildRuleSnapshot, recordJournalOpen } from "./journal";
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
// GAP-06 (v1.46.0): Regime-Gate als DATENKONTEXT — nur RAM-Lesezugriff im
// Ausführungspfad (`resolveRegimeGateForExecution`), kein LLM, keine IO.
// RMA-P2-01 (v1.61.0): dieselben Feature-Familien wie Engine/Monitor.
import {
  evaluateInstrumentRegime,
  resolveRegimeGateForExecution,
  strategyClassOfTemplate,
  type StrategyClass,
} from "./marketRegime";
import { loadRegimeFamilyInputs } from "./regimeFamilyInputs";
import { telemetry } from "./telemetry";
import { LIVE_SIGNAL_BAR_MS, persistClosedEntrySignal } from "./signalDecayRuntime";
// ADR-004 (v0.17.0): zentrale Singleton-Registrierung (keine verstreuten
// globalThis-Keys mehr im Mikro-Executor).
import { state } from "./stateRegistry";
import { registerRuleCacheInvalidator } from "./ruleCacheRegistry";

// ─────────────────────────────────────────────────────────────────────────────
// Basistypen
// ─────────────────────────────────────────────────────────────────────────────

export type FeedTick =
  | { kind: "trade"; symbol: string; ts: number; price: number; qty: number }
  | { kind: "candle"; symbol: string; ts: number; candle: CandleLike; closed: boolean }
  | {
      /** Orderbuch-Snapshot (v0.4.0): updateSpread-Fortsetzung (IAD-T-06). */
      kind: "book";
      symbol: string;
      venue: string;
      ts: number;
      bids: readonly (readonly [unknown, unknown])[];
      asks: readonly (readonly [unknown, unknown])[];
    };

/**
 * Roher Orderbuch-Input an {@link MicroExecutor.updateBook}. `venue` ist
 * Pflicht — nur über die Venue-Provenienz ist die Tiefe belastbar
 * (`src/lib/bookDepthProvenance.ts`).
 */
export interface BookDepthInput {
  venue: string;
  bids: readonly (readonly [unknown, unknown])[] | readonly BookLevelInput[];
  asks: readonly (readonly [unknown, unknown])[] | readonly BookLevelInput[];
}

/** Buch-Levels, die zur Tiefe gewertet werden (Security-Kappe). */
const MAX_BOOK_LEVELS = 10;

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
  /**
   * GAP-06 (v1.46.0): deterministisch aus dem Mission-Template abgeleitete
   * Strategieklasse (null = nicht ableitbar → Regime-Gate-Faktor 1).
   */
  strategyClass?: StrategyClass | null;
};

export interface RuleExecutionAdapter {
  readonly name: string;
  execute(ctx: ExecuteContext): Promise<ExecutionOutcome>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ausführungsintervall & Timeframe-Guard (STX-01, v0.6.2) — fail-closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard-Ausführungsintervall: der LÄNGSTE Regel-Timeframe, den der
 * Mikro-Executor auswertet. `1h` ist das bisherige Maximum — Regeln von `1m`
 * bis `1h` verhalten sich unverändert. Überschreibbar über
 * {@link MicroExecutorOptions.executionInterval}.
 */
export const MICRO_EXECUTION_INTERVAL_DEFAULT: SupportedTimeframe = "1h";

/**
 * Warum der Mikro-Executor eine Regel nicht auswertet — geschlossenes
 * Vokabular (Label des Counters `micro_executor_rule_blocked_total` und Feld
 * `reason` des Logs `micro_executor_rule_blocked`):
 *   - `timeframe_exceeds_interval`: Timeframe länger als das Ausführungsintervall.
 *   - `timeframe_unsupported`: kein `SupportedTimeframe` (z. B. beschädigte,
 *     nicht re-sanitisierte DB-Zeile) — die Periode ist unbekannt.
 */
export type RuleTimeframeBlockReason = "timeframe_exceeds_interval" | "timeframe_unsupported";

/**
 * Fail-closed Timeframe-Guard: die EINE Stelle, die entscheidet, ob der
 * Mikro-Executor eine Regel dieses Timeframes auswerten darf. `null` = ja,
 * sonst der Grund des „Nein“.
 *
 * Auswertbar ist nur ein bekannter Timeframe bis einschließlich zum
 * Ausführungsintervall. Alles andere bleibt draußen, statt still auf einen
 * anderen Takt zu fallen: eine Regel auf einem Tages-Snapshot aus einer
 * halben Tageskerze sähe einen Messwert, den weder ihr Autor noch der Backtest
 * je gesehen haben.
 */
export function ruleTimeframeBlockReason(
  timeframe: unknown,
  executionInterval: SupportedTimeframe,
): RuleTimeframeBlockReason | null {
  if (!isSupportedTimeframe(timeframe)) return "timeframe_unsupported";
  return SUPPORTED_TIMEFRAME_MS[timeframe] > SUPPORTED_TIMEFRAME_MS[executionInterval]
    ? "timeframe_exceeds_interval"
    : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RollingTimeframeSeries — Kerzenhaltung + Aggregation ohne IO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hält eine Kerzenreihe eines Symbols für EIN Timeframe im RAM.
 * Gestartet mit REST-Historie (Seed), danach live via Trade-Ticks und
 * 1m-Kerzen-Closes fortgeschrieben. Aggregation 1m → Nm ist deterministisch.
 * Die Serie aggregiert jeden `SupportedTimeframe` exakt auf dessen Periode;
 * welche Timeframes der Executor zulässt, entscheidet der Guard
 * ({@link ruleTimeframeBlockReason}), nicht die Serie.
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
    // Kein stiller Fallback auf einen anderen Takt (früher `?? 15m`): Die Regel
    // liefe sonst auf Kerzen, die sie nie unterschrieben hat — bei `1m`
    // (CYCLE-DAYTRADE-01) ebenso wie bei `3m`…`5d` (STX-01). Die Perioden kommen
    // aus der kanonischen Tabelle; der Executor hat keine zweite.
    if (!isSupportedTimeframe(timeframe)) {
      throw new RangeError(
        `Unbekannter Timeframe "${String(timeframe).slice(0, 20)}" — Rolling-Serie nicht aufbaubar.`,
      );
    }
    this.symbol = symbol.toUpperCase();
    this.timeframe = timeframe;
    this.bucketMs = SUPPORTED_TIMEFRAME_MS[timeframe];
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
  snapshot(
    volumeWindow = 20,
    spread: number | null = null,
    bookDepthUsd: number | null = null,
  ): RuleSnapshot | null {
    const buf: CandleLike[] = this.finalized.slice(-159);
    if (this.openAgg) {
      buf.push({ ...this.openAgg, time: this.openAgg.time });
    }
    if (buf.length < 25) return null;
    return buildSnapshotFromCandles(this.symbol, buf, volumeWindow, spread, bookDepthUsd);
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

/** Ein konsistenter DB-Snapshot, der vor dem RAM-Swap vollständig aufgebaut wird. */
export interface RuleCacheSnapshot {
  rows: (typeof tradeRules.$inferSelect)[];
  missionRows: Array<{ id: string; status: string; templateId: string | null }>;
  countRows: Array<{ ruleId: string; c: number }>;
}

export type RuleCacheSnapshotLoader = () => Promise<RuleCacheSnapshot>;

/** Lädt alle DB-Teile eines Caches; kein Teilzustand wird hier veröffentlicht. */
export async function loadRuleCacheSnapshot(): Promise<RuleCacheSnapshot> {
  const rows = await db.select().from(tradeRules).where(eq(tradeRules.status, "ACTIVE"));
  const missionRows = await db
    .select({ id: missionsTable.id, status: missionsTable.status, templateId: missionsTable.templateId })
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
  return { rows, missionRows, countRows };
}

/**
 * Liest ACTIVE-Regeln, kompiliert sie einmalig und matcht im Hot-Path rein im
 * RAM. `LISTEN/NOTIFY` invalidiert sofort; der Poll bleibt als Fallback bei
 * Verbindungs- oder Triggerproblemen bestehen. Ein ungültiger Cache matcht
 * während des Reloads absichtlich keine Regeln (fail-closed).
 */
export class RuleCache {
  private bySymbol = new Map<string, CachedRule[]>();
  private missions = new Map<string, string>();
  /** GAP-06: Mission → Template-ID (Quelle der Strategieklasse des Regime-Gates). */
  private missionTemplates = new Map<string, string | null>();
  private loadedAt: number | null = null;
  private dirty = true;
  private dayKey = "";
  private ramCounts = new Map<string, number>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private invalidationVersion = 0;
  private inFlightLoad: Promise<void> | null = null;
  private inFlightVersion: number | null = null;
  private unregisterInvalidator: (() => void) | null = null;

  constructor(
    private readonly refreshMs = 30_000,
    private readonly loadSnapshot: RuleCacheSnapshotLoader = loadRuleCacheSnapshot,
  ) {}

  /** Markiert den Snapshot sofort als nicht verwendbar und startet den Reload. */
  invalidate(): void {
    this.invalidationVersion += 1;
    this.dirty = true;
    if (this.started) void this.load();
  }

  async start(): Promise<void> {
    if (this.started) {
      await this.load();
      return;
    }
    this.started = true;
    this.unregisterInvalidator = registerRuleCacheInvalidator(this, () => this.invalidate());
    this.refreshTimer = setInterval(() => void this.load(), this.refreshMs);
    this.refreshTimer.unref?.();
    await this.load();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.unregisterInvalidator?.();
    this.unregisterInvalidator = null;
  }

  async load(): Promise<void> {
    // Ein laufender Read wird geteilt. Falls eine NOTIFY währenddessen eintrifft,
    // wird dessen Snapshot verworfen und nach Abschluss genau ein neuer gestartet.
    if (this.inFlightLoad) {
      const pending = this.inFlightLoad;
      const versionAtStart = this.inFlightVersion;
      await pending;
      if (
        this.dirty &&
        this.started &&
        versionAtStart !== null &&
        this.invalidationVersion !== versionAtStart
      ) {
        await this.load();
      }
      return;
    }
    if (!this.dirty && this.loadedAt !== null && Date.now() - this.loadedAt < this.refreshMs) return;

    const versionAtStart = this.invalidationVersion;
    const work = (async () => {
      try {
        const snapshot = await this.loadSnapshot();
        if (versionAtStart !== this.invalidationVersion) {
          this.dirty = true;
          return;
        }
        this.applySnapshot(snapshot);
      } catch (error) {
        // Fehlgeschlagene Poll-Refreshes dürfen einen noch gültigen Snapshot
        // weiterverwenden. Nach einer NOTIFY bleibt `dirty=true`, also match()
        // bis zu einem erfolgreichen Reload fail-closed. Ein fehlgeschlagener
        // Load wird nicht sofort rekursiv wiederholt: der nächste Poll oder
        // eine explizite Invalidation versucht es erneut.
        const errorName = error instanceof Error ? error.name : "UnknownError";
        console.warn("[micro] RuleCache-Load fehlgeschlagen; Cache bleibt ungültig bzw. beim letzten Stand:", errorName);
      }
    })();
    this.inFlightLoad = work;
    this.inFlightVersion = versionAtStart;
    try {
      await work;
    } finally {
      if (this.inFlightLoad === work) {
        this.inFlightLoad = null;
        this.inFlightVersion = null;
      }
    }
  }

  /** Baut alle Maps privat auf und veröffentlicht sie mit einem atomaren Swap. */
  private applySnapshot(snapshot: RuleCacheSnapshot): void {
    const counts = new Map<string, number>();
    for (const row of snapshot.countRows) counts.set(row.ruleId, Number(row.c));

    const nextMissions = new Map<string, string>();
    const nextMissionTemplates = new Map<string, string | null>();
    for (const mission of snapshot.missionRows) {
      nextMissions.set(mission.id, mission.status);
      nextMissionTemplates.set(mission.id, mission.templateId ?? null);
    }

    const nextBySymbol = new Map<string, CachedRule[]>();
    for (const row of snapshot.rows) {
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
      const cached: CachedRule = {
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
      };
      const list = nextBySymbol.get(cached.symbol) ?? [];
      list.push(cached);
      nextBySymbol.set(cached.symbol, list);
    }

    // Der Build oben kann werfen, bevor irgendeine sichtbare Map ausgetauscht
    // wird. So sieht der Hot-Path nie einen halb aktualisierten Snapshot.
    this.bySymbol = nextBySymbol;
    this.missions = nextMissions;
    this.missionTemplates = nextMissionTemplates;
    this.loadedAt = Date.now();
    this.dirty = false;
    const day = berlinDayKeyOf(Date.now());
    if (this.dayKey !== day) {
      this.dayKey = day;
      this.ramCounts.clear();
    }
  }

  /** Kompilierte Regeln eines Symbols (ohne Auswertung). */
  candidatesBySymbol(symbol: string): CachedRule[] {
    if (this.dirty || this.loadedAt === null) return [];
    return this.bySymbol.get(symbol.toUpperCase()) ?? [];
  }

  /** Alle kompilierten Regeln (für Series-Aufbau beim Start). */
  allRules(): CachedRule[] {
    return this.dirty || this.loadedAt === null ? [] : [...this.bySymbol.values()].flat();
  }

  /**
   * GAP-06 (v1.46.0): Strategieklasse einer Regel — deterministisch aus dem
   * Mission-Template abgeleitet (`strategyClassOfTemplate`). null = keine
   * Mission/kein Template/kein Treffer → Regime-Gate-Faktor 1 (nie Raten).
   */
  strategyClassFor(missionId: string | null): StrategyClass | null {
    if (!missionId) return null;
    return strategyClassOfTemplate(this.missionTemplates.get(missionId) ?? null);
  }

  /**
   * Test-/Injections-Hook: Regeln direkt in den RAM-Cache setzen, ohne DB.
   * Wird von den Unit-Tests genutzt (Hot-Path-Logik ohne PostgreSQL) und
   * dokumentiert zugleich, dass der Cache nur die DB als Quelle braucht.
   */
  _seedForTest(
    rules: CachedRule[],
    missionStatus: [string, string][] = [],
    missionTemplates: [string, string | null][] = []
  ): void {
    this.bySymbol.clear();
    this.missions.clear();
    this.missionTemplates.clear();
    for (const [id, status] of missionStatus) this.missions.set(id, status);
    for (const [id, templateId] of missionTemplates) this.missionTemplates.set(id, templateId);
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
    if (this.dirty || this.loadedAt === null) return [];
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
// Paper-Adapter — ADR-003 (Atomare Mehrprozess-Order-Reservierung)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Führt einen Regel-Match über den PAPER-Singleton-Ledger aus (ADR-003,
 * v0.17.0): Broker = `paperBrokerLedger()` (Factory-Singleton, geteilt mit
 * der Web-App); vor Sizing/Guardrails erfolgt die Hydration via
 * `ensureHydrated`-Hook; JEDE Order-Eröffnung läuft durch
 * `PaperBroker.submitAtomic()` — dieser sichert innerhalb einer einzigen
 * Postgres-Transaktion:
 *   - `pg_advisory_xact_lock(hashtext('PAPER'))` Kontoserialisierung
 *   - DB-Wahrheits-Prüfung `positions WHERE status='OPEN'`
 *   - In-Memory-Guard + Fill (unter dem Lock)
 *   - `order_intents`-Reservierung mit partiellem UNIQUE-Index
 *   - Positions-Persistenz + Rollback bei Unique-Konflikt (fail-closed)
 * Damit können mehrere Prozesse (Next.js-Worker, Mikro-Executor, CLI)
 * niemals dieselbe Position doppelt eröffnen — siehe docs/roadmap/DECISIONS.md.
 */
/**
 * Lädt die Laufzeit-Limits (risk_config) in den Prozess — lokal implementiert,
 * KEIN Import von riskConfigService/engine (sonst zöge der Mikro-Prozess
 * LLM-Code). Fehlende DB → Code-Defaults bleiben (Fail-safe).
 */
async function ensureRuntimeLimitsLoaded(): Promise<void> {
  // ADR-004 (v0.17.0): Cache-Timestamp nicht mehr auf rohem globalThis,
  // sondern über die zentrale stateRegistry (single reset für Tests).
  const lastLoaded = state.microLimitsLoadedAt.get();
  if (lastLoaded !== undefined && Date.now() - lastLoaded < 60_000) return;
  try {
    const rows = await db.select().from(riskConfig);
    const raw: Record<string, number> = {};
    let activeFactor: number | null = null;
    let activeAtMs: number | null = null;
    // RMA-P5-01 (v1.67.0): persistierter Volatility-Targeting-Faktor.
    let vtpFactor: number | null = null;
    let vtpAtMs: number | null = null;
    // RMA-P5-04 (v1.68.0): persistierter Drawdown-Scaling-Faktor + PAUSE-Stufe.
    let ddpFactor: number | null = null;
    let ddpAtMs: number | null = null;
    let ddpPause: number | null = null;
    for (const r of rows) {
      const n = Number(r.value);
      if (!Number.isFinite(n)) continue;
      if (r.key === "adp.activeFactor") activeFactor = n;
      else if (r.key === "adp.activeAt") activeAtMs = n * 1000;
      else if (r.key === "vtp.activeFactor") vtpFactor = n;
      else if (r.key === "vtp.activeAt") vtpAtMs = n * 1000;
      else if (r.key === "dsp.activeFactor") ddpFactor = n;
      else if (r.key === "dsp.activeAt") ddpAtMs = n * 1000;
      else if (r.key === "dsp.pause") ddpPause = n;
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

    // RMA-P5-01 (v1.67.0): Volatility-Targeting-Faktor. Der Mikro-Prozess
    // wendet den persistierten Faktor NUR an, wenn sein eigener Modus
    // `active` ist (Feature-Flag-Parität mit dem Main-Prozess) und der
    // Faktor frisch ist. Im Modus `monitor`/`off` bleibt er wirkungslos —
    // die Reduktion ist dann reine Beobachtung.
    if (resolveVolTargetingMode() === "active") {
      if (vtpFactor != null && vtpAtMs != null && vtpFactor > 0 && vtpFactor <= 1) {
        if (Date.now() - vtpAtMs < ADAPTIVE_STATE_MAX_AGE_MS) {
          applyVolatilityTargeting({
            factor: vtpFactor,
            reason: "persistierter Volatility-Targeting-Faktor des Main-Prozesses",
            at: new Date(vtpAtMs).toISOString(),
            asOf: null,
            mode: "persisted",
          });
        } else {
          applyVolatilityTargeting(null);
        }
      }
    }

    // RMA-P5-04 (v1.68.0): Drawdown-Scaling-Faktor + PAUSE. Der Mikro-Prozess
    // wendet beides NUR an, wenn sein eigener Modus `active` ist
    // (Feature-Flag-Parität mit dem Main-Prozess) und die Persistenz frisch
    // ist (ADAPTIVE_STATE_MAX_AGE_MS). Ein abgelaufener PAUSE-Block wird
    // explizit zurückgenommen — ein Block darf nie ohne gültige Messung
    // weiterleben (fail-closed bleibt der Faktor selbst: er ist ≤ 1).
    if (resolveDrawdownScalingMode() === "active") {
      const fresh = ddpAtMs != null && Date.now() - ddpAtMs < ADAPTIVE_STATE_MAX_AGE_MS;
      if (ddpFactor != null && ddpAtMs != null && ddpFactor > 0 && ddpFactor <= 1 && fresh) {
        const stage: DrawdownStage = ddpPause === 1 ? "PAUSE" : ddpFactor >= 0.999 ? "NORMAL" : "DEEP";
        const snapshot: DrawdownRiskState = {
          factor: ddpFactor,
          stage,
          paused: stage === "PAUSE",
          drawdownPct: null,
          hwm: null,
          reason: "persistierter Drawdown-Scaling-Faktor des Main-Prozesses",
          at: new Date(ddpAtMs).toISOString(),
          asOf: null,
          mode: "persisted",
          // Die Policyversion ist kein Mikro-Executor-Wissen (kein DB-Read im
          // Hot-Path) — der Faktor selbst ist die Wahrheit; die Version steht
          // in der Snapshot-Tabelle und im Audit des Main-Prozesses.
          policyVersion: "persisted",
        };
        applyDrawdownScaling(snapshot);
      } else {
        applyDrawdownScaling(null);
      }
    }
    state.microLimitsLoadedAt.set(Date.now());
  } catch {
    /* DB nicht bereit → Code-Defaults bleiben wirksam */
  }
}

/**
 * Erzeugt den PAPER-Adapter für Regel-Execution im Mikro-Zyklus.
 *
 * Führt eine abgefangene (kompilierte) Strategie-Regel gegen den lokalen
 * Paper-Broker aus — deterministische Fill-Simulation, keine Netzwerk-I/O.
 * Wird vom Mikro-Executor (eigener Prozess, `npm run micro`) und den
 * Tests verwendet, um den regelbasierten Mikro-Pfad ohne Live-Venue zu
 * üben.
 *
 * @param opts.onFired - Optionaler Callback, der nach erfolgreicher
 *   Execution mit der `ruleId` aufgerufen wird (z. B. für Auditing/Telemetrie).
 * @returns Ein `RuleExecutionAdapter` mit `name: "PAPER_RULE"` und einer
 *   asynchronen `execute(ctx)`-Methode, die das `ExecutionOutcome` liefert.
 */
export function createPaperRuleAdapter(opts?: {
  onFired?: (ruleId: string) => void;
  /**
   * ADR-003 (v0.17.0): Optionaler Hydrations-Hook. Der Mikro-Executor läuft
   * als eigenständiger Prozess; er teilt den PAPER-Singleton-Ledger
   * (`paperBrokerLedger()`) mit der Web-App, muss ihn aber beim Start aus
   * der DB hydrieren. Das macht der Aufrufer (z. B. `scripts/micro-executor.ts`
   * via `getBroker()` aus `engine.ts`) und kann diesen Hook nutzen, um die
   * Hydration nach Bedarf auszulösen. Wird kein Hook übergeben, läuft die
   * Order durch `submitAtomic` — dieser greift IMMER auf die DB-Wahrheit
   * zu (positions OPEN + order_intents-Reservierung), auch ohne vorherige
   * Hydration, und rollt den In-Memory-Ledger bei Konflikt fail-closed
   * zurück. Die Hydration bleibt aber Pflicht, damit `accountEquity`/
   * `openPositions` nicht veraltete Werte liefern.
   */
  ensureHydrated?: () => Promise<void>;
}): RuleExecutionAdapter {
  // ADR-003 (v0.17.0): Singleton-Ledger aus der Broker-Factory statt eines
  // isolierten `new PaperBroker(…)`. Der eigenständige Mikro-Executor-Prozess
  // und die Next.js-Worker teilen sich damit DENSELBEN Ledger-Typ; die
  // atomare DB-Serialisierung (`submitAtomic` + `withAccountLock`) ist der
  // EINZIGE Mehrprozess-Schutz gegen H2. Ein eigenes `new PaperBroker(…)`
  // pro Adapter-Aufruf hätte einen leeren, unhydrierten Ledger erzeugt und
  // damit die H2-Wahrung (DB-Wahrheit + order_intents) vollständig umgangen.
  const { paperBrokerLedger } = require("../brokers/factory") as typeof import("../brokers/factory");
  const broker: PaperBroker = paperBrokerLedger();
  const startedProcess = Date.now();

  return {
    name: "PAPER_RULE",
    async execute(ctx): Promise<ExecutionOutcome> {
      const started = Date.now(), startedMono = performance.now();
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
      // ADR-003: Sicherstellen, dass der Singleton-Ledger aus der DB hydriert
      // ist (Positionen/Cash/Kill-Switch), bevor wir Sizing/Guardrails auf
      // seinen Werten rechnen. Ein veralteter Ledger würde sonst ein zu
      // hohes `accountEquity` sehen und Limits falsch bemessen. Die
      // eigentliche Mehrprozess-Serialisierung (Kontosperre, DB-Wahrheit,
      // order_intents) liegt danach in `submitAtomic` und ist unabhängig
      // vom Hydrationszustand immer wirksam.
      if (opts?.ensureHydrated) {
        try { await opts.ensureHydrated(); } catch { /* Hydration-Fehler → submitAtomic entscheidet fail-closed */ }
      }

      // H2-REMOVED (v0.17.0): Das manuelle `pg_advisory_lock(hashtext('rule:'+
      // symbol))` wurde ENTFERNT. Es war (a) session-scoped statt transaktional
      // (Lock-Leck bei Crash), (b) auf einem anderen Key als `withAccountLock`
      // (hashtext('PAPER')) und konnte damit die Kontosperre NICHT ersetzen
      // oder ergänzen, und (c) enthielt doppelte DB-Prüfungen (positions OPEN,
      // missions-KILLED, kill_switches), die teilweise bereits in
      // `submitAtomic` steckten. Die EINZIGE seriöse Kontosperre ist jetzt
      // `withAccountLock` in `submitAtomic` (transaktional, automatischer
      // Release bei Commit/Rollback, prozessübergreifend wirksam).
      //
      // ADR-003-konformer Ablauf ab hier:
      //   1. In-Prozess-Guardrails (Regime, Sizing, Cluster) auf den
      //      aktuellen Werten des (hydrierten) Singleton-Ledgers.
      //   2. `broker.submitAtomic()`:
      //        - pg_advisory_xact_lock(hashtext('PAPER')) — Kontoserialisierung
      //        - SELECT aus positions WHERE status='OPEN' — DB-Wahrheit
      //        - this.submit(order) — Guard + Fill (im exklusiven Lock)
      //        - INSERT order_intents RESERVED — partieller UNIQUE als
      //          Defense-in-Depth
      //        - persistPosition-Callback (Positions-Insert + Mission-Update)
      //        - bei Unique-Konflikt: rollbackInMemoryFill (fail-closed)
      //
      // Mission-KILLED-Prüfung bleibt hier (VOR der Order, schlankes READ
      // außerhalb der Transaktion) — sie prüft einen Schreibschutz, nicht
      // eine Positionsmehrfachöffnung; eine Race zwischen diesem READ und
      // dem Mission-Kill ist akzeptabel (der Kill schlägt keine Position
      // mehr auf, sobald Status=KILLED committed ist — Kills laufen in
      // einem eigenen Modus und ändern den Status nur vorwärts).
      if (ctx.missionId) {
        const [mission] = await db
          .select({ status: missionsTable.status })
          .from(missionsTable)
          .where(eq(missionsTable.id, ctx.missionId))
          .limit(1);
        if (mission?.status === "KILLED") {
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: "MISSION_KILLED",
            at: new Date().toISOString(),
          };
        }
      }

      try {
        const equity = broker.accountEquity;
        const limits = getLimits();
        const stopPct = Math.min(ctx.spec.action.stopLossPct / 100, limits.defaultStopLossPct);

        // GAP-06 (v1.46.0): Regime-Gate (nur enforce) dämpft das Signal-
        // Risikobudget der Regel mit dem Faktor je Regime × Strategieklasse —
        // DATENKONTEXT, kein Veto: die Order wird nie abgelehnt, nur das
        // Budget läuft gedämpft in die Mission-Sizing-Formel (und bleibt dort
        // gegen limits.maxRiskPerTrade geklemmt → nie über den Code-Ceilings).
        // monitor/off/UNKNOWN/ohne Klasse → Faktor 1 (fail-safe, nie Raten).
        const regimeGate = resolveRegimeGateForExecution(symbol, ctx.strategyClass ?? null);
        const gatedRiskBudgetPct = regimeGate.applied
          ? ctx.spec.action.riskBudgetPct * regimeGate.factor
          : ctx.spec.action.riskBudgetPct;
        // RMA-P2-01: Boost-Entscheidungen mit bounded Labels zählen —
        // blockierte Risiko-Boosts bleiben sichtbar, ohne Symbol-Labels.
        if (regimeGate.boostBlocked) telemetry.regime.boosts.inc({ result: "blocked" });
        else if (regimeGate.applied && regimeGate.factor > 1) telemetry.regime.boosts.inc({ result: "applied" });

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

        // GAP-04 (v1.48.0): Vol-basiertes Sizing — qty = Risikobudget/Stop-
        // Abstand. Stop: explizit aus der Regel (stopPct); fehlender/0-Stop →
        // ATR-Fallback (k·ATR, k = RISK_ATR_STOP_MULT). Fractional-Kelly-Deckel
        // wirkt nur mit verfügbaren Journal-Statistiken (sonst wirkungslos).
        // IMMER an die Code-Ceilings geklemmt (Sizing verschärft, lockert nie).
        // UNKNOWN (kein ATR + kein Stop) → heutige Basis-Größe + Kennzeichnung
        // + Audit-Notiz (Muster adaptiveRisk v1.36.21) — kein Block.
        const sizingCfg = loadSizingConfig();
        const kellyEdge = await resolveKellyEdge(sizingCfg);
        const sized = computePositionSize({
          equity,
          riskPerTradePct: Math.min(gatedRiskBudgetPct, limits.maxRiskPerTrade),
          entryPrice: price,
          atr: ctx.snapshot.atrPct != null ? (ctx.snapshot.atrPct / 100) * price : null,
          stopLoss: stopPct > 0 ? price * (1 - stopPct) : null,
          side: "LONG",
          missionMaxPositionPct: ctx.spec.action.maxPositionPct,
          kelly: kellyEdge,
          cfg: sizingCfg,
        });
        if (sized.unknown) {
          // Fail-closed-Kennzeichnung (kein stiller Wert): Audit-Notiz, Order
          // läuft mit der Basis-Größe weiter.
          try {
            await ruleAudit(
              "POSITION_SIZING_UNKNOWN",
              "WARN",
              { ruleId: ctx.ruleId, symbol, code: `sizing:atr-unknown:${symbol}`, note: sized.note },
              ctx.missionId
            );
          } catch {
            /* Audit ist best-effort — darf die Ausführung nie brechen */
          }
        }
        const notional = sized.notional;
        if (notional <= 0) {
          // Kelly-Deckel ohne positiven Edge → keine Größe (maschinenlesbar).
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: "GUARDRAIL:kelly:no-positive-edge",
            at: new Date().toISOString(),
          };
        }
        const qty = sized.qty;
        const stopLoss =
          stopPct > 0
            ? Number((price * (1 - stopPct)).toFixed(price > 100 ? 2 : 6))
            : Number(sized.stopPrice.toFixed(price > 100 ? 2 : 6));
        const tpDist =
          (stopPct > 0 ? stopPct : Math.max(sized.stopDistancePct, 0.001)) *
          Math.min(ctx.spec.action.takeProfitRR, limits.takeProfitRR);
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

        // GAP-04 (v1.48.0): Cluster-Exposure-Guardrail (Schicht 3) — neues
        // Symbol gegen offene Positionen korrelationsgeclustert (Cache-TTL,
        // kein Hintergrund-Job). monitor (Default): nur Audit-Notiz + Log der
        // Würde-Prüfung, Entscheidung unverändert; enforce: Ablehnung
        // `cluster-exposure:max-per-cluster:N` bzw. `-correlation-stale`.
        // Offene Symbole kommen aus dem (hydrierten) Singleton-Ledger — nicht
        // mehr aus einem separaten SQL-Client (v0.17.0, ADR-003).
        const clusterCheck = await checkClusterExposure({
          symbol,
          openSymbols: broker.listPositions().map((p) => p.symbol).filter((s) => s !== symbol),
          missionId: ctx.missionId,
        }).catch((e) => {
          // Guardrail-Selbstfehler: fail-closed im enforce-Modus; im
          // monitor-Modus bleibt die Entscheidung unverändert (sonst wäre
          // „monitor“ kein no-op).
          console.error(
            "[micro] cluster-exposure guardrail fehlgeschlagen:",
            e instanceof Error ? e.message : e
          );
          const mode = loadClusterLimitsConfig().mode;
          if (mode === "enforce") {
            return {
              allowed: false,
              reason: "cluster-exposure:guardrail-error",
              blockedBy: ["cluster-exposure:guardrail-error"],
              verdict: "STALE" as const,
              mode: "enforce" as const,
              clusterOfSymbol: null,
              clusters: null,
              auditWritten: false,
            };
          }
          return {
            allowed: true,
            reason: "cluster-exposure guardrail fehlgeschlagen (monitor: keine Auswirkung)",
            blockedBy: [],
            verdict: "STALE" as const,
            mode: "monitor" as const,
            clusterOfSymbol: null,
            clusters: null,
            auditWritten: false,
          };
        });
        if (!clusterCheck.allowed) {
          return {
            status: "BLOCKED",
            ruleId: ctx.ruleId,
            symbol,
            reason: `GUARDRAIL:${clusterCheck.blockedBy.join("|") || clusterCheck.reason}`,
            at: new Date().toISOString(),
          };
        }

        // H2: `submitAtomic` reserviert die Position DB-seitig (order_intents,
        // partieller UNIQUE-Index je Symbol) innerhalb einer Postgres-
        // Advisory-Transaktionssperre je Account. Das schützt genau den Fall,
        // den der symbol-scoped Lock oben (client-seitig, nur innerhalb
        // dieses Prozesses wirksam) allein nicht abdecken kann: mehrere
        // Mikro-Executor-*Prozesse*, die gleichzeitig dieselbe Regel/dasselbe
        // Symbol feuern. Die Positions-/Missions-Persistenz läuft im selben
        // `persistPosition`-Callback wie die Reservierung — entweder beides
        // oder nichts.
        // GAP-03: Positions-ID übernehmen (Journal-Verknüpfung, ohne
        // Schema-Änderung an `positions`).
        const journalPosRef: { value: { id: string; createdAt: Date } | null } = { value: null };
        const fill = await broker.submitAtomic(
          {
            symbol,
            side: "LONG",
            qty,
            riskNotional: notional,
            stopLoss,
            takeProfit,
          },
          {
            account: "PAPER",
            executionQuality: {id:`${ctx.ruleId}:${ctx.snapshot.ts}`,at:started,elapsedMs:performance.now()-startedMono,strategy:`rule:${ctx.ruleId}`,quoteCurrency:symbol.includes("/") ? symbol.split("/")[1]:"UNKNOWN",price:{value:ctx.snapshot.price,eventTime:ctx.snapshot.ts,availableAt:started,inputHash:executionInputHash({price:ctx.snapshot.price,ts:ctx.snapshot.ts,symbol})}},
            persistPosition: async (tx, f) => {
              const [pos] = await tx.insert(positionsTable).values({
                symbol: f.symbol,
                side: f.side,
                qty: String(f.qty),
                entryPrice: String(f.fillPrice),
                currentPrice: String(f.fillPrice),
                stopLoss: f.stopLoss === null ? null : String(f.stopLoss),
                takeProfit: f.takeProfit === null ? null : String(f.takeProfit),
                broker: broker.name,
                missionId: ctx.missionId,
                ruleId: ctx.ruleId,
                status: "OPEN",
              }).returning({ id: positionsTable.id, createdAt: positionsTable.createdAt });
              journalPosRef.value = pos ?? null;

              if (ctx.missionId) {
                await tx
                  .update(missionsTable)
                  .set({ status: "ACTIVE", updatedAt: new Date() })
                  .where(eq(missionsTable.id, ctx.missionId));
              }
            },
          }
        );
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
        if (journalPosRef.value) {
          try {
            const candles = await getCandles(symbol, "15m", 120);
            await persistClosedEntrySignal({
              positionId: journalPosRef.value.id,
              symbol,
              strategyClass: ctx.strategyClass ?? null,
              asOfMs: Date.now(),
              candles,
              barDurationMs: LIVE_SIGNAL_BAR_MS,
              timeBasis: "open",
            });
          } catch (e) {
            structuredLog("error", "signal_decay_entry_capture_failed", {
              symbol,
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }
        // GAP-03 (D1a): Journal-Zeile mit RULE-Snapshot (Regel =
        // Entscheidungskette: signature + Ursprungsrolle; keine erfundenen
        // Agenten-Stimmen). Fehlertolerant — Journal-Fehler ändert das
        // ExecutionOutcome NICHT (die Position ist bereits gebucht).
        if (journalPosRef.value) {
          try {
            let regime = "UNKNOWN";
            try {
              regime = getAdaptiveRiskState()?.regime ?? "UNKNOWN";
            } catch {
              regime = "UNKNOWN";
            }
            const snapshot = await buildRuleSnapshot({
              ruleId: ctx.ruleId,
              missionId: ctx.missionId,
              regime,
              source: "MICRO_EXECUTOR",
              openedAt: journalPosRef.value.createdAt,
              // RMA-P1-06 (v1.57.0): Trigger-Snapshot als Daten-Fingerprint
              // des Regel-Entscheids (Point-in-Time, unveränderlich).
              decisionData: ctx.snapshot,
            });
            await recordJournalOpen({
              positionId: journalPosRef.value.id,
              symbol,
              side: "LONG",
              openedAt: journalPosRef.value.createdAt,
              missionId: ctx.missionId,
              ruleId: ctx.ruleId,
              snapshot,
            });
          } catch (e) {
            structuredLog("warn", "journal_open_failed", {
              ruleId: ctx.ruleId,
              symbol,
              error: e instanceof Error ? e.message : String(e),
            });
          }
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
        // GAP-06: Eine enforce-Dämpfung ist eine Mutation des Signalgewichts
        // → eigenes Audit (Maschinenlesbarer Code `regime-gate:SYMBOL:KLASSE:REGIME`).
        if (regimeGate.applied) {
          await ruleAudit(
            "REGIME_GATE_APPLIED",
            "INFO",
            {
              ruleId: ctx.ruleId,
              symbol,
              regime: regimeGate.regime,
              strategyClass: ctx.strategyClass ?? null,
              factor: regimeGate.factor,
              // RMA-P2-01 (additiv): Coverage-Dimension des Snapshots.
              coverage: regimeGate.coverage,
              degraded: regimeGate.degraded,
              riskBudgetPctBefore: ctx.spec.action.riskBudgetPct,
              riskBudgetPctAfter: gatedRiskBudgetPct,
              code: `regime-gate:${symbol}:${ctx.strategyClass ?? "?"}:${regimeGate.regime}`,
            },
            ctx.missionId
          );
        }
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
      }
      // ADR-003 (v0.17.0): Kein finally-Client-Release mehr — alle DB-
      // Zugriffe laufen jetzt über Drizzle (`db`) oder die transaktionale
      // Kontosperre in `submitAtomic` (automatischer Release bei Commit/
      // Rollback). Es gibt keinen mehr manuell erworbenen `client` mehr,
      // der freigegeben werden müsste. Die H2-REMOVED-Stelle dokumentiert
      // den Wegfall des `pg_advisory_lock`-Session-Locks.
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MicroExecutor — Orchestrierung des Hot-Paths
// ─────────────────────────────────────────────────────────────────────────────

export type MicroExecutorOptions = {
  refreshMs?: number;
  seedCandles?: boolean;
  /**
   * Ausführungsintervall: der längste Regel-Timeframe, den dieser Executor
   * auswertet (Default {@link MICRO_EXECUTION_INTERVAL_DEFAULT} = `1h`). Regeln
   * mit längerem Timeframe nimmt der Guard beim Start sichtbar heraus; eine
   * Serie oberhalb des Intervalls lässt sich nicht anlegen (`addSymbol` wirft).
   * Werte über `1h` sind eine Policy-Entscheidung (Audit-Tracking OP-1), keine
   * reine Konfiguration: Der Loop bewertet die laufende Kerze, und der REST-Seed
   * (`getCandles`) kennt `5d` nicht.
   */
  executionInterval?: SupportedTimeframe;
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
  /**
   * Timeframe-Guard (STX-01): das Ausführungsintervall und die Regeln, die er
   * aktuell abweist (aus dem RuleCache abgeleitet — auch nach dem Start
   * aktivierte Regeln erscheinen hier; ausgewertet werden sie nie).
   */
  ruleGuard: {
    executionInterval: SupportedTimeframe;
    blocked: { ruleId: string; symbol: string; timeframe: string; reason: RuleTimeframeBlockReason }[];
  };
  lastError: string | null;
  /** Warmstart (REST-Historie): Fehler sind sichtbar, nicht still verschluckt (MDERR-006). */
  seed: { requested: number; failed: number; lastError: string | null };
};

/**
 * Mikro-Executor — der schnelle, LLM-freie Regel-Executor.
 *
 * Läuft als separater Prozess (`npm run micro`) neben der Web-App. Empfängt
 * WebSocket-Ticks, pflegt die Rolling-Serien je Instrument/Timeframe, wertet
 * die kompilierten Strategie-Regeln (aus `RuleCache`) in Mikrosekunden aus
 * und führt erkannte Matches über den konfigurierten `RuleExecutionAdapter`
 * (Paper oder Live hinter Live-Gate) aus.
 *
 * **Garantien:**
 * - Kein LLM im Ausführungspfad (deterministisch, ~20–100 µs je Tick).
 * - Alle Risk-Limits werden vor der Execution erneut geprüft (fail-closed).
 * - Warmstart: REST-Historie für die Rolling-Serien; Fehler sind sichtbar
 *   (MDERR-006), nicht still verschluckt.
 * - Kill-Switch: bei aktivem Halt werden keine neuen Orders ausgeführt.
 * - Timeframe-Guard (STX-01): Eine Regel mit Timeframe oberhalb des
 *   Ausführungsintervalls wird nie ausgewertet und eröffnet nie eine Position —
 *   fail-closed, aber sichtbar (Counter, Log, `status().ruleGuard`).
 *
 * **Lebenszyklus:** `start()` verbindet die Feeds und startet den Tick-Loop;
 * `stop()` trennt sauber. `status()` liefert Diagnose (Ticks, Matches,
 * Execution-Counts, p95-Eval-Latenz, Serien-Füllung, Seed-Fehler).
 */
export class MicroExecutor {
  private readonly cache: RuleCache;
  private readonly adapter: RuleExecutionAdapter;
  private feeds: MarketFeed[] = [];
  private series = new Map<string, RollingTimeframeSeries>();
  private spreads = new Map<string, number>();
  /** Buch-Tiefe je Symbol (v0.4.0, IAD-T-06) — `depthUsd`, null = nicht verifiziert. */
  private books = new Map<string, number>();
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
  private readonly executionInterval: SupportedTimeframe;

  constructor(opts?: {
    cache?: RuleCache;
    adapter?: RuleExecutionAdapter;
    options?: MicroExecutorOptions;
  }) {
    this.cache = opts?.cache ?? new RuleCache();
    this.adapter =
      opts?.adapter ?? createPaperRuleAdapter({ onFired: (id) => this.cache.noteFired(id) });
    this.options = opts?.options ?? {};
    this.executionInterval = this.options.executionInterval ?? MICRO_EXECUTION_INTERVAL_DEFAULT;
    if (!isSupportedTimeframe(this.executionInterval)) {
      // Ein unbekanntes Intervall würde den Guard unbemerkt aushebeln — lieber beim Start scheitern.
      throw new RangeError(
        `executionInterval "${String(this.executionInterval).slice(0, 20)}" ist kein SupportedTimeframe.`,
      );
    }
  }

  registerFeed(feed: MarketFeed): void {
    this.feeds.push(feed);
  }

  addSymbol(symbolRaw: string, timeframe: string, history: CandleLike[] = []): void {
    const symbol = sanitizeSymbol(symbolRaw);
    if (!symbol) return;
    // Der Guard greift an der einzigen Stelle, an der Serien entstehen:
    // `RuleCache.match` filtert exakt auf den Timeframe der Serie — ohne Serie
    // eines Timeframes wird keine Regel dieses Timeframes ausgewertet.
    const blocked = ruleTimeframeBlockReason(timeframe, this.executionInterval);
    if (blocked) {
      throw new RangeError(
        `Serie ${symbol}:${String(timeframe).slice(0, 20)} abgelehnt (${blocked}, Ausführungsintervall ${this.executionInterval}).`,
      );
    }
    const key = `${symbol}:${timeframe}`;
    if (!this.series.has(key)) {
      this.series.set(key, new RollingTimeframeSeries(symbol, timeframe, history));
    }
  }

  /** Orderbuch-Spread für ein Symbol aktualisieren (für spreadPct-Regeln). */
  updateSpread(symbolRaw: string, spread: number | null): void {
    const symbol = sanitizeSymbol(symbolRaw);
    if (!symbol) return;
    if (spread != null && Number.isFinite(spread) && spread >= 0 && spread <= 0.5) {
      this.spreads.set(symbol, spread);
    } else {
      this.spreads.delete(symbol);
    }
  }

  /**
   * Orderbuch-Tiefe für ein Symbol aktualisieren (v0.4.0, IAD-T-06).
   *
   * Die Qualitätsgrenze greift HIER (am Messpunkt), nicht in der Engine:
   * die Regeln/der Backtest bleiben venue-agnostisch und erhalten pro Symbol
   * ausschließlich ein `bookDepthUsd`, das die Venue-Grenze `VERIFIED`
   * bestanden hat. `book` ist `null`, wenn die Levels die Qualitätsgrenze
   * nicht erreichen ODER das Buch nicht levant ist — es wird NIE als „0
   * Tiefe“ abgelegt, die Regelbedingung liest dann `null` und bleibt stehen.
   */
  updateBook(symbolRaw: string, book: BookDepthInput | null): void {
    const symbol = sanitizeSymbol(symbolRaw);
    if (!symbol) return;
    if (!book) {
      this.books.delete(symbol);
      return;
    }
    const depth = computeBookDepth(book.bids, book.asks, MAX_BOOK_LEVELS);
    if (depth.depthUsd === null) {
      this.books.delete(symbol);
      return;
    }
    const venue = book.venue ? String(book.venue).trim().toUpperCase() : book.venue ?? "";
    const ok =
      venue.length > 0 &&
      depth.depthUsd > 0 &&
      depth.bidLevels > 0 &&
      depth.askLevels > 0 &&
      (bookDepthVerdict(venue, {
        levels: Math.min(depth.bidLevels, depth.askLevels),
        maxAgeMs: null,
      }) === "VERIFIED");
    if (ok) {
      this.books.set(symbol, depth.depthUsd);
    } else {
      this.books.delete(symbol);
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    await this.cache.load();

    // Für JEDE auswertbare aktive Regel eine Rolling-Serie ihres Timeframes
    // sicherstellen (auch 30m/1h — nicht nur die Standard-Timeframes). Der
    // Timeframe-Guard nimmt die übrigen sichtbar heraus: für sie entsteht keine
    // Serie, also wird nie ein Snapshot gegen sie bewertet (STX-01).
    for (const rule of this.cache.allRules()) {
      const reason = this.blockReasonOf(rule);
      if (reason) this.announceBlockedRule(rule, reason);
      else this.addSymbol(rule.symbol, rule.spec.window.timeframe);
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
            // GAP-06 (v1.46.0): Mit den Seed-Kerzen zugleich das Markt-Regime
            // bestimmen (reine Arithmetik; Audit nur bei Wechsel, best-effort).
            // Damit besitzt auch ein separater Mikro-Executor-Prozess ab Start
            // einen Regime-Stand — der Gate-Faktor bleibt sonst fail-safe 1.
            // RMA-P2-01: Feature-Familien aus denselben Artefakten wie die
            // Engine (kanonischer Snapshot; Loader bricht nie).
            try {
              evaluateInstrumentRegime(symbol, candles, { families: loadRegimeFamilyInputs(symbol) });
            } catch {
              /* Regime-Klassifikation darf den Seed nie brechen. */
            }
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

  private blockReasonOf(rule: CachedRule): RuleTimeframeBlockReason | null {
    return ruleTimeframeBlockReason(rule.spec.window.timeframe, this.executionInterval);
  }

  /**
   * Das sichtbare „Nein“ des Timeframe-Guards: Counter (ohne Symbol/Regel-ID als
   * Label — Kardinalitätsregel) plus strukturiertes Log mit allen Bezügen. Läuft
   * je Regel genau einmal, beim Start — nicht je Tick.
   */
  private announceBlockedRule(rule: CachedRule, reason: RuleTimeframeBlockReason): void {
    const timeframe = String(rule.spec.window.timeframe);
    telemetry.microExecutor.ruleBlocked.inc({
      reason,
      timeframe: isSupportedTimeframe(timeframe) ? timeframe : "OTHER",
    });
    structuredLog("warn", "micro_executor_rule_blocked", {
      ruleId: rule.rowId,
      ruleKey: rule.ruleKey,
      version: rule.version,
      symbol: rule.symbol,
      timeframe,
      executionInterval: this.executionInterval,
      reason,
      effect: "Regel wird nicht ausgewertet; aus ihr wird keine Position eröffnet.",
    });
  }

  private handleTick(tick: FeedTick): void {
    if (!this.running) return;
    this.ticks++;
    const symbol = sanitizeSymbol(tick.symbol);
    if (!symbol) return;

    // v0.4.0: Buch-Tick → Tiefen-Cache im RAM aktualisieren (kein Kostenpfad).
    if (tick.kind === "book") {
      this.updateBook(symbol, { venue: tick.venue, bids: tick.bids, asks: tick.asks });
    }

    // Keine Regel für dieses Symbol geladen → Zero-Cost-Tick.
    if (this.cache.candidatesBySymbol(symbol).length === 0) return;
    // Buch-Ticks tragen keine Preise — sie aktualisieren nur die Tiefe.
    if (tick.kind === "book") return;

    const spread = this.spreads.get(symbol) ?? null;
    const bookDepthUsd = this.books.get(symbol) ?? null;
    for (const [key, series] of this.series) {
      const [sym, timeframe] = key.split(":");
      if (sym !== symbol) continue;
      if (tick.kind === "trade") series.touch(tick.price, tick.ts, tick.qty);
      else series.applyCandle(tick.candle, tick.closed);

      const snap = series.snapshot(undefined, spread, bookDepthUsd);
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
            strategyClass: this.cache.strategyClassFor(rule.missionId),
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
      ruleGuard: {
        executionInterval: this.executionInterval,
        blocked: this.cache.allRules().flatMap((rule) => {
          const reason = this.blockReasonOf(rule);
          return reason
            ? [{ ruleId: rule.rowId, symbol: rule.symbol, timeframe: String(rule.spec.window.timeframe), reason }]
            : [];
        }),
      },
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
    // v0.4.0 (IAD-T-06): zusätzlich `@depth5` — der Partial-Book-Snapshot
    // liefert die 5 besten Levels je Seite (~1000 ms Push), genug für die
    // Venue-Qualitätsgrenze (≥ 3 Levels) und die `min(bid,ask)`-Tiefe.
    const streams = valid.map(
      (s) =>
        `${s.toLowerCase()}usdt@trade/${s.toLowerCase()}usdt@kline_1m/${s.toLowerCase()}usdt@depth5`
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
                b?: unknown[][] | null;
                a?: unknown[][] | null;
                k?: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean };
              };
            };
            const data = msg.data;
            if (!data) return;
            const symbol = (data.s ?? "").toUpperCase().replace(/USDT$/, "");
            // v0.4.0: Partial-Book-Depth-Push → Tiefen-Snapshot (nur falls
            // beide Seiten vorliegen; der Executor prüft die Qualitätsgrenze).
            if (data.e === "depthUpdate" && Array.isArray(data.b) && Array.isArray(data.a)) {
              const ts = Number(data.T ?? Date.now());
              const tick: FeedTick = {
                kind: "book",
                symbol,
                venue: "BINANCE",
                ts,
                bids: data.b as unknown as readonly (readonly [unknown, unknown])[],
                asks: data.a as unknown as readonly (readonly [unknown, unknown])[],
              };
              this.tickCount++;
              this.lastTickAt = new Date(ts).toISOString();
              onTick(tick);
              return;
            }
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
