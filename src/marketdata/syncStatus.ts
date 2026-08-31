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
import type { SyncResult } from "./types";

/** Ablage des Sync-Status (gitignored wie das Fehler-Manifest daneben). */
export const MARKET_SYNC_STATUS_FILE = path.join("data", "market-sync-status.json");

/** Harte Obergrenze gespeicherter Venues (Kappung, kein Response-Wachstum). */
export const MAX_STATUS_VENUES = 10;

/** Erlaubte Venue-Form (Großbuchstaben/Ziffern/Unterstrich, wie `KNOWN_SYNC_VENUES`). */
const VENUE_RE = /^[A-Z0-9_]{1,32}$/;

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
export function saveVenueSyncStatus(
  result: SyncResult,
  file: string = MARKET_SYNC_STATUS_FILE,
  now: Date = new Date(),
): void {
  const next = syncResultToVenueStatus(result);
  if (!VENUE_RE.test(next.venue)) return; // defensive: nie einen unbrauchbaren Key persistieren
  const merged = loadVenueSyncStatuses(file).filter((entry) => entry.venue !== next.venue);
  merged.push(next);
  merged.sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0));
  const manifest: SyncStatusManifest = {
    writtenAt: now.toISOString(),
    venues: merged.slice(0, MAX_STATUS_VENUES),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Lädt den Sync-Status. Fehlende/korrupte Datei → leere Liste (der Report
 * bleibt lesbar; ein kaputtes Manifest darf das Ops-Center nicht blockieren).
 * Jeder Eintrag wird strikt validiert — insbesondere die geschlossene
 * `reason`-Aufzählung: unbekannte Schlüssel werden verworfen.
 */
export function loadVenueSyncStatuses(file: string = MARKET_SYNC_STATUS_FILE): VenueSyncStatus[] {
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SyncStatusManifest>;
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
      });
      if (out.length >= MAX_STATUS_VENUES) break;
    }
    return out;
  } catch {
    return [];
  }
}
