/**
 * Operations-Verdrahtung des TWAP-Schedulers (RMA-P4-03).
 *
 * Feature-Flag: `TWAP_EXECUTION_ENABLED=true` schaltet start/tick/cancel/
 * resume/recover frei. Default false. Lesen bleibt immer möglich. Unbekannte
 * Werte werfen — kein stilles Default-Raten.
 *
 * Buch und Quote kommen aus demselben Loader. Fehlendes Intervallvolumen bleibt
 * `null` (Pause), nie 0 und nie „unbegrenzt“. Paper gilt als geöffnet; ein
 * Live-Venue ohne injizierten Kalender ist unbekannt und pausiert fail-closed.
 */
import type { BrokerVenueId, MarketOrderBook } from "../../contracts/broker";
import { pool } from "../../db";
import { killSwitch } from "../../lib/riskGuard";
import { ExecutionPolicyController, type QuoteSnapshot } from "../controller";
import { PaperVenuePort } from "../ports";
import { createExecutionController } from "../service";
import { InMemoryExecutionStore, PostgresExecutionStore, type ExecutionStore } from "../store";
import { controllerChildExecutor } from "./child";
import type { DepthBook } from "./depth";
import { TwapError } from "./errors";
import { TwapScheduler, type TwapSchedulerDeps } from "./scheduler";
import { InMemoryTwapStore, PostgresTwapStore, type TwapStore } from "./store";

export const TWAP_EXECUTION_FLAG = "TWAP_EXECUTION_ENABLED";

export function twapExecutionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[TWAP_EXECUTION_FLAG];
  if (raw === undefined || raw === "") return false;
  if (raw !== "true" && raw !== "false") {
    throw new TwapError("INVALID_FLAG", `${TWAP_EXECUTION_FLAG} muss "true" oder "false" sein`);
  }
  return raw === "true";
}

export interface TwapServiceDeps {
  store?: TwapStore;
  executionStore?: ExecutionStore;
  controller?: ExecutionPolicyController;
  getBook?: TwapSchedulerDeps["getBook"];
  now?: () => number;
  leaseMs?: number;
  isKilled?: () => boolean;
  isMarketOpen?: () => boolean | null;
  isVenueConnected?: () => boolean | null;
  env?: Record<string, string | undefined>;
}

export function bookFromMarket(book: MarketOrderBook, observedAt: number): DepthBook {
  return {
    bids: book.bids.map((l) => ({ price: l.price, qty: l.qty })),
    asks: book.asks.map((l) => ({ price: l.price, qty: l.qty })),
    eventTime: book.ts,
    availableAt: observedAt,
    observedVolume: null,
    volumeEventTime: null,
    volumeAvailableAt: null,
  };
}

export function quoteFromBook(book: DepthBook): QuoteSnapshot | null {
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  const spread = mid > 0 ? (ask - bid) / mid : null;
  if (spread === null || !Number.isFinite(spread) || spread < 0) return null;
  return { mid, bid, ask, spread, eventTime: book.eventTime, availableAt: book.availableAt };
}

/**
 * PAPER ist der Simulator (offen, verbunden). Live ohne injizierten Kalender
 * oder Verbindungsnachweis ist unbekannt und pausiert — nicht „vermutlich offen“.
 */
export function marketPredicates(venue: BrokerVenueId): {
  isMarketOpen: () => boolean | null;
  isVenueConnected: () => boolean | null;
} {
  if (venue === "PAPER") return { isMarketOpen: () => true, isVenueConnected: () => true };
  return { isMarketOpen: () => null, isVenueConnected: () => null };
}

export function createTwapScheduler(deps: TwapServiceDeps = {}): TwapScheduler {
  const executionStore = deps.executionStore ?? new PostgresExecutionStore(pool);
  const paperPort = new PaperVenuePort({ venue: "PAPER", now: deps.now });
  const controller =
    deps.controller ??
    createExecutionController({
      store: executionStore,
      paperPort,
      env: deps.env,
      now: deps.now,
    });
  return new TwapScheduler({
    store: deps.store ?? new PostgresTwapStore(pool),
    executor: controllerChildExecutor(controller, (id) => executionStore.listFills(id)),
    getBook: deps.getBook ?? (async () => null),
    now: deps.now,
    leaseMs: deps.leaseMs,
    isKilled: deps.isKilled ?? (() => killSwitch.isArmed()),
    isMarketOpen: deps.isMarketOpen ?? (() => true),
    isVenueConnected: deps.isVenueConnected ?? (() => true),
  });
}

export function createMemoryTwapScheduler(
  deps: Omit<TwapServiceDeps, "store" | "executionStore"> & {
    getQuote?: (venue: BrokerVenueId, symbol: string) => Promise<QuoteSnapshot | null>;
  } = {},
): TwapScheduler {
  const executionStore = new InMemoryExecutionStore();
  const controller = createExecutionController({
    store: executionStore,
    paperPort: new PaperVenuePort({ venue: "PAPER", now: deps.now }),
    getQuote: deps.getQuote,
    env: deps.env,
    now: deps.now,
  });
  return createTwapScheduler({
    ...deps,
    store: new InMemoryTwapStore(),
    executionStore,
    controller,
  });
}
