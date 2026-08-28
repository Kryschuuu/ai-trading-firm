/**
 * Übergangs-Checks der Live-Gate-State-Machine (Task 11).
 *
 * Interface `TransitionCheck`: jede Ebene hat eine objektive, automatisch
 * verifizierbare Bedingung. Die Checks laufen gegen ein venue-agnostisches
 * `BrokerGatePort` (Unabhängigkeitsklausel: der Enforcer/Service kennt keine
 * Broker-Details; Ports werden registriert oder per Default read-only geladen).
 *
 * Fail-closed-Regeln:
 *   - Ein Port-Fehler ist ein NICHT bestandener Check (kein "unbekannt = ok").
 *   - ORDER_TEST_OK: Es existiert KEIN echter Test-Order-Pfad — der Default-
 *     Port meldet fehlgeschlagen, bis ein dokumentierter Test-Order-Provider
 *     (Venue-Testnet oder expliziter Mock für CI) registriert ist. In CI/Tests
 *     werden NIEMALS echte Orders gesetzt (Mock-Ports only).
 *   - PAPER_APPROVED: erfordert eine Paper-Statistikquelle; ohne registrierte
 *     Quelle gilt 0 Orders -> Check schlägt fehl.
 */
import type { BrokerVenueId } from "@/contracts/broker";
import type { LiveGateConfig, LiveGateEnv } from "./config";
import type { LiveGateCheckId } from "./states";

// ── Port-Contract (venue-agnostisch) ─────────────────────────────────────────

export interface PortProbeResult {
  ok: boolean;
  detail: string;
}

export interface PortPaperStats {
  /** Fehlerfreie Paper-Orders (Basis für PAPER_APPROVED). */
  errorFreeOrders: number;
  /** Gesamtzahl Paper-Orders (Report). */
  orders: number;
  detail: string;
}

/**
 * BrokerGatePort — der EINZIGE Weg, wie die Machine Venue-Fähigkeiten prüft.
 * Alle Methoden read-only bzw. simuliert; `placeTestOrder` DARF niemals eine
 * echte Order am Venue auslösen (Default-Implementierung verweigert deshalb).
 */
export interface BrokerGatePort {
  /** Verbindungstest des Venue-Adapters (lokal, kein Order-Pfad). */
  healthCheck(): Promise<PortProbeResult>;
  /** Read-Only-Market-Data-Check (ein Public-Ticker). */
  fetchTicker(symbol?: string): Promise<PortProbeResult>;
  /** Read-Only-Account-Read (keine Mutation, keine Order). */
  readAccount(): Promise<PortProbeResult>;
  /** Testnet-/Test-Order-Prüfung — NUR simuliert/Mock/Testnet, nie live. */
  placeTestOrder(): Promise<PortProbeResult>;
  /** Paper-Ergebnisquelle für PAPER_APPROVED. */
  paperStats(): Promise<PortPaperStats>;
}

export interface TransitionCheckContext {
  venue: BrokerVenueId;
  env: LiveGateEnv;
  config: LiveGateConfig;
  port: BrokerGatePort;
}

export interface TransitionCheckOutcome {
  ok: boolean;
  detail: string;
}

export interface TransitionCheck {
  id: LiveGateCheckId;
  label: string;
  requirement: string;
  run(ctx: TransitionCheckContext): Promise<TransitionCheckOutcome>;
}

function fail(id: string, detail: string): TransitionCheckOutcome {
  return { ok: false, detail: `[${id}] ${detail}` };
}

function pass(id: string, detail: string): TransitionCheckOutcome {
  return { ok: true, detail: `[${id}] ${detail}` };
}

async function safeRun(
  id: LiveGateCheckId,
  fn: () => Promise<TransitionCheckOutcome>
): Promise<TransitionCheckOutcome> {
  try {
    return await fn();
  } catch (err) {
    return fail(id, `Check-Fehler (fail-closed): ${(err as Error).message}`);
  }
}

export const TRANSITION_CHECKS: Record<LiveGateCheckId, TransitionCheck> = {
  connectivity: {
    id: "connectivity",
    label: "Verbindungstest",
    requirement: "Adapter-Health des Ziel-Venues bestanden (lokal, read-only).",
    async run(ctx) {
      return safeRun("connectivity", async () => {
        const r = await ctx.port.healthCheck();
        return r.ok
          ? pass("connectivity", r.detail)
          : fail("connectivity", r.detail);
      });
    },
  },
  marketData: {
    id: "marketData",
    label: "Read-Only-Market-Data",
    requirement: "Ein Public-Ticker des Venues erfolgreich gelesen (kein Order-Pfad).",
    async run(ctx) {
      return safeRun("marketData", async () => {
        const r = await ctx.port.fetchTicker("BTCUSDT");
        return r.ok ? pass("marketData", r.detail) : fail("marketData", r.detail);
      });
    },
  },
  accountRead: {
    id: "accountRead",
    label: "Read-Only-Account-Read",
    requirement: "Account-Lesezugriff verifiziert (Control-Plane-Probe, status-only).",
    async run(ctx) {
      return safeRun("accountRead", async () => {
        const r = await ctx.port.readAccount();
        return r.ok ? pass("accountRead", r.detail) : fail("accountRead", r.detail);
      });
    },
  },
  orderTest: {
    id: "orderTest",
    label: "Test-Order-Prüfung",
    requirement:
      "Testnet-/Test-Order-Prüfung bestanden — ausschließlich simuliert/Mock; echte Orders sind in Checks/CI verboten.",
    async run(ctx) {
      return safeRun("orderTest", async () => {
        const r = await ctx.port.placeTestOrder();
        return r.ok ? pass("orderTest", r.detail) : fail("orderTest", r.detail);
      });
    },
  },
  paperCriteria: {
    id: "paperCriteria",
    label: "Paper-Kriterien",
    requirement:
      "Mindestens LIVE_GATE_PAPER_MIN_ORDERS fehlerfreie Paper-Orders (Default 50, konfigurierbar).",
    async run(ctx) {
      return safeRun("paperCriteria", async () => {
        const stats = await ctx.port.paperStats();
        const ok = stats.errorFreeOrders >= ctx.config.paperMinOrders && stats.orders > 0;
        return ok
          ? pass(
              "paperCriteria",
              `${stats.errorFreeOrders}/${stats.orders} Paper-Orders fehlerfrei (Minimum ${ctx.config.paperMinOrders}). ${stats.detail}`
            )
          : fail(
              "paperCriteria",
              `Nur ${stats.errorFreeOrders}/${stats.orders} Paper-Orders fehlerfrei — Minimum ${ctx.config.paperMinOrders} nicht erreicht. ${stats.detail}`
            );
      });
    },
  },
};

// ── Port-Registry ────────────────────────────────────────────────────────────

const registeredPorts = new Map<string, BrokerGatePort>();

/** Registriert einen Gate-Port für ein Venue (Integration/Tests/Deploy). */
export function registerGatePort(venue: string, port: BrokerGatePort): void {
  registeredPorts.set(venue.toUpperCase(), port);
}

export function setGatePortForTests(venue: string, port: BrokerGatePort | null): void {
  if (port) registeredPorts.set(venue.toUpperCase(), port);
  else registeredPorts.delete(venue.toUpperCase());
}

export function resetGatePortsForTests(): void {
  registeredPorts.clear();
}

export function resolveGatePort(venue: string): BrokerGatePort {
  return registeredPorts.get(venue.toUpperCase()) ?? createDefaultGatePort(venue);
}

// ── Default-Port (read-only, offline-sicher, fail-closed) ────────────────────

export const NO_TEST_ORDER_REASON =
  "Kein Test-Order-Provider registriert: Bitunix hat kein dokumentiertes Testnet; ORDER_TEST_OK erfordert einen explizit registrierten Test-Order-Provider (Mock in CI oder Venue-Testnet in einem künftigen Adapter).";

export const NO_PAPER_STATS_REASON =
  "Keine Paper-Statistikquelle registriert (Default-Port meldet 0 Orders — fail-closed).";

/**
 * Default-Port: nutzt vorhandene read-only Infrastruktur (Adapter-Health,
 * Bitunix-Public-Ticker, Control-Plane-Status). Netzwerkfehler => Check fällt
 * durch (fail-closed). placeTestOrder verweigert IMMER (kein Testnet).
 */
export function createDefaultGatePort(venueRaw: string): BrokerGatePort {
  const venue = venueRaw.toUpperCase();
  return {
    async healthCheck(): Promise<PortProbeResult> {
      try {
        const { createAdapter } = await import("../brokers/factory");
        const adapter = createAdapter(venue as BrokerVenueId, "paper");
        const health = await adapter.healthCheck();
        return health.status === "online"
          ? { ok: true, detail: `Adapter-Health online (${venue}).` }
          : { ok: false, detail: `Adapter-Health ${health.status} (${venue}) — Verbindungstest nicht bestanden.` };
      } catch (err) {
        return { ok: false, detail: `Health-Check fehlgeschlagen: ${(err as Error).message}` };
      }
    },
    async fetchTicker(symbol = "BTCUSDT"): Promise<PortProbeResult> {
      try {
        if (venue !== "BITUNIX") {
          return {
            ok: false,
            detail: `Kein read-only Market-Data-Check für ${venue} implementiert (fail-closed).`,
          };
        }
        const { envFlagTrue, loadBitunixConfig } = await import("../brokers/bitunix/config");
        const { BitunixPublicClient } = await import("../brokers/bitunix/publicClient");
        if (!envFlagTrue(process.env, "BITUNIX_ENABLED")) {
          return { ok: false, detail: "BITUNIX_ENABLED nicht true — Market-Data-Check nicht möglich." };
        }
        const client = new BitunixPublicClient({ config: loadBitunixConfig(process.env) });
        const ticker = await client.fetchTicker(symbol);
        return ticker && Number.isFinite(ticker.price)
          ? { ok: true, detail: `Public-Ticker ${ticker.symbol} gelesen (read-only).` }
          : { ok: false, detail: "Public-Ticker ungültig/leer." };
      } catch (err) {
        return { ok: false, detail: `Market-Data-Check fehlgeschlagen: ${(err as Error).message}` };
      }
    },
    async readAccount(): Promise<PortProbeResult> {
      try {
        const { getControlPlaneService } = await import("../brokers/control-plane/service");
        const service = await getControlPlaneService();
        const status = await service.getStatus(venue);
        return status.configured && status.connected
          ? { ok: true, detail: "Control-Plane: Credentials konfiguriert + verbunden (read-only Probe)." }
          : { ok: false, detail: "Control-Plane: Venue nicht konfiguriert/verbunden — Account-Read nicht verifiziert." };
      } catch (err) {
        return { ok: false, detail: `Account-Read fehlgeschlagen: ${(err as Error).message}` };
      }
    },
    async placeTestOrder(): Promise<PortProbeResult> {
      // BEWUSST fail-closed: kein Venue-Testnet dokumentiert (Bitunix), echte
      // Test-Orders in CI/Checks sind verboten. Registrierung = Mock/Testnet.
      return { ok: false, detail: NO_TEST_ORDER_REASON };
    },
    async paperStats(): Promise<PortPaperStats> {
      return { errorFreeOrders: 0, orders: 0, detail: NO_PAPER_STATS_REASON };
    },
  };
}
