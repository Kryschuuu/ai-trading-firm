/**
 * Qualitätsschicht der Perp-Reihen (RMA-P2-02) — Lücken, Staleness,
 * Einheiten/Bounds, Duplikate, Cross-Venue.
 *
 * Muster: `src/marketdata/quality.ts` (Kerzen-Qualität, GAP-07). Gleich sind
 *
 *   * die Klassen `GAP | OUTLIER | INVALID | DUPLICATE | CROSSCHECK` (+ `STALE`,
 *     weil bei Perp-Reihen das Datenalter die entscheidende Frage ist),
 *   * der Modus `PERP_DATA_QUALITY_MODE = log | strict`,
 *   * das Artefakt `data/perpdata/quality-report.json` (tmp + rename, 0600),
 *   * die Metrik `perp_data_quality_findings_total` (Label: Klasse).
 *
 * Und gleich ist die **Verantwortung**: im `log`-Modus wird ein Befund
 * dokumentiert und die Zeile mit ihrem `qualityStatus` geschrieben (die
 * Historie bleibt vollständig); im `strict`-Modus wird die betroffene Reihe im
 * Lauf als nicht verwertbar behandelt (belastete Zeilen werden nicht
 * geschrieben, der Lauf endet `PARTIAL`) und die Leseschicht filtert
 * belastete Zeilen komplett (`query.ts::qualityMode`). Ein Befund verschwindet
 * nie still — er zahlt auf Metrik, Report und Audit ein.
 *
 * Was diese Schicht **nicht** tut: sie erfindet keine Werte. Eine Lücke bleibt
 * eine Lücke (kein Interpolieren), ein fehlender OI-Wert bleibt `null` mit
 * Grund, und „keine Liquidationen im Fenster“ ist ein Befund `0`, kein
 * `INVALID`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "../lib/appPaths";
import { telemetry } from "../lib/telemetry";
import { PERP_LIMITS } from "./types";
import type { PerpConfig, PerpQualityMode } from "./config";
import type {
  PerpFundingRow,
  PerpLiquidationRow,
  PerpOpenInterestRow,
  PerpQualityStatus,
  PerpSeriesKind,
} from "./types";

/** Befundklassen (geschlossene Aufzählung — Metrik-Label, Report-Schlüssel). */
export type PerpQualityClass = "GAP" | "OUTLIER" | "INVALID" | "DUPLICATE" | "CROSSCHECK" | "STALE";

export const PERP_QUALITY_CLASSES: readonly PerpQualityClass[] = [
  "GAP",
  "OUTLIER",
  "INVALID",
  "DUPLICATE",
  "CROSSCHECK",
  "STALE",
] as const;

export function isPerpQualityClass(value: unknown): value is PerpQualityClass {
  return typeof value === "string" && (PERP_QUALITY_CLASSES as readonly string[]).includes(value);
}

/** Zuordnung Befundklasse → Zeilenstatus (nur diese werden gesetzt). */
export const PERP_ROW_QUALITY: Record<PerpQualityClass, PerpQualityStatus> = {
  GAP: "GAP",
  OUTLIER: "OUTLIER",
  INVALID: "INVALID",
  DUPLICATE: "DUPLICATE",
  CROSSCHECK: "CROSSCHECK",
  STALE: "STALE",
} as const;

/** Ein klassifizierter Einzelbefund (kompakt, leak-frei: keine Rohtexte). */
export interface PerpQualityFinding {
  cls: PerpQualityClass;
  /** Betroffene Ereigniszeit (ISO) — bei `GAP` die **erwartete**, fehlende Zeit. */
  eventTime?: string;
  /** Stabile Kurzbeschreibung mit Zahlen, ohne Vendor-Rohtext. */
  detail: string;
}

export interface PerpQualitySeriesReport {
  venue: string;
  instrumentId: string;
  kind: PerpSeriesKind;
  /** Zeilenzahl vor der Bereinigung. */
  rows: number;
  counts: Record<PerpQualityClass, number>;
  findings: PerpQualityFinding[];
  /** Beim Cross-Check verglichene Zeitstempel (`0` = keine Überlappung). */
  crosscheckCompared?: number;
}

export interface PerpQualityReport {
  writtenAt: string;
  mode: PerpQualityMode;
  /** Verwendete Grenzen/Politik (Reproduzierbarkeit des Befunds). */
  bounds: {
    maxAbsFundingRate: number;
    maxOiChange: number;
    fundingIntervalMs: number;
    oiIntervalMs: number;
    maxStaleMs: Record<PerpSeriesKind, number>;
  };
  series: PerpQualitySeriesReport[];
  totals: {
    series: number;
    rows: number;
    byClass: Record<PerpQualityClass, number>;
  };
}

/** Artefakt-Pfad (bewusst getrennt vom Kerzen-Report). */
export const PERP_QUALITY_REPORT_FILE = path.join("data", "perpdata", "quality-report.json");

const HOUR = 3_600_000;

/** Gemeinsame Minimalform aller Reihen für die Prüfung. */
export interface PerpAnyRow {
  kind: PerpSeriesKind;
  venue: string;
  instrumentId: string;
  eventTime: Date;
  availableAt: Date;
  qualityStatus: PerpQualityStatus;
  missingReason: string | null;
  contentHash: string;
}

export interface ValidatePerpSeriesInput {
  venue: string;
  instrumentId: string;
  kind: PerpSeriesKind;
  rows: readonly PerpAnyRow[];
  /** Bezugszeitpunkt für Staleness (Lauffenster-Ende, nicht „jetzt“). */
  asOfMs: number;
  config: PerpConfig;
  /** Letzter gespeicherter OI-Wert der Reihe (Änderungsprüfung der ersten Zeile). */
  priorOiValue?: number | null;
}

export function emptyQualityCounts(): Record<PerpQualityClass, number> {
  return { GAP: 0, OUTLIER: 0, INVALID: 0, DUPLICATE: 0, CROSSCHECK: 0, STALE: 0 };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pushFinding(
  report: { findings: PerpQualityFinding[]; counts: Record<PerpQualityClass, number> },
  finding: PerpQualityFinding
): void {
  report.counts[finding.cls] += 1;
  if (report.findings.length < PERP_LIMITS.findingsPerSeries) {
    report.findings.push(finding);
  } else if (report.findings.length === PERP_LIMITS.findingsPerSeries) {
    report.findings.push({
      cls: finding.cls,
      detail: `weitere Befunde dieser Reihe gekürzt (Deckel ${PERP_LIMITS.findingsPerSeries})`,
    });
  }
}

/** Raster je Reihe (Liquidationen sind ein Ereignisstrom ohne Raster). */
export function perpExpectedIntervalMs(kind: PerpSeriesKind, config: PerpConfig): number {
  if (kind === "funding") return Math.max(1, Math.round(config.fundingIntervalHours * HOUR));
  if (kind === "openInterest") return Math.max(1, config.oiIntervalMinutes * 60_000);
  return 0;
}

/**
 * Prüft eine Charge normalisierter Zeilen **vor** dem Schreiben.
 *
 * Rückgabe: Reihen-Report, die zulässigen Zeilen und die Status-Markierung je
 * Zeilenindex. `INVALID`/`DUPLICATE`-Zeilen werden entfernt (sie würden die
 * DB-CHECKs verletzen bzw. denselben Schlüssel doppelt belegen);
 * `OUTLIER`/`GAP`/`STALE`-Zeilen bleiben im Bestand und tragen ihren
 * `qualityStatus` — die Historie wird nicht verstümmelt, aber markiert.
 */
export function validatePerpSeries(input: ValidatePerpSeriesInput): {
  report: PerpQualitySeriesReport;
  accepted: PerpAnyRow[];
  statuses: ReadonlyMap<number, PerpQualityStatus>;
} {
  const { kind, rows, config, asOfMs } = input;
  const report: PerpQualitySeriesReport = {
    venue: input.venue,
    instrumentId: input.instrumentId,
    kind,
    rows: rows.length,
    counts: emptyQualityCounts(),
    findings: [],
  };
  const statuses = new Map<number, PerpQualityStatus>();
  const sorted = [...rows].sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  const expectedIntervalMs = perpExpectedIntervalMs(kind, config);
  const drop = new Set<number>();
  let gapsReported = 0;

  sorted.forEach((row, index) => {
    // ── INVALID: Strukturfehler (Wert XOR Grund, Zeitordnung, Maße) ──────
    // ── Von der Normalisierung bereits klassifiziert ( unplausibler Wert) ──
    // Diese Zeilen bleiben im Bestand (null + Grund ist die ehrliche Form),
    // zählen aber in den Report: sonst wäre `strict` nur gegen Strukturfehler
    // wirksam und eine Venue, die negatives Open Interest meldet, würde in
    // einem Backtest als saubere Reihe durchlaufen.
    if (row.qualityStatus === "INVALID") {
      pushFinding(report, {
        cls: "INVALID",
        eventTime: row.eventTime.toISOString(),
        detail: `${kind}-Zeile erreicht die Qualitätsschicht als INVALID (${String(row.missingReason ?? "Grund unbekannt")})`,
      });
      statuses.set(index, "INVALID");
    }
    const structural = structuralViolation(kind, row);
    if (structural !== null) {
      pushFinding(report, {
        cls: "INVALID",
        eventTime: row.eventTime.toISOString(),
        detail: `${structural} (Instrument ${row.instrumentId})`,
      });
      statuses.set(index, "INVALID");
      drop.add(index);
      return;
    }
    // ── DUPLICATE: derselbe natürliche Schlüssel in einer Charge ──────────
    if (index > 0 && sorted[index - 1]!.eventTime.getTime() === row.eventTime.getTime()) {
      pushFinding(report, {
        cls: "DUPLICATE",
        eventTime: row.eventTime.toISOString(),
        detail: `${kind}-Zeilen mit identischer Ereigniszeit in einer Charge (Index ${index - 1}/${index})`,
      });
      statuses.set(index, "DUPLICATE");
      drop.add(index);
      return;
    }
    // ── OUTLIER: Bound-Verletzungen und Einheitensprünge ─────────────────
    if (kind === "funding") {
      const funding = row as PerpFundingRow;
      if (isFiniteNumber(funding.fundingRate) && Math.abs(funding.fundingRate) > config.maxAbsFundingRate) {
        pushFinding(report, {
          cls: "OUTLIER",
          eventTime: funding.eventTime.toISOString(),
          detail: `Funding-Rate ${funding.fundingRate} außerhalb des Bounds ±${config.maxAbsFundingRate} je Intervall`,
        });
        statuses.set(index, "OUTLIER");
      }
      if (
        isFiniteNumber(funding.intervalHours) &&
        (funding.intervalHours <= 0 || funding.intervalHours > 24)
      ) {
        pushFinding(report, {
          cls: "OUTLIER",
          eventTime: funding.eventTime.toISOString(),
          detail: `Funding-Intervall ${funding.intervalHours} h unplausibel (erwartet 0 < h <= 24)`,
        });
        statuses.set(index, "OUTLIER");
      }
    }
    if (kind === "openInterest") {
      const oi = row as PerpOpenInterestRow;
      if (
        (isFiniteNumber(oi.contracts) && oi.contracts < 0) ||
        (isFiniteNumber(oi.baseQuantity) && oi.baseQuantity < 0) ||
        (isFiniteNumber(oi.quoteValue) && oi.quoteValue < 0)
      ) {
        pushFinding(report, {
          cls: "INVALID",
          eventTime: oi.eventTime.toISOString(),
          detail: "Open Interest negativ — fachlich unmöglich (0 ist ein erlaubter Wert)",
        });
        statuses.set(index, "INVALID");
        drop.add(index);
        return;
      }
      const priorValue = index === 0 ? (input.priorOiValue ?? null) : measureOf(sorted[index - 1] as PerpOpenInterestRow);
      const value = measureOf(oi);
      if (isFiniteNumber(priorValue) && isFiniteNumber(value) && priorValue > 0) {
        const change = Math.abs(value - priorValue) / priorValue;
        if (change > config.maxOiChange) {
          pushFinding(report, {
            cls: "OUTLIER",
            eventTime: oi.eventTime.toISOString(),
            detail: `OI-Sprung ${(change * 100).toFixed(1)} % je Schritt (Bound ${(config.maxOiChange * 100).toFixed(1)} %) — Einheit/Ebene prüfen`,
          });
          statuses.set(index, "OUTLIER");
        }
      }
      const measures = [oi.contracts, oi.baseQuantity, oi.quoteValue].filter((v) => v !== null).length;
      if (measures > 1 && oi.converted !== true) {
        pushFinding(report, {
          cls: "INVALID",
          eventTime: oi.eventTime.toISOString(),
          detail: `${measures} OI-Größen gesetzt, aber converted=false — eine Ableitung wäre ununterscheidbar`,
        });
        statuses.set(index, "INVALID");
        drop.add(index);
        return;
      }
    }
    if (kind === "liquidations") {
      const liquidation = row as PerpLiquidationRow;
      const computed =
        isFiniteNumber(liquidation.quantityBase) && isFiniteNumber(liquidation.price)
          ? liquidation.quantityBase * liquidation.price
          : null;
      if (computed !== null && isFiniteNumber(liquidation.notionalQuote) && liquidation.notionalQuote > 0) {
        const deviation = Math.abs(computed - liquidation.notionalQuote) / liquidation.notionalQuote;
        if (deviation > 0.05) {
          pushFinding(report, {
            cls: "OUTLIER",
            eventTime: liquidation.eventTime.toISOString(),
            detail: `gemeldeter Notional weicht ${(deviation * 100).toFixed(1)} % von qty·price ab`,
          });
          statuses.set(index, "OUTLIER");
        }
      }
    }
    // ── GAP: fehlende erwartete Marks (nur Reihen mit Raster) ────────────
    if (expectedIntervalMs > 0 && index > 0) {
      const previous = sorted[index - 1]!;
      const delta = row.eventTime.getTime() - previous.eventTime.getTime();
      const missing = Math.floor(delta / expectedIntervalMs) - 1;
      if (missing >= 1) {
        for (let step = 1; step <= missing && gapsReported < 40; step += 1) {
          gapsReported += 1;
          pushFinding(report, {
            cls: "GAP",
            eventTime: new Date(previous.eventTime.getTime() + step * expectedIntervalMs).toISOString(),
            detail:
              `Lücke: ${missing} erwartete${missing === 1 ? "" : "n"} ${kind}-Mark${missing === 1 ? "" : "s"} ` +
              `zwischen ${previous.eventTime.toISOString()} und ${row.eventTime.toISOString()} ` +
              `(Raster ${Math.round(expectedIntervalMs / 60_000)} min)`,
          });
        }
      }
    }
  });

  // ── STALE: jüngster Satz älter als die Grenze der Reihe ────────────────
  const maxStale = config.maxStaleMs[kind];
  const latestIndex = sorted.length - 1;
  const latest = latestIndex >= 0 ? sorted[latestIndex]! : undefined;
  if (latest !== undefined && Number.isFinite(maxStale)) {
    // Gemessen wird das **Alter des jüngsten Ereignisses**, nicht der Abruf:
    // unter `available_at = ingested` wäre jeder Satz gerade eben verfügbar —
    // die Staleness-Grenze wäre damit wirkungslos und ein 40 h alter Satz würde
    // als frisch gelten. `availableAt` steuert die Sichtbarkeit (as-of), nie die
    // Frische.
    const ageMs = asOfMs - latest.eventTime.getTime();
    if (ageMs > maxStale) {
      pushFinding(report, {
        cls: "STALE",
        eventTime: latest.eventTime.toISOString(),
        detail: `jüngster ${kind}-Satz ${(ageMs / HOUR).toFixed(1)} h alt (Grenze ${(maxStale / HOUR).toFixed(1)} h)`,
      });
      if (!drop.has(latestIndex)) statuses.set(latestIndex, "STALE");
    }
  }

  const accepted = sorted.filter((_, index) => !drop.has(index));
  return { report, accepted, statuses };
}

/** Strukturregel einer Zeile (was die DB-CHECKs verlangen) — `null` = in Ordnung. */
function structuralViolation(kind: PerpSeriesKind, row: PerpAnyRow): string | null {
  if (row.eventTime.getTime() > row.availableAt.getTime()) {
    return "available_at vor event_time — das wäre Look-ahead in der as-of-Abfrage";
  }
  if (kind === "funding") {
    const funding = row as PerpFundingRow;
    if ((funding.fundingRate === null) === (funding.missingReason === null)) {
      return "Funding ohne Wert und ohne Grund (oder mit beidem)";
    }
    if (isFiniteNumber(funding.fundingRate) && Math.abs(funding.fundingRate) > 0.3) {
      return `Funding-Rate ${funding.fundingRate} jenseits der Venue-Kappe ±0.3`;
    }
    return null;
  }
  if (kind === "openInterest") {
    const oi = row as PerpOpenInterestRow;
    const hasMeasure = oi.contracts !== null || oi.baseQuantity !== null || oi.quoteValue !== null;
    if (hasMeasure === (oi.missingReason !== null)) return "OI ohne Messwert und ohne Grund (oder mit beidem)";
    if (oi.unit !== oi.basis) return `unit ${String(oi.unit)} widerspricht basis ${String(oi.basis)}`;
    if (oi.quoteValue !== null && (oi.quoteCurrency === null || oi.quoteCurrency === "")) {
      return "quote_value ohne quote_currency";
    }
    return null;
  }
  const liquidation = row as PerpLiquidationRow;
  if (liquidation.quantityBase === null && liquidation.notionalQuote === null) {
    return "Liquidation ohne Menge und ohne Notional";
  }
  if (liquidation.notionalQuote !== null && (liquidation.quoteCurrency === null || liquidation.quoteCurrency === "")) {
    return "notional_quote ohne quote_currency";
  }
  if (liquidation.side !== "LONG_LIQUIDATED" && liquidation.side !== "SHORT_LIQUIDATED") {
    return `unbekannte Liquidationsseite ${String(liquidation.side)}`;
  }
  if (isFiniteNumber(liquidation.quantityBase) && liquidation.quantityBase <= 0) return "quantity_base <= 0";
  if (isFiniteNumber(liquidation.price) && liquidation.price <= 0) return "price <= 0";
  return null;
}

/** Autoritative OI-Größe für die Änderungsprüfung (immer dieselbe Einheit). */
function measureOf(row: PerpOpenInterestRow): number | null {
  if (row.basis === "contracts") return row.contracts;
  if (row.basis === "base_units") return row.baseQuantity;
  return row.quoteValue;
}

/** Vergleichspaar für den Cross-Venue-Check (Base-Symbol, nicht Venue-Symbol). */
export interface PerpCrossCheckRow {
  venue: string;
  instrumentId: string;
  /** Vergleichsschlüssel (Base, z. B. `BTCUSDT` bereinigt). */
  underlyingSymbol: string;
  eventTime: Date;
  fundingRate: number | null;
}

/**
 * Cross-Venue-Prüfung (optional, `PERP_DATA_CROSSCHECK_VENUE`): vergleicht
 * Funding-Sätze desselben Settlements über zwei Venues.
 *
 * **Vorzeichenwechsel** ist immer ein Befund — die Richtung, wer zahlt, ist
 * keine Rundungsfrage, sondern eine andere Marktaussage. Beträge werden nur
 * oberhalb der Toleranz gemeldet (Venues handeln unterschiedliche Indizes, ein
 * Aufschlag von einigen Prozent ist normal). Keine Überlappung ⇒ kein Befund:
 * „kein Vergleich“ ist nicht „Abweichung“.
 */
export function crossCheckFunding(
  primary: readonly PerpCrossCheckRow[],
  secondary: readonly PerpCrossCheckRow[],
  options: { tolerance?: number } = {}
): PerpQualitySeriesReport[] {
  const tolerance = options.tolerance ?? 0.5;
  const byKey = new Map<string, PerpCrossCheckRow>();
  for (const row of secondary) {
    if (row.fundingRate === null) continue;
    byKey.set(`${row.underlyingSymbol}|${row.eventTime.getTime()}`, row);
  }
  const reports = new Map<string, PerpQualitySeriesReport>();
  for (const row of primary) {
    if (row.fundingRate === null) continue;
    const other = byKey.get(`${row.underlyingSymbol}|${row.eventTime.getTime()}`);
    if (!other || other.fundingRate === null || other.venue === row.venue) continue;
    const key = `${row.venue}|${row.instrumentId}`;
    let report = reports.get(key);
    if (report === undefined) {
      report = {
        venue: row.venue,
        instrumentId: row.instrumentId,
        kind: "funding",
        rows: 0,
        counts: emptyQualityCounts(),
        findings: [],
        crosscheckCompared: 0,
      };
      reports.set(key, report);
    }
    report.crosscheckCompared = (report.crosscheckCompared ?? 0) + 1;
    const signFlip =
      Math.sign(row.fundingRate) !== Math.sign(other.fundingRate) && row.fundingRate !== 0 && other.fundingRate !== 0;
    const magnitude =
      Math.abs(other.fundingRate) > 0
        ? Math.abs(row.fundingRate - other.fundingRate) / Math.abs(other.fundingRate)
        : Math.abs(row.fundingRate) > 0
          ? 1
          : 0;
    if (signFlip || magnitude > tolerance) {
      pushFinding(report, {
        cls: "CROSSCHECK",
        eventTime: row.eventTime.toISOString(),
        detail: signFlip
          ? `Vorzeichen der Funding-Rate weicht von ${other.venue} ab (${row.fundingRate} vs ${other.fundingRate})`
          : `Funding-Rate weicht ${(magnitude * 100).toFixed(1)} % von ${other.venue} ab (${row.fundingRate} vs ${other.fundingRate})`,
      });
    }
  }
  return [...reports.values()];
}

/** Summenreport eines Laufs (deterministisch sortiert — Artefakt-vergleichbar). */
export function buildPerpQualityReport(
  series: readonly PerpQualitySeriesReport[],
  mode: PerpQualityMode,
  bounds: PerpQualityReport["bounds"],
  now: Date = new Date()
): PerpQualityReport {
  const sorted = [...series].sort(
    (a, b) =>
      a.venue.localeCompare(b.venue) ||
      a.instrumentId.localeCompare(b.instrumentId) ||
      a.kind.localeCompare(b.kind)
  );
  const totals: PerpQualityReport["totals"] = { series: sorted.length, rows: 0, byClass: emptyQualityCounts() };
  for (const serie of sorted) {
    totals.rows += serie.rows;
    for (const cls of PERP_QUALITY_CLASSES) totals.byClass[cls] += serie.counts[cls] ?? 0;
  }
  return { writtenAt: now.toISOString(), mode, bounds, series: sorted, totals };
}

/** Grenzen aus der Konfiguration (Report-Kopf, reproduzierbar). */
export function perpQualityBounds(config: PerpConfig): PerpQualityReport["bounds"] {
  return {
    maxAbsFundingRate: config.maxAbsFundingRate,
    maxOiChange: config.maxOiChange,
    fundingIntervalMs: perpExpectedIntervalMs("funding", config),
    oiIntervalMs: perpExpectedIntervalMs("openInterest", config),
    maxStaleMs: {
      funding: Number.isFinite(config.maxStaleMs.funding) ? config.maxStaleMs.funding : -1,
      openInterest: Number.isFinite(config.maxStaleMs.openInterest) ? config.maxStaleMs.openInterest : -1,
      liquidations: Number.isFinite(config.maxStaleMs.liquidations) ? config.maxStaleMs.liquidations : -1,
    },
  };
}

/** Schreibt den Report atomar (tmp + rename, 0600). */
export function savePerpQualityReport(report: PerpQualityReport, file: string = PERP_QUALITY_REPORT_FILE): string {
  const resolved = resolveRuntimePath(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, resolved);
  return resolved;
}

/** Lädt den letzten Report (fehlend/korrupt → `null`, nie ein Wurf). */
export function loadPerpQualityReport(file: string = PERP_QUALITY_REPORT_FILE): PerpQualityReport | null {
  try {
    const resolved = resolveRuntimePath(file);
    if (!existsSync(resolved)) return null;
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Partial<PerpQualityReport>;
    if (!parsed || !Array.isArray(parsed.series) || !parsed.totals) return null;
    const series: PerpQualitySeriesReport[] = [];
    for (const entry of parsed.series) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<PerpQualitySeriesReport>;
      if (typeof candidate.instrumentId !== "string" || candidate.instrumentId === "") continue;
      if (candidate.kind !== "funding" && candidate.kind !== "openInterest" && candidate.kind !== "liquidations") {
        continue;
      }
      const counts = emptyQualityCounts();
      for (const cls of PERP_QUALITY_CLASSES) {
        const value = (candidate.counts as Record<string, unknown> | undefined)?.[cls];
        if (isFiniteNumber(value) && value >= 0) counts[cls] = Math.floor(value);
      }
      series.push({
        venue: typeof candidate.venue === "string" ? candidate.venue : "UNKNOWN",
        instrumentId: candidate.instrumentId,
        kind: candidate.kind,
        rows: isFiniteNumber(candidate.rows) && candidate.rows >= 0 ? Math.floor(candidate.rows) : 0,
        counts,
        findings: Array.isArray(candidate.findings) ? (candidate.findings as PerpQualityFinding[]) : [],
        crosscheckCompared: isFiniteNumber(candidate.crosscheckCompared)
          ? Math.floor(candidate.crosscheckCompared)
          : 0,
      });
    }
    const byClass = emptyQualityCounts();
    for (const cls of PERP_QUALITY_CLASSES) {
      const value = (parsed.totals.byClass as Record<string, unknown> | undefined)?.[cls];
      if (isFiniteNumber(value) && value >= 0) byClass[cls] = Math.floor(value);
    }
    return {
      writtenAt: typeof parsed.writtenAt === "string" ? parsed.writtenAt : "",
      mode: parsed.mode === "strict" ? "strict" : "log",
      // Fehlende bounds (Report aus älterer Version) ⇒ neutral dokumentieren,
      // erfinden: 0 heißt „keine Bound geprüft“, nicht „Bound verletzt“.
      bounds: parsed.bounds ?? {
        maxAbsFundingRate: 0,
        maxOiChange: 0,
        fundingIntervalMs: 0,
        oiIntervalMs: 0,
        maxStaleMs: { funding: 0, openInterest: 0, liquidations: 0 },
      },
      series,
      totals: {
        series: series.length,
        rows: series.reduce((sum, entry) => sum + entry.rows, 0),
        byClass,
      },
    };
  } catch {
    return null;
  }
}

/** Zählt die Befundklassen in die prozesslokale Metrik (Label: Klasse). */
export function recordPerpQualityFindings(report: PerpQualityReport): void {
  for (const cls of PERP_QUALITY_CLASSES) {
    const count = report.totals.byClass[cls] ?? 0;
    if (count > 0) telemetry.perp.qualityFindings.inc({ class: cls }, count);
  }
}

/**
 * Klassen, die im `strict`-Modus eine Reihe für den Consumer sperren.
 *
 * Bewusst **nur** Strukturverstöße (`INVALID`) und Schlüsselduplikate
 * (`DUPLICATE`): beides bedeutet, dass die Zeile nicht das ist, was sie zu
 * sein vorgibt. Ein `OUTLIER` kann ein echter Marktzustand sein (Funding-Crowd)
 * — ihn zu verstecken wäre schlimmer als ihn zu melden, deshalb bleibt er
 * lesbar und wird nur gezählt.
 */
export const PERP_STRICT_BLOCKING_CLASSES: readonly PerpQualityClass[] = ["INVALID", "DUPLICATE"] as const;

/** Reihenschlüssel (`instrumentId\u0000kind`) der im strict-Modus zu sperren ist. */
export function perpStrictSeriesKey(instrumentId: string, kind: PerpSeriesKind): string {
  return `${instrumentId}\u0000${kind}`;
}

/** Aus dem Report abgeleitete Sperrliste (leere Liste, wenn Modus `log`). */
export function perpStrictBlockedSeries(report: PerpQualityReport | null): Set<string> {
  const blocked = new Set<string>();
  if (report === null || report.mode !== "strict") return blocked;
  for (const serie of report.series) {
    for (const cls of PERP_STRICT_BLOCKING_CLASSES) {
      if ((serie.counts[cls] ?? 0) > 0) {
        blocked.add(perpStrictSeriesKey(serie.instrumentId, serie.kind));
        break;
      }
    }
  }
  return blocked;
}
