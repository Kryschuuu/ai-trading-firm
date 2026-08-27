/**
 * Gemeinsamer HTTP-Zugang für Feeds (Task 03) — Security-Regel 4.
 *
 *   - Feeds sind ausschließlich read-only (GET, `cache: "no-store"`).
 *   - SSRF-Schutz: der Ziel-Host muss in der Allowlist stehen. Fremde Hosts
 *     werden abgelehnt, bevor ein Request rausgeht. In Tests wird die
 *     Allowlist auf den lokalen Fixture-Server gesetzt (kein echtes Netz).
 *   - Timeout ist Pflicht (`feedTimeoutMs`, Standard 8000 ms).
 *   - Retry nur mit Backoff und hartem Limit (`maxRetries`), nie ungebremst.
 *   - Keine Credentials nötig (Public-Feeds).
 */
import { MarketDataError } from "./types";

/** Standard-Hosts, die Feeds kontaktieren dürfen (SSRF-Allowlist). */
export const DEFAULT_ALLOWED_FEED_HOSTS: readonly string[] = [
  "api.binance.com",
  "data-api.binance.vision",
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
];

export interface HttpOptions {
  /** Timeout je Versuch in ms (Pflicht, Standard 8000). */
  timeoutMs?: number;
  /** Maximale Versuche inkl. Erstversuch (Standard 1 → kein Retry). */
  maxRetries?: number;
  /** Basis-Backoff in ms (exponentiell, Standard 200). */
  baseBackoffMs?: number;
  /** SSRF-Allowlist (Hostnamen). Default: DEFAULT_ALLOWED_FEED_HOSTS. */
  allowedHosts?: readonly string[];
}

/** HTTP-Fehler mit Status und redigierter Meldung. */
export class FeedHttpError extends MarketDataError {
  constructor(
    readonly host: string,
    readonly status: number | "FETCH" | "TIMEOUT" | "BLOCKED",
    message: string
  ) {
    super("FEED_HTTP", message);
    this.host = host;
    this.status = status;
  }
}

function hostOf(url: URL): string {
  return url.hostname;
}

/** Prüft, ob ein Host in der Allowlist steht (SSRF). Wirft bei Fremd-Host. */
export function assertHostAllowed(
  url: URL,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_FEED_HOSTS
): void {
  const host = hostOf(url);
  if (!allowedHosts.includes(host)) {
    throw new FeedHttpError(
      host,
      "BLOCKED",
      `Host "${host}" steht nicht in der Feed-Allowlist (SSRF-Schutz)`
    );
  }
}

/**
 * Read-only JSON-Request mit Timeout, SSRF-Allowlist und begrenztem
 * Retry/Backoff. Wirft `FeedHttpError` bei Fehlern — Feeds fangen das und
 * delegieren an die Failover-Kette.
 */
export async function httpGetJson<T>(
  urlInput: string,
  opts: HttpOptions = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRetries = Math.max(1, opts.maxRetries ?? 1);
  const baseBackoffMs = opts.baseBackoffMs ?? 200;
  const allowedHosts = opts.allowedHosts ?? DEFAULT_ALLOWED_FEED_HOSTS;

  const url = new URL(urlInput);
  const host = hostOf(url);
  assertHostAllowed(url, allowedHosts);

  let lastError: unknown = new Error("no attempt");
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = baseBackoffMs * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        signal: ctrl.signal,
        cache: "no-store",
        redirect: "error", // kein Follow — verhindert Redirect-Abfluss an Fremd-Hosts
      });
      if (!res.ok) {
        throw new FeedHttpError(
          host,
          res.status,
          `HTTP ${res.status} von ${host}`
        );
      }
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof FeedHttpError) {
        lastError = e;
      } else if (e instanceof Error && e.name === "AbortError") {
        lastError = new FeedHttpError(host, "TIMEOUT", `Timeout nach ${timeoutMs} ms`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        lastError = new FeedHttpError(host, "FETCH", `Fetch-Fehler von ${host}: ${msg.slice(0, 120)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
