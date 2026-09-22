/**
 * Live-Loader der erweiterten Regime-Featurefamilien (RMA-P2-01, v1.61.0) —
 * SERVER-seitige IO-Schicht um den reinen Vertrag in `regimeFeatures.ts`.
 *
 * Quellen (alle bestehende Artefakte, keine neuen Netzwerkpfade):
 *
 *   liquidity  `data/spread-cache.json`  (FileSpreadCache, gemessener
 *              relativer Spread je Instrument-ID; Key-Auflösung über die
 *              Universe-Registry mit Fallback-Kandidaten)
 *   perp       `data/perpdata/derivatives.json` (Derivative-Cache, nur bei
 *              `PERP_DATA_ENABLED=true`; liefert Funding/OI inkl. Verfügbarkeit)
 *   macro      adaptiver VIX-Zustand (`getAdaptiveRiskState().indicators.VIX`)
 *              mit `at`-Zeitstempel der Bewertung
 *
 * Vertragsregeln:
 *   - Diese Funktion **wirft nie** — fehlende/kaputte/stale Artefakte
 *     ergeben `undefined`-Familien (dann MISSING/STALE im Vertrag), nie einen
 *     erfundenen Wert.
 *   - `availableAt` der Cache-Familien ist der konservative Schreibzeitpunkt
 *     des Artefakts: Inhalte galten früher nicht als bekannt (PIT).
 *   - Rein für den LIVE-Pfad. Backtests/Replays dürfen diesen Loader NICHT
 *     nutzen und übergeben stattdessen PIT-gefilterte `RegimeFamilyInputs`
 *     (z. B. aus Feature-Store- oder Perp-as-of-Abfragen).
 *
 * `marketRegime.ts` importiert dieses Modul bewusst NICHT (Client-Bundle-
 * Grenze: marketData-Importgraph). Engine, Monitor und Micro-Executor laden
 * die Inputs hier und reichen sie an `evaluateInstrumentRegime` weiter.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "./appPaths";
import { getAdaptiveRiskState } from "./riskGuard";
import type { RegimeFamilyInputs } from "./regimeFeatures";

/** Spread-Cache-Pfad (parallel zu `MARKET_SPREAD_CACHE_FILE`, ohne fs-Import dorthin). */
export const REGIME_SPREAD_CACHE_FILE = path.join("data", "spread-cache.json");
/** Derivative-Cache-Pfad (parallel zu `PERP_DERIVATIVE_CACHE_FILE`). */
export const REGIME_PERP_CACHE_FILE = path.join("data", "perpdata", "derivatives.json");

/** Kandidaten-IDs für den Spread-Cache-Lookup (Reihenfolge = Präferenz). */
export function spreadCacheKeyCandidates(symbolRaw: string): string[] {
  const symbol = String(symbolRaw ?? "").trim().toUpperCase();
  if (!symbol) return [];
  const candidates = new Set<string>([symbol]);
  if (symbol.includes(":")) {
    candidates.add(symbol);
    const tail = symbol.slice(symbol.lastIndexOf(":") + 1);
    if (tail) candidates.add(tail);
  } else {
    candidates.add(`PAPER:${symbol}`);
  }
  return [...candidates];
}

type SpreadCacheFile = {
  version?: number;
  writtenAt?: string;
  entries?: Record<string, { spread?: unknown; at?: unknown }>;
};

type PerpCacheFile = {
  writtenAt?: string;
  asOf?: string;
  entries?: Record<
    string,
    {
      fundingRate?: unknown;
      fundingEventTime?: unknown;
      openInterestChange24h?: unknown;
      availability?: unknown;
    }
  >;
};

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function msOrNull(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Liest den Spread-Cache-Inhalt (bricht nie; `null` bei fehlendem/kaputtem File). */
export function readSpreadCacheFile(file: string = REGIME_SPREAD_CACHE_FILE): SpreadCacheFile | null {
  try {
    const resolved = resolveRuntimePath(file);
    if (!existsSync(resolved)) return null;
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as SpreadCacheFile;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.entries !== "object" || parsed.entries === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Liest den Derivative-Cache-Inhalt (bricht nie; `null` bei Problemen). */
export function readPerpCacheFile(file: string = REGIME_PERP_CACHE_FILE): PerpCacheFile | null {
  try {
    const resolved = resolveRuntimePath(file);
    if (!existsSync(resolved)) return null;
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as PerpCacheFile;
    if (parsed === null || typeof parsed !== "object" || typeof parsed.entries !== "object" || parsed.entries === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export type LoadRegimeFamilyInputsOptions = {
  /** As-of-Zeitpunkt (ms) — Defaults `Date.now()`. */
  nowMs?: number;
  /** Env für `PERP_DATA_ENABLED` (Tests/Injektion). */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Datei-Overrides (Tests mit Temp-Verzeichnissen). */
  spreadFile?: string;
  perpFile?: string;
  /** Max. Alter der Cache-Artefakte (ms); Default 24 h. */
  maxCacheAgeMs?: number;
  /** adaptiver Zustand (Injektion; Default `getAdaptiveRiskState`). */
  adaptiveState?: ReturnType<typeof getAdaptiveRiskState>;
};

/**
 * Baut die Roh-Inputs der erweiterten Familien für EIN Instrument zum
 * `asOf`-Zeitpunkt. Wirft nie; fehlende Familien bleiben `undefined`.
 */
export function loadRegimeFamilyInputs(
  symbolRaw: string,
  opts: LoadRegimeFamilyInputsOptions = {}
): RegimeFamilyInputs {
  const nowMs = opts.nowMs ?? Date.now();
  const env = opts.env ?? process.env;
  const maxCacheAgeMs = opts.maxCacheAgeMs ?? 24 * 60 * 60_000;
  const out: RegimeFamilyInputs = {};

  // ── liquidity: Spread-Cache ───────────────────────────────────────────────
  try {
    const cache = readSpreadCacheFile(opts.spreadFile ?? REGIME_SPREAD_CACHE_FILE);
    if (cache) {
      const writtenAtMs = msOrNull(cache.writtenAt);
      const cacheFresh = writtenAtMs != null && nowMs - writtenAtMs <= maxCacheAgeMs && nowMs >= writtenAtMs;
      if (cacheFresh) {
        for (const candidate of spreadCacheKeyCandidates(symbolRaw)) {
          const entry = cache.entries?.[candidate];
          if (!entry) continue;
          const spread = numOrNull(entry.spread);
          const atMs = msOrNull(entry.at);
          if (spread != null && atMs != null) {
            out.liquidity = { relativeSpread: spread, measuredAtMs: atMs };
            break;
          }
        }
      }
    }
  } catch {
    // Loader bricht nie — Familie bleibt MISSING.
  }

  // ── perp: Derivative-Cache (nur mit explizitem Env-Gate) ──────────────────
  try {
    const perpEnabled = String((opts.env ?? process.env).PERP_DATA_ENABLED ?? "").toLowerCase() === "true";
    if (perpEnabled) {
      const cache = readPerpCacheFile(opts.perpFile ?? REGIME_PERP_CACHE_FILE);
      if (cache) {
        const writtenAtMs = msOrNull(cache.writtenAt);
        const cacheFresh =
          writtenAtMs != null && nowMs - writtenAtMs <= maxCacheAgeMs && nowMs >= writtenAtMs;
        if (cacheFresh) {
          for (const candidate of spreadCacheKeyCandidates(symbolRaw)) {
            const entry = cache.entries?.[candidate];
            if (!entry) continue;
            const availability = typeof entry.availability === "string" ? entry.availability : "";
            // Nur belegbare, frische Daten: STALE/MISSING/UNSUPPORTED liefern
            // gar keinen Input (der Vertrag weist sie dann als MISSING aus).
            if (availability !== "AVAILABLE" && availability !== "PARTIAL") continue;
            const fundingRate = numOrNull(entry.fundingRate);
            const fundingEventTimeMs = msOrNull(entry.fundingEventTime);
            if (fundingRate == null || fundingEventTimeMs == null) continue;
            out.perp = {
              fundingRate,
              fundingEventTimeMs,
              openInterestChange24h: numOrNull(entry.openInterestChange24h),
              oiEventTimeMs: fundingEventTimeMs,
              // Konservativ: erst ab Schreibzeit des Artefakts bekannt.
              availableAtMs: writtenAtMs,
            };
            break;
          }
        }
      }
    }
  } catch {
    // Familie bleibt MISSING.
  }

  // ── macro: adaptiver VIX-Zustand (optional) ───────────────────────────────
  try {
    const adaptive = opts.adaptiveState !== undefined ? opts.adaptiveState : getAdaptiveRiskState();
    if (adaptive) {
      const measuredAtMs = msOrNull(adaptive.at);
      const rawVix = (adaptive.indicators as Record<string, unknown> | undefined)?.VIX;
      const vix = numOrNull(rawVix);
      if (measuredAtMs != null && vix != null) {
        out.macro = { vix, measuredAtMs };
      }
    }
  } catch {
    // Familie bleibt MISSING.
  }

  void env;
  return out;
}
