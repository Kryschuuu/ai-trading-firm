/**
 * Fehler-Taxonomie des Alpaca-Adapters (Task 12).
 *
 * SAFE: Meldungen enthalten keine Secrets, keine vollen Query-Strings,
 * keine Bodies, keine Signaturen. Fremd-Input wird gekürzt.
 */
import { BrokerError } from "../../contracts/broker";

/** Maschinenlesbare Klassen der Alpaca-Fehler. */
export type AlpacaErrorKind =
  | "auth"
  | "permission"
  | "rate-limit"
  | "maintenance"
  | "disabled"
  | "ssrf"
  | "payload"
  | "validation"
  | "unknown";

const KIND_CODE: Record<AlpacaErrorKind, string> = {
  auth: "ALPACA_AUTH",
  permission: "ALPACA_PERMISSION",
  "rate-limit": "ALPACA_RATE_LIMIT",
  maintenance: "ALPACA_MAINTENANCE",
  disabled: "ALPACA_DISABLED",
  ssrf: "ALPACA_SSRF",
  payload: "ALPACA_PAYLOAD",
  validation: "ALPACA_VALIDATION",
  unknown: "ALPACA_UNKNOWN",
};

/** Kürzt beliebigen Fremdtext für Logs/Meldungen (kein Secret-Dump). */
export function safeSnippet(value: unknown, max = 80): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  const clean = raw.replace(/[^\x20-\x7E]/g, "").slice(0, max);
  return clean || "<leer>";
}

/**
 * Venue-Fehler mit Taxonomie. `kind` steuert Retry (nur rate-limit /
 * maintenance / unknown-5xx), nie auth/permission.
 */
export class AlpacaApiError extends BrokerError {
  readonly kind: AlpacaErrorKind;
  readonly httpStatus: number | null;
  readonly venueCode: string | null;

  constructor(
    kind: AlpacaErrorKind,
    message: string,
    opts: { httpStatus?: number | null; venueCode?: string | null } = {}
  ) {
    super(KIND_CODE[kind], message);
    this.kind = kind;
    this.httpStatus = opts.httpStatus ?? null;
    this.venueCode = opts.venueCode ?? null;
  }
}

/** Adapter/Market-Data sind per Flag aus. */
export class AlpacaDisabledError extends AlpacaApiError {
  constructor() {
    super(
      "disabled",
      "Alpaca-Adapter ist deaktiviert (ALPACA_ENABLED=false). " +
        "Market-Data und Trading-Calls werden nicht ausgeführt."
    );
  }
}

/**
 * Mappt HTTP-Status + Alpaca-`code`/`message` auf die Taxonomie.
 * Alpaca liefert typisch JSON `{ "code": <int>, "message": "..." }`.
 * Bekannte Codes (siehe Alpaca-Doku): 40110000 = Invalid Credentials.
 */
export function classifyAlpacaFailure(opts: {
  httpStatus?: number | null;
  venueCode?: string | number | null;
  venueMsg?: string | null;
}): { kind: AlpacaErrorKind; message: string } {
  const status = opts.httpStatus ?? 0;
  const code = opts.venueCode != null ? String(opts.venueCode) : "";
  const msg = opts.venueMsg ?? "";

  if (status === 401 || /^401\d{5}$/.test(code) || /invalid.{0,8}credentials/i.test(msg)) {
    return { kind: "auth", message: "Alpaca-Authentifizierung fehlgeschlagen (Key/Secret)." };
  }
  if (status === 403 || /^403\d{5}$/.test(code)) {
    return { kind: "permission", message: "Alpaca: unzureichende API-Berechtigung." };
  }
  if (status === 422 || /^422\d{5}$/.test(code)) {
    return { kind: "validation", message: "Alpaca-Order ungültig (422 Unprocessable Entity)." };
  }
  if (status === 429 || /^429\d{5}$/.test(code)) {
    return { kind: "rate-limit", message: "Alpaca Rate-Limit erreicht." };
  }
  if (status === 503 || status === 502 || /mainten/i.test(msg)) {
    return { kind: "maintenance", message: "Alpaca nicht erreichbar oder in Wartung." };
  }
  if (status === 400 || /^400\d{5}$/.test(code)) {
    return { kind: "validation", message: "Alpaca-Anfrage ungültig (400 Bad Request)." };
  }
  return {
    kind: "unknown",
    message: `Alpaca-Fehler (HTTP ${status || "n/a"}, code ${code || "n/a"}).`,
  };
}
