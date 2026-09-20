/**
 * Konsumenten der kanonischen Perp-Daten (RMA-P2-02, Aufgabe 6).
 *
 * Drei Stellen, die vorher ohne Quelle (oder mit Momentwert) gearbeitet haben,
 * lesen jetzt dieselbe as-of-Ablage:
 *
 *   1. **Scanner** — `DerivativeContext` (Funding/Open-Interest-Faktoren).
 *   2. **Backtest/Paper** — Funding-Rate-Provider (`src/lib/funding.ts`) mit
 *      as-of-Satz aus der Historie statt statischer Default-Rate.
 *   3. **Analystensnapshot** — Textzeile im Research-Kontext mit Satz, Alter
 *      und Begründung, wenn nichts da ist.
 *
 * Die Regel in allen drei Fällen: **fehlend oder veraltet bleibt fehlend**.
 * Ein Snapshot trägt `availability` plus `reasons` und liefert `null`-Felder —
 * die Faktoren fallen auf ihren dokumentierten Neutralwert (Neutralität),
 * nicht auf eine erfundene Rate und schon gar nicht auf `0` („kein Funding“
 * ist eine Marktaussage, kein Ausfallzustand).
 *
 * `PERP_DATA_ENABLED=false` (Default) bedeutet: diese Funktionen werden nicht
 * aufgerufen bzw. liefern eine leere Karte — das Scanner-/Backtest-Verhalten
 * ist dann **bitidentisch** zu v1.53.0.
 */
import { metricLabel, telemetry } from "../lib/telemetry";
import type { DerivativeContext } from "../scanner/types";
import type { FundingRateProvider } from "../lib/funding";
import type { MarketInstrument } from "../universe/types";
import { loadPerpDerivativeCache } from "./derivativeCache";
import type { PerpConfig } from "./config";
import { queryPerpSeries, type PerpAsOfRequest } from "./query";
import type { PerpSeriesSource } from "./ports";
import {
  PERP_LIMITS,
  type PerpFundingRow,
  type PerpLiquidationRow,
  type PerpOpenInterestBasis,
  type PerpOpenInterestRow,
  type PerpSeriesKind,
  type PerpSeriesResult,
  type PerpVenueCapabilities,
  perpRowIsAttestable,
} from "./types";

const HOUR = 3_600_000;

/** Verfügbarkeit eines Snapshots (bewusst feiner als „da / nicht da“). */
export type PerpSnapshotAvailability =
  | "AVAILABLE"
  | "PARTIAL"
  | "MISSING"
  | "STALE"
  | "UNSUPPORTED"
  | "UNAVAILABLE";

/** Alles, was ein Konsument über die Perp-Lage eines Instruments weiß. */
export interface PerpDerivativeSnapshot {
  instrumentId: string;
  venue: string;
  symbol: string;
  /** Aggregierte Verfügbarkeit (schlimmste Teilverfügbarkeit). */
  availability: PerpSnapshotAvailability;
  /** Grund je Reihe — stabil, maschinenlesbar (API/Audit/UI). */
  reasons: Record<PerpSeriesKind, string>;
  /** Jüngste verfügbare Funding-Rate je Intervall (signiert). */
  fundingRate: number | null;
  /** Intervall dieses Satzes (Stunden); `null` = Venue meldet keins. */
  fundingIntervalHours: number | null;
  fundingEventTime: string | null;
  fundingAgeMs: number | null;
  /** Nächstes Settlement, wenn die Quelle es je gemeldet hat (nur Anzeige). */
  nextFundingTime: string | null;
  /** Open Interest **in Quote-Währung** (Vertrag des Scanner-Kontexts). */
  openInterest: number | null;
  openInterestBasis: PerpOpenInterestBasis | null;
  openInterestChange24h: number | null;
  openInterestAgeMs: number | null;
  /** Liquidationen im gelesenen Fenster (Anzahl, Notional-Summe). */
  liquidationEvents: number | null;
  liquidationNotionalQuote: number | null;
  /** As-of-Zeitpunkt der Antwort (ISO) — macht den Snapshot nachvollziehbar. */
  asOf: string;
}

/** Reihenergebnis → Status des Snapshots (mappt `PerpSeriesResult`). */
function availabilityOf(result: PerpSeriesResult | undefined): PerpSnapshotAvailability {
  if (result === undefined) return "UNAVAILABLE";
  switch (result.availability) {
    case "AVAILABLE":
      return result.truncated ? "PARTIAL" : "AVAILABLE";
    case "MISSING":
      return "MISSING";
    case "STALE":
      return "STALE";
    case "UNSUPPORTED":
      return "UNSUPPORTED";
    default:
      return "UNAVAILABLE";
  }
}

const RANK: Record<PerpSnapshotAvailability, number> = {
  AVAILABLE: 0,
  PARTIAL: 1,
  MISSING: 2,
  STALE: 3,
  UNSUPPORTED: 4,
  UNAVAILABLE: 5,
};

function worst(a: PerpSnapshotAvailability, b: PerpSnapshotAvailability): PerpSnapshotAvailability {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Jüngste Zeile einer Reihe (as-of-sortiert, `null` ohne Treffer). */
/** Kurzer, wortgrenzengerechter Textschnitt (Gründe landen in Logs/Artefakt). */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  const at = head.lastIndexOf(" ");
  return `${(at > max * 0.6 ? head.slice(0, at) : head).replace(/[,.;:]$/, "")}…`;
}

/** Symbolform für Vergleich über Formate hinweg („BTC/USDT“ ⇒ „BTCUSDT“). */
function normalizePerpSymbolKey(value: string): string {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function latest<T extends { eventTime: Date }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (best === null || row.eventTime.getTime() > best.eventTime.getTime()) best = row;
  }
  return best;
}

/** Zeile_next_to (as-of-sortiert) zu einem Zielzeitpunkt, innerhalb `toleranceMs`. */
function nearestTo<T extends { eventTime: Date }>(
  rows: readonly T[],
  targetMs: number,
  toleranceMs: number
): T | null {
  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const delta = Math.abs(row.eventTime.getTime() - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = row;
    }
  }
  return bestDelta <= toleranceMs ? best : null;
}

/** OI-Größe in Quote-Währung — nur wenn die Quelle sie auch so gemeldet hat. */
function quoteUnitValue(row: PerpOpenInterestRow | null): number | null {
  if (row === null) return null;
  // `basis === "quote_units"`: direkt gemeldet. Alles andere (auch eine
  // abgeleitete `quoteValue`) wird **nicht** verwendet, wenn die Ableitung
  // nicht als solche gekennzeichnet und mit Mark-Preis unterlegt ist — eine
  // still umgedeutete Größe wäre ein falscher Input mit richtiger Optik.
  if (row.basis === "quote_units" && row.quoteValue !== null) return row.quoteValue;
  if (row.quoteValue !== null && row.converted && row.markPrice !== null) return row.quoteValue;
  return null;
}

/** Autoritative Größe einer OI-Zeile für die Δ24h-Prüfung (immer gleiche Einheit). */
function authoritativeValue(row: PerpOpenInterestRow): number | null {
  if (row.basis === "quote_units") return row.quoteValue;
  if (row.basis === "base_units") return row.baseQuantity;
  return row.contracts;
}

/**
 * Baut die Snapshots für einen Satz Instrumente (ein as-of-Lauf, alle Reihen).
 *
 * Begrenzt durch `PERP_LIMITS.queryInstruments`; die Aufruferin kapt, bevor sie
 * aufruft (Scanner: Shortlist ≤ 40). Fehler der Ablage werden **je Instrument**
 * zu `UNAVAILABLE` (mit Grund), nicht zu einem Wurf, der den ganzen Scan
 * abwürgt — und auch nicht zu „keine Daten“.
 */
export async function buildPerpDerivativeSnapshots(input: {
  source: PerpSeriesSource;
  config: PerpConfig;
  instruments: readonly MarketInstrument[];
  asOfMs: number;
  /** Fenster für die Δ24h- und Liquidations-Aggregat-Prüfung. */
  lookbackMs?: number;
  capabilitiesFor?: (venue: string) => PerpVenueCapabilities | null;
}): Promise<Map<string, PerpDerivativeSnapshot>> {
  const out = new Map<string, PerpDerivativeSnapshot>();
  const instruments = input.instruments.slice(0, PERP_LIMITS.queryInstruments);
  if (instruments.length === 0) return out;
  const lookbackMs = input.lookbackMs ?? 24 * HOUR;
  const request: PerpAsOfRequest = {
    instruments: instruments.map((instrument) => instrument.id),
    fromMs: input.asOfMs - lookbackMs - 2 * HOUR,
    toMs: null,
    asOfMs: input.asOfMs,
    limit: 1 + Math.ceil(lookbackMs / Math.max(1, input.config.oiIntervalMinutes * 60_000)),
  };
  let response;
  try {
    response = await queryPerpSeries(input.source, request, {
      config: input.config,
      // Alter und Staleness werden gegen das as-of gemessen, nicht gegen die
      // Wanduhr: dieselbe replayte Abfrage muss dasselbe Ergebnis liefern.
      nowMs: input.asOfMs,
      ...(input.capabilitiesFor ? { capabilitiesFor: input.capabilitiesFor } : {}),
    });
  } catch (error) {
    // Ablage nicht erreichbar: jeder Eintrag wird UNAVAILABLE, der Scan läuft
    // mit Neutralwerten weiter (existierendes Verhalten), aber *sichtbar*.
    const reason = `STORE_UNAVAILABLE (${clip(String((error as Error).message ?? ""), 120)})`;
    for (const instrument of instruments) {
      out.set(instrument.id, unavailableSnapshot(instrument, input.asOfMs, reason));
    }
    return out;
  }

  const byInstrument = new Map<string, Map<PerpSeriesKind, PerpSeriesResult>>();
  for (const serie of response.series) {
    const inner = byInstrument.get(serie.instrumentId) ?? new Map<PerpSeriesKind, PerpSeriesResult>();
    inner.set(serie.kind, serie);
    byInstrument.set(serie.instrumentId, inner);
  }

  for (const instrument of instruments) {
    const perKind = byInstrument.get(instrument.id) ?? new Map<PerpSeriesKind, PerpSeriesResult>();
    const fundingResult = perKind.get("funding") ?? null;
    const oiResult = perKind.get("openInterest") ?? null;
    const liqResult = perKind.get("liquidations") ?? null;

    // Belegbarkeit zuerst: ein Satz mit `INVALID`/`CROSSCHECK`-Befund trägt
    // zwar eine Zahl, aber keine belastbare Aussage — die darf nie ungeprüft
    // in ein Signal, einen Cache oder ein Analysten-Argument geraten.
    const fundingRowsRaw = (fundingResult?.rows ?? []) as readonly PerpFundingRow[];
    const fundingRows = fundingRowsRaw.filter(perpRowIsAttestable);
    const fundingLatest = latest(
      fundingRows.filter((row) => row.fundingRate !== null)
    );
    const oiRowsRaw = (oiResult?.rows ?? []) as readonly PerpOpenInterestRow[];
    const oiRows = oiRowsRaw.filter(perpRowIsAttestable);
    const oiWithUnit = oiRows.filter((row) => quoteUnitValue(row) !== null);
    const oiLatest = latest(oiRows);
    const oiLatestQuote = latest(oiWithUnit);
    const target24h = input.asOfMs - lookbackMs;
    const oiBaseline = nearestTo(
      oiRows.filter((row) => row.basis === (oiLatest?.basis ?? "none")),
      target24h,
      3 * HOUR
    );

    // Alter je Reihe gegen die **Ereigniszeit**: die as-of-Grenze
    // (`availableAt <= asOf`) regelt, was überhaupt gesehen werden darf; die
    // Frische eines Satzes bemisst sich daran, wie alt das Ereignis ist. Sonst
    // wäre unter `ingested`-Politik alles frisch — und „veraltet“ fiele als
    // Unterscheidungsgrund komplett weg.
    const fundingAgeMs =
      fundingLatest === null
        ? null
        : Math.max(0, input.asOfMs - fundingLatest.eventTime.getTime());
    const openInterestAgeMs =
      oiLatestQuote === null
        ? null
        : Math.max(0, input.asOfMs - oiLatestQuote.eventTime.getTime());
    const oiValue = quoteUnitValue(oiLatestQuote);
    const oiBaselineValue = oiBaseline === null ? null : quoteUnitValue(oiBaseline);
    const change =
      oiValue !== null && oiBaselineValue !== null && oiBaselineValue > 0
        ? (oiValue - oiBaselineValue) / oiBaselineValue
        : null;

    const liquidationsRaw = (liqResult?.rows ?? []) as readonly PerpLiquidationRow[];
    const liquidations = liquidationsRaw.filter(perpRowIsAttestable);
    const inWindow = liquidations.filter((row) => {
      const ms = row.eventTime.getTime();
      return ms > input.asOfMs - lookbackMs && ms <= input.asOfMs;
    });
    const notional = inWindow.every((row) => row.notionalQuote !== null)
      ? inWindow.reduce((sum, row) => sum + (row.notionalQuote ?? 0), 0)
      : null;

    const availability = worst(
      worst(availabilityOf(fundingResult ?? undefined), availabilityOf(oiResult ?? undefined)),
      availabilityOf(liqResult ?? undefined)
    );
    const reasons: Record<PerpSeriesKind, string> = {
      funding: fundingResult?.reason ?? "NO_RESULT",
      openInterest: oiResult?.reason ?? "NO_RESULT",
      liquidations: liqResult?.reason ?? "NO_RESULT",
    };
    if (fundingLatest === null && fundingRowsRaw.length > 0) {
      reasons.funding = PERP_UNATTESTABLE_REASON;
    }
    if (oiLatest === null && oiRowsRaw.length > 0) {
      reasons.openInterest = PERP_UNATTESTABLE_REASON;
    }
    if (oiValue === null && oiLatest !== null && availabilityOf(oiResult ?? undefined) === "AVAILABLE") {
      reasons.openInterest = "OI_NOT_REPORTED_IN_QUOTE_UNITS";
    }
    if (change === null && oiValue !== null) {
      reasons.openInterest = "OI_24H_BASELINE_MISSING";
    }

    out.set(instrument.id, {
      instrumentId: instrument.id,
      venue: instrument.venue,
      symbol: instrument.symbol,
      availability,
      reasons,
      fundingRate: fundingLatest?.fundingRate ?? null,
      fundingIntervalHours: fundingLatest?.intervalHours ?? null,
      fundingEventTime: fundingLatest ? fundingLatest.eventTime.toISOString() : null,
      fundingAgeMs,
      nextFundingTime: fundingLatest?.nextFundingTime ? fundingLatest.nextFundingTime.toISOString() : null,
      openInterest: oiValue,
      openInterestBasis: oiLatestQuote?.basis ?? null,
      openInterestChange24h: change,
      openInterestAgeMs,
      // „keine Daten“ ist nicht „ruhiger Markt“: ohne verfügbare Reihe bleibt
      // beides null (0 wäre ein Signal, das die Venue nie geliefert hat).
      liquidationEvents: liqResult === null || liqResult.availability !== "AVAILABLE" ? null : inWindow.length,
      liquidationNotionalQuote:
        liqResult === null || liqResult.availability !== "AVAILABLE" ? null : inWindow.length === 0 ? 0 : notional,
      asOf: new Date(input.asOfMs).toISOString(),
    });
  }
  return out;
}

/** Grund, wenn eine Reihe Sätze hat, die Qualitätsschicht sie aber nicht belegt. */
const PERP_UNATTESTABLE_REASON = "ALL_ROWS_UNATTESTABLE";

function unavailableSnapshot(instrument: MarketInstrument, asOfMs: number, reason: string): PerpDerivativeSnapshot {
  return {
    instrumentId: instrument.id,
    venue: instrument.venue,
    symbol: instrument.symbol,
    availability: "UNAVAILABLE",
    reasons: { funding: reason, openInterest: reason, liquidations: reason },
    fundingRate: null,
    fundingIntervalHours: null,
    fundingEventTime: null,
    fundingAgeMs: null,
    nextFundingTime: null,
    openInterest: null,
    openInterestBasis: null,
    openInterestChange24h: null,
    openInterestAgeMs: null,
    liquidationEvents: null,
    liquidationNotionalQuote: null,
    asOf: new Date(asOfMs).toISOString(),
  };
}

/**
 * Mapping auf den bestehenden Scanner-Kontext. **Additiv**: Die vier Felder von
 * `DerivativeContext` bleiben unverändert belegt; die Verfügbarkeit liegt im
 * Snapshot, den der Provider selbst mitführt (see `perpDerivativeProvider`).
 */
export function perpSnapshotToDerivativeContext(
  snapshot: PerpDerivativeSnapshot | null | undefined
): DerivativeContext | null {
  if (snapshot === null || snapshot === undefined) return null;
  return {
    fundingRate: snapshot.fundingRate,
    fundingIntervalHours: snapshot.fundingIntervalHours,
    openInterest: snapshot.openInterest,
    openInterestChange24h: snapshot.openInterestChange24h,
  };
}

/**
 * `ScanDataProvider.derivatives` aus einer vorbereiteten Snapshot-Karte.
 *
 * Der Sync-Provider kann nicht selbst lesen (er wird synchron je Instrument
 * aufgerufen) — die Karte wird **einmal pro Lauf** as-of gebaut. Fehlt ein
 * Eintrag, liefert der Provider `null`: die Faktoren bleiben bei ihrem
 * Neutralwert, als wäre die Quelle nicht vorhanden (Default `PERP_DATA_ENABLED
 * = false`).
 */
export function perpDerivativeProvider(
  snapshots: ReadonlyMap<string, PerpDerivativeSnapshot>,
  options: { onUnavailable?: (instrumentId: string, snapshot: PerpDerivativeSnapshot) => void } = {}
): (instrument: MarketInstrument) => DerivativeContext | null {
  return (instrument) => {
    const snapshot = snapshots.get(instrument.id) ?? null;
    if (snapshot === null) return null;
    if (snapshot.availability === "UNAVAILABLE" || snapshot.availability === "MISSING") {
      options.onUnavailable?.(instrument.id, snapshot);
    }
    const context = perpSnapshotToDerivativeContext(snapshot);
    if (context === null) return null;
    const hasAnything =
      context.fundingRate !== null ||
      context.fundingIntervalHours !== null ||
      context.openInterest !== null ||
      context.openInterestChange24h !== null;
    // `null` statt `{fundingRate: 0, …}`: „kein Kontext“ ist die vertragliche
    // Sprache des Scanners für „Quelle nicht verfügbar“.
    return hasAnything ? context : null;
  };
}

/**
 * as-of-Funding-Provider für `FundingAccrualEngine`
 * (`src/lib/funding.ts::FundingRateProvider`).
 *
 * Der Provider ist **vor** dem Lauf gefüllt (`load`) und antwortet synchron aus
 * dem Cache — die as-of-Grenze ist der zweite, vom Engine-Tick durchgereichte
 * Parameter. Ohne Satz, mit Grund: `null` ⇒ die Engine bleibt bei ihrem
 * dokumentierten statischen Default (Backtest-Verhalten wie vor v1.54.0); das
 * wird pro Symbol **einmal** laut, damit ein Dauer-Ausfall nicht wie eine
 * Default-Rate aussieht.
 */
export function createPerpFundingRateProvider(input: {
  source: PerpSeriesSource;
  config: PerpConfig;
  /** Instrumente je Engine-Symbol (Backtest-Symbol → kanonische ID). */
  instrumentOf: (symbol: string) => MarketInstrument | null;
  nowMs?: () => number;
  warn?: (line: string) => void;
}): FundingRateProvider & { load(args: { symbols: readonly string[]; fromMs: number; toMs: number }): Promise<void>; stats(): { hits: number; misses: number; symbols: number } } {
  const cache = new Map<string, { eventMs: number; availableMs: number; ratePer8h: number }[]>();
  const warned = new Set<string>();
  let hits = 0;
  let misses = 0;
  const warn = input.warn ?? ((line: string) => console.warn(line));
  return {
    async load({ symbols, fromMs, toMs }) {
      const unique = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].filter(Boolean);
      const byInstrument = new Map<string, string>();
      const instruments: MarketInstrument[] = [];
      for (const symbol of unique) {
        const instrument = input.instrumentOf(symbol);
        if (instrument === null) continue;
        byInstrument.set(instrument.id, symbol);
        instruments.push(instrument);
      }
      if (instruments.length === 0) return;
      const response = await queryPerpSeries(
        input.source,
        {
          instruments: instruments.map((instrument) => instrument.id),
          kinds: ["funding"],
          fromMs,
          toMs,
          asOfMs: toMs,
          limit: PERP_LIMITS.queryRowsPerSeries,
        },
        { config: input.config, nowMs: input.nowMs?.() ?? Date.now() }
      );
      for (const serie of response.series) {
        const symbol = byInstrument.get(serie.instrumentId);
        if (symbol === undefined) continue;
        const rows = (serie.rows as readonly PerpFundingRow[])
          .filter((row) => row.fundingRate !== null && perpRowIsAttestable(row))
          .map((row) => {
            const interval = row.intervalHours ?? input.config.fundingIntervalHours;
            return {
              eventMs: row.eventTime.getTime(),
              availableMs: row.availableAt.getTime(),
              // Engine-Skalierung rückgängig gemacht: pro Intervall → pro 8h.
              ratePer8h: (row.fundingRate as number) * (8 / Math.max(0.0001, interval)),
            };
          })
          .sort((a, b) => a.eventMs - b.eventMs);
        cache.set(symbol, rows);
      }
    },
    getFundingRate(symbol, asOfMs) {
      const key = String(symbol).toUpperCase();
      const rows = cache.get(key);
      const asOf = Number.isFinite(asOfMs as number) ? (asOfMs as number) : (input.nowMs?.() ?? Date.now());
      if (rows === undefined || rows.length === 0) {
        misses += 1;
        if (!warned.has(key)) {
          warned.add(key);
          warn(
            `[perpdata] ${key}: keine Funding-Historie as-of ${new Date(asOf).toISOString()} — ` +
              `Engine nutzt den konfigurierten Default (kein stiller Ersatz bei vorhandenem Bestand).`
          );
        }
        return null;
      }
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index]!;
        if (row.availableMs > asOf) continue;
        if (asOf - row.eventMs > input.config.maxStaleMs.funding) {
          if (!warned.has(key)) {
            warned.add(key);
            warn(
              `[perpdata] ${key}: jüngster Funding-Satz ist ${((asOf - row.eventMs) / HOUR).toFixed(1)} h alt ` +
                `(Grenze ${(input.config.maxStaleMs.funding / HOUR).toFixed(1)} h) — Staleness, nicht ungesehen.`
            );
          }
          misses += 1;
          return null;
        }
        hits += 1;
        return row.ratePer8h;
      }
      misses += 1;
      return null;
    },
    stats: () => ({ hits, misses, symbols: cache.size }),
  };
}

/**
 * Analystenzeilen aus dem Derivative-Artefakt (Research-Kontext, Zyklus-Steps).
 *
 * Der Analyst läuft pro Symbol und darf für diese Zeilen nicht die Datenbank
 * anfragen — er liest dasselbe Artefakt, das auch der Scanner liest. Fehlend
 * oder gesperrt ⇒ **keine** Zeile (der Prompt bleibt dann, wie er war), statt
 * einer Zeile mit erfundenen 0-Werten.
 */
export function perpAnalystSnapshotLinesFromCache(
  options: {
    maxLines?: number;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    nowMs?: number;
    maxAgeMs?: number;
    onlyUnavailable?: boolean;
    /** Artefaktpfad (Default {@link PERP_DERIVATIVE_CACHE_FILE}) — für Tests/Runs. */
    file?: string;
    /**
     * Nur Einträge dieses Symbols (Analysten laufen **pro Symbol**). Ein
     * Analystensymbol wie „BTC“ oder „BTC/USDT“ trifft auf „BTCUSDT“; ohne
     * Treffer kommen keine Zeilen — nie Zeilen eines fremden Symbols.
     */
    symbol?: string | null;
  } = {}
): string[] {
  const loaded = loadPerpDerivativeCache({
    ...(options.env ? { env: options.env } : {}),
    ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
    ...(options.file !== undefined ? { file: options.file } : {}),
  });
  if (loaded.cache === null) return [];
  const snapshots: PerpDerivativeSnapshot[] = [];
  const wanted = options.symbol ? normalizePerpSymbolKey(options.symbol) : null;
  for (const [instrumentId, entry] of Object.entries(loaded.cache.entries)) {
    if (options.onlyUnavailable === true && entry.availability === "AVAILABLE") continue;
    if (wanted !== null && wanted.length >= 2 && normalizePerpSymbolKey(entry.symbol) !== wanted) continue;
    snapshots.push({
      instrumentId,
      venue: entry.venue,
      symbol: entry.symbol,
      availability: entry.availability,
      reasons: entry.reasons,
      fundingRate: entry.fundingRate,
      fundingIntervalHours: entry.fundingIntervalHours,
      fundingEventTime: entry.fundingEventTime,
      fundingAgeMs: entry.fundingAgeMs,
      nextFundingTime: null,
      openInterest: entry.openInterest,
      openInterestBasis: entry.openInterestBasis,
      openInterestChange24h: entry.openInterestChange24h,
      openInterestAgeMs: null,
      liquidationEvents: entry.liquidationEvents,
      liquidationNotionalQuote: entry.liquidationNotionalQuote,
      asOf: loaded.cache.asOf,
    });
  }
  return perpAnalystSnapshotLines(snapshots, { maxLines: options.maxLines ?? 12 });
}

/** Zählt die Snapshot-Verfügbarkeiten in die Metrik (Label: Verfügbarkeit). */
export function recordPerpSnapshotAvailability(
  snapshots: Iterable<PerpDerivativeSnapshot>
): void {
  for (const snapshot of snapshots) {
    telemetry.perp.asOfQueries.inc({ result: metricLabel(snapshot.availability), kind: "snapshot" });
  }
}

/**
 * Analystensnapshot-Zeilen (Research-Kontext).
 *
 * Eine Zeile je Instrument, mit Satz, Alter und — wenn nichts da ist — dem
 * Grund. Ein Analyst soll „kein Funding-Satz, Venue meldet OI nicht“ lesen
 * können, nicht eine Lücke, die wie ein ruhiger Markt aussieht.
 */
export function perpAnalystSnapshotLines(
  snapshots: Iterable<PerpDerivativeSnapshot>,
  options: { maxLines?: number } = {}
): string[] {
  const lines: string[] = [];
  const max = Math.max(0, Math.min(options.maxLines ?? 40, 40));
  for (const snapshot of snapshots) {
    if (lines.length >= max) break;
    const fundingPart =
      snapshot.fundingRate === null
        ? `funding unavailable (${snapshot.reasons.funding})`
        : `funding ${(snapshot.fundingRate * 100).toFixed(4)} %/${snapshot.fundingIntervalHours ?? "?"}h ` +
          `@${snapshot.fundingEventTime ?? "?"}` +
          (snapshot.fundingAgeMs !== null ? ` age ${(snapshot.fundingAgeMs / HOUR).toFixed(1)}h` : "");
    const oiPart =
      snapshot.openInterest === null
        ? `OI unavailable (${snapshot.reasons.openInterest})`
        : `OI ${snapshot.openInterest.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${snapshot.openInterestBasis ?? ""}` +
          (snapshot.openInterestChange24h !== null
            ? ` Δ24h ${(snapshot.openInterestChange24h * 100).toFixed(2)} %`
            : ` Δ24h unavailable (${snapshot.reasons.openInterest})`);
    const liqPart =
      snapshot.liquidationEvents === null
        ? "liquidations unavailable"
        : `liquidations(24h) ${snapshot.liquidationEvents}` +
          (snapshot.liquidationNotionalQuote !== null
            ? ` ≈ ${snapshot.liquidationNotionalQuote.toLocaleString("en-US", { maximumFractionDigits: 0 })} quote`
            : " (notional nicht durchgehend gemeldet)");
    lines.push(`perp[${snapshot.symbol}@${snapshot.venue}] as-of ${snapshot.asOf}: ${fundingPart}; ${oiPart}; ${liqPart}`);
  }
  return lines;
}
