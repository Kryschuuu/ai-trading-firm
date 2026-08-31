/**
 * Sektion „Market Data“ des Operations Centers (OPS-011).
 *
 * `collectMarketDataReadiness()` baut den {@link MarketDataOpsSnapshot} — die
 * Pipeline-Diagnose **oberhalb** des Scanner-Funnels. Sie beantwortet die
 * Betreiberfrage, die sechs Funnel-Nullen offen lassen:
 *
 *   - „Wir haben keine Kerzen geladen“            → `WARMING` (Warmup)
 *   - „Der Ticker-/Depth-Abruf ist ausgefallen“   → `ERROR`   (Infrastruktur)
 *   - „Der Markt bietet nichts Geeignetes“        → `READY`   (fachlich korrekt)
 *
 * **Reine Lesefunktion:** Registry-Query + Historical-Store-Zählung +
 * Readiness-Ableitung + zwischengespeicherte Sync-Ergebnisse
 * (`data/market-sync-status.json`, `data/market-data-errors.json`).
 * Kein Netzwerk-I/O, kein Sync-Trigger — ein Sync wird hier weder angestoßen
 * noch bewertet; sichtbar wird nur, was Discovery/Enrichment/Backfill zuvor
 * persistiert haben.
 *
 * Security:
 *  - Snapshot enthält nur Zähler, ISO-Zeitstempel, Instrument-IDs und die
 *    geschlossene `reason`-Taxonomie (MDERR-006) — keine Credentials, keine
 *    Env-Variablen, keine internen Dateipfade, keine Stacktraces, keine rohen
 *    Upstream-Messages.
 *  - `venues` ({@link MAX_SNAPSHOT_VENUES}) und `worstOffenders`
 *    ({@link MAX_SNAPSHOT_OFFENDERS}) sind hart gekappt.
 */

import { loadMarketDataErrors } from "@/marketdata/dataErrors";
import { loadVenueSyncStatuses, type VenueSyncStatus } from "@/marketdata/syncStatus";
import type { ScannerConfig } from "@/scanner/config";
import { getScannerService, loadAllInstruments } from "@/scanner/service";
import { requiredWarmupCandles } from "@/scanner/warmup";
import { getRegistry } from "@/universe";
import type { MarketInstrument } from "@/universe/types";

import {
  DISCOVERY_FRESHNESS_WINDOW_MS,
  marketDataReadinessStore,
  scannerCandleCounts,
} from "./marketDataReadiness";
import type { MarketDataOpsSnapshot, MarketDataOpsVenue, MarketDataOpsOffender } from "./types";

/** Obergrenze der „worst offenders“ im Snapshot (deckungsgleich mit WARMUP-004). */
export const MAX_SNAPSHOT_OFFENDERS = 10;

/** Obergrenze der Venue-Zeilen im Snapshot (kein Response-Wachstum). */
export const MAX_SNAPSHOT_VENUES = 10;

/**
 * Eingaben des Snapshots — vollständig injizierbar (⇒ hermetisch testbar).
 * Ohne Argument lädt {@link collectMarketDataReadiness} alles selbst aus den
 * lokalen Quellen (Registry, Historical Store, Manifeste) — auch dann ohne
 * Netzwerk-I/O.
 */
export interface MarketDataSnapshotInput {
  /** Betrachtete Instrumente (Registry-Inhalt, ggf. gekappt geladen). */
  instruments: readonly MarketInstrument[];
  /** Geladene Kerzen je Instrument-ID im Scanner-Timeframe. */
  candleCounts: ReadonlyMap<string, number>;
  /** Scanner-Konfiguration (Quelle von `requiredWarmupCandles`). */
  config: ScannerConfig;
  /** Tatsächliche Registry-Größe, falls `instruments` gekappt ist. */
  registrySize?: number;
  /** Echte Fetch-/Infrastrukturfehler (MDERR-006-Manifest). */
  dataErrors?: ReadonlyMap<string, string>;
  /** Zwischengespeicherte Sync-Ergebnisse je Venue (MDSYNC-001-Projektion). */
  syncStatuses?: readonly VenueSyncStatus[];
  /** Referenzzeitpunkt (ms) für Frische-Fenster und `generatedAt`; Default `Date.now()`. */
  now?: number;
  /** Frische-Fenster für `discovered`; Default 24 h. */
  freshnessWindowMs?: number;
}

/**
 * Baut den Market-Data-Snapshot für das Operations Center.
 *
 * Zählregeln:
 *  - `discovered`  — `lastSeen` innerhalb des Fensters (Zukunft zählt als
 *    frisch, Clock-Skew-tolerant); ungültige Zeitstempel zählen nicht.
 *  - `dataReady`   — Kerzen **≥** `requiredCandles` (Grenzwert gilt als ready).
 *  - `warming`     — `registry − dataReady` (nie negativ).
 *  - `tickerReady` — `volume24h !== null`; `spreadReady` — `spread !== null`
 *    (`null` heißt „unbekannt“, nicht „gut“).
 *  - `readinessStatus` — `ERROR` bei Einträgen im Fehler-Manifest
 *    (Infrastruktur schlägt Fachlogik); `READY` nur, wenn **jedes**
 *    Registry-Instrument vollständig ist (Kerzen + Ticker + Spread);
 *    sonst `WARMING`. `scannerReady ⇔ readinessStatus === "READY"`.
 *  - `worstOffenders` — deterministisch (candles asc, id asc), max. 10.
 */
export function collectMarketDataReadiness(input?: MarketDataSnapshotInput): MarketDataOpsSnapshot {
  const resolved = input ?? loadSnapshotInput();
  const { instruments, candleCounts, config } = resolved;
  const now = resolved.now ?? Date.now();
  const windowMs = Math.max(0, resolved.freshnessWindowMs ?? DISCOVERY_FRESHNESS_WINDOW_MS);
  const requiredCandles = requiredWarmupCandles(config);
  const registry = Math.max(0, Math.floor(resolved.registrySize ?? instruments.length));
  const dataErrorCount = resolved.dataErrors?.size ?? 0;

  let discovered = 0;
  let dataReady = 0;
  let tickerReady = 0;
  let spreadReady = 0;
  let complete = 0; // Kerzen UND Ticker UND Spread — Basis der READY-Entscheidung
  const offenders: MarketDataOpsOffender[] = [];
  const instrumentsByVenue = new Map<string, number>();

  for (const instrument of instruments) {
    instrumentsByVenue.set(instrument.venue, (instrumentsByVenue.get(instrument.venue) ?? 0) + 1);

    const seenMs = Date.parse(instrument.lastSeen);
    if (Number.isFinite(seenMs) && seenMs >= now - windowMs) discovered += 1;

    const candles = Math.max(0, candleCounts.get(instrument.id) ?? 0);
    const candlesReady = candles >= requiredCandles;
    const hasTicker = instrument.volume24h !== null;
    const hasSpread = instrument.spread !== null;

    if (candlesReady) dataReady += 1;
    else offenders.push({ instrumentId: instrument.id, candles, required: requiredCandles });
    if (hasTicker) tickerReady += 1;
    if (hasSpread) spreadReady += 1;
    if (candlesReady && hasTicker && hasSpread) complete += 1;
  }

  offenders.sort((a, b) =>
    a.candles !== b.candles
      ? a.candles - b.candles
      : a.instrumentId < b.instrumentId
        ? -1
        : a.instrumentId > b.instrumentId
          ? 1
          : 0,
  );

  const readinessStatus: MarketDataOpsSnapshot["readinessStatus"] =
    dataErrorCount > 0
      ? "ERROR"
      : registry > 0 && complete >= registry && instruments.length >= registry
        ? "READY"
        : "WARMING";

  const snapshot: MarketDataOpsSnapshot = {
    generatedAt: new Date(now).toISOString(),
    requiredCandles,
    registry,
    discovered,
    dataReady,
    warming: Math.max(registry - dataReady, 0),
    tickerReady,
    spreadReady,
    scannerReady: readinessStatus === "READY",
    readinessStatus,
    venues: buildVenueRows(resolved.syncStatuses ?? [], instrumentsByVenue),
    worstOffenders: offenders.slice(0, MAX_SNAPSHOT_OFFENDERS),
    hint: "",
  };
  snapshot.hint = buildReadinessHint(snapshot);
  return snapshot;
}

/**
 * Kontextabhängiger Hilfetext — zentral, nicht in der JSX verstreut.
 * Genau ein Hinweis je dominierendem Blocker (Reihenfolge = Dominanz):
 *
 *  1. `ERROR`                       — Infrastruktur, häufigste Ursache benannt.
 *  2. `WARMING`, keine Historie     — Sync-Kommando + Herleitung des Sollwerts.
 *  3. `WARMING`, Spread fehlt       — depth-Enrichment, `rule=max-spread`.
 *  4. `WARMING`, Teil-Warmup        — fehlende Instrumente werden benannt.
 *  5. `READY`                       — leerer Funnel ist eine fachliche Aussage.
 */
export function buildReadinessHint(s: MarketDataOpsSnapshot): string {
  if (s.readinessStatus === "ERROR") {
    const reason = dominantFailureReason(s.venues) ?? "RATE_LIMITED";
    return (
      `Market-Data-Abrufe schlagen fehl (haeufigste Ursache: ${reason}). ` +
      `Der leere Funnel ist ein Infrastrukturproblem, keine Marktbewertung. ` +
      `Naechster Schritt: Venue-Status und Request-Budget pruefen.`
    );
  }
  if (s.readinessStatus === "WARMING") {
    if (s.dataReady === 0) {
      return (
        `Es liegt noch keine Kerzenhistorie vor. ` +
        `Fuehre npm run market:sync -- --venue=BITUNIX aus. ` +
        `Benoetigt werden ${s.requiredCandles} Kerzen je Instrument, weil der konfigurierte ` +
        `Faktorsatz eine EMA50 und einen Momentum-Lookback von 60 Perioden enthaelt.`
      );
    }
    if (s.spreadReady === 0) {
      return (
        `Kerzen sind vorhanden, aber kein Spread. Der Spread stammt aus dem Orderbook ` +
        `(/market/depth) - der Ticker-Endpoint liefert ihn nicht. Ohne Spread lehnt der ` +
        `Scanner mit rule=max-spread ab (Datenqualitaet, nicht Marktqualitaet).`
      );
    }
    const missing = s.worstOffenders
      .slice(0, 3)
      .map((o) => `${o.instrumentId} (${o.candles}/${o.required} Kerzen)`)
      .join(", ");
    return (
      `Warmup unvollstaendig: ${s.warming} von ${s.registry} Instrument(en) ohne vollstaendige ` +
      `Datenbasis${missing ? ` - unvollstaendig: ${missing}` : ""}. ` +
      `Fuehre npm run market:sync -- --venue=BITUNIX erneut aus. ` +
      `Die Funnel-Nullen sind datenbedingt, keine Marktbewertung.`
    );
  }
  return (
    `Datenbasis vollstaendig. Ein leerer Funnel ist hier eine echte fachliche Aussage: ` +
    `aktuell erfuellt kein Instrument die Eignungskriterien.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// interne Helfer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live-Eingaben aus den lokalen Quellen — Registry, Historical Store und die
 * beiden persistierten Manifeste. Reine Datei-/Speicherzugriffe; die
 * Scanner-Konfiguration stammt aus exakt dem Scan, den das Ops-Center anzeigt.
 */
function loadSnapshotInput(): MarketDataSnapshotInput {
  const scan = getScannerService().getScan();
  const instruments = loadAllInstruments(); // gekappt (MAX_SERVICE_INSTRUMENTS) — DoS-Schutz
  return {
    instruments,
    candleCounts: scannerCandleCounts(
      marketDataReadinessStore(),
      instruments,
      scan.config.factors.correlation.benchmarkInstrumentId,
    ),
    config: scan.config,
    registrySize: getRegistry().size,
    dataErrors: loadMarketDataErrors(),
    syncStatuses: loadVenueSyncStatuses(),
  };
}

/**
 * Venue-Zeilen: persistierter Sync-Status ∪ Registry-Venues. Venues ohne
 * Sync-Status erscheinen mit `lastSyncAt: null` (sichtbar „nie gesynct“ statt
 * unsichtbar). Deterministisch sortiert (venue asc), gekappt.
 */
function buildVenueRows(
  syncStatuses: readonly VenueSyncStatus[],
  instrumentsByVenue: ReadonlyMap<string, number>,
): MarketDataOpsVenue[] {
  const rows = new Map<string, MarketDataOpsVenue>();
  for (const status of syncStatuses) {
    rows.set(status.venue, {
      venue: status.venue,
      lastSyncAt: status.lastSyncAt,
      lastSyncDegraded: status.lastSyncDegraded,
      instruments: instrumentsByVenue.get(status.venue) ?? status.instruments,
      failuresByReason: { ...status.failuresByReason },
    });
  }
  for (const [venue, count] of instrumentsByVenue) {
    if (!rows.has(venue)) {
      rows.set(venue, {
        venue,
        lastSyncAt: null,
        lastSyncDegraded: false,
        instruments: count,
        failuresByReason: {},
      });
    }
  }
  return [...rows.values()]
    .sort((a, b) => (a.venue < b.venue ? -1 : a.venue > b.venue ? 1 : 0))
    .slice(0, MAX_SNAPSHOT_VENUES);
}

/** Häufigste Fehlerursache über alle Venue-Zähler (deterministisch bei Gleichstand). */
function dominantFailureReason(venues: readonly MarketDataOpsVenue[]): string | null {
  const totals = new Map<string, number>();
  for (const venue of venues) {
    for (const [reason, count] of Object.entries(venue.failuresByReason)) {
      totals.set(reason, (totals.get(reason) ?? 0) + count);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [reason, count] of [...totals.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}
