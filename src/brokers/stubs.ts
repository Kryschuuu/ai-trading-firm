/**
 * Venue-Stubs (Task 02): ALPACA, IBKR, BINANCE, KRAKEN, DYDX.
 *
 * SICHERE STUBS — sie liefern einen gültigen `BrokerAdapter`, der
 *   - seine Capabilities ehrlich deklariert (alles Exec-fähige false,
 *     InstrumentTypes = Venue-Angebot als Doku),
   - JEDEN capability-geprüften Aufruf sicher und informativ verweigert
 *     (`NotSupportedCapabilityError` mit Venue, Capability, Methode),
   - Trading-Aufrufe im (unerreichen) live-Kontext zusätzlich mit
 *     `LiveTradingGateError` verweigert (Defense in Depth — die Factory
 *     erzeugt live-Instanzen ohnehin nie),
   - KEIN Netzwerkverkehr, KEIN Credentials-Zugriff, KEINE Broker-SDKs.
 *
 * Die Stubs sind damit die auditierte, fail-safe Brücke zum späteren
 * Adapter-Ausbau (Task 03+): Die Factory-, Gating- und Audit-Pfade sind
 * voll funktionsfähig und getestet, nur die Venue-Implementierung fehlt.
 */
import { VENUE_CAPABILITIES } from "./capabilities";
import {
  REMOTE_HEALTH_CHECKERS,
  REMOTE_HEALTHCHECK_FLAG,
  remoteHealthCheckEnabled,
  runRemoteHealthCheck,
} from "./health";
import {
  LiveTradingGateError,
  NotSupportedCapabilityError,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerHealth,
  type BrokerOrderRequest,
  type BrokerOrderResult,
  type BrokerPosition,
  type BrokerVenueId,
  type ExecutionMode,
  type MarketCandle,
  type MarketInstrument,
  type MarketTicker,
} from "../contracts/broker";
import type { BrokerAccount } from "../contracts/broker";

export type StubVenueId = Exclude<BrokerVenueId, "PAPER" | "BITUNIX">;

/** Klare Markierung für noch offene Adapter-Entwicklung (Task-Planung). */
const DISCOVERY_TODO_HINT =
  "TODO(task-02/07): Discovery liefert MarketInstrument[] (Contract: " +
  "src/contracts/broker.ts, s. Task 01) — Implementation folgt im " +
  "Adapter-Ausbau";

export class StubBrokerAdapter implements BrokerAdapter {
  readonly id: StubVenueId;
  readonly mode: ExecutionMode;
  readonly capabilities: BrokerCapabilities;

  constructor(venue: StubVenueId, mode: ExecutionMode = "paper") {
    this.id = venue;
    this.mode = mode;
    this.capabilities = VENUE_CAPABILITIES[venue];
  }

  /**
   * Capability-Gate aller Adapter-Methoden (Defense in Depth):
   *   - live-Kontext + trading → LiveTradingGateError (immer),
   *   - capability=false       → NotSupportedCapabilityError (immer).
   * Ein Stub erfüllt KEINE Capability — wirft daher bei jedem Aufruf.
   */
  private requireCapability(
    capability: keyof BrokerCapabilities,
    method: string,
    hint?: string
  ): void {
    if (this.mode === "live" && capability === "trading") {
      throw new LiveTradingGateError(this.id);
    }
    if (!this.capabilities[capability]) {
      throw new NotSupportedCapabilityError(this.id, capability, method, hint);
    }
  }

  /**
   * Local Health-Check (Default): Der Stub ist bewusst `offline` — er ist
   * nicht implementiert und meldet das ehrlich statt `online` zu behaupten.
   * Mit `remote=true` (Flag `BROKER_HEALTHCHECK_REMOTE`, Default OFF) wird
   * der read-only Public-Endpunkt geprüft, sofern vorhanden (BINANCE, KRAKEN).
   */
  async healthCheck(opts?: { remote?: boolean }): Promise<BrokerHealth> {
    const remoteWanted = opts?.remote === true;
    const flagOn = remoteHealthCheckEnabled();
    const base: BrokerHealth = {
      status: "offline",
      latencyMs: 0,
      details: {
        implemented: false,
        hint: "Adapter in diesem Stadium nicht implementiert (Folge-Task)",
      },
    };

    if (!remoteWanted || !flagOn) {
      base.details.remoteCheck = `deaktiviert (${REMOTE_HEALTHCHECK_FLAG}=false ist Default)`;
      return base;
    }

    // Remote-Check aktiviert (read-only, credential-frei, mit Timeout).
    if (!REMOTE_HEALTH_CHECKERS[this.id]) {
      // ALPACA (Credentials nötig), IBKR (Gateway nötig), DYDX (kein
      // verifizierter read-only Endpunkt) → ehrlich `degraded`.
      base.status = "degraded";
      base.details.remoteCheck = "keine Read-only-Check-Möglichkeit ohne Credentials/Gateway";
      base.details.reason = this.remoteReason();
      return base;
    }

    const result = await runRemoteHealthCheck(this.id);
    if (!result) {
      base.details.remoteCheck = "fehlgeschlagen";
      return base;
    }
    base.status = result.status;
    base.details.remoteCheck = "read-only public endpoint";
    Object.assign(base.details, result.details);
    base.latencyMs = typeof result.details.latencyMs === "number"
      ? result.details.latencyMs
      : 0;
    return base;
  }

  private remoteReason(): string {
    switch (this.id) {
      case "ALPACA":
        return "CREDENTIALS_REQUIRED";
      case "IBKR":
        return "GATEWAY_REQUIRED";
      default:
        return "REMOTE_CHECK_NOT_IMPLEMENTED";
    }
  }

  /**
   * TODO(task-02/07): Instrument-Discovery je Venue. Liefert später
   * `MarketInstrument[]` (Contract: src/contracts/broker.ts, Task 01).
   * Bis dahin: sichere, klar markierte Verweigerung.
   */
  async discoverInstruments(): Promise<MarketInstrument[]> {
    this.requireCapability("discovery", "discoverInstruments", DISCOVERY_TODO_HINT);
    // Unerreicht: capability ist beim Stub immer false.
    throw new NotSupportedCapabilityError(this.id, "discovery", "discoverInstruments", DISCOVERY_TODO_HINT);
  }

  async getTicker(_symbol: string): Promise<MarketTicker> {
    this.requireCapability(
      "marketData",
      "getTicker",
      "TODO(task-02/07): Marktdaten via Venue-API"
    );
    throw new NotSupportedCapabilityError(this.id, "marketData", "getTicker");
  }

  async getCandles(_symbol: string, _timeframe: string): Promise<MarketCandle[]> {
    this.requireCapability(
      "marketData",
      "getCandles",
      "TODO(task-02/07): Marktdaten via Venue-API"
    );
    throw new NotSupportedCapabilityError(this.id, "marketData", "getCandles");
  }

  async getAccount(): Promise<BrokerAccount> {
    this.requireCapability("trading", "getAccount", "Adapter nicht implementiert (Folge-Task)");
    throw new NotSupportedCapabilityError(this.id, "trading", "getAccount");
  }

  /**
   * Trading-Verweigerung (sicher + informativ):
   *   - mode 'live' (unerrreichbar via Factory) → LiveTradingGateError,
   *   - sonst → NotSupportedCapabilityError (Capability trading=false).
   * KEIN stiller Fallback auf Paper, KEINE echte Order, KEIN Netzwerk.
   */
  async placeOrder(_req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this.requireCapability(
      "trading",
      "placeOrder",
      "Adapter nicht implementiert (Folge-Task); Live-Pfad zusätzlich hart gesperrt (LiveTradingGateError)"
    );
    throw new NotSupportedCapabilityError(this.id, "trading", "placeOrder");
  }

  async getPositions(): Promise<BrokerPosition[]> {
    this.requireCapability("trading", "getPositions", "Adapter nicht implementiert (Folge-Task)");
    throw new NotSupportedCapabilityError(this.id, "trading", "getPositions");
  }
}
