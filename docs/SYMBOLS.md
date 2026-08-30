# Zentrale, venue-aware Symbol-Normalisierung (SYM-007)

**Status:** verbindlich seit **v1.28.0** · Single Source of Truth: `src/symbols/`
· Migrationsskript: `scripts/normalize-instrument-ids.ts` (`npm run symbols:normalize`)

Diese Seite dokumentiert (1) den Befund der vorherigen, auseinandergelaufenen
Symbol-Validierungen, (2) die verbindlichen Kanonisierungsregeln und (3) die
Fehler- und Migrationssemantik. Die Rule-Engine-Sicherheitsgrenzen bleiben
unangetastet (siehe Abschnitt 5).

---

## 1. Befund: die historischen Symbol-Regex-Muster (vor dem Fix)

Vier unabhängige Muster mit leicht unterschiedlicher Semantik validierten dasselbe
Konzept „Symbol“ — ein in der Registry gültiges Instrument (`KRAKEN:BTC/USD`)
verschwand still im Laufzeitpfad, weil MarketData und RuleEngine `/` ablehnten.

| # | Regex (vor Fix) | Datei | Akzeptiert | Abgelehnt |
| --- | --- | --- | --- | --- |
| 1 | `^[A-Z0-9]{1,20}(?:[/.\-_=][A-Z0-9]{1,10}){0,2}$` | `src/universe/validation.ts` (Registry-Speicher) | `BTC/USD`, `EUR.USD`, `BTC-PERP`, `EURUSD=X`, `BRK.B` | `btc/usd`, `BTC USD`, Strings > 32 |
| 2 | `^[A-Z0-9]{1,12}(?:[.=][A-Z0-9]{1,5})?$` | `src/lib/marketData.ts` (`sanitizeSymbol`) | `BTCUSDT`, `EUR.USD`, `EURUSD=X`, `BRK.B` | **`BTC/USD`**, **`BTC-USD`**, `KRAKEN:BTC/USD`, alles > 17 Zeichen |
| 3 | `^[A-Z0-9]{1,12}(?:[.=][A-Z0-9]{1,5})?$` | `src/lib/ruleEngine.ts` (`sanitizeRuleSpec`) | identisch zu (2) | identisch zu (2) — Regeln für `BTC/USD` & Co. wurden still verworfen |
| 4 | `^[A-Z0-9]{2,20}$` | `src/brokers/bitunix/orders.ts` (Order-Serialisierung) | `BTCUSDT` | `BTC/USD`, `BTC-USD`, `BTC/USDT`, alles mit Trennern |
| 5 | `^[A-Z0-9]{2,20}$` (Inline) | `src/brokers/bitunix/mapping.ts` (Trading-Pairs→Instrument) | `BTCUSDT` | wie (4) |
| 6 | `^[A-Z0-9][A-Z0-9:./\-_=]{0,63}$` | `parse.ts` der Portfolio-API (Eingangs-Whitelist) | `NVDA`, `BTC-USDT`, `BINANCE:BTCUSDT`, `KRAKEN:BTC/USD` | Kleinschreibung am Anfang, Leer-/Steuerzeichen |

**Folge (Sec. 1 des Tickets):** `KRAKEN:BTC/USD` ist in der Universe-Registry
valide (Muster 1), wurde aber von den Mustern 2 und 3 im Laufzeit-/Regelpfad
verworfen — ein gültiges Instrument „verschwand“ dort lautlos. Kein Security-
Boundary-Problem, sondern ein Inkonsistenz-Problem der Symbolsemantik.

**Nach dem Fix:** Muster 1 ist die zentrale Konstante `STORAGE_SYMBOL_RE`
(`src/symbols/normalize.ts`), die Muster 2/3 sind durch
`tryNormalizeVenueSymbol()` ersetzt (kanonische Ausgabe), die Muster 4/5 durch
`isValidVenueNativeSymbol("BITUNIX", …)`. Muster 6 ist eine API-Eingangs-Whitelist
und bleibt unverändert (sie akzeptiert heute bereits alle ID-Formen; sie
validiert Zeichen, keine Semantik).

---

## 2. Zielbild: eine venue-aware Normalisierungsschicht

```ts
// src/symbols/normalize.ts
export type CanonicalSymbol = {
  venue: string;          // "KRAKEN"
  canonical: string;      // kanonische Form, Paare mit "/", z. B. "BTC/USD"
  venueNative: string;    // was die Venue-API erwartet, z. B. "XBTUSD" / "BTCUSDT"
  instrumentId: string;   // `${VENUE}:${canonical}`
  assetClass: "CRYPTO" | "EQUITY" | "ETF" | "FX" | "UNKNOWN";
};

export function normalizeVenueSymbol(venue: string, rawSymbol: string): CanonicalSymbol;
export function tryNormalizeVenueSymbol(venue: string, rawSymbol: string):
  { ok: true; value: CanonicalSymbol } | { ok: false; reason: string };
export function isValidInstrumentId(id: string): boolean;
```

Beispiel (Ticket-Vorgabe):

```ts
normalizeVenueSymbol("KRAKEN", "xbt-usd");
// { venue: "KRAKEN", canonical: "BTC/USD", venueNative: "XBTUSD",
//   instrumentId: "KRAKEN:BTC/USD", assetClass: "CRYPTO" }
```

### Dateien

| Datei | Inhalt |
| --- | --- |
| `src/symbols/normalize.ts` | Public API (`normalizeVenueSymbol`, `tryNormalizeVenueSymbol`, `isValidInstrumentId`, `isValidStorageSymbol`, `isValidVenueNativeSymbol`, `cleanRawSymbol`, Warn-Senke) |
| `src/symbols/venueProfiles.ts` | Deklarative Venue-Profile + Paar-Parser (ReDoS-sichere, negierte Zeichenklassen) |
| `src/symbols/errors.ts` | `SymbolNormalizationError` (typisiert, Grund), `UnknownVenueProfileWarning`, `UnknownVenueProfileError` |
| `src/symbols/idMigration.ts` | Kernlogik des Migrationsskripts (§3.4) |
| `scripts/normalize-instrument-ids.ts` | CLI (`npm run symbols:normalize`) — Dry-Run ist Default |
| `tests/symbols/normalize.test.ts` | Golden-Tests |
| `tests/symbols/normalize.property.test.ts` | Property-Tests (deterministischer PRNG, Invarianten) |
| `tests/symbols/idMigration.test.ts` | Migrations-Tests |

**Ersetzte/angepasste Stellen:** `src/lib/marketData.ts`
(`sanitizeSymbol` → SSoT + Quellen-Routing), `src/lib/ruleEngine.ts`
(`sanitizeRuleSpec` → SSoT, siehe Abschnitt 5), `src/universe/validation.ts`
(`VENUE_RE`/`SYMBOL_RE` sind jetzt Re-Exporte der SSoT),
`src/brokers/bitunix/orders.ts` + `src/brokers/bitunix/mapping.ts`
(native Byte-Identität statt lokalem Regex), `src/lib/news.ts` (Finviz-Filter
kanonisch-aware). Weitere Broker (ALPACA/IBKR/BINANCE/KRAKEN/DYDX) sind
derzeit ehrliche Stubs ohne eigenes Symbol-Regex.

---

## 3. Kanonisierungsregeln (verbindlich, §3.2)

1. **Unicode-Bereinigung zuerst:** Unicode-Normalisierung **NFKC** → Entfernung
   von Zero-Width-Zeichen (`U+200B`–`U+200D`, `U+FEFF`) → Trim → Uppercase.
   NFKC bildet u. a. Vollbreiten-Formen (`ＢＴＣ` → `BTC`) und NBSP → Space ab.
2. **Akzeptierte Eingabeformate:** `BTCUSDT`, `BTC/USD`, `BTC-USD`, `BTC_USD`,
   `EUR.USD`, `EURUSD=X` sowie mit Venue-Präfix (`KRAKEN:BTC/USD`). Der Präfix
   muss zum Venue-Argument passen, sonst wird abgelehnt (kein Raten).
3. **Kanonisches Format je Anlageklasse:** Krypto-/FX-Paare mit `/`
   (`BTC/USD`, `EUR/USD`), Einzelwerte ohne Trenner (`AAPL`, `BRK.B` —
   der Punkt-Klassensuffix bleibt erhalten). Das kanonische Format enthält
   niemals `-` oder `_`.
4. **`instrumentId` ist immer `${VENUE}:${canonical}`.** Die Registry und der
   Historical Store speichern weiterhin ihre heutige, venue-native
   Speicherschreibweise (siehe Abschnitt 4 „Speicherform vs. Kanon“); die
   kanonische ID ist aus jedem gespeicherten Symbol über
   `tryNormalizeVenueSymbol` deterministisch ableitbar und ist die einzige ID,
   die neue Konsumenten (ab MDSYNC-001) verwenden.
5. **Parsing-Reihenfolge** (deckungsgleich mit der bisherigen
   Universe-Normalisierung): FX-Suffix (`EURUSD=X`) → expliziter Trenner
   (`/`, `-`, `_`, `.`) → Venue-Alias-Präfix (`XBTUSD`) → bekanntes
   Quote-Suffix (`BTCUSDT`) → einfacher Ticker (`AAPL`).
6. **Nichts wird geraten:** `BTC/US-D` (doppelter Trenner), `BRK-B`
   (1-Zeichen-Dash-Klasse), `EUR/USD=X` (FX-Suffix mit Trenner) werden mit
   maschinenlesbarem Grund abgelehnt — niemals „repariert“. Opake, heute
   funktionierende Yahoo-Formen (`JPY=X`) bleiben byte-identisch erhalten.

### Venue-Profile (`src/symbols/venueProfiles.ts`)

| Venue | Kanon ↔ Nativ | Besonderheiten |
| --- | --- | --- |
| `DEFAULT` (Fallback) | `BTC/USD` ↔ `BTC/USD` | striktes Default-Profil; Abfragepfad für `marketData`/RuleEngine ist `PAPER` (gleiche Politik) |
| `PAPER` | `BTC/USD` ↔ `BTC/USD` | Legacy-Ausführungspfad |
| `BINANCE` | `BTC/USDT` ↔ `BTCUSDT` | konkatenierte native Form |
| `KRAKEN` | `BTC/USD` ↔ `XBTUSD` | Alias `XBT ↔ BTC` (bijektiv, auch als Präfix in `XBTUSD`) |
| `BITUNIX` | `BTC/USDT` ↔ `BTCUSDT` | min. 2, max. 20 Zeichen (ex-Regex-Grenzen) |
| `DYDX` | `BTC/USD` ↔ `BTC-USD` | Dash-native Form |
| `ALPACA` | `AAPL` ↔ `AAPL` | Asset-Class-Fallback EQUITY |
| `IBKR` | `EUR/USD` ↔ `EUR.USD` | Punkt-native Form; Fallback EQUITY |

Konkatenierte native Formen (`BTCUSDT`) werden nur erzeugt, wenn die Quote
bekannt ist (`USDT/USDC/…`, Fiat) — sonst würde die Paar-Grenze verloren gehen
(Korruptionsschutz; der Trenner bleibt dann stehen und die Venue entscheidet).

### Asset-Class-Heuristik

FX-Suffix oder Fiat/Fiat-Paar → `FX`; Krypto-Quote (`USDT/USDC/BTC/ETH/…`) oder
Krypto-Basis mit USD-Quote → `CRYPTO`; Punkt-Klassensuffix (`BRK.B`) →
`EQUITY`; bekannte ETF-Ticker → `ETF`; bekannte Krypto-Basen → `CRYPTO`;
Venue-Fallback (ALPACA/IBKR → `EQUITY`), sonst **`UNKNOWN`** — die Heuristik
rät nie eine Klasse.

---

## 4. Speicherform vs. Kanon (wichtig für Bestandsdaten)

Die Registry speichert absichtlich die **venue-native Speicherschreibweise**
(`IBKR:EUR.USD`, `BINANCE:BTCUSDT`, `KRAKEN:BTC/USD` — letztere ist Kraken-
`wsname`-Konvention). Diese IDs ändern sich mit SYM-007 **nicht**; alle
bestehenden Referenzen (Watchlist, UI, Scanner) bleiben gültig. Neu ist die
**kanonische ID** (`IBKR:EUR/USD`) als einheitliche, venue-übergreifend
vergleichbare Form, die ab MDSYNC-001 die verbindliche ID für neue Konsumenten
ist. `isValidInstrumentId` akzeptiert beide Formen (validiert, ohne
umzuschreiben); die Abbildung Speicherform ↔ Kanon ist über die Venue-Profile
deterministisch.

Das Migrationsskript `npm run symbols:normalize` (Dry-Run ist Default,
`--apply` mit automatischem Backup `<datei>.bak-<ISO>`):

- **repariert nur strukturelle Korruption** (Venue-Kleinschreibung,
  `id ≠ venue:symbol`, History-ID-Präfix ≠ `venue`-Feld) — Ziel aus dem
  Symbolfeld abgeleitet, nie geraten;
- **meldet** legale Alt-Notationen als HINWEIS (`KRAKEN:BTC-USD`,
  `PAPER:EURUSD=X`), ohne sie zu ändern;
- **überspringt** Unparsebares und Zielkollisionen (kein stilles
  Serien-Merging), entfernt unter `--apply` byte-identische Dubletten;
- ist **idempotent**; Exit-Codes: 0 sauber, 1 Operator-Entscheid nötig,
  2 Dry-Run (Default).

Der aktuelle Seed (`data/universe/instruments.ndjson`, 26 Instrumente) ist
bereits konsistent: 0 Umbenennungen, 1 Hinweis (`PAPER:EURUSD=X`).

---

## 5. Unveränderte Rule-Engine-Sicherheitsgrenzen (§3.3)

Ausdrücklich **nicht** geändert:

- `RULE_ALLOWED_SIDE = "LONG"` (Shorts bleiben global gesperrt),
- numerische Operatoren `lt, lte, gt, gte, eq, between, in`,
- Trend-Operatoren `eq, in`,
- alle Ceilings (`RULE_CEILINGS`/`LIMIT_CEILINGS`), Feld-Whitelist und das
  „Code entscheidet“-Modell.

`sanitizeRuleSpec()` hat ausschließlich sein lokales Regex durch
`tryNormalizeVenueSymbol("PAPER", …)` ersetzt und arbeitet danach mit der
kanonischen Form. Regeln mit `BTC/USD` werden jetzt akzeptiert (vorher still
verworfen); Injection-Zeichen werden weiterhin verworfen (Property-Test P4:
3000 Verwebungen, 2000 Innen-Whitespace-Fälle).

## 6. Sichtbare Verhaltensänderungen (Migration für Konsumenten)

| Stelle | Vorher | Nachher |
| --- | --- | --- |
| `marketData.sanitizeSymbol("EURUSD=X")` | `"EURUSD=X"` | `"EUR/USD"` (kanonisch; Yahoo-URL bleibt `EURUSD=X` — das Routing bildet ab) |
| `marketData.sanitizeSymbol("BTC/USD")` | `null` | `"BTC/USD"` (Binance-Route `BTCUSDT`) |
| `marketData.sanitizeSymbol("BTC-USD")` | `null` | `"BTC/USD"` |
| `marketData.sanitizeSymbol("EUR.USD")` | `"EUR.USD"` (Yahoo 404) | `"EUR/USD"` → Yahoo `EURUSD=X` (jetzt datenbar) |
| `sanitizeRuleSpec(symbol: "BTC/USD")` | abgelehnt | akzeptiert, `spec.symbol === "BTC/USD"` |
| Quote-/Candle-Caches | Schlüssel = Eingabeform | Schlüssel = kanonische Form (dedupliziert Schreibweisen) |
| `STATIC_PRICES`-Fallback | nur exakter Schlüssel | zusätzlich Krypto-Basis des kanonischen Paares |
| Längenlimit Abfragepfad | 12 (+5 Suffix) | 24 Zeichen gesamt, Einzel-Ticker ≤ 12 |

Das Strict-Profil für unbekannte Venues greift im **Abfragepfad nicht
werfend** ein (Default-Profil + strukturierter Log-Eintrag
`unknown_venue_symbol_profile` vom Typ `UnknownVenueProfileWarning`) und im
**Registrierungs-/Sync-Pfad werfend** (`normalizeVenueSymbol(..., {
profilePolicy: "strict" })` → `UnknownVenueProfileError`).

## Siehe auch

- [MARKET_UNIVERSE.md](MARKET_UNIVERSE.md) — Registry-Datenmodell, `VENUE:SYMBOL`-Speicherschreibweise
- [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md) — Symbol-Lebenszyklus Sync → Scanner
- [HISTORY.md](HISTORY.md) — Historical Store (ndjson, Schlüssel `instrumentId + timeframe + ts`)
- [ERROR_HANDLING_MARKETDATA.md](ERROR_HANDLING_MARKETDATA.md) — Fehlertaxonomie des Datenpfads
