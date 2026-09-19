/**
 * CLUSTER-EXPOSURE-GUARDRAIL — Guardrail-Schicht 3 des riskGuard (GAP-04,
 * v1.48.0, D2).
 *
 * Verhindert, dass 5 „unabhängige“ Trades in Wahrheit ein BTC-Beta-Trade
 * sind: Vor der Freigabe wird das neue Symbol gegen die OFFENEN Positionen
 * korrelationsgeclustert. Die Korrelations-Mathematik wird NICHT dupliziert,
 * sondern aus `src/portfolio` importiert (`correlationMatrix` +
 * `correlationClusters` — die bereits getestete Task-05-Mathematik).
 *
 * Datenquelle: der append-only HistoricalStore (lokale Kerzen, `1h`-Reihe,
 * `DEFAULT_ANALYSIS_TIMEFRAME`-Konvention) — rollierende logarithmische
 * Renditen über ein gemeinsames Zeitstempel-Intersection (zeitlich aligned,
 * kein Positions-Guessing bei Lücken). KEIN Netzwerk, KEIN Hintergrund-Job:
 * die Berechnung läuft nur je Order-Prüfung, mit TTL-Cache
 * (`RISK_CORR_CACHE_TTL_MS`).
 *
 * Limits (Bounds + Defaults, s. CONFIGURATION.md):
 *   RISK_CORR_THRESHOLD      Default 0.7   (Bounds [0.3, 0.99])
 *   RISK_MAX_PER_CLUSTER     Default 3     (Bounds [1, 10])
 *   RISK_CORR_WINDOW_CANDLES Default 90    (Bounds [30, 365])
 *   RISK_CORR_CACHE_TTL_MS   Default 900000 (Bounds [60000, 3600000])
 *   RISK_CLUSTER_LIMITS_MODE monitor (Default) | enforce
 *
 * FAIL-CLOSED: Fehlen die Korrelationsdaten (keine Kerzen im Store, Symbol
 * nicht auflösbar, zu wenige gemeinsame Zeitstempel, Daten älter als
 * 24 h), wird die Aufstockung in MÖGLICHERWEISE korrelierte Cluster in
 * enforce-Modus abgelehnt (`cluster-exposure:correlation-stale`) — statt zu
 * raten. In monitor-Modus bleibt die Entscheidung unverändert; die
 * Würde-Prüfung wird als Audit-Notiz + Log protokolliert.
 *
 * RECHNUNG je Order-Prüfung (kein Hintergrund-Job):
 *   1. Cache-Treffer (Symbol-Menge + Fenster + Schwelle, TTL) → verwenden.
 *   2. Sonst frische Berechnung aus dem HistoricalStore (lokal, schnell).
 *   3. `correlationClusters` (Single-Linkage, |ρ| ≥ Schwelle) →
 *      Cluster des neuen Symbols; Count = offene Mitglieder + 1 (neu).
 *   4. Count > RISK_MAX_PER_CLUSTER → VIOLATION
 *      (`cluster-exposure:max-per-cluster:N`), enforce = Ablehnung.
 *
 * Audit (revisionssicher, auditClass=security, at-least-once):
 *   - monitor + Verstoß/Stale  → `CLUSTER_EXPOSURE_MONITOR`  (wouldBlock)
 *   - enforce + Verstoß/Stale  → `CLUSTER_EXPOSURE_BLOCKED`
 *   - OK → kein Eintrag (kein Lärm pro Order).
 */

import {
  correlationClusters,
  correlationMatrix,
  type CorrelationCluster,
  type CorrelationMatrix,
} from "@/portfolio";
import { HistoricalStore, type SupportedTimeframe } from "./marketdata/historicalStore";
import { getProductionMarketDataManager } from "./marketdata/production";
import { auditWrite } from "./auditSink";
import { structuredLog } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Konfiguration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `monitor` (Default): Entscheidungspfad UNVERÄNDERT, Verstoß/Stale wird nur
 * als Audit-Notiz + Log mit der Würde-Prüfung protokolliert (Rollout-first).
 * `enforce`: echte Ablehnung mit maschinenlesbarem Grund.
 * Unbekannter Wert → `monitor` + Warnung (bewusster Rollout-Default).
 */
export type ClusterLimitsMode = "monitor" | "enforce";

export interface ClusterLimitsConfig {
  mode: ClusterLimitsMode;
  /** |ρ|-Schwelle für die Clustering-Union. */
  threshold: number;
  /** Max. offene Positionen je Korrelations-Cluster. */
  maxPerCluster: number;
  /** Renditen-Fenster in Kerzen (1h-Reihe). */
  windowCandles: number;
  /** Cache-TTL der Korrelations-Berechnung (ms). */
  cacheTtlMs: number;
}

/** Erlaubtes Fenster pro numerischem Flag — Werte werden geklemmt. */
export const CLUSTER_LIMITS_BOUNDS = {
  threshold: [0.3, 0.99] as const,
  maxPerCluster: [1, 10] as const,
  windowCandles: [30, 365] as const,
  cacheTtlMs: [60_000, 3_600_000] as const,
};

export const DEFAULT_CLUSTER_LIMITS_CONFIG: ClusterLimitsConfig = {
  mode: "monitor",
  threshold: 0.7,
  maxPerCluster: 3,
  windowCandles: 90,
  cacheTtlMs: 900_000,
};

/**
 * Kerzen-Periodizität der Cluster-Renditen: `1h` (Analyse-Standard des
 * HistoricalStore; 90 Kerzen ≈ 3,75 Tage — genug Signal, wenig Noise).
 */
export const CLUSTER_TIMEFRAME: SupportedTimeframe = "1h";

/** Daten gelten als STALE, wenn die jüngste verwendete Kerze älter ist. */
export const CLUSTER_DATA_FRESH_MS = 24 * 60 * 60 * 1000;

/** Mindestanzahl gemeinsamer Renditen — darunter keine Aussage (fail-closed). */
const MIN_COMMON_RETURNS = 20;

function parseFinite(value: unknown): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function clampNumber(value: unknown, bounds: readonly [number, number], fallback: number): number {
  const n = parseFinite(value);
  if (n == null) return fallback;
  return Math.min(Math.max(n, bounds[0]), bounds[1]);
}

function clampInt(value: unknown, bounds: readonly [number, number], fallback: number): number {
  const n = parseFinite(value);
  if (n == null) return fallback;
  return Math.round(Math.min(Math.max(n, bounds[0]), bounds[1]));
}

function parseMode(raw: unknown): ClusterLimitsMode {
  if (raw === "monitor" || raw === "enforce") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    console.warn(`[cluster-exposure] unbekannter Modus "${raw}" → monitor (Rollout-Default)`);
  }
  return "monitor";
}

/**
 * Lädt und klemmt das Cluster-Limits-Setup aus der Umgebung (Env ist die
 * Single Source of Truth für diese Schicht — wie Exit-/Regime-Flags).
 */
export function loadClusterLimitsConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ClusterLimitsConfig {
  return {
    mode: parseMode(env.RISK_CLUSTER_LIMITS_MODE),
    threshold: clampNumber(env.RISK_CORR_THRESHOLD, CLUSTER_LIMITS_BOUNDS.threshold, DEFAULT_CLUSTER_LIMITS_CONFIG.threshold),
    maxPerCluster: clampInt(env.RISK_MAX_PER_CLUSTER, CLUSTER_LIMITS_BOUNDS.maxPerCluster, DEFAULT_CLUSTER_LIMITS_CONFIG.maxPerCluster),
    windowCandles: clampInt(env.RISK_CORR_WINDOW_CANDLES, CLUSTER_LIMITS_BOUNDS.windowCandles, DEFAULT_CLUSTER_LIMITS_CONFIG.windowCandles),
    cacheTtlMs: clampInt(env.RISK_CORR_CACHE_TTL_MS, CLUSTER_LIMITS_BOUNDS.cacheTtlMs, DEFAULT_CLUSTER_LIMITS_CONFIG.cacheTtlMs),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Korrelations-Quelle (HistoricalStore) + TTL-Cache
// ─────────────────────────────────────────────────────────────────────────────

export interface ClusterCorrelationData {
  /** Matrix über die übergebenen Symbole (in dieser Reihenfolge). */
  matrix: CorrelationMatrix;
  /** Anzahl gemeinsamer Renditen-Beobachtungen. */
  observations: number;
  /** Zeitstempel (ms) der jüngsten verwendeten Kerze. */
  lastTs: number;
  /** Berechnungszeitpunkt (ms) — Basis der TTL. */
  computedAt: number;
}

/**
 * Injizierbare Korrelations-Quelle. `null` = nicht berechenbar
 * (fail-closed: der Caller wertet das als STALE).
 */
export type CorrelationSource = (symbols: string[], windowCandles: number) => Promise<ClusterCorrelationData | null>;

const G = globalThis as typeof globalThis & {
  __clusterCorrCache?: Map<string, ClusterCorrelationData>;
  __clusterCorrSource?: CorrelationSource;
};

const corrCache = (G.__clusterCorrCache ??= new Map());

function cacheKey(symbols: string[], windowCandles: number, threshold: number): string {
  return [...symbols].sort().join("|") + `|w${windowCandles}|t${threshold}`;
}

/**
 * Default-Quelle: Kerzen aus dem lokalen HistoricalStore (append-only NDJSON),
 * 1h-Reihe, gemeinsame Zeitstempel-Intersection, logarithmische Renditen.
 * `null` bei: unauflösbarem Instrument, < MIN_COMMON_RETURNS+2 Kerzen je
 * Symbol oder < MIN_COMMON_RETURNS gemeinsamen Renditen (fail-closed).
 */
export function createHistoricalStoreSource(opts: {
  store?: HistoricalStore;
  timeframe?: SupportedTimeframe;
  resolveInstrumentId?: (symbol: string) => string | null;
} = {}): CorrelationSource {
  const timeframe = opts.timeframe ?? CLUSTER_TIMEFRAME;
  const resolveId = opts.resolveInstrumentId ?? defaultResolveInstrumentId;
  let store: HistoricalStore | null = null;
  const getStore = (): HistoricalStore => (store ??= opts.store ?? new HistoricalStore());

  return async (symbols, windowCandles): Promise<ClusterCorrelationData | null> => {
    if (symbols.length < 2) return null;
    const perSymbol: Array<{ symbol: string; closes: Map<number, number> }> = [];
    for (const s of symbols) {
      let id: string | null = null;
      try {
        id = resolveId(s);
      } catch {
        id = null;
      }
      if (!id) return null; // Symbol nicht auflösbar → keine Aussage (fail-closed).
      const rows = getStore().query({ instrumentId: id, timeframe, limit: windowCandles + 2 });
      const closes = new Map<number, number>();
      for (const r of rows) {
        if (r.close > 0) closes.set(r.ts, r.close);
      }
      if (closes.size < MIN_COMMON_RETURNS + 2) return null;
      perSymbol.push({ symbol: s, closes });
    }

    // Gemeinsame Zeitachse (Intersection), aufsteigend, jüngste `window+1`
    // Kerzen → `window` log-Renditen, zeitlich aligned über ALLE Symbole.
    const [first, ...rest] = perSymbol;
    const common = [...first.closes.keys()]
      .filter((ts) => rest.every((p) => p.closes.has(ts)))
      .sort((a, b) => a - b)
      .slice(-(windowCandles + 1));
    if (common.length < MIN_COMMON_RETURNS + 1) return null;

    const series = perSymbol.map((p) => {
      const out: number[] = [];
      for (let i = 1; i < common.length; i++) {
        const c0 = p.closes.get(common[i - 1])!;
        const c1 = p.closes.get(common[i])!;
        out.push(Math.log(c1 / c0));
      }
      return out;
    });

    const matrix = correlationMatrix(series, { symbols });
    return {
      matrix,
      observations: common.length - 1,
      lastTs: common[common.length - 1],
      computedAt: Date.now(),
    };
  };
}

/**
 * Instrument-Resolver: Positions-Symbol (kanonisch, z. B. `BTC`, `AAPL`,
 * `EUR/USD`) → Instrument-ID des Universums (z. B. `PAPER:BTC`), unter der
 * die HistoricalStore-Kerzen liegen. Registry nicht erreichbar → `null`
 * (fail-closed: Guardrail wertet das als STALE, nie als „unkorrelliert“).
 */
function defaultResolveInstrumentId(symbol: string): string | null {
  try {
    const manager = getProductionMarketDataManager();
    const bySymbol = manager.resolveInstrument(symbol);
    if (bySymbol) return bySymbol.id;
    const byId = manager.resolveInstrument(`PAPER:${symbol}`);
    return byId?.id ?? null;
  } catch {
    return null;
  }
}

let defaultSourceInstance: CorrelationSource | null = null;

/** Default-Quelle (Prozess-Singleton; Tests injizieren eigene Quellen). */
export function getDefaultCorrelationSource(): CorrelationSource {
  defaultSourceInstance ??= G.__clusterCorrSource ?? createHistoricalStoreSource();
  return defaultSourceInstance;
}

/** Test-Hook: Default-Quelle ersetzen (z. B. inquirer-freie Integrationstests). */
export function setDefaultCorrelationSourceForTests(source: CorrelationSource | null): void {
  G.__clusterCorrSource = source ?? undefined;
  defaultSourceInstance = null;
}

/** Cache-Status für Observability (GET /api/firm/risk). */
export function getClusterCacheStatus(now: number = Date.now()): {
  entries: number;
  lastComputedAt: string | null;
  stale: boolean;
} {
  let last: number | null = null;
  for (const v of corrCache.values()) {
    if (last == null || v.computedAt > last) last = v.computedAt;
  }
  const ttl = loadClusterLimitsConfig().cacheTtlMs;
  return {
    entries: corrCache.size,
    lastComputedAt: last != null ? new Date(last).toISOString() : null,
    stale: last == null || now - last > ttl,
  };
}

/** Test-Reset: Cache + injizierte Default-Quelle zurücksetzen. */
export function __resetClusterExposureForTests(): void {
  corrCache.clear();
  G.__clusterCorrSource = undefined;
  defaultSourceInstance = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reiner Kern: Cluster-Beurteilung (unit-testbar, kein I/O)
// ─────────────────────────────────────────────────────────────────────────────

export type ClusterVerdict =
  | {
      status: "OK";
      clusters: CorrelationCluster[];
      /** Mitglieder des Clusters, in das das neue Symbol fällt. */
      clusterOfSymbol: string[];
      /** Offene Mitglieder + 1 (das neue Symbol). */
      count: number;
      limit: number;
      reason: string;
    }
  | {
      status: "VIOLATION";
      clusters: CorrelationCluster[];
      clusterOfSymbol: string[];
      count: number;
      limit: number;
      /** Maschinenlesbarer Ablehnungsgrund. */
      code: string;
      reason: string;
    }
  | {
      status: "STALE";
      code: string;
      reason: string;
    };

/**
 * Beurteilt die Cluster-Exposure einer neuen Position (REIN, deterministisch).
 *
 * - `matrix === null` → STALE (keine Daten = keine Aussage).
 * - `dataAgeMs > maxDataAgeMs` (Default 24 h) → STALE.
 * - Count des Clusters des neuen Symbols (offene Mitglieder + 1) >
 *  `maxPerCluster` → VIOLATION.
 */
export function assessClusterExposure(input: {
  symbol: string;
  openSymbols: readonly string[];
  matrix: CorrelationMatrix | null;
  threshold: number;
  maxPerCluster: number;
  /** Alter der Daten (now − jüngste Kerze) in ms; undefined = frisch. */
  dataAgeMs?: number;
  /** Max. Datenalter in ms (Default CLUSTER_DATA_FRESH_MS). */
  maxDataAgeMs?: number;
}): ClusterVerdict {
  const maxDataAge = input.maxDataAgeMs ?? CLUSTER_DATA_FRESH_MS;
  if (input.matrix == null) {
    return {
      status: "STALE",
      code: "cluster-exposure:correlation-stale",
      reason: "Korrelationsdaten nicht verfügbar — keine Aussage möglich (fail-closed).",
    };
  }
  if (input.dataAgeMs != null && input.dataAgeMs > maxDataAge) {
    return {
      status: "STALE",
      code: "cluster-exposure:correlation-stale",
      reason: `Korrelationsdaten älter als ${Math.round(maxDataAge / 3_600_000)} h — keine Aussage möglich (fail-closed).`,
    };
  }

  const clusters = correlationClusters(input.matrix, input.threshold);
  const target = input.symbol.toUpperCase();
  const cluster = clusters.find((c) => c.symbols.some((s) => s.toUpperCase() === target));
  if (!cluster) {
    // Kann nur bei inkonsistenter Matrix passieren — konservativ statt raten.
    return {
      status: "STALE",
      code: "cluster-exposure:correlation-stale",
      reason: "Neues Symbol nicht in der Korrelationsmatrix gefunden (fail-closed).",
    };
  }
  const count =
    1 + input.openSymbols.filter((s) => cluster.symbols.some((m) => m.toUpperCase() === s.toUpperCase())).length;
  const limit = input.maxPerCluster;
  if (count > limit) {
    return {
      status: "VIOLATION",
      clusters,
      clusterOfSymbol: cluster.symbols,
      count,
      limit,
      code: `cluster-exposure:max-per-cluster:${limit}`,
      reason: `Cluster ${cluster.symbols.join("/")} hätte ${count} Positionen — Limit ${limit} (Schwelle ${input.threshold}).`,
    };
  }
  return {
    status: "OK",
    clusters,
    clusterOfSymbol: cluster.symbols,
    count,
    limit,
    reason: `Cluster ${cluster.symbols.join("/")} mit ${count} Positionen ≤ Limit ${limit}.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Order-Pfad-Wrapper: Cache + Modus + Audit
// ─────────────────────────────────────────────────────────────────────────────

export interface ClusterExposureCheckInput {
  /** Neues Symbol (kanonisch). */
  symbol: string;
  /** Andere offene Positionssymbole (ohne das neue Symbol). */
  openSymbols: readonly string[];
  /** Override des Modus (Default: Env-Config). */
  mode?: ClusterLimitsMode;
  /** Override der numerischen Config (geklemmt; Default: Env-Config). */
  cfg?: Partial<Omit<ClusterLimitsConfig, "mode">>;
  /** Injizierte Korrelations-Quelle (Default: HistoricalStore). */
  source?: CorrelationSource;
  /** Uhrzeit (ms) für Cache/Altersprüfungen (Default Date.now()). */
  now?: number;
  missionId?: string | null;
  agentId?: string | null;
}

export interface ClusterExposureCheckResult {
  /** false = enforce + Verstoß/Stale → Order wird abgelehnt. */
  allowed: boolean;
  /** Menschenlesbare Begründung (mit Code bei Ablehnung). */
  reason: string;
  /** Maschinenlesbar: [] | ["cluster-exposure:max-per-cluster:N"] | ["cluster-exposure:correlation-stale"]. */
  blockedBy: string[];
  verdict: "OK" | "VIOLATION" | "STALE";
  mode: ClusterLimitsMode;
  clusterOfSymbol: string[] | null;
  clusters: CorrelationCluster[] | null;
  /** true = ein audit_log-Eintrag wurde (bestanden) geschrieben. */
  auditWritten: boolean;
}

/**
 * Führt die Guardrail-Prüfung für eine neue Order aus (je Order-Prüfung,
 * mit TTL-Cache; KEIN Hintergrund-Job). Schreibt je Guardrail-Entscheidung
 * (Verstoß/Stale — in beiden Modi) einen revisionssicheren audit_log-Eintrag.
 *
 * monitor (Default): `allowed` ist IMMER true — die Würde-Prüfung wird nur
 * protokolliert. enforce: Verstoß/Stale → `allowed = false`.
 *
 * Wirft nicht: Source-Fehler werden als STALE gewertet (fail-closed).
 */
export async function checkClusterExposure(
  input: ClusterExposureCheckInput
): Promise<ClusterExposureCheckResult> {
  const envCfg = loadClusterLimitsConfig();
  const cfg: ClusterLimitsConfig = {
    mode: envCfg.mode,
    threshold: clampNumber(input.cfg?.threshold ?? envCfg.threshold, CLUSTER_LIMITS_BOUNDS.threshold, envCfg.threshold),
    maxPerCluster: clampInt(input.cfg?.maxPerCluster ?? envCfg.maxPerCluster, CLUSTER_LIMITS_BOUNDS.maxPerCluster, envCfg.maxPerCluster),
    windowCandles: clampInt(input.cfg?.windowCandles ?? envCfg.windowCandles, CLUSTER_LIMITS_BOUNDS.windowCandles, envCfg.windowCandles),
    cacheTtlMs: clampInt(input.cfg?.cacheTtlMs ?? envCfg.cacheTtlMs, CLUSTER_LIMITS_BOUNDS.cacheTtlMs, envCfg.cacheTtlMs),
  };
  const mode: ClusterLimitsMode = input.mode ?? cfg.mode;
  const now = input.now ?? Date.now();
  const symbol = input.symbol.toUpperCase();
  const openSymbols = [
    ...new Set(
      input.openSymbols
        .map((s) => String(s).toUpperCase())
        .filter((s) => s !== symbol && s !== "")
    ),
  ];

  // Keine offene Position → kein Cluster zu prüfen (nichts, womit
  // korreliert werden könnte). Ohne Datenbedarf, ohne Audit-Lärm.
  if (openSymbols.length === 0) {
    return {
      allowed: true,
      reason: "Keine anderen offenen Positionen — keine Cluster-Prüfung nötig.",
      blockedBy: [],
      verdict: "OK",
      mode,
      clusterOfSymbol: [symbol],
      clusters: null,
      auditWritten: false,
    };
  }

  // 1) Cache (Symbol-Menge + Fenster + Schwelle), sonst frische Berechnung.
  const key = cacheKey([symbol, ...openSymbols], cfg.windowCandles, cfg.threshold);
  const hit = corrCache.get(key);
  let data: ClusterCorrelationData | null =
    hit && now - hit.computedAt < cfg.cacheTtlMs ? hit : null;
  if (data == null) {
    const source = input.source ?? getDefaultCorrelationSource();
    try {
      data = await source([symbol, ...openSymbols], cfg.windowCandles);
    } catch {
      data = null; // Source-Fehler = keine Daten (fail-closed).
    }
    if (data) corrCache.set(key, data);
  }

  // 2) Beurteilung (stale Daten → konservativ).
  const verdict = assessClusterExposure({
    symbol,
    openSymbols,
    matrix: data?.matrix ?? null,
    threshold: cfg.threshold,
    maxPerCluster: cfg.maxPerCluster,
    dataAgeMs: data ? now - data.lastTs : undefined,
  });

  // 3) Modus-Übersetzung + Audit.
  const blocked = mode === "enforce" && verdict.status !== "OK";
  let auditWritten = false;
  if (verdict.status !== "OK") {
    const code = verdict.status === "VIOLATION" ? verdict.code : "cluster-exposure:correlation-stale";
    const detail: Record<string, unknown> = {
      symbol,
      openSymbols,
      mode,
      verdict: verdict.status,
      code,
      reason: verdict.reason,
      wouldBlock: mode === "monitor",
      threshold: cfg.threshold,
      maxPerCluster: cfg.maxPerCluster,
      windowCandles: cfg.windowCandles,
      data: data
        ? { observations: data.observations, lastTs: new Date(data.lastTs).toISOString(), ageMs: now - data.lastTs }
        : null,
    };
    if (verdict.status === "VIOLATION") {
      detail.clusterOfSymbol = verdict.clusterOfSymbol;
      detail.count = verdict.count;
      detail.limit = verdict.limit;
    }
    const event = mode === "monitor" ? "CLUSTER_EXPOSURE_MONITOR" : "CLUSTER_EXPOSURE_BLOCKED";
    try {
      const res = await auditWrite(event, "WARN", detail, {
        auditClass: "security",
        missionId: input.missionId ?? undefined,
        agentId: input.agentId ?? undefined,
      });
      auditWritten = res.durable;
    } catch {
      auditWritten = false;
    }
    const logMsg = `${symbol}: ${verdict.status} — ${code} (Modus ${mode}${mode === "monitor" ? ", keine Ablehnung" : ", abgelehnt"})`;
    if (mode === "enforce") console.warn(`[cluster-exposure] ${logMsg}`);
    else structuredLog("warn", "cluster_exposure_would_block", { symbol, code, count: verdict.status === "VIOLATION" ? verdict.count : null, mode });
  }

  return {
    allowed: !blocked,
    reason: verdict.reason,
    blockedBy: blocked ? [verdict.status === "VIOLATION" ? verdict.code : "cluster-exposure:correlation-stale"] : [],
    verdict: verdict.status,
    mode,
    clusterOfSymbol: verdict.status === "STALE" ? null : verdict.clusterOfSymbol,
    clusters: verdict.status === "STALE" ? null : verdict.clusters,
    auditWritten,
  };
}
