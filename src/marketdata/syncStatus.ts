/**
 * Persistenter Sync-Status je Venue (OPS-011, aufbauend auf MDSYNC-001).
 *
 * Der MarketData-Sync (`npm run market:sync`) und das Operations Center
 * laufen als getrennte Prozesse. Damit das Ops-Center **ohne Netzwerk-I/O**
 * den Zeitpunkt des letzten Syncs je Venue, das degraded-Flag und die
 * Fehlerzähler nach Ursache kennt, schreibt der Sync-Entry-Point eine
 * kompakte Projektion des `SyncResult` hierher:
 *
 *   data/market-sync-status.json   (gitignored, Laufzeit-Artefakt)
 *
 * Konsumenten:
 *  - `src/ops/collectMarketData.ts` → `MarketDataOpsSnapshot.venues`
 *    (Ops-Panel „Market Data“: letzter Sync, degraded, Fehler nach Ursache).
 *
 * Security (geschlossene Aufzählung, Review-Auflage):
 *  - Persistiert werden nur Zähler und die klassifizierte `reason`-Taxonomie
 *    (`MarketDataErrorReason`, MDERR-006) — **keine** rohen Upstream-Messages,
 *    keine URLs, keine Symbole, keine Secrets.
 *  - Venue-Namen werden gegen eine Whitelist-Form validiert, die Datei ist
 *    auf {@link MAX_STATUS_VENUES} Venues gekappt (kein Response-Wachstum).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isMarketDataErrorReason } from "../lib/marketDataErrors";
import { resolveRuntimePath } from "../lib/appPaths";
import type { SyncResult } from "./types";

/** Ablage des Sync-Status (gitignored wie das Fehler-Manifest daneben).
 *  Bewusst relativ gehalten (`data/...`) — beim Lesen/Schreiben wird über
 *  `resolveRuntimePath` aufgelöst, damit CLI (cwd Projekt-Root) und
 *  Next.js-Server (möglicherweise anderer cwd/`DATA_DIR`) dieselbe Datei sehen.
 *  Vorher nutzte nur der Sync-Status `path.join("data",...)` direkt, während
 *  `HistoricalStore`/`InstrumentRegistry` bereits `resolveRuntimePath` nutzten —
 *  Folge: Ops-Center (Next.js) las einen anderen Pfad als die CLI schrieb
 *  ("zuletzt 2026-09-17" vs. "2026-09-18", lastSync 26 vs. 250).
 */
export const MARKET_SYNC_STATUS_FILE = path.join("data", "market-sync-status.json");

/** Harte Obergrenze gespeicherter Venues (Kappung, kein Response-Wachstum). */
export const MAX_STATUS_VENUES = 10;

/** Erlaubte Venue-Form (Großbuchstaben/Ziffern/Unterstrich, wie `KNOWN_SYNC_VENUES`). */
const VENUE_RE = /^[A-Z0-9_]{1,32}$/;

/**
 * Erlaubte Timeframe-Form für `staleByTimeframe` (geschlossene Allowlist des
 * Historical Store: 1m,3m,5m,15m,30m,1h,2h,4h,1d,5d). Kein Freitext —
 * sonst wäre das Status-Feld ein unbegrenzter Label-Raum.
 */
const STALE_TIMEFRAME_RE = /^(1m|3m|5m|15m|30m|1h|2h|4h|1d|5d)$/;

/** Kompakte, credentials-freie Projektion eines `SyncResult` je Venue. */
export interface VenueSyncStatus {
  /** Venue-Key in Großbuchstaben (z. B. `"BITUNIX"`). */
  venue: string;
  /** `finishedAt` des letzten Laufs (ISO-8601 UTC) oder `null`. */
  lastSyncAt: string | null;
  /** `degraded`-Flag des letzten Laufs (Fehler vorhanden, Lauf fortgesetzt). */
  lastSyncDegraded: boolean;
  /** Tatsächlich synchronisierte Instrumente (`SyncResult.synced`). */
  instruments: number;
  /**
   * Fehlerzähler nach klassifizierter Ursache (MDERR-006-Taxonomie).
   * Geschlossene Aufzählung: unklassifizierte Fehler zählen als `UNKNOWN`,
   * rohe Upstream-Messages werden nie gespeichert.
   */
  failuresByReason: Record<string, number>;
  /**
   * Stale-Guard (GAP-07): Reihen (`Instrument ⟂ Timeframe`) der Venue, deren
   * jüngste Kerze die TF-Schwelle (`MARKETDATA_STALE_*_HOURS`) überschreitet.
   * Ausschließlich ZÄHLER — keine Instrument-IDs (keine Symbole im Status,
   * dieselbe Security-Policy wie oben). `undefined` = Guard nicht gelaufen
   * (Altbestände/ältere CLI).
   */
  staleSeries?: number;
  /** Stale-Reihen je Timeframe (nur Timeframes mit Befund, erlaubte TF-Keys). */
  staleByTimeframe?: Record<string, number>;
}

interface SyncStatusManifest {
  writtenAt: string;
  venues: VenueSyncStatus[];
}

/**
 * Projiziert ein `SyncResult` in den persistierbaren Venue-Status.
 * Reine Funktion — zählt `failures` nach geschlossener `reason`-Taxonomie.
 */
export function syncResultToVenueStatus(result: SyncResult): VenueSyncStatus {
  const failuresByReason: Record<string, number> = {};
  for (const failure of result.failures) {
    const reason = isMarketDataErrorReason(failure.reason) ? failure.reason : "UNKNOWN";
    failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
  }
  return {
    venue: String(result.venue ?? "").trim().toUpperCase().slice(0, 32),
    lastSyncAt: typeof result.finishedAt === "string" && result.finishedAt ? result.finishedAt : null,
    lastSyncDegraded: result.degraded === true,
    instruments: Number.isFinite(result.synced) ? Math.max(0, Math.floor(result.synced)) : 0,
    failuresByReason,
  };
}

/**
 * Persistiert den Status eines Laufs atomar (tmp + rename, Modus 0600).
 * Bestehende Einträge anderer Venues bleiben erhalten; derselbe Venue-Key
 * wird ersetzt. Ergebnis ist deterministisch sortiert (venue asc) und auf
 * {@link MAX_STATUS_VENUES} gekappt.
 */
/**
 * Optionale Stale-Guard-Zusammenfassung (GAP-07) je Venue — ausschließlich
 * Zähler (`staleSeries`, `staleByTimeframe`), keine Instrument-IDs.
 */
export interface VenueStaleStatus {
  staleSeries: number;
  staleByTimeframe: Record<string, number>;
}

export function saveVenueSyncStatus(
  result: SyncResult,
  file: string = MARKET_SYNC_STATUS_FILE,
  now: Date = new Date(),
  stale?: VenueStaleStatus,
): void {
  const next = syncResultToVenueStatus(result);
  if (!VENUE_RE.test(next.venue)) return; // defensive: nie einen unbrauchbaren Key persistieren
  if (stale && Number.isFinite(stale.staleSeries) && stale.staleSeries >= 0) {
    next.staleSeries = Math.max(0, Math.floor(stale.staleSeries));
    const tf: Record<string, number> = {};
    if (stale.staleByTimeframe && typeof stale.staleByTimeframe === "object") {
      for (const [k, v] of Object.entries(stale.staleByTimeframe)) {
        if (!STALE_TIMEFRAME_RE.test(k)) continue; // nur erlaubte Timeframe-Keys
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) tf[k] = Math.floor(v);
      }
    }
    if (Object.keys(tf).length > 0) next.staleByTimeframe = tf;
  }
  const resolved = resolveRuntimePath(file);
  const merged = loadVenueSyncStatuses(file).filter((entry) => entry.venue !== next.venue);
  merged.push(next);
  merged.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0));
  const manifest: SyncStatusManifest = {
    writtenAt: now.toISOString(),
    venues: merged.slice(0, MAX_STATUS_VENUES),
  };
  mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  renameSync(tmp, resolved);
}

/**
 * Lädt den Sync-Status. Fehlende/korrupte Datei → leere Liste (der Report
 * bleibt lesbar; ein kaputtes Manifest darf das Ops-Center nicht blockieren).
 * Jeder Eintrag wird strikt validiert — insbesondere die geschlossene
 * `reason`-Aufzählung: unbekannte Schlüssel werden verworfen.
 */
export function loadVenueSyncStatuses(file: string = MARKET_SYNC_STATUS_FILE): VenueSyncStatus[] {
  try {
    const resolved = resolveRuntimePath(file);
    if (!existsSync(resolved)) return [];
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<SyncStatusManifest>;
    const out: VenueSyncStatus[] = [];
    for (const entry of Array.isArray(parsed.venues) ? parsed.venues : []) {
      if (!entry || typeof entry !== "object") continue;
      const venue = typeof entry.venue === "string" ? entry.venue : "";
      if (!VENUE_RE.test(venue)) continue;
      const failuresByReason: Record<string, number> = {};
      if (entry.failuresByReason && typeof entry.failuresByReason === "object") {
        for (const [reason, count] of Object.entries(entry.failuresByReason)) {
          if (!isMarketDataErrorReason(reason)) continue; // geschlossene Aufzählung
          if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
          failuresByReason[reason] = Math.floor(count);
        }
      }
      // Stale-Guard (GAP-07): nur Zähler + erlaubte Timeframe-Keys; alles
      // andere (Instrument-IDs, Freitext) wird verworfen — fail-safe.
      let staleSeries: number | undefined;
      let staleByTimeframe: Record<string, number> | undefined;
      if (typeof entry.staleSeries === "number" && Number.isFinite(entry.staleSeries) && entry.staleSeries >= 0) {
        staleSeries = Math.max(0, Math.floor(entry.staleSeries));
      }
      if (entry.staleByTimeframe && typeof entry.staleByTimeframe === "object") {
        const tf: Record<string, number> = {};
        for (const [k, v] of Object.entries(entry.staleByTimeframe)) {
          if (!STALE_TIMEFRAME_RE.test(k)) continue;
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) tf[k] = Math.floor(v);
        }
        if (Object.keys(tf).length > 0) staleByTimeframe = tf;
      }
      out.push({
        venue,
        lastSyncAt:
          typeof entry.lastSyncAt === "string" && Number.isFinite(Date.parse(entry.lastSyncAt))
            ? entry.lastSyncAt
            : null,
        lastSyncDegraded: entry.lastSyncDegraded === true,
        instruments:
          typeof entry.instruments === "number" && Number.isFinite(entry.instruments)
            ? Math.max(0, Math.floor(entry.instruments))
            : 0,
        failuresByReason,
        ...(staleSeries !== undefined ? { staleSeries } : {}),
        ...(staleByTimeframe !== undefined ? { staleByTimeframe } : {}),
      });
      if (out.length >= MAX_STATUS_VENUES) break;
    }
    return out;
  } catch {
    return [];
  }
}
