/**
 * Persistenter Spread-/Depth-Cache für den Market-Data-Sync (v1.38.0).
 *
 * Der relative Spread UND die Orderbuch-Tiefe (`bookDepthUsd`, v0.4.0)
 * stammen gemeinsam aus dem Orderbuch (`/market/depth`): je Instrument EIN
 * Request, und die Depth-Stage ist der teuerste Teil eines Sync-Laufs
 * (N Aufrufe gegen die strikteste Rate-Limit-Drossel). Spreads liquider
 * Perpetuals ändern sich auf Stunden-/Tagesebene kaum — trotzdem holte
 * jeder (insbesondere stündliche) Sync-Lauf alle Books erneut.
 *
 * Dieser Cache hält erfolgreich gemessene Spreads **und Tiefen** je
 * Instrument über Prozessgrenzen hinweg:
 *
 *   data/spread-cache.json   (gitignored, Laufzeit-Artefakt, Mode 0600)
 *
 * Innerhalb der TTL (Default 6 h, `MARKET_SPREAD_CACHE_TTL_MS`, `0` = aus)
 * wird kein Depth-Request für das Instrument gestellt. Die
 * Orderbuch-Stage befüllt weiterhin alle Cache-Lücken; fehlgeschlagene
 * Werte werden NIE übernommen (kein falscher „bekannter Spread“).
 *
 * Bewusste Grenzen:
 *  - Nur erfolgreiche, endliche Werte (Spread ≤ 50 %, Tiefe ≥ 0) gelangen in
 *    den Cache (Plausibilitätsprüfung bleibt in der Enrichment-Stage).
 *  - Der Live-Handel und der Mikro-Executor nutzen diese Datei NICHT — sie
 *    arbeiten mit Live-Books/WebSocket-Ticks. Es geht ausschließlich um
 *    die tägliche/stündliche Scanner-Versorgung.
 *  - Trockenläufe (`--dry-run`) schreiben niemals in diesen Cache.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "../lib/appPaths";

/** Ablage des Caches (gitignored, siehe .gitignore). */
export const MARKET_SPREAD_CACHE_FILE = path.join("data", "spread-cache.json");

/**
 * Default-Lebensdauer eines gecachten Spreads: 6 Stunden. Kurz genug, dass
 * ein Marktregimewechsel (Ausweitung der Books) spätestens dann frisch
 * geholt wird; lang genug, dass ein stündlicher Timer im Schnitt 5 von 6
 * Depth-Requests je Instrument einspart.
 */
export const DEFAULT_SPREAD_CACHE_TTL_MS = 6 * 60 * 60_000;

/** Umgebungsvariable zur Konfiguration der TTL; `0` schaltet den Cache ab. */
export const SPREAD_CACHE_TTL_ENV = "MARKET_SPREAD_CACHE_TTL_MS";

interface SpreadCacheEntry {
  /** Relativer Spread `(ask-bid)/mid`, garantiert endlich. */
  spread: number;
  /**
   * Orderbuch-Tiefe `min(Σ bid×qty, Σ ask×qty)` in Quote-Währung (v0.4.0).
   * Optional/nur-`depth`-Venues; `number` = gemessen und < venünftige Grenze,
   * fehlend = keine belastbare Tiefe (der Lesepfad liefert dann `null`).
   */
  bookDepthUsd?: number;
  /** ISO-8601-UTC des messenden Sync-Laufs. */
  at: string;
}

interface SpreadCacheFile {
  version: 1;
  writtenAt: string;
  entries: Record<string, SpreadCacheEntry>;
}

/**
 * Spread-Cache-Port des Sync-Service. Bewusst klein und synchron (ein
 * Lesevorgang beim Aufbau, ein atomarer Schreibvorgang je Lauf).
 */
export interface SpreadCache {
  /**
   * Frischer Spread je Instrument-ID oder `undefined`, wenn kein Wert
   * existiert ODER der Eintrag die TTL überschritten hat (oder der Wert
   * unplausibel ist — dann wie „nicht vorhanden“).
   */
  fresh(instrumentId: string, nowMs: number): number | undefined;
  /** Merkt einen neu gemessenen Spread (Schreiben erst bei {@link flush}). */
  record(instrumentId: string, spread: number, at: Date): void;
  /**
   * Frische Tiefe je Instrument-ID oder `undefined` (kein Wert, TTL abgelaufen,
   * oder nicht in diesem Eintrag gemessen).
   */
  freshDepth(instrumentId: string, nowMs: number): number | undefined;
  /** Merkt eine gemessene Tiefe (nur nicht-negative, endliche Werte). */
  recordDepth(instrumentId: string, bookDepthUsd: number, at: Date): void;
  /** Atomarer Schreibvorgang aller gesammelten Werte. */
  flush(now: Date): void;
}

/**
 * Liest die TTL aus der Umgebung. `0` (und Negativwerte) deaktivieren den
 * Cache; unparsebare Werte fallen auf den Default zurück statt leise zu
 * deaktivieren oder ewig zu cachen.
 */
export function spreadCacheTtlMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[SPREAD_CACHE_TTL_ENV];
  if (raw === undefined) return DEFAULT_SPREAD_CACHE_TTL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SPREAD_CACHE_TTL_MS;
  return Math.max(0, Math.floor(value));
}

/**
 * Datei-gestützter Cache. Fehlt die Datei oder ist sie korrupt, beginnt er
 * leer (ein Sync muss mit einer kaputten Cache-Datei weiterlaufen können).
 */
export class FileSpreadCache implements SpreadCache {
  private readonly entries = new Map<string, SpreadCacheEntry>();
  private touched = false;

  constructor(
    private readonly file: string = MARKET_SPREAD_CACHE_FILE,
    private readonly ttlMs: number = DEFAULT_SPREAD_CACHE_TTL_MS,
  ) {
    if (ttlMs <= 0) return;
    try {
      const resolved = resolveRuntimePath(file);
      if (!existsSync(resolved)) return;
      const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<SpreadCacheFile>;
      const rawEntries = parsed && typeof parsed === "object" ? parsed.entries : null;
      if (!rawEntries || typeof rawEntries !== "object") return;
      for (const [id, entry] of Object.entries(rawEntries)) {
        if (!entry || typeof entry !== "object") continue;
        const spread = (entry as SpreadCacheEntry).spread;
        const depth = (entry as SpreadCacheEntry).bookDepthUsd;
        const at = (entry as SpreadCacheEntry).at;
        const atMs = Date.parse(String(at));
        if (typeof spread === "number" && Number.isFinite(spread) && spread >= 0 && Number.isFinite(atMs)) {
          const kept: SpreadCacheEntry = { spread, at: String(at) };
          if (typeof depth === "number" && Number.isFinite(depth) && depth >= 0) kept.bookDepthUsd = depth;
          this.entries.set(id.slice(0, 128), kept);
        }
      }
    } catch {
      // Kaputte Datei: leer starten, beim nächsten flush überschreiben.
      this.entries.clear();
    }
  }

  fresh(instrumentId: string, nowMs: number): number | undefined {
    if (this.ttlMs <= 0) return undefined;
    const entry = this.freshEntry(instrumentId, nowMs);
    return entry?.spread;
  }

  freshDepth(instrumentId: string, nowMs: number): number | undefined {
    if (this.ttlMs <= 0) return undefined;
    return this.freshEntry(instrumentId, nowMs)?.bookDepthUsd;
  }

  record(instrumentId: string, spread: number, at: Date): void {
    if (this.ttlMs <= 0) return; // deaktivierter Cache schreibt nichts
    if (!Number.isFinite(spread) || spread < 0) return;
    const key = instrumentId.slice(0, 128);
    const existing = this.entries.get(key);
    this.entries.set(key, {
      spread,
      bookDepthUsd: existing?.bookDepthUsd,
      at: at.toISOString(),
    });
    this.touched = true;
  }

  recordDepth(instrumentId: string, bookDepthUsd: number, at: Date): void {
    if (this.ttlMs <= 0) return; // deaktivierter Cache schreibt nichts
    if (!Number.isFinite(bookDepthUsd) || bookDepthUsd < 0) return;
    const key = instrumentId.slice(0, 128);
    // Tiefe nur in einen vorhandenen Spread-Eintrag schreiben: Ohne Spread
    // gibt es ersichtlich gar kein belastbares Buch (beide stammen aus
    // DEMSELBEN Depth-Call), und ein einsamer depth-Wert ohne Spread-Eintrag
    // wäre ein Halb-Artefakt.
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.set(key, {
      spread: existing.spread,
      bookDepthUsd,
      at: at.toISOString(),
    });
    this.touched = true;
  }

  /** Gültigen Eintrag je ID liefern oder `undefined` (fehlt/stale/unplausibel). */
  private freshEntry(instrumentId: string, nowMs: number): SpreadCacheEntry | undefined {
    const entry = this.entries.get(instrumentId);
    if (!entry) return undefined;
    const atMs = Date.parse(entry.at);
    if (!Number.isFinite(atMs) || nowMs - atMs > this.ttlMs) return undefined;
    return entry;
  }

  flush(now: Date): void {
    if (!this.touched) return;
    const file: SpreadCacheFile = {
      version: 1,
      writtenAt: now.toISOString(),
      entries: Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    };
    const resolved = resolveRuntimePath(this.file);
    mkdirSync(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(tmp, resolved);
  }
}
