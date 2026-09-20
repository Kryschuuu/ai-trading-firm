/**
 * Normalisierung der Perpetual-Rohformen (RMA-P2-02) — Einheiten, Vorzeichen,
 * Zeitachsen und die „null ≠ 0“-Regel.
 *
 * Diese Suite ist die **einzige**, die die Venue-Formate direkt gegen die
 * kanonische Zeile stellt. Alles, was hier durchrutscht (ein Prozentwert als
 * Dezimalanteil, ein Sekunden-Epochenwert als Millisekunde, ein negatives Open
 * Interest als „0“), ist später in Ablage, Backtest und Scanner nicht mehr
 * unterscheidbar. Deshalb wird je Regel genau ein Verhalten geprüft — und zwar
 * das dokumentierte, nicht das, was der Code zufällig liefert.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PERP_TIME_BOUNDS,
  computeAvailableAt,
  normalizeBatch,
  normalizeFundingRow,
  normalizeLiquidationRow,
  normalizeOpenInterestRow,
  perpContentHash,
  perpRowKey,
  toEpochMs,
  toFiniteNumber,
  type PerpNormalizeContext,
} from "../src/perpdata/normalize";

/** Feste Bezugspunkte — keine Wanduhr (deterministische Wiedergabe). */
const FETCHED_AT = new Date("2026-09-20T12:00:00.000Z");
const T = Date.parse("2026-09-20T08:00:00.000Z");
const INTERVAL_MS = 8 * 3_600_000;

function ctx(overrides: Partial<PerpNormalizeContext> = {}): PerpNormalizeContext {
  return {
    venue: "SIM",
    instrumentId: "SIM:BTCUSDT",
    symbol: "BTCUSDT",
    sourceId: "sim:v1",
    fetchedAt: FETCHED_AT,
    availabilityPolicy: "ingested",
    maxAbsFundingRate: 0.0075,
    ...overrides,
  };
}

describe("perp normalize: FundingRate", () => {
  it("bewahrt Vorzeichen und Interpretation (positiv = Longs zahlen)", () => {
    const negative = normalizeFundingRow({ eventTime: T, fundingRate: "-0.000125", intervalHours: 8 }, 0, ctx());
    const positive = normalizeFundingRow({ eventTime: T + INTERVAL_MS, fundingRate: 0.000125, intervalHours: 8 }, 1, ctx());
    assert.equal(negative.row?.fundingRate, -0.000125);
    assert.equal(positive.row?.fundingRate, 0.000125);
    assert.equal(negative.row?.unit, "fraction_per_interval");
    assert.equal(negative.row?.qualityStatus, "OK");
    assert.equal(negative.row?.missingReason, null);
  });

  it("rechnet Prozentform auf den Dezimalanteil (0.0375 % → 0.000375)", () => {
    const row = normalizeFundingRow({ eventTime: T, fundingRatePct: "0.0375", intervalHours: 4 }, 0, ctx());
    assert.equal(row.row?.fundingRate, 0.000375);
    assert.equal(row.row?.intervalHours, 4, "das gemeldete Raster bleibt je Satz erhalten");
  });

  it("verwirft Out-of-Bounds-Sätze als null + INVALID + Grund (nicht als 0)", () => {
    const row = normalizeFundingRow({ eventTime: T, fundingRate: 0.2, intervalHours: 8 }, 0, ctx());
    assert.equal(row.row?.fundingRate, null);
    assert.equal(row.row?.qualityStatus, "INVALID");
    assert.equal(row.row?.missingReason, "OUT_OF_BOUNDS");
    assert.ok(row.row?.eventTime, "die Zeile bleibt als Ereignis erhalten (Löcher bleiben sichtbar)");
  });

  it("akzeptiert Sekunden-Epochen nur, wenn der Adapter sie deklariert", () => {
    const declared = normalizeFundingRow({ eventTime: Math.floor(T / 1000), fundingRate: 0.0001 }, 0, ctx({ epochUnit: "s" }));
    assert.equal(declared.row?.eventTime.getTime(), Math.floor(T / 1000) * 1000);
    // Undeklariert: ein Sekundenwert ist kein zulässiger Millisekunden-Zeitpunkt.
    const undeclared = normalizeFundingRow({ eventTime: Math.floor(T / 1000), fundingRate: 0.0001 }, 1, ctx());
    assert.equal(undeclared.rejected?.reason, "EVENT_TIME_OUT_OF_RANGE");
    assert.equal(undeclared.row, undefined);
  });

  it("ohne Satz bleibt die Zeile UNKNOWN + NOT_REPORTED (kein Default 0)", () => {
    const row = normalizeFundingRow({ eventTime: T }, 0, ctx());
    assert.equal(row.row?.fundingRate, null);
    assert.equal(row.row?.qualityStatus, "UNKNOWN");
    assert.equal(row.row?.missingReason, "NOT_REPORTED");
  });

  it("lehnt fehlende und in der Zukunft liegende Ereigniszeiten ab", () => {
    assert.equal(normalizeFundingRow({ eventTime: null, fundingRate: 0.0001 }, 0, ctx()).rejected?.reason, "MISSING_EVENT_TIME");
    const farFuture = FETCHED_AT.getTime() + PERP_TIME_BOUNDS.maxSkewMs + 60_000;
    assert.equal(normalizeFundingRow({ eventTime: farFuture, fundingRate: 0.0001 }, 1, ctx()).rejected?.reason, "EVENT_TIME_OUT_OF_RANGE");
  });

  it("nutzt für die Zukunftsschranke die injizierte Abrufzeit, nicht die Wanduhr", () => {
    // Replay eines alten Fensters: `fetchedAt` 2020, Satz 2020 + 1 h. Gegen die
    // echte Wanduhr wäre das „Jahrhunderte in der Vergangenheit“, gegen
    // `fetchedAt` ein völlig normaler Satz.
    const fetchedAt = new Date("2020-01-01T00:00:00.000Z");
    const row = normalizeFundingRow({ eventTime: Date.parse("2020-01-01T01:00:00.000Z"), fundingRate: 0.0001 }, 0, ctx({ fetchedAt }));
    assert.equal(row.row?.eventTime.getTime(), Date.parse("2020-01-01T01:00:00.000Z"));
    // Umgekehrt: ein Satz jenseits der Toleranz **relativ zu fetchedAt** muss
    // abgewiesen werden, auch wenn die Wanduhr längst weitergelaufen ist.
    const future = normalizeFundingRow({ eventTime: Date.parse("2020-01-05T00:00:00.000Z"), fundingRate: 0.0001 }, 1, ctx({ fetchedAt }));
    assert.equal(future.rejected?.reason, "EVENT_TIME_OUT_OF_RANGE");
  });

  it("nextFundingTime wird getragen, Mark-Preis gerundet", () => {
    const row = normalizeFundingRow(
      { eventTime: T, fundingRate: 0.0001, intervalHours: 8, nextFundingTime: T + INTERVAL_MS, markPrice: "66286.6123456789" },
      0,
      ctx()
    );
    assert.equal(row.row?.nextFundingTime?.getTime(), T + INTERVAL_MS);
    assert.equal(row.row?.markPrice, 66286.61234568);
  });
});

describe("perp normalize: Open Interest", () => {
  it("negativer Wert ⇒ Messgröße raus, Rest bleibt belegtbar und markiert", () => {
    const row = normalizeOpenInterestRow(
      { eventTime: T, contracts: -5, baseQuantity: 12.5, quoteValue: 825_000, basis: "base_units", quoteCurrency: "USDT" },
      0,
      ctx()
    );
    assert.equal(row.row?.contracts, null, "der fachlich unmögliche Wert wird nicht gespeichert");
    assert.equal(row.row?.baseQuantity, 12.5, "ein einzelner Ausreißer vernichtet keine saubere Zeile");
    assert.equal(row.row?.qualityStatus, "INVALID", "der Befund bleibt an der Zeile sichtbar");
    assert.equal(row.row?.basis, "base_units", "die deklarierte Autorität bleibt erhalten");
    // Wert XOR Grund ist Ablagevertrag (CHECK `perp_open_interest_*`): eine
    // markierte Zeile mit Messwert darf nie zusätzlich einen Missing-Grund tragen.
    assert.equal(row.row?.missingReason, null);
    assert.equal(row.rejected, undefined);
  });

  it("nur negative Messgröße ⇒ qualifizierter Abweis mit INVALID_MEASURE", () => {
    const row = normalizeOpenInterestRow({ eventTime: T, contracts: -5, basis: "contracts" }, 0, ctx());
    assert.equal(row.row, undefined, "nichts Messbares ⇒ keine Zeile, keine 0");
    assert.equal(row.rejected?.reason, "INVALID_MEASURE");
    assert.match(String(row.rejected?.detail), /negativ/i);
  });

  it("rechnet Contracts ↔ Basis ↔ Quote nur mit bekannter Kontraktgröße", () => {
    const withSize = normalizeOpenInterestRow(
      { eventTime: T, contracts: 100, contractSize: 0.001, markPrice: 66_000 },
      0,
      ctx({ quoteCurrency: "USDT" })
    );
    assert.equal(withSize.row?.baseQuantity, 0.1);
    assert.equal(withSize.row?.quoteValue, 6600);
    assert.equal(withSize.row?.converted, true);
    assert.equal(withSize.row?.basis, "contracts", "die autoritative Einheit bleibt die gemeldete");

    const withoutSize = normalizeOpenInterestRow({ eventTime: T, contracts: 100, markPrice: 66_000 }, 1, ctx({ quoteCurrency: "USDT" }));
    assert.equal(withoutSize.row?.baseQuantity, null, "ohne Kontraktgröße wird NICHT geraten");
    assert.equal(withoutSize.row?.converted, false);
  });

  it("Quote-Wert ohne Währungscode ist nicht interpretierbar ⇒ Abweis, null + Grund wäre unverstellbar", () => {
    const row = normalizeOpenInterestRow({ eventTime: T, quoteValue: 5000 }, 0, ctx());
    assert.equal(row.row, undefined, "basis NOT NULL + Wert-CHECK lassen eine leere Zeile nicht zu");
    assert.equal(row.rejected?.reason, "NO_MEASURE");
    // Mit Währungscode dagegen ist die Zeile vollständig.
    const withCurrency = normalizeOpenInterestRow({ eventTime: T, quoteValue: 5000, quoteCurrency: "USDT" }, 1, ctx());
    assert.equal(withCurrency.row?.quoteValue, 5000);
    assert.equal(withCurrency.row?.basis, "quote_units");
    assert.equal(withCurrency.row?.qualityStatus, "OK");
  });

  it("mischt die Venue Einheiten, entscheidet die deklarierte Basis", () => {
    const declared = normalizeOpenInterestRow(
      { eventTime: T, contracts: 100, baseQuantity: 0.5, basis: "base_units", contractSize: 0.005, quoteCurrency: "USDT", markPrice: 66_000 },
      0,
      ctx()
    );
    assert.equal(declared.row?.basis, "base_units");
    assert.equal(declared.row?.unit, "base_units");
    assert.equal(declared.row?.contracts, 100, "gemessene Werte werden nicht überschrieben");
    assert.equal(declared.row?.baseQuantity, 0.5);
    assert.equal(declared.row?.quoteValue, 33_000, "die fehlende Quote wird aus Basis × Marktpreis abgeleitet");
    assert.equal(declared.row?.converted, true, "und die Ableitung ist als solche markiert");
  });
});

describe("perp normalize: Liquidationen", () => {
  it("kanonisiert Order-Richtung auf die betroffene Positionsseite", () => {
    const sell = normalizeLiquidationRow({ eventTime: T, side: "SELL", quantityBase: 0.5, price: 66_000 }, 0, ctx({ quoteCurrency: "USDT" }));
    const buy = normalizeLiquidationRow({ eventTime: T + 1000, side: "BUY", quantityBase: 0.5, price: 66_000 }, 1, ctx({ quoteCurrency: "USDT" }));
    assert.equal(sell.row?.side, "LONG_LIQUIDATED", "ein Verkaufs-Fill liquidiert eine Long-Position");
    assert.equal(buy.row?.side, "SHORT_LIQUIDATED");
    assert.equal(sell.row?.notionalQuote, 33_000, "Notional aus Menge × Preis abgeleitet");
  });

  it("übernimmt gemeldete Positionsseiten unverändert", () => {
    const row = normalizeLiquidationRow({ eventTime: T, side: "SHORT", quantityBase: 2, price: 1_000, notionalQuote: 2_000, quoteCurrency: "USDT", sideIsPosition: true }, 0, ctx());
    assert.equal(row.row?.side, "SHORT_LIQUIDATED");
  });

  it("zwei Ereignisse derselben Sekunde sind zwei Zeilen (Quell-ID im Inhalt)", () => {
    const a = normalizeLiquidationRow({ eventTime: T, side: "BUY", quantityBase: 1, price: 100, sourceEventId: "77" }, 0, ctx());
    const b = normalizeLiquidationRow({ eventTime: T, side: "BUY", quantityBase: 1, price: 100, sourceEventId: "78" }, 1, ctx());
    assert.notEqual(a.row?.contentHash, b.row?.contentHash);
    assert.notEqual(
      perpRowKey({ kind: "liquidations", venue: "SIM", instrumentId: "SIM:BTCUSDT", eventTime: a.row!.eventTime, sourceEventId: a.row!.sourceEventId }),
      perpRowKey({ kind: "liquidations", venue: "SIM", instrumentId: "SIM:BTCUSDT", eventTime: b.row!.eventTime, sourceEventId: b.row!.sourceEventId })
    );
    const batch = normalizeBatch([
      { eventTime: T, side: "BUY", quantityBase: 1, price: 100, sourceEventId: "77" },
      { eventTime: T, side: "BUY", quantityBase: 1, price: 100, sourceEventId: "78" },
    ] as never[], ((raw: never, index: number) => normalizeLiquidationRow(raw, index, ctx())) as never, { limit: 500 });
    assert.equal(batch.rows.length, 2, "kein Verschmelzen zweier echter Ereignisse");
    assert.equal(batch.duplicates, 0);
  });
});

describe("perp normalize: Batch, Schlüssel und Zeitachse", () => {
  it("dedupliziert denselben Schlüssel und meldet die Kappung", () => {
    const rows = [
      { eventTime: T, fundingRate: 0.0001 },
      { eventTime: T, fundingRate: 0.0002 },
      { eventTime: T + INTERVAL_MS, fundingRate: 0.0003 },
    ];
    const batch = normalizeBatch(rows as never[], ((raw: never, index: number) => normalizeFundingRow(raw, index, ctx())) as never, { limit: 2 });
    assert.equal(batch.duplicates, 1, "gleicher Schlüssel ⇒ ein Satz, der zweite gezählt");
    assert.equal(batch.truncated, true, "mehr Zeilen als `limit` ⇒ gemeldet, nicht verschluckt");
    assert.deepEqual(batch.rejected.map((entry) => entry.reason), ["TRUNCATED"]);
    assert.equal(batch.rows.length, 1);
  });

  it("identischer Schlüssel + identischer Inhalt ⇒ identischer Hash (Revisionen sind Abweichungen)", () => {
    const a = normalizeFundingRow({ eventTime: T, fundingRate: 0.0001, intervalHours: 8 }, 0, ctx());
    const b = normalizeFundingRow({ eventTime: T, fundingRate: 0.0001, intervalHours: 8 }, 1, ctx());
    assert.equal(a.row?.contentHash, b.row?.contentHash);
    assert.equal(a.row?.contentHash, perpContentHash({
      kind: "funding",
      instrumentId: "SIM:BTCUSDT",
      eventTime: new Date(T).toISOString(),
      rate: 0.0001,
      intervalHours: 8,
      markPrice: null,
      schemaVersion: 1,
    }));
    assert.match(String(a.row?.contentHash), /^pv1:[0-9a-f]{64}$/);
  });

  it("availableAt folgt der Politik: ingested = max(Ereignis, Abruf), settlement = Ereignis", () => {
    assert.equal(computeAvailableAt(T, FETCHED_AT, "ingested").getTime(), FETCHED_AT.getTime());
    const later = FETCHED_AT.getTime() + 60_000;
    assert.equal(computeAvailableAt(later, FETCHED_AT, "ingested").getTime(), later, "ein Satz nach dem Abruf bleibt später verfügbar");
    assert.equal(computeAvailableAt(T, FETCHED_AT, "settlement").getTime(), T);
  });

  it("tolert numerische Strings und lehnt Nicht-Zahlen ab", () => {
    assert.equal(toFiniteNumber("0.000125"), 0.000125);
    assert.equal(toFiniteNumber("1e-4"), 0.0001);
    assert.equal(toFiniteNumber(""), null);
    assert.equal(toFiniteNumber("12abc"), null);
    assert.equal(toFiniteNumber(Number.NaN), null);
    assert.equal(toEpochMs(null, "ms", FETCHED_AT.getTime()), null);
  });
});
