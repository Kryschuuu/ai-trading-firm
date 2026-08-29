/**
 * Persistentes Marktdaten-Fehler-Manifest (MDERR-006).
 *
 * Der MarketData-Sync (`npm run market-sync`) und der Scanner laufen als
 * getrennte Prozesse. Damit der Scanner — und das Operations Center — echte
 * Fetch-/Infrastrukturfehler **über Prozessgrenzen hinweg** kennen, schreibt
 * der Sync die Fehler aus `SyncResult.errors` hierher:
 *
 *   data/market-data-errors.json   (gitignored, Laufzeit-Artefakt)
 *
 * Konsumenten:
 *  - `scripts/run-scan.ts` → `dataErrors` in `scanUniverse()` → Readiness
 *    `ERROR` + `data-unavailable`-Rejection (nie `min-candles`).
 *  - `ScannerService.refresh()` → gleicher Default (Ops Center).
 *  - `src/ops/collect.ts` → Zähler/Reasons im Scanner-Cockpit.
 *
 * Security: gespeichert werden nur `instrumentId`, klassifizierte `reason`,
 * `stage` und `timeframe` — keine Fehlermeldungen, keine URLs, keine Secrets.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { classifyMarketDataError, type MarketDataErrorReason } from "../lib/marketDataErrors";
import type { SyncError } from "./types";

/** Ablage des Manifests (gitignored, siehe .gitignore). */
export const MARKET_DATA_ERRORS_FILE = path.join("data", "market-data-errors.json");

/** Harte Obergrenze der Manifest-Einträge (DoS: Registry ist auf 50 k begrenzt). */
export const MAX_MANIFEST_ENTRIES = 100_000;

export interface MarketDataErrorManifestEntry {
  instrumentId: string;
  reason: MarketDataErrorReason;
  stage: SyncError["stage"];
  timeframe?: string;
  at: string;
}

export interface MarketDataErrorManifest {
  writtenAt: string;
  errors: MarketDataErrorManifestEntry[];
}

/**
 * Übersetzt `SyncError[]` (Stage `candles` + ticker/orderbook mit
 * instrumentId) in eine `Map<instrumentId, reason>` — die Eingabe von
 * `assessDataReadiness()`/`scanUniverse()`.
 */
export function syncErrorsToDataErrors(errors: readonly SyncError[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const error of errors) {
    if (!error.instrumentId) continue; // Batch-Fehler ohne Instrument → keinem Instrument zuordenbar
    const { reason } = classifyMarketDataError(error.message);
    if (!out.has(error.instrumentId)) out.set(error.instrumentId, reason);
  }
  return out;
}

/**
 * Persistiert Fehler atomar (tmp + rename). Nur stabile Felder — keine
 * rohen Fehlermeldungen (können URLs/Secrets enthalten).
 */
export function saveMarketDataErrors(
  errors: readonly SyncError[],
  file: string = MARKET_DATA_ERRORS_FILE,
  now: Date = new Date(),
): void {
  const manifest: MarketDataErrorManifest = {
    writtenAt: now.toISOString(),
    errors: errors
      .filter((e) => e.instrumentId)
      .map((e) => ({
        instrumentId: String(e.instrumentId).slice(0, 128),
        reason: classifyMarketDataError(e.message).reason,
        stage: e.stage,
        timeframe: e.timeframe ? String(e.timeframe).slice(0, 16) : undefined,
        at: now.toISOString(),
      }))
      .slice(0, MAX_MANIFEST_ENTRIES),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Lädt das Manifest. Fehlende/korrupte Datei → leere Map (der Scanner bleibt
 * lauffähig; ein kaputtes Manifest darf keinen Scan blockieren).
 */
export function loadMarketDataErrors(file: string = MARKET_DATA_ERRORS_FILE): Map<string, string> {
  try {
    if (!existsSync(file)) return new Map();
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MarketDataErrorManifest>;
    const out = new Map<string, string>();
    for (const entry of Array.isArray(parsed.errors) ? parsed.errors : []) {
      if (typeof entry?.instrumentId === "string" && typeof entry?.reason === "string" && entry.instrumentId) {
        out.set(entry.instrumentId, entry.reason);
      }
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Entfernt das Manifest (nach erfolgreichem, fehlerfreiem Sync). */
export function clearMarketDataErrors(file: string = MARKET_DATA_ERRORS_FILE): void {
  rmSync(file, { force: true });
}
