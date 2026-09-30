# VERSION — Autonome KI-Trading-Firma

**Kanonische Versions-Metadaten** des Projekts. Alle anderen Versionsverweise
in Code und Doku leiten sich von diesem Stand ab.

| Feld | Wert |
| --- | --- |
| **Version** | `v0.6.5` |
| **Schema** | SemVer, öffentliches `v0.x.x` (0.x = Beta-Phase) |
| **Status** | **BETA — nicht produktionsreif** (Paper-Trading, keine Live-Broker-Garantien) |
| **Beta-Zusage** | Bleibt `0.x`/Beta **unabhängig** vom Funktions- und Ausbau-Stand — Kriterien `B1…B8`: [`docs/BETA_STATUS.md`](docs/BETA_STATUS.md) |
| **Release-Datum** | 2026-09-30 |
| **Quellbasiert** | `package.json` (`version: "0.6.5"`), `src/lib/version.ts` liest die SSoT zur Laufzeit |
| **Changelog** | [`CHANGELOG.md`](CHANGELOG.md) (Keep a Changelog) |
| **Legacy-Historie** | [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md) (interne Zählung `v1.x.x`, `v1.73.1` ≙ `v0.1.0`) |

## Bedeutung der Version

`v0.1.0` ist die **Beta-Baseline**: Sie bündelt den gesamten bis dahin
erreichten Funktionsstand der Beta-Entwicklung (interne Zählung bis `v1.73.1`)
und etabliert das öffentliche v0.x.x-Schema. `v0.2.0` ergänzt den
kostenbewussten Regel-Backtest, den Workshop-Schritt 5 und die
Trusted-Indikatoren, ohne den Engine-Default zu ändern. `v0.3.0` liefert:

- **Paper lange genug für n ≥ 100**: `RULE_BACKTEST_MIN_BARS` 40 → 100,
  `JOURNAL_MIN_TRADES` 20 → 100, `backtestMinTrades`/`paperMinTrades`/
  `driftMinSample` 30/20/20 → 100/100/100 — statistisch belastbare Stichproben.
- **Kostenmodell auf den feinen Takten**: Spread- und Slippage-Fallback
  timeframe-abhängig (1m 15 bp, 5m 10 bp, 15m 8 bp, 30m 6 bp, 1h 4 bp, 4h 3 bp,
  1d 2 bp) — feiner Takt frisst mehr Edge, das Modell rechnet das jetzt ehrlich.
- **6 rote Tests grün**: Audit-Reliability (Fake-DB für Prompt-Artefakte),
  Mission-Template (guardrail-stress-test mit erlaubter Deckel-Warnung),
  Sentiment-API (fail-soft ohne DB), Performance-Deckel (O(n²) → O(n) via
  Indikator-Cache, 17 s → 0,6 s für 2 Jahre 1h).
- **spreadPct als Regelfeld**: Orderbuch-Spread als Prozentfeld
  (`instrument.spread` ×100), verfügbar in `RuleSnapshot`, `RULE_FIELDS`,
  Mikro-Executor (`updateSpread`), Trusted-Indicators und Workshop.

`v0.4.0` liefert die logische Fortsetzung von `spreadPct`:

- **bookDepthUsd als Regelfeld** (IAD-T-06): Orderbuch-Tiefe der abriegelnden
  Seite `min(Σ bid×qty, Σ ask×qty)` in Quote-Währung — gemessen im
  `market-sync`, live im Mikro-Executor (`updateBook`, Binance `@depth5`),
  verfügbar im `RuleSnapshot`/`RULE_FIELDS`, `TrustedReading` und Backtest.
  `null` = keine belastbare Tiefe (fail-closed, nie eine erfundene 0).
- **Orderbuch-Qualitätsgrenze je Venue** (`src/lib/bookDepthProvenance.ts`):
  `depth`-Venues (BINANCE/BITUNIX/KRAKEN, ≥ 3 Levels, Snapshot ≤ 5 s) liefern
  `VERIFIED`; `top`-Venues (YAHOO) und `none` bleiben `UNQUALIFIED` — der
  Schutz gegen Fake-Liquidität auf dünnen Büchern.

`v0.5.0` ergänzt den Market-Sync und die Scan-Missionsbrücke:

- **Mehrere Missions-Venues warmziehen** (`npm run market:sync:mission-venues`)
  synchronisiert IBKR, PAPER, BINANCE und KRAKEN separat, ohne Freigabe-Gates
  zu umgehen, und berichtet den Gesamtstatus.
- **Datenbewusster Missionsprompt**: bis zu fünf Scanner-/Volumen-gerankte
  Kandidaten mit Preis, RSI, Trend und ATR%; Kandidaten ohne mindestens 25
  Kerzen sind nicht handelbar (fail-closed).
- **Fokusrotation** deterministisch je 15-Minuten-Zyklus und Missions-ID;
  Scanner-Scores aus einem aktuellen READY-Artefakt haben Vorrang, Volumen ist
  der Rückfall.

`v0.6.0` liefert die **Backtest-Performance-Baseline** (Prompt 00-01, Finding STX-12)
— Messung, keine Optimierung:

- **`npm run bench:backtest`** (`scripts/bench-backtest.ts`): misst auf einer echten,
  aus dem `HistoricalStore` gelesenen Reihe drei Pfade (`backtestRule`,
  `runMultiAssetBacktest`, `buildIndicatorCache`+`snapshotFromCache`) bei
  n ∈ {1 000, 5 000, 17 520} Kerzen, je 1 Warmlauf + 3 Läufen (Median), mit
  `ms/1000 Kerzen`, log-log-Fit-Exponent und der „1 Zelle Matrix"-Rechnung. Ohne Netz,
  ohne Datenbank; schreibt nur nach `data/bench/` (gitignoriert).
- **`npm run history:import-csv`** (`scripts/import-history-csv.ts`): netzfreier
  CSV-Import in den Store (Dry-Run als Default, `--apply`, `--from`/`--to`, `--max-bars`),
  damit die Messreihe reproduzierbar ist.
- **Ergebnis** ([`BENCH-BASELINE.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)):
  `backtestRule()` wächst mit Exponent **1,99** (54,14 Kernstunden für 7 500 Zellen),
  die Engine mit **1,01** (0,44 Kernstunden) — **121,7×** bzw. **360,1×** schneller.
  Entscheidung: Screening läuft über `runMultiAssetBacktest()`, STX-12 wird Patch-Task.
- **Kein Laufzeitverhalten geändert:** `ruleEngine.ts`, `engine.ts` und
  `indicatorCache.ts` bleiben unberührt; Audit-Doku auf Stand `v1.1.0`.

`v0.6.1` liefert die **Strategie-Stack-SSoT** und die **drei Vokabular-Entscheidungen**
(Prompts 00-02/00-03, Findings STX-02/03/04) — Doku, kein Laufzeit-Code:

- **[`docs/architecture/STRATEGY_STACK.md`](docs/architecture/STRATEGY_STACK.md)** (00-02, mit
  PR #182 gemergt und hier nachträglich versioniert): SSoT-Karte „welcher Baustein ist wofür
  zuständig“ mit expliziten Lücken und Einordnungsregel; im selben Zug gegen den Code
  nachverifiziert und korrigiert.
- **ADR-008 bis ADR-010** in [`docs/roadmap/DECISIONS.md`](docs/roadmap/DECISIONS.md):
  Strategieklasse (`StrategyTemplate.class` Pflicht aus `STRATEGY_CLASS_KEYS`, `unclassified` ist
  ein Fehler, keine neue Klasse), Regime (`MarketRegime` + `UNKNOWN` fail-closed, 7er-Taxonomie
  verworfen) und Universe (keine `MultiAssetStrategySpec`; `PortfolioConstruction` liest den
  `CrossSectionalConfig`-Snapshot).
- **Gate G0 der Strategie-Roadmap erfüllt:** Phase 1 (`v0.6.2`, Timeframe-Angleichung) darf starten.
- **`tests/adrVocabulary.test.ts`:** hält die ADRs gegen Code, Roadmap und Prompts fest (nur lesend).
- **Kein Laufzeitverhalten geändert:** `src/`, `scripts/` und `drizzle/` bleiben unberührt; Audit-Doku
  auf Stand `v1.1.1`.

`v0.6.2` liefert die **Timeframe-Angleichung** (Prompt 01-01, Finding STX-01, Gate G1):

- **Ein Vokabular:** `RuleWindow.timeframe` ist ein `SupportedTimeframe` — alle zehn Werte
  `1m … 5d` (vorher fünf). `RULE_ALLOWED_TIMEFRAMES` (`ruleEngine.ts`) und das LLM-Schema leiten
  sich aus `SUPPORTED_TIMEFRAMES` ab; die Liste lebt als reine, client-sichere Datei in
  `src/lib/marketdata/timeframes.ts` (der Historical Store re-exportiert sie), der Workshop-Schritt 5
  liest dieselbe Liste. `sanitizeRuleSpec`, `RULE_FIELDS`, `RuleAction`, `RULE_CEILINGS` und
  `RULE_ALLOWED_SIDE` sind unverändert; Regeln mit `1m … 1h` liefern dieselben Bytes wie zuvor
  (Golden-Test).
- **Timeframe-Guard im Mikro-Executor (fail-closed, sichtbar):** Er wertet Regeln nur bis zu seinem
  Ausführungsintervall aus (`MicroExecutorOptions.executionInterval`, Default `1h`). Längere Regeln
  (`2h`, `4h`, `1d`, `5d`) bekommen keine Serie und lösen nie aus — Counter
  `micro_executor_rule_blocked_total`, Log `micro_executor_rule_blocked` und `status().ruleGuard`
  (`GET /api/firm/micro`) machen das „Nein“ sichtbar. Die Serien rechnen mit der kanonischen
  Periodentabelle; `3m` läuft nicht mehr still auf 15-Minuten-Kerzen.
- **`vwapPct` ist eine Intraday-Größe:** auf `1d`/`5d` immer `null` (nie `0`) — per Test belegt, in
  [`docs/BACKTESTING.md`](docs/BACKTESTING.md) §1.1 tabelliert („Rule-Timeframe ↔ unterstützte Felder“).
- **Bekannte Einschränkung:** Das Kosten-Fallback-Modell des Paper-Backtests ist für `3m`, `2h`, `5d`
  nicht kalibriert (`3m` optimistisch) — bewusst unverändert, siehe dieselbe Tabelle.
- **Audit-Doku auf Stand `v1.1.2`:** STX-01 behoben, Gate G1 erfüllt, Phase 2 darf starten.

`v0.6.3` ergänzt die reinen Formeln `bollingerBands` (Bandlevel und exakt
BBW-paritätsgleiche Bruch-Bandbreite) und `donchianChannel` (entry/exit-Fenster
**ohne** aktuelle Kerze). Parameter werden begrenzt; ohne genügend gültige Daten
gibt es `null`. Donchian verlangt bei Template 03-08 einen Higher-Timeframe-Guard.
Noch keine neuen `RULE_FIELDS`, Rule-Snapshots oder Cache-Felder; 02-02/02-03
folgen separat.

`v0.6.4` schließt die erste Hälfte davon: Die **Bollinger-Bandlage** wird
regelfähig. Drei additive `RULE_FIELDS` — `bbZScore` (`(close − middle)/σ`,
dimensionslos), `priceVsUpperBbPct` und `priceVsLowerBbPct` (Abstand zur Kante in
Prozent des Kurses) — beschreiben die **Position** im Band, während `bbwPct` die
**Breite** misst. Bandparameter fest 20/2σ; `null` bei fehlender Historie,
`middle <= 0` und (nur `bbZScore`) σ == 0 — nie eine erfundene 0. Beide
Snapshot-Pfade liefern dieselben Werte (`buildSnapshotFromCandles` und
`buildIndicatorCache`/`snapshotFromCache`), geprüft in
`tests/backtest.multiAsset.test.ts`; ein Golden-Hash belegt, dass Läufe ohne
Bollinger-Feld byte-identisch zu `v0.6.3` bleiben. Das Donchian-Feld folgte in
`v0.6.5` (02-03); Templates beginnen mit `v0.7.0`.

`v0.6.5` schließt die zweite Hälfte: Der **Donchian-Ausbruch** wird regelfähig.
`donchianBreakoutPct` = `(close / upper − 1) · 100`, wobei `upper` das Hoch der
**vorigen 20 Kerzen** ist (`donchianChannel`, ohne Signalkerze, STX-02-01) —
positiv = Ausbruch über den vorher bekannten Kanal, kein Look-ahead. `null`
(nie 0) unter 21 Kerzen oder bei `upper <= 0`; eine echte 0 = Kurs exakt auf dem
Kanalhoch. Die Fensterlänge ist **kein Regelfeld**, sondern Template-Parameter
(03-08); die Formel liegt in `donchianBreakoutPct()` (eine Stelle), der Cache
rechnet `donchianUpper` mit einer monotonen Deque in **O(n)** vor (kein
`Math.max` über ein Fenster je Bar, STX-12). Beide Snapshot-Pfade sind
Bar-für-Bar pari (Test über drei Symbole), der Golden-Hash unveränderter
Bestandsläufe bleibt bestehen. Damit sind alle sieben Strategie-Vorschläge des
Audits regelformulierbar; Templates folgen ab `v0.7.0`.

In der 0.x-Reihe dürfen Breaking Changes eingeführt werden, wenn sie im
Changelog dokumentiert sind.

**Beta-Hinweis:** Das Projekt ist für Bildungszwecke und private Nutzung auf
eigene Gefahr konzipiert. Kein Teil davon ist für produktive Handelsumgebungen
bestimmt (Details: Disclaimer im [`README.md`](README.md)).

**Beta-Exit:** Das Verlassen der `0.x` ist **kein** Feature-Ziel und wird nicht
per Roadmap ausgelöst. Maßgeblich sind acht Kriterien `B1…B8` (Out-of-Sample
über 12 Monate Live-Paper, Regime-Abdeckung, Live-Readiness-Audit, Security,
Compliance, Betriebsreife, **unabhängige** Drittprüfung, bewusste
Haftungsentscheidung) in [`docs/BETA_STATUS.md`](docs/BETA_STATUS.md).

**Ausdrücklich gilt:** Auch die vollständige Umsetzung der Strategie-Roadmap
([`docs/audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`](docs/audits/2026-09-29-strategy-template-ausbau/ROADMAP.md),
32 Prompts, Releases `v0.6.0` … `v0.11.2`) **beendet die Beta-Phase nicht**.
Sie liefert die Messgeräte, nicht die Messung — und keine Phase erfüllt ein
Kriterium. Begründung: `report.md` §8 des Audits.
## Komponenten-Übersicht

### Kernmodule (`src/`)

| Modul | Zweck |
| --- | --- |
| `src/cycle/` | Agenten-Zyklus (Daily/Weekly): sequenzielle Schritte der KI-Agenten (Technical/News/Macro → Research → Risk → Portfolio → Approver → Executor) |
| `src/scanner/` | Deterministischer Market-Scanner (Liquidität/Volatilität/Korrelation, **14 aktive** Faktoren laut `scanner.config.json`, point-in-time) |
| `src/marketdata/` | Markt-Daten-Pipeline: Multi-Venue-Sync, Candle-Backfill, Qualitäts-Layer, Aggregation, Readiness |
| `src/brokers/` | Broker-Schicht: Paper-Broker (Fill-Simulation), Bitunix/Alpaca-Adapter, Reconciliation, Emergency-Broker-Schnittstelle |
| `src/execution/` | Ausführungspolitik: Order-Gates, Post-Only-Fallback, TWAP-Engine, Policy-Controller |
| `src/live-gate/` | Harte Freigabeschicht für jeden Live-Pfad (Flags, Security-Stamps, Kill-Switch-Kopplung) |
| `src/risk` (in `src/lib/`) | `riskGuard`, `adaptiveRisk`, `positionSizing`, `clusterExposure`, `volatilityTargeting`, `drawdownScaling`, `signalDecay`, `circuitBreaker`, `exits` |
| `src/portfolio/` | Portfolio-Engine: Kennzahlen, Korrelations-Cluster, Volatility-Targeting-Policy, Drawdown-Policy |
| `src/lib/indicators.ts` | Reine Indikatoren inkl. Bollinger-Bandlevel/`bollingerPosition` (v0.6.3/0.6.4) und Donchian-Kanal (v0.6.3); Bollinger-Lage seit v0.6.4 als Regelfeld (`bbZScore`, `priceVs*BbPct`), Donchian-Ausbruch seit v0.6.5 (`donchianBreakoutPct`, kanonische Fenster 20/10) |
| `src/backtest/` | Backtest-Engines (legacy/paper/event_replay), Walk-Forward, Monte-Carlo, Trade-Ledger, Indikator-Cache (v0.3.0) |
| `src/forecasts/` | Forecast-Ledger: point-in-time Resolving, Brier-Score, Kalibrierung |
| `src/features/` | Point-in-Time Feature Store (versionierte Featurewerte) |
| `src/perpdata/` | Historische Perpetual-Daten (Funding, Open Interest, Liquidationen) |
| `src/sentiment/`, `src/crossSectional/`, `src/confluence/` | Research-Schicht: strukturiertes Sentiment, Cross-Sectional Ranking, MTF-Konfluenz |
| `src/strategyLifecycle/` | 9-Zustands-Lifecycle-Strategie mit Driftgates (Backtest↔Paper↔Live), n ≥ 100 |
| `src/devilsAdvocate/` | Adversaler Falsifikations-Step (nur defensive Risiko-Wirkung) |
| `src/promptPerformance/` | Prompt-Artefakte, Run-Provenanz, Metriken je Prompt-Version |
| `src/routing/` | LLM-Model-Router (Ollama/OpenAI/Gemini/Claude), Overrides, Turn-Budgets |
| `src/auth/`, `src/lib/` (security) | Auth-Modi, RBAC, Sessions, Rate-Limits, Audit-Sink (durable), Kill-Switch |
| `src/universe/` | Instrument-Universe-Registry (venue-aware) |
| `src/attribution/` | Deterministische Trade-PnL-Attribution |
| `src/executionQuality/` | Venueübergreifendes Execution-Benchmarking (append-only Ledger) |
| `src/db/`, `src/history/`, `src/contracts/` | Drizzle-Schema, Historical Store (append-only OHLCV), Broker-Contracts |
| `src/app/` | Next.js App Router: Dashboard, Operations Center, API-Routen |
| `src/components/` | React-UI (Paper-Trading-Dashboard, Control-Plane, Docs-Viewer) |

### Laufzeit & Infrastruktur

- **Runtime:** Node.js ≥ 20 (Entwicklung/Produuktion), TypeScript strict, Next.js 16 (App Router)
- **Datenbank:** PostgreSQL (Drizzle ORM, append-only/idempotente Migrations in `drizzle/`)
- **Prozesse:** Web-App (Next.js, Port 3369), Mikro-Executor (Regel-Executor, `npm run micro`), Market-Sync (systemd-timer), Watchdog

### Externe APIs & Dienste

| Dienst | Zweck | Zugang |
| --- | --- | --- |
| **Bitunix** (REST + WebSocket) | Krypto-Marktdaten, Paper-Sync, Live-Ausführung (nur hinter Live-Gate) | Öffentliche Endpoints ohne Credential für Marktdaten; Live nur mit expliziten Credentials |
| **Binance / Kraken / Alpaca / IBKR / Yahoo** (Marktdaten-Adaption) | Multi-Venue-Sync für den Historical Store | Öffentliche Endpoints, credential-frei |
| **Ollama** | Lokale LLMs (Default-Provider) | HTTP, `OLLAMA_BASE_URL` |
| **OpenAI-kompatible Endpunkte, Gemini, Claude** | Alternative LLM-Provider (Router) | API-Key je Provider über Secret-Store |
| **PostgreSQL** | Institutionelles Gedächtnis, Audit, Persistenz | `DATABASE_URL` |

### Konfiguration

- Umgebungsvariablen: [`CONFIGURATION.md`](CONFIGURATION.md) (vollständige
  Flag-Referenz mit sicheren Defaults) und `.env.example`.
- Deployment-Units (systemd): `deploy/`.
- Test-/CI-Workflow-Quellen: `docs/ci/` (gespiegelt nach `.github/workflows/`).

## Versionspflege

1. Änderungen zuerst im [`CHANGELOG.md`](CHANGELOG.md) unter `[Unreleased]` dokumentieren.
2. `package.json` (einzige Versions-SSoT) bumpen: Bugfix → Patch, additive
   Funktion → Minor, dokumentierte Breaking Change (0.x) → Minor/Major nach
   Bedarf.
3. Diese Datei (Datum + Version) und die Status-Header der betroffenen
   Doku-Module aktualisieren.
4. `npm run typecheck && npm run lint && npm test && npm run docs:validate`
   grün halten (Pflicht-Checks, siehe [`CONTRIBUTING.md`](CONTRIBUTING.md)).
