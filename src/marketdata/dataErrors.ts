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

import type { MarketDataErrorReason } from "../lib/marketDataErrors";
import { resolveRuntimePath } from "../lib/appPaths";
import type { SyncError } from "./types";

/** Ablage des Manifests (gitignored, siehe .gitignore).
 *  Relativ gehalten; I/O wird über `resolveRuntimePath` aufgelöst (siehe
 *  `syncStatus.ts` — identischer Cross-Prozess-Pfad-Fix für CLI vs. Next.js).
 */
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

/**
 * Batch-Fehler ohne Instrument-Zuordnung (v1.39.1): schlägt eine GANZE Stage
 * fehl (z. B. Discovery/Netzwerk), gibt es kein `instrumentId` — bisher wurden
 * solche Fehler still verworfen, das Manifest blieb leer und der Betrieb las
 * „1 Fehler“ ohne jeden nachlesbaren Grund. Batch-Einträge tragen deshalb nur
 * Stage + klassifizierte Ursache (gleiche Security-Politik wie oben: keine
 * Meldungstexte, keine URLs, keine Secrets).
 */
export interface MarketDataErrorBatchEntry {
  stage: SyncError["stage"];
  reason: MarketDataErrorReason | "UNCLASSIFIED";
  count: number;
  at: string;
}

export interface MarketDataErrorManifest {
  writtenAt: string;
  errors: MarketDataErrorManifestEntry[];
  /** Batch-Fehler (Stage-Level, ohne Instrument); optional für Altbestände. */
  batch?: MarketDataErrorBatchEntry[];
}

/**
 * Aus `SyncResult.errors` die Instrumente mit echten Fetch-/Infrastrukturfehlern.
 *
 * Bewusst **keine** Zustands-Warnungen (z. B. „Ticker-Symbol weicht ab“) und
 * keine `upsert`-Persistenzfehler: diese dürfen den Scanner nicht als
 * `DATA_UNAVAILABLE` ausfallen lassen. Nur Fehler mit klassifizierter `reason`
 * (vom `MarketDataSyncService` gesetzt) signalisieren einen Abruffehler.
 */
/**
 * Datenqualitäts-Klassen (GAP-07) gehören NICHT ins Fetch-Fehler-Manifest:
 * sie sind Beobachtungen über vorhandene Daten, keine Abruf-Fehler. Im
 * `log`-Modus (Default) dürfen sie das Instrument im Scanner nicht als
 * `data-unavailable` abwerten; im `strict`-Modus läuft dieselbe Wirkung
 * bewusst über den Qualitäts-Report (`qualityStrictDataErrors()`), nicht
 * über dieses Manifest.
 */
const QUALITY_REASONS = new Set<string>([
  "QUALITY_GAP",
  "QUALITY_OUTLIER",
  "QUALITY_INVALID",
  "QUALITY_DUPLICATE",
  "QUALITY_CROSSCHECK",
]);

export function syncErrorsToDataErrors(errors: readonly SyncError[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const error of errors) {
    if (!error.instrumentId) continue; // Batch-Fehler ohne Instrument → keinem Instrument zuordenbar
    if (error.stage === "upsert") continue; // Persistenzfehler, kein Marktdaten-Fetch-Fehler
    if (typeof error.reason !== "string") continue; // reine Datenqualitäts-Warnung ohne Fehlerobjekt
    if (QUALITY_REASONS.has(error.reason)) continue; // Qualitäts-Befund (GAP-07), kein Fetch-Fehler
    if (!out.has(error.instrumentId)) out.set(error.instrumentId, error.reason);
  }
  return out;
}

/**
 * Persistiert Fehler atomar (tmp + rename). Nur stabile Felder — keine
 * rohen Fehlermeldungen (können URLs/Secrets enthalten). Batch-Fehler ohne
 * `instrumentId` werden je Stage/Ursache zusammengefasst (`batch`), damit ein
 * Komplettausfall (Discovery/Netzwerk) über Prozessgrenzen nachlesbar bleibt.
 *
 * Rückgabe: tatsächlich persistierte Einträge (Instrument-Fehler und
 * Batch-Buckets) — der CLI leitet daraus seine ehrliche Statuszeile ab, statt
 * „Manifest geschrieben“ zu behaupten, wenn nichts drin landete.
 */
export function saveMarketDataErrors(
  errors: readonly SyncError[],
  file: string = MARKET_DATA_ERRORS_FILE,
  now: Date = new Date(),
): { persisted: number; batch: number } {
  const resolved = resolveRuntimePath(file);
  const batchCounts = new Map<string, number>();
  for (const e of errors) {
    if (e.instrumentId || e.stage === "upsert") continue;
    const key = `${e.stage}/${e.reason ?? "UNCLASSIFIED"}`;
    batchCounts.set(key, (batchCounts.get(key) ?? 0) + 1);
  }
  const manifest: MarketDataErrorManifest = {
    writtenAt: now.toISOString(),
    errors: errors
      .filter((e) => e.instrumentId && e.stage !== "upsert" && typeof e.reason === "string")
      .map((e) => ({
        instrumentId: String(e.instrumentId).slice(0, 128),
        reason: e.reason as MarketDataErrorReason,
        stage: e.stage,
        timeframe: e.timeframe ? String(e.timeframe).slice(0, 16) : undefined,
        at: now.toISOString(),
      }))
      .slice(0, MAX_MANIFEST_ENTRIES),
    ...(batchCounts.size > 0
      ? {
          batch: [...batchCounts.entries()].map(([key, count]) => {
            const [stage, reason] = key.split("/");
            return { stage, reason, count, at: now.toISOString() } as MarketDataErrorBatchEntry;
          }),
        }
      : {}),
  };
  mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  renameSync(tmp, resolved);
  return { persisted: manifest.errors.length, batch: manifest.batch?.length ?? 0 };
}

/**
 * Lädt die Batch-Fehler des Manifests (Read-only; fehlende/korrupte Datei
 * oder Altbestand ohne `batch` ⇒ leere Liste).
 */
export function loadMarketDataBatchErrors(
  file: string = MARKET_DATA_ERRORS_FILE,
): MarketDataErrorBatchEntry[] {
  try {
    const resolved = resolveRuntimePath(file);
    if (!existsSync(resolved)) return [];
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<MarketDataErrorManifest>;
    if (!Array.isArray(parsed.batch)) return [];
    return parsed.batch.filter(
      (e): e is MarketDataErrorBatchEntry =>
        !!e && typeof e.stage === "string" && typeof e.count === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Lädt das Manifest. Fehlende/korrupte Datei → leere Map (der Scanner bleibt
 * lauffähig; ein kaputtes Manifest darf keinen Scan blockieren).
 */
export function loadMarketDataErrors(file: string = MARKET_DATA_ERRORS_FILE): Map<string, string> {
  try {
    const resolved = resolveRuntimePath(file);
    if (!existsSync(resolved)) return new Map();
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<MarketDataErrorManifest>;
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
  rmSync(resolveRuntimePath(file), { force: true });
}
