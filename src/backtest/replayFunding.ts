/**
 * Funding-Ereignisse für den Event-Replay-Pfad (RMA-P1-01, v1.58.0).
 *
 * Übersetzt kanonische `perp_funding_rates`-Zeilen (RMA-P2-02,
 * `src/perpdata`) in punktgenaue `FUNDING_DUE`-Ereignisse des Replayers:
 *
 *   - `eventTime`   = Settlement-Zeit der Zeile (Ereigniszeit).
 *   - `availableAt` = `availableAt` der Zeile (Politik `ingested`/`settlement`
 *                     aus `PERP_AVAILABILITY_POLICY`) — der Replayer bucht ein
 *                     Funding-Ereignis erst, wenn es bekannt sein DURFTE.
 *   - `ratePer8h`   = gespeicherte Intervall-Rate × (8 / Intervallstunden) —
 *                     dieselbe Skalierung wie `fundingRateTo8h`
 *                     (`src/perpdata/replay.ts`). Vorzeichen: > 0 = Longs
 *                     zahlen (kanonische Konvention, docs/PERPETUAL_DATA.md).
 *
 * Fail-closed: Zeilen ohne Rate (`fundingRate === null`), mit nicht
 * belegbarer Qualität (Aufrufer filtert via `perpRowIsAttestable`) oder mit
 * unsinnigem Intervall werden NICHT in Ereignisse übersetzt, sondern gezählt
 * zurückgemeldet — fehlendes Funding wird nie still als 0 gebucht, es fehlt
 * SICHTBAR (Coverage `fundingEvents` + `skipped`-Zähler des Loaders).
 */

import { fundingRateTo8h } from "../perpdata/replay";
import type { PerpFundingRow } from "../perpdata/types";
import { REPLAY_FUNDING_BOUNDS, type FundingDueEvent } from "./replayEvents";

export interface ReplayFundingConversion {
  events: FundingDueEvent[];
  /** Zeilen ohne Rate/mit ungültigem Intervall/außerhalb der Bounds. */
  skipped: number;
}

/**
 * Wandelt attestierbare Funding-Zeilen EINES Instruments in
 * `FUNDING_DUE`-Ereignisse um. `engineSymbol` ist das Symbol, unter dem die
 * Engine das Instrument führt (z. B. `BITUNIX:BTCUSDT`).
 */
export function perpFundingRowsToReplayEvents(args: {
  engineSymbol: string;
  venue: string;
  rows: readonly PerpFundingRow[];
  defaultIntervalHours: number;
}): ReplayFundingConversion {
  const events: FundingDueEvent[] = [];
  let skipped = 0;
  for (const row of args.rows) {
    if (row.fundingRate === null || !Number.isFinite(row.fundingRate)) {
      skipped++;
      continue;
    }
    const { ratePer8h, intervalHours } = fundingRateTo8h(
      row.fundingRate,
      row.intervalHours,
      args.defaultIntervalHours
    );
    if (
      !Number.isFinite(ratePer8h) ||
      ratePer8h < REPLAY_FUNDING_BOUNDS.ratePer8h.min ||
      ratePer8h > REPLAY_FUNDING_BOUNDS.ratePer8h.max ||
      intervalHours < REPLAY_FUNDING_BOUNDS.intervalHours.min ||
      intervalHours > REPLAY_FUNDING_BOUNDS.intervalHours.max
    ) {
      skipped++;
      continue;
    }
    const eventTime = row.eventTime.getTime();
    const availableAt = row.availableAt.getTime();
    if (!Number.isInteger(eventTime) || eventTime <= 0 || availableAt < eventTime) {
      skipped++;
      continue;
    }
    events.push({
      type: "FUNDING_DUE",
      symbol: args.engineSymbol.toUpperCase(),
      venue: args.venue.toUpperCase(),
      eventTime,
      availableAt,
      ratePer8h,
      intervalHours,
    });
  }
  return { events, skipped };
}
