/**
 * Typisierte Fehler der Perpetual-Daten (RMA-P2-02).
 *
 * Muster des Repos (vgl. `FeatureStoreError`, `PortfolioError`): ein Fehler ist
 * ein **stabile Code** plus detailierte, leakfreie Angaben — nie ein
 * Rohtext einer Venue-Antwort. Die Codes sind API-vertraglich
 * (`GET /api/marketdata/perpetual/*` spiegelt sie als `error`-Feld).
 */

/** Basisklasse aller Perp-Daten-Fehler. */
export class PerpDataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Die Venue bietet diese Reihenart grundsätzlich nicht.
 *
 * Bewusst **kein** leeres Ergebnis: ein Aufrufer, der `[]` als „keine Daten“
 * liest, würde einen fehlenden Endpunkt mit einem ruhigen Markt verwechseln.
 * `reason` trägt den typisierten Grund, `supported` listet, was die Venue
 * stattdessen liefert (Behebungshinweis für Betrieb und UI).
 */
export class PerpUnsupportedCapabilityError extends PerpDataError {
  readonly availability = "UNSUPPORTED" as const;

  constructor(
    readonly venue: string,
    readonly kind: string,
    readonly reason: "NO_PUBLIC_ENDPOINT" | "VENUE_NOT_PERP" | "DISABLED_BY_POLICY",
    readonly supported: readonly string[]
  ) {
    super(
      "perp:unsupported",
      `${venue} stellt ${kind} nicht als historische Perp-Reihe bereit (Grund: ${reason}). ` +
        `Unterstützte Perp-Reihen dieser Venue: ${supported.length > 0 ? supported.join(", ") : "keine"}.`,
      { venue, kind, reason, supported }
    );
  }
}

/** Ablage nicht erreichbar/lesbar — Konsumenten müssen fail-closed abbrechen. */
export class PerpStoreUnavailableError extends PerpDataError {
  constructor(message: string, detail?: Readonly<Record<string, unknown>>) {
    super("perp:store_unavailable", message, detail);
  }
}

/** Abfrage-/Konfigurationsfehler aus externer Quelle (HTTP-Query, CLI). */
export class PerpQueryError extends PerpDataError {
  constructor(code: string, message: string, detail?: Readonly<Record<string, unknown>>) {
    super(code, message, detail);
  }
}

/**
 * Redigiert eine Fremd-Fehlermeldung für Manifest, Log und API (RMA-P2-02).
 *
 * Ein Transportfehler einer Venue trägt gern die vollständige Request-URL —
 * mit Symbol, Timespan und (bei falsch konfiguriertem Client) einem Key im
 * Query-String. Langlebige Artefakte (Lauf-Manifest, Qualitätsreport) dürfen
 * das nicht sehen: URLs → `[url]`, Credential-ähnliche `key=value` →
 * `[redacted]`, Steuerzeichen und Zeilenumbrüche raus (Log-Injection), Länge
 * hart begrenzt. Der *Inhalt* bleibt lesbar, die Details verschwinden.
 */
export function perpRedactMessage(raw: unknown, max = 200): string {
  let text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw ?? "");
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  text = text.replace(/\[?(?:https?|wss?|ftp):\/\/[^\s"'\]]+/gi, "[url]");
  text = text.replace(
    /\b(?:api[_-]?key|apikey|access[_-]?key|secret|signature|token|authorization|bearer)\b\s*[:=]\s*[^&\s,;]+/gi,
    "[redacted]"
  );
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

/** Klassifizierte Zeilen- oder Definitionsdetail-Fehler beim Schreiben. */
export class PerpValidationError extends PerpDataError {
  constructor(message: string, detail?: Readonly<Record<string, unknown>>) {
    super("perp:invalid", message, detail);
  }
}
