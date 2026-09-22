/**
 * Operations-Verdrahtung des Execution-Policy-Controllers (RMA-P4-02).
 *
 * `createExecutionController` baut einen produktionsfähigen Controller:
 *   - Store: Postgres (`PostgresExecutionStore`) oder injizierter Store.
 *   - PAPER: `PaperVenuePort` (deterministische Simulation) + Quotes aus
 *     `marketData.getQuote` + Spread aus der Universe-Registry (0 per
 *     Single-Price-Prämisse, wenn die Registry keinen Spread kennt) +
 *     Konto aus dem Paper-Ledger der Engine.
 *   - Live-Venues (BITUNIX/ALPACA): Ports, Quotes und Konten werden pro
 *     Request aus den Broker-Adaptern gebaut (`buildLiveVenueDeps`) — inkl.
 *     echtem Orderbuch-Top (Mid/Spread) und zentralem Live-Gate-Enforcer.
 *
 * Feature-Flag: `EXECUTION_POLICY_ENABLED=true` schaltet die schreibenden
 * Pfade (start/poll/recover) frei; Default false. Lesen (Status) ist immer
 * möglich. Unbekannte Flag-Werte werfen (kein stilles Default-Raten).
 */
import type { BrokerVenueId, ExecutionMode } from "../contracts/broker";
import { pool } from "../db";
import { getQuote } from "../lib/marketData";
import { evaluateLiveOrder } from "../live-gate/enforcer";
import { getRegistry } from "../universe";
import { AlpacaBrokerAdapter } from "../brokers/alpaca/adapter";
import { BitunixBrokerAdapter } from "../brokers/bitunix/adapter";
import { ExecutionControllerError, ExecutionPolicyController, type AccountSnapshot, type InstrumentSpec, type QuoteSnapshot } from "./controller";
import { AlpacaVenuePort, BitunixVenuePort } from "./livePorts";
import { PaperVenuePort, type VenueExecutionPort } from "./ports";
import { InMemoryExecutionStore, PostgresExecutionStore, type ExecutionStore } from "./store";

export const EXECUTION_POLICY_FLAG = "EXECUTION_POLICY_ENABLED";

export function executionPolicyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[EXECUTION_POLICY_FLAG];
  if (raw === undefined || raw === "") return false;
  if (raw !== "true" && raw !== "false") {
    throw new ExecutionControllerError("INVALID_FLAG", `${EXECUTION_POLICY_FLAG} muss "true" oder "false" sein (got ${raw.slice(0, 20)})`);
  }
  return raw === "true";
}

export interface ExecutionServiceDeps {
  store?: ExecutionStore;
  paperPort?: PaperVenuePort;
  extraPorts?: Map<BrokerVenueId, VenueExecutionPort>;
  getQuote?: (venue: BrokerVenueId, symbol: string) => Promise<QuoteSnapshot | null>;
  getAccount?: (venue: BrokerVenueId, mode: ExecutionMode) => Promise<AccountSnapshot | null>;
  getInstrument?: (venue: BrokerVenueId, symbol: string) => InstrumentSpec | null;
  liveGateAllowed?: (venue: BrokerVenueId) => { allowed: boolean; code: string };
  env?: Record<string, string | undefined>;
  now?: () => number;
}

function registryInstrument(venue: BrokerVenueId, symbol: string): InstrumentSpec | null {
  try {
    const found = getRegistry().find(venue, symbol);
    if (!found) return null;
    if (!Number.isFinite(found.quantityStep) || found.quantityStep <= 0) return null;
    if (!Number.isFinite(found.priceStep) || found.priceStep <= 0) return null;
    if (!Number.isFinite(found.minQuantity) || found.minQuantity <= 0) return null;
    return { quantityStep: found.quantityStep, priceStep: found.priceStep, minQuantity: found.minQuantity };
  } catch {
    return null;
  }
}

/**
 * PAPER-Standardquote (exportiert für die API-Routen-Komposition): Kurs aus
 * `marketData`, Spread aus der Registry (0 per Single-Price-Prämisse).
 */
export async function defaultPaperQuote(
  paperPort: PaperVenuePort,
  symbol: string
): Promise<QuoteSnapshot | null> {
  return paperQuote(paperPort, symbol);
}

/**
 * PAPER-Standardkonto (exportiert für die API-Routen-Komposition): Engine-Ledger.
 */
export async function defaultPaperAccount(): Promise<AccountSnapshot | null> {
  return paperAccount();
}

async function paperQuote(
  paperPort: PaperVenuePort,
  symbol: string
): Promise<QuoteSnapshot | null> {
  const sym = symbol.toUpperCase();
  let quote;
  try {
    quote = await getQuote(sym);
  } catch {
    return null;
  }
  if (!Number.isFinite(quote.price) || quote.price <= 0) return null;
  // Spread aus der Registry (echte Orderbuch-Messung, wenn vorhanden); sonst
  // Single-Price-Prämisse der Simulation (Spread 0, dokumentiert in
  // docs/POST_ONLY_FALLBACK.md). Quote-Zeit = Ereignis- UND Verfügbarkeitszeit
  // (Staleness misst gegen die Beobachtungszeit, nicht gegen „jetzt“).
  let spread: number | null = null;
  try {
    const inst = getRegistry().find("PAPER", sym);
    spread = inst?.spread ?? 0;
  } catch {
    spread = 0;
  }
  if (spread === null || !Number.isFinite(spread) || spread < 0) return null;
  const mid = quote.price;
  const bid = mid * (1 - spread / 2);
  const ask = mid * (1 + spread / 2);
  paperPort.setQuote(sym, { bid, ask, mid, ts: quote.ts });
  return { mid, bid, ask, spread, eventTime: quote.ts, availableAt: quote.ts };
}

async function paperAccount(): Promise<AccountSnapshot | null> {
  try {
    const { getBroker } = await import("../lib/engine");
    const broker = await getBroker();
    const equity = broker.accountEquity;
    const openPositions = broker.openPositions;
    if (!Number.isFinite(equity) || equity <= 0) return null;
    if (!Number.isFinite(openPositions) || openPositions < 0) return null;
    return { equity, openPositions };
  } catch {
    return null;
  }
}

export function createExecutionController(deps: ExecutionServiceDeps = {}): ExecutionPolicyController {
  const env = deps.env ?? process.env;
  const paperPort = deps.paperPort ?? new PaperVenuePort({ venue: "PAPER" });
  const ports = new Map<BrokerVenueId, VenueExecutionPort>([["PAPER", paperPort]]);
  if (deps.extraPorts) {
    for (const [venue, port] of deps.extraPorts) ports.set(venue, port);
  }
  const getQuoteFn =
    deps.getQuote ??
    (async (venue: BrokerVenueId, symbol: string) => {
      if (venue === "PAPER") return paperQuote(paperPort, symbol);
      return null;
    });
  const getAccountFn =
    deps.getAccount ??
    (async (venue: BrokerVenueId, mode: ExecutionMode) => {
      if (venue === "PAPER" && (mode === "paper" || mode === "backtest")) return paperAccount();
      return null;
    });
  return new ExecutionPolicyController({
    store: deps.store ?? new PostgresExecutionStore(pool),
    ports,
    getQuote: getQuoteFn,
    getAccount: getAccountFn,
    getInstrument: deps.getInstrument ?? registryInstrument,
    liveGateAllowed:
      deps.liveGateAllowed ??
      ((venue: BrokerVenueId) => {
        const decision = evaluateLiveOrder(venue, { env, audit: false });
        return { allowed: decision.allowed, code: decision.code };
      }),
    now: deps.now,
  });
}

/** Prozessweiter PAPER-Controller für Jobs (Store: Postgres, außer Tests). */
let sharedPaperController: ExecutionPolicyController | null = null;

export function getExecutionController(): ExecutionPolicyController {
  sharedPaperController ??= createExecutionController();
  return sharedPaperController;
}

export function resetExecutionControllerForTests(): void {
  sharedPaperController = null;
}

export function createMemoryExecutionController(
  deps: Omit<ExecutionServiceDeps, "store"> = {}
): ExecutionPolicyController {
  return createExecutionController({ ...deps, store: new InMemoryExecutionStore() });
}

export interface LiveVenueDeps {
  port: VenueExecutionPort;
  getQuote: (symbol: string) => Promise<QuoteSnapshot | null>;
  getAccount: () => Promise<AccountSnapshot | null>;
}

/**
 * Baut Live-Venue-Abhängigkeiten aus den Broker-Adaptern (Orderbuch-Top als
 * Quote, Venue-Konto, signierter Port). Wirft laut bei fehlenden Credentials
 * oder deaktiviertem Adapter — der Aufrufer (API) mappt auf 503/400.
 */
export async function buildLiveVenueDeps(
  venue: "BITUNIX" | "ALPACA",
  mode: ExecutionMode
): Promise<LiveVenueDeps> {
  if (venue === "BITUNIX") {
    const adapter = new BitunixBrokerAdapter(mode);
    const client = await adapter.privateClient();
    return {
      port: new BitunixVenuePort(client),
      getQuote: async (symbol: string) => {
        const book = await adapter.getOrderBook(symbol);
        const bid = book.bids[0]?.price;
        const ask = book.asks[0]?.price;
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
        const mid = (bid + ask) / 2;
        const spread = mid > 0 ? (ask - bid) / mid : null;
        if (spread === null || !Number.isFinite(spread) || spread < 0) return null;
        return { mid, bid, ask, spread, eventTime: book.ts, availableAt: Date.now() };
      },
      getAccount: async () => {
        const acc = await adapter.getAccount();
        if (!Number.isFinite(acc.equity) || acc.equity <= 0) return null;
        return { equity: acc.equity, openPositions: acc.openPositions };
      },
    };
  }
  const adapter = new AlpacaBrokerAdapter(mode);
  const client = await adapter.privateClient();
  return {
    port: new AlpacaVenuePort(client),
    getQuote: async (symbol: string) => {
      const quote = await adapter.getExecutionQuote(symbol);
      const bid = quote.bids[0]?.price;
      const ask = quote.asks[0]?.price;
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
      const mid = (bid + ask) / 2;
      const spread = mid > 0 ? (ask - bid) / mid : null;
      if (spread === null || !Number.isFinite(spread) || spread < 0) return null;
      return { mid, bid, ask, spread, eventTime: quote.ts, availableAt: Date.now() };
    },
    getAccount: async () => {
      const acc = await adapter.getAccount();
      if (!Number.isFinite(acc.equity) || acc.equity <= 0) return null;
      return { equity: acc.equity, openPositions: acc.openPositions };
    },
  };
}
