/**
 * Paper-Modi & Konfiguration (Task 03) — Negativ-Tests.
 * Falsche Kombinationen → klare, maschinenlesbare Fehler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadMarketDataConfig, parsePaperMode } from "../src/lib/marketdata/config";
import { MarketDataManager } from "../src/lib/marketdata/manager";
import { PaperConfigError } from "../src/lib/marketdata/types";

test("Default paperMode ist 'broker-market-data' (Modus B)", () => {
  const cfg = loadMarketDataConfig({});
  assert.equal(cfg.paperMode, "broker-market-data");
  assert.equal(cfg.staticFallbackEnabled, false, "Statik-Fallback Default AUS");
  assert.equal(cfg.allowSyntheticFallback, false, "Synthetic-Fallback Default AUS");
});

test("Ungültiger paperMode → klarer Konfigurationsfehler", () => {
  assert.throws(() => parsePaperMode("paper"), /Ungültiger paperMode/);
  assert.throws(() => parsePaperMode(123), /Ungültiger paperMode/);
  assert.equal(parsePaperMode("synthetic"), "synthetic");
});

test("Modus C ohne Flag → klarer Fehler", () => {
  assert.throws(
    () => loadMarketDataConfig({ PAPER_MODE: "broker-paper-api" }),
    (e: unknown) => e instanceof PaperConfigError && /PAPER_MODE_C_ENABLED=true/.test(e.message)
  );
});

test("Modus C ohne Venue-Capability → klarer Fehler (heute: kein Venue unterstützt C)", () => {
  const cfg = loadMarketDataConfig({
    PAPER_MODE: "broker-paper-api",
    PAPER_MODE_C_ENABLED: "true",
    PAPER_BROKER_API_VENUE: "ALPACA",
  });
  assert.throws(
    () => new MarketDataManager({ config: cfg }),
    (e: unknown) => e instanceof PaperConfigError && /nicht verfügbar/.test(e.message)
  );
});

test("Modus C mit unbekanntem Venue → klarer Fehler", () => {
  const cfg = loadMarketDataConfig({
    PAPER_MODE: "broker-paper-api",
    PAPER_MODE_C_ENABLED: "true",
    PAPER_BROKER_API_VENUE: "NOSUCH",
  });
  assert.throws(
    () => new MarketDataManager({ config: cfg }),
    (e: unknown) => e instanceof PaperConfigError && /unbekanntes Venue/.test(e.message)
  );
});

test("Statisches Fallback nur explizit via Flag aktivierbar", () => {
  assert.equal(loadMarketDataConfig({}).staticFallbackEnabled, false);
  assert.equal(loadMarketDataConfig({ PAPER_STATIC_FALLBACK: "true" }).staticFallbackEnabled, true);
});
