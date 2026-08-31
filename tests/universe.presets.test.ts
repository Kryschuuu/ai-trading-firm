/**
 * Preset-Tests des erweiterten Markt-Universums (v1.30.0).
 *
 * Sichert den dokumentierten Preset-Vertrag ab:
 *   50 Aktien · 50 Indizes · 22 Rohstoffe · 30 Kryptowährungen
 *
 * sowie die Seed-Invarianten, die andernfalls erst zur Laufzeit auffallen:
 *   * kein `liveAvailable` im Seed (CAP-008),
 *   * `liveTradable`: PAPER = false, reale Venue = true,
 *   * Determinismus (zwei Builds ⇒ identische Serialisierung),
 *   * Idempotenz des Registry-Upserts,
 *   * kein Verstoß gegen die Universe-Ausschluss-Policy (gehebelte Token,
 *     Test-Symbole).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PRESET_COMMODITIES,
  PRESET_COUNTS,
  PRESET_CRYPTO,
  PRESET_EQUITIES,
  PRESET_INDICES,
  PRESET_INSTRUMENTS,
  PRESET_TIMESTAMP,
  assertPresetContract,
  buildPresetInstruments,
  presetSummary,
} from "../src/universe/presets";
import { InstrumentRegistry } from "../src/universe/registry";
import { PERSISTED_INSTRUMENT_FIELDS, serializeInstrument } from "../src/universe/store";
import { isValidInstrumentId, isValidSymbol, isValidVenue } from "../src/universe/validation";
import { DEFAULT_POLICY } from "../src/universe/policy";

// ── Preset-Vertrag ──────────────────────────────────────────────────────────

test("Presets: dokumentierte Anzahlen (50/50/22/30) sind erfüllt", () => {
  assert.equal(PRESET_EQUITIES.length, 50, "Aktien-Preset");
  assert.equal(PRESET_INDICES.length, 50, "Indizes-Preset");
  assert.equal(PRESET_COMMODITIES.length, 22, "Rohstoff-Preset");
  assert.equal(PRESET_CRYPTO.length, 30, "Krypto-Preset");
  assert.equal(PRESET_COUNTS.equities, 50);
  assert.equal(PRESET_COUNTS.indices, 50);
  assert.equal(PRESET_COUNTS.commodities, 22);
  assert.equal(PRESET_COUNTS.crypto, 30);
  assert.doesNotThrow(() => assertPresetContract());

  const summary = presetSummary();
  assert.equal(summary.instruments, PRESET_INSTRUMENTS.length);
});

test("Presets: jedes Preset ist duplikatfrei", () => {
  for (const [label, list] of [
    ["equities", PRESET_EQUITIES],
    ["indices", PRESET_INDICES],
    ["commodities", PRESET_COMMODITIES],
    ["crypto", PRESET_CRYPTO],
  ] as const) {
    const symbols = list.map((e) => e.symbol);
    assert.equal(new Set(symbols).size, symbols.length, `${label} enthält Duplikate`);
  }
});

test("Presets: Krypto-Presets tragen Basis-Asset und USDT-Quote", () => {
  for (const entry of PRESET_CRYPTO) {
    assert.ok(entry.base, `${entry.symbol} braucht ein Basis-Asset`);
    assert.equal(entry.quote, "USDT", `${entry.symbol} muss in USDT quotiert sein`);
    assert.ok(entry.symbol.endsWith("USDT"), `${entry.symbol} muss auf USDT enden`);
    assert.ok(entry.minQuantity > 0, `${entry.symbol}: minQuantity > 0`);
    assert.ok(entry.priceStep > 0, `${entry.symbol}: priceStep > 0`);
  }
});

// ── Seed-Invarianten ────────────────────────────────────────────────────────

test("Presets: kein liveAvailable im Seed (CAP-008)", () => {
  for (const instrument of PRESET_INSTRUMENTS) {
    assert.equal(
      "liveAvailable" in instrument,
      false,
      `${instrument.venue}:${instrument.symbol} darf liveAvailable nicht seeden`,
    );
  }
});

test("Presets: liveTradable ist false für PAPER und true für reale Venues", () => {
  for (const instrument of PRESET_INSTRUMENTS) {
    if (instrument.venue === "PAPER") {
      assert.equal(instrument.liveTradable, false, `${instrument.venue}:${instrument.symbol}`);
      assert.equal(instrument.paperAvailable, true, `${instrument.venue}:${instrument.symbol}`);
    } else {
      assert.equal(instrument.liveTradable, true, `${instrument.venue}:${instrument.symbol}`);
    }
  }
});

test("Presets: Short-Verfügbarkeit folgt der Venue-Mechanik", () => {
  for (const instrument of PRESET_INSTRUMENTS) {
    if (instrument.venue === "BINANCE") {
      // Spot kann nicht leer verkauft werden — bewusst keine falsche Zusage.
      assert.equal(instrument.shortAvailable, false, `${instrument.venue}:${instrument.symbol}`);
      assert.equal(instrument.marketType, "spot");
    } else if (instrument.venue === "PAPER") {
      assert.equal(instrument.shortAvailable, true, `${instrument.venue}:${instrument.symbol}`);
    } else {
      assert.equal(instrument.shortAvailable, true, `${instrument.venue}:${instrument.symbol}`);
    }
  }
});

test("Presets: Hebel nur dort, wo das Produkt ihn anbietet", () => {
  for (const instrument of PRESET_INSTRUMENTS) {
    const leveraged = instrument.marketType === "future" || instrument.marketType === "cfd";
    assert.equal(
      instrument.leverageAvailable,
      leveraged,
      `${instrument.venue}:${instrument.symbol} (${instrument.marketType})`,
    );
  }
});

test("Presets: alle IDs erfüllen Venue- und Symbol-Muster der Registry", () => {
  for (const instrument of PRESET_INSTRUMENTS) {
    const id = `${instrument.venue}:${instrument.symbol}`;
    assert.ok(isValidVenue(instrument.venue), `Venue ungültig: ${instrument.venue}`);
    assert.ok(isValidSymbol(instrument.symbol), `Symbol ungültig: ${instrument.symbol}`);
    assert.ok(isValidInstrumentId(id), `ID ungültig: ${id}`);
  }
});

test("Presets: kein Satz verstößt gegen die Universe-Ausschluss-Policy", () => {
  for (const rule of DEFAULT_POLICY.rules) {
    const re = new RegExp(rule.pattern);
    for (const instrument of PRESET_INSTRUMENTS) {
      if (rule.field === "symbol") {
        assert.equal(re.test(instrument.symbol), false, `Policy ${rule.id} trifft ${instrument.symbol}`);
      }
      if (rule.field === "id") {
        assert.equal(
          re.test(`${instrument.venue}:${instrument.symbol}`),
          false,
          `Policy ${rule.id} trifft ${instrument.venue}:${instrument.symbol}`,
        );
      }
    }
  }
});

test("Presets: Metriken starten auf null und lastSeen ist der fixe Zeitstempel", () => {
  for (const instrument of PRESET_INSTRUMENTS) {
    assert.equal(instrument.volume24h, null, `${instrument.venue}:${instrument.symbol} volume24h`);
    assert.equal(instrument.spread, null, `${instrument.venue}:${instrument.symbol} spread`);
    assert.equal(instrument.volatility, null, `${instrument.venue}:${instrument.symbol} volatility`);
    assert.equal(instrument.lastSeen, PRESET_TIMESTAMP);
  }
});

// ── Determinismus & Idempotenz ──────────────────────────────────────────────

test("Presets: zwei Builds serialisieren byte-identisch (Determinismus)", () => {
  const a = buildPresetInstruments();
  const b = buildPresetInstruments();
  assert.equal(a.length, b.length);
  const serialize = (list: typeof a) =>
    [...list]
      .map((instrument) => PERSISTED_INSTRUMENT_FIELDS.map((field) => `${field}=${String(instrument[field] ?? "")}`).join("|"))
      .sort()
      .join("\n");
  assert.equal(serialize(a), serialize(b));
});

test("Presets: ohne PAPER-Spiegel entstehen exakt die Venue-Instrumente", () => {
  const withMirror = buildPresetInstruments({ withPaperMirror: true });
  const withoutMirror = buildPresetInstruments({ withPaperMirror: false });
  assert.equal(withoutMirror.length, withMirror.length - (50 + 50 + 22 + 30));
  assert.ok(withoutMirror.every((instrument) => instrument.venue !== "PAPER"));
});

test("Presets: Registry-Upsert ist idempotent (zweiter Lauf ändert nichts)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "universe-presets-"));
  try {
    const registry = new InstrumentRegistry({ dir });
    registry.load();
    const first = registry.upsertMany([...PRESET_INSTRUMENTS], "test:preset", "SEED");
    registry.save();
    assert.equal(first.rejected.length, 0, JSON.stringify(first.rejected.slice(0, 5)));
    assert.equal(first.created, PRESET_INSTRUMENTS.length);
    assert.equal(registry.size, PRESET_INSTRUMENTS.length);

    const serializedFirst = registry
      .query({ pageSize: 500 })
      .items.map((instrument) => serializeInstrument(instrument))
      .join("\n");

    const second = registry.upsertMany([...PRESET_INSTRUMENTS], "test:preset", "SEED");
    registry.save();
    assert.equal(second.created, 0, "zweiter Lauf darf nichts neu anlegen");
    assert.equal(second.rejected.length, 0);
    assert.equal(second.unchanged, PRESET_INSTRUMENTS.length, "zweiter Lauf darf nichts ändern");

    const serializedSecond = registry
      .query({ pageSize: 500 })
      .items.map((instrument) => serializeInstrument(instrument))
      .join("\n");
    assert.equal(serializedSecond, serializedFirst, "Persistenz muss stabil bleiben");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Presets: Asset-Klassen und Markttypen je Preset-Familie", () => {
  const combinations = new Set<string>();
  for (const instrument of PRESET_INSTRUMENTS) {
    if (instrument.venue === "PAPER") continue;
    combinations.add(`${instrument.venue}:${instrument.assetClass}:${instrument.marketType}`);
  }
  assert.deepEqual([...combinations].sort(), [
    "ALPACA:equity:spot",
    "BINANCE:crypto:spot",
    "IBKR:commodity:future",
    "IBKR:equity:spot",
    "IBKR:index:cfd",
  ]);
});

test("Presets: PAPER-Spiegel existieren für jedes Preset-Asset", () => {
  const paper = new Set(
    PRESET_INSTRUMENTS.filter((instrument) => instrument.venue === "PAPER").map((i) => i.symbol),
  );
  const expected = new Set<string>([
    ...PRESET_EQUITIES.map((e) => e.symbol),
    ...PRESET_INDICES.map((e) => e.symbol),
    ...PRESET_COMMODITIES.map((e) => e.symbol),
    ...PRESET_CRYPTO.map((e) => e.base ?? e.symbol),
  ]);
  assert.deepEqual([...paper].sort(), [...expected].sort());
});
