/**
 * Gemeinsamer HTTP-Client der Sync-Venue-Adapter (BINANCE, KRAKEN, ALPACA/IBKR
 * via Yahoo, PAPER als Spiegel).
 *
 * Warum eine eigene Schicht statt der Broker-HTTP-Clients: Der Sync braucht
 * einen credential-freien Bulk-/Backfill-Pfad (Discovery, Bulk-Ticker, Klines)
 * mit deterministischem Retry nur für idempotente GETs — die Broker-Clients
 * (`src/brokers/<venue>/http.ts`) tragen Signatur-/Order-Semantik (Ambiguity,
 * Idempotenz-Schutz), die hier falsch wäre. Umgekehrt fassen die
 * Low-Latency-Feeds (`feeds/binance`, `feeds/yahoo`) nur Einzelsymbole an;
 * sie kennen kein Discovery/Backfill und bleiben unberührt.
 *
 * Kontrakt:
 *   - Nur GET, nur JSON. Kein Body, keine Credentials, keine Signatur.
 *   - SSRF-Schutz: Host-Allowlist (Default: genau der `baseUrl`-Host),
 *     nur `https` — `http` ausschließlich für Loopback (Fixture-Server in
 *     Tests). Keine Userinfo, keine Redirects (`redirect: "error"`).
 *   - Retry mit Backoff ausschließlich für idempotente GETs bei
 *     429/5xx/Netzwerk/Timeout (`maxAttempts`, Default 3). 4xx außer 429
 *     wirft sofort (kein Retry auf Client-Fehler). `Retry-After` bei 429
 *     wird respektiert (gedeckelt).
 *   - Fehler sind immer typisiert (`MarketDataHttpError` mit Status,
 *     `MarketDataTimeoutError`, `MarketDataSchemaError` mit `.cause`-Kette),
 *     damit `classifyMarketDataError` sie ehrlich einordnen kann. Meldungen
 *     tragen nur den Host, nie die volle URL (Query enthält Symbole).
 *   - Token-Bucket (`limiter`) wird VOR jedem Versuch genommen — auch vor
 *     Retries. Kein Request umgeht die Drossel.
 */

import {
  MarketDataHttpError,
  MarketDataSchemaError,
  MarketDataTimeoutError,
  type MarketDataErrorReason,
} from "../../lib/marketDataErrors";

/** Struktureller Limiter-Kontrakt — `TokenBucket`-kompatibel. */
export interface SyncHttpLimiter {
  take(): Promise<void>;
}

export interface SyncHttpClientOptions {
  /** Basis-URL der Venue-API, z. B. `https://api.binance.com`. */
  baseUrl: string;
  /**
   * Erlaubte Hosts (Default: genau der Host aus `baseUrl`). Jede angefragte
   * URL außerhalb der Liste wirft — auch Redirects würden hier scheitern,
   * sie sind zusätzlich per `redirect: "error"` verboten.
   */
  allowedHosts?: readonly string[];
  /** Timeout je Versuch in ms (Default 10_000). */
  timeoutMs?: number;
  /** Versuche gesamt (Default 3 = 1 + 2 Retries bei retrybaren Ursachen). */
  maxAttempts?: number;
  /** Backoff-Basis in ms (Default 250; Versuch n wartet `base × 2^(n-1)`). */
  backoffBaseMs?: number;
  /** Max. Response-Größe in Bytes (Default 5 MiB, Payload-Schutz). */
  maxResponseBytes?: number;
  /** Token-Bucket der Venue (pflicht in Produktion, optional in Tests). */
  limiter?: SyncHttpLimiter;
  /** Feste Header (z. B. `User-Agent` für Yahoo). */
  headers?: Record<string, string>;
  /** Injizierbares `fetch` (Tests: Fixture-Server oder Stub). */
  fetchImpl?: typeof fetch;
  /** Injizierbarer Sleep (Tests: kein reales Warten). */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Deckel für `Retry-After` (s): Die Venue darf den Sync nicht minutenlang parken. */
const MAX_RETRY_AFTER_MS = 10_000;

/** Nur der Host in Fehlermeldungen — nie Pfad/Query (Symbole, keine Secrets). */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "venue";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Baut einen `Error` mit Taxonomie-`code`. Für Venue-Umschlag-Fehler ohne
 * HTTP-Status (z. B. Kraken `{ error: [...] }` bei HTTP 200) und für
 * Adapter-seitige Symbolfehler — `classifyMarketDataError` übernimmt einen
 * `code`, der exakt einer Taxonomie-Klasse entspricht, direkt.
 */
export function taggedSyncError(code: MarketDataErrorReason, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** GET-Client für öffentliche Venue-JSON-Endpunkte (siehe Modulkopf). */
export class SyncHttpClient {
  private readonly baseUrl: string;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxResponseBytes: number;
  private readonly limiter: SyncHttpLimiter | undefined;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SyncHttpClientOptions) {
    if (!options || typeof options.baseUrl !== "string" || !options.baseUrl) {
      throw new Error("SyncHttpClient: baseUrl ist Pflicht.");
    }
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new Error("SyncHttpClient: baseUrl ist keine gültige URL.");
    }
    assertPublicScheme(base);
    if (base.username || base.password) {
      throw new Error("SyncHttpClient: baseUrl darf keine Credentials enthalten.");
    }
    this.baseUrl = base.toString().replace(/\/+$/, "");
    const hosts = options.allowedHosts ?? [base.host];
    if (hosts.length === 0) {
      throw new Error("SyncHttpClient: allowedHosts darf nicht leer sein.");
    }
    this.allowedHosts = new Set(hosts.map((h) => h.toLowerCase()));
    this.timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxAttempts = positiveInt(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.backoffBaseMs = positiveInt(options.backoffBaseMs, DEFAULT_BACKOFF_BASE_MS, "backoffBaseMs");
    this.maxResponseBytes = positiveInt(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maxResponseBytes");
    this.limiter = options.limiter;
    this.headers = { Accept: "application/json", ...options.headers };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * GET + JSON-Parse gegen `baseUrl + path`.
   *
   * @param path Pfad ab `/` (muss mit `/` beginnen — kein Host-Wechsel über
   *   absolute URLs möglich).
   * @param query Query-Parameter (Werte werden encodiert; `undefined` fällt
   *   weg). Formatierung komplexer Werte (Kommalisten, JSON-Arrays) liegt
   *   beim Aufrufer — der Client encodiert nur.
   */
  async getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = this.buildUrl(path, query);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.limiter) await this.limiter.take();
      try {
        // eslint-disable-next-line no-await-in-loop -- sequenzieller Retry ist beabsichtigt.
        return await this.fetchOnce<T>(url);
      } catch (err) {
        lastErr = err;
        const waitMs = this.retryWaitMs(err, attempt);
        if (waitMs === null) throw err;
        // eslint-disable-next-line no-await-in-loop -- Backoff zwischen den Versuchen.
        await this.sleep(waitMs);
      }
    }
    throw lastErr;
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error("SyncHttpClient: path muss mit / beginnen.");
    }
    const url = new URL(path, `${this.baseUrl}/`);
    if (!this.allowedHosts.has(url.host.toLowerCase())) {
      throw new Error(`SyncHttpClient: Host ${safeHost(url.toString())} nicht in der Allowlist.`);
    }
    assertPublicScheme(url);
    if (url.username || url.password) {
      throw new Error("SyncHttpClient: URL darf keine Credentials enthalten.");
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        url.searchParams.append(key, value);
      }
    }
    return url.toString();
  }

  private async fetchOnce<T>(url: string): Promise<T> {
    const host = safeHost(url);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (isTimeoutAbort(err)) {
        throw new MarketDataTimeoutError(`GET ${host} nach ${this.timeoutMs} ms`);
      }
      throw err;
    }
    if (!res.ok) {
      const httpErr = new MarketDataHttpError(res.status, host);
      if (res.status === 429) {
        // `Retry-After` (s) wird respektiert (gedeckelt in `retryWaitMs`).
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== null) {
          (httpErr as unknown as { retryAfterMs?: number }).retryAfterMs = retryAfter;
        }
      }
      throw httpErr;
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (isTimeoutAbort(err)) {
        throw new MarketDataTimeoutError(`GET ${host} (Body) nach ${this.timeoutMs} ms`);
      }
      throw err;
    }
    if (text.length > this.maxResponseBytes) {
      throw new MarketDataSchemaError(
        `GET ${host}: Antwort ${text.length} Bytes über der Payload-Kappe ${this.maxResponseBytes} (nicht erneut angefragt).`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      // `.cause`-Kette: Der Original-Parse-Fehler bleibt für die
      // Klassifikation erhalten (SyntaxError in der Kette ⇒ SCHEMA_MISMATCH).
      throw Object.assign(
        new MarketDataSchemaError(`GET ${host}: Antwort ist kein gültiges JSON.`),
        { cause: err },
      );
    }
  }

  /**
   * Backoff vor dem nächsten Versuch — oder `null` (nicht retrybar / keine
   * Versuche übrig). Retrybar: 429/5xx, Timeout, Netzwerk-/Abort-Fehler ohne
   * HTTP-Status. NIEMALS 4xx außer 429 (Client-Fehler) und niemals
   * Schema-Fehler (ein Retry lieferte dieselbe unbrauchbare Antwort).
   */
  private retryWaitMs(err: unknown, attempt: number): number | null {
    if (attempt >= this.maxAttempts) return null;
    if (err instanceof MarketDataSchemaError) return null;
    if (err instanceof MarketDataHttpError) {
      if (err.httpStatus === 429) {
        return Math.max(this.backoffBaseMs * 2 ** (attempt - 1), this.retryAfterMs(err));
      }
      if (err.httpStatus >= 500 && err.httpStatus <= 599) {
        return this.backoffBaseMs * 2 ** (attempt - 1);
      }
      return null;
    }
    // Timeout- und Netzwerkfehler (inkl. Loopback-Fixture-Abbrüche): retrybar.
    return this.backoffBaseMs * 2 ** (attempt - 1);
  }

  /** `Retry-After` (s) aus einem 429-Fehler, gedeckelt — sonst 0. */
  private retryAfterMs(err: MarketDataHttpError): number {
    const raw = (err as unknown as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.min(raw, MAX_RETRY_AFTER_MS);
    }
    return 0;
  }
}

/** `AbortSignal.timeout()` bricht mit `TimeoutError` ab (kein manueller Abort hier). */
function isTimeoutAbort(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * `https` überall; `http` nur für Loopback (Fixture-Server der Tests).
 * Jede andere Kombination wirft — auch aus `buildUrl` (Abwehr, falls eine
 * Venue je Pfad ein anderes Schema liefern wollte).
 */
function assertPublicScheme(url: URL): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return;
  throw new Error(`SyncHttpClient: Schema ${url.protocol} nicht erlaubt (nur https, http nur für Loopback).`);
}

/** `Retry-After` (Delta-Sekunden) → ms; HTTP-Datum/Unsinn ⇒ null. */
function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`SyncHttpClient: ${name} muss eine positive Ganzzahl sein.`);
  }
  return value;
}
