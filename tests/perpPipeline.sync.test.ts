/**
 * Sync der Perpetual-Reihen (RMA-P2-02): Backfill ohne Duplikate,
 * inkrementeller Retry, Capability-Unterscheidung, Qualität, harte Grenzen.
 *
 * Der Test läuft gegen den **Fixture-Adapter** und die **Speicher-Ablage** —
 * dieselbe Kette, die im Produktbetrieb die Postgres-Ablage füllt. Ein echter
 * Venue-Lauf ist hier nicht möglich (kein Netz im CI); die Adapter-Grenze wird
 * über `FixturePerpProfile` verschoben, wo ein Verhalten geprüft werden soll,
 * das nur eine Venue liefert (Löcher, negative Werte, fehlende Reihen,
 * Rate-Limit-Fehler). Die Ablage-Idempotenz gegen Postgres selbst steht in
 * `tests/perpPipeline.db.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadPerpConfig } from "../src/perpdata/config";
import { InMemoryPerpStore } from "../src/perpdata/memoryStore";
import { SIM_PERP_VENUE, createFixturePerpAdapter, type FixturePerpProfile } from "../src/perpdata/adapters/fixture";
import { aggregatePerpSyncResults, selectPerpInstruments, syncPerpVenue } from "../src/perpdata/sync";
import { crossCheckFunding, validatePerpSeries } from "../src/perpdata/quality";
import { normalizeFundingRow, normalizeOpenInterestRow, type PerpNormalizeContext } from "../src/perpdata/normalize";
import { PERP_LIMITS } from "./perpPipeline.helpers";
import type { MarketInstrument } from "../src/universe/types";
import type { PerpDataAdapter, PerpFetchResult, PerpRawFundingRowAlias } from "./perpPipeline.helpers";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR = 3_600_000;
const INTERVAL = 8 * HOUR;

const ENV = {
  PERP_DATA_ENABLED: "true",
  PERP_DATA_SYNC_ENABLED: "true",
  PERP_DATA_VENUES: "SIM",
  PERP_DATA_SAFETY_LAG_MS: "0",
  PERP_DATA_BACKFILL_DAYS: "3",
} as const;

function perpConfig(overrides: Record<string, string> = {}) {
  return loadPerpConfig({ ...ENV, ...overrides });
}

function instrument(symbol: string, venue = SIM_PERP_VENUE, marketType: MarketInstrument["marketType"] = "perpetual"): MarketInstrument {
  return {
    id: `${venue}:${symbol}`,
    venue,
    symbol,
    base: symbol.replace(/USDT$/, ""),
    quote: "USDT",
    assetClass: "crypto",
    marketType,
    status: "active",
    minQuantity: 0.001,
    priceStep: 0.1,
    quantityStep: 0.001,
    makerFee: 0.0002,
    takerFee: 0.0006,
    leverageAvailable: true,
    shortAvailable: true,
    paperAvailable: true,
    liveTradable: false,
    liveAvailable: false,
    volume24h: null,
    spread: null,
    bookDepthUsd: null,
    volatility: null,
    lastSeen: NOW.toISOString(),
  };
}

const INSTRUMENTS = [instrument("BTCUSDT"), instrument("ETHUSDT")];

async function run(options: {
  profile?: FixturePerpProfile;
  store?: InMemoryPerpStore;
  instruments?: readonly MarketInstrument[];
  mode?: "BACKFILL" | "INCREMENTAL";
  fromMs?: number | null;
  toMs?: number | null;
  dryRun?: boolean;
  maxInstruments?: number;
  qualityMode?: "log" | "strict";
  adapter?: PerpDataAdapter;
  configOverrides?: Record<string, string>;
}) {
  const config = perpConfig(options.qualityMode ? { PERP_DATA_QUALITY_MODE: options.qualityMode } : options.configOverrides ?? {});
  const store = options.store ?? new InMemoryPerpStore();
  const adapter = options.adapter ?? createFixturePerpAdapter({ profile: options.profile ?? {}, now: () => NOW });
  const results = await syncPerpVenue({
    venue: SIM_PERP_VENUE,
    adapter,
    store,
    config,
    instruments: options.instruments ?? INSTRUMENTS,
    mode: options.mode ?? "BACKFILL",
    ...(options.fromMs !== undefined ? { fromMs: options.fromMs } : {}),
    ...(options.toMs !== undefined ? { toMs: options.toMs } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.maxInstruments !== undefined ? { maxInstruments: options.maxInstruments } : {}),
    now: () => NOW,
    sleep: async () => undefined,
    // Das Artefakt würde in den Repo-Arbeitsbaum schreiben — die Speicher-Ablage
    // prüft die Kette ohne Seiteneffekt.
    writeQualityArtifact: false,
  });
  return { results, store, config };
}

describe("perp sync: Backfill, Idempotenz, Inkrement", () => {
  it("schreibt jede Reihe genau einmal und meldet die Mengen", async () => {
    const { results, store } = await run({});
    const [first] = results;
    assert.equal(first.status, "SUCCEEDED", `Erwartet SUCCEEDED, Fehlbefunde: ${JSON.stringify(first.failures.slice(0, 2))}`);
    assert.equal(first.replayed, false);
    assert.ok(first.runId, "ein echter Lauf hat ein Manifest");
    assert.equal(fundingOf(store).length, first.stats.funding.written);
    assert.ok(store.size > 0, "es sind Zeilen angekommen");
    assert.ok(first.stats.liquidations.written > 0, "Liquidationen kommen aus dem Fixture-Pfad");
    for (const kind of ["funding", "openInterest", "liquidations"] as const) {
      const written = first.stats[kind].written;
      assert.equal(first.stats[kind].duplicates, 0, "im ersten Lauf gibt es keine Duplikate");
      assert.equal(store.rows(kind).length, written);
    }
    assert.ok(fundingOf(store).every((row) => row.unit === "fraction_per_interval"), "Einheit bleibt kanonisch");
  });

  it("zweiter identischer Backfill ist ein Replay ohne neue Zeilen", async () => {
    const store = new InMemoryPerpStore();
    const after = await run({ store });
    const size = after.store.size;
    const second = await run({ store, fromMs: after.results[0] ? undefined : undefined });
    const [again] = second.results;
    assert.equal(again.replayed, true, "derselbe Idempotenzschlüssel ⇒ Replay, kein zweiter Datenlauf");
    assert.equal(second.store.size, size, "kein einziger Satz doppelt geschrieben");
    for (const kind of ["funding", "openInterest", "liquidations"] as const) {
      assert.equal(again.stats[kind].written, 0, `${kind}: Replay schreibt nichts`);
    }
    const keys = fundingOf(second.store).map((row) => `${row.instrumentId}|${row.eventTime.toISOString()}`);
    assert.equal(new Set(keys).size, keys.length, "natürlicher Schlüssel bleibt eindeutig");
  });

  it("inkrementeller Lauf nach gesetztem Wasserstand liefert nur Neues", async () => {
    const store = new InMemoryPerpStore();
    const first = await run({ store, toMs: NOW_MS - 2 * DAY() });
    assert.ok(first.results[0].watermarks.length > 0, "Wasserstände sind gesetzt");
    const before = store.size;
    const second = await run({ store, mode: "INCREMENTAL" });
    const [outcome] = second.results;
    assert.equal(outcome.mode, "INCREMENTAL");
    assert.ok(outcome.requests > 0, "der Inkrement-Lauf hat wirklich nachgefragt");
    assert.ok(second.store.size >= before, "Bestand wächst nur, nie zurück");
    const keys = openInterestOf(second.store).map((row) => `${row.instrumentId}|${row.eventTime.toISOString()}`);
    assert.equal(new Set(keys).size, keys.length, "auch über zwei Läufe hinweg: keine Duplikate");
  });

  it("Dry-Run rechnet die ganze Kette, schreibt aber nichts", async () => {
    const { results, store } = await run({ dryRun: true });
    const [outcome] = results;
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(store.size, 0, "Ablage unangetastet");
    assert.equal(outcome.runId, null, "kein Manifest für einen Dry-Run");
    assert.ok(outcome.stats.funding.fetched > 0, "gelesen wurde trotzdem");
    assert.equal(outcome.requests > 0, true);
    const cursors = await store.readCursors({});
    assert.equal(cursors.length, 0, "Wasserstände gehören zu einem geschriebenen Lauf");
  });

  it("Rate-Limit-Fehler wird zurückgenommen und endet nicht als Datenlücke", async () => {
    const { results, store } = await run({ profile: { failuresBeforeSuccess: 1 } });
    const [outcome] = results;
    assert.ok(outcome.requests > 0);
    assert.equal(outcome.status, "SUCCEEDED", `Retry muss zum Erfolg führen, war ${JSON.stringify(outcome.failures.slice(0, 2))}`);
    assert.ok(fundingOf(store).length > 0, "nach dem Retry sind Sätze da");
  });

  it("Aggregate verdichten die Manifeste eines Laufs", async () => {
    const { results } = await run({});
    const aggregate = aggregatePerpSyncResults(results);
    assert.equal(aggregate.runs, results.length);
    assert.equal(aggregate.requests, results.reduce((sum, entry) => sum + entry.requests, 0));
    assert.equal(aggregate.fetched, results.reduce((sum, entry) => sum + entry.stats.funding.fetched + entry.stats.openInterest.fetched + entry.stats.liquidations.fetched, 0));
    assert.equal(aggregate.status, "SUCCEEDED");
  });
});

describe("perp sync: unsupported vs. transientes Fehlern vs. leer", () => {
  it("UNSUPPORTED ist kein Fehler: kein Failure-Eintrag, aber sichtbar", async () => {
    const adapter: PerpDataAdapter = {
      venue: SIM_PERP_VENUE,
      capabilities: {
        venue: SIM_PERP_VENUE,
        funding: { supported: true, sourceId: "sim:funding" },
        openInterest: { supported: true, sourceId: "sim:oi" },
        liquidations: { supported: false, reason: "NO_PUBLIC_ENDPOINT", note: "kein öffentlicher Endpunkt" },
      },
      fetchFunding: async (request) => ({
        availability: "AVAILABLE",
        series: {
          sourceId: "sim:funding",
          fetchedAt: NOW,
          truncated: false,
          rows: [{ eventTime: request.toMs - INTERVAL, fundingRate: "0.0001", intervalHours: 8 }],
        },
      } as PerpFetchResult<PerpRawFundingRowAlias>),
      fetchOpenInterest: async () => ({ availability: "AVAILABLE", series: { sourceId: "sim:oi", fetchedAt: NOW, truncated: false, rows: [] } }),
      fetchLiquidations: async () => ({ availability: "UNSUPPORTED", reason: "NO_PUBLIC_ENDPOINT", note: "kein öffentlicher Endpunkt" }),
    };
    const { results, store } = await run({ adapter });
    const [outcome] = results;
    assert.equal(outcome.capabilities.liquidations.supported, false);
    assert.ok(outcome.stats.liquidations.unsupported >= 1, "die Unsupported-Zählung trägt den Fall");
    assert.equal(outcome.failures.filter((failure) => failure.kind === "liquidations").length, 0, "unsupported ist kein Fehlerfall");
    assert.equal(store.rows("liquidations").length, 0);
    assert.equal(outcome.status, "SUCCEEDED", "eine nicht lieferbare Reihe blockiert den Lauf nicht");
  });

  it("UNAVAILABLE (transient) bleibt Fehlbefund mit retryable-Flag", async () => {
    const adapter: PerpDataAdapter = {
      venue: SIM_PERP_VENUE,
      capabilities: {
        venue: SIM_PERP_VENUE,
        funding: { supported: true, sourceId: "sim:funding" },
        openInterest: { supported: true, sourceId: "sim:oi" },
        liquidations: { supported: true, sourceId: "sim:liq" },
      },
      fetchFunding: async () => {
        throw new Error("HTTP 502 https://sim.invalid/api/v1/futures/market/get_funding_rate_history?symbol=BTCUSDT api_key=SECRET123");
      },
      fetchOpenInterest: async () => ({ availability: "UNAVAILABLE", reason: "RATE_LIMITED", retryable: true, httpStatus: 429 }),
      fetchLiquidations: async () => ({ availability: "AVAILABLE", series: { sourceId: "sim:liq", fetchedAt: NOW, truncated: false, rows: [] } }),
    };
    const { results, store } = await run({ adapter, instruments: [INSTRUMENTS[0]] });
    const [outcome] = results;
    assert.notEqual(outcome.status, "SUCCEEDED", "transiente Ausfälle machen den Lauf PARTIAL/FAILED, nicht grün");
    assert.ok(outcome.failures.length > 0, "jeder Ausfall ist als Fehlbefund dokumentiert");
    assert.equal(outcome.failures.every((failure) => failure.retryable), true);
    const serialized = JSON.stringify(outcome.failures);
    assert.equal(/SECRET123|https?:\/\//i.test(serialized), false, `Fehlbefunde sind leak-frei: ${serialized.slice(0, 160)}`);
    assert.equal(fundingOf(store).length, 0);
  });

  it("leere Antwort ist unterscheidbar von unsupported (Grund NO_ROWS in der Abfrage)", async () => {
    const { store } = await run({ profile: { dropOpenInterest: true } });
    const empty = store.rows("openInterest");
    assert.equal(empty.length, 0, "die Reihe fehlt — das ist kein UNSUPPORTED-Capability-Fall");
  });
});

describe("perp sync: Qualität", () => {
  it("Lücken in der Settlement-Reihe werden als GAP gemeldet, nicht repariert", async () => {
    const { results } = await run({ profile: { gapEvery: 3 }, instruments: [INSTRUMENTS[0]] });
    const [outcome] = results;
    assert.ok(outcome.qualityFindings.GAP >= 1, `GAP-Befund erwartet, war ${JSON.stringify(outcome.qualityFindings)}`);
  });

  it("negatives Open Interest wird invalid markiert und erreicht die Ablage nicht", async () => {
    const log = await run({ profile: { negativeOpenInterestAt: 2 }, qualityMode: "log" });
    assert.ok(log.results[0].qualityFindings.INVALID >= 1, `INVALID-Befund erwartet, war ${JSON.stringify(log.results[0].qualityFindings)}`);
    assert.ok(log.results[0].stats.openInterest.invalid >= 1, "der Abweis zählt in die Zeilenstatistik");
    const strict = await run({ profile: { negativeOpenInterestAt: 2 }, qualityMode: "strict" });
    assert.ok(strict.results[0].qualityFindings.INVALID >= 1);
    assert.equal(
      strict.store.rows("openInterest").length,
      0,
      "strict: die belastete Reihe bleibt ungeschrieben (log: markiert geschrieben)"
    );
    assert.ok(log.store.rows("openInterest").length > 0, "log: Bestand bleibt erhalten");
  });

  it("Satz außerhalb der Konfigurationsgrenze wird zu null + OUT_OF_BOUNDS", async () => {
    const { store } = await run({ configOverrides: { PERP_DATA_MAX_ABS_FUNDING_RATE: "0.0000001" } });
    const outliers = fundingOf(store).filter((row) => row.missingReason === "OUT_OF_BOUNDS");
    assert.ok(outliers.length > 0, "enge Grenze muss Ausweisen produzieren");
    assert.equal(outliers.every((row) => row.fundingRate === null), true, "nie ein geklemmter Zahlenwert");
  });

  it("validatePerpSeries: Strukturverstöße und Duplikate werden aussortiert", () => {
    const base: PerpNormalizeContext = {
      venue: "SIM",
      instrumentId: "SIM:BTCUSDT",
      symbol: "BTCUSDT",
      sourceId: "sim:v1",
      fetchedAt: NOW,
      availabilityPolicy: "ingested",
      maxAbsFundingRate: 0.0075,
    };
    const rows = [
      normalizeFundingRow({ eventTime: NOW_MS - 2 * INTERVAL, fundingRate: 0.0001, intervalHours: 8 }, 0, base).row!,
      normalizeFundingRow({ eventTime: NOW_MS - 2 * INTERVAL, fundingRate: 0.0001, intervalHours: 8 }, 1, base).row!,
    ];
    const config = perpConfig();
    const duplicates = validatePerpSeries({
      venue: "SIM",
      instrumentId: "SIM:BTCUSDT",
      kind: "funding",
      rows: rows as never,
      asOfMs: NOW_MS,
      config,
    });
    assert.equal(duplicates.report.counts.DUPLICATE, 1, "zweiter Satz desselben Schlüssels ist ein Duplikat");
    assert.equal(duplicates.accepted.length, 1);

    // available_at < event_time wäre Look-ahead → Verstoss gegen die DB-CHECKs.
    const backwards = [{ ...rows[0], eventTime: new Date(NOW_MS), availableAt: new Date(NOW_MS - HOUR) }];
    const rejected = validatePerpSeries({
      venue: "SIM",
      instrumentId: "SIM:BTCUSDT",
      kind: "funding",
      rows: backwards as never,
      asOfMs: NOW_MS,
      config,
    });
    assert.equal(rejected.accepted.length, 0, "Look-ahead-Zeile darf die Ablage nicht erreichen");
    assert.ok(/available_at/.test(JSON.stringify(rejected.report.findings)));
  });

  it("Staleness: veraltete Reihe wird STALE, der Bestand aber nicht gelöscht", () => {
    const base: PerpNormalizeContext = {
      venue: "SIM",
      instrumentId: "SIM:BTCUSDT",
      symbol: "BTCUSDT",
      sourceId: "sim:v1",
      fetchedAt: NOW,
      availabilityPolicy: "ingested",
      maxAbsFundingRate: 0.0075,
    };
    const old = normalizeFundingRow({ eventTime: NOW_MS - 40 * HOUR, fundingRate: 0.0001, intervalHours: 8 }, 0, base).row!;
    const validated = validatePerpSeries({
      venue: "SIM",
      instrumentId: "SIM:BTCUSDT",
      kind: "funding",
      rows: [old] as never,
      asOfMs: NOW_MS,
      config: perpConfig({ PERP_DATA_MAX_STALE_FUNDING_HOURS: "24" }),
    });
    assert.ok(validated.report.counts.STALE >= 1, `STALE erwartet, war ${JSON.stringify(validated.report.counts)}`);
    assert.equal(validated.accepted.length, 1, "markieren statt vernichten");
  });

  it("Cross-Venue-Prüfung meldet Vorzeichenwechsel, nicht den Mittelwert", () => {
    const eventTime = new Date(NOW_MS - INTERVAL);
    const primary = [{ venue: "SIM", instrumentId: "SIM:BTCUSDT", underlyingSymbol: "BTCUSDT", eventTime, fundingRate: 0.0001 }];
    const secondary = [{ venue: "OTHER", instrumentId: "OTHER:BTCUSDT", underlyingSymbol: "BTCUSDT", eventTime, fundingRate: -0.0001 }];
    const reports = crossCheckFunding(primary as never, secondary as never);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].counts.CROSSCHECK, 1);
    assert.match(String(reports[0].findings[0].detail), /Vorzeichen/);
    // Gleicher Satz ⇒ verglichen, kein Befund (die Prüfung meldet Abweichungen,
    // nicht Übereinstimmungen — der Vergleich selbst bleibt zählbar).
    const agreeing = crossCheckFunding(primary as never, [{ ...secondary[0], fundingRate: 0.0001 }] as never);
    assert.equal(agreeing.length, 1);
    assert.equal(agreeing[0].counts.CROSSCHECK, 0);
    assert.equal(agreeing[0].crosscheckCompared, 1);
    // Gleiche Venue wird nicht gegeneinander geprüft (sonst jede Normalisierung
    // als „Abweichung von sich selbst“).
    assert.equal(crossCheckFunding(primary as never, [{ ...secondary[0], venue: "SIM" }] as never).length, 0);
  });
});

describe("perp sync: harte Grenzen", () => {
  it("Spot-Instrumente verlassen den Perp-Pfad vor dem ersten Request", () => {
    const { perpetual, notPerpetual } = selectPerpInstruments([...INSTRUMENTS, instrument("AAAUSDT", SIM_PERP_VENUE, "spot")], SIM_PERP_VENUE);
    assert.equal(perpetual.length, 2);
    assert.equal(notPerpetual, 1);
  });

  it("maxInstruments kappt den Scope (gemeldet, nicht still)", async () => {
    const { results } = await run({ maxInstruments: 1 });
    assert.equal(results[0].instruments, 1);
    assert.ok(results[0].requests <= PERP_LIMITS.syncInstruments * PERP_LIMITS.requestsPerSeries * 3);
  });

  it("Requests je Lauf bleiben durch das dokumentierte Budget gedeckelt", async () => {
    const { results } = await run({});
    const cap = results[0].instruments * PERP_LIMITS.requestsPerSeries * 3 + results[0].instruments;
    assert.ok(results[0].requests <= cap, `${results[0].requests} Requests über Budget ${cap}`);
  });

  it("Sicherheitsnachlauf bleibt auch bei expliziter Obergrenze wirksam", async () => {
    const config = perpConfig({ PERP_DATA_SAFETY_LAG_MS: String(6 * HOUR) });
    const store = new InMemoryPerpStore();
    const adapter = createFixturePerpAdapter({ profile: {}, now: () => NOW });
    const results = await syncPerpVenue({
      venue: SIM_PERP_VENUE,
      adapter,
      store,
      config,
      instruments: [INSTRUMENTS[0]],
      mode: "BACKFILL",
      toMs: NOW_MS,
      now: () => NOW,
      sleep: async () => undefined,
      writeQualityArtifact: false,
    });
    assert.equal(results[0].status, "SUCCEEDED");
    const latest = Math.max(...fundingOf(store).map((row) => row.eventTime.getTime()));
    assert.ok(latest <= NOW_MS - 6 * HOUR, `jüngstes Settlement ${new Date(latest).toISOString()} liegt im Nachlauffenster`);
  });
});

function DAY(): number {
  return 24 * HOUR;
}

/** Typengrenze: die Speicher-Ablage liefert die Reihen-Union, Tests brauchen die Art. */
function fundingOf(store: InMemoryPerpStore) {
  type Any = ReturnType<InMemoryPerpStore["rows"]>[number];
  return store.rows("funding").filter((row) => row.kind === "funding") as Extract<Any, { kind: "funding" }>[];
}

function openInterestOf(store: InMemoryPerpStore) {
  type Any = ReturnType<InMemoryPerpStore["rows"]>[number];
  return store.rows("openInterest").filter((row) => row.kind === "openInterest") as Extract<Any, { kind: "openInterest" }>[];
}
