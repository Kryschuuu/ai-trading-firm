/**
 * Laufzeit-Projektion der Instrument-Verfügbarkeit (CAP-008).
 *
 * SICHERHEITSRELEVANT: `liveAvailable` ist NIEMALS ein Seed-Wert. Es ist die
 * Konjunktion aus fachlicher Freigabe, Venue-Capability, Adapter-Registrierung,
 * Feature-Flag und Live-Gate. Ein UI-/API-Konsument, der `liveAvailable=true`
 * für einen Stub anzeigt, kann zu einem Live-Trade-Versuch mit echtem Kapital
 * verleiten.
 *
 * Semantik:
 *   liveTradable   = fachlich für Live-Handel vorgesehen (Stammdaten/Produkt)
 *   liveAvailable  = technisch JETZT live handelbar (alle fünf Bedingungen)
 *   paperAvailable = Paper-Execution möglich (Stammdaten, durchgereicht)
 *
 * Fail-closed: unbekannte Venue, fehlende Capability-Deklaration oder
 * Ausnahme im Projektor ⇒ liveAvailable=false.
 *
 * Dies ist die EINZIGE Schreibstelle für `liveAvailable`.
 */
import { adaptersFromCatalog, lookupAdapter, type ProjectionAdapterView } from "../brokers/adapterCatalog";
import { capabilityMatrix, type CapabilityMatrix } from "../capabilities/matrix";
import type { BrokerCapabilities } from "../contracts/broker";
import { venueEnabledFromEnv } from "../live-gate/config";
import { evaluateLiveOrder as evaluateLiveOrderEnforcer } from "../live-gate/enforcer";
import { structuredLog } from "../lib/logger";
import type { MarketInstrument } from "./types";

/** Maschinenlesbare Gründe, warum liveAvailable=false (keine Secrets, keine Env-Werte). */
export const AVAILABILITY_REASON = {
  NOT_LIVE_TRADABLE: "NOT_LIVE_TRADABLE",
  VENUE_UNKNOWN: "VENUE_UNKNOWN",
  CAPABILITY_MISSING: "CAPABILITY_MISSING",
  CAPABILITY_TRADING_FALSE: "CAPABILITY_TRADING_FALSE",
  CAPABILITY_LIVE_FALSE: "CAPABILITY_LIVE_FALSE",
  ADAPTER_MISSING: "ADAPTER_MISSING",
  ADAPTER_STUB: "ADAPTER_STUB",
  FEATURE_FLAG_UNSET: "FEATURE_FLAG_UNSET",
  LIVE_GATE_CLOSED: "LIVE_GATE_CLOSED",
  PROJECTION_EXCEPTION: "PROJECTION_EXCEPTION",
} as const;

export type AvailabilityReasonCode = (typeof AVAILABILITY_REASON)[keyof typeof AVAILABILITY_REASON];

export interface AvailabilityProjection {
  paperAvailable: boolean;
  /** Aus Stammdaten/Produktentscheidung — der Projektor überschreibt das nicht. */
  liveTradable: boolean;
  /** Projiziert. Niemals ein Seed-Wert. */
  liveAvailable: boolean;
  /** Deterministische, maschinenlesbare Codes (leer genau dann, wenn liveAvailable). */
  reasons: AvailabilityReasonCode[];
}

export interface AvailabilityProjectionInput {
  venue: string;
  symbol?: string;
  id?: string;
  liveTradable?: boolean;
  paperAvailable?: boolean;
}

export type LiveOrderEvaluator = (venue: string) => { allowed: boolean };

export interface FeatureFlagView {
  /** true genau dann, wenn `${VENUE}_ENABLED` aus der Server-Env gesetzt ist. */
  isEnabled(venue: string): boolean;
}

export interface ProjectionContext {
  capabilities: CapabilityMatrix;
  adapters: ProjectionAdapterView;
  featureFlags: FeatureFlagView;
  evaluateLiveOrder: LiveOrderEvaluator;
}

export const LIVE_TRADABLE_TOOLTIP =
  "Fachlich fuer Live-Handel vorgesehen. Sagt nichts darueber aus, ob aktuell ein funktionsfaehiger Broker-Adapter existiert.";

export const LIVE_AVAILABLE_TOOLTIP =
  "Technisch jetzt live handelbar. Erfordert Adapter, aktivierte Venue-Capability, gesetztes Feature-Flag und ein geoeffnetes Live-Gate.";

export const SEED_LIVE_AVAILABLE_FORBIDDEN_MESSAGE =
  'Das Feld "liveAvailable" ist im Instrument-Seed nicht zulaessig. Live-Verfuegbarkeit ist ein Laufzeitzustand und wird aus Capability-Matrix, Adapter-Registrierung, Feature-Flag und Live-Gate projiziert. Nutze stattdessen "liveTradable" fuer die fachliche Freigabe.';

const lastLiveAvailable = new Map<string, boolean>();
const gateDecisionCache = new Map<string, boolean>();

function envFeatureFlags(env: NodeJS.ProcessEnv = process.env): FeatureFlagView {
  return {
    isEnabled(venue: string): boolean {
      return venueEnabledFromEnv(venue, env);
    },
  };
}

function defaultEvaluateLiveOrder(venue: string): { allowed: boolean } {
  const key = venue.trim().toUpperCase();
  const cached = gateDecisionCache.get(key);
  if (cached !== undefined) return { allowed: cached };
  let allowed = false;
  try {
    allowed = evaluateLiveOrderEnforcer(key, { audit: false }).allowed === true;
  } catch {
    allowed = false;
  }
  gateDecisionCache.set(key, allowed);
  return { allowed };
}

/** Default-Kontext: Capability-SSoT + statischer Adapter-Katalog + Server-Env + Live-Gate. */
export function defaultProjectionContext(): ProjectionContext {
  return {
    capabilities: capabilityMatrix,
    adapters: adaptersFromCatalog(),
    featureFlags: envFeatureFlags(),
    evaluateLiveOrder: defaultEvaluateLiveOrder,
  };
}

let injectedContext: ProjectionContext | null = null;

/** Nur Tests: Projektor-Kontext ersetzen (`null` = Default). */
export function setProjectionContextForTests(next: ProjectionContext | null): void {
  injectedContext = next;
  lastLiveAvailable.clear();
  gateDecisionCache.clear();
}

export function currentProjectionContext(): ProjectionContext {
  return injectedContext ?? defaultProjectionContext();
}

function instrumentKey(instrument: AvailabilityProjectionInput): string {
  if (typeof instrument.id === "string" && instrument.id) return instrument.id;
  const venue = String(instrument.venue ?? "").trim().toUpperCase();
  const symbol = String(instrument.symbol ?? "").trim().toUpperCase();
  return symbol ? `${venue}:${symbol}` : venue;
}

function closed(paperAvailable: boolean, liveTradable: boolean, reasons: AvailabilityReasonCode[]): AvailabilityProjection {
  return { paperAvailable, liveTradable, liveAvailable: false, reasons };
}

function auditLiveBecameTrue(key: string, venue: string): void {
  const prev = lastLiveAvailable.get(key);
  lastLiveAvailable.set(key, true);
  if (prev === true) return;
  structuredLog("info", "live_available_became_true", {
    venue,
    instrumentId: key,
    cause: "ALL_FIVE_CONDITIONS",
  });
}

/**
 * liveAvailable ist die Konjunktion aus:
 *   1. instrument.liveTradable === true
 *   2. capabilities[venue].trading === true
 *   3. registrierter Nicht-Stub-Adapter UND capabilities[venue].live === true
 *   4. featureFlags[`${venue}_ENABLED`] === true  (venueEnabledFromEnv)
 *   5. evaluateLiveOrder(venue, { audit: false }).allowed === true
 *
 * Fällt eine Bedingung weg, ist liveAvailable=false und der Grund landet in reasons[].
 */
export function projectInstrumentAvailability(
  instrument: AvailabilityProjectionInput,
  context: ProjectionContext = currentProjectionContext(),
): AvailabilityProjection {
  const paperAvailable = instrument.paperAvailable !== false;
  const liveTradable = instrument.liveTradable === true;

  try {
    const venueRaw = typeof instrument.venue === "string" ? instrument.venue.trim().toUpperCase() : "";
    const reasons: AvailabilityReasonCode[] = [];

    if (!liveTradable) reasons.push(AVAILABILITY_REASON.NOT_LIVE_TRADABLE);

    if (!venueRaw) {
      reasons.push(AVAILABILITY_REASON.VENUE_UNKNOWN);
      return closed(paperAvailable, liveTradable, reasons);
    }

    const caps: BrokerCapabilities | undefined = context.capabilities[venueRaw];
    if (!caps) {
      reasons.push(AVAILABILITY_REASON.CAPABILITY_MISSING);
      if (!context.adapters.has(venueRaw)) reasons.push(AVAILABILITY_REASON.ADAPTER_MISSING);
      reasons.push(AVAILABILITY_REASON.FEATURE_FLAG_UNSET);
      reasons.push(AVAILABILITY_REASON.LIVE_GATE_CLOSED);
      return closed(paperAvailable, liveTradable, uniqueReasons(reasons));
    }

    if (caps.trading !== true) reasons.push(AVAILABILITY_REASON.CAPABILITY_TRADING_FALSE);

    if (!context.adapters.has(venueRaw)) {
      reasons.push(AVAILABILITY_REASON.ADAPTER_MISSING);
    } else {
      const adapter = context.adapters.get(venueRaw);
      if (!adapter) {
        reasons.push(AVAILABILITY_REASON.ADAPTER_MISSING);
      } else if (adapter.isStub) {
        reasons.push(AVAILABILITY_REASON.ADAPTER_STUB);
      }
    }

    if (caps.live !== true) reasons.push(AVAILABILITY_REASON.CAPABILITY_LIVE_FALSE);

    if (context.featureFlags.isEnabled(venueRaw) !== true) {
      reasons.push(AVAILABILITY_REASON.FEATURE_FLAG_UNSET);
    }

    let gateAllowed = false;
    try {
      gateAllowed = context.evaluateLiveOrder(venueRaw).allowed === true;
    } catch {
      gateAllowed = false;
    }
    if (!gateAllowed) reasons.push(AVAILABILITY_REASON.LIVE_GATE_CLOSED);

    const liveAvailable = reasons.length === 0;
    const key = instrumentKey(instrument);
    if (liveAvailable) {
      auditLiveBecameTrue(key, venueRaw);
    } else {
      lastLiveAvailable.set(key, false);
    }

    return {
      paperAvailable,
      liveTradable,
      liveAvailable,
      reasons: uniqueReasons(reasons),
    };
  } catch (err) {
    structuredLog("warn", "availability_projection_failed", {
      venue: String(instrument.venue ?? "").slice(0, 40),
      error: err instanceof Error ? err.name : "Error",
    });
    return closed(paperAvailable, liveTradable, [AVAILABILITY_REASON.PROJECTION_EXCEPTION]);
  }
}

function uniqueReasons(reasons: AvailabilityReasonCode[]): AvailabilityReasonCode[] {
  return [...new Set(reasons)];
}

/** Wendet die Projektion auf ein Instrument an — einzige Zuweisung von liveAvailable. */
export function applyAvailabilityProjection<T extends AvailabilityProjectionInput>(
  instrument: T,
  context: ProjectionContext = currentProjectionContext(),
): T & Pick<AvailabilityProjection, "paperAvailable" | "liveTradable" | "liveAvailable"> {
  const projected = projectInstrumentAvailability(instrument, context);
  return {
    ...instrument,
    paperAvailable: projected.paperAvailable,
    liveTradable: projected.liveTradable,
    liveAvailable: projected.liveAvailable,
  };
}

export function formatAvailabilityReason(code: AvailabilityReasonCode, venue: string): string {
  const v = venue.trim().toUpperCase() || "UNKNOWN";
  switch (code) {
    case AVAILABILITY_REASON.NOT_LIVE_TRADABLE:
      return "Live nicht verfuegbar: Instrument ist fachlich nicht fuer Live-Handel vorgesehen";
    case AVAILABILITY_REASON.VENUE_UNKNOWN:
      return `Live nicht verfuegbar: Venue ${v} ist unbekannt`;
    case AVAILABILITY_REASON.CAPABILITY_MISSING:
      return `Live nicht verfuegbar: keine Capability-Deklaration fuer ${v}`;
    case AVAILABILITY_REASON.CAPABILITY_TRADING_FALSE:
      return `Live nicht verfuegbar: Venue ${v} deklariert capabilities.trading=false`;
    case AVAILABILITY_REASON.ADAPTER_STUB:
      return `Live nicht verfuegbar: Adapter fuer ${v} ist ein Stub`;
    case AVAILABILITY_REASON.ADAPTER_MISSING:
      return `Live nicht verfuegbar: kein Adapter fuer ${v} registriert`;
    case AVAILABILITY_REASON.CAPABILITY_LIVE_FALSE:
      return `Live nicht verfuegbar: Venue ${v} deklariert capabilities.live=false`;
    case AVAILABILITY_REASON.FEATURE_FLAG_UNSET:
      return `Live nicht verfuegbar: Feature-Flag ${v}_ENABLED ist nicht gesetzt`;
    case AVAILABILITY_REASON.LIVE_GATE_CLOSED:
      return "Live nicht verfuegbar: Live-Gate ist geschlossen";
    case AVAILABILITY_REASON.PROJECTION_EXCEPTION:
      return "Live nicht verfuegbar: Projektion fail-closed nach Ausnahme";
    default:
      return `Live nicht verfuegbar: ${code}`;
  }
}

/** UI-Badge bei liveAvailable=false: erster Eintrag aus reasons[]. */
export function formatLiveUnavailableBadge(reasons: readonly string[], venue: string): string {
  const first = reasons[0] as AvailabilityReasonCode | undefined;
  if (!first) return "Live nicht verfuegbar";
  return formatAvailabilityReason(first, venue);
}

/**
 * Seed-Schema: `liveAvailable` ist explizit verboten.
 * @throws Error mit SEED_LIVE_AVAILABLE_FORBIDDEN_MESSAGE
 */
export function assertSeedRecordHasNoLiveAvailable(record: unknown): void {
  if (record !== null && typeof record === "object" && !Array.isArray(record) && "liveAvailable" in record) {
    throw new Error(SEED_LIVE_AVAILABLE_FORBIDDEN_MESSAGE);
  }
}

/**
 * Startup-Konsistenz: jedes Venue mit `trading:true` braucht einen nicht-Stub-Adapter.
 * Strict-/Production-Modus wirft, sonst Warnung.
 */
export function assertTradingVenuesHaveRealAdapters(
  options: {
    capabilities?: CapabilityMatrix;
    strict?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): { ok: boolean; problems: string[] } {
  const caps = options.capabilities ?? capabilityMatrix;
  const env = options.env ?? process.env;
  const strict =
    options.strict ?? (env.NODE_ENV === "production" || env.CAPABILITY_STRICT === "true");
  const problems: string[] = [];

  for (const [venue, cap] of Object.entries(caps)) {
    if (!cap || cap.trading !== true) continue;
    const adapter = lookupAdapter(venue);
    if (!adapter) {
      problems.push(`${venue}: capabilities.trading=true, aber kein Adapter registriert`);
    } else if (adapter.isStub) {
      problems.push(`${venue}: capabilities.trading=true, aber Adapter ist ein Stub`);
    }
  }

  if (problems.length === 0) return { ok: true, problems };

  const message = `Capability/Adapter-Inkonsistenz: ${problems.join("; ")}`;
  if (strict) {
    throw new Error(message);
  }
  structuredLog("warn", "capability_adapter_mismatch", { message, count: problems.length });
  return { ok: false, problems };
}

/** Universe-Invariante: liveAvailable=true ⇒ capabilities[venue].trading=true. */
export function assertLiveAvailableImpliesTrading(
  instruments: Iterable<Pick<MarketInstrument, "venue" | "liveAvailable">>,
  capabilities: CapabilityMatrix = capabilityMatrix,
): void {
  for (const instrument of instruments) {
    if (instrument.liveAvailable !== true) continue;
    const cap = capabilities[instrument.venue];
    if (cap?.trading !== true) {
      throw new Error(
        `Invariante verletzt: ${instrument.venue} hat liveAvailable=true, aber capabilities.trading!==true`,
      );
    }
  }
}
