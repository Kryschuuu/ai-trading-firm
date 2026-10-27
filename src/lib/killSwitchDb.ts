/**
 * Autoritatives, prozessübergreifendes Kill-Switch-Gate (ASA-01).
 *
 * Hintergrund:
 *   Im Mehrprozess-Betrieb (`ai-trading-firm.service` + `micro-executor.service`)
 *   reicht das prozesslokale In-Memory-Flag `killSwitch` (`riskGuard.ts`) nicht
 *   aus: ein `POST /api/firm/kill` im Web-Prozess ließ den separaten
 *   `micro-executor` weiter Orders ausführen.
 *
 * Architektur:
 *   1. PostgreSQL (`kill_switches`) ist im Produktionspfad die einzige
 *      autoritative Quelle der Wahrheit.
 *   2. Im Normalbetrieb dämpft ein kurzlebiger TTL-Cache (<= 500 ms) die
 *      DB-Last auf hochfrequenten Pfaden.
 *   3. `POST /api/firm/kill` (sowie Auto-Kills) senden nach dem DB-Write
 *      `pg_notify('firm_control_changed', …)`; verbundene Prozesse
 *      (`FirmControlNotificationListener`) invalidieren ihren TTL-Cache sofort
 *      und synchronisieren `riskGuard.killSwitch`.
 *   4. FAIL-CLOSED: Ist `DATABASE_URL` auf eine reale Datenbank konfiguriert
 *      und schlägt die Abfrage von `kill_switches` fehl, entscheidet das Gate
 *      zwingend `armed = true` mit klarem Ablehnungsgrund.
 *   5. Testfreundlicher Offline-Fallback: Ohne `DATABASE_URL` (bzw. mit dem
 *      Offline-Test-Platzhalter `0.0.0.0:5432/test` aus `npm test`) fällt die
 *      Prüfung explizit auf das lokale In-Memory-Gate `killSwitch` zurück,
 *      damit reine Unit-Tests ohne PostgreSQL deterministisch grün bleiben.
 *
 * Bewusst frei von LLM-, Analysten-, Engine- und UI-Importen, damit sowohl
 * `MicroExecutor`, `brokerHydration` als auch `src/live-gate/enforcer.ts`
 * dieses Modul direkt verwenden können.
 */
import type { Pool, PoolClient } from "pg";
import { desc, sql } from "drizzle-orm";
import { db, pool as sharedPool } from "@/db";
import { killSwitches } from "@/db/schema";
import { killSwitch } from "./riskGuard";
import { state } from "./stateRegistry";

/** PostgreSQL LISTEN/NOTIFY-Kanal für globale Firmen-Steuerungsereignisse. */
export const FIRM_CONTROL_CHANNEL = "firm_control_changed";

/** Maximale Lebensdauer eines positiven/negativen DB-Snapshots im RAM (<= 500 ms). */
export const KILL_SWITCH_CACHE_TTL_MS = 500;

/**
 * Platzhalter-URL, die `npm test` und `npm run security:live-gate` für
 * DB-freie Offline-Unit-Tests setzen (`package.json`).
 */
const OFFLINE_TEST_DATABASE_URL = "postgresql://test:test@0.0.0.0:5432/test";

export type KillSwitchEnvLike = {
  readonly [key: string]: string | undefined;
};

export type KillSwitchSource =
  | "db"
  | "db-error"
  | "memory-fallback"
  | "cache-stale-fail-closed";

export interface AuthoritativeKillSwitchStatus {
  armed: boolean;
  reason: string | null;
  source: KillSwitchSource;
  checkedAtMs: number;
}

export type KillSwitchDbRow = {
  armed: boolean;
  reason: string | null;
};

export type KillSwitchDbReader = () => Promise<KillSwitchDbRow | null>;

let testDbReader: KillSwitchDbReader | null = null;
let testDbMode: "auto" | "db" | "memory" = "auto";
let singletonListener: FirmControlNotificationListener | null = null;

function currentEpoch(): number {
  return state.killSwitchDbEpoch.get() ?? 0;
}

function bumpEpoch(): number {
  const next = currentEpoch() + 1;
  state.killSwitchDbEpoch.set(next);
  return next;
}

/**
 * Extrahiert einen secret-freien Fehlercode für Ablehnungsgründe (niemals
 * rohe Connection-Strings / Credentials in Fehlermeldungen spiegeln).
 */
function safeDbErrorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const directCode = (err as { code?: unknown }).code;
    if (typeof directCode === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(directCode)) {
      return directCode;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(causeCode)) {
        return causeCode;
      }
    }
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(name) && name !== "Error") {
      return name;
    }
  }
  return "DB_QUERY_FAILED";
}

/**
 * Entscheidet, ob eine reale Datenbank für das autoritative Kill-Switch-Gate
 * konfiguriert ist (`true`) oder der explizite In-Memory-Fallback für reine
 * Offline-Unit-Tests gilt (`false`).
 */
export function isKillSwitchDbConfigured(
  env: KillSwitchEnvLike = process.env
): boolean {
  if (testDbMode === "memory") return false;
  if (testDbMode === "db" || testDbReader !== null) return true;
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return false;
  if (raw === OFFLINE_TEST_DATABASE_URL) return false;
  return true;
}

/**
 * Invalidiert den lokalen TTL-Cache sofort (z. B. nach `NOTIFY firm_control_changed`
 * oder vor einem erzwungenen Reload).
 */
export function invalidateAuthoritativeKillSwitchCache(): void {
  bumpEpoch();
  state.killSwitchDbCache.reset();
  state.killSwitchDbInFlight.reset();
}

function syncLocalLatchFromDb(armed: boolean, reason: string | null): void {
  if (armed) {
    const effectiveReason = reason ?? "KILL_SWITCH_ARMED";
    killSwitch.pull(effectiveReason);
    state.killSwitchSyncedFromDb.set(true);
  } else {
    killSwitch.disarm();
    state.killSwitchSyncedFromDb.set(false);
  }
}

async function queryLatestKillSwitchRow(): Promise<KillSwitchDbRow | null> {
  if (testDbReader) {
    return testDbReader();
  }
  const rows = await db
    .select({
      armed: killSwitches.armed,
      reason: killSwitches.reason,
    })
    .from(killSwitches)
    .orderBy(desc(killSwitches.createdAt), desc(killSwitches.id))
    .limit(1);
  if (!rows[0]) return null;
  return {
    armed: rows[0].armed === true,
    reason: rows[0].reason ?? null,
  };
}

/**
 * Liest den autoritativen Kill-Switch-Status aus PostgreSQL (mit <= 500 ms
 * TTL-Cache im Normalbetrieb) und synchronisiert das lokale `killSwitch`-Latch.
 *
 * Fail-Closed: Schlägt die DB-Abfrage bei konfigurierter Datenbank fehl, wird
 * `armed = true` mit `KILL_SWITCH_DB_UNAVAILABLE` zurückgegeben und lokal
 * gezogen.
 */
export async function readAuthoritativeKillSwitch(opts?: {
  env?: KillSwitchEnvLike;
  forceRefresh?: boolean;
  now?: number;
}): Promise<AuthoritativeKillSwitchStatus> {
  const env = opts?.env ?? process.env;
  const now = opts?.now ?? Date.now();

  if (!isKillSwitchDbConfigured(env)) {
    const armed = killSwitch.isArmed();
    return {
      armed,
      reason: armed ? "KILL_SWITCH_ARMED" : null,
      source: "memory-fallback",
      checkedAtMs: now,
    };
  }

  const epoch = currentEpoch();
  if (!opts?.forceRefresh) {
    const cached = state.killSwitchDbCache.get();
    if (
      cached &&
      cached.epoch === epoch &&
      now >= cached.status.checkedAtMs &&
      now - cached.status.checkedAtMs <= KILL_SWITCH_CACHE_TTL_MS
    ) {
      syncLocalLatchFromDb(cached.status.armed, cached.status.reason);
      return cached.status;
    }

    const inFlight = state.killSwitchDbInFlight.get();
    if (inFlight && inFlight.epoch === epoch) {
      return inFlight.promise;
    }
  }

  const epochAtStart = currentEpoch();
  let promise: Promise<AuthoritativeKillSwitchStatus> | undefined;
  promise = (async (): Promise<AuthoritativeKillSwitchStatus> => {
    try {
      const latest = await queryLatestKillSwitchRow();
      const checkedAtMs = opts?.now ?? Date.now();

      let armed: boolean;
      let reason: string | null;
      if (latest === null) {
        // Noch kein Eintrag in `kill_switches`: falls lokal nur wegen eines
        // früheren DB-Fehlers fail-closed gezogen war, nach erfolgreicher
        // DB-Verbindung wieder freigeben; manuellen lokalen Halt sonst achten.
        if (state.killSwitchSyncedFromDb.get()) {
          killSwitch.disarm();
          state.killSwitchSyncedFromDb.set(false);
        }
        armed = killSwitch.isArmed();
        reason = armed ? "KILL_SWITCH_ARMED" : null;
      } else {
        armed = latest.armed === true;
        reason = armed ? latest.reason ?? "KILL_SWITCH_ARMED" : null;
        syncLocalLatchFromDb(armed, reason);
      }

      const status: AuthoritativeKillSwitchStatus = {
        armed,
        reason,
        source: "db",
        checkedAtMs,
      };

      if (currentEpoch() === epochAtStart) {
        state.killSwitchDbCache.set({ status, epoch: epochAtStart });
      }
      return status;
    } catch (err) {
      const code = safeDbErrorCode(err);
      const reason = `KILL_SWITCH_DB_UNAVAILABLE: Kill-Switch-Abfrage in PostgreSQL fehlgeschlagen (${code}) — Order fail-closed blockiert.`;
      syncLocalLatchFromDb(true, reason);
      // Fehlerzustand bewusst NICHT als "armed: false" cachen; Cache löschen,
      // damit nach DB-Erholung sofort frisch gelesen wird.
      state.killSwitchDbCache.reset();
      return {
        armed: true,
        reason,
        source: "db-error",
        checkedAtMs: opts?.now ?? Date.now(),
      };
    } finally {
      const current = state.killSwitchDbInFlight.get();
      if (current && current.promise === promise) {
        state.killSwitchDbInFlight.reset();
      }
    }
  })();

  if (!opts?.forceRefresh) {
    state.killSwitchDbInFlight.set({ promise, epoch: epochAtStart });
  }
  return promise;
}

/**
 * Synchrone Auswertung für synchrone Gate-Aufrufer (`evaluateLiveOrder` in
 * `src/live-gate/enforcer.ts`):
 *   - Ohne konfigurierte DB (Offline-Unit-Tests): expliziter In-Memory-Fallback.
 *   - Mit konfigurierter DB + frischem TTL-Snapshot (<= 500 ms): DB-Wahrheit.
 *   - Mit konfigurierter DB ohne frischen Snapshot (kalt oder TTL abgelaufen):
 *     FAIL-CLOSED (`armed = true`), bis `readAuthoritativeKillSwitch()` den
 *     Zustand gegen PostgreSQL verifiziert hat.
 */
export function evaluateAuthoritativeKillSwitchSync(opts?: {
  env?: KillSwitchEnvLike;
  now?: number;
  triggerBackgroundRefresh?: boolean;
}): AuthoritativeKillSwitchStatus {
  const env = opts?.env ?? process.env;
  const now = opts?.now ?? Date.now();

  if (!isKillSwitchDbConfigured(env)) {
    const armed = killSwitch.isArmed();
    return {
      armed,
      reason: armed ? "KILL_SWITCH_ARMED" : null,
      source: "memory-fallback",
      checkedAtMs: now,
    };
  }

  const epoch = currentEpoch();
  const cached = state.killSwitchDbCache.get();
  if (
    cached &&
    cached.epoch === epoch &&
    now >= cached.status.checkedAtMs &&
    now - cached.status.checkedAtMs <= KILL_SWITCH_CACHE_TTL_MS
  ) {
    syncLocalLatchFromDb(cached.status.armed, cached.status.reason);
    return cached.status;
  }

  if (opts?.triggerBackgroundRefresh) {
    void readAuthoritativeKillSwitch({ env });
  }

  if (killSwitch.isArmed()) {
    return {
      armed: true,
      reason: "KILL_SWITCH_ARMED",
      source: "db",
      checkedAtMs: now,
    };
  }

  return {
    armed: true,
    reason:
      "KILL_SWITCH_DB_UNVERIFIED: Autoritativer Kill-Switch-Status aus PostgreSQL nicht frisch verifiziert (TTL <= 500 ms — fail-closed).",
    source: "cache-stale-fail-closed",
    checkedAtMs: now,
  };
}

/**
 * Aktualisiert den lokalen Prozess-Cache nach einem erfolgreichen Write in
 * `kill_switches` und benachrichtigt alle Nachbarprozesse über PostgreSQL
 * `NOTIFY firm_control_changed`.
 *
 * Best-Effort beim `pg_notify`: Schlägt der Notify-Befehl fehl (z. B. auf
 * einer Mock-DB im Offline-Test), bleibt die bereits persistierte Mutation
 * wirksam; andere Prozesse fallen spätestens nach `KILL_SWITCH_CACHE_TTL_MS`
 * (500 ms) auf einen frischen DB-Read zurück.
 */
export async function notifyFirmControlChanged(payload: {
  armed: boolean;
  reason?: string | null;
  source?: string;
}): Promise<void> {
  const nextEpoch = bumpEpoch();
  const reason = payload.armed ? payload.reason ?? "KILL_SWITCH_ARMED" : null;
  syncLocalLatchFromDb(payload.armed, reason);
  if (isKillSwitchDbConfigured()) {
    state.killSwitchDbCache.set({
      epoch: nextEpoch,
      status: {
        armed: payload.armed,
        reason,
        source: "db",
        checkedAtMs: Date.now(),
      },
    });
  } else {
    state.killSwitchDbCache.reset();
  }

  const message = JSON.stringify({
    kind: "kill_switch",
    armed: payload.armed,
    reason,
    source: payload.source ?? "firm",
    at: new Date().toISOString(),
  });

  try {
    const execFn = (db as unknown as { execute?: (q: unknown) => Promise<unknown> }).execute;
    if (typeof execFn === "function") {
      await db.execute(sql`SELECT pg_notify(${FIRM_CONTROL_CHANNEL}, ${message})`);
    }
  } catch {
    /* Best-Effort: TTL-Cache (<= 500 ms) sichert das Nachziehen auch ohne NOTIFY. */
  }
}

export interface FirmControlNotificationListenerOptions {
  initialRetryMs?: number;
  maxRetryMs?: number;
  log?: (level: "info" | "warn", message: string) => void;
  /** Optionaler Zusatz-Callback (z. B. für Tests oder Hydration-Invalidierung). */
  onInvalidated?: (payload: string | undefined) => void;
}

/**
 * Reconnecting PostgreSQL `LISTEN firm_control_changed`-Client (analog zu
 * `TradeRulesNotificationListener`). Invalidiert bei jedem Signal sofort den
 * lokalen Kill-Switch-TTL-Cache und stößt einen frischen DB-Read an; meldet
 * das Payload `armed: true`, wird `killSwitch` zusätzlich sofort synchron im
 * RAM gezogen (0-ms-Schutzrichtung), während ein Disarm immer erst durch die
 * DB-Abfrage bestätigt werden muss.
 */
export class FirmControlNotificationListener {
  private client: PoolClient | null = null;
  private handlers: {
    notification: (message: { channel?: string; payload?: string }) => void;
    error: (error: Error) => void;
    end: () => void;
  } | null = null;
  private connecting: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs: number;
  private stopped = true;

  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly log: NonNullable<FirmControlNotificationListenerOptions["log"]>;
  private readonly onInvalidated?: (payload: string | undefined) => void;

  constructor(
    private readonly pool: Pick<Pool, "connect">,
    options: FirmControlNotificationListenerOptions = {}
  ) {
    this.initialRetryMs = Math.max(1, Math.trunc(options.initialRetryMs ?? 1_000));
    this.maxRetryMs = Math.max(this.initialRetryMs, Math.trunc(options.maxRetryMs ?? 30_000));
    this.retryMs = this.initialRetryMs;
    this.log =
      options.log ??
      ((level, message) => console[level === "warn" ? "warn" : "log"](message));
    this.onInvalidated = options.onInvalidated;
  }

  /** Idempotent; löst nach aktivem `LISTEN` (oder geplantem Retry) auf. */
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
      this.detachHandlers(client);
      try {
        await client.query(`UNLISTEN ${FIRM_CONTROL_CHANNEL}`);
        client.release();
      } catch (error) {
        client.release(
          error instanceof Error
            ? error
            : new Error(`Unable to UNLISTEN ${FIRM_CONTROL_CHANNEL}`)
        );
      }
    }
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

      const notification = (message: { channel?: string; payload?: string }) => {
        if (message?.channel !== FIRM_CONTROL_CHANNEL) return;
        invalidateAuthoritativeKillSwitchCache();
        // Sichere Richtung sofort im RAM ziehen; Entschärfen immer erst nach
        // verifiziertem SELECT auf `kill_switches`.
        if (typeof message.payload === "string" && message.payload.length > 0) {
          try {
            const parsed = JSON.parse(message.payload) as {
              armed?: unknown;
              reason?: unknown;
            };
            if (parsed.armed === true) {
              const reason =
                typeof parsed.reason === "string" && parsed.reason.trim().length > 0
                  ? parsed.reason
                  : "KILL_SWITCH_ARMED";
              syncLocalLatchFromDb(true, reason);
            }
          } catch {
            /* Freitext-Payload ist zulässig — DB-Read unten entscheidet autoritativ. */
          }
        }
        void readAuthoritativeKillSwitch({ forceRefresh: true });
        try {
          this.onInvalidated?.(message.payload);
        } catch (error) {
          const errorName = error instanceof Error ? error.name : "UnknownError";
          this.log(
            "warn",
            `[kill-switch-db] onInvalidated-Callback fehlgeschlagen: ${errorName}`
          );
        }
      };
      const onError = (error: Error) => this.handleDisconnect(client!, error);
      const onEnd = () =>
        this.handleDisconnect(
          client!,
          new Error("PostgreSQL LISTEN connection ended")
        );

      this.client = client;
      this.handlers = { notification, error: onError, end: onEnd };
      attached = true;
      client.on("notification", notification);
      client.on("error", onError);
      client.on("end", onEnd);
      await client.query(`LISTEN ${FIRM_CONTROL_CHANNEL}`);

      if (this.stopped) {
        if (this.client === client) {
          this.client = null;
          this.detachAndRelease(client);
        }
        return;
      }
      this.retryMs = this.initialRetryMs;
      this.log("info", `[kill-switch-db] LISTEN ${FIRM_CONTROL_CHANNEL} aktiv`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error("UnknownError");
      if (client && attached && this.client === client) {
        this.client = null;
        this.detachAndRelease(client, err);
      } else if (client && !attached) {
        client.release(err);
      }
      if (!this.stopped) {
        this.log(
          "warn",
          `[kill-switch-db] LISTEN ${FIRM_CONTROL_CHANNEL} fehlgeschlagen: ${safeDbErrorCode(err)}`
        );
        this.scheduleRetry();
      }
    }
  }

  private handleDisconnect(client: PoolClient, error: Error): void {
    if (this.client !== client) return;
    this.client = null;
    this.detachAndRelease(client, error);
    invalidateAuthoritativeKillSwitchCache();
    if (!this.stopped) {
      this.log(
        "warn",
        `[kill-switch-db] LISTEN ${FIRM_CONTROL_CHANNEL} Verbindung verloren: ${safeDbErrorCode(error)}`
      );
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

/**
 * Startet den prozessweiten `LISTEN firm_control_changed`-Listener (idempotent,
 * no-op ohne konfigurierte Datenbank).
 */
export async function startFirmControlListener(
  options?: FirmControlNotificationListenerOptions
): Promise<FirmControlNotificationListener | null> {
  if (!isKillSwitchDbConfigured()) return null;
  if (!singletonListener) {
    singletonListener = new FirmControlNotificationListener(sharedPool, options);
  }
  await singletonListener.start();
  return singletonListener;
}

export async function stopFirmControlListener(): Promise<void> {
  const current = singletonListener;
  singletonListener = null;
  if (current) {
    await current.stop();
  }
}

// ── Test-Hooks (nur für deterministische Unit-/Integrationstests) ───────────

export function setKillSwitchDbReaderForTests(
  reader: KillSwitchDbReader | null
): void {
  testDbReader = reader;
  invalidateAuthoritativeKillSwitchCache();
}

export function setKillSwitchDbModeForTests(
  mode: "auto" | "db" | "memory"
): void {
  testDbMode = mode;
  invalidateAuthoritativeKillSwitchCache();
}

export function resetKillSwitchDbForTests(): void {
  testDbReader = null;
  testDbMode = "auto";
  invalidateAuthoritativeKillSwitchCache();
  state.killSwitchSyncedFromDb.reset();
}
