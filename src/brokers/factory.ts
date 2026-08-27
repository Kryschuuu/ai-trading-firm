/**
 * Broker-Factory (Task 02) — der EINZIGE Erzeugungspunkt für Broker-Adapter.
 *
 * Fail-Safe-Reihenfolge (laut, auditiert, NIEMALS stiller Fallback):
 *   1. Unbekanntes Venue          → UnknownVenueError
 *   2. mode = 'live'              → LiveTradingGateError (IMMER, bis der
 *                                    Live-Trading-Gate-Task öffnet)
 *   3. Fehlende Capability        → NotSupportedCapabilityError
 *                                    (Gating-Table: REQUIRED_CAPABILITY_BY_MODE)
 *   4. OK                         → Adapter (cache je venue:mode)
 *
 * Audit (Regel 5): Jeder Aufruf mit `mode != 'paper'` (plus alle
 * UNKNOWN_VENUE-Ablehnungen) landet im Audit-Log (ring + best-effort DB).
 *
 * Caching: Der PAPER-Ledger ist ein Prozess-Singleton — backtest- und
 * paper-Instanzen teilen denselben, von der Engine hydratierten Ledger.
 * Stub-Adapter sind stateless und werden je (venue,mode) gecacht.
 */
import {
  LiveTradingGateError,
  NotSupportedCapabilityError,
  UnknownVenueError,
  type BrokerAdapter,
  type BrokerVenueId,
  type ExecutionMode,
} from "../contracts/broker";
import { PaperBroker } from "../lib/broker";
import { recordBrokerFactoryCall } from "./audit";
import { REQUIRED_CAPABILITY_BY_MODE, VENUE_CAPABILITIES } from "./capabilities";
import { PaperBrokerAdapter } from "./paper";
import { StubBrokerAdapter } from "./stubs";

const G = globalThis as typeof globalThis & {
  __brokerAdapters?: Map<string, BrokerAdapter>;
  __paperBrokerLedger?: PaperBroker;
};

function adapterCache(): Map<string, BrokerAdapter> {
  return (G.__brokerAdapters ??= new Map());
}

/**
 * Der PAPER-Ledger als Prozess-Singleton. Die Factory ist der einzige Ort,
 * an dem `new PaperBroker(…)` steht (Engine/Agenten erzeugen nichts mehr
 * selbst — Bytekompatibilität über den identischen Objekttyp).
 */
export function paperBrokerLedger(): PaperBroker {
  G.__paperBrokerLedger ??= new PaperBroker(
    Number(process.env.STARTING_EQUITY || 10000)
  );
  return G.__paperBrokerLedger;
}

/** Fügt eine Venue-Roh-Eingabe auf die Adapter-Venues der Whitelist. */
export function normalizeVenue(raw: unknown): BrokerVenueId | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (Object.keys(VENUE_CAPABILITIES) as string[]).includes(v)
    ? (v as BrokerVenueId)
    : null;
}

/**
 * Erzeugt einen frischen Adapter für ein (validiertes) Venue.
 * Der PAPER-Adapter teilt den Singleton-Ledger; Stubs sind stateless.
 */
export function createAdapter(
  venue: BrokerVenueId,
  mode: ExecutionMode
): BrokerAdapter {
  if (venue === "PAPER") {
    return new PaperBrokerAdapter(paperBrokerLedger(), mode);
  }
  return new StubBrokerAdapter(venue, mode);
}

/**
 * THE BROKER FACTORY.
 *
 * @example
 *   const adapter = await getBroker("PAPER", "paper");   // → PaperBrokerAdapter
 *   await getBroker("ALPACA", "testnet");                // → NotSupportedCapabilityError
 *   await getBroker("PAPER", "live");                    // → LiveTradingGateError (IMMER)
 */
export async function getBroker(
  venueRaw: string,
  mode: ExecutionMode = "paper"
): Promise<BrokerAdapter> {
  // 1) Input-Validierung: nur Whitelist-Venues, nie freier String.
  const venue = normalizeVenue(venueRaw);
  if (!venue) {
    const safe =
      typeof venueRaw === "string" && venueRaw.length > 0
        ? venueRaw.slice(0, 40)
        : String(venueRaw ?? "").slice(0, 40);
    const err = new UnknownVenueError(safe);
    // Auch im paper-Modus: unbekannte Venues sind ein Audit-Ereignis,
    // damit das Audit-Log vollständig bleibt.
    await recordBrokerFactoryCall({
      venue: safe,
      mode,
      outcome: "DENIED",
      capability: null,
      errorCode: err.code,
    });
    throw err;
  }

  // 2) LIVE-SPERRUNG: vor jeder Capability-Prüfung, für JEDES Venue,
  //    standardmäßig und permanent, bis der Live-Gate-Task öffnet.
  if (mode === "live") {
    const err = new LiveTradingGateError(venue);
    await recordBrokerFactoryCall({
      venue,
      mode,
      outcome: "DENIED",
      capability: null,
      errorCode: err.code,
    });
    throw err;
  }

  // 3) Capability-Gating: der Modus verlangt eine Capability, die der
  //    Adapter deklariert haben muss (Single Source of Truth).
  const capability = REQUIRED_CAPABILITY_BY_MODE[mode];
  const caps = VENUE_CAPABILITIES[venue];
  if (!caps[capability]) {
    const err = new NotSupportedCapabilityError(
      venue,
      capability,
      `getBroker("${mode}")`
    );
    await recordBrokerFactoryCall({
      venue,
      mode,
      outcome: "DENIED",
      capability,
      errorCode: err.code,
    });
    throw err;
  }

  // 4) OK: Adapter liefern (cache je venue:mode; PAPER teilt den Ledger).
  const key = `${venue}:${mode}`;
  let adapter = adapterCache().get(key);
  if (!adapter) {
    adapter = createAdapter(venue, mode);
    adapterCache().set(key, adapter);
  }

  if (mode !== "paper") {
    await recordBrokerFactoryCall({
      venue,
      mode,
      outcome: "OK",
      capability: null,
      errorCode: null,
    });
  }
  return adapter;
}
