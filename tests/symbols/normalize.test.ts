/**
 * Golden-Tests der zentralen, venue-aware Symbol-Normalisierung (SYM-007).
 *
 * Kernaussagen:
 *  1. Die Ticket-Formate (`BTCUSDT`, `BTC/USD`, `BTC-USD`, `BTC_USD`,
 *     `EUR.USD`, `EURUSD=X`, `KRAKEN:BTC/USD`) werden EINHEITLICH kanonisiert.
 *  2. Venue-Profile bilden kanonisch ↔ nativ korrekt ab (inkl. Kraken XBT↔BTC).
 *  3. `instrumentId` ist immer `${VENUE}:${canonical}`.
 *  4. Die Rule-Engine-Sicherheitsgrenzen bleiben unverändert (§3.3) — die
 *     Symbolsemantik allein wird zentralisiert; Injection wird weiter verworfen.
 *  5. Unbekannte Venue: Abfragepfad = Default-Profil + Warning; Sync-Pfad
 *     (`profilePolicy: "strict"`) = Throw.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cleanRawSymbol,
  isValidInstrumentId,
  isValidStorageSymbol,
  isValidVenueNativeSymbol,
  normalizeVenueSymbol,
  setUnknownVenueWarningSinkForTests,
  tryNormalizeVenueSymbol,
  STORAGE_SYMBOL_RE,
  type CanonicalSymbol,
} from "../../src/symbols/normalize";
import {
  UnknownVenueProfileError,
  SymbolNormalizationError,
  type UnknownVenueProfileWarning,
} from "../../src/symbols/errors";
import {
  DEFAULT_PROFILE,
  VENUE_PROFILES,
  getVenueProfile,
  parseCanonicalSymbol,
} from "../../src/symbols/venueProfiles";
import { sanitizeRuleSpec } from "../../src/lib/ruleEngine";

// ── §3.2: Kanonisierungsregeln ──────────────────────────────────────────────

test("Kanonisierung: Unicode NFKC + Zero-Width + Trim + Uppercase", () => {
  assert.equal(cleanRawSymbol("  btc/usd "), "BTC/USD");
  assert.equal(cleanRawSymbol("btc\uFEFFusd"), "BTCUSD"); // BOM entfernt
  assert.equal(cleanRawSymbol("b\u200Dtc"), "BTC"); // Zero-Width-Joiner entfernt
  assert.equal(cleanRawSymbol("bt\u200Bc"), "BTC"); // Zero-Width-Space entfernt
  // NFKC: Vollbuchstaben-Kompatibilitätsformen (U+FF22…) werden abgebildet.
  assert.equal(cleanRawSymbol("\uFF22\uFF34\uFF23"), "BTC");
});

test("Ticket-Beispiel: KRAKEN xbt-usd → kanonisch BTC/USD, nativ XBTUSD", () => {
  const r = tryNormalizeVenueSymbol("KRAKEN", "xbt-usd");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const expected: CanonicalSymbol = {
    venue: "KRAKEN",
    canonical: "BTC/USD",
    venueNative: "XBTUSD",
    instrumentId: "KRAKEN:BTC/USD",
    assetClass: "CRYPTO",
  };
  assert.deepEqual(r.value, expected);
});

test("Eingabeformate §3.2 werden einheitlich kanonisiert (PAPER = Default-Profil)", () => {
  const cases: [string, string][] = [
    ["BTCUSDT", "BTC/USDT"],
    ["BTC/USD", "BTC/USD"],
    ["BTC-USD", "BTC/USD"],
    ["BTC_USD", "BTC/USD"],
    ["btc-usd", "BTC/USD"],
    ["EUR.USD", "EUR/USD"],
    ["EURUSD=X", "EUR/USD"],
    ["EURUSD", "EUR/USD"],
    ["BTC", "BTC"],
    ["AAPL", "AAPL"],
    ["BRK.B", "BRK.B"],
    ["EURGBP=X", "EUR/GBP"],
  ];
  for (const [input, canonical] of cases) {
    const r = tryNormalizeVenueSymbol("PAPER", input);
    assert.equal(r.ok, true, `${input} muss akzeptiert werden`);
    if (r.ok) assert.equal(r.value.canonical, canonical, `${input} → ${canonical}`);
  }
});

test("Venue-Präfix wird akzeptiert, wenn er zur Venue passt — und verworfen, wenn nicht", () => {
  const ok = tryNormalizeVenueSymbol("KRAKEN", "KRAKEN:BTC/USD");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.value.instrumentId, "KRAKEN:BTC/USD");
  assert.equal(tryNormalizeVenueSymbol("KRAKEN", "BINANCE:BTC/USD").ok, false);
  const r = tryNormalizeVenueSymbol("KRAKEN", "BINANCE:BTC/USD");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /passt nicht zur Venue/);
});

test("Kanonisches Format je Anlageklasse: Paare mit /, Einzelwerte ohne Trenner", () => {
  assert.equal(normalizeVenueSymbol("PAPER", "BTCUSDT").canonical, "BTC/USDT");
  assert.equal(normalizeVenueSymbol("PAPER", "EURUSD=X").canonical, "EUR/USD");
  assert.equal(normalizeVenueSymbol("PAPER", "SPY").canonical, "SPY");
  assert.equal(normalizeVenueSymbol("PAPER", "BRK.B").canonical, "BRK.B");
});

test("instrumentId ist immer ${VENUE}:${canonical}", () => {
  for (const [venue, raw] of [
    ["KRAKEN", "xbtusd"],
    ["BINANCE", "ethusdt"],
    ["IBKR", "eur.usd"],
    ["DYDX", "BTC-USD"],
    ["ALPACA", "aapl"],
  ] as const) {
    const c = normalizeVenueSymbol(venue, raw);
    assert.equal(c.instrumentId, `${c.venue}:${c.canonical}`);
    assert.match(c.instrumentId, /^[A-Z][A-Z0-9_]{1,15}:/);
  }
});

// ── Venue-Profile ───────────────────────────────────────────────────────────

test("Venue-native Abbildungen (Ticket §3.1 + Ticket-Beispiele)", () => {
  const cases: [string, CanonicalSymbol["canonical"], string][] = [
    ["KRAKEN", "BTC/USD", "XBTUSD"],
    ["BINANCE", "BTC/USDT", "BTCUSDT"],
    ["BITUNIX", "BTC/USDT", "BTCUSDT"],
    ["DYDX", "BTC/USD", "BTC-USD"],
    ["IBKR", "EUR/USD", "EUR.USD"],
    ["ALPACA", "AAPL", "AAPL"],
    ["PAPER", "BTC/USD", "BTC/USD"],
  ];
  for (const [venue, canonical, native] of cases) {
    const profile = getVenueProfile(venue);
    assert.ok(profile, `Profil ${venue} muss existieren`);
    assert.equal(profile.toVenueNative(canonical), native, `${venue}: ${canonical} → ${native}`);
    assert.equal(profile.toCanonical(native), canonical, `${venue}: ${native} → ${canonical}`);
  }
});

test("Kraken-Alias XBT ↔ BTC in beide Richtungen (inkl. konkatenierter Form)", () => {
  assert.equal(normalizeVenueSymbol("KRAKEN", "XBTUSD").canonical, "BTC/USD");
  assert.equal(normalizeVenueSymbol("KRAKEN", "XBT/USD").canonical, "BTC/USD");
  assert.equal(normalizeVenueSymbol("KRAKEN", "BTC/USD").venueNative, "XBTUSD");
  // Keine Fehl-Aliasierung: XB ist keine Kraken-Base.
  assert.notEqual(normalizeVenueSymbol("KRAKEN", "XBTEUR").canonical, "XB/TEUR");
});

test("Asset-Class-Heuristik (dokumentiert, rät nie laut)", () => {
  assert.equal(normalizeVenueSymbol("PAPER", "BTC/USD").assetClass, "CRYPTO");
  assert.equal(normalizeVenueSymbol("PAPER", "BTCUSDT").assetClass, "CRYPTO");
  assert.equal(normalizeVenueSymbol("PAPER", "EURUSD=X").assetClass, "FX");
  assert.equal(normalizeVenueSymbol("IBKR", "EUR.USD").assetClass, "FX");
  assert.equal(normalizeVenueSymbol("PAPER", "SPY").assetClass, "ETF");
  assert.equal(normalizeVenueSymbol("PAPER", "BTC").assetClass, "CRYPTO");
  assert.equal(normalizeVenueSymbol("ALPACA", "AAPL").assetClass, "EQUITY");
  assert.equal(normalizeVenueSymbol("PAPER", "BRK.B").assetClass, "EQUITY");
  assert.equal(normalizeVenueSymbol("PAPER", "JPY=X").assetClass, "FX");
  // Unbekannte Einzel-Ticker im Default-Profil: UNKNOWN, kein Raten.
  assert.equal(normalizeVenueSymbol("PAPER", "ZZZQ").assetClass, "UNKNOWN");
});

// ── Ablehnungssemantik ──────────────────────────────────────────────────────

test("tryNormalizeVenueSymbol wirft nie und liefert maschinenlesbare Gründe", () => {
  const rejected: unknown[] = [
    "",
    "   ",
    "BTC;DROP TABLE",
    'BTC"; DROP',
    "BTC&foo=bar",
    "https://evil.example/?x=1",
    "BTC\nINSTRUCTION",
    "$TSLA",
    "BTC/USD/EUR",
    "BTC/US-D",
    "/BTCUSD",
    "BTCUSD/",
    "A".repeat(25),
    "KRAKEN::BTC",
    123 as unknown as string,
    null as unknown as string,
  ];
  for (const raw of rejected) {
    const r = tryNormalizeVenueSymbol("PAPER", raw as string);
    assert.equal(r.ok, false, `${String(raw)} muss abgelehnt werden`);
    if (!r.ok) assert.ok(r.reason.length > 0);
  }
});

test("normalizeVenueSymbol wirft typisierten SymbolNormalizationError", () => {
  assert.throws(() => normalizeVenueSymbol("PAPER", "BTC;DROP"), (e) => {
    assert.ok(e instanceof SymbolNormalizationError);
    assert.equal(e.code, "SYMBOL_NORMALIZATION");
    assert.equal(e.reason, "INVALID_CHARACTERS");
    return true;
  });
});

test("BRK-B (1-Zeichen-Dash-Klasse) wird nicht geraten — klarer Ablehnungsgrund", () => {
  const r = tryNormalizeVenueSymbol("PAPER", "BRK-B");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /MALFORMED_SYMBOL/);
});

test("Opake Yahoo-Formen bleiben erhalten (JPY=X), ohne zu raten", () => {
  const c = normalizeVenueSymbol("PAPER", "JPY=X");
  assert.equal(c.canonical, "JPY=X");
  assert.equal(c.assetClass, "FX");
});

// ── Unbekannte Venue: warn vs. strict ───────────────────────────────────────

test("Unbekannte Venue (Abfragepfad): Default-Profil + Warning, kein Throw", () => {
  const warnings: UnknownVenueProfileWarning[] = [];
  setUnknownVenueWarningSinkForTests((w) => warnings.push(w));
  try {
    const r = tryNormalizeVenueSymbol("BYBIT", "BTC/USD");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.venue, "BYBIT");
      assert.equal(r.value.canonical, "BTC/USD");
    }
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].venue, "BYBIT");
  } finally {
    setUnknownVenueWarningSinkForTests(null);
  }
});

test("Unbekannte Venue (Registrierungspfad): strict wirft UnknownVenueProfileError", () => {
  assert.throws(
    () => normalizeVenueSymbol("BYBIT", "BTC/USD", { profilePolicy: "strict" }),
    (e) => e instanceof UnknownVenueProfileError && e.code === "UNKNOWN_VENUE_PROFILE"
  );
  // …und try* liefert denselben Fall als Grund statt stiller Annahme.
  const r = tryNormalizeVenueSymbol("BYBIT", "BTC/USD", { profilePolicy: "strict" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /Unbekannte Venue/);
});

test("Ungültige Venue-Formate werden abgelehnt (kein Profilzugriff)", () => {
  for (const venue of ["", "1VENUE", "venue-mit-dash", "TOOLONGVENUE1234567", "kr4k3n!"]) {
    assert.equal(tryNormalizeVenueSymbol(venue, "BTC").ok, false, venue);
  }
});

// ── instrumentId-/Storage-Validierung ───────────────────────────────────────

test("isValidInstrumentId akzeptiert kanonische UND native IDs, verwirft kaputtes", () => {
  assert.equal(isValidInstrumentId("KRAKEN:BTC/USD"), true);
  assert.equal(isValidInstrumentId("BINANCE:BTCUSDT"), true);
  assert.equal(isValidInstrumentId("BINANCE:BTC/USDT"), true);
  assert.equal(isValidInstrumentId("IBKR:EUR.USD"), true);
  assert.equal(isValidInstrumentId("IBKR:EUR/USD"), true);
  assert.equal(isValidInstrumentId("KRAKEN:XBTUSD"), true);
  assert.equal(isValidInstrumentId("kraken:BTC/USD"), true); // Venue-Case tolerant
  assert.equal(isValidInstrumentId("KRAKEN:BTC:USD"), false);
  assert.equal(isValidInstrumentId("BTC/USD"), false);
  assert.equal(isValidInstrumentId(":BTC"), false);
  assert.equal(isValidInstrumentId("KRAKEN:BTC;DROP"), false);
  assert.equal(isValidInstrumentId(""), false);
});

test("Storage-Muster bleibt legacy-kompatibel (Registry-Speicher)", () => {
  for (const ok of ["BTC/USD", "EUR.USD", "BTC-PERP", "EURUSD=X", "BRK.B", "BTCUSDT"]) {
    assert.equal(isValidStorageSymbol(ok), true, ok);
    assert.equal(STORAGE_SYMBOL_RE.test(ok), true, ok);
  }
  for (const bad of ["BTC;USD", "btc/usd", "BTC USD", "A".repeat(33)]) {
    assert.equal(isValidStorageSymbol(bad), false, bad);
  }
});

test("isValidVenueNativeSymbol: Order-Pfad verlangt venue-native Byte-Identität", () => {
  assert.equal(isValidVenueNativeSymbol("BITUNIX", "BTCUSDT"), true);
  assert.equal(isValidVenueNativeSymbol("BITUNIX", "BTC-USD"), false); // nicht nativ
  assert.equal(isValidVenueNativeSymbol("BITUNIX", "B"), false); // minLength 2
  assert.equal(isValidVenueNativeSymbol("BITUNIX", "BTCUSDT多余"), false);
  assert.equal(isValidVenueNativeSymbol("KRAKEN", "XBTUSD"), true);
  assert.equal(isValidVenueNativeSymbol("KRAKEN", "BTCUSD"), false); // unaliased
});

// ── Rule-Engine-Grenzen (§3.3) ──────────────────────────────────────────────

test("§3.3: sanitizeRuleSpec nutzt die SSoT, Sicherheitsgrenzen unverändert", () => {
  const base = {
    name: "t",
    condition: { logic: "all", conditions: [{ field: "rsi14", op: "lt", value: 30 }] },
    action: { side: "LONG", stopLossPct: 5 },
    window: { timeframe: "15m" },
  };
  // Der frühere Totalverlust: Slash-Symbole werden jetzt akzeptiert.
  const slash = sanitizeRuleSpec({ ...base, symbol: "BTC/USD" });
  assert.equal(slash.ok, true);
  if (slash.ok) assert.equal(slash.spec.symbol, "BTC/USD");
  // Legacy-Formate bleiben funktionsfähig.
  const legacy = sanitizeRuleSpec({ ...base, symbol: "btc" });
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.equal(legacy.spec.symbol, "BTC");
  // Injection/Schmuggel bleibt geschlossen.
  assert.equal(sanitizeRuleSpec({ ...base, symbol: "BTC;DROP TABLE" }).ok, false);
  // Seite/Operatoren unangetastet.
  assert.equal(
    sanitizeRuleSpec({ ...base, symbol: "BTC", action: { ...base.action, side: "SHORT" } }).ok,
    false
  );
});

// ── Profil-Vollständigkeit ──────────────────────────────────────────────────

test("Alle eingebauten Profile erfüllen die Kanon-Invariante (Roundtrip-Stabilität)", () => {
  for (const profile of [...VENUE_PROFILES, DEFAULT_PROFILE]) {
    const samples = ["BTC/USD", "ETH/USDT", "EUR/USD", "AAPL", "BRK.B"];
    for (const canonical of samples) {
      const native = profile.toVenueNative(canonical);
      const back = profile.toCanonical(native);
      // Aliase können die Form ändern (XBTUSD→BTC/USD), aber nie das Paar verlieren.
      const p = parseCanonicalSymbol(back);
      assert.equal(p.ok, true, `${profile.venue}: ${canonical} → ${native} → ${back} muss kanonisch parsebar bleiben`);
    }
  }
});
