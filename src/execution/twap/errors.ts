/**
 * Geschlossene Fehler des TWAP-/Depth-Schedulers (RMA-P4-03).
 *
 * `code` ist metrik- und API-tauglich (kein Venue-Freitext). `field` nennt
 * das verletzte Policy-/Eingabefeld, wenn die Ablehnung aus der Validierung
 * kommt.
 */

export class TwapError extends Error {
  readonly code: string;
  readonly field?: string;

  constructor(code: string, detail: string, field?: string) {
    super(`${code}: ${detail}`);
    this.name = "TwapError";
    this.code = code;
    this.field = field;
  }
}
