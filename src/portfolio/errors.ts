/**
 * Fehler-Contract des Portfolio-Moduls (Task 05).
 *
 * Grundregel der Numerik-Schicht: **Es wird nie geraten und nie still
 * repariert.** Jede unbrauchbare Eingabe (NaN, ±∞, nicht-positive Preise,
 * zu kurze Serien), jede singuläre Matrix und jede nicht konvergierte
 * Optimierung erzeugt einen `PortfolioError` mit
 *   - einem maschinenlesbaren `code` (für API-Antworten und Tests),
 *   - dem betroffenen `field` (für Entwickler),
 *   - einem `message`, der **keine** Rohdaten-Dumps und keine Secrets enthält.
 *
 * Das Modul ist unabhängig von `src/lib/secrets.ts`, damit die
 * Portfolio-Bibliothek ohne den Rest des Systems importierbar bleibt
 * (Unabhängigkeitsklausel). Die Redaktion folgt demselben Muster.
 */

/** Maschinenlesbare Fehlercodes des Portfolio-Moduls. */
export type PortfolioErrorCode =
  /** Eingabewert ist keine endliche Zahl (NaN/±∞) oder strukturell ungültig. */
  | "INVALID_INPUT"
  /** Serie ist leer oder zu kurz für die angeforderte Kennzahl. */
  | "INSUFFICIENT_DATA"
  /** Serien unterschiedlicher Länge, wo gleiche Länge erforderlich ist. */
  | "LENGTH_MISMATCH"
  /** Preis ≤ 0 (Logarithmus undefiniert). */
  | "NON_POSITIVE_PRICE"
  /** Kovarianzmatrix ist singulär bzw. nicht positiv definit. */
  | "SINGULAR_MATRIX"
  /** Numerisches Verfahren (Cholesky, Newton) ist fehlgeschlagen. */
  | "NUMERIC_FAILURE"
  /** Iterationslimit erreicht, ohne die Toleranz zu unterschreiten. */
  | "NOT_CONVERGED"
  /** Nebenbedingungen sind mathematisch unerfüllbar (z. B. Σ Untergrenzen > 1). */
  | "INFEASIBLE_CONSTRAINTS"
  /** Größen-/DoS-Limit der Anfrage überschritten. */
  | "LIMIT_EXCEEDED"
  /** Konfiguration ungültig (Bereiche, Reihenfolge, Summen). */
  | "INVALID_CONFIG"
  /** Die Risk Guard hat das Optimizer-Ergebnis verworfen (Autoritätskette). */
  | "RISK_GUARD_REJECTION"
  /** Symbol-/Bezeichner-Validierung fehlgeschlagen. */
  | "INVALID_SYMBOL";

/** Strukturierter Fehler der Portfolio-Schicht. */
export class PortfolioError extends Error {
  /** Maschinenlesbarer Code (stabiler API-Contract). */
  readonly code: PortfolioErrorCode;
  /** Betroffenes Feld bzw. betroffene Serie (optional). */
  readonly field?: string;
  /** Zusätzliche, **nicht sensitive** Diagnose (Index, Größe, Schwellwert …). */
  readonly details?: Record<string, number | string | boolean | null>;

  constructor(
    code: PortfolioErrorCode,
    message: string,
    options?: { field?: string; details?: Record<string, number | string | boolean | null> }
  ) {
    super(options?.field ? `${options.field}: ${message}` : message);
    this.name = "PortfolioError";
    this.code = code;
    this.field = options?.field;
    this.details = options?.details;
  }
}

/** Muster, die in Fehlermeldungen nichts zu suchen haben (Secrets, URIs). */
const SECRET_PATTERNS: RegExp[] = [
  /postgresql:\/\/\S+/gi,
  /postgres:\/\/\S+/gi,
  /Bearer\s+[A-Za-z0-9._\-+=/]+/gi,
  /(?:sk-ant-|sk-|AIza)[A-Za-z0-9_\-]{8,}/g,
  /(?:api[_-]?key|authorization|x-firm-token)["']?\s*[:=]\s*["']?[^\s"'&]+/gi,
];

/**
 * Redigiert eine beliebige Fehlermeldung für HTTP-Antworten und Logs.
 *
 * Entfernt Secret-Muster, komprimiert Leerraum, ersetzt Steuerzeichen und
 * kürzt auf 240 Zeichen — damit ein fehlerhaftes Request-Body-Fragment
 * niemals als Klartext an den Client zurückgeht.
 */
export function redactPortfolioMessage(text: string, max = 240): string {
  let out = text ?? "";
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  out = out.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!out) return "Interner Fehler";
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Sichere öffentliche Fehlermeldung aus einem unbekannten Fehlerobjekt. */
export function publicPortfolioErrorMessage(err: unknown, fallback = "Interner Fehler"): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : fallback;
  return redactPortfolioMessage(raw) || fallback;
}

/** Liefert den Fehlercode eines unbekannten Fehlers (Default `INVALID_INPUT`). */
export function portfolioErrorCode(err: unknown): PortfolioErrorCode {
  return err instanceof PortfolioError ? err.code : "INVALID_INPUT";
}

/** Wirft `INVALID_INPUT`, wenn `value` keine endliche Zahl ist. */
export function requireFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PortfolioError("INVALID_INPUT", `erwartet endliche Zahl, gefunden ${describe(value)}`, { field });
  }
  return value;
}

/** Wirft `INVALID_INPUT`, wenn `value` nicht endlich oder < min ist. */
export function requireFiniteAtLeast(value: unknown, min: number, field: string): number {
  const v = requireFinite(value, field);
  if (v < min) {
    throw new PortfolioError("INVALID_INPUT", `erwartet ≥ ${min}, gefunden ${v}`, { field });
  }
  return v;
}

/** Wirft `INVALID_INPUT`, wenn `value` nicht endlich oder ≤ 0 ist. */
export function requirePositive(value: unknown, field: string): number {
  const v = requireFinite(value, field);
  if (v <= 0) {
    throw new PortfolioError("INVALID_INPUT", `erwartet > 0, gefunden ${v}`, { field });
  }
  return v;
}

/** Beschreibt einen Fremdwert kurz und sicher für Fehlermeldungen. */
export function describe(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return String(value);
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return `Array(${value.length})`;
  return typeof value;
}
