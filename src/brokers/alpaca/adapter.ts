/**
 * AlpacaBrokerAdapter — 8. Venue, US-Aktien/ETFs/Crypto (Task 12).
 *
 * Capabilities: discovery, marketData, trading, paper, testnet (Paper-API),
 * live (Capability JA), stopAtVenue (Bracket-Orders auf Alpaca). testnet
 * ist true, weil Alpacas offizielle "Paper-Trading"-API ein vollständiges
 * Testnet ist (eigener Endpoint, separate Credentials, eigenes Geld-Limit).
 *
 * Ausführungsarchitektur (analog zu Task-07-Bitunix): Der Adapter besitzt
 * EINE `ExecutionPort` je Modus — `PaperExecutionEngine` (paper/backtest)
 * bzw. `BrokerExecutionEngine` (testnet/live). Live führt NIE über das
 * Paper-Ledger: Der Live-Pfad prüft das zentrale Live-Gate (Task 11) und
 * delegiert danach ausschließlich an die Broker-Engine.
 *
 * Live-Freigabe: durch den zentralen Live-Gate-Enforcer (Task 11) — Default
 * weiter `LiveTradingGateError`, bis die State-Machine LIVE_ENABLED + Flags
 * + Suite + Control Plane freigibt (docs/LIVE_TRADING.md).
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
  type EmergencyCancelResult,
  type EmergencyCloseFill,
  type ExecutionMode,
  type MarketCandle,
  type MarketTicker,
} from "../../contracts/broker";
import type { MarketInstrument } from "../../universe/types";
import { getRegistry, type InstrumentRegistry } from "../../universe";
import {
  type AlpacaRuntimeConfig,
  type EnvLike,
  loadAlpacaPublicConfig,
  loadAlpacaTradeConfig,
} from "./config";
import { assertAlpacaEnabled, assertLiveOrderAllowed } from "./gates";
import { AlpacaPublicClient } from "./publicClient";
import { AlpacaPrivateClient } from "./privateClient";
import { AlpacaPaperLedger } from "./paper";
import { BrokerExecutionEngine, PaperExecutionEngine, type ExecutionPort } from "./execution";
import { createDefaultAlpacaSecretStore, loadAlpacaCredentials, type AlpacaCredentials, type SecretStore } from "./secrets";
import { createAlpacaLogger, type AlpacaLogger } from "./redactor";
import { AlpacaHttp, TokenBucket } from "./http";
import { mapAsset, mapAssets } from "./mapping";
import { envInt } from "../../lib/env";

export interface AlpacaAdapterDeps {
  env?: EnvLike;
  publicConfig?: AlpacaRuntimeConfig;
  tradeConfig?: AlpacaRuntimeConfig;
  publicClient?: AlpacaPublicClient;
  privateClient?: AlpacaPrivateClient;
  registry?: InstrumentRegistry;
  secretStore?: SecretStore;
  logger?: AlpacaLogger;
  paper?: AlpacaPaperLedger;
  now?: () => Date;
}

export class AlpacaBrokerAdapter implements BrokerAdapter {
  readonly id = "ALPACA" as const;
  readonly mode: ExecutionMode;
  readonly capabilities: BrokerCapabilities = VENUE_CAPABILITIES.ALPACA;

  private readonly env: EnvLike;
  private readonly publicCfg: AlpacaRuntimeConfig;
  private readonly tradeCfg: AlpacaRuntimeConfig;
  private readonly logger: AlpacaLogger;
  private readonly secrets: SecretStore;
  private readonly publicClient: AlpacaPublicClient;
  private readonly registry?: InstrumentRegistry;
  private readonly paper: AlpacaPaperLedger;
  private readonly now: () => Date;
  private lastTicker = new Map<string, MarketTicker>();
  private privateClientOverride?: AlpacaPrivateClient;
  private brokerEngine: BrokerExecutionEngine | null = null;
  /**
   * Deterministische Redaction-Quelle des Loggers. Sobald Credentials über
   * `loadCreds()` in den Prozess geladen werden, stehen sie SOFORT in dieser
   * Maskierliste — kein Fire-and-Forget-Fenster.
   */
  private readonly redactionSecrets: string[] = [];

  constructor(mode: ExecutionMode = "paper", deps: AlpacaAdapterDeps = {}) {
    this.mode = mode;
    this.env = deps.env ?? process.env;
    this.publicCfg = deps.publicConfig ?? loadAlpacaPublicConfig(this.env);
    this.tradeCfg = deps.tradeConfig ?? loadAlpacaTradeConfig(this.env);
    this.secrets = deps.secretStore ?? createDefaultAlpacaSecretStore(this.env);
    this.logger = deps.logger ?? createAlpacaLogger(() => this.redactionSecrets.filter(Boolean));
    const secretsFn = () => this.redactionSecrets.filter(Boolean);
    const publicHttp = new AlpacaHttp({
      config: this.publicCfg,
      logger: this.logger,
      secrets: secretsFn,
      bucket: new TokenBucket(this.publicCfg.publicRatePerSec, this.publicCfg.publicRatePerSec),
    });
    this.publicClient = deps.publicClient ?? new AlpacaPublicClient({ config: this.publicCfg, http: publicHttp });
    this.registry = deps.registry;
    this.paper =
      deps.paper ??
      new AlpacaPaperLedger(envInt("STARTING_EQUITY", 10_000, 1, 1e12, this.env), {
        registry: this.registry,
      });
    this.now = deps.now ?? (() => new Date());
    this.privateClientOverride = deps.privateClient;
  }

  /**
   * Zentraler Credential-Lader: einziger Weg, auf dem Klartext-Credentials in
   * den Adapter gelangen. Befüllt SYNCHRON mit dem Laden die Redaction-Liste
   * des Loggers.
   */
  private async loadCreds(): Promise<AlpacaCredentials | null> {
    const creds = await loadAlpacaCredentials(this.secrets);
    if (creds) {
      this.redactionSecrets[0] = creds.apiKey;
      this.redactionSecrets[1] = creds.apiSecret;
    }
    return creds;
  }

  /**
   * Frontend-sichere Projektion — niemals Secrets.
   *   - configured: Credentials hinterlegt + Adapter aktiviert
   *   - connected: nur true, wenn verify einen echten Account-Abruf gemacht hat
   *   - permissions: nur belegte Rechte; ohne verify leer; mit verify mindestens READ
   *   - permissionsVerified: true = geprüft statt angenommen
   */
  async credentialStatus(opts?: { verify?: boolean }): Promise<import("./types").AlpacaCredentialStatus> {
    const creds = await this.loadCreds();
    const base: import("./types").AlpacaCredentialStatus = {
      configured: Boolean(creds) && this.publicCfg.enabled,
      connected: false,
      permissions: [],
      permissionsVerified: false,
      liveEnabled: false,
      alpacaEnabled: this.publicCfg.enabled,
      paper: this.publicCfg.usePaperEndpoints,
    };
    if (!opts?.verify || !creds || !this.publicCfg.enabled) return base;
    try {
      const client = await this.privateClient();
      await client.getAccount();
      return { ...base, connected: true, permissions: ["READ"], permissionsVerified: true };
    } catch {
      return base;
    }
  }

  async healthCheck(opts?: { remote?: boolean }): Promise<BrokerHealth> {
    const t0 = process.hrtime.bigint();
    const creds = await this.loadCreds();
    const status = await this.credentialStatus();
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    const details: Record<string, unknown> = {
      implemented: true,
      alpacaEnabled: status.alpacaEnabled,
      configured: status.configured,
      connected: status.connected,
      permissions: status.permissions,
      permissionsVerified: status.permissionsVerified,
      liveEnabled: false,
      paperSimulated: true,
      stopAtVenue: true,
      testnet: this.capabilities.testnet,
      testnetReason: "Alpaca Paper-API ist ein vollständiges Testnet (paper-api.alpaca.markets).",
      usePaperEndpoints: this.publicCfg.usePaperEndpoints,
      remoteCheck: opts?.remote ? "angefordert" : "deaktiviert (Default)",
    };
    if (!this.publicCfg.enabled) {
      return {
        status: "offline",
        latencyMs,
        details: { ...details, reason: "ALPACA_DISABLED" },
      };
    }
    if (opts?.remote) {
      // Alpacas Snapshot-Endpoint ist nicht credential-frei (IEX-Daten
      // verlangen Auth). Ohne Credentials liefert der Health-Click deshalb
      // ehrlich "degraded" + CREDENTIALS_REQUIRED — wir starten gar nicht
      // erst einen Network-Call. Das ist konsistent mit der Stub-Semantik
      // (andere Venues ohne credential-freien Check verhalten sich gleich).
      if (!creds) {
        return {
          status: "degraded",
          latencyMs,
          details: { ...details, reason: "CREDENTIALS_REQUIRED", remoteCheck: "credentials erforderlich" },
        };
      }
      try {
        await this.publicClient.fetchSnapshot("AAPL", "equity");
        details.remoteCheck = "read-only public snapshot";
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
    assertAlpacaEnabled(this.env);
    const client = await this.privateClient();
    const items = await client.getAssets({ status: "active" });
    const stamped = mapAssets(items, this.now());
    const registry = this.registry ?? tryRegistry();
    if (registry && stamped.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < stamped.length; i += BATCH) {
        registry.upsertMany(stamped.slice(i, i + BATCH), "discovery:alpaca");
      }
    }
    return stamped;
  }

  async getTicker(symbol: string): Promise<MarketTicker> {
    this.require("marketData", "getTicker");
    assertAlpacaEnabled(this.env);
    const sym = symbol.toUpperCase();
    const assetClass: "equity" | "crypto" = sym.includes("/") ? "crypto" : "equity";
    const t = await this.publicClient.fetchTicker(sym, assetClass);
    if (!t) {
      throw new NotSupportedCapabilityError(
        this.id,
        "marketData",
        "getTicker",
        `Alpaca lieferte keinen Ticker für ${sym}.`
      );
    }
    this.lastTicker.set(sym, t);
    return t;
  }

  async getTickers(symbols?: string[]): Promise<MarketTicker[]> {
    this.require("marketData", "getTickers");
    assertAlpacaEnabled(this.env);
    const out: MarketTicker[] = [];
    const list = symbols && symbols.length > 0 ? symbols : ["AAPL", "MSFT", "TSLA"];
    for (const s of list) {
      try {
        const t = await this.getTicker(s);
        out.push(t);
      } catch {
        /* einzelne Ticker dürfen fehlschlagen, ohne den ganzen Batch zu blockieren */
      }
    }
    return out;
  }

  async getCandles(symbol: string, timeframe = "1Day", limit = 120): Promise<MarketCandle[]> {
    this.require("marketData", "getCandles");
    assertAlpacaEnabled(this.env);
    const sym = symbol.toUpperCase();
    const assetClass: "equity" | "crypto" = sym.includes("/") ? "crypto" : "equity";
    return this.publicClient.fetchCandles(sym, assetClass, timeframe, limit);
  }

  async getOrderBook(_symbol: string): Promise<import("../../contracts/broker").MarketOrderBook> {
    this.require("marketData", "getOrderBook");
    throw new NotSupportedCapabilityError(
      this.id,
      "marketData",
      "getOrderBook",
      "Alpaca-Adapter liefert keine Order-Book-Daten (nur Trades/Quotes/Bars)."
    );
  }

  async getAccount(): Promise<BrokerAccount> {
    this.require("trading", "getAccount");
    assertAlpacaEnabled(this.env);
    if (this.mode === "live") {
      assertLiveOrderAllowed(this.id, this.env);
    }
    const engine = await this.execution();
    return engine.getAccount((s) => this.lastTicker.get(s)?.price ?? null);
  }

  async getPositions(): Promise<BrokerPosition[]> {
    this.require("trading", "getPositions");
    assertAlpacaEnabled(this.env);
    if (this.mode === "live") {
      assertLiveOrderAllowed(this.id, this.env);
    }
    const engine = await this.execution();
    return engine.listPositions((s) => this.lastTicker.get(s)?.price ?? null);
  }

  /**
   * paper/backtest: PaperExecutionEngine (lokales Ledger gegen Alpaca-Ticker).
   * testnet/live: Live-Gate-Enforcer (Task 11) → BrokerExecutionEngine
   *                → AlpacaPrivateClient.placeOrder (echte Venue-Order).
   *                NIE Paper-Ledger im Live-Pfad.
   */
  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    this.require("trading", "placeOrder");
    assertAlpacaEnabled(this.env);
    if (this.mode === "live") {
      assertLiveOrderAllowed(this.id, this.env);
    }
    const engine = await this.execution();
    const sym = req.symbol.toUpperCase();
    const ticker = this.lastTicker.get(sym) ?? (await this.getTicker(sym));
    return engine.submit(req, ticker);
  }

  // ── H7 (v1.36.20): Kill-Switch-Notfall auf Venue-Ebene ─────────────────────
  // Live/testnet: echte Alpaca-Trade-API cancel → close → verify. Paper/
  // backtest: NotSupportedCapabilityError — der Kern glattstellt dort über
  // den Legacy-PaperBroker, nicht über den Adapter.

  async cancelAllOpenOrders(): Promise<EmergencyCancelResult> {
    assertAlpacaEnabled(this.env);
    if (this.mode !== "live" && this.mode !== "testnet") {
      throw new NotSupportedCapabilityError(this.id, "emergency", "cancelAllOpenOrders", "Nur live/testnet.");
    }
    if (this.mode === "live") assertLiveOrderAllowed(this.id, this.env);
    const engine = await this.execution();
    if (!engine.cancelAllOpenOrders) {
      throw new NotSupportedCapabilityError(this.id, "emergency", "cancelAllOpenOrders", "Engine ohne H7-Notfall-Pfad.");
    }
    return engine.cancelAllOpenOrders();
  }

  async closeAllPositions(reason: string): Promise<EmergencyCloseFill[]> {
    assertAlpacaEnabled(this.env);
    if (this.mode !== "live" && this.mode !== "testnet") {
      throw new NotSupportedCapabilityError(this.id, "emergency", "closeAllPositions", "Nur live/testnet.");
    }
    if (this.mode === "live") assertLiveOrderAllowed(this.id, this.env);
    const engine = await this.execution();
    if (!engine.closeAllPositions) {
      throw new NotSupportedCapabilityError(this.id, "emergency", "closeAllPositions", "Engine ohne H7-Notfall-Pfad.");
    }
    return engine.closeAllPositions(reason);
  }

  async verifyFlat(): Promise<boolean> {
    assertAlpacaEnabled(this.env);
    if (this.mode !== "live" && this.mode !== "testnet") {
      throw new NotSupportedCapabilityError(this.id, "emergency", "verifyFlat", "Nur live/testnet.");
    }
    if (this.mode === "live") assertLiveOrderAllowed(this.id, this.env);
    const engine = await this.execution();
    if (!engine.verifyFlat) {
      throw new NotSupportedCapabilityError(this.id, "emergency", "verifyFlat", "Engine ohne H7-Notfall-Pfad.");
    }
    return engine.verifyFlat();
  }

  /** Private-Client (Account/Positions/Place) — Basis der Broker-Engine. */
  async privateClient(): Promise<AlpacaPrivateClient> {
    if (this.privateClientOverride) return this.privateClientOverride;
    const creds = await this.loadCreds();
    if (!creds) {
      throw new NotSupportedCapabilityError(this.id, "trading", "privateClient", "Keine Alpaca-Credentials (Env-Fallback).");
    }
    const tradeHttp = new AlpacaHttp({
      config: this.tradeCfg,
      logger: this.logger,
      secrets: () => this.redactionSecrets.filter(Boolean),
      bucket: new TokenBucket(this.tradeCfg.privateRatePerSec, this.tradeCfg.privateRatePerSec),
    });
    return new AlpacaPrivateClient({
      config: this.tradeCfg,
      credentials: creds,
      http: tradeHttp,
    });
  }

  private async execution(): Promise<ExecutionPort> {
    if (this.mode !== "live" && this.mode !== "testnet") {
      return new PaperExecutionEngine(this.paper);
    }
    // testnet UND live nutzen die Broker-Engine — der Live-Gate prüft im
    // Live-Pfad die Freigabe; im Testnet-Pfad (Paper-API) ist der Gate
    // nicht nötig, weil ohnehin nur die Paper-Endpoint-URL verwendet wird.
    // WICHTIG: tradeCfg.usePaperEndpoints (nicht publicCfg) ist maßgeblich,
    // weil nur die Trade-Config ALPACA_USE_LIVE_ENDPOINTS liest.
    if (this.mode === "testnet" && !this.tradeCfg.usePaperEndpoints) {
      // Sicherheits-Defense: Testnet mit Live-Endpoint ist verboten.
      throw new NotSupportedCapabilityError(this.id, "testnet", "execution",
        "Testnet-Modus verlangt usePaperEndpoints=true (ALPACA_USE_LIVE_ENDPOINTS nicht setzen).");
    }
    if (!this.brokerEngine) {
      const client = await this.privateClient();
      this.brokerEngine = new BrokerExecutionEngine(client, this.paper);
    }
    return this.brokerEngine;
  }

  private require(capability: keyof BrokerCapabilities, method: string): void {
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
