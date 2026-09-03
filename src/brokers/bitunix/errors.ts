/**
 * Fehler-Taxonomie des Bitunix-Adapters (Task 07).
 *
 * SAFE: Meldungen enthalten keine Secrets, keine vollen Query-Strings,
 * keine Bodies, keine Signaturen. Fremd-Input wird gekürzt.
 */
import { BrokerError } from "../../contracts/broker";

/** Maschinenlesbare Klassen der Bitunix-Fehler. */
export type BitunixErrorKind =
  | "auth"
  | "permission"
  | "rate-limit"
  | "maintenance"
  | "disabled"
  | "ssrf"
  /**
   * Ambivalenter Ausgang eines NICHT-idempotenten Requests (z. B. place_order
   * nach HTTP 429 / Timeout / Netzwerkfehler / 5xx). Die Anfrage KÖNNTE
   * serverseitig verarbeitet worden sein — nie blind wiederholen, sondern
   * VOR jedem erneuten Senden per clientOrderId den echten Status abfragen.
   */
  | "ambiguous"
  /** Antwort über der Payload-Kappe — niemals erneut anfragen. */
  | "payload"
  | "unknown";

const KIND_CODE: Record<BitunixErrorKind, string> = {
  auth: "BITUNIX_AUTH",
  permission: "BITUNIX_PERMISSION",
  "rate-limit": "BITUNIX_RATE_LIMIT",
  maintenance: "BITUNIX_MAINTENANCE",
  disabled: "BITUNIX_DISABLED",
  ssrf: "BITUNIX_SSRF",
  ambiguous: "BITUNIX_AMBIGUOUS",
  payload: "BITUNIX_PAYLOAD",
  unknown: "BITUNIX_UNKNOWN",
};

/** Kürzt beliebigen Fremdtext für Logs/Meldungen (kein Secret-Dump). */
export function safeSnippet(value: unknown, max = 80): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  const clean = raw.replace(/[^\x20-\x7E]/g, "").slice(0, max);
  return clean || "<leer>";
}

/**
 * Venue-Fehler mit Taxonomie. `kind` steuert Retry (nur rate-limit /
 * maintenance / unknown-5xx), nie auth.
 */
export class BitunixApiError extends BrokerError {
  readonly kind: BitunixErrorKind;
  readonly httpStatus: number | null;
  readonly venueCode: number | null;

  constructor(
    kind: BitunixErrorKind,
    message: string,
    opts: { httpStatus?: number | null; venueCode?: number | null } = {}
  ) {
    super(KIND_CODE[kind], message);
    this.kind = kind;
    this.httpStatus = opts.httpStatus ?? null;
    this.venueCode = opts.venueCode ?? null;
  }
}

/**
 * Ambivalenter Fehler einer nicht-idempotenten Order (H4): Der HTTP-Transport
 * hat bei HTTP 429 / Timeout / Netzwerkfehler / 5xx NICHT automatisch
 * wiederholt, weil die Venue die Order bereits verarbeitet haben könnte
 * (Doppel-Order-Gefahr). Der Aufrufer MUSS vor einem erneuten Senden den
 * echten Status per `clientOrderId` abfragen (`getOrderByClientId`).
 */
export class BitunixAmbiguousError extends BitunixApiError {
  constructor(
    message: string,
    opts: { httpStatus?: number | null; venueCode?: number | null } = {}
  ) {
    super("ambiguous", message, opts);
  }
}

/** Adapter/Market-Data sind per Flag aus. */
export class BitunixDisabledError extends BitunixApiError {
  constructor() {
    super(
      "disabled",
      "Bitunix-Adapter ist deaktiviert (BITUNIX_ENABLED=false). " +
        "Market-Data und Trading-Calls werden nicht ausgeführt."
    );
  }
}

/**
 * Mappt HTTP-Status + Venue-`code` auf die Taxonomie.
 * Venue-Code 10007 = Signature Error (offizielle Doku) → auth.
 */
export function classifyBitunixFailure(opts: {
  httpStatus?: number | null;
  venueCode?: number | null;
  venueMsg?: string | null;
}): { kind: BitunixErrorKind; message: string } {
  const status = opts.httpStatus ?? 0;
  const code = opts.venueCode ?? 0;
  if (code === 10007 || status === 401) {
    return { kind: "auth", message: "Bitunix-Authentifizierung fehlgeschlagen (Signatur/Key)." };
  }
  if (status === 403 || code === 10006) {
    return { kind: "permission", message: "Bitunix: unzureichende API-Berechtigung." };
  }
  if (status === 429 || code === 10001) {
    return { kind: "rate-limit", message: "Bitunix Rate-Limit erreicht." };
  }
  if (status === 503 || status === 502 || /mainten/i.test(opts.venueMsg ?? "")) {
    return { kind: "maintenance", message: "Bitunix nicht erreichbar oder in Wartung." };
  }
  return {
    kind: "unknown",
    message: `Bitunix-Fehler (HTTP ${status || "n/a"}, code ${code || "n/a"}).`,
  };
}
