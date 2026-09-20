/**
 * Capability-Matrix der Perpetual-**Daten** je Venue (RMA-P2-02).
 *
 * ── Warum eine eigene Matrix? ────────────────────────────────────────────────
 * `src/brokers/capabilities.ts` antwortet auf die Frage „kann dieses Venue
 * handeln?“ (`marketData`, `trading`, `paper`, `live`). Für historische
 * Perp-Zeitreihen ist das zu grob: **nicht jede Perp-Venue liefert jede
 * Reihenart als öffentliche Historie.** Die Bitunix-Futures-API hat einen
 * Funding-History-Endpunkt, aber keinen öffentlichen Open-Interest- oder
 * Liquidations-Endpunkt. Diese Matrix hält genau diesen Unterschied fest —
 * und zwar **typisiert**, damit ein Consumer „gibt es nicht“ von „heute
 * gestört“ und von „leere Periode“ unterscheiden kann (Baseline-Regel 3).
 *
 * ── Abgrenzung zur Broker-Matrix (keine zweite Wahrheit) ─────────────────────
 * 1. `marketData === true` bleibt Voraussetzung: meldet die Broker-Matrix
 *    keinen öffentlichen Market-Data-Pfad, kann hier nichts supported sein.
 * 2. `instrumentTypes.perpetual !== true` ⇒ **alle** Perp-Reihen
 *    `VENUE_NOT_PERP` (Spot-only-Venuen wie ALPACA erfinden keine Perp-Daten).
 * 3. Diese Matrix addiert die Endpunkt-Realität je Reihenart.
 *
 * `PERP_VENUE_SUPPORT` ist bewusst eine **offene** Tabelle: eine neue Venue
 * ergänzt eine Zeile, der Kern bleibt unverändert. Unbekannte Venues fallen
 * auf `NO_PUBLIC_ENDPOINT` zurück — nicht auf „unterstützt, aber leer“.
 */
import { VENUE_CAPABILITIES } from "../brokers/capabilities";
import type { BrokerVenueId } from "../contracts/broker";
import type {
  PerpKindCapability,
  PerpSeriesKind,
  PerpVenueCapabilities,
} from "./types";

/** Deklarierte Endpunkt-Realität einer Venue (nur `supported`-Einträge). */
interface PerpVenueSupportEntry {
  funding?: { sourceId: string; note?: string };
  openInterest?: { sourceId: string; note?: string };
  liquidations?: { sourceId: string; note?: string };
}

/**
 * Bekannte Perp-Datenquellen.
 *
 * | Venue    | funding | openInterest | liquidations | Begründung                                                            |
 * | -------- | ------- | ------------ | ------------ | --------------------------------------------------------------------- |
 * | `BITUNIX`| ✓       | ✗            | ✗            | `get_funding_rate_history` vorhanden; OI/Liquidationen haben **keinen** öffentlichen Endpunkt (dokumentierte Futures-API) |
 * | `SIM`    | ✓       | ✓            | ✓            | deterministischer Fixture-Adapter (Tests/Isolation, keine Produktionsquelle) |
 */
export const PERP_VENUE_SUPPORT: Readonly<Record<string, PerpVenueSupportEntry>> = {
  BITUNIX: {
    funding: {
      sourceId: "bitunix:funding_history",
      note: "GET /api/v1/futures/market/get_funding_rate_history (max 200 Zeilen je Request, 10 req/s/IP)",
    },
  },
  SIM: {
    funding: { sourceId: "sim:fixture_funding", note: "deterministischer Fixture-Adapter" },
    openInterest: { sourceId: "sim:fixture_open_interest", note: "deterministischer Fixture-Adapter" },
    liquidations: { sourceId: "sim:fixture_liquidations", note: "deterministischer Fixture-Adapter" },
  },
};

/** Alle Venues, die hier überhaupt eine Perp-Datenquelle deklarieren. */
export const PERP_KNOWN_VENUES: readonly string[] = Object.keys(PERP_VENUE_SUPPORT);

/** Reihenarten in kanonischer Reihenfolge (stabile Ausgabe, keine Sortier-Roulette). */
export const PERP_KIND_ORDER: readonly PerpSeriesKind[] = [
  "funding",
  "openInterest",
  "liquidations",
];

function kindKey(kind: PerpSeriesKind): keyof PerpVenueSupportEntry {
  return kind;
}

/** Unterstützte Reihenarten einer Venue (für Behebungshinweise). */
export function supportedPerpKinds(venue: string): PerpSeriesKind[] {
  const caps = perpCapabilitiesFor(venue);
  return PERP_KIND_ORDER.filter((kind) => caps[kind].supported);
}

/**
 * Capability-Bild einer Venue (rein, deterministisch, ohne IO).
 *
 * Die Prüfung läuft in drei Stufen und endet **nie** in einem Ratewert:
 * 1. Broker-Matrix: existiert das Venue und meldet `marketData`?
 * 2. Markttyp: hat das Venue Perpetuals (`instrumentTypes.perpetual`)?
 * 3. Endpunkt: deklariert `PERP_VENUE_SUPPORT` genau diese Reihenart?
 */
export function perpCapabilitiesFor(venueRaw: string): PerpVenueCapabilities {
  const venue = venueRaw.trim().toUpperCase();
  const brokerCaps = (VENUE_CAPABILITIES as Record<string, (typeof VENUE_CAPABILITIES)[BrokerVenueId] | undefined>)[venue];
  const hasMarketData = brokerCaps ? brokerCaps.marketData === true : venue === "SIM";
  const isPerpVenue = brokerCaps
    ? brokerCaps.instrumentTypes.perpetual === true
    : venue === "SIM";
  const support = PERP_VENUE_SUPPORT[venue] ?? {};

  const build = (kind: PerpSeriesKind): PerpKindCapability => {
    const entry = support[kindKey(kind)];
    if (!hasMarketData) {
      return {
        supported: false,
        reason: "NO_PUBLIC_ENDPOINT",
        note: `${venue} meldet in der Capability-SSoT (src/brokers/capabilities.ts) keinen öffentlichen Market-Data-Pfad.`,
      };
    }
    if (!isPerpVenue) {
      return {
        supported: false,
        reason: "VENUE_NOT_PERP",
        note: `${venue} führt laut Capability-SSoT keine Perpetuals — historische Perp-Daten werden hier nicht erfunden.`,
      };
    }
    if (!entry) {
      return {
        supported: false,
        reason: "NO_PUBLIC_ENDPOINT",
        note: `${venue} hat für ${kind} keinen dokumentierten, öffentlichen Endpunkt (Gap, kein Messwert 0).`,
      };
    }
    return { supported: true, sourceId: entry.sourceId, ...(entry.note ? { note: entry.note } : {}) };
  };

  return {
    venue,
    funding: build("funding"),
    openInterest: build("openInterest"),
    liquidations: build("liquidations"),
  };
}

/** Capability genau einer Reihenart. */
export function perpCapabilityFor(
  venue: string,
  kind: PerpSeriesKind
): PerpKindCapability {
  return perpCapabilitiesFor(venue)[kind];
}

/** `true` nur, wenn die Venue diese Reihenart tatsächlich liefert. */
export function perpsAreSupported(venue: string, kind: PerpSeriesKind): boolean {
  return perpCapabilityFor(venue, kind).supported;
}

/**
 * Querschnittsmatrix aller bekannten Venues (read-only Ops-Ansicht, sortiert).
 *
 * Enthalten sind die Broker-Venues **und** die hier deklarierten Quellen, damit
 * das Statusbild keine Lücke vorgaukelt: eine Venue, die nur hier steht, ist
 * sichtbar, eine Venue ohne Eintrag ebenso.
 */
export function perpCapabilityMatrix(): PerpVenueCapabilities[] {
  const venues = new Set<string>([
    ...Object.keys(VENUE_CAPABILITIES),
    ...PERP_KNOWN_VENUES,
  ]);
  return [...venues]
    .map((v) => v.toUpperCase())
    .sort()
    .map((venue) => perpCapabilitiesFor(venue));
}
