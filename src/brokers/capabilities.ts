/**
 * Capability-Table der Broker-Adapters (Task 02).
 *
 * REINES DATENMODUL — kein IO, kein Netzwerk, keine Adapter-Instanzen.
 * Damit können `src/lib/broker.ts` (Registry-Projektion), die Factory, die
 * Stubs und die PAPER-Adapter dieselbe Wahrheit lesen, ohne Import-Zyklen.
 *
 * SINGLE SOURCE OF TRUTH: Die Capability-Flags der Adapter stammen aus
 * dieser Table. Die Registry (`BROKER_REGISTRY`) ist nur eine Projektion
 * davon (`paperAvailable`/`liveAvailable`) — Tests in
 * `tests/brokerFactory.test.ts` belegen die Spiegelung.
 *
 * SEMANTIK: Die Flags beschreiben, was der ADAPTER-CODE dieses Repos
 * aktuell ausführt — nicht, was der Broker-Anbieter bewirbt. Die
 * Venue-Angebote (z. B. „Binance: Testnet vorhanden“) bleiben als
 * Doku-Felder (label/note) in `BROKER_REGISTRY`.
 *
 * instrumentTypes: Venue-typische Markttypen (Doku der Abdeckbarkeit);
 * sie dienen dem Universum-/Ranking-Task, kein Ausführungsversprechen.
 */
import type {
  BrokerCapabilities,
  BrokerVenueId,
  ExecutionMode,
} from "../contracts/broker";

export const VENUE_CAPABILITIES: Record<BrokerVenueId, BrokerCapabilities> = {
  /** Interne Simulation — der einzige vollständig ausführbare Broker. */
  PAPER: {
    discovery: true,
    marketData: true,
    trading: true,
    paper: true,
    testnet: false,
    live: false,
    instrumentTypes: { spot: true, perpetual: false, future: false, option: false },
    // SL/TP verwaltet der interne Monitor, nicht das "Venue".
    stopAtVenue: false,
  },
  /** Stubs (Task 02): Adapter noch nicht implementiert → alles false. */
  ALPACA: {
    discovery: false,
    marketData: false,
    trading: false,
    paper: false,
    testnet: false,
    live: false,
    // Venue-Angebot (Doku): US-Aktien, ETFs, Krypto — Spot.
    instrumentTypes: { spot: true, perpetual: false, future: false, option: false },
    stopAtVenue: false,
  },
  IBKR: {
    discovery: false,
    marketData: false,
    trading: false,
    paper: false,
    testnet: false,
    live: false,
    // Venue-Angebot (Doku): global — Aktien, Optionen, Futures, FX.
    instrumentTypes: { spot: true, perpetual: false, future: true, option: true },
    stopAtVenue: false,
  },
  BINANCE: {
    discovery: false,
    marketData: false,
    trading: false,
    paper: false,
    testnet: false,
    live: false,
    // Venue-Angebot (Doku): Krypto Spot & Futures (Testnet vorhanden).
    instrumentTypes: { spot: true, perpetual: true, future: true, option: false },
    stopAtVenue: false,
  },
  KRAKEN: {
    discovery: false,
    marketData: false,
    trading: false,
    paper: false,
    testnet: false,
    live: false,
    // Venue-Angebot (Doku): Krypto Spot & Futures (Futures-Demo-Umgebung).
    instrumentTypes: { spot: true, perpetual: true, future: true, option: false },
    stopAtVenue: false,
  },
  DYDX: {
    discovery: false,
    marketData: false,
    trading: false,
    paper: false,
    testnet: false,
    live: false,
    // Venue-Angebot (Doku): dezentrale Perpetuals (self-custody).
    instrumentTypes: { spot: false, perpetual: true, future: false, option: false },
    stopAtVenue: false,
  },
  /**
   * Bitunix Futures (Task 07).
   * live=true beschreibt die technische Fähigkeit des Adapters (Order-
   * Serialisierung, Signing) — NICHT die Freigabe. Factory + placeOrder
   * werfen bis task-11 immer LiveTradingGateError.
   * testnet=false: die offizielle Futures-Doku weist kein Testnet aus.
   * paper=true: lokale Simulation gegen echte Bitunix-Kurse (Modus B).
   */
  BITUNIX: {
    discovery: true,
    marketData: true,
    trading: true,
    paper: true,
    testnet: false,
    live: true,
    instrumentTypes: { spot: false, perpetual: true, future: false, option: false },
    stopAtVenue: true,
  },
};

/**
 * Gating-Table der Factory: Execution-Modus → erforderliche Capability.
 *
 *   backtest → paper   (simulierte Order braucht die Simulation)
 *   paper    → paper   (simulierte Order mit realzeit-Kurs)
 *   testnet  → testnet (Broker-Order im Testnet)
 *   live     → live    (theoretisch; praktisch wird `live` VOR dem
 *                       Capability-Check durch LiveTradingGateError hart
 *                       gesperrt — die Zeile dokumentiert die Semantik)
 */
export const REQUIRED_CAPABILITY_BY_MODE: Record<
  ExecutionMode,
  keyof BrokerCapabilities
> = {
  backtest: "paper",
  paper: "paper",
  testnet: "testnet",
  live: "live",
};

/**
 * Für die API/Doku: welche Modi ein Venue prinzipiell anbieten KANN
 * (Capability-Basis). `live` ist hier immer false — die Sperrung ist
 * plattformseitig, nicht capability-seitig.
 */
export function availableExecutionModes(
  venue: BrokerVenueId
): Record<ExecutionMode, { available: boolean; reason?: string }> {
  const caps = VENUE_CAPABILITIES[venue];
  return {
    backtest: { available: caps.paper },
    paper: { available: caps.paper },
    testnet: { available: caps.testnet },
    live: {
      available: false,
      reason:
        "LIVE_TRADING_GATE: hart gesperrt, bis der Live-Trading-Gate-Task öffnet",
    },
  };
}
