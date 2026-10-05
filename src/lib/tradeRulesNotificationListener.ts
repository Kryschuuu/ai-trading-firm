/**
 * Reconnecting PostgreSQL LISTEN-Client für trade_rules.
 *
 * Der Client hält genau eine dedizierte Pool-Verbindung; er führt keinerlei
 * Regel-Queries aus. Benachrichtigungen werden nach dem Commit von PostgreSQL
 * zugestellt. Bei Verbindungsverlust wird mit begrenztem exponentiellem
 * Backoff neu verbunden; der periodische RuleCache-Poll bleibt ein Fallback.
 */
import type { Pool, PoolClient } from "pg";

export const TRADE_RULES_CHANNEL = "trade_rules";

export interface TradeRulesNotificationListenerOptions {
  initialRetryMs?: number;
  maxRetryMs?: number;
  log?: (level: "info" | "warn", message: string) => void;
}

export class TradeRulesNotificationListener {
  private client: PoolClient | null = null;
  private handlers: {
    notification: (message: { channel?: string }) => void;
    error: (error: Error) => void;
    end: () => void;
  } | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs: number;
  private stopped = true;

  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly log: NonNullable<TradeRulesNotificationListenerOptions["log"]>;

  constructor(
    private readonly pool: Pick<Pool, "connect">,
    private readonly onNotification: () => void,
    options: TradeRulesNotificationListenerOptions = {},
  ) {
    this.initialRetryMs = Math.max(1, Math.trunc(options.initialRetryMs ?? 1_000));
    this.maxRetryMs = Math.max(this.initialRetryMs, Math.trunc(options.maxRetryMs ?? 30_000));
    this.retryMs = this.initialRetryMs;
    this.log = options.log ?? ((level, message) => console[level === "warn" ? "warn" : "log"](message));
  }

  /** Idempotent; resolves after LISTEN succeeds or a retry has been scheduled. */
  start(): Promise<void> {
    this.stopped = false;
    if (this.connecting) return this.connecting;
    if (this.client) return Promise.resolve();
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const client = this.client;
    this.client = null;
    if (client) {
      // LISTEN is session-scoped. Return the healthy connection to pg.Pool only
      // after UNLISTEN, otherwise a later borrower could retain this subscription.
      this.detachHandlers(client);
      try {
        await client.query(`UNLISTEN ${TRADE_RULES_CHANNEL}`);
        client.release();
      } catch (error) {
        client.release(error instanceof Error ? error : new Error("Unable to UNLISTEN trade_rules"));
      }
    }
    // A pending pool.connect() observes `stopped` after it resolves and releases
    // its client. Do not wait for a potentially stuck network connect here.
  }

  private async connectOnce(): Promise<void> {
    let client: PoolClient | null = null;
    let attached = false;
    try {
      client = await this.pool.connect();
      if (this.stopped) {
        client.release();
        return;
      }

      const notification = (message: { channel?: string }) => {
        if (message?.channel !== TRADE_RULES_CHANNEL) return;
        try {
          this.onNotification();
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          this.log("warn", `[cache-invalidation] RuleCache-Callback fehlgeschlagen: ${errorName}`);
        }
      };
      const onError = (error: Error) => this.handleDisconnect(client!, error);
      const onEnd = () => this.handleDisconnect(client!, new Error("PostgreSQL LISTEN connection ended"));
      this.client = client;
      this.handlers = { notification, error: onError, end: onEnd };
      attached = true;
      // Install handlers before LISTEN so no notification or disconnect can
      // land in the gap between subscription activation and our code.
      client.on("notification", notification);
      client.on("error", onError);
      client.on("end", onEnd);
      await client.query(`LISTEN ${TRADE_RULES_CHANNEL}`);

      if (this.stopped) {
        if (this.client === client) {
          this.client = null;
          this.detachAndRelease(client);
        }
        return;
      }
      this.retryMs = this.initialRetryMs;
      this.log("info", `[task07] LISTEN ${TRADE_RULES_CHANNEL} aktiv`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error("UnknownError");
      if (client && attached && this.client === client) {
        this.client = null;
        this.detachAndRelease(client, err);
      } else if (client && !attached) {
        client.release(err);
      }
      // If an attached client already emitted `error`, handleDisconnect has
      // released it; do not release it a second time here.
      if (!this.stopped) {
        this.log("warn", `[task07] LISTEN ${TRADE_RULES_CHANNEL} fehlgeschlagen: ${err.name}`);
        this.scheduleRetry();
      }
    }
  }

  private handleDisconnect(client: PoolClient, error: Error): void {
    if (this.client !== client) return;
    this.client = null;
    this.detachAndRelease(client, error);
    if (!this.stopped) {
      this.log("warn", `[task07] LISTEN ${TRADE_RULES_CHANNEL} Verbindung verloren: ${error.name}`);
      this.scheduleRetry();
    }
  }

  private detachHandlers(client: PoolClient): void {
    const handlers = this.handlers;
    this.handlers = null;
    if (handlers) {
      client.removeListener("notification", handlers.notification);
      client.removeListener("error", handlers.error);
      client.removeListener("end", handlers.end);
    }
  }

  private detachAndRelease(client: PoolClient, error?: Error): void {
    this.detachHandlers(client);
    client.release(error);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.maxRetryMs, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
    this.retryTimer.unref?.();
  }
}
