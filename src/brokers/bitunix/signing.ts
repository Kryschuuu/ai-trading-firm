/**
 * Bitunix-Request-Signatur (Task 07).
 *
 * Offizielle Formel (REST, https://www.bitunix.com/api-docs/futures/common/sign.html):
 *
 *   1. queryParams: Keys ASCII-aufsteigend, Konkatenation `key + value`
 *      ohne Trenner und ohne `=`/`&` (Beispiel: `id1uid200`).
 *   2. body: JSON **ohne Spaces**, identisch zum gesendeten Body.
 *   3. digest = SHA256_hex(nonce + timestamp + api-key + queryParams + body)
 *   4. sign   = SHA256_hex(digest + secretKey)
 *
 * Byte-Reihenfolge: UTF-8-String-Konkatenation, dann SHA-256, Hex lower-case.
 * Standard-Lib: `node:crypto.createHash("sha256")`.
 *
 * Abweichungen zur Doku (in docs/BITUNIX.md):
 *   - Demo-timestamp `"20241120123045"` vs. Spezifikation „milliseconds“ —
 *     Produktion nutzt monotonische Millisekunden.
 *   - Nonce „32bits“ vs. Login-Beispiel 32 Zeichen — 32 Hex-Zeichen.
 *
 * @example
 * ```ts
 * const { sign } = signBitunixRequest({
 *   nonce: "123456",
 *   timestamp: "20241120123045",
 *   apiKey: "yourApiKey",
 *   secret: "yourSecretKey",
 *   queryParams: "id1uid200",
 *   body: '{"uid":"2899"}',
 * });
 * ```
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** SHA-256 Hex (UTF-8) — die eine Hash-Primitive dieses Moduls. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Query-Kanonisierung laut Doku: sortierte Keys, `key+value` ohne Trenner.
 * `undefined`/`null`/leere Werte werden weggelassen.
 */
export function encodeQueryParams(
  params: Record<string, string | number | boolean | null | undefined> = {}
): string {
  const keys = Object.keys(params)
    .filter((k) => {
      const v = params[k];
      return v !== undefined && v !== null && v !== "";
    })
    .sort();
  let out = "";
  for (const k of keys) {
    out += k + String(params[k]);
  }
  return out;
}

/** Kompaktes JSON (keine Spaces) — muss byte-identisch zum Request-Body sein. */
export function compactJson(body: unknown): string {
  if (body === undefined || body === null || body === "") return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body);
}

export interface SignInput {
  nonce: string;
  timestamp: string;
  apiKey: string;
  secret: string;
  /** Bereits kanonisierter Query-String (oder leer). */
  queryParams?: string;
  /** Kompakter Body (oder leer). */
  body?: string;
}

export interface SignResult {
  /** Erste Runde: SHA256(nonce+ts+key+query+body). */
  digest: string;
  /** Zweite Runde: SHA256(digest+secret) — Header `sign`. */
  sign: string;
}

/**
 * Doppel-SHA256-Signatur. Golden-testbar: gleiche Inputs → gleiche Hex.
 *
 * Formel: `SHA256(SHA256(nonce+timestamp+api-key+query+body)+secret)`
 */
export function signBitunixRequest(input: SignInput): SignResult {
  const query = input.queryParams ?? "";
  const body = input.body ?? "";
  const digestInput = input.nonce + input.timestamp + input.apiKey + query + body;
  const digest = sha256Hex(digestInput);
  const sign = sha256Hex(digest + input.secret);
  return { digest, sign };
}

/** Verifiziert eine Signatur (Mock-Server, konstante Zeit soweit praxisnah). */
export function verifyBitunixSign(input: SignInput, providedSign: string): boolean {
  if (typeof providedSign !== "string" || providedSign.length === 0) return false;
  const { sign } = signBitunixRequest(input);
  if (sign.length !== providedSign.length) return false;
  // Timing-safe compare on utf8 bytes of hex.
  const a = Buffer.from(sign, "utf8");
  const b = Buffer.from(providedSign, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Nonce-Quelle: 32 Hex-Zeichen (16 Bytes). Eindeutigkeit über ein
 * In-Memory-Fenster (Replay-Schutz auf Client-Seite).
 */
export class NonceFactory {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly windowSize = 4096) {}

  /** Liefert eine im Fenster eindeutige Nonce. */
  next(): string {
    for (let i = 0; i < 8; i++) {
      const n = randomBytes(16).toString("hex");
      if (!this.seen.has(n)) {
        this.remember(n);
        return n;
      }
    }
    // Praktisch unerreichbar — Fallback mit Timestamp-Suffix.
    const fallback = randomBytes(12).toString("hex") + Date.now().toString(16).slice(-8);
    this.remember(fallback);
    return fallback;
  }

  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }

  get size(): number {
    return this.seen.size;
  }

  private remember(n: string): void {
    this.seen.add(n);
    this.order.push(n);
    while (this.order.length > this.windowSize) {
      const old = this.order.shift();
      if (old) this.seen.delete(old);
    }
  }
}

/**
 * Monotoner Millisekunden-Timestamp. Wenn die Wanduhr stehen bleibt oder
 * zurückspringt, wird der letzte Wert + 1 verwendet (Replay-Schutz).
 */
export class MonotonicTimestamp {
  private last = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Nächster Timestamp als Dezimalstring. */
  next(): string {
    const n = this.now();
    this.last = n > this.last ? n : this.last + 1;
    return String(this.last);
  }

  get lastValue(): number {
    return this.last;
  }
}

/** Prozessweite Defaults (Adapter kann eigene Instanzen injizieren). */
export const defaultNonceFactory = new NonceFactory();
export const defaultTimestamp = new MonotonicTimestamp();
