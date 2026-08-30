/**
 * Instrument-Registry — deterministischer Kern des Market-Universe.
 *
 * Eigenschaften (nicht verhandelbar):
 *   - **Kein LLM, kein Netzwerk.** Nur Schema, Policy und lokale Persistenz.
 *   - **Broker-unabhängig.** Kein Venue-spezifischer Code; Fähigkeiten werden
 *     ausschließlich über Capability-Flags im Contract abgebildet.
 *   - **Deterministisch.** Stabile Sortierung nach `id`, IDs immer
 *     `VENUE:SYMBOL`, identische Eingabe ⇒ identische Datei.
 *   - **Auditiert.** Jede Mutation erzeugt genau einen Audit-Eintrag.
 *
 * @example
 * ```ts
 * const registry = new InstrumentRegistry();
 * registry.load();
 * registry.upsert({ venue: "BINANCE", symbol: "BTCUSDT" }, "discovery:binance");
 * const page = registry.query({ venue: "BINANCE", assetClass: "crypto", pageSize: 50 });
 * ```
 */

import {
  applyAvailabilityProjection,
  projectInstrumentAvailability,
} from "./capabilityProjection";
import { CompiledPolicy, DEFAULT_POLICY, loadPolicy, type UniversePolicy } from "./policy";
import { NdjsonStore } from "./store";
import { buildAuditEntry, fileAuditSink, sanitizeSource, writeDbAudit, type AuditSink, type UniverseAuditEntry } from "./audit";
import { assetIdOf, normalizeInstrument, normalizeSymbol, normalizeVenue, underlyingOf, withRelations } from "./normalization";
import {
  MAX_BATCH_SIZE,
  UniverseValidationError,
  clampPage,
  clampPageSize,
  safeRef,
} from "./validation";
import type {
  Instrument,
  InstrumentInput,
  InstrumentQuery,
  MarketInstrument,
  QueryResult,
  RejectedInstrument,
  Underlying,
  UpsertResult,
} from "./types";

/** Optionen für eine Registry-Instanz (Tests injizieren Store/Policy/Uhr). */
export interface RegistryOptions {
  /** Persistenzschicht; Default: NDJSON in `UNIVERSE_DATA_DIR`. */
  store?: NdjsonStore;
  /** Datenverzeichnis (Kurzform statt eigenem Store). */
  dir?: string;
  /** Ausschluss-Policy; Default: `loadPolicy()`. */
  policy?: UniversePolicy;
  /** Zusätzliche Audit-Senke (Datei-Senke ist immer aktiv). */
  auditSink?: AuditSink;
  /** Uhr (für deterministische Tests). */
  now?: () => Date;
  /** Nach jeder Mutation persistieren (Default: true). */
  autoSave?: boolean;
}

/** Ein nach Venue gruppierter Ausschnitt des Universums. */
export interface VenueGroup {
  /** Venue-Kürzel. */
  venue: string;
  /** Anzahl Instrumente dieser Venue in der aktuellen Ergebnismenge. */
  count: number;
  /** Instrumente, stabil nach `id` sortiert. */
  instruments: MarketInstrument[];
}

function asArray<T>(value: T | T[] | undefined): T[] | null {
  if (value === undefined) return null;
  const arr = Array.isArray(value) ? value : [value];
  return arr.length ? arr : null;
}

function byId(a: MarketInstrument, b: MarketInstrument): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function withProjectedCapabilities(instrument: MarketInstrument): MarketInstrument {
  return applyAvailabilityProjection(instrument);
}

/** In-Memory-Registry mit NDJSON-Persistenz. */
export class InstrumentRegistry {
  private readonly items = new Map<string, MarketInstrument>();
  private readonly store: NdjsonStore;
  private readonly compiled: CompiledPolicy;
  private readonly sinks: AuditSink[];
  private readonly now: () => Date;
  private readonly autoSave: boolean;
  private loaded = false;
  private skippedOnLoad = 0;

  constructor(options: RegistryOptions = {}) {
    this.store = options.store ?? new NdjsonStore(options.dir);
    this.compiled = new CompiledPolicy(options.policy ?? safeLoadPolicy());
    this.sinks = [fileAuditSink(this.store)];
    if (options.auditSink) this.sinks.push(options.auditSink);
    this.now = options.now ?? (() => new Date());
    this.autoSave = options.autoSave ?? true;
  }

  /** Anzahl Instrumente im Speicher. */
  get size(): number {
    return this.items.size;
  }

  /** Anzahl beim Laden übersprungener, kaputter Zeilen (Diagnose). */
  get skippedLines(): number {
    return this.skippedOnLoad;
  }

  /** Aktive Policy (read-only). */
  get policy(): UniversePolicy {
    return this.compiled.policy;
  }

  /**
   * Jüngster `lastSeen`-Zeitstempel über alle Instrumente — der „Stand“ des
   * Universums. Bewusst aus den Daten abgeleitet (überlebt Prozessneustarts
   * ohne zusätzliche Metadatei), `null` bei leerem Universum.
   */
  get lastSync(): string | null {
    let max: string | null = null;
    for (const i of this.items.values()) {
      if (max === null || i.lastSeen > max) max = i.lastSeen;
    }
    return max;
  }

  /** Lädt die Persistenz (idempotent; `force` erzwingt Neu-Einlesen). */
  load(force = false): this {
    if (this.loaded && !force) return this;
    const result = this.store.load();
    this.items.clear();
    for (const i of result.instruments) this.items.set(i.id, withProjectedCapabilities(i));
    this.skippedOnLoad = result.skipped;
    this.loaded = true;
    return this;
  }

  /** Schreibt den aktuellen Stand atomar in die NDJSON-Datei. */
  save(): this {
    this.store.save([...this.items.values()]);
    return this;
  }

  /** Liefert ein Instrument per kanonischer ID oder `null`. */
  get(id: string): MarketInstrument | null {
    if (typeof id !== "string") return null;
    const found = this.items.get(id.trim().toUpperCase());
    return found ? withProjectedCapabilities(found) : null;
  }

  /** Liefert ein Instrument per Venue + venue-nativem Symbol oder `null`. */
  find(venue: string, symbol: string): MarketInstrument | null {
    try {
      return this.get(`${normalizeVenue(venue)}:${normalizeSymbol(symbol)}`);
    } catch {
      return null;
    }
  }

  /** Wie `get`, aber inklusive abgeleiteter `assetId`/`underlyingId`. */
  getWithRelations(id: string): Instrument | null {
    const found = this.get(id);
    return found ? withRelations(found) : null;
  }

  /**
   * Legt ein Instrument an oder aktualisiert es.
   *
   * Konfliktverhalten (Upsert-Merge):
   *   - Angegebene Felder überschreiben den Bestand.
   *   - Nicht angegebene Felder bleiben erhalten (kein Zurücksetzen auf Defaults).
   *   - `null` bei Metriken (`volume24h`, `spread`, `volatility`) bedeutet
   *     „kein neuer Wert“ und lässt den Bestandswert stehen; nur ein
   *     expliziter Zahlenwert überschreibt.
   *   - `lastSeen` wird auf den Eingabewert bzw. „jetzt“ gesetzt.
   */
  upsert(input: InstrumentInput, source = "manual"): UpsertResult {
    return this.upsertMany([input], source, "UPSERT");
  }

  /**
   * Batch-Upsert (max. `MAX_BATCH_SIZE` Sätze). Ungültige oder per Policy
   * ausgeschlossene Sätze landen in `rejected`; der Rest wird geschrieben —
   * ein kaputter Satz darf einen Discovery-Lauf nicht komplett verwerfen.
   */
  upsertMany(inputs: InstrumentInput[], source = "manual", action: "UPSERT" | "BATCH_UPSERT" | "SEED" = "BATCH_UPSERT"): UpsertResult {
    if (!Array.isArray(inputs)) {
      throw new UniverseValidationError("instruments", "erwartet Array");
    }
    if (inputs.length > MAX_BATCH_SIZE) {
      throw new UniverseValidationError("instruments", `max. ${MAX_BATCH_SIZE} Sätze pro Batch`);
    }
    this.load();

    const rejected: RejectedInstrument[] = [];
    const touched: string[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const raw of inputs) {
      let candidate: MarketInstrument;
      const ref = raw && typeof raw === "object" ? `${safeRef(raw.venue, 16)}:${safeRef(raw.symbol, 24)}` : safeRef(raw);
      try {
        const existing = this.peekExisting(raw);
        candidate = normalizeInstrument(this.mergeInput(existing, raw), this.now());
      } catch (e) {
        rejected.push({
          ref,
          code: e instanceof UniverseValidationError ? e.code : "VALIDATION_ERROR",
          message: e instanceof Error ? e.message : "unbekannter Validierungsfehler",
        });
        continue;
      }

      const decision = this.compiled.evaluate(candidate);
      if (decision.excluded) {
        rejected.push({
          ref: candidate.id,
          code: "POLICY_EXCLUDED",
          message: `${decision.ruleId}: ${decision.reason ?? "per Policy ausgeschlossen"}`,
        });
        continue;
      }

      candidate = withProjectedCapabilities(candidate);

      const before = this.items.get(candidate.id);
      if (!before) {
        this.items.set(candidate.id, candidate);
        created += 1;
        touched.push(candidate.id);
      } else if (JSON.stringify(before) === JSON.stringify(candidate)) {
        unchanged += 1;
      } else {
        this.items.set(candidate.id, candidate);
        updated += 1;
        touched.push(candidate.id);
      }
    }

    if ((created > 0 || updated > 0) && this.autoSave) this.save();
    if (created > 0 || updated > 0 || rejected.length > 0) {
      this.audit(buildAuditEntry({ source, action, created, updated, rejected: rejected.length, ids: touched.sort(), now: this.now() }));
    }

    return { created, updated, unchanged, rejected, ids: touched.sort() };
  }

  /** Entfernt ein Instrument. Liefert `true`, wenn es existierte. */
  remove(id: string, source = "manual"): boolean {
    this.load();
    const key = typeof id === "string" ? id.trim().toUpperCase() : "";
    const existed = this.items.delete(key);
    if (existed) {
      if (this.autoSave) this.save();
      this.audit(buildAuditEntry({ source, action: "REMOVE", removed: 1, ids: [key], now: this.now() }));
    }
    return existed;
  }

  /**
   * Filtert das Universum. Alle Filter sind UND-verknüpft, das Ergebnis ist
   * stabil nach `id` sortiert und paginiert (Seitengröße hart auf 500 geklemmt).
   */
  query(q: InstrumentQuery = {}): QueryResult {
    this.load();
    const venues = asArray(q.venue)?.map((v) => String(v).trim().toUpperCase());
    const classes = asArray(q.assetClass);
    const types = asArray(q.marketType);
    const statuses = asArray(q.status);
    const base = q.base ? String(q.base).trim().toUpperCase() : null;
    const quote = q.quote ? String(q.quote).trim().toUpperCase() : null;
    const underlying = q.underlying ? String(q.underlying).trim().toUpperCase() : null;
    const search = q.search ? String(q.search).trim().toUpperCase().slice(0, 64) : null;

    const matched: MarketInstrument[] = [];
    for (const i of this.items.values()) {
      if (venues && !venues.includes(i.venue)) continue;
      if (classes && !classes.includes(i.assetClass)) continue;
      if (types && !types.includes(i.marketType)) continue;
      if (statuses && !statuses.includes(i.status)) continue;
      if (q.paperAvailable !== undefined && i.paperAvailable !== q.paperAvailable) continue;
      const projected = projectInstrumentAvailability(i);
      if (q.liveTradable !== undefined && projected.liveTradable !== q.liveTradable) continue;
      if (q.liveAvailable !== undefined && projected.liveAvailable !== q.liveAvailable) continue;
      if (q.leverageAvailable !== undefined && i.leverageAvailable !== q.leverageAvailable) continue;
      if (q.shortAvailable !== undefined && i.shortAvailable !== q.shortAvailable) continue;
      if (base && i.base !== base) continue;
      if (quote && i.quote !== quote) continue;
      if (underlying && assetIdOf(i) !== underlying) continue;
      if (q.minVolume24h !== undefined && (i.volume24h === null || i.volume24h < q.minVolume24h)) continue;
      if (q.maxSpread !== undefined && (i.spread === null || i.spread > q.maxSpread)) continue;
      if (q.maxVolatility !== undefined && (i.volatility === null || i.volatility > q.maxVolatility)) continue;
      if (search && !i.id.includes(search)) continue;
      matched.push(withProjectedCapabilities(i));
    }

    matched.sort(byId);
    const pageSize = clampPageSize(q.pageSize ?? undefined);
    const page = clampPage(q.page ?? undefined);
    const start = (page - 1) * pageSize;
    const items = matched.slice(start, start + pageSize);
    return { items, total: matched.length, page, pageSize, hasMore: start + items.length < matched.length };
  }

  /** Gruppiert eine Ergebnismenge nach Venue (Venues alphabetisch). */
  groupByVenue(items: MarketInstrument[] = this.query({ pageSize: 500 }).items): VenueGroup[] {
    const groups = new Map<string, MarketInstrument[]>();
    for (const i of items) {
      const list = groups.get(i.venue) ?? [];
      list.push(i);
      groups.set(i.venue, list);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([venue, list]) => ({ venue, count: list.length, instruments: list.sort(byId) }));
  }

  /** Alle unterschiedlichen Underlyings des Universums (nach ID sortiert). */
  underlyings(): Underlying[] {
    this.load();
    const map = new Map<string, Underlying>();
    for (const i of this.items.values()) {
      const u = underlyingOf(i);
      if (!map.has(u.id)) map.set(u.id, u);
    }
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Alle Instrumente eines Underlyings — die „Dreifach-Existenz“-Sicht auf BTC. */
  instrumentsForUnderlying(underlyingId: string): MarketInstrument[] {
    return this.query({ underlying: underlyingId, pageSize: 500 }).items;
  }

  /** Zählt Instrumente je Venue über das gesamte Universum. */
  countByVenue(): Record<string, number> {
    this.load();
    const out: Record<string, number> = {};
    for (const i of this.items.values()) out[i.venue] = (out[i.venue] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  // ── intern ────────────────────────────────────────────────────────────────

  private peekExisting(raw: InstrumentInput): MarketInstrument | null {
    if (!raw || typeof raw !== "object") return null;
    try {
      return this.get(`${normalizeVenue(raw.venue)}:${normalizeSymbol(raw.symbol)}`);
    } catch {
      return null;
    }
  }

  /** Bestand + Eingabe zusammenführen (siehe Konfliktverhalten in `upsert`). */
  private mergeInput(existing: MarketInstrument | null, input: InstrumentInput): InstrumentInput {
    if (!existing) return input;
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      // Metriken: null = „kein neuer Wert“, Bestand bleibt erhalten.
      if (value === null && (key === "volume24h" || key === "spread" || key === "volatility")) continue;
      merged[key] = value;
    }
    merged.lastSeen = input.lastSeen ?? this.now().toISOString();
    return merged as InstrumentInput;
  }

  private audit(entry: UniverseAuditEntry): void {
    for (const sink of this.sinks) {
      try {
        void sink(entry);
      } catch (e) {
        console.warn("[universe] Audit-Senke fehlgeschlagen:", e instanceof Error ? e.message : String(e));
      }
    }
    void writeDbAudit(entry);
  }
}

function safeLoadPolicy(): UniversePolicy {
  try {
    return loadPolicy();
  } catch (e) {
    // Eine kaputte Override-Datei darf nicht still zu einer schwächeren Policy
    // führen — sie ist ein harter Startfehler.
    throw new Error(`Universe-Policy konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Standard-Quelle für Audit-Einträge des Seed-Imports. */
export const SEED_SOURCE = "seed:watchlist";

/** Wiederverwendbare Sanitizer-Referenz für API-Schichten. */
export { sanitizeSource, DEFAULT_POLICY };
