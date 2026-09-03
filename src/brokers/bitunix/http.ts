/**
 * HTTP-Transport für den Bitunix-Adapter (Task 07).
 *
 *   - TLS erzwungen (https); http nur Loopback + explizites Test-Flag
 *   - Zertifikatsprüfung: Node-Default (an)
 *   - Host-Allowlist (SSRF)
 *   - Timeouts + begrenzter Retry/Backoff
 *   - Token-Bucket Rate-Limiter
 *   - redirect: error
 */
import { BitunixAmbiguousError, BitunixApiError, classifyBitunixFailure, safeSnippet } from "./errors";
import { BITUNIX_MAX_RESPONSE_BYTES } from "./config";
import type { BitunixRuntimeConfig } from "./config";
import type { BitunixLogger } from "./redactor";
import { createBitunixLogger, redactBitunix } from "./redactor";

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

export interface BitunixHttpOptions {
  config: BitunixRuntimeConfig;
  logger?: BitunixLogger;
  secrets?: () => readonly string[];
  fetchImpl?: typeof fetch;
  bucket?: TokenBucket;
}

export interface BitunixHttpRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: string;
  headers?: Record<string, string>;
  signed?: boolean;
  /**
   * Retry-Semantik. Default: GET = idempotent (Retry erlaubt), POST = NICHT
   * idempotent. Für nicht-idempotente Requests (z. B. place_order) wird bei
   * jedem ambivalenten Ausgang (HTTP 429, Timeout, Netzwerkfehler, 5xx) NICHT
   * automatisch wiederholt — die Venue könnte die Order bereits verarbeitet
   * haben (Doppel-Order-Gefahr). Stattdessen wird ein `BitunixAmbiguousError`
   * (kind "ambiguous") nach oben gereicht; der Aufrufer muss VOR einem
   * erneuten Senden per `clientOrderId` den echten Status abfragen.
   */
  idempotent?: boolean;
}

export interface BitunixHttpResponse {
  status: number;
  json: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parst die Ziel-URL, prüft Schema/Host (SSRF) und gibt die kanonische URL.
 */
export function assertUrlAllowed(
  raw: string,
  cfg: BitunixRuntimeConfig
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BitunixApiError("ssrf", "Bitunix-URL ist ungültig (SSRF-Schutz).");
  }
  if (url.username || url.password) {
    throw new BitunixApiError("ssrf", "Bitunix-URL mit Userinfo abgelehnt (SSRF-Schutz).");
  }
  const host = url.hostname.toLowerCase();
  const allowed = cfg.allowedHosts.map((h) => h.toLowerCase());
  if (!allowed.includes(host)) {
    throw new BitunixApiError(
      "ssrf",
      `Host "${safeSnippet(host, 40)}" steht nicht auf der Bitunix-Allowlist (SSRF-Schutz).`
    );
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && cfg.allowInsecureHttp && LOOPBACK.has(host)) {
    return url;
  }
  throw new BitunixApiError(
    "ssrf",
    `Schema "${url.protocol}" ist nicht erlaubt (TLS erzwungen, außer Loopback-Tests).`
  );
}

function buildUrl(
  base: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> | undefined,
  cfg: BitunixRuntimeConfig
): URL {
  const joined = path.startsWith("http") ? path : `${base.replace(/\/+$/, "")}${path}`;
  const url = new URL(joined);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }
  return assertUrlAllowed(url.toString(), cfg);
}

export class BitunixHttp {
  private readonly cfg: BitunixRuntimeConfig;
  private readonly logger: BitunixLogger;
  private readonly secrets: () => readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly bucket: TokenBucket;

  constructor(opts: BitunixHttpOptions) {
    this.cfg = opts.config;
    this.secrets = opts.secrets ?? (() => []);
    this.logger = opts.logger ?? createBitunixLogger(this.secrets);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.bucket = opts.bucket ?? new TokenBucket(opts.config.publicRatePerSec, opts.config.publicRatePerSec);
  }

  async request(req: BitunixHttpRequest): Promise<BitunixHttpResponse> {
    const url = buildUrl(this.cfg.restBaseUrl, req.path, req.query, this.cfg);
    // Nicht-idempotente Requests (Default für POST) dürfen bei ambivalenten
    // Fehlern (Timeout/Netzwerk/5xx/429) NICHT automatisch wiederholt werden —
    // Doppel-Order-Gefahr. Stattdessen reicht der Transport einen
    // `BitunixAmbiguousError` nach oben; der Aufrufer (privateClient) muss
    // VOR einem erneuten Senden per clientOrderId den Status abfragen (H4).
    const idempotent = req.idempotent ?? req.method === "GET";
    const max = Math.max(1, this.cfg.retryMax);
    let last: BitunixApiError | null = null;

    for (let attempt = 0; attempt < max; attempt++) {
      if (attempt > 0) {
        await sleep(this.cfg.timeoutMs > 0 ? Math.min(200 * 2 ** (attempt - 1), 2000) : 0);
      }
      await this.bucket.take();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Accept: "application/json",
          language: "en-US",
          ...(req.headers ?? {}),
        };
        if (req.body) headers["Content-Type"] = "application/json";
        const res = await this.fetchImpl(url.toString(), {
          method: req.method,
          headers,
          body: req.method === "POST" ? req.body ?? "" : undefined,
          signal: ctrl.signal,
          cache: "no-store",
          redirect: "error",
        });
        const text = await readCapped(res, BITUNIX_MAX_RESPONSE_BYTES);
        let json: unknown = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (res.status === 401 || res.status === 403) {
          const classified = classifyBitunixFailure({
            httpStatus: res.status,
            venueCode: readCode(json),
          });
          throw new BitunixApiError(classified.kind, classified.message, {
            httpStatus: res.status,
            venueCode: readCode(json),
          });
        }
        if (res.status === 429 || res.status >= 500) {
          const classified = classifyBitunixFailure({ httpStatus: res.status, venueMsg: readMsg(json) });
          last = new BitunixApiError(classified.kind, classified.message, {
            httpStatus: res.status,
            venueCode: readCode(json),
          });
          // Idempotent (GET) → Retry. Nicht-idempotent (POST, place_order) →
          // NIE blind wiederholen: die Anfrage KÖNNTE serverseitig angekommen
          // sein. Stattdessen ambivalenten Fehler nach oben (privateClient
          // muss vor einem erneuten Senden per clientOrderId den Status
          // abfragen — H4-Idempotenz).
          if (idempotent) continue;
          throw new BitunixAmbiguousError(classified.message, {
            httpStatus: res.status,
            venueCode: readCode(json),
          });
        }
        if (!res.ok) {
          const classified = classifyBitunixFailure({
            httpStatus: res.status,
            venueCode: readCode(json),
            venueMsg: readMsg(json),
          });
          throw new BitunixApiError(classified.kind, classified.message, {
            httpStatus: res.status,
            venueCode: readCode(json),
          });
        }
        return { status: res.status, json };
      } catch (e) {
        if (e instanceof BitunixApiError) {
          if (e.kind === "auth" || e.kind === "permission" || e.kind === "ssrf" || e.kind === "payload") throw e;
          last = e;
          // Bereits als "ambiguous" markiert → direkt weiterreichen.
          if (e.kind === "ambiguous") throw e;
          // Idempotenter Pfad: rate-limit/maintenance/unknown wiederholen.
          if (idempotent) {
            if (e.kind === "rate-limit") continue;
            if (e.kind === "maintenance" || e.kind === "unknown") continue;
            throw e;
          }
          // Nicht-idempotenter Pfad: nur AMBIVALENTE Ausgänge (429/5xx/
          // Timeout/Netz/maintenance/rate-limit) werden als "ambiguous"
          // markiert. Definitiv abgelehnte 4xx (z. B. 400 Validierung) sind
          // NICHT ambivalent — kein Status-Query, kein Retry.
          if (e.httpStatus != null && e.httpStatus < 500 && e.httpStatus !== 429) {
            throw e;
          }
          throw new BitunixAmbiguousError(e.message, {
            httpStatus: e.httpStatus,
            venueCode: e.venueCode,
          });
        }
        if (e instanceof Error && e.name === "AbortError") {
          last = new BitunixApiError("unknown", `Bitunix-Timeout nach ${this.cfg.timeoutMs} ms.`);
          // Timeout ist ambivalent — nicht-idempotente Requests reichen einen
          // "ambiguous"-Fehler nach oben (kein blindes erneutes Senden).
          if (idempotent) continue;
          throw new BitunixAmbiguousError(last.message, { httpStatus: null, venueCode: null });
        }
        const msg = redactBitunix(e instanceof Error ? e.message : String(e), this.secrets());
        last = new BitunixApiError("unknown", `Bitunix-Netzwerkfehler: ${msg.slice(0, 80)}`);
        // Netzwerkabbruch ist ambivalent — dito.
        if (idempotent) continue;
        throw new BitunixAmbiguousError(last.message, { httpStatus: null, venueCode: null });
      } finally {
        clearTimeout(timer);
      }
    }
    throw last ?? new BitunixApiError("unknown", "Bitunix-Request fehlgeschlagen.");
  }
}

function readCode(json: unknown): number | null {
  if (json && typeof json === "object" && "code" in json) {
    const n = Number((json as { code: unknown }).code);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readMsg(json: unknown): string | null {
  if (json && typeof json === "object" && "msg" in json) {
    const m = (json as { msg: unknown }).msg;
    return typeof m === "string" ? m : null;
  }
  return null;
}

export { buildUrl };

/**
 * Liest den Response-Text mit harter Byte-Kappe.
 *
 * `content-length` dient als Vorabfilter (spart die Übertragung klar zu großer
 * Antworten); die Kappe selbst wird am Stream durchgesetzt, damit eine
 * Chunked-Response sie nicht umgeht. Überschreitung ist kein Retry-Kandidat —
 * sonst würde ein über großer Payload die Venue dauerhaft blockieren.
 */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers?.get?.("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && maxBytes > 0 && declared > maxBytes) {
    // `payload` ist bewusst KEIN Retry-Kind: eine zu große Antwort bleibt zu
    // groß und würde die Venue sonst dauerhaft blockieren.
    throw new BitunixApiError("payload", `Antwortgröße ${declared} Bytes über der Kappe von ${maxBytes} Bytes`);
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
      throw new BitunixApiError("payload", `Antwortgröße überschreitet die Kappe von ${maxBytes} Bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
}
