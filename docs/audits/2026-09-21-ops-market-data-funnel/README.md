# Market-Data-Funnel: Fehleranalyse, Root-Cause und Behebungsplan

- **Stand:** 2026-09-21 (UTC)
- **Quelle:** Operations Center, Sektion „Market Data" (Screenshot vom 2026-09-21 19:51:16 UTC) plus lokale Verifikation im Repo
- **Version:** `1.58.0` (`package.json`)
- **Sprache:** Deutsch (Repo-Konvention)

## 1. Beobachtung (Screenshot)

```
Registry 26, Außer Scope 12, Discovered 0, Data-ready 0, Warming 14
Candles 0 / 61, Ticker-ready 0, Spread-ready 0, Scanner-ready NO
Hint: „Market-Data-Abrufe schlagen fehl (haeufigste Ursache: SCHEMA_MISMATCH)."
Letzter Sync je Venue:
  ALPACA nie (5), BINANCE nie (3), BITUNIX 2026-09-20 22:52 degraded
    (250 Instrumente, SCHEMA_MISMATCH×1, UNKNOWN×1),
  IBKR nie (6), KRAKEN nie (3), PAPER nie (9)
Worst offenders: ALPACA:AAPL/MSFT/NVDA/QQQ, PAPER:AAPL/ETH/EURUSD=X/MSFT/NVDA/QQQ je 0/61
Ablehnungs-Diagnose (26): alle min-candles, „Volumen nicht geladen · Spread nicht geladen"
```

Zwei getrennte Symptome:

1. Fünf Venues haben **noch nie** synchronisiert.
2. Die einzige aktive Venue (BITUNIX) war zum Screenshot-Zeitpunkt **degraded** mit zwei klassifizierten Fehlern.

## 2. Architektur-Kurzfassung (wichtig für die Einordnung)

- Pipeline: `Discovery → Enrichment (Ticker bulk + Orderbook/Depth) → Backfill (Klines) → Readiness`.
  Orchestrierung: `src/marketdata/sync.ts` (`MarketDataSyncService`).
- Das Ops-Panel ist eine **reine Lese-Aggregation** (Registry + Historical Store + Sync-Status-Manifeste), kein Netzwerk, kein Sync-Trigger:
  `src/ops/collectMarketData.ts`, `src/ops/marketDataReadiness.ts`.
- Warmup-Bedarf: `requiredWarmupCandles(config)` (`src/scanner/warmup.ts:60`), Default **61**
  (EMA50 + Momentum-Lookback 60 + 1 Referenzkerze).
- Sync-Default: nur Timeframe **`1h`** (`src/marketdata/types.ts:75`, `SYNC_TIMEFRAMES`),
  `SYNC_CANDLE_LIMIT = 150`.
- Readiness-Regel: `dataReady ⇔ Kerzen ≥ 61 UND volume24h !== null UND spread !== null`
  (`src/ops/marketDataReadiness.ts:172`, `src/ops/collectMarketData.ts:124-131`).
- Fehler-Taxonomie: `src/lib/marketDataErrors.ts` (`classifyMarketDataError`).
- Daten-Scope: Nur Venues **mit mindestens einer Kerze im Store** blockieren READY;
  Preset-Venues ohne Kerzen zählen als `outOfScope` (`dataScopeInstruments()`,
  `src/ops/marketDataReadiness.ts:113-124`; Spiegel in `src/scanner/warmup.ts:149-167`
  via `scopeVenues: "data"`). Kaltstart-Schutz: hat **keine** Venue Kerzen, bleiben
  alle Instrumente im Scope (sonst wäre der leere Store fälschlich READY).

## 3. Hypothesen und Prüfung

### Hypothese A: „Die Börsen liefern keine Daten" (Marktproblem)

- **Widerlegt.** BITUNIX liefert. Lokale Verifikation am 2026-09-21 ~20:32 UTC:
  `data/market-sync-status.json` → `degraded: false`, `failuresByReason: {}`,
  `instruments: 250`; `data/marketdata/quality-report.json` → 250 Reihen,
  37500 Kerzen (= 150 je Reihe, also volles `SYNC_CANDLE_LIMIT`),
  nur 1× `OUTLIER` (Qualitätsbefund, kein Fetch-Fehler).
  `data/history/candles.ndjson` ≈ 23 MB.
- Der leere Funnel im Screenshot ist daher **kein Marktbefund**.

### Hypothese B: „Genereller Sync-Defekt für alle Venues"

- **Teilweise widerlegt / präzisiert.** Der Sync funktioniert für BITUNIX.
  Für ALPACA/BINANCE/IBKR/KRAKEN/PAPER existiert **gar kein Adapter**, es kann also
  auch kein genereller Laufzeitfehler vorliegen — sondern eine fehlende Integration
  (siehe Hypothese C).

### Hypothese C: „Preset-Venues ohne Adapter" (Hauptursache für 0/61)

- **Bestätigt.** `src/marketdata/registerAdapters.ts:64`:
  `KNOWN_SYNC_VENUES = [BITUNIX]`. Es gibt genau eine Adapter-Fabrik
  (`createAdapter()`, nur `BITUNIX_VENUE`); alles andere meldet `UNKNOWN_VENUE`
  und wird als `skipped` berichtet, nie synchronisiert.
- Die 26 Screenshot-Instrumente (`ALPACA:*`, `BINANCE:*`, `IBKR:*`, `KRAKEN:*`,
  `PAPER:*`) sind kuratierte Presets aus `data/universe/instruments.ndjson`
  ( versioniert ) mit `lastSeen: 2026-08-27`, `volume24h: null`, `spread: null`.
  Ohne Adapter bleiben Ticker-Enrichment, Depth-Enrichment und Kline-Backfill für
  sie dauerhaft aus → `0/61`, `min-candles`, `rule=max-spread`-Folgefehler.
- Das Panel zeigt das **korrekt** als `letzter Sync: nie` an
  (`buildVenueRows()`, `src/ops/collectMarketData.ts:255-283`).
- Zuständigkeitskette: `registerAdapters()` → `MarketDataSyncService.syncVenue()` wirft
  `UnsupportedVenueError` für unbekannte Venues; `syncAll()` läuft nur über
  registrierte Adapter.

### Hypothese D: „SCHEMA_MISMATCH = Bitunix-API hat ihr Format gebrochen"

- **Nur teilweise bestätigt — es ist eine Sammel-Klassifikation, kein Beweis eines
  API-Bruchs.** `classifyMarketDataError()` (`src/lib/marketDataErrors.ts:200-240`)
  mappt auf `SCHEMA_MISMATCH` bei:
  - `code: "SCHEMA_MISMATCH"` / `ZodError`,
  - `SyntaxError` / JSON-Parse-Markern,
  - Discovery-Zeile ohne gültiges Symbol (`src/marketdata/sync.ts:590-600`,
    dort zusätzlich `INVALID_SYMBOL` bzw. Kappungs-`SCHEMA_MISMATCH` bei
    `> MAX_RESPONSE_ROWS`),
  - Store-Ablehnung ungültiger Kerzen (`sync.ts:1168-1177`).
- Der Transport (`src/brokers/bitunix/publicClient.ts:29-39`, `envelopeData()`)
  wirft bei `envelope.code !== 0` einen `BitunixApiError`; dessen Klassifikation
  (`classifyBitunixFailure`) entscheidet, was später als `SCHEMA_MISMATCH`,
  `RATE_LIMITED`, `UPSTREAM_5XX` usw. gezählt wird.
- Konkrete empfindliche Stellen (Format-Annahmen, keine exhortativen Änderungen
  ohne Repro):
  - `mapKline()` (`publicClient.ts:281-292`): erwartet `time/open/high/low/close`
    als Zahl-oder-String, `baseVol/quoteVol` optional; liefert `null` bei Fehlen →
    führt bei 0 verwertbaren Bars zu `DATA_UNAVAILABLE` (`sync.ts:1067-1076`),
    nicht zu `SCHEMA_MISMATCH`.
  - `mapTradingPairToInstrument()` (`src/marketdata/adapters/bitunix.ts:118-179`):
    verwirft Zeilen ohne normalisierbares Symbol oder ohne `base/quote`
    (auch via `inferBase`/`inferQuote`); der Sync zählt sie als `unusableRows`.
  - `mapTicker()` (`publicClient.ts:266-279`): toleriert fehlende `quoteVol/baseVol`
    als `undefined` → Enrichment-`null` (Data-Quality, kein Fehler).
  - `BITUNIX_TIMEFRAME_MAP` (`adapters/bitunix.ts:53-64`): `3m`/`5d` sind
    dokumentierte Lücken (`null` → `UnsupportedTimeframeError`); ein Sync mit
    diesen Timeframes schlägt pro Reihe fehl — aktuell irrelevant, da nur `1h`
    gesynct wird.
- **Zeitliche Einordnung:** Der Screenshot (`2026-09-20 22:52 degraded`,
  `SCHEMA_MISMATCH×1, UNKNOWN×1`) ist älter als der aktuelle lokale Zustand
  (`2026-09-21 20:32`, `degraded: false`, 0 Fehler). Der Fehler war also
  **transient** (einzelne Zeile / einzelner Chunk / einzelner Depth-Call) und ist
  lokal nicht mehr reproduzierbar, solange kein historischer Sync-Report
  (`data/marketdata/sync-report-*.json`) mit den beiden Failure-Einträgen vorliegt.
  `UNKNOWN` heißt dabei lediglich: kein HTTP-Status, kein bekannter Code —
  Ursache aus dem klassifizierten Zähler allein **nicht** bestimmbar.

### Hypothese E: „Leeres Fehler-Manifest, trotzdem ERROR"

- **Bestätigt als Zustands-, nicht Codefehler.** `collectMarketDataReadiness()`
  (`src/ops/collectMarketData.ts:144-149`): `dataErrors.size > 0 → ERROR`
  (Infrastruktur schlägt Fachlogik). `buildReadinessHint()` nennt die dominante
  `reason` über alle Venues (`SCHEMA_MISMATCH`).
- Lokal existiert aktuell **kein** `data/market-data-errors.json`
  (Datei fehlt → `loadMarketDataErrors()` liefert leere Map → kein ERROR).
  Zum Screenshot-Zeitpunkt muss das Manifest Einträge enthalten haben.
  Fazit: `ERROR` war damals korrekt; heute wäre derselbe Zustand `WARMING`.

### Hypothese F: „26 vs. 250 Instrumente — Zählfehler im Panel"

- **Erklärt, kein Zählfehler.** `loadSnapshotInput()`
  (`collectMarketData.ts:233-248`) lädt `loadAllInstruments()` **gekapt**
  (`MAX_SERVICE_INSTRUMENTS`, DoS-Schutz), meldet aber `registrySize: getRegistry().size`
  als echte Größe. `dataScopeInstruments()` spaltet in `scoped` vs. `outOfScope`.
  Der Screenshot (`Registry 26, Außer Scope 12`) ist eine gefilterte/gekappte Sicht
  (Preset-Universum); die aktuelle `instruments.ndjson` enthält zusätzlich ~250
  BITUNIX-Zeilen mit frischem `lastSeen` (2026-09-21) plus Enrichment-Werten.
  Bei BITUNIX-Kerzen im Store fallen die Preset-Venues aus dem Scope —
  deren Nullen blockieren READY dann nicht mehr.

## 4. Root-Cause (Kurzfassung)

1. **Hauptursache (strukturell, permanent):** Nur BITUNIX ist als Sync-Venue
   verdrahtet (`KNOWN_SYNC_VENUES = [BITUNIX]`). ALPACA/BINANCE/IBKR/KRAKEN/PAPER
   sind Presets ohne Adapter und ohne Sync — `0/61`, kein Volumen, kein Spread,
   `min-candles`. Das ist eine **fehlende Venue-Integration** (bzw. ein
   Kurations-/Scope-Problem), kein Laufzeit-Bug.
2. **Nebenursache (transient):** 1× `SCHEMA_MISMATCH` + 1× `UNKNOWN` bei BITUNIX
   am 2026-09-20 haben den Lauf auf `degraded` gesetzt und — via Fehler-Manifest —
   den Readiness-Status auf `ERROR` gehoben. Ohne den historischen Sync-Report ist
   die einzelne Zeile nicht mehr identifizierbar; der aktuelle Lauf ist fehlerfrei.
3. **Verschärfend:** `staleSeries: 190` (1h) — der inkrementelle Sync überspringt
   frische Reihen (`freshTimeframes`), alte Lücken schließen sich nur mit `--full`
   oder nach Periodenrand. `PAPER:BTC 29/61` u. ä. sind nie nachgefüllt worden,
   weil PAPER nie gesynct wird.

## 5. Behebung (Plan)

1. **Diagnose sichern (vor jeder Änderung):**
   - Historischen Sync-Report zum 2026-09-20-Lauf suchen
     (`data/marketdata/sync-report-*.json`); die beiden Failure-Einträge
     (Stage, Symbol, Timeframe, `reason`, `retryable`, `httpStatus`) bestimmen,
     ob es Discovery/Ticker/Depth/Kline/Upsert war.
   - `BITUNIX_ENABLED=true`, `MARKET_SYNC_VENUES`, Token-Bucket (8 req/s),
     `npm run market:sync -- --venue=BITUNIX --full` in Staging reproduzieren.
2. **Bugfix A — Preset-Venues entscheiden (Produktentscheidung, dann Code):**
   - Option 1: Adapter je Venue implementieren
     (`src/marketdata/adapters/<venue>.ts`, Registrierung in
     `registerAdapters.ts`, Symbol-Profile in `src/symbols/venueProfiles.ts`,
     Capability-Matrix in `src/brokers/capabilities.ts`).
   - Option 2: Presets ohne Sync-Venue aus Registry/Seed und aus dem
     Standard-Scope entfernen; Docs (`MARKET_DATA_PIPELINE.md`,
     `OPERATIONS_CENTER.md`, `CONFIGURATION.md`) klar als
     „einzige Daten-Venue: BITUNIX" kennzeichnen.
   - Bis dahin: `outOfScope`-Hinweis im Ops-Panel so lassen — er ist korrekt.
3. **Bugfix B — SCHEMA_MISMATCH ent-transientisieren:**
   - `envelopeData()`-, `mapKline()`-, `mapTradingPairToInstrument()`- und
     `normalizeCandles()`-Pfade trennen in „strikt verwerfen + zählen" vs.
     „tolerant übernehmen"; jede verworfene Zeile mit Venue+Stage+Grund zählen
     (kein `UNKNOWN` ohne Kontext).
   - `classifyBitunixFailure()`-Mapping gegen reale Venue-Codes prüfen;
     Chunk-Fallback in `fetchTickers()` (`publicClient.ts:94-120`) beibehalten.
4. **Backfill schließen:** `npm run market:sync -- --venue=BITUNIX --full`
   nach Fix fahren, bis `staleSeries` → 0 und jede im Scope befindliche Reihe
   ≥ 61×`1h` hält; danach regulären inkrementellen Rhythmus prüfen.
5. **Tests (vor Merge):** `npm run typecheck`, `npm run lint`,
   `npm run docs:validate`, `npm test`, `npm run security:live-gate`;
   zusätzlich Schema-Tests je Venue (gültig/leer/falscher Typ/`code != 0`),
   Funnel-Tests mit Mocks + Fixture-Responses, Edge-Cases
   (leere Klines → `DATA_UNAVAILABLE`, kein stilles `[]`).
   Coverage-Gates beachten (`marketsync` 90 % Zeilen, `security:live-gate` 95 %).
6. **Doku + Release (Deutsch, Conventional Commits):** betroffene Docs und
   `CHANGELOG.md` aktualisieren (`fix(marketdata): …`), Workflows in
   `docs/ci/*.workflow.yml` und `.github/workflows/` byte-identisch halten,
   PR mit Problem/Lösung/Verifikation.

## 6. Nicht-Ziele / Abgrenzung

- Kein Live-Broker-Pfad (Paper-Trading-Repo; Market-Data nur über Public-Endpoints).
- Keine neuen Secrets/Keys; `.env.bak-*` und `.env`-Inhalte weder loggen noch committen.
- `data/`-Artefakte (`history/`, `market-sync-status.json`, `spread-cache.json`)
  nicht committen — Ausnahme bleibt `data/universe/instruments.ndjson`.

---

## 7. Prompt zur Überprüfung durch andere LLMs (Peer-Review)

> **Rolle:** Du bist ein unabhängiger Senior-Reviewer (TypeScript/Next.js,
> Market-Data-Pipelines). Prüfe die obige Analyse kritisch gegen das Repo
> `Kryschuuu/ai-trading-firm` (Stand 2026-09-21, v1.58.0).
>
> **Aufgaben:**
>
> 1. **Faktenprüfung:** Verifiziere jede Dateiangabe (`registerAdapters.ts:64`,
>    `types.ts:75`, `warmup.ts:60`, `marketDataReadiness.ts:172`,
>    `collectMarketData.ts:144-149/233-248`, `marketDataErrors.ts:200-240`,
>    `publicClient.ts:29-39/94-120/266-292`, `adapters/bitunix.ts:53-64/118-179`,
>    `sync.ts:590-600/1067-1076/1168-1177`). Melde jede abweichende Zeile/Funktion.
> 2. **Logikprüfung:** Gilt `dataReady ⇔ Kerzen ≥ 61 UND Ticker UND Spread`?
>    Gilt `ERROR ⇔ dataErrors.size > 0`? Gilt der Kaltstart-Schutz
>    (`venuesWithData.size === 0 → alle im Scope`)? Findest du einen Pfad, in dem
>    der leere Funnel fälschlich als Marktbewertung dargestellt wird?
> 3. **Alternativhypothesen:** Nenne mindestens zwei alternative Erklärungen für
>    `SCHEMA_MISMATCH×1 + UNKNOWN×1` (z. B. Rate-Limit-Chunk, Depth-Leere,
>    `3m`/`5d`-Lücke, Store-Ablehnung, Clock-Skew bei `lastSeen`), bewerte ihre
>    Plausibilität und sag, welches Artefakt (`sync-report-*.json`,
>    `market-data-errors.json`, `quality-report.json`) sie jeweils beweisen oder
>    widerlegen würde.
> 4. **Lücken:** Fehlt in der Analyse ein Mechanismus (z. B. `freshTimeframes`/
>    inkrementeller Skip, `MAX_SERVICE_INSTRUMENTS`-Kappung, `staleSeries`-Guard,
>    Ticker-Chunking, Spread-Cache-TTL), der die Screenshot-Werte ebenfalls
>    erklären könnte?
> 5. **Fix-Kritik:** Ist Option 1 vs. Option 2 (Adapter bauen vs. Presets
>    entfernen) korrekt abgewogen? Welchen Fix würdest du priorisieren und warum?
>    Welche Änderung ist riskant (z. B. `SYNC_TIMEFRAMES` erweitern, Warmup senken)?
> 6. **Urteil:** Schließe mit `BESTÄTIGT`, `TEILWEISE BESTÄTIGT` oder
>    `WIDERLEGT` je Hypothese (A–F) plus maximal fünf konkreten,
>    dateibasierten nächsten Schritten. Antworte auf Deutsch, knapp, mit
>    `datei:zeile`-Belegen. Keine Codeänderungen, nur das Review.
