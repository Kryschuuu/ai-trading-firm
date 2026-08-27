/**
 * Gemeinsame Validierung der read-only Portfolio-API (Task 05).
 *
 * Alle drei Routen (`/api/portfolio/metrics|correlation|optimize`) nutzen
 * dieselben Grenzen. Grundsatz: **keine stillschweigende Korrektur** — eine
 * ungültige oder zu große Anfrage wird mit einem klaren Fehler abgelehnt,
 * weil gekürzte Reihen andere (falsche) Kennzahlen liefern würden.
 *
 * DoS-Schutz: Request-Body-Größe, Anzahl Serien, Serienlänge und das Produkt
 * `Serien × Länge` sind hart begrenzt (`PORTFOLIO_LIMITS`).
 */

import { PORTFOLIO_LIMITS, isCorrelationMethod, isOptimizationMode, isSingularMatrixPolicy } from "@/portfolio/config";
import { PortfolioError, publicPortfolioErrorMessage, requireFinite, requireFiniteAtLeast } from "@/portfolio/errors";
import type { CorrelationMethod, OptimizationMode, SeriesInput } from "@/portfolio/types";

/** Maximale Body-Größe (Bytes). */
export const MAX_BODY_BYTES = PORTFOLIO_LIMITS.maxBodyBytes;

/**
 * Erlaubtes Symbolformat: beginnt alphanumerisch, danach Großbuchstaben,
 * Ziffern und `: . / - _ =` (deckt `NVDA`, `BTC-USDT`, `BINANCE:BTCUSDT` ab).
 * Keine Leer- oder Steuerzeichen ⇒ nichts kann in URLs, Logs oder Dateinamen
 * eskalieren.
 */
export const PORTFOLIO_SYMBOL_RE = /^[A-Z0-9][A-Z0-9:./\-_=]{0,63}$/;

/** Maximale Länge eines Symbols. */
export const MAX_SYMBOL_LENGTH = 64;

/** Fehlercode → HTTP-Status. */
export function statusForCode(code: string): number {
  switch (code) {
    case "LIMIT_EXCEEDED":
      return 413;
    case "RISK_GUARD_REJECTION":
      return 422;
    case "INVALID_SYMBOL":
    case "INVALID_INPUT":
    case "INVALID_CONFIG":
    case "LENGTH_MISMATCH":
    case "INSUFFICIENT_DATA":
    case "NON_POSITIVE_PRICE":
    case "INFEASIBLE_CONSTRAINTS":
    case "INVALID_JSON":
      return 400;
    case "SINGULAR_MATRIX":
    case "NOT_POSITIVE_DEFINITE":
    case "NUMERIC_FAILURE":
      return 422;
    default:
      return 500;
  }
}

/**
 * Einheitliche Fehlerantwort (stabiler Code, redigierte Meldung).
 *
 * Nur {@link PortfolioError}-Meldungen sind für Clients formuliert und werden
 * ausgegeben. Jede andere Ausnahme (Bug, Infrastruktur) liefert die generische
 * Meldung „Interner Fehler" — interne Details gehören ins Server-Log, nicht in
 * eine HTTP-Antwort.
 */
export function errorResponse(err: unknown): Response {
  const code = err instanceof PortfolioError ? err.code : "INTERNAL_ERROR";
  const status = statusForCode(code);
  return Response.json(
    {
      ok: false,
      error: code,
      message: err instanceof PortfolioError ? publicPortfolioErrorMessage(err) : "Interner Fehler",
      ...(err instanceof PortfolioError && err.field ? { field: err.field } : {}),
    },
    { status }
  );
}

/** `405 Method Not Allowed` — die Routen sind ausschließlich POST (Payload-Größe). */
export function methodNotAllowed(): Response {
  return Response.json(
    { ok: false, error: "METHOD_NOT_ALLOWED", message: "dieser Endpunkt akzeptiert ausschließlich POST" },
    { status: 405, headers: { Allow: "POST" } }
  );
}

/**
 * Liest und parst den Request-Body mit harter Größenprüfung.
 *
 * @throws PortfolioError `LIMIT_EXCEEDED` (413) bzw. `INVALID_INPUT` (400).
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PortfolioError("LIMIT_EXCEEDED", `Body größer als ${MAX_BODY_BYTES} Bytes`, {
      field: "body",
      details: { declared, max: MAX_BODY_BYTES },
    });
  }
  const text = await req.text();
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_BODY_BYTES) {
    throw new PortfolioError("LIMIT_EXCEEDED", `Body größer als ${MAX_BODY_BYTES} Bytes`, {
      field: "body",
      details: { bytes, max: MAX_BODY_BYTES },
    });
  }
  if (!text.trim()) {
    throw new PortfolioError("INVALID_INPUT", "leerer Request-Body", { field: "body" });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PortfolioError("INVALID_INPUT", "Body ist kein gültiges JSON", { field: "body" });
  }
}

/** Erzwingt ein Objekt als Body-Wurzel. */
export function asObject(value: unknown, field = "body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PortfolioError("INVALID_INPUT", "erwartet ein JSON-Objekt", { field });
  }
  return value as Record<string, unknown>;
}

/** Validiert und normalisiert ein Symbol (Trim, Uppercase, Formatprüfung). */
export function parseSymbol(raw: unknown, field = "symbol"): string {
  if (typeof raw !== "string") {
    throw new PortfolioError("INVALID_SYMBOL", "symbol muss ein String sein", { field });
  }
  const symbol = raw.trim().toUpperCase();
  if (!symbol || symbol.length > MAX_SYMBOL_LENGTH || !PORTFOLIO_SYMBOL_RE.test(symbol)) {
    throw new PortfolioError("INVALID_SYMBOL", "ungültiges Symbolformat", {
      field,
      details: { length: symbol.length, max: MAX_SYMBOL_LENGTH },
    });
  }
  return symbol;
}

/** Parst eine Zahl mit optionalem Wertebereich. */
export function parseNumber(
  raw: unknown,
  field: string,
  options: { min?: number; max?: number; integer?: boolean } = {}
): number {
  const value = requireFinite(raw, field);
  if (options.min !== undefined && value < options.min) {
    throw new PortfolioError("INVALID_INPUT", `${field} muss ≥ ${options.min} sein`, { field });
  }
  if (options.max !== undefined && value > options.max) {
    throw new PortfolioError("INVALID_INPUT", `${field} muss ≤ ${options.max} sein`, { field });
  }
  if (options.integer && !Number.isInteger(value)) {
    throw new PortfolioError("INVALID_INPUT", `${field} muss ganzzahlig sein`, { field });
  }
  return value;
}

/** Parst eine optionale Zahl (undefined bleibt undefined). */
export function parseOptionalNumber(
  raw: unknown,
  field: string,
  options: { min?: number; max?: number; integer?: boolean } = {}
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  return parseNumber(raw, field, options);
}

/** Parst ein Zahlenarray (endliche Werte, harte Längengrenze). */
export function parseNumberArray(raw: unknown, field: string): number[] {
  if (!Array.isArray(raw)) {
    throw new PortfolioError("INVALID_INPUT", `${field} muss ein Array sein`, { field });
  }
  if (raw.length > PORTFOLIO_LIMITS.maxSeriesLength) {
    throw new PortfolioError("LIMIT_EXCEEDED", `${field} länger als ${PORTFOLIO_LIMITS.maxSeriesLength}`, {
      field,
      details: { length: raw.length, max: PORTFOLIO_LIMITS.maxSeriesLength },
    });
  }
  const out = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new PortfolioError("INVALID_INPUT", `${field}[${i}] ist keine endliche Zahl (NaN/Infinity sind verboten)`, {
        field,
        details: { index: i },
      });
    }
    out[i] = value;
  }
  return out;
}

/** Eine Kerze (high/low/close) mit Positivprüfung. */
function parseCandle(raw: unknown, field: string, index: number): { high: number; low: number; close: number } {
  const obj = asObject(raw, `${field}[${index}]`);
  const high = parseNumber(obj.high, `${field}[${index}].high`, { min: Number.EPSILON });
  const low = parseNumber(obj.low, `${field}[${index}].low`, { min: Number.EPSILON });
  const close = parseNumber(obj.close, `${field}[${index}].close`, { min: Number.EPSILON });
  if (high < low) {
    throw new PortfolioError("INVALID_INPUT", `Kerze ${index}: high ${high} < low ${low}`, {
      field: `${field}[${index}]`,
    });
  }
  return { high, low, close };
}

/**
 * Parst die `series`-Liste eines Requests.
 *
 * Jedes Element braucht ein `symbol` und genau eine Quelle
 * (`prices` | `returns` | `logReturns`); `candles` ist optional (ATR).
 */
export function parseSeries(raw: unknown, field = "series"): SeriesInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PortfolioError("INVALID_INPUT", "series muss ein nicht-leeres Array sein", { field });
  }
  if (raw.length > PORTFOLIO_LIMITS.maxSeries) {
    throw new PortfolioError("LIMIT_EXCEEDED", `maximal ${PORTFOLIO_LIMITS.maxSeries} Serien je Request`, {
      field,
      details: { count: raw.length, max: PORTFOLIO_LIMITS.maxSeries },
    });
  }
  return raw.map((entry, i) => {
    const obj = asObject(entry, `${field}[${i}]`);
    const series: SeriesInput = { symbol: parseSymbol(obj.symbol, `${field}[${i}].symbol`) };
    if (obj.prices !== undefined) series.prices = parseNumberArray(obj.prices, `${field}[${i}].prices`);
    if (obj.returns !== undefined) series.returns = parseNumberArray(obj.returns, `${field}[${i}].returns`);
    if (obj.logReturns !== undefined) series.logReturns = parseNumberArray(obj.logReturns, `${field}[${i}].logReturns`);
    if (obj.candles !== undefined) {
      if (!Array.isArray(obj.candles) || obj.candles.length > PORTFOLIO_LIMITS.maxSeriesLength) {
        throw new PortfolioError("INVALID_INPUT", "candles muss ein Array mit begrenzter Länge sein", {
          field: `${field}[${i}].candles`,
        });
      }
      series.candles = obj.candles.map((c, j) => parseCandle(c, `${field}[${i}].candles`, j));
    }
    if (obj.assetClass !== undefined) {
      if (typeof obj.assetClass !== "string" || obj.assetClass.length > 32) {
        throw new PortfolioError("INVALID_INPUT", "assetClass muss ein kurzer String sein", {
          field: `${field}[${i}].assetClass`,
        });
      }
      series.assetClass = obj.assetClass.trim().toLowerCase();
    }
    if (series.prices === undefined && series.returns === undefined && series.logReturns === undefined) {
      throw new PortfolioError("INVALID_INPUT", "eine der Quellen prices | returns | logReturns ist Pflicht", {
        field: `${field}[${i}]`,
      });
    }
    const rf = parseOptionalNumber(obj.riskFreeRate, `${field}[${i}].riskFreeRate`, { min: -1, max: 1 });
    if (rf !== undefined) series.riskFreeRate = rf;
    return series;
  });
}

/** Parst ein Korrelationsverfahren. */
export function parseCorrelationMethod(raw: unknown, field = "method"): CorrelationMethod | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isCorrelationMethod(raw)) {
    throw new PortfolioError("INVALID_INPUT", "method muss 'pearson' oder 'spearman' sein", { field });
  }
  return raw;
}

/** Parst einen Optimierungs-Modus. */
export function parseMode(raw: unknown, field = "mode"): OptimizationMode {
  if (!isOptimizationMode(raw)) {
    throw new PortfolioError("INVALID_INPUT", "mode muss min_variance | max_sharpe | risk_parity sein", { field });
  }
  return raw;
}

/** Parst eine Policy für singuläre Matrizen. */
export function parseSingularMatrixPolicy(raw: unknown, field = "singularMatrixPolicy") {
  if (raw === undefined || raw === null) return undefined;
  if (!isSingularMatrixPolicy(raw)) {
    throw new PortfolioError("INVALID_INPUT", "singularMatrixPolicy muss error | ridge | pseudo-inverse sein", { field });
  }
  return raw;
}

/** Parst ein optionales String-→Zahl-Objekt (z. B. `perSymbol`). */
export function parseSymbolMap(raw: unknown, field: string): Record<string, number> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asObject(raw, field);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[parseSymbol(key, `${field}.${key}`)] = requireFiniteAtLeast(value, 0, `${field}.${key}`);
  }
  return out;
}
