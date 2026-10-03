# VERSION — Autonome KI-Trading-Firma

**Kanonische Versions-Metadaten** des Projekts. Alle anderen Versionsverweise
in Code und Doku leiten sich von diesem Stand ab.

| Feld | Wert |
| --- | --- |
| **Version** | `v0.11.0` |
| **Schema** | SemVer, öffentliches `v0.x.x` (0.x = Beta-Phase) |
| **Status** | **BETA — nicht produktionsreif** (Paper-Trading, keine Live-Broker-Garantien) |
| **Beta-Zusage** | Bleibt `0.x`/Beta **unabhängig** vom Funktions- und Ausbau-Stand — Kriterien `B1…B8`: [`docs/BETA_STATUS.md`](docs/BETA_STATUS.md) |
| **Release-Datum** | 2026-10-03 |
| **Quellbasiert** | `package.json` (`version: "0.11.0"`), `src/lib/version.ts` liest die SSoT zur Laufzeit |
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

Die `v0.7.x`-Reihe liefert die **Strategie-Artefakte** selbst (Phase 3 des
Audits). `v0.7.0` legt das Fundament: den reinen Typenvertrag
`src/strategies/types.ts` (03-01) und den Katalog `src/strategies/catalog.ts`
(03-02), der jedes Template **beim Import** validiert — ein kaputtes Template
lässt den Prozess nicht starten. `v0.7.1` (`ema-adx-trend`), `v0.7.2`
(`macd-momentum`) und `v0.7.3` (`rsi-mean-reversion`) liefern je ein Template
mit eigenem Test; jedes ist ein **reines Parameterraster über dem bestehenden
`RuleSpec`-Vertrag** — kein neues Regelfeld, kein neuer Indikator, keine
Engine-Änderung. `v0.7.3` ist dabei das erste Artefakt der Klasse
`mean-reversion` und damit der Nachweis, dass die Klassifikation (ADR-008)
trägt: Erst diese Klasse wird im Regime-Gate tatsächlich gedämpft
(`TREND_UP`/`TREND_DOWN` Faktor 0.5, `RANGE` 1). `v0.7.4` schließt die
Template-Reihe mit den drei verbleibenden Artefakten: `bollinger-squeeze`
(03-06, erste Klasse `breakout`, erstes Template mit `bbZScore` aus 02-02),
`vwap-pullback` (03-07, fachlich ein zustandsloser VWAP-Tages-Bias — kein
Pullback/Reclaim; `4h`/`1d` sind wegen des UTC-Tagesankers ausgeschlossen) und
`donchian-breakout` (03-08, Higher-Timeframe-only `1h`/`4h`, ein Ausbruch pro
Tag, `donchianBreakoutPct` aus 02-03; `entryPeriod` bleibt Snapshot-Definition).
Der Katalog führt damit **alle sechs** geplanten Templates; die drei Templates
wurden gemeinsam als ein Release ausgeliefert (ein Versions-Bump pro PR), die
unabhängige Prüfbarkeit bleibt über die je eigene Testdatei erhalten.

`v0.7.5` schließt den **sicherheitskritischen Übergang** der Phase 3 und damit
die Lücke, die Finding STX-05 beschreibt: `src/strategies/compiler.ts` ist der
**einzige** Aufrufer von `buildRule()` und führt jede Rohform zwingend durch
`sanitizeRuleSpec()` — es gibt keinen zweiten Weg zu einer `RuleSpec`. Der
Compiler liefert `{ok:false}` mit Fehlerstrings (nie einen Wurf, nie einen
Rückfall auf die Rohform), macht Klemmungen als `clamped`-Liste sichtbar
(„`action.stopLossPct: 999 → 20`"), trägt `strategyClass` ausschließlich aus
`template.class` (ADR-008, `unclassified` wird abgelehnt) und hasht die Eingabe
zu einem prozessstabilen `stc1:<sha256>`-Fingerprint (Idempotenz 04-02, Cache
05-04). Die dynamischen Laufzeit-Limits (`ruleWithinRuntimeLimits`) sind
`warnings`, keine Compile-Fehler: Sie hängen an Regime-/VolTarget-/Drawdown-
Faktoren und würden den Fingerprint sonst prozessabhängig machen; erzwungen
werden sie weiterhin im Order-Pfad. `ruleEngine.ts` bleibt **unverändert**.
Der Pflicht-Beweis liegt in `tests/strategies.compiler.security.test.ts`
(26 Tests, u. a. Sanitize-Spy, Ceiling-Klemmung, unbekanntes Feld, fremder
Operator, `SHORT`, fehlendes `requiredFields`, ROLLOUT über alle sechs
Templates).

`v0.7.6` schließt die **Phase 3** ab (03-10, Finding STX-18): Die sechs
Strategie-Artefakte sind jetzt nicht mehr nur kompilierbar, sondern
**vertraglich abgesichert**. `tests/strategies.templates.test.ts` prüft je
Template die Struktur (Params-Raster, `RULE_FIELDS`-Whitelist, Klasse ≠
`unclassified`, `expectedRegimes` ohne `UNKNOWN`, Gate-/Policy-Kontrakt,
Annahmen), die Compiler-Parität (Defaults ohne Klemmung, stabiler
`stc1:`-Fingerprint, `symbol` vom Aufrufer, `sourceRole` `RESEARCH`),
deterministische Positiv-Fixtures (kein totes Template) und
Kurzhistorie-Fixtures (fehlende Lesewerte bleiben inert), je eine
Negativ-Fixture pro Bedingung und Richtung (verletztes Feld, `null`,
Raster-Extremwert) sowie die Katalog-Integrität. Die Engine-↔-Cache-Parität der
Phase-2-Felder (`bbZScore`, `priceVs*BbPct`, `donchianBreakoutPct`) ist als
Regression festgenagelt. `docs/STRATEGY_TEMPLATES.md` wird von
`npm run docs:templates` **aus dem Katalog erzeugt** und im Test byteweise
gegen den Generator geprüft. `ruleEngine.ts`, `sanitizeRuleSpec`,
`indicators.ts`, `indicatorCache.ts` und der Katalog bleiben unverändert.

`v0.8.0` ergänzt das **Schemafundament für versionierte Strategie-Persistenz**
(STX-04-01): `drizzle/2026-10-01_strategy_catalog.sql` und `src/db/schema.ts`
liefern `strategy_definitions` sowie `strategy_versions`, inklusive
Template-/Klassen-/Timeframe-Checks, eindeutigen Fingerprints/Content-Hashes
(`fingerprint`, `content_hash`) und Provenienz (`code_version`,
`template_version`). Migration und `drizzle-kit push` erzeugen für diese beiden
Tabellen dieselbe Struktur; sieben DB-Tests decken Idempotenz, Constraints,
Duplikate und Rollback ab. **Abgrenzung:** Es gibt noch keinen App-Schreib- oder
Lesepfad; der Service aus 04-02 wird benötigt, bevor der Befund STX-06 als
behoben gelten kann. Kein Backfill und keine Änderung an `strategy_lifecycle_*`.

`v0.9.0` macht die **Screening-Matrix zu Jobs** (STX-05-04): `runScreening()`
in `src/screening/runner.ts` fährt `createOrGetRun()` → je Zelle `upsertCells()`
→ optionalen Backtest → Metriken, mit **hartem** `maxCells` (Default 5 000,
Abbruch statt Kürzung), Caps-Prüfung statt Ergebnis-Kappung (`BLOCKED` mit
Grund `caps exceeded`) und I/O-Nebenläufigkeit 4 (max 8) ohne `worker_threads`.
`src/screening/backtestAdapter.ts` bindet ausschließlich
`runMultiAssetBacktest()` an (`SCREENING_BACKTEST_PATH = "multiAsset"`; die
historische Prä-Cache-Messung in `BENCH-BASELINE.md` §6 ergab damals 121,7×
gegenüber `backtestRule()`). Seit `v0.11.0` nutzt auch `backtestRule()` den
Cache; der Screening-Pfad bleibt unverändert auf der Multi-Asset-Engine,
punkt-in-zeit und mit harter Kerzengrenze. `npm run screening` bedient es;
`--dry-run` ist der Default, `--execute` der einzige Weg zu einem echten Lauf.
`backtest_run_id` bleibt `null` — `persistBacktestRun()` braucht einen
`WalkForwardReport`, und ein Einzelzellen-Lauf wäre eine zweite Lauf-Wahrheit.
Gate G6 verlangt weiterhin den verbindlichen 50-Zellen-Pilot. Über einer
Kernstunde wird der Pilot blockiert und der Store-/Adapter-/Engine-Pfad geprüft;
STX-12 ist bereits behoben.

`v0.10.0` eröffnet **Phase 6 (Validator)** mit dem deterministischen
Annahmen-Audit (STX-06-01): `src/strategies/validator/assumptions.ts` prüft
als reine Funktion über injizierte `*Facts`, ob die deklarierten Annahmen
eines Templates (`StrategyTemplate.assumptions`) im konkreten Lauf belegt
sind — elf Prüfungen in fester Reihenfolge (`FEE_NONZERO`,
`SLIPPAGE_NONZERO`, `SPREAD_MEASURED`, `DEPTH_SUFFICIENT`, `WARMUP_MET`,
`TRADES_SUFFICIENT`, `CAPS_RESPECTED`, `LEAKAGE_PROTECTED`,
`INTRADAY_ONLY`, `CHANGE_PCT_SEMANTICS` plus `FILLS_MODELLED`), jede
Evidenz mit Zahl. Unter 30 Trades (`MC_MIN_SAMPLE_TRADES`) liefert der
Audit `UNKNOWN` statt `VIOLATED`; eine kritische Annahme mit `VIOLATED`
**oder** `UNKNOWN` macht das Gesamtergebnis zu `INCONCLUSIVE`, nicht zu
`FAIL` — ein nicht prüfbarer Lauf ist kein Beweis gegen die Strategie.
`assumptionGate()` gibt Metriken (06-02/06-03) nur bei `PASS` frei.
**Abgrenzung:** Overfit-/Robustheits-Messung, Cost-Stress und der Report
mit CLI (06-02…06-04) fehlen noch; der Validator-Agent (06-05) ist der
einzige Schritt mit LLM-Zugriff und bleibt offen.

`v0.10.1` liefert die **zweite** Validator-Stufe (STX-06-02) mit
`src/strategies/validator/overfit.ts`: reine Funktionen über die vorhandenen
Walk-Forward-Strukturen (`CandidateScoreRow`, `FreezeArtifact`,
`HoldoutReport`, `WalkForwardAggregate`) — keine IO, keine Uhr, keine
Kandidatengenerierung. `plateauMetrics()` misst die **Breite** des stabilen
Bereichs (`robustShare`: Kandidaten mit `passedGates` in **allen** Fenstern;
`neverShare`; Median-Rang und Stabilität des gewählten Kandidaten), statt den
Optimum-Punkt zu feiern. `trainOosGap({ is, oos })` urteilt
`gap > 0.5 ⇒ SUSPECT`, `oosSharpe <= 0 ⇒ BROKEN` — **`isSharpe` allein
entscheidet nie**. `multipleTestingWarning(n)` warnt ab 6 Kandidaten und
**blockiert** ab 21 (`n > 20`): Bei 50 Kandidaten ist der beste per Zufall gut.
`holdoutIntegrity()` prüft `holdout.from >= freeze.oosTo`,
`holdout.candidateId === freeze.selectedCandidateId` und den
`candlesHash`-Stand (`CLEAN | CONTAMINATED | UNKNOWN`; `CONTAMINATED` ⇒
`INCONCLUSIVE`). Fehlende Tabellen/Fakten liefern `UNKNOWN` mit Grund — nie
„robust, weil nur ein Kandidat geprüft wurde“.

`v0.10.2` liefert die **dritte** Validator-Stufe (STX-06-03) mit
`src/strategies/validator/stress.ts` und schließt Finding **STX-11** ohne
drittes Kostenmodell: `COST_STRESS_SCENARIOS` definiert die drei
versionierten Szenarien `base` (1× Gebühren, 5 bp Slippage), `double`
(2× Gebühren, 10 bp Slippage) und `triple` (3× Gebühren, 20 bp Slippage;
Bps-Werte als normative Stress-Annahmen dokumentiert, tatsächliche Kosten im
Basislauf prüft 06-01). Schicht 1 (`runInEngineStress()`,
`summarizeStressSweep()`) fährt pro Szenario genau **einen** Walk-Forward-Lauf
mit angepasstem `BacktestEngineConfig` (`feeModel` skaliert,
`slippageModel: "fixed"`, `fixedSlippageBps`; `executionModel` bleibt der des
Referenzlaufs: `"legacy" | "paper" | "event_replay"`). `base` ist
byte-identisch zum Referenzlauf; `slippageModel: "none"` im Referenzlauf wird
fail-closed mit `{ ok: false, errors }` abgewiesen (kein stilles Hochrechnen).
`summarizeStressSweep()` bestimmt `degradationRatio =
OOS-Sharpe(triple) / OOS-Sharpe(base)`, interpoliert `breakevenMultiplier`
linear zwischen den Szenarien (`null` bei `triple.netPnl > 0` ⇒ „hält
mindestens 3×") und vergibt das Verdikt `COST_ROBUST` (`>= 0.6` **und**
`triple.netPnl > 0`), `COST_SENSITIVE` (`[0.3, 0.6)`) oder `COST_DEPENDENT`
(`< 0.3`). Schicht 2 (`runPostHocStress()`) reicht das Trade-Log dünn an
`runMonteCarloSimulation()` mit `stress: { feeMultiplier, slippageMultiplier }`
durch; im kombinierten Report (`buildStressReport()`) stehen `inEngine` und
`postHoc` strikt getrennt. Harte Laufzeit-Bounds:
`DEFAULT_MAX_STRESS_RUNS = 45` (`3 × 3 × 5`), CLI-Flag `--max-runs`
(`parseMaxRunsFlag()`). **Abgrenzung:** Report + CLI (06-04) und der
Validator-Agent (06-05) bleiben offen.

`v0.10.3` liefert die **vierte** Validator-Stufe (STX-06-04) und schließt
Finding **STX-17** (`src/strategies/validator/report.ts` + `persist.ts`):
`buildValidationReport()` ist rein (keine Uhr, keine DB, kein Zufall) und
fällt genau ein Urteil aus `PASS | FAIL | INCONCLUSIVE` über die achtstufige
Kette `ASSUMPTIONS → HOLDOUT_INTEGRITY → DATA_SUFFICIENCY → OOS_POLICY_GATES →
TRAIN_OOS_GAP_AND_PLATEAU → COST_STRESS → MULTIPLE_TESTING → FINAL`. Die erste
Stufe ohne `PASS` entscheidet, alle späteren stehen als `SKIPPED` im
`gates[]`-Protokoll — kein Score, keine Gewichtung; ein `INCONCLUSIVE` wird
nicht durch einen späteren `FAIL` überstimmt, und ein `PASS` entsteht nur,
wenn alle sieben Prüfstufen bestanden sind. Fehlende Vorstufen sind immer
`INCONCLUSIVE`, nie stilles `PASS`. Schwellen kommen aus der SSoT
(`evaluateBacktestGate()`/`DEFAULT_PROMOTION_POLICY`, `MC_MIN_SAMPLE_TRADES`,
`trainOosGap()`/`plateauMetrics()`, `DEFAULT_STRESS_VERDICT_THRESHOLDS`,
`multipleTestingWarning()`); nur für die Plateau-Grenze wurde
`PROMOTION_POLICY_BOUNDS.validationMinPlateauShare = [0, 1]` ergänzt (Default
0.5 am Gate). `aggregateRegimeTrades()` ordnet Trades point-in-time dem letzten
`regime_snapshots`-Eintrag mit `asOf <= Entry` zu, liest ausschließlich
`REGIME_EVAL_LABELS` ohne `UNKNOWN`, schließt `UNKNOWN`/nicht zuordenbare
Trades gezählt aus (**kein `RANGE`-Fallback**, `sharpe` `null` statt `0` unter
der Mindeststichprobe) und lässt `evaluateRegimeOos` unverändert.
`writeValidationEvidence()` schreibt idempotent über `recordEvidence()` aus
`@/strategyLifecycle` (keine eigene Hashfunktion, kein `requestTransition`).
Die CLI `npm run validate:strategy` (`scripts/run-validate-strategy.ts`) fährt
Walk-Forward + 06-01/02/03, schreibt Report (`--out`) und Evidenz (`--no-write`
unterdrückt sie) und endet nur bei `PASS` mit Exit 0 (1 = `FAIL`/
`INCONCLUSIVE`/Laufzeitfehler, 2 = Bedienfehler). **Abgrenzung (Stand v0.10.3):**
06-05 war zu diesem Releasezeitpunkt noch offen und wurde in `v0.10.4` ergänzt.
Die Agent-Funktion gibt nur eine Interpretation by-value zurück; automatische
Persistenz in `detail jsonb` ist nicht verdrahtet.

`v0.10.4` liefert den erklärenden Validator-Agenten (STX-06-05): eine separate
`AgentInterpretation` aus explizit allowlisteten aggregierten Report-Daten,
strenge JSON-Schema-Prüfung und Injection-Grenze bei einem Prompt unter 8 KiB.
`LOCAL_FREE` bleibt cloud-frei; `OPENCODE_FREE` ist opt-in und Best-Effort.
Shadow-Modus ist standardmäßig aktiv. Der Agent kann `result` weder verändern
noch Evidenz schreiben; Provider-/Schema-Ausfälle lassen den Report unverändert.
Eine automatische Speicherung der Interpretation in `detail jsonb` ist nicht
verdrahtet — darüber entscheidet ein künftiger Aufrufer/Persistenzpfad.

`v0.10.5` (STX-07-01) ergänzt das reine Copy-Domänenmodell:
Handlungsabsichts-Typen, SSoT-gestütztes cross-venue Symbol-Mapping,
`FIXED_AMOUNT`/`FIXED_RATIO`/`EQUITY_RATIO` und Leverage-Policy. Es entstehen
noch keine Tabellen, keine Policy-Engine und kein Adapter.

`v0.10.6` (STX-07-02, 2026-10-03) ergänzt die versionierte Copy-Policy
(`cpl1:<sha256>`) und die fail-closed Vorabprüfung gegen Copy-Limits, Spread,
Equity-Verlust, offene Positionen und Hebel. Die additive Migration legt genau
`copy_subscriptions` und `copy_order_links` an: `SIMULATE_ONLY` ist per DB-CHECK
erzwungen, Abonnements starten deaktiviert und doppelte Follower-Intent-Keys
werden unique. Order-Link-Zustände laufen vorwärts; wiederholtes `markFilled`
ist ein No-Op. Ausführung, Receipts und Reconciliation bleiben bei der
bestehenden Execution-Quality-/Broker-Reconciliation-Kette. Die FK-Spalte zur
bestehenden `execution_quality_intents.id` ist TEXT, weil deren tatsächlich
vorhandener Primärschlüssel TEXT ist — ein UUID-FK wäre in PostgreSQL ungültig.

`v0.10.8` (STX-08-02, 2026-10-03) schließt Altlast 3 aus dem Audit-Abgleich:
Der Browser-Doku-Viewer löst `docs/architecture/` und `docs/roadmap/` auf. Der
Existenz-Fallback in `resolveDoc()` (`src/lib/docsCatalog.ts`) sucht zusätzlich
`docs/architecture/${safeBase}` und `docs/roadmap/${safeBase}` — nach
`docs/security/` und vor `docs/archive/`, die bestehenden Prioritäten bleiben
unverändert. Damit sind
[`STRATEGY_STACK.md`](docs/architecture/STRATEGY_STACK.md),
[`PIPELINE_MAP.md`](docs/architecture/PIPELINE_MAP.md),
[`DB_SCHEMA.md`](docs/architecture/DB_SCHEMA.md),
[`INTEGRATION_POINTS.md`](docs/architecture/INTEGRATION_POINTS.md) und der
ADR-Log [`DECISIONS.md`](docs/roadmap/DECISIONS.md) (ADR-008…ADR-010) im Viewer
unter `/docs/<Datei>.md` lesbar. Die dreistufige Auflösung bleibt: kein
`docs/**`-Walk, kein Pfad-Parameter; der Pfad entsteht weiterhin nur aus
`basename()` + fester Liste. Parent-Referenzen (`../…`) werden im
Existenz-Fallback zusätzlich abgewiesen, `DOCS_CATALOG` bleibt unverändert
(keine neuen Slugs — ein Katalogeintrag würde die Pfadform auflösen).
`0.10.7` bleibt frei: 08-01 wurde als `[Unreleased]`-Nachtrag ohne Bump
nachgereicht.

`v0.10.9` (STX-08-03, 2026-10-03) räumt Altlast 1 aus dem Audit-Abgleich ab:
Die Strategieklassen des Signal-Decay-Pfads stehen nicht mehr als vier
unabhängige Literalstellen im Code, sondern werden aus der Single Source of
Truth `STRATEGY_CLASSES` ([`src/lib/marketRegime.ts`](src/lib/marketRegime.ts),
ADR-008) abgeleitet — `STRATEGY_CLASS_KEYS = [...STRATEGY_CLASSES,
"unclassified"]`. `isStrategyClassKey()`, die lokale Closure `classOf()`
(Risk-Config-Overrides `sdc.<klasse>.<feld>`) und `metricClass()` im
Laufzeitpfad prüfen über einen Lookup gegen diese Liste; der Token-Alias
`mean_reversion` → `mean-reversion` bleibt als Format erhalten. Typ
`StrategyClassKey`, Reihenfolge und Werte sind unverändert, es gibt keinen
Verhaltenswechsel. Ein neuer Quelltext-Wächter in
[`tests/adrVocabulary.test.ts`](tests/adrVocabulary.test.ts) verbietet
Klassennamen als Vergleichs- oder Listenliteral in
[`src/lib/signalDecay.ts`](src/lib/signalDecay.ts) und
[`src/lib/signalDecayRuntime.ts`](src/lib/signalDecayRuntime.ts); er baut sein
Muster aus der SSoT und greift damit auch für eine künftig per ADR ergänzte
Klasse. Einzige verbleibende, dokumentierte Literalstelle sind die
append-only DB-CHECKs `positions_strategy_class_check` und
`signal_decay_events_class_check`
([`drizzle/2026-09-22_signal_decay.sql`](drizzle/2026-09-22_signal_decay.sql)).
`DEFAULT_CLASS_POLICIES`, Env-Namen und Schwellen bleiben unangetastet.

`v0.11.0` (STX-08-04, PR #221, 2026-10-03) stellt `backtestRule()` auf den bestehenden
`IndicatorCache` um: `buildIndicatorCache(candles)` läuft einmal vor der
Backtest-Schleife; pro Bar liefert `snapshotFromCache()` den Snapshot. Der
wachsende Präfix-Slice entfällt. Die vor der Änderung festgehaltenen Golden-
Hashes (3 Symbole × 2 Timeframes; Trades, Kennzahlen und Snapshots) bleiben
identisch. `executionModel` bleibt `"legacy"`; `sanitizeRuleSpec`,
`RULE_FIELDS`, `RULE_CEILINGS`, `RULE_ALLOWED_SIDE` und `RuleAction` wurden nicht
verändert.

Der vollständige Paritätstest prüft jedes aktuelle `RULE_FIELDS`-Feld exakt für
576 Bars über drei Symbole und zwei Timeframes. Zusätzliche Fixtures fixieren
`atrPct` bei ATR = 0 als `null` (statt des bisherigen Cache-Werts `0`),
`vwapPct` bei weniger als zwei Bars am UTC-Tag, `spreadPct`/`bookDepthUsd`, die
Bollinger-Nullfälle und `donchianBreakoutPct`. Die ATR-Korrektur vereinheitlicht
den gemeinsam genutzten Engine-Cache mit dem bereits bestehenden Direktpfad;
`atrPct eq 0` feuert bei flachen Kerzen daher fail-closed.

**Performance-Nachweis:** Die Originalreihe der echten `HistoricalStore`-
Baseline ist in diesem Checkout nicht vorhanden. Als ergänzende, nicht direkt
mit ihr vergleichbare Kontrollmessung wurde deshalb eine deterministische
synthetische 1h-Reihe mit 17 520 Bars sowohl mit dem alten Direktcode als auch
mit dem Cache-Pfad gemessen: **20 253,6 ms → 64,5 ms Median (314,1×)** bei
identischen Backtest-Ergebnissen. Originale Messwerte und Methode bleiben in
[`BENCH-BASELINE.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)
als Folgemessung dokumentiert.

`v0.11.0` enthält außerdem den bereits implementierten Copy-Engine-Lauf aus
07-03 (PR #215), zunächst unter `[Unreleased]` dokumentiert und mit dem
08-01-Nachtrag in diesen Release übernommen: Bitunix-Leader, `SIMULATE_ONLY`-
Follower ausschließlich auf dem Paper-Ledger, Baseline-/Heartbeat-Gates und
`npm run copy:paper`. Details und Grenzen stehen im Changelog.

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
32 Prompts, Releases `v0.6.0` … `v0.11.1`) **beendet die Beta-Phase nicht**.
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
| `src/strategies/` | **Neu seit v0.7.0:** versionierte Strategie-Artefakte — `types.ts` (Vertrag, reine Typen) und `catalog.ts` (eine Registry, Validierung beim Import); `templates/` mit `ema-adx-trend` (v0.7.1), `macd-momentum` (v0.7.2), `rsi-mean-reversion` (v0.7.3, Klasse `mean-reversion`) sowie `bollinger-squeeze` (Klasse `breakout`), `vwap-pullback` und `donchian-breakout` (alle v0.7.4) — **alle sechs** geplanten Templates; seit v0.7.5 `compiler.ts` als einziger Aufrufer von `buildRule()` + `sanitizeRuleSpec()` (STX-05/03-09); seit v0.7.6 vertraglich abgesichert über `tests/strategies.templates.test.ts` und dokumentiert in der generierten [`docs/STRATEGY_TEMPLATES.md`](docs/STRATEGY_TEMPLATES.md) (03-10); seit v0.10.0 `validator/assumptions.ts` — deterministischer Annahmen-Audit vor jeder Metrik-Auswertung (STX-06-01); seit v0.10.1 `validator/overfit.ts` — Plateau (`robustShare`), IS/OOS-Lücke, Multiple-Testing-Warnung und Holdout-Integrität (STX-06-02); seit v0.10.2 `validator/stress.ts` — zweischichtiger Cost- & Slippage-Stress-Runner (`runInEngineStress`, `summarizeStressSweep`, `runPostHocStress`; [`docs/STRATEGY_VALIDATION.md`](docs/STRATEGY_VALIDATION.md), STX-06-03) |
| `src/strategyLifecycle/` | 9-Zustands-Lifecycle-Strategie mit Driftgates (Backtest↔Paper↔Live), n ≥ 100 |
| `src/devilsAdvocate/` | Adversaler Falsifikations-Step (nur defensive Risiko-Wirkung) |
| `src/promptPerformance/` | Prompt-Artefakte, Run-Provenanz, Metriken je Prompt-Version |
| `src/routing/` | LLM-Model-Router (Ollama/OpenAI/Gemini/Claude), Overrides, Turn-Budgets |
| `src/auth/`, `src/lib/` (security) | Auth-Modi, RBAC, Sessions, Rate-Limits, Audit-Sink (durable), Kill-Switch |
| `src/universe/` | Instrument-Universe-Registry (venue-aware) |
| `src/attribution/` | Deterministische Trade-PnL-Attribution |
| `src/executionQuality/` | Venueübergreifendes Execution-Benchmarking (append-only Ledger) |
| `src/copy/` | Reines Copy-Domänenmodell, versionierte fail-closed Policy und idempotente `copy_order_links` (SIMULATE_ONLY, kein Live-Pfad) |
| `src/db/`, `src/history/`, `src/contracts/` | Drizzle-Schema (seit v0.8.0 auch `strategy_definitions`/`strategy_versions`), Historical Store (append-only OHLCV), Broker-Contracts |
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
