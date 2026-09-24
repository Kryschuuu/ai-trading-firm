/**
 * Unit-Tests des persistenten Spread-Caches (v1.37.0):
 * TTL-Verhalten, Atomarität/Roundtrip, Toleranz gegen korrupte Dateien,
 * Plausibilitätsfilter und Env-Auswertung.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_SPREAD_CACHE_TTL_MS,
  FileSpreadCache,
  SPREAD_CACHE_TTL_ENV,
  spreadCacheTtlMs,
} from "../../src/marketdata/spreadCache";

function cacheFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spread-cache-"));
  return path.join(dir, "spread-cache.json");
}

const T0 = Date.parse("2026-09-13T10:00:00.000Z");
const HOUR = 3_600_000;

test("leere/fehlende Datei: kein Treffer, flush schreibt atomar", () => {
  const file = cacheFile();
  const cache = new FileSpreadCache(file, 6 * HOUR);
  assert.equal(cache.fresh("BITUNIX:BTCUSDT", T0), undefined);
  cache.record("BITUNIX:BTCUSDT", 0.0001, new Date(T0));
  cache.flush(new Date(T0));
  assert.ok(existsSync(file), "Cache-Datei wurde angelegt");
  assert.ok(!existsSync(`${file}.tmp`), "geschrieben wird via tmp+rename (kein .tmp-Rest)");

  const reloaded = new FileSpreadCache(file, 6 * HOUR);
  assert.equal(reloaded.fresh("BITUNIX:BTCUSDT", T0 + HOUR), 0.0001);
});

test("TTL: innerhalb gültig, danach verfallen", () => {
  const file = cacheFile();
  const cache = new FileSpreadCache(file, HOUR);
  cache.record("BITUNIX:ETHUSDT", 0.0002, new Date(T0));
  cache.flush(new Date(T0));
  const reloaded = new FileSpreadCache(file, HOUR);
  assert.equal(reloaded.fresh("BITUNIX:ETHUSDT", T0 + HOUR), 0.0002, "Grenze inklusive");
  assert.equal(reloaded.fresh("BITUNIX:ETHUSDT", T0 + HOUR + 1), undefined, "1 ms über TTL: verfallen");
});

test("ttl=0: Cache ist deaktiviert (immer undefined, keine Datei)", () => {
  const file = cacheFile();
  const cache = new FileSpreadCache(file, 0);
  cache.record("BITUNIX:BTCUSDT", 0.0001, new Date(T0));
  cache.flush(new Date(T0));
  assert.equal(existsSync(file), false);
  assert.equal(cache.fresh("BITUNIX:BTCUSDT", T0), undefined);
});

test("korrupte Cache-Datei wird ignoriert statt den Sync zu blockieren", () => {
  const file = cacheFile();
  writeFileSync(file, "{ kaputt", { mode: 0o600 });
  const cache = new FileSpreadCache(file, 6 * HOUR);
  assert.equal(cache.fresh("BITUNIX:BTCUSDT", T0), undefined);
  cache.record("BITUNIX:BTCUSDT", 0.0001, new Date(T0));
  cache.flush(new Date(T0));
  const reloaded = new FileSpreadCache(file, 6 * HOUR);
  assert.equal(reloaded.fresh("BITUNIX:BTCUSDT", T0), 0.0001, "überschrieben und wieder lesbar");
});

test("unplausible/fehlende Werte werden nicht übernommen", () => {
  const file = cacheFile();
  const cache = new FileSpreadCache(file, 6 * HOUR);
  cache.record("BITUNIX:BTCUSDT", Number.NaN, new Date(T0));
  cache.record("BITUNIX:ETHUSDT", -0.001, new Date(T0));
  cache.record("BITUNIX:SOLUSDT", 0.0003, new Date(T0));
  cache.flush(new Date(T0));
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(raw.entries), ["BITUNIX:SOLUSDT"]);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("spreadCacheTtlMs: Default, 0/negativ = aus, unparsbar fällt zurück auf Default", () => {
  assert.equal(spreadCacheTtlMs({}), DEFAULT_SPREAD_CACHE_TTL_MS);
  assert.equal(spreadCacheTtlMs({ [SPREAD_CACHE_TTL_ENV]: "0" }), 0);
  assert.equal(spreadCacheTtlMs({ [SPREAD_CACHE_TTL_ENV]: "-500" }), 0);
  assert.equal(spreadCacheTtlMs({ [SPREAD_CACHE_TTL_ENV]: "3600000" }), HOUR);
  assert.equal(spreadCacheTtlMs({ [SPREAD_CACHE_TTL_ENV]: "garnicht" }), DEFAULT_SPREAD_CACHE_TTL_MS);
});

test("bookDepthUsd: recordDepth schreibt nur in vorhandenen Spread-Eintrag (kein Halb-Artefakt)", () => {
  const file = cacheFile();
  const cache = new FileSpreadCache(file, 6 * HOUR);
  // Tiefe ohne vorherigen Spread → wird NICHT geschrieben (beide stammen aus
  // demselben Depth-Call; ein einsamer depth-Wert wäre nutzlos).
  cache.recordDepth("BITUNIX:BTCUSDT", 42_000, new Date(T0));
  cache.flush(new Date(T0));
  assert.equal(existsSync(file), false, "kein Write ohne Spread-Eintrag");

  // Regulär: erst Spread, dann Tiefe → Roundtrip.
  cache.record("BITUNIX:BTCUSDT", 0.0001, new Date(T0));
  cache.recordDepth("BITUNIX:BTCUSDT", 42_000, new Date(T0));
  cache.flush(new Date(T0));
  const reloaded = new FileSpreadCache(file, 6 * HOUR);
  assert.equal(reloaded.freshDepth("BITUNIX:BTCUSDT", T0 + HOUR), 42_000);
  assert.equal(reloaded.fresh("BITUNIX:BTCUSDT", T0 + HOUR), 0.0001);

  // negative/nicht-endliche Tiefe wird verworfen.
  cache.recordDepth("BITUNIX:BTCUSDT", -1, new Date(T0));
  cache.flush(new Date(T0));
  const again = new FileSpreadCache(file, 6 * HOUR);
  assert.equal(again.freshDepth("BITUNIX:BTCUSDT", T0 + HOUR), 42_000);
});

test("bookDepthUsd: alte Cache-Dateien OHNE depth bleiben lesbar (Abwärtskompatibilität)", () => {
  const file = cacheFile();
  // Eine v0.3.0-Datei: entries mit `spread`/`at`, ohne `bookDepthUsd`.
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      writtenAt: new Date(T0).toISOString(),
      entries: {
        "BITUNIX:BTCUSDT": { spread: 0.0001, at: new Date(T0).toISOString() },
      },
    }),
    { mode: 0o600 },
  );
  const cache = new FileSpreadCache(file, 6 * HOUR);
  assert.equal(cache.fresh("BITUNIX:BTCUSDT", T0 + HOUR), 0.0001);
  assert.equal(cache.freshDepth("BITUNIX:BTCUSDT", T0 + HOUR), undefined);
});
