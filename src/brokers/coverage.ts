/**
 * Broker-Coverage-Modell (Operations Center) — die getrennte Wahrheit über
 * „registrierte" vs. „tatsächlich abgedeckte" Venues.
 *
 * MOTIVATION: Eine reine Zählung „7 Broker" ist irreführend. Ein registriertes
 * Venue (Adapter existiert) sagt NICHTS darüber aus, welche Fähigkeiten der
 * Adapter tatsächlich ausführt. Dieses Modul projiziert die ehrliche Ist-Lage
 * aus der Single Source of Truth (`VENUE_CAPABILITIES`) plus dem Live-Gate-
 * Enforcer und macht sie für die UI/API transparent:
 *
 *   - registrierte Venues        (Adapter vorhanden)
 *   - Venues mit voller Discovery
 *   - Venues mit Paper-Market-Data
 *   - Venues mit aktiviertem Live-Trading
 *   - Coverage je Capability      (Discovery/Market-Data/Paper/Testnet/Live)
 *
 * REINES PROJEKTIONSMODUL — kein Netzwerk, keine Adapter-Instanzen. Die
 * Live-Bewertung wird injizierbar gehalten, damit Unit-Tests deterministisch
 * bleiben (Default: zentraler Live-Gate-Enforcer, read-only/audit:false).
 *
 * TERMINOLOGIE (bewusst getrennt):
 *   „registriert"  = das Repo kennt einen Adapter für dieses Venue.
 *   „abgedeckt"    = der Adapter-Code führt die Capability tatsächlich aus.
 *   „intern"       = PAPER-Simulator (kein reales externes Venue).
 *   „extern"       = reales Broker-/Exchange-Venue (alles außer PAPER).
 */
import { VENUE_CAPABILITIES } from "./capabilities";
import { BROKER_REGISTRY } from "../lib/broker";
import { BROKER_VENUE_IDS, type BrokerVenueId } from "../contracts/broker";
import { evaluateLiveOrder } from "../live-gate/enforcer";

/** Das interne Simulator-Venue (kein reales externes Venue). */
export const INTERNAL_VENUE: BrokerVenueId = "PAPER";

/** IDs der Coverage-Kennzahlen (Reihenfolge = Anzeige-Reihenfolge). */
export const COVERAGE_METRIC_IDS = [
  "discovery",
  "marketData",
  "paperExecution",
  "testnetExecution",
  "liveExecution",
] as const;

export type CoverageMetricId = (typeof COVERAGE_METRIC_IDS)[number];

/** Deutsch-lesbare Labels je Coverage-Kennzahl. */
export const COVERAGE_METRIC_LABELS: Record<CoverageMetricId, string> = {
  discovery: "Discovery Coverage",
  marketData: "Market Data Coverage",
  paperExecution: "Paper Execution Coverage",
  testnetExecution: "Testnet Execution Coverage",
  liveExecution: "Live Execution Coverage",
};

/** Eine Zeile der Coverage-Tabelle: ein Venue mit seinen aktuellen Fähigkeiten. */
export interface VenueCoverageRow {
  venue: BrokerVenueId;
  label: string;
  /** true = interner Simulator (PAPER), false = reales externes Venue. */
  internal: boolean;
  /** Adapter entdeckt Instrumente. */
  discovery: boolean;
  /** Adapter liefert Kurse/Kerzen. */
  marketData: boolean;
  /** Adapter betreibt ein Paper-Depot (simulierte Fills). */
  paperExecution: boolean;
  /** Adapter kann Broker-Testnet ausführen. */
  testnetExecution: boolean;
  /** Adapter KANN technisch Live-Orders senden (Capability, ≠ Freigabe). */
  liveCapable: boolean;
  /** Live-Trading ist AKTUELL freigegeben (Live-Gate-Entscheidung). */
  liveEnabled: boolean;
  /** Maschinenlesbarer Grund der Live-Entscheidung (Deny-/Allow-Code). */
  liveReason: string;
}

/** Eine Coverage-Kennzahl: wie viele Venues die Capability tatsächlich abdecken. */
export interface CoverageMetric {
  id: CoverageMetricId;
  label: string;
  /** Anzahl Venues, die das Kriterium erfüllen. */
  covered: number;
  /** Gesamtzahl betrachteter Venues (alle registrierten). */
  total: number;
  /** Venue-IDs, die das Kriterium erfüllen. */
  venues: BrokerVenueId[];
}

/** Aggregierte Coverage-Übersicht für das Operations Center. */
export interface BrokerCoverageSummary {
  /** Alle registrierten Venues (Adapter vorhanden). */
  registeredVenues: number;
  /** Interne Simulator-Venues (PAPER). */
  internalVenues: number;
  /** Reale externe Venues (alles außer PAPER). */
  externalVenues: number;
  /**
   * Headline-Kennzahlen — bewusst EXTERN gezählt (der interne PAPER-Simulator
   * verfälscht die Aussage über reale Venue-Integration nicht). Ergibt für den
   * aktuellen Stand exakt: 1 volle Discovery, 1 Paper-Market-Data, 0 Live.
   */
  fullDiscoveryVenues: number;
  paperMarketDataVenues: number;
  liveEnabledVenues: number;
  /** Coverage je Capability über ALLE registrierten Venues (ehrliche Ist-Lage). */
  metrics: CoverageMetric[];
  /** Detailtabelle: jedes Venue mit seinen Capabilities. */
  rows: VenueCoverageRow[];
}

/** Optionen zur Coverage-Berechnung (Injektion für deterministische Tests). */
export interface ComputeCoverageOptions {
  /**
   * Bewertet, ob Live-Trading für ein Venue AKTUELL freigegeben ist.
   * Default: zentraler Live-Gate-Enforcer (read-only, audit:false).
   * Rückgabe `{ enabled, reason }` — fail-safe: bei Fehler `enabled=false`.
   */
  liveDecision?: (venue: BrokerVenueId) => { enabled: boolean; reason: string };
}

/** Default-Live-Bewertung: zentraler Enforcer, read-only, fail-safe deny. */
function defaultLiveDecision(venue: BrokerVenueId): { enabled: boolean; reason: string } {
  try {
    const decision = evaluateLiveOrder(venue, { audit: false });
    return { enabled: decision.allowed, reason: decision.reason };
  } catch (err) {
    return {
      enabled: false,
      reason: `LIVE_GATE_LOCKED: Enforcer nicht bewertbar (${
        err instanceof Error ? err.message : String(err)
      }) — fail-safe deny.`,
    };
  }
}

/**
 * Berechnet die Coverage-Übersicht aus der Capability-SSoT und dem Live-Gate.
 *
 * DETERMINISTISCH bei injizierter `liveDecision`; ohne Injektion liest die
 * Funktion den zentralen Enforcer (read-only). Kein Netzwerk, keine IO.
 */
export function computeBrokerCoverage(
  opts: ComputeCoverageOptions = {}
): BrokerCoverageSummary {
  const liveDecision = opts.liveDecision ?? defaultLiveDecision;

  const rows: VenueCoverageRow[] = BROKER_VENUE_IDS.map((venue) => {
    const caps = VENUE_CAPABILITIES[venue];
    const live = liveDecision(venue);
    return {
      venue,
      label: BROKER_REGISTRY[venue].label,
      internal: venue === INTERNAL_VENUE,
      discovery: caps.discovery,
      marketData: caps.marketData,
      paperExecution: caps.paper,
      testnetExecution: caps.testnet,
      liveCapable: caps.live,
      liveEnabled: live.enabled,
      liveReason: live.reason,
    };
  });

  const total = rows.length;
  const collect = (pred: (row: VenueCoverageRow) => boolean): BrokerVenueId[] =>
    rows.filter(pred).map((r) => r.venue);

  const metricVenues: Record<CoverageMetricId, BrokerVenueId[]> = {
    discovery: collect((r) => r.discovery),
    marketData: collect((r) => r.marketData),
    paperExecution: collect((r) => r.paperExecution),
    testnetExecution: collect((r) => r.testnetExecution),
    liveExecution: collect((r) => r.liveEnabled),
  };

  const metrics: CoverageMetric[] = COVERAGE_METRIC_IDS.map((id) => ({
    id,
    label: COVERAGE_METRIC_LABELS[id],
    covered: metricVenues[id].length,
    total,
    venues: metricVenues[id],
  }));

  const external = rows.filter((r) => !r.internal);

  return {
    registeredVenues: total,
    internalVenues: rows.filter((r) => r.internal).length,
    externalVenues: external.length,
    // Headline bewusst EXTERN gezählt (Produktentscheidung).
    fullDiscoveryVenues: external.filter((r) => r.discovery && r.marketData).length,
    paperMarketDataVenues: external.filter((r) => r.paperExecution && r.marketData).length,
    // Live-Freigabe wird über ALLE Venues gezählt (Freigabe kann nie intern sein).
    liveEnabledVenues: rows.filter((r) => r.liveEnabled).length,
    metrics,
    rows,
  };
}
