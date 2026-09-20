/**
 * Funding-Replay über die kanonische Historie (RMA-P2-02).
 *
 * Der Paper-Monitor akkumuliert Funding **ab jetzt** (Periodenwechsel seit dem
 * letzten Tick). Für Backtest und Post-Mortem ist das zu wenig: dort soll
 * belegt werden, welche Sätze in einem vergangenen Fenster *fällig waren und
 * zu diesem Zeitpunkt bekannt sein durften*. Genau das ist dieses Modul — und
 * es verwendet **dieselbe Formel** wie der Live-Pfad
 * (`src/lib/funding.ts::computeFunding`), statt eine zweite zu etablieren.
 *
 * ── Was gebucht wird ───────────────────────────────────────────────────────
 * Ein Settlement wird gebucht, wenn alle vier Bedingungen gelten:
 *
 *   1. `openedAtMs < event_time <= asOfMs`      (Intervall lag innerhalb der
 *                                                 Haltedauer der Position),
 *   2. `available_at <= asOfMs`                  (der Satz durfte zu `asOf`
 *                                                 schon bekannt sein),
 *   3. `funding_rate IS NOT NULL`                (kein Grund-Feld),
 *   4. die Position ist ein Perpetual            (Spot zahlt kein Funding).
 *
 * Alles andere wird **nicht** gebucht und nicht erfunden: ein fehlendes
 * Settlement erscheint in `missingMarks` (Lücke im Raster) und die Antwort
 * bleibt `PARTIAL`. Ein Replay mit `MISSING`-Verfügbarkeit bucht null
 * Accruals und meldet den Grund — es liefert keine „0 Kosten“-Aussage, die
 * wie ein günstiger Markt aussähe.
 *
 * ── Einheitenumrechnung ────────────────────────────────────────────────────
 * Kanonisch ist die Rate **je Intervall** (`fraction_per_interval`). Die
 * Engine rechnet mit `ratePer8h` und skaliert selbst auf ihr Konfigurations-
 * intervall. Die Übersetzung ist deshalb exakt eine Division/Multiplikation:
 *
 *     ratePer8h = fundingRate · (8 / intervalHours)
 *
 * mit `intervalHours` aus der **Zeile** (venue-gemeldet) und Fallback auf das
 * konfigurierte Raster. 4h-Venues liefern damit die doppelte 8h-Äquivalentrate
 * — was zwei 4h-Settlements pro 8h entspricht, kein Rundungs-trick.
 */
import { computeFunding, type FundingConfig } from "../lib/funding";
import type { PerpFundingRow, PerpSeriesKind, PerpSeriesQuery } from "./types";
import { PERP_LIMITS, perpRowIsAttestable } from "./types";
import type { PerpSeriesSource } from "./ports";
import type { PerpConfig } from "./config";

/** Eine Position, für die repliert wird. */
export interface PerpReplayPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  /** Einstiegspreis (Notional-Basis wie im Paper-Ledger). */
  price: number;
  openedAtMs: number;
  /** Optional: Schließzeit — dann endet das Replay hier (nicht bei `asOfMs`). */
  closedAtMs?: number | null;
  isPerpetual?: boolean;
}

/** Einzelner gebuchter Accrual (identische Feldbedeutung wie `FundingAccrual`). */
export interface PerpReplayEntry {
  symbol: string;
  side: "LONG" | "SHORT";
  /** Satz je Intervall, wie gespeichert (Vorzeichen: > 0 = Longs zahlen). */
  fundingRate: number;
  /** Auf 8h umgerechnete Rate (was die Engine verbraucht). */
  ratePer8h: number;
  /** Intervall dieses Settlements (Stunden). */
  intervalHours: number;
  /** Settlement-Zeit (ISO). */
  eventTime: string;
  /** Ab wann der Satz bekannt sein durfte (ISO). */
  availableAt: string;
  notional: number;
  /** Cashflow aus Kontosicht (negativ = gezahlt) — `computeFunding`-Semantik. */
  funding: number;
  /** `true` = Satz war belastet (OUTLIER/GAP/…), aber vorhanden. */
  qualityFlagged: boolean;
}

/** Ergebnis eines Replays. */
export interface PerpReplayResult {
  availability: "AVAILABLE" | "PARTIAL" | "MISSING" | "UNAVAILABLE";
  reason: string;
  entries: PerpReplayEntry[];
  /** Summe der Accruals (Kontosicht, negativ = gezahlt). */
  totalFunding: number;
  /** Erwartete, aber fehlende Settlements im Replay-Fenster (ISO). */
  missingMarks: string[];
  /** Verworfene Zeilen, weil erst nach `asOfMs` verfügbar (Look-ahead-Schutz). */
  hiddenRows: number;
  /** Verworfene Zeilen außerhalb der Haltedauer. */
  outsideHoldingRows: number;
  /**
   * Verworfene Sätze wegen der Qualitätsschicht: unbelegbare Befunde
   * (INVALID/DUPLICATE/CROSSCHECK/UNKNOWN) immer, in `strictQuality` zusätzlich
   * GAP/STALE/OUTLIER. Ein Ausschluss, der zählt, ist kein Ausschluss ins Nichts.
   */
  qualityFlagged: number;
  asOf: string;
}

/** Übersetzt eine gespeicherte Rate in die 8h-Größe der Engine. */
export function fundingRateTo8h(
  fundingRate: number,
  rowIntervalHours: number | null,
  defaultIntervalHours: number
): { ratePer8h: number; intervalHours: number } {
  const intervalHours =
    rowIntervalHours !== null && Number.isFinite(rowIntervalHours) && rowIntervalHours > 0
      ? rowIntervalHours
      : defaultIntervalHours;
  return { ratePer8h: fundingRate * (8 / intervalHours), intervalHours };
}

/**
 * Reines Replay über bereits gelesene Zeilen (ohne IO — deterministisch testbar).
 *
 * `rows` muss **nicht** vorfiltriert sein: `eventTime`/`availableAt`-Grenzen
 * werden hier nochmals geprüft (defensive Tiefe), damit ein Aufrufer, der eine
 * vollständige Historie hineingibt, nicht versehentlich in die Zukunft schaut.
 */
export function computeReplayAccruals(
  position: PerpReplayPosition,
  rows: readonly PerpFundingRow[],
  options: { asOfMs: number; defaultIntervalHours: number; strictQuality?: boolean }
): PerpReplayResult {
  const asOfMs = Math.floor(options.asOfMs);
  const endMs = Math.floor(
    position.closedAtMs !== undefined && position.closedAtMs !== null
      ? Math.min(position.closedAtMs, asOfMs)
      : asOfMs
  );
  const entries: PerpReplayEntry[] = [];
  const seen = new Set<string>();
  let hiddenRows = 0;
  let outsideHoldingRows = 0;
  let qualityFlagged = 0;

  const sorted = [...rows].sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime());
  for (const row of sorted) {
    if (row.availableAt.getTime() > asOfMs) {
      hiddenRows += 1;
      continue;
    }
    const eventMs = row.eventTime.getTime();
    if (eventMs <= position.openedAtMs || eventMs > endMs) {
      outsideHoldingRows += 1;
      continue;
    }
    if (row.fundingRate === null) continue;
    // Zwei Stufen: unbelegbare Sätze (INVALID/DUPLICATE/CROSSCHECK/UNKNOWN)
    // werden **immer** verworfen — eine Rate, die die Qualitätsschicht
    // anzweifelt, darf einen Posten in einem P&L-Pfad erzeugen. `strictQuality`
    // verschärft das auf „nur OK“ (GAP/STALE/OUTLIER fallen dann ebenfalls raus).
    if (!perpRowIsAttestable(row) || (options.strictQuality === true && row.qualityStatus !== "OK")) {
      qualityFlagged += 1;
      continue;
    }
    const { ratePer8h, intervalHours } = fundingRateTo8h(
      row.fundingRate,
      row.intervalHours,
      options.defaultIntervalHours
    );
    // DIESELBE Formel wie der Live-Tick — nur mit historischer Rate.
    const config: Pick<FundingConfig, "intervalHours"> = { intervalHours };
    const computed = computeFunding(
      { side: position.side, qty: position.qty, price: position.price },
      config,
      ratePer8h
    );
    if (computed === null) continue;
    const key = row.eventTime.toISOString();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      symbol: position.symbol.toUpperCase(),
      side: position.side,
      fundingRate: row.fundingRate,
      ratePer8h,
      intervalHours,
      eventTime: key,
      availableAt: row.availableAt.toISOString(),
      notional: computed.notional,
      funding: Number(computed.funding.toFixed(8)),
      qualityFlagged: row.qualityStatus !== "OK",
    });
  }

  const covered = entries.map((entry) => Date.parse(entry.eventTime)).sort((a, b) => a - b);
  const missingMarks: string[] = [];
  if (entries.length > 1) {
    const stepMs = Math.round(options.defaultIntervalHours * 3_600_000);
    for (let index = 1; index < covered.length; index += 1) {
      const gap = covered[index]! - covered[index - 1]!;
      const missing = Math.floor(gap / stepMs) - 1;
      for (let step = 1; step <= Math.min(missing, 200); step += 1) {
        missingMarks.push(new Date(covered[index - 1]! + step * stepMs).toISOString());
      }
    }
  }
  const totalFunding = Number(entries.reduce((sum, entry) => sum + entry.funding, 0).toFixed(8));
  const availability: PerpReplayResult["availability"] =
    entries.length === 0
      ? rows.length === 0
        ? "MISSING"
        : "MISSING"
      : missingMarks.length > 0 || hiddenRows > 0 || qualityFlagged > 0
        ? "PARTIAL"
        : "AVAILABLE";
  const reason =
    availability === "AVAILABLE"
      ? "OK"
      : availability === "PARTIAL"
        ? missingMarks.length > 0
          ? "FUNDING_HISTORY_INCOMPLETE"
          : hiddenRows > 0
            ? "ROWS_NOT_YET_AVAILABLE_AT_AS_OF"
            : "ROWS_REJECTED_BY_QUALITY"
        : rows.length === 0
          ? "NO_FUNDING_ROWS_AS_OF"
          : "NO_DUE_INTERVAL_IN_HOLDING_PERIOD";
  return {
    availability,
    reason,
    entries,
    totalFunding,
    missingMarks,
    hiddenRows,
    outsideHoldingRows,
    qualityFlagged,
    asOf: new Date(asOfMs).toISOString(),
  };
}

/**
 * Replay gegen die Ablage (as-of-gefiltert, begrenzt).
 *
 * Die Lesegrenze ist `PERP_LIMITS.queryRowsPerSeries`; reicht sie nicht, ist
 * das Ergebnis `PARTIAL` mit Grund `REPLAY_WINDOW_TRUNCATED` — ein Replay, das
 * still schweigt, wäre schlimmer als keines.
 */
export async function replayPositionFunding(
  source: PerpSeriesSource,
  input: {
    venue: string;
    instrumentId: string;
    position: PerpReplayPosition;
    asOfMs: number;
    /** Untere Fenster Grenze (Default: `openedAtMs − ein Intervall`). */
    fromMs?: number | null;
    config: PerpConfig;
    qualityMode?: "log" | "strict";
  }
): Promise<PerpReplayResult & { truncated: boolean }> {
  const defaultIntervalHours = input.config.fundingIntervalHours;
  const fromMs = input.fromMs ?? input.position.openedAtMs - defaultIntervalHours * 3_600_000;
  const query: PerpSeriesQuery = {
    venue: input.venue,
    instrumentIds: [input.instrumentId],
    kinds: ["funding"] as readonly PerpSeriesKind[],
    fromMs,
    toMs: input.asOfMs,
    asOfMs: input.asOfMs,
    limit: PERP_LIMITS.queryRowsPerSeries,
    qualityMode: input.qualityMode ?? input.config.qualityMode,
  };
  const rows = await source.readFunding(query);
  const withinLimit = rows.length > query.limit ? rows.slice(rows.length - query.limit) : rows;
  const result = computeReplayAccruals(input.position, withinLimit, {
    asOfMs: input.asOfMs,
    defaultIntervalHours,
    ...(input.qualityMode === "strict" || input.config.qualityMode === "strict" ? { strictQuality: true } : {}),
  });
  const truncated = rows.length > query.limit;
  return {
    ...result,
    availability: truncated && result.availability === "AVAILABLE" ? "PARTIAL" : result.availability,
    reason: truncated ? "REPLAY_WINDOW_TRUNCATED" : result.reason,
    truncated,
  };
}
