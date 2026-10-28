/**
 * HTTP-Transport für den Alpaca-Adapter (Task 12).
 *
 *   - TLS erzwungen (https); http nur Loopback + explizites Test-Flag
 *   - Zertifikatsprüfung: Node-Default (an)
 *   - Host-Allowlist (SSRF)
 *   - Timeouts + begrenzter Retry/Backoff
 *   - Token-Bucket Rate-Limiter
 *   - redirect: error
 *   - Basic-Auth aus Credentials beim Senden
 */
import { AlpacaApiError, classifyAlpacaFailure, safeSnippet } from "./errors";
import { ALPACA_MAX_RESPONSE_BYTES, ALPACA_RETRY_BASE_MS } from "./config";
import type { AlpacaRuntimeConfig } from "./config";
import type { AlpacaLogger } from "./redactor";
import { createAlpacaLogger, redactAlpaca } from "./redactor";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number
  ) {
    this.tokens = burst;
  }

  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / Math.max(this.ratePerSec, 0.001)) * 1000);
      await sleep(Math.min(Math.max(waitMs, 10), 2000));
    }
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
  }
}

export interface AlpacaHttpOptions {
  config: AlpacaRuntimeConfig;
  logger?: AlpacaLogger;
  secrets?: () => readonly string[];
  fetchImpl?: typeof fetch;
  bucket?: TokenBucket;
  /** Obergrenze für Retry-After und exponentiellen Backoff (Default: 10 s). */
  maxRetryDelayMs?: number;
  /** Basis für den exponentiellen Backoff (Default: ALPACA_RETRY_BASE_MS). */
  retryBaseDelayMs?: number;
  /** In Tests injizierbare Wartefunktion; Produktion verwendet setTimeout. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface AlpacaHttpRequest {
  method: "GET" | "POST" | "DELETE" | "PATCH";
  /** Basis-URL (z. B. tradeBaseUrl oder dataBaseUrl). */
  base: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: string;
  headers?: Record<string, string>;
  /**
   * Kompatibilitäts-Hinweis für Call-Sites. Die Retry-Sicherheit wird
   * unabhängig davon aus Methode und Body bestimmt: GET/DELETE sind sicher,
   * POST nur mit nicht-leerem `client_order_id` im JSON-Body. Ein `true` kann
   * unsichere POST-/PATCH-Retries nicht freischalten.
   */
  idempotent?: boolean;
}

export interface AlpacaHttpResponse {
  status: number;
  json: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

/** Nur der Alpaca-Body-Key ist ein belastbarer POST-Idempotenzbeleg. */
function hasClientOrderId(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const id = (parsed as Record<string, unknown>).client_order_id;
    return typeof id === "string" && id.trim().length > 0;
  } catch {
    return false;
  }
}

/** Retry-Policy auf den tatsächlichen Request begrenzen, nicht auf Caller-Hints. */
function isSafeToRetryAmbiguousFailure(req: AlpacaHttpRequest): boolean {
  if (req.method === "GET" || req.method === "DELETE") return true;
  return req.method === "POST" && hasClientOrderId(req.body);
}

/**
 * `Retry-After` als Delta-Sekunden (inkl. Dezimalwert) oder HTTP-Datum.
 * Ungültige Werte liefern null; gültige Werte werden sofort begrenzt.
 */
function retryAfterDelayMs(value: string | null, nowMs: number, maxDelayMs: number): number | null {
  const raw = value?.trim();
  if (!raw) return null;

  let delayMs: number;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    delayMs = Number.isFinite(seconds) ? seconds * 1000 : maxDelayMs;
  } else {
    const dateMs = Date.parse(raw);
    if (!Number.isFinite(dateMs)) return null;
    delayMs = dateMs - nowMs;
  }
  if (!Number.isFinite(delayMs)) return maxDelayMs;
  return Math.min(maxDelayMs, Math.max(0, delayMs));
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Parst die Ziel-URL, prüft Schema/Host (SSRF) und gibt die kanonische URL.
 */
export function assertUrlAllowed(
  raw: string,
  cfg: AlpacaRuntimeConfig
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AlpacaApiError("ssrf", "Alpaca-URL ist ungültig (SSRF-Schutz).");
  }
  if (url.username || url.password) {
    throw new AlpacaApiError("ssrf", "Alpaca-URL mit Userinfo abgelehnt (SSRF-Schutz).");
  }
  const host = url.hostname.toLowerCase();
  const allowed = cfg.allowedHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(host)) {
    throw new AlpacaApiError(
      "ssrf",
      `Host "${safeSnippet(host, 40)}" steht nicht auf der Alpaca-Allowlist (SSRF-Schutz).`
    );
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && cfg.allowInsecureHttp && LOOPBACK.has(host)) {
    return url;
  }
  throw new AlpacaApiError(
    "ssrf",
    `Schema "${url.protocol}" ist nicht erlaubt (TLS erzwungen, außer Loopback-Tests).`
  );
}

function buildUrl(
  base: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> | undefined
): string {
  const joined = path.startsWith("http") ? path : `${base.replace(/\/+$/, "")}${path}`;
  const url = new URL(joined);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * HTTP-Client für Alpaca. Sendet automatisch Basic-Auth, sofern `auth`
 * injiziert wurde (Credentials werden NICHT im Adapter-Header sichtbar).
 */
export class AlpacaHttp {
  private readonly config: AlpacaRuntimeConfig;
  private readonly logger: AlpacaLogger;
  private readonly secrets: () => readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly bucket: TokenBucket;
  private readonly maxRetryDelayMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: AlpacaHttpOptions) {
    this.config = opts.config;
    this.secrets = opts.secrets ?? (() => []);
    this.logger = opts.logger ?? createAlpacaLogger(this.secrets);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.bucket = opts.bucket ?? new TokenBucket(opts.config.publicRatePerSec, opts.config.publicRatePerSec);
    this.maxRetryDelayMs = normalizeDelay(opts.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS);
    this.retryBaseDelayMs = normalizeDelay(opts.retryBaseDelayMs, ALPACA_RETRY_BASE_MS);
    this.sleepImpl = opts.sleepImpl ?? sleep;
  }

  private backoffDelayMs(attempt: number): number {
    const exponent = Math.min(Math.max(0, attempt), 30);
    return Math.min(this.maxRetryDelayMs, this.retryBaseDelayMs * 2 ** exponent);
  }

  async request(req: AlpacaHttpRequest): Promise<AlpacaHttpResponse> {
    const url = assertUrlAllowed(buildUrl(req.base, req.path, req.query), this.config);
    const retrySafe = isSafeToRetryAmbiguousFailure(req);
    const max = Math.max(1, Math.floor(this.config.retryMax));
    let last: AlpacaApiError | null = null;
    let nextRetryDelayMs: number | null = null;

    for (let attempt = 0; attempt < max; attempt++) {
      if (attempt > 0) {
        const delay = nextRetryDelayMs ?? this.backoffDelayMs(attempt - 1);
        nextRetryDelayMs = null;
        if (delay > 0) await this.sleepImpl(delay);
      }
      await this.bucket.take();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.config.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
          ...(req.headers ?? {}),
        };
        if (req.body) headers["Content-Type"] = "application/json";
        const res = await this.fetchImpl(url.toString(), {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "DELETE" ? undefined : req.body ?? "",
          signal: ctrl.signal,
          cache: "no-store",
          redirect: "error",
        });
        const text = await readCapped(res, ALPACA_MAX_RESPONSE_BYTES);
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (res.status === 401 || res.status === 403) {
          const classified = classifyAlpacaFailure({
            httpStatus: res.status,
            venueCode: readCode(json),
            venueMsg: readMsg(json),
          });
          throw new AlpacaApiError(classified.kind, classified.message, {
            httpStatus: res.status,
            venueCode: readCode(json),
          });
        }
        if (res.status === 429 || res.status >= 500) {
          const classified = classifyAlpacaFailure({
            httpStatus: res.status,
            venueCode: readCode(json),
            venueMsg: readMsg(json),
          });
          last = new AlpacaApiError(classified.kind, classified.message, {
            httpStatus: res.status,
            venueCode: readCode(json),
          });

          // 429 ist eine explizite Ablehnung und daher unabhängig von Methode
          // und Idempotenz sicher wiederholbar. 5xx ist ambivalent: Nur GET,
          // DELETE oder POST mit client_order_id im Body dürfen automatisch
          // wiederholt werden.
          const mayRetry = res.status === 429 || retrySafe;
          if (mayRetry && attempt + 1 < max) {
            const serverDelay =
              res.status === 429 || res.status === 503
                ? retryAfterDelayMs(res.headers.get("retry-after"), Date.now(), this.maxRetryDelayMs)
                : null;
            nextRetryDelayMs = serverDelay ?? this.backoffDelayMs(attempt);
            continue;
          }
          throw last;
        }
        if (!res.ok) {
          const classified = classifyAlpacaFailure({
            httpStatus: res.status,
            venueCode: readCode(json),
            venueMsg: readMsg(json),
          });
          throw new AlpacaApiError(classified.kind, classified.message, {
            httpStatus: res.status,
            venueCode: readCode(json),
          });
        }
        return { status: res.status, json };
      } catch (e) {
        if (e instanceof AlpacaApiError) {
          if (e.kind === "auth" || e.kind === "permission" || e.kind === "ssrf" || e.kind === "validation") throw e;
          last = e;
          if (e.kind === "rate-limit" && attempt + 1 < max) {
            nextRetryDelayMs = this.backoffDelayMs(attempt);
            continue;
          }
          if (
            (e.kind === "maintenance" || e.kind === "unknown") &&
            retrySafe &&
            attempt + 1 < max
          ) {
            nextRetryDelayMs = this.backoffDelayMs(attempt);
            continue;
          }
          throw e;
        }
        if (e instanceof Error && e.name === "AbortError") {
          last = new AlpacaApiError("unknown", `Alpaca-Timeout nach ${this.config.timeoutMs} ms.`);
          if (retrySafe && attempt + 1 < max) {
            nextRetryDelayMs = this.backoffDelayMs(attempt);
            continue;
          }
          throw last;
        }
        const msg = redactAlpaca(e instanceof Error ? e.message : String(e), this.secrets());
        last = new AlpacaApiError("unknown", `Alpaca-Netzwerkfehler: ${msg.slice(0, 80)}`);
        if (retrySafe && attempt + 1 < max) {
          nextRetryDelayMs = this.backoffDelayMs(attempt);
          continue;
        }
        throw last;
      } finally {
        clearTimeout(timer);
      }
    }
    throw last ?? new AlpacaApiError("unknown", "Alpaca-Request fehlgeschlagen.");
  }
}

function readCode(json: unknown): string | null {
  if (json && typeof json === "object" && "code" in json) {
    const v = (json as { code: unknown }).code;
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    return null;
  }
  return null;
}

function readMsg(json: unknown): string | null {
  if (json && typeof json === "object" && "message" in json) {
    const m = (json as { message: unknown }).message;
    return typeof m === "string" ? m : null;
  }
  return null;
}

/** Hilfsfunktion: Basic-Auth-Header aus Klartext-Credentials. */
export function basicAuthHeader(key: string, secret: string): string {
  const token = Buffer.from(`${key}:${secret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

/**
 * Liest den Response-Text mit harter Byte-Kappe.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && maxBytes > 0 && declared > maxBytes) {
    throw new AlpacaApiError("payload", `Antwortgröße ${declared} Bytes über der Kappe von ${maxBytes} Bytes`);
  }
  if (!res.body || !(maxBytes > 0)) return await res.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* Stream bereits geschlossen */
      }
      throw new AlpacaApiError("payload", `Antwortgröße überschreitet die Kappe von ${maxBytes} Bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
}
