# Market Universe — broker-unabhängige Instrumenten-Registry (Task 01)

**Stand:** 2026-08-27 · **Modul:** `src/universe/` · **API:** `/api/markets`
**Status:** Fundament-Umbau 1 von 12 — ersetzt die Watchlist als Marktdefinition.

---

## 1. Zielbild

Vor diesem Task war `DEFAULT_WATCHLIST` in `src/lib/marketData.ts` die faktische
Definition des handelbaren Universums: neun Strings, hart im Code, ohne Venue,
ohne Handelsbedingungen, ohne Zustand. Alles, was danach kam (Kursabruf,
Marktscan, Regelwerk, Broker), hing an dieser Liste.

Ab Task 01 gilt:

> **Die Instrument-Registry ist die einzige Quelle der Wahrheit darüber, was
> handelbar ist. Die Watchlist ist nur noch eine Anzeigereihenfolge.**

Drei Prinzipien, die den Rest der Umbau-Serie tragen:

| Prinzip | Bedeutung |
| --- | --- |
| **Symbol ≠ Markt** | `BTC` ist ein Asset. `BINANCE:BTCUSDT` (Spot), `KRAKEN:BTC/USD` (Spot) und `BITUNIX:BTCUSDT` (Perpetual) sind **drei Instrumente** mit **einem** ökonomischen Underlying (`BTC`). |
| **Broker-Unabhängigkeit** | Der Kern kennt kein Broker-SDK, keine Venue-Sonderlogik, keine Credentials — nur das Schema unten und Capability-Flags (`paperAvailable`, `liveAvailable`, `leverageAvailable`, `shortAvailable`). |
| **Determinismus** | Kein LLM, kein Netzwerk-Call, keine Zufallswerte im Kernlayer. Gleiche Eingabe ⇒ gleiche Datei, stabile Sortierung nach `id`. |

### Abgrenzung — was dieser Task *nicht* tut

* Keine Live-Trading-Funktion. `liveAvailable` ist eine **Fähigkeitsangabe**, kein Schalter.
* Kein Marktdaten-Abruf. `volume24h`, `spread`, `volatility` starten auf `null`;
  gefüllt werden sie von späteren Tasks (Liquidity-/Ranking-Layer).
* Keine Änderung an Guardrails, Broker oder Order-Pfad — `PaperBroker` läuft unverändert.

---

## 2. Datenmodell

### 2.1 Drei Ebenen

```
Underlying   BTC              ökonomische Exposure ("worauf wette ich?")
    │
Asset        BTC              venue-unabhängiger Ticker + Anlageklasse
    │
Instrument   BINANCE:BTCUSDT  handelbarer Kontrakt an genau einer Venue
             KRAKEN:BTC/USD   … mit eigenen Gebühren, Ticks, Flags
             BITUNIX:BTCUSDT  … Perpetual: anderer Markttyp, gleiches Underlying
```

`Asset` und `Underlying` werden **abgeleitet, nicht persistiert**
(`assetOf()`, `underlyingOf()`, `withRelations()` in `normalization.ts`).
Persistiert wird ausschließlich das Instrument — jede Ableitung ist
deterministisch reproduzierbar.

### 2.2 Feldkatalog `MarketInstrument`

Deckungsgleich mit `src/universe/types.ts`. 20 fachliche Pflichtfelder plus die
abgeleitete Identität `id` (= `VENUE:SYMBOL`) — zusammen 21 Schlüssel pro Zeile
in der Persistenz.

| # | Feld | Typ | Bedeutung |
| --- | --- | --- | --- |
| 0 | `id` | `string` | Kanonische Identität `"<VENUE>:<SYMBOL>"`, z. B. `"BINANCE:BTCUSDT"`. Wird immer aus `venue` + `symbol` erzeugt, nie frei gesetzt. |
| 1 | `venue` | `string` | Handelsplatz in Großbuchstaben (`PAPER`, `ALPACA`, `IBKR`, `BINANCE`, `KRAKEN`, `DYDX`, `BITUNIX`, …). Bewusst `string`, keine Union — neue Venues brauchen keine Kernänderung. |
| 2 | `symbol` | `string` | Venue-natives Symbol, exakt so wie die Venue es schreibt: `BTCUSDT`, `BTC/USD`, `EUR.USD`, `SPY`. |
| 3 | `base` | `string \| null` | Basis-Asset bei Paaren (`"BTC"`), `null` bei Einzelwerten (Aktie/ETF). |
| 4 | `quote` | `string` | Quote-/Abrechnungswährung: `USDT`, `USD`, `EUR`, … |
| 5 | `assetClass` | `'crypto' \| 'equity' \| 'etf' \| 'fx' \| 'commodity' \| 'index' \| 'other'` | Anlageklasse; steuert später Ranking- und Risikoprofile. |
| 6 | `marketType` | `'spot' \| 'perpetual' \| 'future' \| 'option' \| 'cfd'` | Kontraktmechanik (Funding, Verfall, Hebel). |
| 7 | `status` | `'active' \| 'halted' \| 'delisted' \| 'preview'` | Handelbarkeitszustand aus Sicht der Registry. |
| 8 | `minQuantity` | `number` | Kleinste handelbare Menge (> 0). |
| 9 | `priceStep` | `number` | Preis-Tick (> 0); jede Order muss ein Vielfaches treffen. |
| 10 | `quantityStep` | `number` | Mengen-Tick (> 0). |
| 11 | `makerFee` | `number` | Maker-Gebühr als Dezimalanteil (`0.001` = 0,1 %); Rabatte dürfen negativ sein, Betrag ≤ 0.1. |
| 12 | `takerFee` | `number` | Taker-Gebühr als Dezimalanteil. |
| 13 | `leverageAvailable` | `boolean` | Hebel an dieser Venue für dieses Instrument verfügbar. |
| 14 | `shortAvailable` | `boolean` | Short-Verkauf möglich. |
| 15 | `paperAvailable` | `boolean` | Im Paper-Modus simulierbar (Kursquelle vorhanden). |
| 16 | `liveAvailable` | `boolean` | Live handelbar — reine Fähigkeitsangabe, **kein** Freigabeschalter. |
| 17 | `volume24h` | `number \| null` | 24-h-Volumen in Quote-Währung; `null` = unbekannt (nicht 0!). |
| 18 | `spread` | `number \| null` | Relativer Spread (`0.0004` = 4 bp); `null` = unbekannt. |
| 19 | `volatility` | `number \| null` | Annualisierte Volatilität als Dezimalanteil; `null` = unbekannt. |
| 20 | `lastSeen` | `string` | ISO-8601-UTC-Zeitstempel der letzten Bestätigung durch eine Quelle. |

**`null` heißt „unbekannt“, nie „null“.** Metrik-Filter (`minVolume24h`,
`maxSpread`, `maxVolatility`) schließen unbekannte Werte deshalb aus, statt sie
optimistisch als 0 zu behandeln.

### 2.3 Abgeleitete Typen

| Typ | Felder | Ableitung |
| --- | --- | --- |
| `Asset` | `id`, `symbol`, `assetClass` | `base` bzw. Symbol ohne FX-Suffix |
| `Underlying` | `id`, `assetId`, `assetClass` | identisch zur Asset-ID — verbindet Spot/Perp/Future desselben Basiswerts |
| `Instrument` | `MarketInstrument` + `assetId` + `underlyingId` | `withRelations()` |

---

## 3. Registry-Layer

`src/universe/registry.ts` → Klasse `InstrumentRegistry`.

| Operation | Signatur | Verhalten |
| --- | --- | --- |
| Laden | `load(force?)` | Liest NDJSON, validiert jede Zeile; kaputte Zeilen werden gezählt (`skippedLines`), nie geworfen. |
| Anlegen/Ändern | `upsert(input, source)` | Merge-Upsert, ein Audit-Eintrag. |
| Batch | `upsertMany(inputs, source, action?)` | Max. 5000 Sätze; gute Sätze werden geschrieben, kaputte einzeln in `rejected` gemeldet. |
| Lesen | `get(id)`, `find(venue, symbol)`, `getWithRelations(id)` | `null`, wenn unbekannt oder Format ungültig. |
| Löschen | `remove(id, source)` | `boolean`, Audit-Eintrag bei Erfolg. |
| Suchen | `query(filter)` | Alle Filter UND-verknüpft, stabil nach `id` sortiert, paginiert. |
| Gruppieren | `groupByVenue(items)`, `countByVenue()` | Venues alphabetisch. |
| Beziehungen | `underlyings()`, `instrumentsForUnderlying(id)` | Venue-übergreifende Sicht. |
| Stand | `lastSync` | Jüngster `lastSeen` über alle Instrumente (`null` bei leerem Universum). |

### 3.1 Upsert-Konfliktverhalten

1. Angegebene Felder überschreiben den Bestand.
2. **Nicht** angegebene Felder bleiben erhalten — ein Teil-Update setzt nichts auf Defaults zurück.
3. `null` bei `volume24h` / `spread` / `volatility` bedeutet „kein neuer Wert“ und lässt den Bestandswert stehen.
4. `lastSeen` wird auf den Eingabewert bzw. „jetzt“ gesetzt.
5. Inhaltlich identischer Satz ⇒ `unchanged`, keine Datei-Schreiboperation, kein Audit-Eintrag.

### 3.2 Filter und Pagination

`venue`, `assetClass`, `marketType`, `status` (je Einzelwert oder Liste),
`paperAvailable`, `liveAvailable`, `leverageAvailable`, `shortAvailable`,
`base`, `quote`, `underlying`, `minVolume24h`, `maxSpread`, `maxVolatility`,
`search` (Teilstring auf der ID, **kein** Regex).

Pagination: `page` (1-basiert, ≥ 1) und `pageSize` (1…**500**, Default 100).
Überschreitungen werden **geklemmt**, nicht abgelehnt — ein zu großer Wert soll
keinen Job abbrechen, aber auch nie das ganze Universum in eine Antwort ziehen.

### 3.3 Persistenz

`data/universe/instruments.ndjson` — eine Zeile je Instrument, stabile
Feldreihenfolge, sortiert nach `id`, atomar geschrieben (`tmp` + `rename`).

Warum NDJSON und nicht PostgreSQL?

* Das Universum ist **Konfigurationswissen**, kein Transaktionszustand: es soll im Git-Diff reviewbar sein.
* Die Registry muss **ohne laufende Datenbank** funktionieren (Tests, CI, Kaltstart vor dem Schema-Push).
* Zeilenformat ⇒ minimale, lesbare Diffs bei Discovery-Läufen.

Verzeichnis überschreibbar via `UNIVERSE_DATA_DIR` (absolut oder relativ zum Projektstamm).

---

## 4. Normalisierungsregeln

| Schritt | Regel |
| --- | --- |
| Venue | Trim → Uppercase; Muster `^[A-Z][A-Z0-9_]{1,15}$`. |
| Symbol | Trim → Uppercase → Leerzeichen entfernt; Muster `^[A-Z0-9]{1,20}(?:[/.\-_=][A-Z0-9]{1,10}){0,2}$`. Die venue-typische Schreibweise (`/` bei Kraken, keine Trenner bei Binance) bleibt erhalten — sie ist Teil der Identität. |
| ID | Immer `VENUE:SYMBOL`. Eine mitgelieferte, abweichende `id` ist ein Validierungsfehler. |
| base/quote | 1) FX-Suffix `=X` (`EURUSD=X` → EUR/USD) → 2) expliziter Trenner (`BTC/USD`, `BTC-USD`, `EUR.USD`; `-PERP`/`-SWAP` → Quote `USD`) → 3) bekanntes Quote-Suffix (`BTCUSDT` → BTC/USDT) → 4) kein Paar (`SPY`, `BRK.B`). |
| `assetClass` | FX-Suffix oder Fiat/Fiat → `fx`; Krypto-Quote (`USDT/USDC/TUSD/FDUSD/BUSD/BTC/ETH`) oder Nicht-Fiat-Basis gegen `USD` → `crypto`; sonst `equity`. Explizite Angabe schlägt jede Ableitung. |
| `marketType` | Venue `DYDX` oder Symbol-Suffix `-PERP`/`-SWAP` → `perpetual`, sonst `spot`. Explizite Angabe schlägt die Ableitung. |
| Defaults | Konservativ: `status: active`, `paperAvailable: true`, `liveAvailable: false`, `leverageAvailable: false`, `shortAvailable: false`, Metriken `null`. |

### 4.1 Ausschluss-Policy

Konfigurationsdatei: `src/universe/policy.default.json` (Spiegel der eingebauten
`DEFAULT_POLICY`). Override über `UNIVERSE_POLICY_FILE=/pfad/policy.json`.

```json
{
  "version": 1,
  "maxSymbolLength": 32,
  "rules": [
    { "id": "leveraged-token", "field": "symbol",
      "pattern": "^[A-Z]{2,10}(?:3L|3S|5L|5S|UP|DOWN|BULL|BEAR)(?:USDT|USDC|USD|BUSD)?$",
      "reason": "Gehebelte Token bilden ihren Basiswert wegen täglichem Rebalancing nicht linear ab." },
    { "id": "test-symbol", "field": "symbol",
      "pattern": "^(?:TEST|DEMO|SANDBOX)[A-Z0-9/._=-]*$",
      "reason": "Test- und Sandbox-Symbole gehören nicht ins Handelsuniversum." }
  ],
  "excludeVenues": [],
  "excludeQuotes": []
}
```

Regeln: `field` ∈ `symbol | id | venue | quote | base | status`, max. 50 Regeln,
max. 120 Zeichen je Muster; jede Datei wird beim Laden validiert. Eine defekte
Override-Datei ist ein **harter Startfehler** — stilles Zurückfallen auf eine
schwächere Policy wäre eine Sicherheitsfalle. Ein per Policy ausgeschlossener
Satz wird mit `POLICY_EXCLUDED` und Regel-ID abgelehnt und im Audit gezählt.

---

## 5. Migration der Watchlist

Die neun Symbole der alten `DEFAULT_WATCHLIST` wurden zu **26 Seed-Instrumenten**
(`src/universe/seed.ts`, erzeugt via `npm run universe:seed`):

| Quelle | Zielinstrumente |
| --- | --- |
| BTC, ETH, SOL | `BINANCE:BTCUSDT/ETHUSDT/SOLUSDT` + `KRAKEN:BTC/USD, ETH/USD, SOL/USD` |
| SPY, QQQ, NVDA, AAPL, MSFT | je `ALPACA:<SYM>` + `IBKR:<SYM>` |
| EURUSD=X | `IBKR:EUR.USD` (assetClass `fx`) |
| alle neun | zusätzlich `PAPER:<SYM>` — hält den bestehenden Paper-Broker-Pfad unverändert lauffähig |

`DEFAULT_WATCHLIST` existiert weiter, ist aber `@deprecated` und wird aus
`UI_WATCHLIST_PREFERENCE` (`src/universe/watchlist.ts`) abgeleitet — einer Liste
von **Instrument-ID-Referenzen** mit Anzeigenamen. Reihenfolge und Inhalt sind
byte-identisch zur alten Liste; kein bestehender Aufrufer bricht.

```ts
export const UI_WATCHLIST_PREFERENCE = [
  { instrumentId: "PAPER:BTC", displaySymbol: "BTC", label: "Bitcoin (Paper)" },
  // …
];
```

---

## 6. API-Referenz

### 6.1 `GET /api/markets`

Query-Parameter (alle optional, UND-verknüpft, Mehrfachwerte kommasepariert):

| Parameter | Werte |
| --- | --- |
| `venue` | `BINANCE`, `BINANCE,KRAKEN`, … |
| `assetClass` | `crypto`, `equity`, `etf`, `fx`, `commodity`, `index`, `other` |
| `marketType` | `spot`, `perpetual`, `future`, `option`, `cfd` |
| `status` | `active`, `halted`, `delisted`, `preview` |
| `paperAvailable`, `liveAvailable`, `leverageAvailable`, `shortAvailable` | `true` \| `false` |
| `base`, `quote`, `underlying` | Ticker (`^[A-Z0-9]{1,12}$`) |
| `minVolume24h`, `maxSpread`, `maxVolatility` | Zahl ≥ 0 |
| `q` | Teilstring auf der ID, max. 64 Zeichen |
| `page`, `pageSize` | ≥ 1 bzw. 1…500 (Default 100) |

**Request**

```http
GET /api/markets?venue=BINANCE&assetClass=crypto&pageSize=2
```

**Response 200**

```json
{
  "ok": true,
  "venue": "BINANCE",
  "count": 2,
  "lastSync": "2026-08-27T00:00:00.000Z",
  "instruments": [
    {
      "id": "BINANCE:BTCUSDT", "venue": "BINANCE", "symbol": "BTCUSDT",
      "base": "BTC", "quote": "USDT", "assetClass": "crypto",
      "marketType": "spot", "status": "active",
      "minQuantity": 0.00001, "priceStep": 0.01, "quantityStep": 0.00001,
      "makerFee": 0.001, "takerFee": 0.001,
      "leverageAvailable": false, "shortAvailable": false,
      "paperAvailable": true, "liveAvailable": true,
      "volume24h": null, "spread": null, "volatility": null,
      "lastSeen": "2026-08-27T00:00:00.000Z"
    },
    { "id": "BINANCE:ETHUSDT", "…": "…" }
  ],
  "groups": [{ "venue": "BINANCE", "count": 2, "instruments": [ "…" ] }],
  "page": 1, "pageSize": 2, "total": 3, "hasMore": true
}
```

`venue` beschreibt den Ausschnitt: konkrete Venue, kommaseparierte Auswahl oder
`"ALL"` ohne Filter. `groups` liefert dieselbe Ergebnismenge nach Venue gruppiert.

**Response 400**

```json
{ "ok": false, "error": "VALIDATION_ERROR",
  "message": "assetClass: \"quatsch\" ist keiner von crypto | equity | etf | fx | commodity | index | other",
  "details": { "maxPageSize": 500 } }
```

### 6.2 `GET /api/markets/{venue}/{symbol}`

Symbole mit `/` URL-kodieren (`/api/markets/KRAKEN/BTC%2FUSD`); alternativ wird
`~` als Alias akzeptiert (`/api/markets/KRAKEN/BTC~USD`).

```json
{
  "ok": true,
  "instrument": { "id": "BINANCE:BTCUSDT", "…": "…", "assetId": "BTC", "underlyingId": "BTC" },
  "related": ["KRAKEN:BTC/USD", "PAPER:BTC"],
  "lastSync": "2026-08-27T00:00:00.000Z"
}
```

| Status | Body |
| --- | --- |
| 400 | `{ "ok": false, "error": "VALIDATION_ERROR", "message": "venue: ungültiges Format" }` |
| 404 | `{ "ok": false, "error": "NOT_FOUND", "message": "Instrument BINANCE:DOGEUSDT ist nicht im Universum." }` |
| 500 | `{ "ok": false, "error": "INTERNAL_ERROR", "message": "<redigiert>" }` |

Beide Endpunkte sind **lesend** und mutieren die Registry nie; deshalb greift —
wie bei den übrigen GET-Routen — keine Token-Pflicht.

---

## 7. Audit

Jede Mutation erzeugt genau einen Eintrag:

```json
{ "actor": "system", "source": "seed:script", "action": "SEED",
  "changed": 26, "created": 26, "updated": 0, "rejected": 0,
  "ids": ["ALPACA:AAPL", "…"], "timestamp": "2026-08-27T12:26:47.858Z" }
```

* **Dateisenke (immer aktiv):** `data/universe/audit-log.ndjson`, append-only, nicht versioniert.
* **Datenbanksenke (optional):** `UNIVERSE_AUDIT_DB=1` schreibt zusätzlich in die
  Tabelle `audit_log` (Event `UNIVERSE_MUTATION`, Level `INFO`, Detail = Eintrag oben).
  Fehler dort werden redigiert geloggt und brechen die Mutation nicht ab.

Protokolliert werden ausschließlich IDs und Zähler — niemals Payloads, Header oder Credentials.

---

## 8. Konfiguration

| Variable | Default | Zweck |
| --- | --- | --- |
| `UNIVERSE_DATA_DIR` | `data/universe` | Ablage von Instrumenten- und Audit-Datei |
| `UNIVERSE_POLICY_FILE` | *(leer)* | Pfad zu einer Policy-Override-Datei |
| `UNIVERSE_AUDIT_DB` | *(leer)* | `1` = Audit zusätzlich nach PostgreSQL |

Kommandos: `npm run universe:seed` (deterministisch), `npm test`,
`npm run test:coverage` (Coverage-Bericht für `src/universe/**`).

---

## 9. Offene Punkte

1. **Discovery-Adapter** (Task 2+): Venue-seitige Instrumentenlisten holen und via `upsertMany` einspeisen — die Registry bleibt dabei netzwerkfrei, der Adapter liegt außerhalb.
2. **Metriken füllen**: `volume24h`, `spread`, `volatility` sind bis dahin `null`; Liquidity-/Risk-Filter brauchen sie.
3. **Delisting-Lifecycle**: aktuell nur Statuswechsel; Aufräumregeln (Retention, automatisches `halted` bei fehlendem `lastSeen`) fehlen bewusst.
4. **Symbol-Alias-Tabelle**: `KRAKEN:XBT/USD` ↔ `BTC` ist noch nicht abgebildet; heute wird die venue-native Schreibweise 1:1 übernommen.
5. **UI-Anbindung**: Das Operations Center (Task 10) rendert `docs/help/market-universe.help.json` als Tooltips; die Watchlist-Präferenz soll dort editierbar werden.
6. **Monitor/Marktscan** liest weiterhin `DEFAULT_WATCHLIST` (Legacy-Alias). Umstellung auf `registry.query()` ist für den Ranking-Task vorgesehen.
