/**
 * Derivative-Kontext-Artefakt (RMA-P2-02) — die sync-Lesbare Brücke zu den
 * Konsumenten.
 *
 * Der Scanner (`ScanDataProvider.derivatives`) und der Analystensnapshot werden
 * **synchron** je Instrument aufgerufen; die kanonische Ablage ist eine
 * as-of-Abfrage (async, Postgres). Diese Datei ist die Schicht dazwischen:
 *
 *   Perp-Sync / `refreshDerivativeCache()` ──► data/perpdata/derivatives.json
 *                                                     │ gelesen beim Scan-Lauf
 *                                                     ▼
 *                                    Scanner-Faktoren / Analystenzeilen
 *
 * Muster des Repos: `src/marketdata/dataErrors.ts` und `syncStatus.ts` — ein
 * klassifiziertes JSON-Artefakt statt IPC. Das löst auch das Cross-Prozess-
 * Problem (CLI schreibt, Next.js-Server liest).
 *
 * ── Drei Regeln, damit die Brücke nicht zur Lüge wird ──────────────────────
 *   1. **Gelesen wird nur, wenn `PERP_DATA_ENABLED=true`.** Sonst verhält sich
 *      der Scanner exakt wie vor v1.54.0 (Neutralwerte), egal was auf Platte
 *      liegt — auch eine Datei von einem früheren Lauf mit eingeschaltetem
 *      Flag.
 *   2. **Alter der Datei zählt gegen die Staleness-Grenze der Funding-Reihe.**
 *      Eine abgelaufene Datei liefert `null` (kein Kontext), nicht die alten
 *      Zahlen: „der letzte Sync ist 3 Tage her“ ist für einen Score keine
 *      Aussage über heute.
 *   3. **Pro Instrument bleibt die Verfügbarkeit erhalten.** `MISSING`,
 *      `STALE`, `UNSUPPORTED` werden mit Grund mitgeschrieben; die Faktoren
 *      sehen `null`-Felder (neutral), nie eine 0.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "../lib/appPaths";
import { perpDataEnabled, type PerpConfig } from "./config";
import { PERP_LIMITS, type PerpOpenInterestBasis } from "./types";
import type { PerpDerivativeSnapshot } from "./consumers";
import type { DerivativeContext } from "../scanner/types";

/** Pfad des Artefakts (läuft dem Kerzen-Fehlermanifest den Rang nicht ab). */
export const PERP_DERIVATIVE_CACHE_FILE = path.join("data", "perpdata", "derivatives.json");

/** Eintrag im Artefakt: die vier Kontextfelder plus Verfügbarkeit/Grund. */
export interface PerpDerivativeCacheEntry extends DerivativeContext {
  venue: string;
  symbol: string;
  availability: PerpDerivativeSnapshot["availability"];
  reasons: PerpDerivativeSnapshot["reasons"];
  fundingEventTime: string | null;
  fundingAgeMs: number | null;
  openInterestBasis: PerpOpenInterestBasis | null;
  liquidationEvents: number | null;
  liquidationNotionalQuote: number | null;
}

export interface PerpDerivativeCache {
  /** Schreibzeitpunkt (Uhr des schreibenden Prozesses). */
  writtenAt: string;
  /** As-of der zugrunde liegenden Abfrage. */
  asOf: string;
  schemaVersion: number;
  /** Politik/Qualität, damit ein Leser die Zahlen einordnen kann. */
  availabilityPolicy: PerpConfig["availabilityPolicy"];
  qualityMode: PerpConfig["qualityMode"];
  entries: Record<string, PerpDerivativeCacheEntry>;
}

function isEntry(value: unknown): value is PerpDerivativeCacheEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.venue === "string" &&
    typeof entry.symbol === "string" &&
    typeof entry.availability === "string" &&
    entry.reasons !== null &&
    typeof entry.reasons === "object"
  );
}

/** Zahl oder `null` (kein Default — `0` ist hier eine Aussage, kein Fallback). */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Baut das Artefakt aus Snapshots (höchstens `PERP_LIMITS.queryInstruments`
 * Einträge, Instrument-IDs auf Länge geprüft — ein Pfad-Fremdtext landet hier
 * nicht).
 */
export function buildPerpDerivativeCache(
  snapshots: Iterable<PerpDerivativeSnapshot>,
  meta: { writtenAt: Date; availabilityPolicy: PerpConfig["availabilityPolicy"]; qualityMode: PerpConfig["qualityMode"] }
): PerpDerivativeCache {
  const entries: Record<string, PerpDerivativeCacheEntry> = {};
  let count = 0;
  for (const snapshot of snapshots) {
    if (count >= PERP_LIMITS.queryInstruments) break;
    const id = String(snapshot.instrumentId).trim().toUpperCase();
    if (!id || id.length > PERP_LIMITS.instrumentIdLength) continue;
    entries[id] = {
      venue: snapshot.venue,
      symbol: snapshot.symbol,
      fundingRate: snapshot.fundingRate,
      fundingIntervalHours: snapshot.fundingIntervalHours,
      openInterest: snapshot.openInterest,
      openInterestChange24h: snapshot.openInterestChange24h,
      availability: snapshot.availability,
      reasons: snapshot.reasons,
      fundingEventTime: snapshot.fundingEventTime,
      fundingAgeMs: snapshot.fundingAgeMs,
      openInterestBasis: snapshot.openInterestBasis,
      liquidationEvents: snapshot.liquidationEvents,
      liquidationNotionalQuote: snapshot.liquidationNotionalQuote,
    };
    count += 1;
  }
  return {
    writtenAt: meta.writtenAt.toISOString(),
    asOf: snapshotsIteratorFirstAsOf(snapshots) ?? meta.writtenAt.toISOString(),
    schemaVersion: 1,
    availabilityPolicy: meta.availabilityPolicy,
    qualityMode: meta.qualityMode,
    entries,
  };
}

function snapshotsIteratorFirstAsOf(snapshots: Iterable<PerpDerivativeSnapshot>): string | null {
  for (const snapshot of snapshots) return snapshot.asOf;
  return null;
}

/** Atomar schreiben (tmp + rename, 0600 — wie der Qualitätsreport). */
export function savePerpDerivativeCache(cache: PerpDerivativeCache, file: string = PERP_DERIVATIVE_CACHE_FILE): string {
  const resolved = resolveRuntimePath(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, resolved);
  return resolved;
}

export interface LoadPerpDerivativeCacheResult {
  cache: PerpDerivativeCache | null;
  /** Warum nicht gelesen wurde (stabil; `null` = gelesen). */
  reason:
    | null
    | "DISABLED"
    | "FILE_MISSING"
    | "FILE_INVALID"
    | "FILE_STALE"
    | "EMPTY";
  ageMs: number | null;
  entries: number;
}

/**
 * Lädt das Artefakt. `null` **ohne** Ausnahme — diese Funktion wirft nie, weil
 * sie im Scanner-Laufpfad sitzt; der Grund wird mitgeliefert, damit ein
 * Consumer ihn melden kann, statt ihn zu erraten.
 */
export function loadPerpDerivativeCache(
  options: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    nowMs?: number;
    /** Altersgrenze des Artefakts (Default: Staleness-Grenze Funding). */
    maxAgeMs?: number;
    file?: string;
  } = {}
): LoadPerpDerivativeCacheResult {
  const nowMs = options.nowMs ?? Date.now();
  const empty: LoadPerpDerivativeCacheResult = { cache: null, reason: "DISABLED", ageMs: null, entries: 0 };
  if (!perpDataEnabled(options.env ?? process.env)) return empty;
  const resolved = resolveRuntimePath(options.file ?? PERP_DERIVATIVE_CACHE_FILE);
  if (!existsSync(resolved)) return { ...empty, reason: "FILE_MISSING" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    return { ...empty, reason: "FILE_INVALID" };
  }
  if (parsed === null || typeof parsed !== "object") return { ...empty, reason: "FILE_INVALID" };
  const candidate = parsed as Partial<PerpDerivativeCache>;
  if (
    typeof candidate.writtenAt !== "string" ||
    typeof candidate.asOf !== "string" ||
    candidate.entries === null ||
    typeof candidate.entries !== "object"
  ) {
    return { ...empty, reason: "FILE_INVALID" };
  }
  const writtenAtMs = Date.parse(candidate.writtenAt);
  const ageMs = Number.isFinite(writtenAtMs) ? Math.max(0, nowMs - writtenAtMs) : null;
  const maxAgeMs = options.maxAgeMs ?? 24 * 3_600_000;
  if (ageMs === null || ageMs > maxAgeMs) {
    return { ...empty, reason: "FILE_STALE", ageMs };
  }
  const entries: Record<string, PerpDerivativeCacheEntry> = {};
  let count = 0;
  for (const [key, value] of Object.entries(candidate.entries as Record<string, unknown>)) {
    if (count >= PERP_LIMITS.queryInstruments) break;
    if (!isEntry(value)) continue;
    entries[key] = {
      venue: value.venue,
      symbol: value.symbol,
      fundingRate: numOrNull((value as unknown as Record<string, unknown>).fundingRate),
      fundingIntervalHours: numOrNull((value as unknown as Record<string, unknown>).fundingIntervalHours),
      openInterest: numOrNull((value as unknown as Record<string, unknown>).openInterest),
      openInterestChange24h: numOrNull((value as unknown as Record<string, unknown>).openInterestChange24h),
      availability: value.availability,
      reasons: value.reasons,
      fundingEventTime:
        typeof value.fundingEventTime === "string" ? value.fundingEventTime : null,
      fundingAgeMs: numOrNull(value.fundingAgeMs),
      openInterestBasis:
        value.openInterestBasis === "contracts" ||
        value.openInterestBasis === "base_units" ||
        value.openInterestBasis === "quote_units"
          ? value.openInterestBasis
          : null,
      liquidationEvents: numOrNull(value.liquidationEvents),
      liquidationNotionalQuote: numOrNull(value.liquidationNotionalQuote),
    };
    count += 1;
  }
  if (count === 0) return { cache: { ...candidate, entries } as PerpDerivativeCache, reason: "EMPTY", ageMs, entries: 0 };
  return { cache: { ...candidate, entries } as PerpDerivativeCache, reason: null, ageMs, entries: count };
}

/** Artefakt → Map für den Scanner-Provider (`null`, wenn nichts lesbar ist). */
export function perpDerivativeContextsFromCache(
  options: Parameters<typeof loadPerpDerivativeCache>[0] = {}
): { map: ReadonlyMap<string, DerivativeContext> | null; reason: LoadPerpDerivativeCacheResult["reason"]; entries: number } {
  const loaded = loadPerpDerivativeCache(options);
  if (loaded.cache === null || loaded.reason !== null) {
    return { map: null, reason: loaded.reason ?? "FILE_INVALID", entries: 0 };
  }
  const map = new Map<string, DerivativeContext>();
  for (const [id, entry] of Object.entries(loaded.cache.entries)) {
    map.set(id, {
      fundingRate: entry.fundingRate,
      fundingIntervalHours: entry.fundingIntervalHours,
      openInterest: entry.openInterest,
      openInterestChange24h: entry.openInterestChange24h,
    });
  }
  return { map: map.size > 0 ? map : null, reason: null, entries: map.size };
}

