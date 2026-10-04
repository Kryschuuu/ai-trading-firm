/**
 * Zeiträume der Equity-Kurve — eine Quelle für API, Chart und Doku.
 *
 * Warum ein eigenes Modul: API (`/api/firm/equity`), Chart-Buttons und
 * Beschriftungen müssen dieselben Zeiträume kennen. Lagen die Listen früher
 * verstreut, konnte das Chart „3 M“ anbieten, während die API den Parameter
 * still auf „week“ zurückfallen ließ. Hier stehen IDs, Aliase, Klartext-Titel
 * und Erklärungstexte (für den Hover-Tooltip der Buttons) beieinander.
 *
 * Der Sonderfall `all` hat keinen Kalenderanfang — er reicht so weit zurück,
 * wie die Aufbewahrung der Kurve reicht (`EQUITY_RETENTION_DAYS`).
 */
import { periodStart, type Period } from "./time";

export type EquityRange = Period | "all";

export const EQUITY_RANGES: readonly EquityRange[] = [
  "day",
  "week",
  "month",
  "quarter",
  "halfyear",
  "year",
  "all",
];

/** Was die UI auf den Button schreibt. */
export const EQUITY_RANGE_LABELS: Record<EquityRange, string> = {
  day: "1 T",
  week: "1 W",
  month: "1 M",
  quarter: "3 M",
  halfyear: "6 M",
  year: "1 J",
  all: "Max",
};

/** Was der Button im Tooltip erklärt (Hover-Beschreibung). */
export const EQUITY_RANGE_TITLES: Record<EquityRange, string> = {
  day: "Heute — ab Berliner Mitternacht (Kalendertag, keine rollenden 24 h)",
  week: "Diese Woche — ab Montag 00:00 Berliner Zeit",
  month: "Dieser Monat — ab dem 1. um 00:00 Berliner Zeit",
  quarter: "Dieses Quartal — ab 1. Jan/Apr/Jul/Okt",
  halfyear: "Dieses Halbjahr — ab 1. Januar bzw. 1. Juli",
  year: "Dieses Jahr — ab 1. Januar",
  all: "Gesamte Historie — so weit wie die Aufbewahrung reicht (EQUITY_RETENTION_DAYS)",
};

/** Zusätzliche Schreibweisen, die Clients/Bookmarks schon benutzt haben. */
const RANGE_ALIASES: Record<string, EquityRange> = {
  "1d": "day",
  "24h": "day",
  today: "day",
  "1w": "week",
  "7d": "week",
  "1m": "month",
  "30d": "month",
  "3m": "quarter",
  "90d": "quarter",
  "6m": "halfyear",
  "180d": "halfyear",
  "1y": "year",
  "1j": "year", // deutsche Schreibweise (1 Jahr)
  "12m": "year",
  "365d": "year",
  max: "all",
  alles: "all",
  full: "all",
};

export function isEquityRange(value: string): value is EquityRange {
  return (EQUITY_RANGES as readonly string[]).includes(value) || value in RANGE_ALIASES;
}

/** Normalisiert Alias-Schreibweisen auf die kanonische ID (Default: week). */
export function normalizeEquityRange(value: string | null | undefined): EquityRange {
  const raw = (value ?? "").trim().toLowerCase();
  if ((EQUITY_RANGES as readonly string[]).includes(raw)) return raw as EquityRange;
  return RANGE_ALIASES[raw] ?? "week";
}

/**
 * Kalenderanfang des Zeitraums. `all` hat keinen Kalenderanfang (`null`) —
 * der Aufrufer setzt dort die Aufbewahrungsgrenze ein.
 */
export function equityRangeStart(range: EquityRange, at: Date = new Date()): Date | null {
  return range === "all" ? null : periodStart(range, at);
}

/**
 * Fensterbreite in Millisekunden — nur für Anzeige/Diagnose („Zeitraum: 3
 * Monate“). `all` hat keine feste Breite (0 = unbekannt).
 */
export function equityRangeWindowMs(range: EquityRange, at: Date = new Date()): number {
  if (range === "all") return 0;
  return Math.max(0, at.getTime() - periodStart(range, at).getTime());
}
