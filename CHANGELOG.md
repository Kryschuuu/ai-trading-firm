# Changelog — Autonome KI-Trading-Firma

> **Status-Header (Task 12):** Konsolidierter Überblick · **2026-09-01** ·
> Code-Version **1.35.2**. Vollständige, detaillierte Einträge je Release stehen
> in [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (Keep a Changelog + SemVer).
> Diese Datei ist der konsolidierte, task-zugeordnete Überblick.

## Versionierung

| Stelle | Bedeutung |
| --- | --- |
| **MAJOR** (1.x.y) | Breaking Changes: DB-Schema-Brüche, entfernte Env-Variablen, neue Pflichtkonfiguration |
| **MINOR** (x.1.y) | Neue Features (z. B. Provider), abwärtskompatibel |
| **PATCH** (x.y.1) | Bugfixes und Sicherheits-Fixes |

Die Version steht in `package.json` und wird von `/api/health` und `/api/firm`
ausgeliefert.

## [1.35.2] — 2026-09-01 · fix(marketdata): Ticker-Lücken-Fallback — Bulk-Lücken nie still als „enriched"

Die zwei in 1.35.1 als vorbestehend dokumentierten Testfehler sind behoben
(Details: `docs/CHANGELOG.md`): Fehlt ein Symbol in der Bulk-Ticker-Response,
versucht `enrichWithTickers()` jetzt genau einen Einzel-Ticker-Fallback mit
Symbol-Guard; bleibt die Lücke offen, wird sie als `ticker`-failure sichtbar
(degradierter Lauf, CLI-Exit 1) statt still als „enriched" zu zählen. Zwei
Unit-Tests, die die alte, kaschierende Semantik festschrieben, wurden bewusst
an die ehrliche Semantik der Integrationstests angepasst. **Alle 1521 Tests
grün.**

## [1.35.1] — 2026-09-01 · fix(broker): Sicherheits-Härtung des Bitunix-Live-Pfads

Vier Lücken aus dem Broker-Audit geschlossen (Details: `docs/CHANGELOG.md`):
Kill-Switch + Code-Guardrails jetzt **unmittelbar vor jeder Live-Order** in der
`BrokerExecutionEngine` (fail-closed gegen die echte Konto-Equity); kein
Transport-Retry mehr für den nicht-idempotenten `place_order`-POST
(Doppel-Order-Gefahr, nur 429 bleibt Retry-fähig); der zentrale
Live-Gate-Enforcer prüft zusätzlich den prozessweiten Not-Halt
`/api/firm/kill` — der Firmen-Kill-Knopf stoppt damit auch Live-Orders;
`credentialStatus()` meldet Rechte nur noch verifiziert
(`configured`/`connected`/`permissionsVerified`, ohne `verify` keine
Rechte-Behauptung) und die Logger-Redaction wird deterministisch mit dem
Credential-Laden befüllt. 7 neue Regressionstests
(`tests/bitunix.security.test.ts`).

## [1.35.0] — 2026-08-31 · feat(workshop): Missions-Baukasten — Markt-Scans, Segmente, Vorlagen

**Missionen können jetzt mehr als ein Symbol.** Aufträge wie „scanne alle
Märkte“, „nur Penny Stocks“ oder „nur Indizes“ waren bisher nicht ausdrückbar:
Multi-Asset-Mandate standen mit `symbol = NULL` in der Datenbank und die Engine
riet (`mission.symbol ?? "SPY"`). Neu sind Missions-Typen, Marktsegmente,
wiederverwendbare Vorlagen und eine Mandatsprüfung — plus 10 weitere
Standard-Missionen (insgesamt **14** nach der Installation).

* **Missions-Typ (`missions.scope`):** `SINGLE_SYMBOL` (ein Instrument, Verhalten
  unverändert) oder `SCAN_UNIVERSE` (ein Marktsegment wird gescannt).
* **Neun Marktsegmente (`missions.segment`):** `ALL`, `INDICES`, `CRYPTO`,
  `EQUITIES`, `FX`, `COMMODITIES`, `PENNY`, `VOLATILE`, `LIQUID` — Kandidaten
  kommen zur Laufzeit aus der Instrument-Registry (`src/lib/missionUniverse.ts`),
  nie aus einer kopierten Liste.
* **18 Vorlagen** (`src/lib/missionTemplates.ts`), davon 14 im Seed: Titel,
  prüfbarer Zieltext, Budgets, Risikoprofil, SQL-prüfbares Erfolgskriterium und
  Drei-Ebenen-Hilfe. `POST /api/firm/missions {"templateId":"…"}` legt eine
  komplette Mission an; eigene Angaben gewinnen.
* **Mandatsprüfung in der Engine:** `TRADE` außerhalb der Kandidatenliste →
  `BLOCKED` + `ORDER_REJECTED`/`MISSION_SCOPE_VIOLATION`; leeres Segment →
  `MISSION_SCOPE_EMPTY` (fail-closed). Beide Fälle erscheinen im Trace als
  Schritt **MISSIONS-MANDAT**.
* **Workshop-UI:** Vorlagen-Auswahl (gruppiert, mit Filter „nur mitinstallierte“),
  Radiogruppe Missions-Typ, Segment-Auswahl mit live gezählten Kandidaten,
  Drei-Ebenen-Hilfe als Tooltip und Aufklapper, Missionsliste mit Typ-Badge.
* **Doku:** [`docs/MISSIONS.md`](docs/MISSIONS.md) (neu, im Doku-Katalog
  registriert), Handbuch 5.1/5.4, `docs/help/workshop.help.json` (16 Begriffe),
  Installations-Checkliste (14 Missionen).
* **Migration:** `npx drizzle-kit push` ergänzt `missions.scope` (Default
  `SINGLE_SYMBOL`), `.segment`, `.template_id`; `POST /api/seed` trägt bei
  Alt-Mandaten ohne Symbol den Missions-Typ nach (`missionsMigrated`).

## [1.34.0] — 2026-08-31 · feat(install): geführtes Windows-Setup mit PowerShell

* **Windows-Installation:** `scripts/setup-windows.ps1` installiert per `winget`
  Git, Node.js LTS, PostgreSQL und optional Ollama, richtet Datenbank und `.env`
  ein, seedet das Universum und führt Typecheck, Lint, Build und Health-Check aus.
* **Dokumentation:** [`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md) enthält
  den One-Liner, Eingabeführung, Sicherheitsdefaults und konkrete Workarounds.
* **Sicherheit:** Secrets werden nicht geloggt; Live-Trading bleibt deaktiviert.

## [1.33.1] — 2026-08-31 · fix(setup): PAPER-MODE-Default und WURZELURSACHE-Validierung (B7)

**P0, trifft jede Neuinstallation.** `scripts/setup-cachyos.sh` schrieb
`PAPER_MODE=B` in `.env` — ein Wert, den `parsePaperMode()` ablehnt
(erlaubt: `synthetic | broker-market-data | broker-paper-api`). Die Engine
warf beim Boot einen `PaperConfigError`, `/api/firm` antwortete 503 mit dem
irreführenden Hinweis „PostgreSQL läuft?", und `validate-setup.sh` meldete
zehn stille Folgefehler (V05–V17). Befund B7:
[`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md).

* **Setup:** `scripts/setup-cachyos.sh` schreibt an beiden Stellen
  `broker-market-data` (dokumentierter Produktions-Default). Bestehende
  `.env`-Dateien bleiben unangetastet (`env_ensure_key` ergänzt nur fehlende
  Schlüssel).
* **Validierung:** `scripts/validate-setup.sh` prüft `PAPER_MODE` aus
  `./.env` **vor** jedem HTTP-Request und bricht bei ungültigem Wert mit
  einem lauten `WURZELURSACHE`-Block ab (Exit 2). Zusätzlich erkennt es ein
  `{error, fix}`-Objekt von `/api/firm` (503) und benennt die Ursache statt
  zehn stille Fehlchecks; bei paperMode-Fehlern ersetzt es den generischen
  Route-Hinweis durch die konkrete `.env`-Behebung. Check V04 nennt
  `PAPER_MODE` als mögliche Ursache.
* **Doku:** `INSTALL.md` (Flag-Tabelle: `A`/`B`/`C` werden nicht akzeptiert),
  `docs/SETUP_BUGS.md` (B7), `docs/INSTALL.md` (Troubleshooting
  `EADDRINUSE 0.0.0.0:3369`).
* Version **1.34.0**. Kein Schema-Bruch, keine Datenmigration.

Details: [docs/CHANGELOG.md](docs/CHANGELOG.md#1331---2026-08-31--fixsetup-paper-mode-default-und-wurzelursache-validierung-b7)


## [1.33.0] — 2026-08-31 · feat(ops): add market-data readiness panel to operations center

**[OPS] Surface market-data readiness instead of six funnel zeros**

Das Operations Center visualisierte ausschliesslich den Scanner-Funnel.
Bei fehlender Datenbasis waren sechs Nullen nicht von einer echten
fachlichen Aussage unterscheidbar - der eigentliche P0-Defekt wurde
dadurch lange als "Scanner zu restriktiv" fehlinterpretiert.

- `collectMarketDataReadiness()`: reine Lesefunktion, kein Netzwerk-I/O
- `MarketDataOpsSnapshot` mit Registry/Discovered/Data-ready/Warming/
  Candles(n/required)/Ticker-ready/Spread-ready/Scanner-ready
- Pro Venue: letzter Sync, degraded-Flag, Fehler nach Ursache
  (`data/market-sync-status.json`, geschlossene MDERR-006-Taxonomie)
- `worstOffenders` (Top 10 Instrumente mit zu wenig Historie)
- `buildReadinessHint()`: kontextabhaengige, handlungsleitende Hinweise
  je dominierendem Blocker
- Neue UI-Sektion „Market Data" (`MarketDataPanel.tsx`) **oberhalb** des
  Funnels; Ampel READY/WARMING/ERROR farb- UND textkodiert; Funnel bleibt
  in allen Zustaenden sichtbar
- Runbook "Funnel ist leer" in `docs/OPERATIONS.md`
- Ops bleibt read-only: kein Sync-Trigger-Endpoint

Refs: Code Review Scanner, Kap. 14, 26

Details: [docs/CHANGELOG.md](docs/CHANGELOG.md#1330---2026-08-31--featops-add-market-data-readiness-panel-to-operations-center)


## [1.32.0] — 2026-08-31 · feat(marketdata): enrich instruments with volume24h and orderbook spread (P1)

**[MARKETDATA] Add ticker and orderbook enrichment to instrument discovery**

`discoverInstruments()` lieferte bisher nur Handelsparameter aus
`/futures/market/trading_pairs`. Die scanner-relevanten Metriken `volume24h`
und `spread` fehlten vollständig. Da der Spread-Faktor — anders als der
Liquiditätsfaktor — keinen Kerzen-Fallback besitzt, hätte der Funnel
auch nach dem Candle-Fix vollständig an `max-spread` abgelehnt.

- `enrichWithTickers()`: ein Bulk-Call auf `/market/tickers` → `volume24h` (quote)
- `enrichWithOrderBooks()`: `/market/depth` (limit=5) → relativer Spread
- Plausibilitätsgrenzen: gekreuzte/leere Bücher und Spreads > 50% → null
- Fehlende Werte bleiben null und werden als Data-Quality-Zustand
  transportiert, nicht als fachliche Ablehnung
- Eligibility-Rejection trägt jetzt `candles/volume24h/spread` als Kontext
- Rate-Limit-schonend: 1× Bulk-Tickers, N× Depth mit `limit=5`, Concurrency ≤8
- Security: Arrays gekappt, `Number.isFinite()`, Timeouts, Symbol-Allowlist,
  `maxInstruments` ≤1000, kein unbegrenztes Fan-out

Refs: Code Review Scanner, Kap. 4, 5, 22

Details: [docs/CHANGELOG.md](docs/CHANGELOG.md#1320---2026-08-31--featmarketdata-enrich-instruments-with-volume24h-and-orderbook-spread-p1)


## [1.31.0] — 2026-08-31 · fix(bitunix): Public Market Data in den Scanner-Warmstart verdrahten (P0)

**P0, Productionspfad.** Der funktionsfähige Bitunix-Adapter war von keinem
Produktionspfad aufgerufen — die Registry blieb bei den 26 statischen
Seed-Instrumenten. Der Public-Market-Data-Pfad ist jetzt über einen dünnen
`MarketDataAdapter`-Wrapper (`src/marketdata/adapters/bitunix.ts`) mit dem
`MarketDataSyncService` verdrahtet; die Registrierung
(`registerMarketDataAdapters(env)`) instanziiert ausschließlich den
credential-freien PublicClient, gated über Capability-Matrix
(`capabilities.BITUNIX.marketData`) **und** `BITUNIX_ENABLED`. Neue
`UnsupportedTimeframeError`-Semantik (3m/5d sind dokumentierte Bitunix-Lücken),
HALTED/DELISTED-Instrumente werden geflaggt statt verworfen, `run-scan` ohne
`--sync` bleibt nachweislich netzwerkfrei (Guard-Server-Subprozess-Test).
Broker- und Marketdata-Domäne entkoppelt: keine Rückwärts-Abhängigkeit mehr.
Live-Gate unverändert. Details: [docs/CHANGELOG.md](docs/CHANGELOG.md#1310---2026-08-31--fixbitunix-public-market-data-in-den-scanner-warmstart-verdrahten-p0).

## [1.30.0] — 2026-08-31 · fix(setup): Setup-Pfad härten + Markt-Presets + Short-Selling-Default (SETUP-130)

**P1, Produktkette + Sicherheit.** Der Setup-Pfad hatte fünf Befundgruppen,
die eine Neuinstallation unbrauchbar oder unsicher machen konnten, und das
handelbare Universum war mit 26 Instrumenten zu dünn für den Scanner-Trichter.
Vollständiges Befund-/Fix-Register: [`docs/SETUP_BUGS.md`](docs/SETUP_BUGS.md).

* **B1 PostgreSQL:** alle Cluster-Checks laufen als `$PG_SUDO_USER`;
  Versionsabgleich (`pg_version_mismatch` / `pg_control_major`) **vor** jedem
  Eingriff; `pg_pick_locale()` mit Fallback `C.UTF-8` → `en_US.UTF-8` → `C`
  bei `--encoding=UTF8`; `initdb` mit Fehlerbehandlung; Cluster-Reset nur als
  bewusster Schritt (`pg_reset_cluster`, `--reset-cluster`).
* **B2 Datenbank:** Tabellen-Verifikation gegen die 13 Pflicht-Tabellen aus
  `checkSchema()`, Einzelprüfung von `agents`/`missions`/`risk_config`/
  `kill_switches`/`positions`/`equity_snapshots`/`broker_credentials`,
  UUID-Prüfung jeder Mission-ID — beendet
  `invalid input syntax for type uuid: "null"`.
* **B3 Broker:** der aktive Adapter wird über `/api/firm → account.broker`
  verifiziert; `UNEXPECTED_BROKER_ADAPTER` ist damit sichtbar statt rätselhaft.
* **B4 Build:** neu `src/lib/appPaths.ts` (`resolveRuntimePath`,
  `resolveRuntimePathSafe`, `joinRuntimePath`, `resolveStoredPath`) ersetzt die
  **12** `path.join(process.cwd(), <dynamisch>)`-Stellen in `secretStore.ts`,
  `cycle/artifacts.ts`, `cycle/ports.ts`, `historicalStore.ts`,
  `portfolio/auditFile.ts`, `routing/router.ts`, `scanner/artifacts.ts`,
  `universe/store.ts` — `next build` ist warnungsfrei, zusätzlich mit
  Path-Traversal-Schutz.
* **B5 API:** `FIRM_API_TOKEN` wird erzeugt (`openssl rand -hex 32`), `.env`
  bleibt `600`; offener `0.0.0.0`-Betrieb ohne Token wird als
  Sicherheitswarnung quittiert. Die Ceiling-Klemmung wird mit **Prozent** (90)
  statt Bruch (0.9) geprüft — der alte Test konnte seit v1.7.0 nie bestehen.
* **B6 Validierung:** neu `scripts/validate-setup.sh` mit **18** deterministischen
  Checks (bestanden ab `--min-pass`, Default 15), `--json`, dokumentierten
  Ausnahmen und Behebungszeile je Fehlcheck.
* **Feature Markt-Presets:** neu `src/universe/presets.ts` +
  `npm run universe:seed:markets` — **50 Aktien** (ALPACA/IBKR),
  **50 Indizes** (IBKR-CFD), **22 Rohstoffe** (IBKR-Futures),
  **30 Kryptowährungen** (BINANCE-Spot), je Asset plus `PAPER`-Spiegel
  = **354 Instrumente**. `assertPresetContract()` macht Abweichungen von den
  dokumentierten Zahlen zum harten Fehler.
* **Feature Short-Selling:** im Setup-Default **aktiviert**
  (`risk_config.allowShort = 1`, abschaltbar mit `--no-shorts`). Die harten
  Code-Grenzen bleiben unverändert (`maxLeverage = 1`, `requireStopLoss = true`
  nicht abschaltbar, Kill-Switch, `LIMIT_CEILINGS`).
* `scripts/setup-cachyos.sh` neu geschrieben: 10 Schritte, strukturiertes
  Logging nach `data/setup/setup-<Zeitstempel>.log`, `--dry-run`,
  `--non-interactive`, Secret-Maskierung in Anzeige **und** Log, ERR-Trap mit
  Schritt-/Zeilenangabe, vollständig idempotent.
* Tests: neu `tests/universe.presets.test.ts` (15 Tests). Bestehende
  Setup-Regressionstests (`tests/dbConfig.test.ts`, `tests/setupCluster.test.ts`,
  `tests/setupPgService.test.ts`) unverändert grün.
* Doku: neu `docs/SETUP_BUGS.md`, aktualisiert `README.md`, `INSTALL.md`,
  `docs/INSTALL.md`, `docs/MARKET_UNIVERSE.md`.
* Version **1.30.0**. Kein Schema-Bruch, keine Datenmigration.

## [1.29.0] — 2026-08-30 · feat(marketdata): persistenter Warmup + Sync-CLI (MDSYNC-001)

**P1, Produktkette.** Kein Prozess befüllte `data/history/candles.ndjson`:
`scanUniverse()` las 0 Kerzen, lehnte **alle** Instrumente mit `min-candles` ab
und der Trichter wirkte wie „Markt ungeeignet“. Neu: der Sync ist ein eigener
persistenter Schritt **vor** dem Scan — der Scanner bleibt rein (kein I/O).

* Neu `npm run market:sync` (Alias `market-sync`) mit `--venue`,
  `--timeframes`, `--symbols`, `--candle-limit`, `--max-instruments`,
  `--concurrency`, `--strict`, `--dry-run`, `--json`, `--no-manifest`,
  `--status`, `--help`; Exit-Codes 0/1/2, `run-scan --sync` nutzt denselben
  Pfad, `npm run market:sync:status` liest nur die Warmup-Readiness.
* Neu `src/marketdata/registerAdapters.ts` als einzige Instanzierungsstelle,
  fail-closed über `MARKET_SYNC_ENABLED` · `MARKET_SYNC_VENUES` ·
  `<VENUE>_ENABLED`; nicht freigeschaltete Venues melden symbolische Gründe.
* `SyncResult` mit deckungsgleichen Zählern und `formatSyncLog()`;
  `HistoricalStore.appendSeries()` schreibt einen Lauf in **einer**
  Datei-Revision statt N × M (Semantik je Reihe identisch).
* Harte Grenzen: Parallelität ≤ 8, `candleLimit ≤ 2000`,
  `candleLimit ≥ requiredWarmupCandles` (sonst Exit 2, vor dem ersten Request),
  Payload-Kappe 5 MiB am Transport (`BITUNIX_PAYLOAD`, kein Retry).
* Security: Public-only (kein PrivateClient, keine Credential-Header),
  Symbol-Allowlist vor URL-Bau, Log-Injection- und Pfad-Interpolations-Schutz,
  `/api/markets` bleibt GET-only.
* Doku: `MARKET_DATA_PIPELINE.md` §0 Code-Map, §12 CLI, §13 Abweichungen;
  `docs/INSTALL.md` §6.1; `.env.example`.
* Tests: `test/marketdata/*` + `test/integration/*` (Goldentest mit
  Warmup-Kontrast, Request-Budget, Architektur-Greps),
  `npm run test:coverage:marketsync` ≥ 90 %. Gesamtsuite **1389/1389 grün**.
* Version **1.29.0**. Keine Schema- oder Datenmigration.

## [1.28.1] — 2026-08-30 · fix(universe): liveAvailable als Laufzeitprojektion (CAP-008)

**P1, sicherheitsrelevant im UI/API-Sinn.** `liveTradable` ist die fachliche
Produktentscheidung (Seed/Stammdaten: PAPER = false, reale Venues = true).
`liveAvailable` ist **niemals** ein Seed-Wert — es ist die Konjunktion aus
(1) `liveTradable`, (2) `capabilities[venue].trading`, (3) registriertem
Nicht-Stub-Adapter mit `capabilities.live`, (4) `${VENUE}_ENABLED`,
(5) `evaluateLiveOrder().allowed`. Fail-closed; `reasons[]` nur symbolische
Codes. Startup: `trading:true` verlangt einen echten Adapter.

* Neu `src/universe/capabilityProjection.ts` + `src/brokers/adapterCatalog.ts`
  (statisch, keine Adapter-Instanziierung).
* Seed persistiert `liveTradable`, verbietet `liveAvailable`.
* `/api/markets` liefert `liveAvailabilityReasons` und Tooltips.
* Ops-Sektion Market Universe: Badges „live unavailable“.
* Doku: `docs/CAPABILITIES.md`, `MARKET_UNIVERSE.md`, `BITUNIX.md`.
* Version **1.28.1**. Live-Gate-Enforcement unverändert.

## [1.28.0] — 2026-08-30 · feat(symbols): zentrale, venue-aware Symbol-Normalisierung (SYM-007)

**P1.** Vier unabhängige Symbol-Regexe (Universe, `marketData`, `ruleEngine`,
Bitunix) mit leicht unterschiedlicher Semantik validierten dasselbe Konzept —
das in der Registry gültige Instrument `KRAKEN:BTC/USD` wurde im
Laufzeit-/Regelpfad still verworfen. Neu: **eine** venue-aware
Normalisierungsschicht (`src/symbols/`) als Single Source of Truth. Die
Rule-Engine-Sicherheitsgrenzen (nur LONG, Operatoren, Ceilings) bleiben
unangetastet (Ticket §3.3).

* Neu `src/symbols/`: `normalizeVenueSymbol()` / `tryNormalizeVenueSymbol()` /
  `isValidInstrumentId()`; deklarative Venue-Profile (Kraken-Alias `XBT↔BTC`,
  native Formen `XBTUSD`/`BTCUSDT`/`BTC-USD`/`EUR.USD`); typisierte Fehler.
* Kanonisierung (§3.2): NFKC, Zero-Width-Entfernung, Trim, Uppercase;
  akzeptiert `BTCUSDT`, `BTC/USD`, `BTC-USD`, `BTC_USD`, `EUR.USD`, `EURUSD=X`
  und `VENUE:`-Präfixe; Paare kanonisch mit `/`, Einzelwerte ohne Trenner;
  `instrumentId = ${VENUE}:${canonical}`.
* Unbekannte Venue: Abfragepfad = striktes Default-Profil +
  `UnknownVenueProfileWarning` (kein Wurf); Sync-/Registrierungspfad =
  `UnknownVenueProfileError` (`profilePolicy: "strict"`).
* Ersetzt: lokale Regexe in `src/lib/marketData.ts` (Routing jetzt
  kanonisch-aware: Fiat/Fiat → Yahoo `=X`, Krypto → Binance),
  `src/lib/ruleEngine.ts`, `src/universe/validation.ts` (Re-Exports der SSoT),
  `src/brokers/bitunix/orders.ts` + `mapping.ts` (venue-native Byte-Identität).
* Migration (§3.4): `npm run symbols:normalize` — Dry-Run ist Default,
  `--apply` mit automatischem Backup; repariert nur strukturelle Korruption
  (`id ≠ venue:symbol`, Venue-Case), meldet Alt-Notationen als Hinweis,
  überspringt Unparsebares und Zielkollisionen, idempotent.
* Docs: neu `docs/SYMBOLS.md` (Befund-Tabelle der Alt-Regexe, Regeln,
  Verhaltensänderungen), Referenzen in `README.md` und
  `docs/MARKET_DATA_PIPELINE.md` (§11), Abgleich in
  `docs/MARKET_UNIVERSE.md` (§4, §9) und `docs/HISTORY.md`
  (Speicherform-Verweis), Task-Board `docs/ARENA_TASKS.md` (Task 15).
* Tests: Golden-Suite (`tests/symbols/normalize.test.ts`), Property-Tests mit
  deterministischem PRNG (`normalize.property.test.ts`: nie werfen, Idempotenz,
  Kanon↔Nativ-Roundtrip, Injection-Invariante, ReDoS-Probe),
  Migrations-Tests (`idMigration.test.ts`).

## [1.27.0] — 2026-08-30 · feat(operations): strukturierte Market-Data-Readiness-Diagnose (OPS-010)

**Review-Nacharbeit (CODE-REVIEW-SCANNER, Sections 14, 22, 26).** Das
Operations Center zeigte nur den Endzustand des Scanner-Funnels
(„Gescannt 26, Eligible 0, …“) — nicht, **ob** und **wo** die Datenpipeline
(Discovery → Enrichment → Backfill) steckt. Neu: ein strukturierter
Market-Data-Readiness-Report plus eine Ablehnungs-Diagnose mit vollständigem
Datenzustand je Instrument — beides rein aggregiert aus Registry +
Historical Store + Scanner-Config, **ohne Netzwerk-I/O**.

* Neu `src/ops/marketDataReadiness.ts`: `MarketDataReadinessReport`
  (Registry / Discovered ≤ 24 h / Data-ready / Warming / Candles geladen vs.
  benötigt / Ticker-ready / Spread-ready / Scanner-ready) und
  `collectMarketDataReadiness()` — Grenzwert `candleCount ===
  requiredWarmupCandles(config)` gilt als ready (Boundary getestet).
* Neu `src/scanner/eligibilityDiagnostics.ts`: pro Rejection Regel **plus**
  Datenzustand (`candles`, `volume24h`, `spread`) — macht „Spread wurde
  nicht geladen“ (Data-Quality) von „Markt ungeeignet“ (fachlich)
  unterscheidbar. „Erste Regel gewinnt“-Routing unverändert, Modul ist
  ausdrücklich nur Monitoring (Inline-Kommentar im Dateikopf); Ausgabe auf
  50 Einträge gedeckelt, `total` zählt voll (DoS-Schutz).
* `GET /api/ops`: additive Payload-Felder `marketDataReadiness` und
  `eligibilityDiagnostics` — **kein Breaking Change**: Sektionen und
  Funnel-Format unverändert (2-Argument-`buildOpsPayload` kompatibel,
  fail-soft `null` bei Aggregationsfehler).
* UI: neue Karte **Market Data** neben der Scanner-Karte exakt im
  Review-Zeilenformat, inkl. Pflicht-Tooltips („Scanner-ready NO“,
  „Candles 0/61“) und einklappbarer Ablehnungs-Diagnose.
* Tests: Unit (leere Registry; Regression Review-Ist-Zustand 26×0; Ziel-Zustand
  180 ready; Boundary; Diagnose `spread: null` → `max-spread`; DoS-Deckel;
  Additivität) + Integration (simulierter Sync-Durchlauf → `GET /api/ops`
  konsistent mit Registry-/HistoricalStore-Zustand, Secret-Scan).
* Neu **`docs/OPERATIONS_CENTER.md`** („Wie diagnostiziere ich einen leeren
  Scanner-Funnel?“, Walkthrough Registry → … → Scanner-ready), registriert im
  Doku-Katalog und in `docs/README.md`; `docs/MARKET_DATA_PIPELINE.md` §6 um
  Report-Feldtabelle und Diagnose-Format erweitert; Hilfe
  `ops.help.json` v3 (`section.marketDataReadiness`).
* Version **1.27.0**.
## [1.26.4] — 2026-08-30 · Capability-SSoT für Instrument-Live-Flags (CODE-REVIEW-SCANNER §17)

**Fix (P1, sicherheitsrelevant im UI/API-Sinn):** Der statische Universe-Seed
enthielt `liveAvailable: true`/`liveTradable: true` für reale Venues wie
Binance, Kraken, Alpaca und IBKR, obwohl deren Adapter in dieser Codebasis nur
Stubs sind. Der Seed ist nun keine Capability-Wahrheit mehr.

* `src/universe/seed.ts` und die versionierten NDJSON-Seeds enthalten nur noch
  statische Instrumentdaten; `liveAvailable`/`liveTradable` sind entfernt.
* Neu `src/capabilities/resolveCapabilities.ts` und
  `src/capabilities/matrix.ts`: `resolveInstrumentCapabilities(venue, matrix)`
  projiziert `liveAvailable` aus `marketData` und `liveTradable` aus `trading`,
  unbekannte Venues fail-closed auf `false/false`.
* Registry, Normalisierung, Validierung, Persistenz und `/api/markets` liefern
  Live-Flags nur noch aus der Capability-Matrix. Alte persistierte Werte können
  die Projektion nicht mehr auf `true` manipulieren.
* Tests: Resolver-Stubs, Bitunix-Matrix-Spiegelung, Unknown-Venue-Fallback,
  Seed-Strukturtest gegen beide Live-Felder, Regression für Nicht-PAPER-
  Stub-Venues und API-Test für Kraken `liveAvailable=false`.
* Doku: Neu `docs/CAPABILITIES.md`; `docs/MARKET_UNIVERSE.md`,
  `docs/BITUNIX.md`, `docs/README.md` und Doku-Katalog aktualisiert.
* Version **1.26.4**. Keine DB-Migration, keine Env-Änderung. Live-Gate-
  Logik unverändert.

Refs: CODE-REVIEW-SCANNER.md Section 17.

## [1.26.3] — 2026-08-30 · Nacharbeit PR: Marktdaten-Fehler-Doku & Sync-Klassifikation (MDERR-006)

**Nacharbeit zu PR (v1.26.1, `fix(marketdata): stop swallowing fetch
failures`).** Die Typisierung/Telemetrie aus v1.26.1 wird vervollständigt:
Der Sync kategorisiert Fehler bereits im Abfangen (statt erst aus einer
redigierten Textmeldung), der Entscheidungsbaum für Betrieb wird als eigenes
Dokument ergänzt, und die verbliebenen Aufrufer behandeln
`MarketDataFetchError` explizit pro Symbol/Timeframe.

* `src/marketdata/sync.ts` + `src/marketdata/types.ts`: `SyncError` trägt
  jetzt klassifizierte `reason`/`retryable`/`httpStatus`; Fehler werden beim
  Abfangen über `classifyMarketDataError()` gesetzt (Per-Instrument-Isolation,
  kein globaler Abbruch). `BitunixApiError.httpStatus=429` bleibt so als
  `RATE_LIMITED` erhalten.
* `src/marketdata/dataErrors.ts`: Das Fehler-Manifest übernimmt nur echte
  Fetch-/Infrastrukturfehler (mit `reason`, `stage != "upsert"`). Reine
  Datenqualitäts-Warnungen (z. B. Ticker-Symbol-Abweichung) lösen kein
  `DATA_UNAVAILABLE` mehr aus und maskieren so keine echten 429-Fehler.
* `src/lib/marketDataErrors.ts`: `classifyMarketDataError()` erkennt
  JSON-Parse-/Syntax-Fehler jetzt als `SCHEMA_MISMATCH` und trägt den
  geforderten Inline-Kommentar „Diese Klassifikation ist NICHT nur
  kosmetisch …“.
* `src/lib/marketData.ts`: strukturiertes Log `market_data_fetch_failed`
  enthält das explizite `message`-Feld
  `[market-data] FETCH FAILED … infrastructure/API error … See
  docs/ERROR_HANDLING_MARKETDATA.md`.
* Analysten (`src/lib/analysts.ts`) und Monitor
  (`src/lib/monitor.ts`): `getCandles()`-Aufrufer fangen
  `MarketDataFetchError` jetzt pro Symbol/Timeframe und isolieren Fehler —
  ein Netzwerkfehler bricht keine TA/Macro/Swing-/Marktscan-Schleife ab.
* Tests: `classifyMarketDataError()` JSON-Parse → `SCHEMA_MISMATCH`,
  Marktdaten-Log mit `FETCH FAILED`-Text, Sync-Fehler-Retention
  (429 → `RATE_LIMITED`, Rest-Sync läuft), Integrationstest 429 im
  Mock-HTTP-Kline-Pfad.
* Neu **`docs/ERROR_HANDLING_MARKETDATA.md`** (Entscheidungsbaum: werfen vs.
  Cache vs. `DATA_UNAVAILABLE`), registriert im Doku-Katalog
  (`src/lib/docsCatalog.ts`) und in `docs/README.md`.
* `docs/MARKET_DATA_PIPELINE.md` §8: vollständige Fehlertaxonomie + Behandlung
  je `reason` durch Sync-Service und Operations Center.
* `docs/OBSERVABILITY.md`: Status/v1.26.3, Verweis auf Entscheidungsbaum,
  `message`-Feld im Log-Event.
* Version **1.26.3**.

Refs: CODE-REVIEW-SCANNER.md Section 9 · MDERR-006.

## [1.26.2] — 2026-08-29 · Nacharbeit PR #40: Versionierung, Changelogs & Migrations-Runbook (Doku)

**Nacharbeit zu PR #40 (`[HISTORY] Persist candle timeframe and deduplicate
bars`, v1.26.0).** Das Datenmodell war bereits gemergt; es fehlten die
Betriebs-Doku, der empfohlene Migrationspfad und ein Teil der konsolidierten
Nachweise. Dieser Release schließt diese Lücken — **ohne fachliche Änderung**
an Schema v2, Primärschlüssel `instrumentId + timeframe + ts` und Dedup-Regel.

* Neu **`docs/MIGRATION_TIMEFRAME_FIELD.md`** — Schritt-für-Schritt-Runbook
  für Produktionsumgebungen: Voraussetzungen, Schreiber stoppen,
  Pflicht-Backup mit Prüfsumme, **Neuaufbau** (`npm run market-sync`) als
  empfohlener Pfad, Inline-Migration als Sicherheitsnetz, Ermittlung von
  `--assume-timeframe` über Median-`ts`-Abstände (nie raten), Validierung,
  Nachlauf, Rollback, Exit-Codes und Sicherheitsregeln.
* `docs/MARKET_DATA_PIPELINE.md` §5.3: **Neuaufbau statt Inline-Migration**
  als empfohlener Pfad für den Bitunix-Feed explizit begründet (150 Bars je
  Instrument und Timeframe, Timeframes `5m/15m/30m/1h`, public REST, kein
  Etikettier-Fehler durch Annahmen) — wie im Ticket gefordert.
* `docs/MARKET_DATA_PIPELINE.md` §5.2 und `docs/HISTORY.md` §6: CLI-Nutzung
  auf den neuen **Dry-Run-Default** umgestellt und mit dem Runbook verlinkt.
* Migrations-CLI `scripts/migrate-history-timeframe.ts` schreibt nur noch mit
  **`--apply`**; ohne das Flag läuft es als Dry-Run (keine Dateiänderung, kein
  Backup, Exit-Code **2**). Damit ist der Security-Audit-Punkt „Dry-Run als
  Default“ erfüllt: Produktionsdaten werden nie durch einen versehentlichen
  Aufruf überschrieben. Exit-Codes `0/1/2` sind dokumentiert.
* `docs/README.md` + `src/lib/docsCatalog.ts`: `HISTORY.md` und das neue
  Runbook im Doku-Katalog (`GET /api/docs`) registriert.
* `docs/ARENA_TASKS.md`: Task 14 (Timeframe-Dimension, MDSYNC-001) mit
  Version, PR, Security-Spalte und Nacharbeit aufgenommen.
* `npm run docs:validate` prüft neu die **Versions-Konsistenz**:
  `package.json` == oberster Eintrag in `CHANGELOG.md` **und**
  `docs/CHANGELOG.md`, Status-Header der `CHANGELOG.md`, Versionszeile in
  `docs/README.md` (neuer Check „Version-Konsistenz“).
* Neu `tests/docsVersioning.test.ts`: Versionierung und Doku-Verlinkung sind
  gegen Regressionen abgesichert.
* Version 1.26.2.

Refs: Code Review Scanner, Kap. 8, 20.

## [1.26.1] — 2026-08-29 · Typisierte Marktdaten-Fehler statt stiller leerer Arrays (P1, MDERR-006)

**`[MARKETDATA] Stop swallowing fetch failures`** — `getCandles()` bildete
HTTP 429/5xx, DNS-Fehler, ungültige Symbole, Schema-Abweichungen und TLS-Fehler
alle auf `[]` ab. Downstream war das nicht von „0 Kerzen vorhanden“
unterscheidbar und erschien als `min-candles`-Ablehnung — eine leere Serie kann
Faktoren neutralisieren, statt eine Ausführung zu stoppen.

* Neu `src/lib/marketDataErrors.ts`: `MarketDataFetchError` (venue/symbol/
  timeframe/reason/retryable/httpStatus, redigiertes `toJSON()`),
  `classifyMarketDataError()` (vollständige Ursachen-Taxonomie),
  `MarketDataErrorReason` (11 Ursachen).
* `getCandles()` wirft bei echten Fehlern; das stille
  `catch { return cached?.candles ?? []; }` ist **entfernt**. Leere
  Venue-Antworten (`[]`) bleiben gültig („nachweislich keine Bars“).
* Neu `getCandlesWithFallback()`: expliziter, als `stale` markierter
  Cache-Pfad mit `{ candles, source, stale, ageMs, error? }` — ohne Cache wird
  geworfen. Scanner-/Executor-Pfad nutzt ihn nicht.
* Telemetrie `src/lib/telemetry.ts`: Counter
  `market_data_fetch_failures_total{venue,timeframe,reason}` (bewusst ohne
  `symbol`-Label: Kardinalität).
* Strukturiertes, redigiertes Logging `src/lib/logger.ts`
  (`market_data_fetch_failed`, `market_data_unauthorized_public_endpoint`
  bei 401/403, Retry-Warnungen; 512-Zeichen-Kappe, kein Stacktrace, keine
  vollen URLs).
* Begrenztes Retry-Budget (2 Versuche, Backoff 250 ms, nur retryable
  Ursachen) — kein Endlos-Retry.
* Scanner: Fehler werden als `dataErrors` gereicht → `data-unavailable`-
  Rejection und Readiness `ERROR` statt `min-candles`; Sync persistiert ein
  Fehler-Manifest (`data/market-data-errors.json`).
* MicroExecutor-Warmstart: Seed-Fehler sichtbar (`status().seed`,
  `micro_executor_seed_fetch_failed`).
* Backtest-Route liefert 503 `MARKET_DATA_UNAVAILABLE` mit `reason`.
* Doku: neu `docs/OBSERVABILITY.md`; `docs/MARKET_DATA_PIPELINE.md` Kap. 6–8.
* Version 1.26.1.

Refs: Code Review Scanner, Kap. 9, 21.

## [1.26.0] — 2026-08-29 · Timeframe-Dimension im HistoricalStore + Migration (P1, BREAKING)

**`[HISTORY] Persist candle timeframe and deduplicate bars`** — Das
persistente Kerzenformat `data/history/candles.ndjson` erhält eine
**Timeframe-Dimension** (Schema **v2**). Bisher fehlte `timeframe` in
`HistoricalCandleEntry`: Mehrere Periodizitäten desselben Instruments
(`BITUNIX:BTCUSDT / 5m`, `/15m`, `/1h`) waren im Store nicht unterscheidbar
und würden zu einer gemeinsamen Faktorreihe verschmelzen — EMA, Momentum und
Volatilität wären unbemerkt falsch. Zusätzlich fehlte die deterministische
Deduplizierung (doppelte Bars bei wiederholtem Backfill).

**BREAKING CHANGE — Migration bestehender Daten erforderlich:**

```bash
npm run history:migrate -- --file=data/history/candles.ndjson \
  --assume-timeframe=15m        # mit --dry-run erst trocken prüfen
```

* `HistoricalCandleEntry.timeframe: SupportedTimeframe` (Pflicht), Zeilen mit
  `"v": 2`; logischer Schlüssel **instrumentId + timeframe + ts**.
* `append(candles, id, provenance, timeframe, now): { written, deduplicated }`
  — die alte 4-stellige Signatur wurde **entfernt** (kein optionaler
  Parameter, der den Mix-Bug still reproduziert); TypeScript zwingt jeden
  Aufrufer zur Migration.
* `query({ instrumentId, timeframe, from?, to?, limit? })` mit
  **Pflicht-Timeframe** (Compile + Runtime-Guard); `limit` liefert die
  letzten N Bars (ts desc selektiert, asc zurück), `from`/`to` inklusiv.
* Deterministische Dedup: jüngstes `fetchedAt` gewinnt, Gleichstand → zuletzt
  gelesen; `maxBarsPerSeries` (Default 5000) mit Kompaktierung.
* Legacy-Zeilen (ohne `timeframe`) werden als `LEGACY_UNKNOWN` markiert,
  gezählt, über Timeframe-Queries nie ausgeliefert und erzeugen eine
  einmalige Migrations-Warnung.
* `scripts/migrate-history-timeframe.ts` (`npm run history:migrate`):
  Backup `candles.ndjson.bak-<ISO>` (0600) vor dem Schreiben,
  `--assume-timeframe` Pflicht bei Legacy (kein Raten), `--dry-run`,
  Report (gelesen/migriert/dedupliziert/verworfen), **idempotent**,
  Verlust-Invariante `gelesen = geschrieben + dedupliziert + verworfen`.
* Streambasierter Loader (kein OOM), robuste Behandlung kaputter Zeilen,
  atomares Schreiben (`tmp`+`rename`), Security-Härtung (kein Path-Traversal,
  `JSON.stringify`-Zeilen, Werte-Validierung, feldweises Parsing ohne
  Spread gegen Prototype-Pollution).
* Aufrufstellen migriert: Sync-Service, MarketDataManager (Snapshot-Ticks
  → `1m`), ReplayFeed (Default `1h`), Scanner-Provider (`readAll()` mit
  Timeframe-Präferenz `1h→4h→30m→15m→5m`), Analytics-Port und Backtest-Step
  (`1h`). Der MicroExecutor nutzt den Store nicht (eigene In-RAM-Serien) und
  ist unberührt.
* Tests: `tests/history/historicalStore.test.ts`,
  `tests/history/migration.test.ts` (31 Tests); bestehende Tests migriert
  (Gesamt: 1217 grün).
* Doku: neu `docs/HISTORY.md` (Schema, Schlüssel, Dedup, Migration,
  Rollback, Sicherheit); `docs/MARKET_DATA_PIPELINE.md` Kap. 4–5 aktualisiert.
* Version 1.26.0; npm-Skript `history:migrate`; Test-Glob erweitert.

Refs: Code Review Scanner, Kap. 8, 20.

## [1.25.3] — 2026-08-29 · Deterministischer Warmup-Bedarf + Scanner-Readiness (OPS-009)

**Fix (P1, CODE-REVIEW-SCANNER Kap. 6/21):** `filters.minCandles=30` war
inkonsistent zum konfigurierten Faktorsatz (EMA50 → 50 Kerzen,
Momentum-Lookback 60 → 61 Kerzen) und erzeugte still unvollständige
Faktor-Scores. Zusätzlich war „keine Historie“ nicht von „Markt ungeeignet“
unterscheidbar.

* `requiredWarmupCandles(config)` — abgeleiteter Warmup-Bedarf (aktuell 61),
  kein Hardcoding, gedeckelt auf 1000 (Security).
* `filters.minCandles` fällt per Default auf `requiredWarmupCandles` zurück;
  Config-Validierung warnt bei zu niedrigem expliziten Wert (Strict: Fehler).
* `ScannerReadiness` = `READY | WARMING | ERROR` + `assessDataReadiness()`
  (reine Funktion); `ScanResult.readiness` + `.requiredCandles`, Funnel
  verhaltensgleich.
* `min-candles`-Rejection erklärt jetzt die Herkunft des Schwellwerts; Ops-
  Sektion + CLI weisen Readiness getrennt aus.
* Tests: `tests/scanner.warmup.test.ts`, `tests/scanner.readiness.test.ts` (+
  Config-/Pipeline-/Snapshot-Tests). Doku: `docs/MARKET_DATA_PIPELINE.md` Kap. 6,
  `docs/DAILY_WEEKLY_RESEARCH.md`.

## [1.25.2] — 2026-08-29 · Instrument-Enrichment: volume24h + Orderbook-Spread (nachträglich PR #35)

**Nacharbeit zu FEHLER-3 (P0, CODE-REVIEW-SCANNER §4/§5):** Discovery
(`trading_pairs`) liefert nur statische Handelsparameter — ohne Enrichment ist
`spread` für jedes Instrument `null`, und da der `spread`-Faktor (anders als
`liquidity`) keinen Fallback besitzt, läuft der Trichter an der `max-spread`-Regel
leer — auch nach einem Candle-Backfill. Der Funktionsumfang kam mit **PR #35**
(dort selbst als 1.24.1 geführt); dieser Release konsolidiert Versionierung,
Changelogs und Dokumentationsstand nachträglich — analog zur Nacharbeit zu
PR #33 (1.25.0) und PR #34 (1.25.1).

* `src/marketdata/spread.ts` — `calculateRelativeSpread(bid, ask) =
  (ask − bid) / mid`; fehlende, nicht-positive, invertierte oder nicht-endliche
  Werte ⇒ `null` („nicht geladen“) — nie `0`, nie `NaN`, nie eine Exception.
* `src/marketdata/sync.ts` — feste Reihenfolge je Instrument: `getTicker` →
  `volume24h`, `getOrderBook` → `calculateRelativeSpread(bids[0], asks[0])`,
  **ein** `registry.upsert({ …, volume24h, spread, lastSeen }, "sync:<VENUE>")`,
  danach Candle-Backfill. Ticker gebündelt (1× `getTickers`, Fallback per
  Symbol), Depth pro Instrument über den Token-Bucket (8 req/s) — kein Fan-Out.
* **Symbol-Guard:** Ein Ticker wird nur bei exakter Symbol-Übereinstimmung
  übernommen — sonst bleibt `volume24h` unbekannt statt fremd (+ Eintrag in
  `SyncResult.errors`, `stage: "ticker"`).
* `src/scanner/filters.ts` — `FilterRejection.dataQuality` trennt Data-Quality-
  von Fachablehnungen; die Meldungen nennen die fehlende Metrik explizit
  („Spread wurde nicht geladen …“ statt „Instrument ungeeignet“).
* Tests: `src/marketdata/__tests__/spread.test.ts` (Golden
  `100/100.02 ≈ 0.00019998`, Toleranz 1e-8), Enrichment-, Batch-Ticker-,
  Fallback- und Rate-Limiter-Tests in `sync.test.ts`, gehärtete Integration
  (`volume24h > 0` **und** `spread !== null`, 0 Credential-Header),
  Data-Quality-Tests in `tests/scanner.funnel.test.ts`.
* Doku: `docs/BITUNIX.md` §1.2 (Spread aus dem Orderbuch, 1 zusätzlicher
  `/depth`-Call je Instrument), `docs/MARKET_DATA_PIPELINE.md` §2–§3
  (Ende-zu-Ende-Datenfluss) + §8 (Data-Quality-Tabelle),
  `docs/DAILY_WEEKLY_RESEARCH.md` (Rejection-Shape mit `dataQuality`);
  Doku-Stand auf 1.25.2 aktualisiert.

**Sicherheit:** Public-Endpoints (`trading_pairs`, `tickers`, `depth`, `kline`)
senden keine Credential-Header (`sign`, `api-key`, `nonce`, `timestamp`,
`authorization`) — je Request getestet; `privateCalls === 0`. Die
Rate-Limit-Eskalation bei N Instrumenten (z. B. 180 × `/depth`) läuft
sequenziell durch den Token-Bucket (8 req/s) — kein Sekunden-Burst.

---

## [1.25.1] — 2026-08-29 · Bitunix-Wiring in den Scanner-Warmup (nachträglich PR #34)

**Nacharbeit zu FEHLER-2 (P0, CODE-REVIEW-SCANNER §2/§3):** Der Sync-Pfad existierte
seit 1.25.0, aber der funktionsfähige Adapter war nie angeschlossen — die Pipeline
nutzte nur den parallelen `BitunixMarketDataAdapter`-Wrapper. Das ist gelöst:
Verdrahtung über die zentrale Registry, redundanter Wrapper entfernt.

* `BitunixBrokerAdapter` implementiert explizit `MarketDataAdapter`
  (`implements BrokerAdapter, MarketDataAdapter`); `getCandles()` mit `limit`-
  Parameter, neu `getTickers()` (1× Batch-Ticker-Call).
* `src/marketdata/adapterRegistry.ts` (NEU) — die **einzige** Stelle, die konkrete
  Adapter-Klassen instanziiert; registriert `"BITUNIX"` im Modus `paper`, **ohne**
  PrivateClient/Credentials.
* `scripts/run-market-sync.ts` ruft produktiv `syncVenue("BITUNIX")` über
  `createAdapterRegistry()` auf.
* Redundanter Wrapper `src/marketdata/adapters/bitunix.ts` entfernt — keine
  parallele zweite Implementierung der Public-Pfade.
* Tests: `tests/bitunix.marketdata.test.ts` (Interface, Registry, Orderbook,
  Edge Cases, Security-Audit, 429-Retry/Backoff) und Fixture
  `tests/fixtures/bitunixMockClient.ts`; Integration läuft über Registry +
  Mock-HTTP-Layer. Volle Suite grün (1140/1140).
* Doku: `docs/BITUNIX.md` §1.1 (Vier-Ebenen-Trennung: public data / private
  trading / paper / live), `docs/MARKET_DATA_PIPELINE.md` (Venue-Matrix,
  `AdapterRegistry` im Architektur-Diagramm); Doku-Stand auf 1.25.1 aktualisiert.

**Sicherheit:** Im Sync-Pfad laufen ausschließlich Public-Client-Methoden
(`trading_pairs`, `tickers`, `depth`, `kline`) — keine Credential-Header
(je Request getestet), `privateCalls === 0`. `PrivateClient` bleibt für die
Order-Ausführung über die Broker-Factory getrennt.

---

## [1.25.0] — 2026-08-29 · Markt-Daten-Sync-Pfad (nachträglich PR #33)

**Nacharbeit zur Architekturänderung:** Der Scanner (`scanUniverse()`) las bisher
nur die lokale, oft leere Historie (`data/history/candles.ndjson`). Ohne einen
vorherigen Warmup-Lauf war der Trichter leer. Dafür gibt es jetzt einen
**eigenen Sync-Pfad** vor dem Scan — deterministisch, ohne den Scanner zu
verändern.

**Architektur (nach PR #33):**

```
Venue-Adapter (public REST) → MarketDataSyncService → Registry + HistoricalStore
                                                      → Scanner (weiterhin ohne Netz)
```

* `MarketDataAdapter.discoverInstruments()` (1×) → Registry
* `MarketDataSyncService.syncVenue()` (1× Batch-Ticker, N× Depth, N× 4 Timeframes)
* `scanUniverse()` bleibt deterministisch und netzwerkfrei; `/api/markets` bleibt read-only.

**Neu / bestätigt (nachträglich):**

* `src/marketdata/` — `MarketDataAdapter`, `MarketDataSyncService`, `Spread`,
  `UnsupportedVenueError`, `Bitunix-Public-Adapter` (Public-Client, keine Keys).
* CLI-Befehle: `npm run market-sync` und `npm run scan -- --sync-first`.
* Dokumentation: `docs/MARKET_DATA_PIPELINE.md` (Discovery, Enrichment,
  Backfill 5m/15m/30m/1h mit 150 Kerzen, Persistence, Readiness, Scanner,
  Failure-Semantics, Rate-Limiting 8 req/s, Venue-Matrix, Sicherheit).
* Verhalten: Fehler pro Instrument isoliert (kein Full-Abort); Token-Bucket
  8 req/s nur Public-Client; CLI loggt nur aggregierte Zähler.
* Doku-Stand auf 1.25.0 aktualisiert.

**Sicherheit:** Keine Private-API, keine Credentials im Sync-Pfad; Adapter-Instanzierung
nur über `AdapterRegistry` im Modus `"paper"`; Integrationstests prüfen `privateCalls === 0`.

---

## [1.24.1] — 2026-08-29 · Instrument-Enrichment: volume24h + Orderbook-Spread (PR #35)

**Nacharbeit zu 1.24.0 (CODE-REVIEW-SCANNER §4/§5):** `discoverInstruments()`
liefert nur statische Handelsparameter (`symbol`, `base`, `quote`,
`minTradeVolume`, Präzisionen, `maxLeverage`, `symbolStatus`, `isApiSupported`) —
**keine** Liquiditäts- oder Preismetriken. Ohne Enrichment ist `spread` für
jedes Instrument `null`, der `spread`-Faktor hat (anders als `liquidity`)
keinen Fallback, und der Trichter läuft an der `max-spread`-Regel leer — auch
nach einem Candle-Backfill.

* **Enrichment-Pfad** `trading_pairs → tickers → volume24h → depth →
  bestBid/bestAsk/spread → kline → HistoricalStore → Scanner`:
  `MarketDataSyncService.syncVenue()` ruft je Instrument `getTicker()` (bzw.
  1× `getTickers()` als Batch) und `getOrderBook()` auf und schreibt
  `volume24h` + berechneten relativen Spread mit `lastSeen` in die Registry.
* **`calculateRelativeSpread()`** (`src/marketdata/spread.ts`):
  `(ask − bid) / mid`; fehlende/invertierte/nicht-positive/`NaN`-Werte ⇒
  `null` („nicht geladen“), niemals `0` und niemals eine Exception.
* **Data-Quality-Rejections:** `FilterRejection.dataQuality` trennt fehlende
  Daten (`min-candles`, `min-volume`, `max-spread`, `max-execution-cost`) von
  fachlichen Marktgründen; Meldungen sagen „… wurde nicht geladen“ statt eines
  generischen „Instrument ungeeignet“.
* **Symbol-Guard:** Ein Ticker wird nur übernommen, wenn sein `symbol` exakt
  zum Instrument passt — sonst bleibt `volume24h` unbekannt statt fremd.
* **Doku:** `docs/MARKET_DATA_PIPELINE.md` (Enrichment-Datenfluss,
  Data-Quality-Tabelle) und `docs/BITUNIX.md` §1.2 (Spread kommt aus
  `/depth`, nicht aus dem Ticker; 1 zusätzlicher Call je Instrument).

## [1.24.0] — 2026-08-29 · Persistenter Venue-Market-Data-Sync

**Haupt-Task:** `MarketDataSyncService` orchestriert Discovery → Ticker- und
Orderbook-Enrichment → Candle-Backfill (5m/15m/30m/1h) in Registry und
Historical Store. Der Scanner bleibt deterministisch und netzwerkfrei.
CLI: `npm run market-sync`, `npm run scan -- --sync-first`. Doku:
`docs/MARKET_DATA_PIPELINE.md`.

## [1.23.0] — 2026-08-29 · Operations Center vollständig integriert (Task 10)

**Haupt-Task:** Das Operations Center ist keine Phase-1-Hülle mehr. Der Tab
zeigt zehn Sektionen mit echten Werten aus bestehenden Modulen — statt sieben
Karten, von denen fünf auf `stub` standen.

**Ausgangslage (Beanstandung aus dem Review):** `docs/ARENA_TASKS.md` wies Task
10 als „Implementiert“ aus, während Code und API sich selbst als
„Operations-Center-Hülle“ bezeichneten und der Tab textlich erklärte, er sei
„bewusst die leere Hülle“. Korrektur: **Code an Doku angeglichen** (nicht die
Doku herabgestuft).

**Neu — zehn Sektionen, jede mit Quellen und Ist-Daten:**

- **Market Universe** — Bestand je Venue, Datenstand, Policy-Version (`src/universe`).
- **Scanner** — Trichter scanned→eligible→interesting→daily→deep, Top-Scores mit
  Regime (`src/scanner`).
- **Portfolio Analytics** — offene Positionen, Exposure, Eigenkapital,
  Tagesergebnis; Gewichte/Kennzahlen bleiben Sache des Portfolio-Moduls.
- **Research Operations** — Tages-/Wochenläufe, Status, Dauer, Weekly-Klassen
  (`src/cycle`).
- **Broker Operations** — sieben Venues mit Capabilities, Execution-Modi und
  lokalem Health (`GET /api/brokers`).
- **LLM Operations** — Routing-Policy, Modus, Provider-Health, Tagesbudget,
  letzte Entscheidungen (`GET /api/routing`).
- **Agent Operations** — Agenten, Rollen, Missionen, letzte Aktivität.
- **Risk** — Limits, Volatilitäts-Regime, Kill-Switch, Live-Gate-Lage.
- **Audit** — Ereignisse/Warnungen/kritische Treffer plus Integrität der
  Live-Gate-Hash-Kette.
- **Help** — Hilfe-Dateien, Fachbegriffe und der Dokumentationskatalog.

**Architektur:** Neues Modul `src/ops/` (`types.ts`, `collect.ts`, `index.ts`)
aggregiert ausschließlich bestehende Fassaden. Keine zweite Fachlogik, keine
Mutation, kein Secret im Payload. `src/auth/ops.ts` hält weiterhin Katalog und
RBAC-Projektion (Rolle, Live-Sperre); `buildOpsPayload()` führt Katalog und
Ist-Daten zusammen.

**Robustheit:** Jede Sektion ist fail-soft. Eine nicht erreichbare Quelle
(z. B. PostgreSQL aus, `docs/`-Ordner fehlt) macht nur ihre Sektion
`unavailable` mit redigierter Meldung — das Cockpit bleibt lesbar. Der
Zustandsraum `ready | degraded | empty | locked | unavailable` ersetzt `stub`.

**Bedienung:** Der Reiter „🧭 Operations Center“ ist jetzt im Dashboard
sichtbar (vorher nur im Code vorhanden). Karten mit Ziel-Tab (Brokers, Risk,
Protokoll) springen direkt dorthin; jede Karte nennt unter „Quellen“ ihre
Datenherkunft.

**Getrennt/Sauber:** `src/lib/docsCatalog.ts` ist die neue Single Source of
Truth für die Dokumentations-Whitelist — `GET /api/docs` und die Help-Sektion
lesen dieselbe Liste (vorher nur in der Route).

## [1.22.0] — 2026-08-29 · Provider/Modell-Overrides + Audit-Härtung + Test-Isolation

**Administrative Provider/Modell-Auswahl je Agent (Haupt-Task):** Admins können
jetzt pro Agent einen expliziten Provider und ein explizites Modell festlegen
(Overrides), die vor der normalen Policy-/Modusauswertung greifen — mit
best-effort-Persistenz, Fallback und vollständiger Auditierung.

- **Neu `Provider/Modell-Override`** im Router (`setOverrides()`/`getOverrides()`):
  pro Agent ein Tupel `{provider, model, fallbackMode}`. Override wird zuerst
  versucht (Health, Cloud-Freigabe, Budget, Kontext, Fähigkeiten bleiben harte
  Router-Guardrails); bei Fehlschlag (offline/Quota/Kontext/…) fällt der Router
  transparent in den konfigurierten `fallbackMode` und die normale Kette läuft
  weiter.
- **Persistenz:** Overrides werden best-effort unter `data/routing/overrides.json`
  (chmod 600) gespeichert und beim nächsten Start geladen — analog zu den
  bereits vorhandenen Routing-Modi (`data/routing/modes.json`). Korrupte oder
  fehlende Dateien werden toleriert (leerer Startzustand). Deaktivierung via
  `null` (z. B. `{"TECHNICAL_ANALYST": null}`) entfernt einen Override.
- **API-Erweiterung** `PUT /api/routing/modes`: akzeptiert jetzt zusätzlich
  `overrides` im selben Request; Antwort enthält beide Audit-Logs. `GET
  /api/routing/modes` liefert neben den Modi auch die aktuellen Overrides.
  Ungültige Modelle werden abgewiesen (Modell muss in der Provider-Registry
  registriert sein).
- **Snapshot/Audit:** `RouterSnapshot.overrides` und der Routing-API-Snapshot
  liefern die Overrides mit; jede Setzung/Deaktivierung wird als
  `ADMIN_OVERRIDE_CHANGE` mit `from → override:provider:model → to` auditiert.
- **Fallback-Verhalten:** Scheitert der Override-Provider (offline, Quota
  erschöpft, Kontext zu klein, Fähigkeit fehlt, Kostendeckel, Agenten-Budget),
  wird automatisch in den `fallbackMode` gewechselt — kein harter Fehler.
  Jeder Fallback ist als `FALLBACK_CHAIN` auditiert.

**Actor-Audit-Sicherheitsfix:**

- **Client-geliefertes `actor`-Feld wird ignoriert.** Das betrifft
  `PUT /api/routing/modes` (und war bereits für alle Control-Plane-Routen
  unter `/api/brokers/*` umgesetzt): die Audit-ID wird ausschließlich aus der
  authentifizierten Principal-Rolle nach RBAC/CSRF aufgelöst
  (`actorAuditId(req)` → `admin`/`operator`/`viewer`). Ein Angreifer, der
  Operator- oder Viewer-Token besitzt, kann keine Admin-Aktionen als
 另一 Benutzer im Audit unterschieben; lokaler Offen-Betrieb (kein Token
  gesetzt) schreibt konsistent `admin`. TSDoc-Kommentare an den betroffenen
  Routen verschärft, Regressions-Test für Routing-API vorhanden.

**Weitere Änderungen:**

- **Test-Fixture-Härtung:** `tests/fixtures/routingTestUtil.ts` setzte
  `overridesFile: null` nicht, so dass On-Disk-Overrides zwischen Tests
  leckten und einen Override-Validierungstest falsch negativ schlugen
  (Reihenfolgenabhängigkeit). Behoben — beide Persistenz-Pfade (`modesFile`,
  `overridesFile`) sind im Test-Modus jetzt `null`.
- **Neue Routing-Tests (+5, total 1148):** Override-Deaktivierung (Null),
  Persistenz (Write → Reload), Malformed-JSON-Toleranz, Fallback-Kette bei
  Offline-Override, Snapshot-Invarianten. `tests/routing.*.test.ts` jetzt
  **107 grün**.
- **Doku-Aktualisierungen:** `docs/LLM_ROUTING.md` auf Version 1.22.0
  aktualisiert (Overrides, Persistenz, Deaktivierung, Fallback-Verhalten,
  Authentifizierung und Audit-Identität, Peer-Review-Checkliste ergänzt),
  `docs/PROVIDER_INTEGRATION.md` und `README.md` auf 1.22.0 nachgezogen.
  Neues Peer-Review-Dokument `docs/PEER_REVIEW_ROUTING_OVERRIDES.md`.
- **Keine Breaking Changes:** Bestehende Modi (`manual`/`automatic`/`hybrid`),
  Policy-Datei, API-Responses (additive Felder) und Env-Variablen bleiben
  kompatibel. Weder `putCredentials`-Arbeitsfluss noch Live-Gate oder
  Broker-Coverage werden berührt.

## [1.21.0] — 2026-08-29 · Coverage-Trennung + vereinheitlichte Paper-Execution

**Terminologie & Broker-Status-Tracking getrennt (Haupt-Task):** „gescannte“
bzw. registrierte Venues sind jetzt klar von der tatsächlichen Capability-
Abdeckung getrennt.

- **Neu `src/brokers/coverage.ts`** (`computeBrokerCoverage`): reine Projektion
  aus der Capability-SSoT + Live-Gate-Enforcer. Liefert Headline-Kennzahlen
  („7 Venues registriert · 1 mit vollständiger Discovery · 1 mit Paper-Market-Data
  · 0 mit aktiviertem Live Trading“) und fünf Coverage-Metriken (Discovery /
  Market Data / Paper / Testnet / Live Execution).
- **Neu `GET /api/brokers/coverage`** (read-only, tokenfrei, keine Secrets).
- **Neu `CoveragePanel`** im Brokers-&-Venues-Tab: differenzierte Headline,
  fünf Coverage-Balken und eine Detailtabelle je Venue (intern/extern, Live-
  Fähigkeit vs. Live-Freigabe getrennt). Ersetzt die irreführende Zählung
  „7 Broker“.
- **Headline extern gezählt:** Der interne `PAPER`-Simulator wird transparent
  als *intern* markiert; die Headline misst reale externe Venue-Integration.

**Paper-Execution vereinheitlicht (Sekundär-Task):** Der Bitunix-Paper-Ledger
verwendet **keine** separate, vereinfachte Simulation mehr.

- **Fix `src/brokers/bitunix/paper.ts`:** statt fester Faktoren
  (LONG → `price·1.0001`, SHORT → `price·0.9999`) läuft jeder Fill jetzt durch
  den **zentralen** `FillSimulator` (Spread, Slippage, Gebühren, Latenz,
  Partial Fills). `Generic Paper === Bitunix Paper`.
- **Neu `src/lib/marketdata/snapshot.ts`** (`snapshotFromLastPrice`,
  `fallbackInstrument`): wandelt einen reinen Last-Preis-Ticker in einen
  normalisierten `MarketSnapshot` (Bid/Ask symmetrisch aus synthetischem
  Spread), damit ticker-basierte Venues dieselbe Fill-Engine nutzen.
- **Neuer Env-Knopf** `PAPER_SIM_SYNTHETIC_SPREAD_BPS` (Default 2 bp).
- **Keine Breaking Changes:** Reject-Pfade, Guardrails, Kill-Switch und der
  Live-Pfad (weiterhin `LiveTradingGateError`) unverändert.
- **Neue Tests (+24):** `brokerCoverage.test.ts`, `brokerCoverage.api.test.ts`,
  `bitunix.paper.unified.test.ts`, `marketdata.snapshot.test.ts`.

## [1.20.0] — 2026-08-28 · Bitunix-Ausführungs-Refactor (Paper/Broker getrennt)

**Kritischer Bugfix + Architektur-Trennung (Peer-Review umgesetzt):** Der
Bitunix-Live-Pfad handelt **niemals mehr über das lokale Paper-Ledger**.

- **`ExecutionPort`** (`src/brokers/bitunix/execution.ts`): `PaperExecutionEngine`
  (paper/backtest, lokales Ledger) und `BrokerExecutionEngine` (live, echte
  Private-API) sind zwei getrennte Implementierungen desselben Ports.
- **Adapter-Fix:** `placeOrder`, `getAccount`, `getPositions` im Live-Modus
  delegieren nach bestandener Live-Gate-Prüfung an die **Broker-Engine**
  (`BitunixPrivateClient.placeSerializedOrder` / echte Venue-Daten) — nicht mehr
  an `paper.submit()` / Paper-Account. Kein stiller Fallback.
- **Semantik-Trennung** (Fehler 3): neues Instrument-Feld `liveTradable`
  (Fähigkeit des Instruments am Broker) klar getrennt von `adapterCapabilities.live`,
  `venueControl.liveEnabled` und `liveGate.state`. `liveAvailable` bleibt als
  abwärtskompatibler Spiegel. Bitunix-Mapping: `liveTradable=true`,
  `liveAvailable=false`.
- **Keine Breaking Changes:** Paper-Trading & Testnet-Verhalten unverändert;
  Live bleibt ohne bestandene Gate-Prüfung `LiveTradingGateError`.
- Neue Tests: Live-Gate-OPEN → Broker-Engine (nicht Paper), ExecutionPort-Separation,
  Semantik-Trennung der vier Live-Konzepte.

## [1.19.0] — 2026-08-28 · Task 11 (Live-Trading-Gate)

- Auditierte Live-Trading-State-Machine: 9 Zustände, exakt 8 legale Übergänge.
- Single-Point-Enforcer vor jeder Venue-Order; Human-Gate mit 24 h Cooldown und
  4-Augen-Modus; Kill-Switch mit persistenter Failsafe-Datei.
- Append-only Audit mit SHA-256-Hash-Kette; merge-blockierender CI-Job
  `security-live-gate` (Coverage ≥ 95 %).
- **Aktiviert KEIN Live-Trading** — Default bleibt DISCONNECTED/off.

## [1.18.0] — 2026-08-28 · Task 10 (Operations Center + RBAC)

- Rollen `viewer` / `operator` / `admin`; Ops-Tab; Doku-Drift-Fixes.
- 3-Ebenen-Hilfe (`docs/help/*.help.json`) als Tooltip-Grundlage.

## [1.17.0] — 2026-08-28 · Task 09 (Model-Router)

- `MODEL_ROUTER` mit 9 Routing-Inputs, Default-Tabelle
  (CEO→automatic, Research→large, Technical→local-small, News→local-small,
  Risk→local-medium, Portfolio→local-medium), Eskalationsfluss, Budgets, Audit.

## [1.16.0] — 2026-08-28 · Task 08 (Broker Control Plane)

- Credential-Secret-Store mit Verschlüsselung, Health-Checks, Red-Team-Checks,
  Audit-Katalog-UI.

## [1.15.0] — 2026-08-27 · Task 07 (Bitunix-Adapter)

- Bitunix als 7. Venue: Public REST/WS, Signing, Paper-Modus B; Live bleibt
  gesperrt.

## [1.14.0–1.12.0] — 2026-08-27 · Tasks 05–06 (Portfolio-Analytics, Cycle)

- Portfolio-Analytics mit Formelkatalog, drei Optimizer-Modi und Risk-Guard-
  Kette; Daily/Weekly-Agent-Cycle mit CORE/ROTATION/DISCOVERY/EXCLUDED.

## [1.11.0–1.9.0] — 2026-08-27 · Tasks 03–04 (Paper-Trading, Scanner)

- Broker-unabhängige Paper-Market-Data (Modi A/B/C) mit deterministischem
  Fill-Simulator; deterministischer Markt-Scanner mit Score-Gewichten
  (25/15/15/10/10/10/5/5/5) und Trichter (10.000→2.000→500→100 + 20–40 Deep).

## [1.8.0–1.6.0] — 2026-08-26/27 · Tasks 01–02 (Universe, Broker-Modell)

- Instrument-Registry (Market Universe) mit Normalisierung; Broker-Capability-
  Modell mit Execution Modes `backtest/paper/testnet/live` und Adapter-Vertrag.

## [1.0.0–1.5.x] — 2026-08 (Ausgangsstand)

- Next.js + Drizzle + PostgreSQL, 6-Agenten-Pipeline, LLM-Provider-Schicht,
  Security-Härtung (Secret-Store, Guard, Audit-View). Ausführliche Einträge:
  `docs/CHANGELOG.md`.

## Unreleased / Backlog

- Vollständige, code-synchronisierte Docs (15/15 Zieldateien mit Status-Header),
  Root-Docs (`README.md`, `INSTALL.md`, dieser Changelog) — seit 1.22.0
  durchgehend versioniert.
- Hilfe-Systematik: `docs/help/help.schema.json` + alle `*.help.json` schema-valid.
- CI-Job `docs-validate` (Schema, Link-Check, Markdown-Lint, Secret-Scan, Konsistenz).
- Audit-Report `docs/DOCS_SYNC_AUDIT.md`; Task-Tracker `docs/ARENA_TASKS.md`
  (Tasks 1–12); SECURITY_AUDIT-Kapitel Task 12.
- Multi-Node Rate-Limit/Scheduler-Locks (prozess-lokale Limits im Single-Node-Betrieb).
- Persistente Scheduler-Locks über Prozesse hinweg (siehe docs/CHANGELOG.md Backlog-Tabelle).
## [1.34.0] — 2026-08-31 · feat(install): geführtes Windows-Setup mit PowerShell

* **Windows-Installation:** `scripts/setup-windows.ps1` installiert per `winget`
  Git, Node.js LTS, PostgreSQL und optional Ollama, richtet Datenbank und `.env`
  ein, seedet das Universum und führt Typecheck, Lint, Build und Health-Check aus.
* **Dokumentation:** [`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md) enthält
  den One-Liner, Eingabeführung, Sicherheitsdefaults und konkrete Workarounds.
* **Sicherheit:** Secrets werden nicht geloggt; Live-Trading bleibt deaktiviert.
