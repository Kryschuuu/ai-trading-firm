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
  | "DATA_UNAVAILABLE" // Venue liefert valide, aber leere Antwort — z. B. `data: []` bei Klines (0 verwertbare Bars, BEFORE_START/INVALID-Zeitraum), kein Retry
  // ── Datenqualitäts-Klassen (GAP-07, v1.47.0) ─────────────────────────────
  // Keine Abruf-Fehler: die Daten sind gelandet, die Serie ist nur auffällig.
  // Sie werden deshalb bewusst NICHT als retryable eingestuft und fließen nie
  // in die Fetch-Backoff-Logik; die Sichtbarkeit läuft über Quality-Report,
  // Sync-Report (stage `candles`) und `market_data_quality_findings_total`.
  | "QUALITY_GAP" // fehlende Intervalle in der Serie (erwartete Kerze nicht vorhanden)
  | "QUALITY_OUTLIER" // Wick/Körper > MARKETDATA_OUTLIER_ATR_MULT × ATR (Default 25 — bewusst großzügig, Flash-Moves durchkommen)
  | "QUALITY_INVALID" // OHLC ≤ 0, high < low oder close außerhalb [low, high]
  | "QUALITY_DUPLICATE" // derselbe Zeitstempel mehrfach in der Serie
  | "QUALITY_CROSSCHECK" // Zweitquellen-Abweichung > MARKETDATA_CROSSCHECK_TOLERANCE_PCT (opt-in)
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
  DATA_UNAVAILABLE: true,
  QUALITY_GAP: true,
  QUALITY_OUTLIER: true,
  QUALITY_INVALID: true,
  QUALITY_DUPLICATE: true,
  QUALITY_CROSSCHECK: true,
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

/** JSON-Parse- bzw. Syntaxfehler, die auf ein unerwartetes Response-Schema hindeuten. */
const JSON_SCHEMA_MARKERS =
  /JSON|Unexpected token|Unexpected end of JSON|is not valid JSON|not valid JSON|unterminated (?:string|array|object)|at position/i;

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  let current = err;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    out.push(current);
    if (typeof current === "object" && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return out;
}

function isJsonParseError(err: unknown): boolean {
  for (const node of causeChain(err)) {
    if (node instanceof SyntaxError) return true;
    if (node && typeof node === "object") {
      const e = node as { name?: unknown; message?: unknown };
      if (e.name === "SyntaxError") return true;
      if (typeof e.message === "string" && JSON_SCHEMA_MARKERS.test(e.message)) return true;
    }
    if (typeof node === "string" && JSON_SCHEMA_MARKERS.test(node)) return true;
  }
  return false;
}

/**
 * Sammelt `kind`-Werte von Fehler und Ursachen-Kette. Venue-Clients
 * (Bitunix: `auth`/`permission`/`rate-limit`/`maintenance`/`payload`/…,
 * siehe `src/brokers/bitunix/errors.ts`) typisieren Fehler maschinenlesbar —
 * ohne diese Abbildung landete z. B. ein Bitunix-Rate-Limit als generisches
 * `UNKNOWN` statt als retryable `RATE_LIMITED`.
 */
function kindsOf(err: unknown): string[] {
  const out: string[] = [];
  for (const node of causeChain(err)) {
    if (node && typeof node === "object") {
      const kind = (node as { kind?: unknown }).kind;
      if (typeof kind === "string" && kind) out.push(kind);
    }
  }
  return out;
}

/**
 * Normalisiert einen `kind`-Wert auf vergleichbare Token
 * (`rate-limit` → `[rate, limit]`, `RATE_LIMIT` → `[rate, limit]`).
 */
function kindTokens(kind: string): string[] {
  return kind
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Bildet einen normalisierten `kind` auf die Taxonomie ab. `null` = kein
 * Treffer (Aufrufer fällt auf die nächste Regel zurück).
 */
function reasonForKind(kind: string): { reason: MarketDataErrorReason; retryable: boolean } | null {
  const tokens = kindTokens(kind);
  const joined = tokens.join("");
  const has = (...want: string[]): boolean => want.every((w) => tokens.includes(w));
  // `data_unavailable` (valide, aber leere Venue-Antwort) ist KEIN 5xx:
  // explizit vor der `unavailable`-Regel abfangen, sonst würde ein
  // valides Leer-Ergebnis als retryable eingestuft (Retry-Loop).
  if (has("data", "unavailable") || joined === "dataunavailable") {
    return { reason: "DATA_UNAVAILABLE", retryable: false };
  }
  if (has("rate", "limit") || joined.includes("ratelimit") || joined.includes("toomanyrequests") || tokens.includes("429")) {
    return { reason: "RATE_LIMITED", retryable: true };
  }
  if (
    has("maintenance") ||
    has("service", "unavailable") ||
    has("bad", "gateway") ||
    has("gateway", "timeout") ||
    tokens.includes("unavailable") ||
    tokens.includes("maintenance")
  ) {
    return { reason: "UPSTREAM_5XX", retryable: true };
  }
  if (
    tokens.includes("auth") ||
    tokens.includes("authentication") ||
    tokens.includes("unauthorized") ||
    tokens.includes("permission") ||
    tokens.includes("permissions") ||
    tokens.includes("forbidden")
  ) {
    return { reason: "UNAUTHORIZED", retryable: false };
  }
  if (has("not", "found") || tokens.includes("notfound") || joined.includes("unknownsymbol") || joined.includes("symbolnotfound")) {
    return { reason: "NOT_FOUND", retryable: false };
  }
  if (joined.includes("invalidsymbol") || joined.includes("badsymbol")) {
    return { reason: "INVALID_SYMBOL", retryable: false };
  }
  // Antwort über der Payload-Kappe: niemals erneut anfragen (non-retryable);
  // nächstliegende Taxonomie-Klasse ist SCHEMA_MISMATCH (Antwort unbrauchbar).
  if (tokens.includes("payload") || has("too", "large") || has("payload", "too", "large")) {
    return { reason: "SCHEMA_MISMATCH", retryable: false };
  }
  if (tokens.includes("timeout") || has("deadline", "exceeded") || tokens.includes("deadline")) {
    return { reason: "TIMEOUT", retryable: true };
  }
  if (tokens.includes("aborted") || tokens.includes("cancelled") || tokens.includes("canceled")) {
    return { reason: "ABORTED", retryable: false };
  }
  if (
    tokens.includes("network") ||
    tokens.includes("dns") ||
    tokens.includes("socket") ||
    has("connection", "refused") ||
    has("connection", "reset") ||
    NETWORK_CODES.has(kind.toUpperCase())
  ) {
    return { reason: "NETWORK", retryable: true };
  }
  if (tokens.includes("tls") || tokens.includes("ssl") || tokens.includes("cert") || tokens.includes("certificate")) {
    return { reason: "TLS", retryable: false };
  }
  return null;
}

/**
 * Diese Klassifikation ist NICHT nur kosmetisch — sie entscheidet,
 * ob ein Fehler als transient (Retry sinnvoll) oder permanent
 * (Instrument-Konfigurationsfehler) behandelt wird.
 *
 * Priorität: expliziter HTTP-Status (inkl. `BitunixApiError.httpStatus`) →
 * JSON-Parse (inkl. `.cause`-Kette) → Schema-/Timeout-Codes →
 * explizite Typisierung (`code` exakt = Taxonomie-Klasse, Venue-`kind`,
 * Broker-Codes wie `BITUNIX_RATE_LIMIT`) → TLS-/Netzwerk-Codes → `UNKNOWN`.
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

  // JSON.parse() wirft SyntaxError/TypeError — das ist keine Netzwerkursache,
  // sondern ein unerwartetes/Veraltetes Response-Schema (SCHEMA_MISMATCH).
  if (isJsonParseError(err)) {
    return { reason: "SCHEMA_MISMATCH", retryable: false, httpStatus };
  }
  if (codes.includes("SCHEMA_MISMATCH") || names.includes("ZODERROR")) {
    return { reason: "SCHEMA_MISMATCH", retryable: false, httpStatus };
  }
  if (codes.includes("TIMEOUT") || codes.includes("ABORTED") || names.includes("ABORTERROR") || names.includes("TIMEOUTERROR")) {
    // AbortError entsteht hier praktisch immer durch den Timeout-Timer.
    return { reason: codes.includes("ABORTED") ? "ABORTED" : "TIMEOUT", retryable: codes.includes("ABORTED") ? false : true, httpStatus };
  }
  // Explizit typisierte Fehler schlagen die nachfolgenden Heuristiken: ein
  // `code`, der exakt einer Taxonomie-Klasse entspricht, wird direkt
  // übernommen (retryable folgt `RETRYABLE_REASONS`); danach Venue-`kind`
  // (`rate-limit`, `maintenance`, `auth`, … — `kindsOf` liest die
  // `.cause`-Kette) und Broker-Codes (`BITUNIX_RATE_LIMIT`, …). Ohne diese
  // Abbildung landete z. B. jedes Bitunix-Rate-Limit als `UNKNOWN`.
  for (const code of codes) {
    if (isMarketDataErrorReason(code)) {
      return { reason: code, retryable: RETRYABLE_REASONS.has(code), httpStatus };
    }
  }
  for (const kind of [...kindsOf(err), ...codes]) {
    const mapped = reasonForKind(kind);
    if (mapped) return { ...mapped, httpStatus };
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
