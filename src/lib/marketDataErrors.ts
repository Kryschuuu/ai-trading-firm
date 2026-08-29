/**
 * Typisierte Marktdaten-Fehler (P1 — MDERR-006).
 *
 * Problem, das dieser Modul behebt: `getCandles()` bildete HTTP 429/5xx,
 * DNS-Fehler, ungültige Symbole, Schema-Abweichungen und TLS-Fehler alle auf
 * `[]` ab. Downstream war das nicht von „0 Kerzen vorhanden“ unterscheidbar
 * und erschien als `min-candles`-Ablehnung — eine leere Serie kann Faktoren
 * neutralisieren, statt eine Ausführung zu stoppen.
 *
 * Jeder echte Abruf-Fehler wird hier in eine vollständige Ursachen-Taxonomie
 * übersetzt (`reason` + `retryable` + optional `httpStatus`) und als
 * `MarketDataFetchError` geworfen. `[]` ist damit ausschließlich die
 * nachweisliche Antwort „die Venue hat keine Bars geliefert“.
 *
 * Security:
 *  - `toJSON()` ist redigiert: kein `cause`-Message/Stack, keine vollen URLs,
 *    keine Credentials (Message/Log-Felder laufen durch `sanitizeLogField`).
 *  - Kein `symbol`-Label in Metriken (Kardinalität) — Symbol nur im Log.
 */
import { sanitizeLogField } from "./logger";

/** Vollständige Ursachen-Taxonomie eines Marktdaten-Abrufs. */
export type MarketDataErrorReason =
  | "RATE_LIMITED" // 429 — Request-Budget zu aggressiv
  | "UPSTREAM_5XX" // 500/502/503 …
  | "UNAUTHORIZED" // 401/403 — versehentlicher Private-Endpoint-Aufruf
  | "NOT_FOUND" // 404 / unbekanntes Symbol
  | "INVALID_SYMBOL" // Symbolformat verletzt die Whitelist
  | "SCHEMA_MISMATCH" // Response validiert nicht gegen das erwartete Schema
  | "TIMEOUT" // AbortError / eigener Timeout-Timer
  | "NETWORK" // DNS (ENOTFOUND), ECONNREFUSED, ECONNRESET …
  | "TLS" // ERR_TLS_CERT_ALTNAME_INVALID …
  | "ABORTED" // expliziter Abbruch (code "ABORTED")
  | "UNKNOWN";

/** Ursachen, die mit Backoff/Retry behandelt werden dürfen. */
export const RETRYABLE_REASONS: ReadonlySet<MarketDataErrorReason> = new Set([
  "RATE_LIMITED",
  "UPSTREAM_5XX",
  "TIMEOUT",
  "NETWORK",
]);

export function isMarketDataErrorReason(value: unknown): value is MarketDataErrorReason {
  return typeof value === "string" && (RETRYABLE_REASONS.has(value as MarketDataErrorReason) || (value as string) in ALL_REASONS);
}

const ALL_REASONS: Record<MarketDataErrorReason, true> = {
  RATE_LIMITED: true,
  UPSTREAM_5XX: true,
  UNAUTHORIZED: true,
  NOT_FOUND: true,
  INVALID_SYMBOL: true,
  SCHEMA_MISMATCH: true,
  TIMEOUT: true,
  NETWORK: true,
  TLS: true,
  ABORTED: true,
  UNKNOWN: true,
};

/** Netzwerk-Codes, die als `NETWORK` klassifiziert werden. */
const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

const TLS_MARKERS = ["TLS", "CERT", "SELF_SIGNED", "UNABLE_TO_VERIFY", "HOSTNAME_MISMATCH"];

/**
 * HTTP-Status-basierter Transportfehler. Der Status bleibt maschinenlesbar,
 * damit `classifyMarketDataError` 429/5xx/401/404 korrekt einordnen kann —
 * unabhängig davon, welche Bibliothek den Fehler erzeugt hat.
 */
export class MarketDataHttpError extends Error {
  readonly httpStatus: number;
  readonly code = "MARKET_DATA_HTTP";

  constructor(status: number, detail = "") {
    super(`HTTP ${status}${detail ? ` von ${detail}` : ""}`);
    this.name = "MarketDataHttpError";
    this.httpStatus = status;
  }
}

/** Eigener Timeout-Timer (nicht nur der Fetch-Abort). */
export class MarketDataTimeoutError extends Error {
  readonly code = "TIMEOUT";

  constructor(detail = "") {
    super(`Zeitüberschreitung${detail ? `: ${detail}` : ""}`);
    this.name = "MarketDataTimeoutError";
  }
}

/** Antwort validiert nicht gegen das erwartete Schema. */
export class MarketDataSchemaError extends Error {
  readonly code = "SCHEMA_MISMATCH";

  constructor(detail = "") {
    super(`Schema-Abweichung${detail ? `: ${detail}` : ""}`);
    this.name = "MarketDataSchemaError";
  }
}

/** Liest einen HTTP-Status aus Fehler-Objekten (`.httpStatus`/`.status`/`.statusCode` oder Message). */
function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    for (const key of ["httpStatus", "status", "statusCode"]) {
      const v = e[key];
      if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599) return v;
    }
    if (typeof e.message === "string") {
      const m = /(?:HTTP|status(?: code)?)\s*(\d{3})/i.exec(e.message);
      if (m) return Number(m[1]);
    }
  }
  if (typeof err === "string") {
    const m = /(?:HTTP|status(?: code)?)\s*(\d{3})/i.exec(err);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Bekannte Fehlercodes, die auch aus Message-Texten extrahiert werden. */
const CODE_MARKERS =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|EPIPE|ERR_TLS_[A-Z0-9_]+)\b/g;

/** Sammelt `code`-Werte von Fehler und Ursachen-Kette (undici kapselt in `.cause`). */
function codesOf(err: unknown): string[] {
  const out: string[] = [];
  let current = err;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (typeof current === "object") {
      const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
      if (typeof e.code === "string") out.push(e.code);
      if (typeof e.name === "string") out.push(e.name);
      // Fremd-Clients (Sync-Adapter) liefern oft nur Messages — Codes daraus
      // extrahieren, damit die Taxonomie auch dort greift.
      if (typeof e.message === "string") out.push(...(e.message.match(CODE_MARKERS) ?? []));
      current = e.cause;
    } else if (typeof current === "string") {
      out.push(...(current.match(CODE_MARKERS) ?? []));
      break;
    } else {
      break;
    }
  }
  return out;
}

/**
 * Klassifiziert einen beliebigen Fehler in die Marktdaten-Taxonomie.
 *
 * Priorität: expliziter HTTP-Status (inkl. `BitunixApiError.httpStatus`) →
 * Fehler-Codes/Names (inkl. `.cause`-Kette) → `UNKNOWN`.
 */
export function classifyMarketDataError(err: unknown): {
  reason: MarketDataErrorReason;
  retryable: boolean;
  httpStatus?: number;
} {
  const httpStatus = statusOf(err);
  if (httpStatus === 429) return { reason: "RATE_LIMITED", retryable: true, httpStatus };
  if (httpStatus === 401 || httpStatus === 403) return { reason: "UNAUTHORIZED", retryable: false, httpStatus };
  if (httpStatus === 404 || httpStatus === 410) return { reason: "NOT_FOUND", retryable: false, httpStatus };
  if (httpStatus === 400 || httpStatus === 422) return { reason: "INVALID_SYMBOL", retryable: false, httpStatus };
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 599) {
    return { reason: "UPSTREAM_5XX", retryable: true, httpStatus };
  }

  const codes = codesOf(err);
  const names = codes.map((c) => c.toUpperCase());

  if (codes.includes("SCHEMA_MISMATCH") || names.includes("ZODERROR")) {
    return { reason: "SCHEMA_MISMATCH", retryable: false, httpStatus };
  }
  if (codes.includes("TIMEOUT") || codes.includes("ABORTED") || names.includes("ABORTERROR") || names.includes("TIMEOUTERROR")) {
    // AbortError entsteht hier praktisch immer durch den Timeout-Timer.
    return { reason: codes.includes("ABORTED") ? "ABORTED" : "TIMEOUT", retryable: codes.includes("ABORTED") ? false : true, httpStatus };
  }
  if (codes.some((c) => c.startsWith("ERR_TLS") || TLS_MARKERS.some((m) => c.toUpperCase().includes(m)))) {
    return { reason: "TLS", retryable: false, httpStatus };
  }
  if (NETWORK_CODES.has(codes[0] ?? "") || codes.some((c) => NETWORK_CODES.has(c))) {
    return { reason: "NETWORK", retryable: true, httpStatus };
  }
  if (names.some((n) => n.includes("ENOTFOUND") || n.includes("ECONNREFUSED") || n.includes("ECONNRESET"))) {
    return { reason: "NETWORK", retryable: true, httpStatus };
  }

  return { reason: "UNKNOWN", retryable: false, httpStatus };
}

/** Redigierte, gekürzte Ursachen-Zusammenfassung für `toJSON()` (kein Stack, keine Message). */
function summarizeCause(cause: unknown): Record<string, unknown> | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) {
    const code =
      typeof (cause as { code?: unknown }).code === "string"
        ? sanitizeLogField((cause as unknown as { code: string }).code, 64)
        : undefined;
    return {
      name: sanitizeLogField(cause.name, 64),
      ...(code ? { code } : {}),
    };
  }
  return { type: typeof cause };
}

/**
 * Sprach-Template der Fehlermeldung. Der Text macht explizit, dass es sich
 * um einen Infrastrukturfehler handelt — KEIN „keine Historie vorhanden“.
 */
export function buildMarketDataErrorMessage(
  venue: string,
  symbol: string,
  timeframe: string,
  reason: MarketDataErrorReason,
  httpStatus: number | undefined,
  retryable: boolean,
): string {
  const status = httpStatus === undefined ? "ohne HTTP-Status" : `HTTP ${httpStatus}`;
  return (
    `Market-Data-Abruf fehlgeschlagen: ${venue} ${symbol} ${timeframe} - ${reason} ` +
    `(${status}, ${retryable ? "retryable" : "nicht retryable"}). ` +
    `Dies ist ein Infrastrukturfehler, KEIN "keine Historie vorhanden". ` +
    `Der Scanner meldet dafuer DATA_UNAVAILABLE.`
  );
}

/** Typisierter Marktdaten-Abruf-Fehler. */
export class MarketDataFetchError extends Error {
  readonly venue: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly reason: MarketDataErrorReason;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly cause?: unknown;

  constructor(init: {
    venue: string;
    symbol: string;
    timeframe: string;
    reason: MarketDataErrorReason;
    retryable: boolean;
    httpStatus?: number;
    cause?: unknown;
  }) {
    const venue = String(init.venue ?? "unknown").slice(0, 32);
    const symbol = sanitizeLogField(init.symbol, 64);
    const timeframe = String(init.timeframe ?? "unknown").slice(0, 16);
    const reason = init.reason;
    const retryable = Boolean(init.retryable);
    super(buildMarketDataErrorMessage(venue, symbol, timeframe, reason, init.httpStatus, retryable));
    this.name = "MarketDataFetchError";
    this.venue = venue;
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.reason = reason;
    this.retryable = retryable;
    if (init.httpStatus !== undefined) this.httpStatus = init.httpStatus;
    if (init.cause !== undefined) this.cause = init.cause;
  }

  /**
   * Redigierte Serialisierung: keine Credentials, keine vollen URLs, keine
   * Stacktraces, keine ungefilterten `cause`-Nachrichten. `JSON.stringify`
   * nutzt diese Methode automatisch.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      venue: this.venue,
      symbol: this.symbol,
      timeframe: this.timeframe,
      reason: this.reason,
      retryable: this.retryable,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      message: sanitizeLogField(this.message),
      cause: summarizeCause(this.cause),
    };
  }
}
