/**
 * Typisierte Venue-Fähigkeiten für Post-Only-/Cancel-/Replace-Ausführung (RMA-P4-02).
 *
 * Jede Venue meldet EXPLIZIT, was sie kann. Ein `false` ist ein ehrliches
 * „nicht vorhanden“ — der Controller failt dann oder nutzt die in der Policy
 * explizit konfigurierte sichere Alternative (`postOnlyFallback: "limit"`).
 * Stilles Fallenlassen eines Post-Only-Flags ist VERBOTEN und wird in den
 * Serializern mit einem eigenen Fehlercode (`POST_ONLY_UNSUPPORTED`) belegt.
 *
 * Capability-Tabelle (Single Source of Truth, Stand 2026-09-22):
 *
 *   PAPER   postOnly=true  (deterministische Simulation im Venue-Port)
 *           cancelSingle=true, cancelReplaceAtomic=true ( Speicher-atomar)
 *   BITUNIX postOnly=true  (Wire-`effect: "POST_ONLY"`, LIMIT+GTC)
 *           cancelSingle=true (POST cancel_orders + Verify via get_order_detail;
 *             die Venue-Antwort allein beweist NICHT den Cancel — erst der
 *             Detail-Status CANCELED; bis dahin UNKNOWN ⇒ Fallback blockiert)
 *           cancelReplaceAtomic=false (kein atomarer Replace-Endpoint; der
 *             Controller cancelt, verifiziert und reicht neu ein)
 *   ALPACA  postOnly=false (Trade-API v2 kennt kein Post-Only-Flag; Stand der
 *             öffentlichen Doku — bei Venue-Nachrüstung hier auf true setzen
 *             und den Serializer erweitern, nie umgekehrt)
 *           cancelSingle=true (DELETE /v2/orders/{id} + Verify via GET)
 *           cancelReplaceAtomic=true (PATCH /v2/orders/{id})
 *   übrige  alles false (Stub-Venues ohne Trading-Pfad)
 */
import type { BrokerVenueId, OrderExecutionCapabilities } from "../contracts/broker";

/**
 * Alias auf den Broker-Vertrag (`OrderExecutionCapabilities`) — die Definition
 * lebt im Contract (Single Source of Truth), diese Tabelle belegt sie je Venue.
 */
export type VenueExecutionCapabilities = OrderExecutionCapabilities;

export const VENUE_EXECUTION_CAPABILITIES: Record<BrokerVenueId, VenueExecutionCapabilities> = {
  PAPER: { postOnly: true, cancelSingle: true, cancelReplaceAtomic: true },
  ALPACA: { postOnly: false, cancelSingle: true, cancelReplaceAtomic: true },
  IBKR: { postOnly: false, cancelSingle: false, cancelReplaceAtomic: false },
  BINANCE: { postOnly: false, cancelSingle: false, cancelReplaceAtomic: false },
  KRAKEN: { postOnly: false, cancelSingle: false, cancelReplaceAtomic: false },
  DYDX: { postOnly: false, cancelSingle: false, cancelReplaceAtomic: false },
  BITUNIX: { postOnly: true, cancelSingle: true, cancelReplaceAtomic: false },
};

export function executionCapabilitiesFor(venue: BrokerVenueId): VenueExecutionCapabilities {
  return VENUE_EXECUTION_CAPABILITIES[venue];
}

export class ExecutionCapabilityError extends Error {
  readonly code: string;
  readonly venue: BrokerVenueId;
  constructor(code: string, venue: BrokerVenueId, detail: string) {
    super(`${code}: ${venue}: ${detail}`);
    this.name = "ExecutionCapabilityError";
    this.code = code;
    this.venue = venue;
  }
}

/** Geworfen, wenn Post-Only verlangt, aber weder nativ noch per Fallback erlaubt ist. */
export function postOnlyUnsupported(venue: BrokerVenueId): ExecutionCapabilityError {
  return new ExecutionCapabilityError(
    "POST_ONLY_UNSUPPORTED",
    venue,
    "Venue meldet postOnly=false und die Policy erlaubt keinen Limit-Fallback (postOnlyFallback=fail)."
  );
}

/** Geworfen, wenn ein Einzel-Cancel verlangt wird, die Venue aber keinen meldet. */
export function cancelUnsupported(venue: BrokerVenueId): ExecutionCapabilityError {
  return new ExecutionCapabilityError(
    "CANCEL_UNSUPPORTED",
    venue,
    "Venue meldet cancelSingle=false — TTL/Cancel-Pfad ist hier nicht ausführbar."
  );
}
