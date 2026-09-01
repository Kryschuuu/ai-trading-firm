/**
 * BitunixBrokerAdapter — 7. Venue, Futures-Perpetuals (Task 07).
 *
 * Capabilities: discovery, marketData, trading, paper, live (Capability JA),
 * stopAtVenue. testnet=false (kein dokumentiertes Testnet).
 *
 * Ausführungsarchitektur (Task-11-Refactor): Der Adapter besitzt EINE `ExecutionPort`
 * je Modus — `PaperExecutionEngine` (paper/backtest) bzw. `BrokerExecutionEngine`
 * (live). Live führt NIE über das Paper-Ledger: Der Live-Pfad prüft das zentrale
 * Live-Gate (Task 11) und delegiert danach ausschließlich an die Broker-Engine
 * → `BitunixPrivateClient.placeSerializedOrder` / echte Account-/Positions-Daten.
 *
 * Live-Freigabe: durch den zentralen Live-Gate-Enforcer (Task 11) — Default weiter
 * `LiveTradingGateError`, bis die State-Machine LIVE_ENABLED + Flags + Suite +
 * Control Plane freigibt (docs/LIVE_TRADING.md).
 * Paper: echte Public-Kurse, lokales Ledger, keine Private-API.
 */
import { VENUE_CAPABILITIES } from "../capabilities";
import {
  NotSupportedCapabilityError,
  type BrokerAccount,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerHealth,
  type BrokerOrderRequest,
  type BrokerOrderResult,
  type BrokerPosition,
  type ExecutionMode,
  type MarketCandle,
  type MarketOrderBook,
  type MarketTicker,
} from "../../contracts/broker";
import type { MarketInstrument } from "../../universe/types";
import { getRegistry, type InstrumentRegistry } from "../../universe";
import {
  type BitunixRuntimeConfig,
  type EnvLike,
  loadBitunixConfig,
} from "./config";
import { assertBitunixEnabled, assertLiveOrderAllowed } from "./gates";
import { BitunixPublicClient, mapTicker } from "./publicClient";
import { BitunixPrivateClient } from "./privateClient";
import { BitunixPaperLedger } from "./paper";
import { BrokerExecutionEngine, PaperExecutionEngine, type ExecutionPort } from "./execution";
import { createDefaultBitunixSecretStore, loadBitunixCredentials, type BitunixCredentials, type SecretStore } from "./secrets";
import { createBitunixLogger, type BitunixLogger } from "./redactor";
import { BitunixPublicWs } from "./ws";
import type { BitunixCredentialStatus } from "./types";
import { TokenBucket } from "./http";
import { envInt } from "../../lib/env";

export interface BitunixAdapterDeps {
  env?: EnvLike;
  config?: BitunixRuntimeConfig;
  publicClient?: BitunixPublicClient;
  privateClient?: BitunixPrivateClient;
  registry?: InstrumentRegistry;
  secretStore?: SecretStore;
  logger?: BitunixLogger;
  paper?: BitunixPaperLedger;
  now?: () => Date;
}

/**
 * Zusätzlich zum `BrokerAdapter`-Contract bietet der Adapter die Public-
 * Market-Data-Methoden `discoverInstruments()` / `getTicker(s)()` /
 * `getOrderBook()` / `getCandles()` an. Die **Marketdata-Domäne** koppelt er
 * bewusst NICHT mehr direkt ein (kein Import von `src/marketdata` — die
 * Abhängigkeitsrichtung bleibt Broker ← Marketdata, nie umgekehrt): der
 * dünne Wrapper `src/marketdata/adapters/bitunix.ts` adaptiert den
 * `BitunixPublicClient` auf das `MarketDataAdapter`-Interface
 * (`src/marketdata/sync.ts`) und ist die einzige Market-Data-Quelle des
 * `MarketDataSyncService`. Die Methoden hier bleiben für Paper-Ausführung,
 * Health-Check und die Broker-API Routen erhalten.
 */
export class BitunixBrokerAdapter implements BrokerAdapter {
  readonly id = "BITUNIX" as const;
  readonly mode: ExecutionMode;
  readonly capabilities: BrokerCapabilities = VENUE_CAPABILITIES.BITUNIX;

  private readonly env: EnvLike;
  private readonly cfg: BitunixRuntimeConfig;
  private readonly logger: BitunixLogger;
  private readonly secrets: SecretStore;
  private readonly public: BitunixPublicClient;
  private readonly registry?: InstrumentRegistry;
  private readonly paper: BitunixPaperLedger;
  private readonly now: () => Date;
  private lastTicker = new Map<string, MarketTicker>();
  private ws: BitunixPublicWs | null = null;
  private privateClientOverride?: BitunixPrivateClient;
  /** Cache der Modus-spezifischen Ausführungs-Engine (Paper- oder Broker-Port). */
  private brokerEngine: BrokerExecutionEngine | null = null;
  /**
   * Deterministische Redaction-Quelle des Loggers: Sobald Credentials über
   * `loadCreds()` in den Prozess geladen werden, stehen sie SOFORT in dieser
   * Maskierliste — kein Fire-and-Forget-Fenster, in dem nur die musterbasierte
   * Redaction greift. Vor dem ersten Laden existieren die Klartexte im
   * Adapter ohnehin nicht.
   */
  private readonly redactionSecrets: string[] = [];

  constructor(mode: ExecutionMode = "paper", deps: BitunixAdapterDeps = {}) {
    this.mode = mode;
    this.env = deps.env ?? process.env;
    this.cfg = deps.config ?? loadBitunixConfig(this.env);
    this.secrets = deps.secretStore ?? createDefaultBitunixSecretStore(this.env);
    this.logger = deps.logger ?? createBitunixLogger(() => this.redactionSecrets.filter(Boolean));
    this.public =
      deps.publicClient ??
      new BitunixPublicClient({
        config: this.cfg,
        logger: this.logger,
        bucket: new TokenBucket(this.cfg.publicRatePerSec, this.cfg.publicRatePerSec),
      });
    this.registry = deps.registry;
    this.paper =
      deps.paper ??
      new BitunixPaperLedger(envInt("STARTING_EQUITY", 10_000, 1, 1e12, this.env), {
        registry: this.registry,
      });
    this.now = deps.now ?? (() => new Date());
    this.privateClientOverride = deps.privateClient;
  }

  /**
   * Zentraler Credential-Lader: einziger Weg, auf dem Klartext-Credentials in
   * den Adapter gelangen. Befüllt SYNCHRON mit dem Laden die Redaction-Liste
   * des Loggers (deterministisch — kein Race gegen ein Fire-and-Forget-Promise).
   */
  private async loadCreds(): Promise<BitunixCredentials | null> {
    const creds = await loadBitunixCredentials(this.secrets);
    if (creds) {
      this.redactionSecrets[0] = creds.apiKey;
      this.redactionSecrets[1] = creds.apiSecret;
    }
    return creds;
  }

  /**
   * Frontend-sichere Projektion — niemals Secrets.
   *
   * Ehrliche Semantik (statt der früheren Behauptung `permissions:
   * ["READ","TRADE"]` allein aus der Existenz von Credentials):
   *   - `configured`            Credentials hinterlegt + Adapter aktiviert.
   *   - `connected`             nur true, wenn `verify` einen echten
   *                             (read-only) Konto-Abruf erfolgreich gemacht hat.
   *   - `permissions`           nur belegte Rechte. Ohne `verify` leer; mit
   *                             `verify` maximal READ — Bitunix' Account-
   *                             Antwort weist keine Handelsberechtigung aus,
   *                             TRADE ließe sich nur per echter Order beweisen.
   *   - `permissionsVerified`   true = geprüft statt angenommen.
   */
  async credentialStatus(opts?: { verify?: boolean }): Promise<BitunixCredentialStatus> {
    const creds = await this.loadCreds();
    const base: BitunixCredentialStatus = {
      configured: Boolean(creds) && this.cfg.enabled,
      connected: false,
      permissions: [],
      permissionsVerified: false,
      liveEnabled: false,
      bitunixEnabled: this.cfg.enabled,
    };
    if (!opts?.verify || !creds || !this.cfg.enabled) return base;
    try {
      const client = await this.privateClient();
      await client.getAccount();
      return { ...base, connected: true, permissions: ["READ"], permissionsVerified: true };
    } catch {
      // Fail-closed: kein Recht wird gemeldet, das nicht belegt ist.
      return base;
    }
  }

  async healthCheck(opts?: { remote?: boolean }): Promise<BrokerHealth> {
    const t0 = process.hrtime.bigint();
    const status = await this.credentialStatus();
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    const details: Record<string, unknown> = {
      implemented: true,
      bitunixEnabled: status.bitunixEnabled,
      configured: status.configured,
      connected: status.connected,
      permissions: status.permissions,
      permissionsVerified: status.permissionsVerified,
      liveEnabled: false,
      paperSimulated: true,
      stopAtVenue: true,
      testnet: false,
      testnetReason: "Offizielle Futures-Doku weist kein Testnet aus.",
      remoteCheck: opts?.remote ? "angefordert" : "deaktiviert (Default)",
    };
    if (!this.cfg.enabled) {
      return {
        status: "offline",
        latencyMs,
        details: { ...details, reason: "BITUNIX_DISABLED" },
      };
    }
    if (opts?.remote) {
      try {
        await this.public.fetchTickers("BTCUSDT");
        details.remoteCheck = "read-only public tickers";
        return { status: "online", latencyMs, details };
      } catch {
        return {
          status: "degraded",
          latencyMs,
          details: { ...details, reason: "REMOTE_CHECK_FAILED", remoteCheck: "fehlgeschlagen" },
        };
      }
    }
    return { status: "online", latencyMs, details };
  }

  async discoverInstruments(): Promise<MarketInstrument[]> {
    this.require("discovery", "discoverInstruments");
    assertBitunixEnabled(this.env);
    const items = await this.public.fetchTradingPairs();
    const stamped = items.map((i) => ({ ...i, lastSeen: this.now().toISOString() }));
    const registry = this.registry ?? tryRegistry();
    if (registry && stamped.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < stamped.length; i += BATCH) {
        registry.upsertMany(stamped.slice(i, i + BATCH), "discovery:bitunix");
      }
    }
    return stamped;
  }

  async getTicker(symbol: string): Promise<MarketTicker> {
    this.require("marketData", "getTicker");
    assertBitunixEnabled(this.env);
    const t = await this.public.fetchTicker(symbol.toUpperCase());
    this.lastTicker.set(t.symbol, t);
    return t;
  }

  /**
   * 1 × tickers (Batch) — Bulk-Variante der Public-Ticker. Bitunix liefert
   * ohne Symbolfilter den vollen Public-Ticker-Satz; damit spart sich der
   * Marketdata-Wrapper (`src/marketdata/adapters/bitunix.ts`) N per-Symbol-Calls.
   * Public-Client, keine Credentials.
   */
  async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
    this.require("marketData", "getTickers");
    assertBitunixEnabled(this.env);
    const query = symbols && symbols.length > 0 ? symbols.join(",") : undefined;
    const rows = await this.public.fetchTickers(query);
    const tickers = rows.map(mapTicker);
    for (const t of tickers) this.lastTicker.set(t.symbol, t);
    return tickers;
  }

  async getCandles(symbol: string, timeframe: string, limit = 120): Promise<MarketCandle[]> {
    this.require("marketData", "getCandles");
    assertBitunixEnabled(this.env);
    return this.public.fetchKlines(symbol.toUpperCase(), timeframe, limit);
  }

  async getOrderBook(symbol: string): Promise<MarketOrderBook> {
    this.require("marketData", "getOrderBook");
    assertBitunixEnabled(this.env);
    return this.public.fetchOrderBook(symbol.toUpperCase());
  }

  async getAccount(): Promise<BrokerAccount> {
    this.require("trading", "getAccount");
    assertBitunixEnabled(this.env);
    if (this.mode === "testnet") {
      throw new NotSupportedCapabilityError(this.id, "testnet", "getAccount", "Kein Bitunix-Testnet dokumentiert.");
    }
    // Live-Gate VOR jedem Broker-Zugriff — kein Paper-Ledger im Live-Pfad.
    // (Gate vor Engine-Aufbau: auch ohne Credentials bleibt der Deny dominant.)
    if (this.mode === "live") {
      assertLiveOrderAllowed(this.id, this.env);
    }
    const engine = await this.execution();
    return engine.getAccount((s) => this.lastTicker.get(s)?.price ?? null);
  }

  async getPositions(): Promise<BrokerPosition[]> {
    this.require("trading", "getPositions");
    assertBitunixEnabled(this.env);
    if (this.mode === "testnet") {
      throw new NotSupportedCapabilityError(this.id, "testnet", "getPositions", "Kein Bitunix-Testnet dokumentiert.");
    }
    if (this.mode === "live") {
      assertLiveOrderAllowed(this.id, this.env);
    }
    const engine = await this.execution();
    return engine.listPositions((s) => this.lastTicker.get(s)?.price ?? null);
  }

  /**
   * Paper/backtest: PaperExecutionEngine (lokales Ledger gegen Bitunix-Ticker).
   * live: Live-Gate-Enforcer (Task 11) → BrokerExecutionEngine
   *       → `BitunixPrivateClient.placeSerializedOrder` (echte Venue-Order).
   *       NIE Paper-Ledger im Live-Pfad.
   * testnet: NotSupportedCapabilityError.
   */
  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this.require("trading", "placeOrder");
    if (this.mode === "testnet") {
      throw new NotSupportedCapabilityError(
        this.id,
        "testnet",
        "placeOrder",
        "Kein Bitunix-Testnet in der offiziellen Futures-Doku."
      );
    }
    assertBitunixEnabled(this.env);
    if (this.mode === "live") {
      // Gate zuerst — erst nach bestandener Gesamtprüfung wird gesendet.
      assertLiveOrderAllowed(this.id, this.env);
    }
    const engine = await this.execution();
    const ticker = this.lastTicker.get(req.symbol.toUpperCase()) ?? (await this.getTicker(req.symbol));
    return engine.submit(req, ticker);
  }

  /**
   * Private-Client (Account/Positions/Place) — Basis der Broker-Engine.
   * Bei fehlenden Credentials laut `NotSupportedCapabilityError` (fail-safe).
   */
  async privateClient(): Promise<BitunixPrivateClient> {
    if (this.privateClientOverride) return this.privateClientOverride;
    const creds = await this.loadCreds();
    if (!creds) {
      throw new NotSupportedCapabilityError(this.id, "trading", "privateClient", "Keine Bitunix-Credentials (Env-Fallback).");
    }
    return new BitunixPrivateClient({
      config: this.cfg,
      credentials: creds,
      logger: this.logger,
    });
  }

  /**
   * Liefert die modus-spezifische Ausführungs-Engine.
   *
   * paper/backtest → PaperExecutionEngine (lokales Ledger)
   * live           → BrokerExecutionEngine (echte Venue-API)
   * testnet        → wird hier nicht erreicht (wirft in den Aufrufern).
   *
   * Der Live-Pfad berührt den Paper-Ledger NIE — die Modus-Separation ist die
   * eigentliche Sicherheitsgarantie gegen „Live-Daten aus Paper“.
   */
  private async execution(): Promise<ExecutionPort> {
    if (this.mode !== "live") return new PaperExecutionEngine(this.paper);
    this.brokerEngine ??= new BrokerExecutionEngine(await this.privateClient());
    return this.brokerEngine;
  }

  /** WS-Client (Ticker/Kline) mit Reconnect. */
  marketWs(): BitunixPublicWs {
    this.ws ??= new BitunixPublicWs({
      config: this.cfg,
      logger: this.logger,
      handlers: {
        onTicker: (t) => this.lastTicker.set(t.symbol, t),
      },
    });
    return this.ws;
  }

  private require(capability: keyof BrokerCapabilities, method: string): void {
    if (this.mode === "live" && capability === "trading") {
      // Defense in Depth — Factory erzeugt live nie; placeOrder/getAccount prüfen extra.
    }
    const cap = this.capabilities[capability];
    if (cap === false) {
      throw new NotSupportedCapabilityError(this.id, String(capability), method);
    }
  }
}

function tryRegistry(): InstrumentRegistry | undefined {
  try {
    return getRegistry();
  } catch {
    return undefined;
  }
}
