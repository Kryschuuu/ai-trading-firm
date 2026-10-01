# Strategie-Stack — Single Source of Truth (SSoT)

> **Status:** Ist-Zustand · **Stand:** 2026-10-01 · **Code-Version:** v0.8.0 (Beta)
> **Verbindliche Referenz:** `docs/architecture/STRATEGY_STACK.md`  
> **Roadmap:** `../audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`  
> **Vokabular-Entscheidungen:** [ADR-008 … ADR-010](../roadmap/DECISIONS.md) (Strategieklasse, Regime, Universe)

## Zweck

Diese Karte fixiert den **Ist-Zustand** des Strategie-Stacks — welcher Baustein wofür
zuständig ist und wo neue Arbeit hingehört. Sie korrigiert die Fehleinschätzung aus
dem Ausbaudokument (Feature Store = 3 Features, kein „zentraler Layer"; Regime =
bereits 5+1; Strategieklasse = bereits vorhanden; Alpaca-WS = nicht vorhanden).

Bestandskarte, keine zweite Implementierung. Die **Entscheidungen** dahinter (Strategieklasse, Regime,
Universe) stehen als ADR-008 … ADR-010 in [`../roadmap/DECISIONS.md`](../roadmap/DECISIONS.md) — diese Karte
verortet sie nur. Details zu Datenflüssen: `PIPELINE_MAP.md`, Tabellen: `DB_SCHEMA.md`,
Erweiterungspunkte: `INTEGRATION_POINTS.md`.

## 1. Komponenten-Tabelle — SSoT je Thema

| Thema | SSoT | Nicht hier |
|---|---|---|
| Rule-Felder (Whitelist) | `src/lib/ruleFieldCatalog.ts` | — |
| Rule-Ausführung + Sanitize | `src/lib/ruleEngine.ts` | nicht im Strategie-Modul |
| Rule-Timeframes | `src/lib/marketdata/timeframes.ts` (`SUPPORTED_TIMEFRAMES`); `RULE_ALLOWED_TIMEFRAMES` in `ruleEngine.ts` leitet sich ab | kein zweites Vokabular (STX-01) |
| Indikator-Formeln | `src/lib/indicators.ts` (Band-/Donchian-Level + `donchianBreakoutPct`); bestehender Backtest-Cache: `src/backtest/indicatorCache.ts` (`bbZScore`/`priceVs*BbPct` seit 02-02, `donchianUpper` seit 02-03) | Keine zweite Formel-/Cache-Wahrheit; Erweiterungen nur additiv |
| Strategieklasse | `src/lib/signalDecay.ts` (`STRATEGY_CLASS_KEYS`) | nicht neu in `src/strategies/` (ADR-008) |
| Regime | `src/lib/marketRegime.ts` (`MarketRegime`) + `regime_snapshots` | kein zweites Vokabular (ADR-009) |
| Regime-Auswertung | `src/lib/regimeEvaluation.ts` | misst den Markt, nicht die Strategie (ADR-009) |
| Universe-Mitgliedschaft | Snapshot: `crossSectional/types.ts` (`EligibilityConfig`); Registry-Policy: `src/universe/policy.ts` | keine zweite Eligibility-Spec (ADR-010) |
| Cross-Sectional-Ranking | `src/crossSectional/*` | keine neue Spec (ADR-010) |
| Portfolio-Gewichte / Exposure | `src/portfolio/*` (`optimize.ts`, `volatilityTargeting.ts`) | Universe-Gewichte nur als `PortfolioConstruction` (ADR-010, nicht gebaut) |
| Scanner-Faktoren | `src/scanner/scanner.config.json` (**14 aktive**) | nicht die Dateiliste |
| Feature Store | `src/features/*` (3 Features) | nicht „zentraler Layer" |
| Backtest / WF / MC | `src/backtest/*` | keine zweite Engine |
| Kostenmodell | `BacktestEngineConfig.feeModel` + `MonteCarloStressConfig` | kein drittes |
| Strategie-Template-Vertrag | `src/strategies/types.ts` (`StrategyTemplate`) | — |
| Strategie-Templates (Katalog) | `src/strategies/catalog.ts` (`STRATEGY_TEMPLATES`, Import-Zeit-Validierung) + `src/strategies/templates/*.ts` (eine Datei pro Artefakt) | keine zweite Template-Liste; Workshop-UI/CLI/Tests lesen hier |
| Strategie-Versionen (Schema, STX-04-01) | `strategyDefinitions`/`strategyVersions` in `src/db/schema.ts` + `drizzle/2026-10-01_strategy_catalog.sql` (`v0.8.0`) | noch kein App-Schreib-/Lesepfad; folgt in 04-02 |
| Screening-Matrix + Persistenz (STX-05-01…03) | `src/screening/{types,config,priority,matrix,keys,store}.ts` + `strategy_screening_runs`/`strategy_market_results` | eigene Run-/Zelltabellen, kein Universe-Ergebnis in `backtest_runs`; Runner/CLI folgen in 05-04 |
| Strategie-Template-Doku | `docs/STRATEGY_TEMPLATES.md` (**generiert** aus dem Katalog via `npm run docs:templates`) | keine handgepflegte zweite Tabelle; der Vertragstest vergleicht sie byteweise mit dem Generator |
| Lifecycle + Evidenz | `src/strategyLifecycle/*` | — |
| Symbol-SSoT | `src/symbols/normalize.ts` | kein String-Replace |
| Fill-Reconciliation | `src/brokers/reconciliation.ts` + `src/executionQuality/` | kein Copy-Reconciler |
| Broker-WS | nur `src/brokers/bitunix/ws.ts` | Alpaca hat **keinen** |

### Erläuterungen (Ist-Zustand, stichprobenweise verifiziert)

- **Rule-Felder:** `src/lib/ruleFieldCatalog.ts` exportiert `RULE_FIELDS` (Whitelist, 25 Felder), `RULE_FIELD_LABELS` (Workshop-UI) und `RULE_FIELD_SCHEMA_HINTS` (Einheiten/Beispiele für das LLM-Schema). `src/lib/ruleEngine.ts` re-exportiert und nutzt sie in `sanitizeRuleSpec()`. Keine zweite Whitelist. Seit 02-02 (`v0.6.4`): `bbZScore`, `priceVsUpperBbPct`, `priceVsLowerBbPct` — die Lage im Bollinger-Band (20/2σ, `BOLLINGER_PERIOD`/`BOLLINGER_MULT`) neben der Breite `bbwPct`; Einheiten, `null`-Semantik und der „Squeeze → Breakout“-Workflow stehen in [BACKTESTING.md §1.2](../BACKTESTING.md#12-bollinger-bandlage-stx-02-02-v064). Seit 02-03 (`v0.6.5`): `donchianBreakoutPct` = Abstand zum Hoch der **vorigen** 20 Kerzen (ohne Signalkerze), marktneutral in Prozent — Details in [BACKTESTING.md §1.3](../BACKTESTING.md#13-donchian-ausbruch-stx-02-03-v065).
- **Rule-Ausführung:** `src/lib/ruleEngine.ts` enthält `sanitizeRuleSpec`, `compileRuleSpec` (liefert `CompiledRule.evaluate`), `buildSnapshotFromCandles`, `backtestRule`, `RULE_CEILINGS`, `RULE_ALLOWED_TIMEFRAMES`. Kein Import von LLM-Modulen (bewusst isoliert).
- **Rule-Timeframes (STX-01, v0.6.2):** `src/lib/marketdata/timeframes.ts` exportiert `SUPPORTED_TIMEFRAMES` (zehn Werte `1m … 5d`), `SUPPORTED_TIMEFRAME_MS` und `isSupportedTimeframe`; der Historical Store re-exportiert sie. `RuleWindow.timeframe` ist ein `SupportedTimeframe`, `RULE_ALLOWED_TIMEFRAMES` (`ruleEngine.ts`) und `RULE_LLM_SCHEMA` leiten sich daraus ab, die Workshop-UI liest dieselbe Liste. Der Mikro-Executor wertet nur Regeln bis zu seinem Ausführungsintervall aus (Default `1h`; `ruleTimeframeBlockReason` in `src/lib/microExecutor.ts`) und weist längere sichtbar ab. `vwapPct` ist auf `1d`/`5d` immer `null`. Tabelle: [BACKTESTING.md §1.1](../BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062).
- **Indikatoren:** `src/lib/indicators.ts` = reine Formeln (`ema`, `rsi`, `macd`, `adx`, `atr`/`atrPct`, `bollingerBandWidthPct`, `sessionVwap`); seit 02-01 (`v0.6.3`) auch `bollingerBands` (SMA ± mult·Populations-σ, `width`/`bandwidthPct` als Bruch, exakt BBW-paritätsgleich) und `donchianChannel` (High/Low der **vorherigen** entry-/exit-Perioden, ohne Signalkerze; HTF-Mindest-Timeframe in 03-08). Neue Parameter geklemmt; fehlende Werte = `null`. Seit 02-02 (`v0.6.4`) ist das Bollinger-Band über `bollingerPosition()` an die Regel-Felder `bbZScore`/`priceVsUpperBbPct`/`priceVsLowerBbPct` angeschlossen, seit 02-03 (`v0.6.5`) der Donchian-Kanal über `donchianBreakoutPct()` (`(close / Kanalhoch − 1) · 100`, Kanalhoch = Hoch der **vorigen** 20 Kerzen) — jeweils in **beiden** Snapshot-Pfaden (`buildSnapshotFromCandles` und `src/backtest/indicatorCache.ts`), mit feldweisem Paritätstest und Golden-Hash für unveränderte Bestandsläufe. Die Fensterlänge (20/10, `DONCHIAN_ENTRY_PERIOD`/`DONCHIAN_EXIT_PERIOD`) ist Snapshot-Definition, kein Regelfeld; Template 03-08 nutzt den kanonischen Default und dokumentiert eine andere Periode als bekannte Grenze (06-02). Phase 2 ist damit fachlich abgeschlossen, offen bleibt nur der optionale Feature-Store-Slice 02-04.
- **Strategieklasse:** `src/lib/signalDecay.ts` definiert `STRATEGY_CLASS_KEYS = ["mean-reversion", "trend", "breakout", "unclassified"]` und `DEFAULT_CLASS_POLICIES`. `StrategyClass` (drei Werte, Liste `STRATEGY_CLASSES`) stammt aus `src/lib/marketRegime.ts`. Regeln tragen keine Klasse; zur Laufzeit wird sie aus dem Mission-Template abgeleitet (`strategyClassOfTemplate`). Verbindlich: ADR-008 (Klasse deklarieren, `unclassified` ist kein Template-Status, keine neue Klasse). `src/strategies/` enthält **keine** eigene Klassenliste — der Katalog liest `STRATEGY_CLASS_KEYS` (Wächter: `tests/adrVocabulary.test.ts`).

- **Strategie-Templates (Phase 3, 03-01/03-02 `v0.7.0`, 03-03 `v0.7.1`, 03-04 `v0.7.2`, 03-05 `v0.7.3`, 03-06/03-07/03-08 `v0.7.4`):** `src/strategies/types.ts` definiert den Vertrag `StrategyTemplate` (deklarierte `class: StrategyClassKey`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes`, `requiredFields`, `params`, `assumptions`, `expectedRegimes` und einen Builder `buildRule(params) => RuleSpecInput` als **reine Funktion der Parameter** — STX-05: kein `ctx`, kein Marktdatenzugriff). `src/strategies/catalog.ts` ist die **einzige** Template-Registry: `STRATEGY_TEMPLATES` führt **eine Zeile pro Datei** unter `src/strategies/templates/` (seit 03-03: `ema-adx-trend` — Trendfolge long über `trend`/`priceVsEma50Pct`/`adx14`/`volumeRatio`, Klasse `trend`, Timeframes `1h`/`4h`; seit 03-04: `macd-momentum` — `macdHist gt 0` als einziges Vorzeichen-Signal, `priceVsEma50Pct` als **skalenfreier** Ersatz für jede Magnitude-Frage (der Wert steht in Preiseinheiten), `adx14` als Richtungsbestätigung, dieselbe Klasse und Timeframes; seit 03-05: `rsi-mean-reversion` — **erste Klasse `mean-reversion`**, `rsi14 lte rsiOversold` als Überdehnung, `priceVsEma21Pct lte -ema21GapPct` als Abstand zum Mittel und **`adx14 lte adxMax` als Seitwärts-Deckel** (ohne ihn wäre es ein „Catching the falling knife"-System), Timeframes `15m`/`1h`/`4h`, `expectedRegimes: ["RANGE"]`; bewusst ohne `bbZScore` — die normalisierte Metrik hängt an 02-02 und gehört zu 03-06. Erst diese Klasse wird im Regime-Gate tatsächlich gedämpft (`TREND_UP`/`TREND_DOWN` Faktor 0.5, `RANGE` 1), das Template **nutzt** das Gate und verändert es nicht; seit 03-06 (`v0.7.4`): `bollinger-squeeze` — erstes Template mit `class: "breakout"` und dem neuen Phase-2-Feld `bbZScore`, Timeframes `1h`/`4h`, `expectedRegimes: ["RANGE", "TREND_UP"]`, Details in §1.1; seit 03-07 (`v0.7.4`): `vwap-pullback` — fachlich ein zustandsloser VWAP-Tages-Bias long, ausdrücklich **keine** Pullback-/Reclaim-Sequenz, Timeframes `5m`/`15m`/`1h`, `expectedRegimes` `TREND_UP`; seit 03-08 (`v0.7.4`): `donchian-breakout` — Higher-Timeframe-Ausbruch über dem Hoch der **vorigen** 20 Kerzen (`donchianBreakoutPct` aus 02-03, kein Look-ahead) mit ADX- und Volumenbestätigung, höchstens **ein** Ausbruch pro Tag (`maxExecutionsPerDay: 1`, Cooldown 720 Minuten), Timeframes `1h`/`4h`, `expectedRegimes` `TREND_UP`/`RANGE`; `entryPeriod` (20) ist Snapshot-Definition und **kein** Regelfeld), `STRATEGY_TEMPLATE_IDS` als geschlossene Union, `validateTemplate()` (fail-closed: ID-Format, Version, Klasse ungleich `unclassified`, Timeframe-Allowlist, `RULE_FIELDS`-Whitelist, Parametergrenzen, Builder-Determinismus, `side` nur LONG, `RULE_CEILINGS`, `expectedRegimes` ohne `UNKNOWN`) und `assertTemplatesValid()` **beim Import** — ein kaputtes Template lässt den Prozess nicht starten. Der Katalog sanitized nichts: `sanitizeRuleSpec()` bleibt die einzige legale Transformation der Builder-Rohform, und seit `v0.7.5` ruft sie ausschließlich `src/strategies/compiler.ts` auf (§1.2). Keine zweite Template-Liste in UI, Seed, CLI oder Tests, kein zweiter Aufrufer von `buildRule()`.
- **Regime:** `src/lib/marketRegime.ts` definiert `MarketRegime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL" | "CRASH"` plus `UNKNOWN` als `MarketRegimeLabel` (5+1). Persistenz: Tabelle `regime_snapshots` (`src/db/schema.ts`, `src/lib/regimeSnapshotStore.ts`). Kein zweites Vokabular (ADR-009); die `VolatilityRegime`-Typen (`adaptiveRisk.ts`, `src/portfolio/types.ts`, `src/scanner/types.ts`) sind Volatilitäts-Stufen, kein Markt-Regime.
- **Regime-Auswertung:** `src/lib/regimeEvaluation.ts` = reine Auswertung persistenter Snapshots (Stabilität, Transitionen, Coverage, Markt-Forward-Returns je Regime — keine Strategie-Kennzahlen), kein IO.
- **Universe-Mitgliedschaft:** drei Filterstufen mit je eigenem Zweck — Registry-Ausschluss-Policy (`src/universe/policy.ts`, `policy.default.json`), Scanner-Trichter (`checkEligibility` in `src/scanner/filters.ts`) und Snapshot-Membership für Cross-Sectional (`EligibilityConfig` in `src/crossSectional/types.ts`, angewendet in `universe.ts`). Für Universe-Strategien gilt die dritte; keine vierte Stufe, keine zweite Eligibility-Spec (ADR-010).
- **Cross-Sectional-Ranking:** `src/crossSectional/*` = Momentum-Horizonte, Winsorize, z-Score, Composite, Rang/Perzentil, Provenance. Keine zusätzliche Spec-Datei.
- **Scanner-Faktoren:** `src/scanner/scanner.config.json` (versioniert, `version: 2`) konfiguriert **14 aktive** Faktoren: `liquidity`, `spread`, `atr`, `volatility`, `momentum`, `trend`, `volumeRatio`, `rsi`, `drawdown`, `correlation`, `news`, `funding`, `openInterest`, `execution`. Implementierung: `src/scanner/factors/*` (17 Dateien: 15 Faktor-Module — 14 aktive plus `crossSectionalMomentum` als Diagnose — sowie `helpers.ts` und `index.ts`). SSoT ist die Config, nicht die Dateiliste.
- **Feature Store:** `src/features/*` = Registry, Materialisierung, PIT-Query, Validierung. Aktueller Slice (RMA-P6-01): 3 Features `scanner.rsi`, `scanner.atr`, `scanner.atr_band` (`src/features/definitions.ts` `FEATURE_IDS`). Kein „zentraler Layer", der Scanner/Backtest ersetzt — zusätzlicher Lesepfad.
- **Backtest / WF / MC:** `src/backtest/*` = `engine.ts`, `portfolio.ts`, `simulator.ts`, `walkforward.ts`, `montecarlo.ts`, `indicatorCache.ts`, `tradeLedger.ts`, `runStore.ts`, etc. Keine zweite Engine.
- **Kostenmodell:** `BacktestEngineConfig.feeModel` (`src/backtest/types.ts` `{ makerFee, takerFee }`) + `MonteCarloStressConfig` (`src/backtest/montecarlo.ts` `{ feeMultiplier, slippageMultiplier }`). Kein drittes Modell.
- **Lifecycle + Evidenz:** `src/strategyLifecycle/*` = 9 Zustände (`states.ts`), Drift-Gates (`drift.ts`), Evidenz (`evidence.ts`), Order-Gate, Policies, Service.
- **Symbol-SSoT:** `src/symbols/normalize.ts` = `tryNormalizeVenueSymbol`, `normalizeVenueSymbol`, Venue-Profile. Kein String-Replace an anderer Stelle.
- **Fill-Reconciliation:** `src/brokers/reconciliation.ts` + `src/executionQuality/` (`capture.ts`, `reconcile.ts`, `model.ts`, `store.ts`). Kein Copy-Reconciler.
- **Broker-WS:** Nur `src/brokers/bitunix/ws.ts` existiert. `src/brokers/alpaca/` enthält keinen WS-Client (Alpaca hat **keinen** WS in diesem Repo).

### 1.1 Bollinger-Squeeze (STX-03-06, v0.7.4)

`src/strategies/templates/bollinger-squeeze.ts` liefert eine reine Parameterfunktion
und ist einmalig im Katalog registriert. Die Rohform bleibt `RuleSpecInput`:
Symbol und gewählten unterstützten Timeframe setzt der Aufrufer, danach ist
`sanitizeRuleSpec()` Pflicht. Keine Engine-/Indikator-/Cache-Änderung.

| Parameter | Default | Bereich | Schritt | Feldbezug |
|---|---|---|---|---|
| `bbwMaxPct` | 6 % | 2…15 | 0,25 | `bbwPct` |
| `bbZScoreMin` | 0,5 σ | 0…3 | 0,1 | `bbZScore` |
| `adxMin` | 22 | 15…35 | 1 | `adx14` |
| `volumeRatioMin` | 1,2× | 0,9…3 | 0,05 | `volumeRatio` |
| `stopLossPct` | 4 % | 1…12 | 0,5 | `atrPct` (nur Risikodoku) |
| `takeProfitRR` | 2,5× | 1…5 | 0,25 | kein eigenes Regelfeld; Pflicht-`mapsTo: atrPct` wie 03-03…03-05 |

Die vier Feldvergleiche sind `bbwPct lte bbwMaxPct`, `bbZScore gte bbZScoreMin`,
`adx14 gte adxMin`, `volumeRatio gte volumeRatioMin` mit `logic: "all"`.
Die Bandbreitenschwelle ist **nicht marktübergreifend**, sondern markt-,
timeframe- und regimeabhängig. 6 % ist ein **unvermessener Startwert**:
06-01/06-02 prüft die 20. Perzentile über die letzten 200 geschlossenen Kerzen
gegen den Store (`1h`/`4h` separat), vor Live-Einsatz. Keine dynamische
Perzentilrechnung im Builder.

**σ-Semantik:** `bbZScore = (close − middle) / σ`, `upper = middle + 2·σ` ⇒
bei `close == upper` gilt `z = 2`, nicht ungefähr 1,4. Default 0,5 bedeutet
`close >= middle + 0,5·σ`, also ein **frühes Setup über der Bandmitte**,
keinen bestätigten Bruch der oberen Kante. `priceVsUpperBbPct gte 0` wäre ein
alternativer Kantenfilter (bei σ > 0 äquivalent zu `bbZScore gte 2`), nicht
zum Default 0,5; beide werden nicht kombiniert, bei null gibt es keinen Ersatz.

Die Annahmen dokumentieren die bewusste **Snapshot-Vereinfachung**: alle vier
Filter auf derselben geschlossenen Kerze, kein „vorher eng, jetzt weit“-Nachweis.
Die Signalkerze steckt im Band und kann es bereits weiten. Schlusskurs-Fill
nach Erkennung am Kerzenschluss ist im Live-Pfad eine kritische Latenzannahme.
Der Test `tests/strategies.bollingerSqueeze.test.ts` hält diese Grenzen sowie
Vertrag, Default < 2 und den gesamten Parameterraum ohne Klemmung fest.

### 1.2 Compiler-Kette (STX-03-09, v0.7.5)

`src/strategies/compiler.ts` ist der **einzige** Aufrufer von `buildRule()` und
damit der sicherheitskritische Übergang des Strategie-Stacks. Die Kette ist
geschlossen und in dieser Reihenfolge erzwungen:

```
Template (Katalog) → buildRule(params) → sanitizeRuleSpec() → RuleSpec
                     └─ ruleWithinRuntimeLimits(spec) → warnings
```

| Schritt | Was passiert | Warum genau hier |
|---|---|---|
| 1 | `getTemplate(templateId)` | unbekannte ID ⇒ Fehler, nie ein Default |
| 2 | `class !== "unclassified"` | ADR-008: die Klasse ist eine Fachaussage, kein Voreinstellungswert |
| 3 | `timeframe ∈ template.supportedTimeframes` | ein Artefakt trägt nur seine geprüften Takte |
| 4 | Parameter: fehlend ⇒ `default`, unbekannte Keys/Raster-Verstöße ⇒ Fehler | das Raster ist die einzige erlaubte Parametrisierung |
| 5 | `buildRule(params)` **im `try`** | ein werfender Builder ist `{ok:false}`, kein Prozessabbruch |
| 6 | Builder-Ausgabe erneut prüfen: Whitelist, `side`, `maxConditions`, `requiredFields` | der Builder darf sich nicht außerhalb der Template-Bounds bewegen |
| 7 | `symbol` + `timeframe` vom **Aufrufer** einsetzen | das Template kennt weder Instrument noch Ausführungstakt |
| 8 | **`sanitizeRuleSpec()`** | einzige legale Transformation der Rohform — unbekannte Felder, fremde Operatoren, `SHORT` und Werte außerhalb `RULE_CEILINGS` fallen hier |
| 9 | `sourceRole`: `RESEARCH` (oder ausdrückliches `CEO`-Votum), nie `MANUAL` | Templates sind Forschungsartefakte |
| 10 | `ruleWithinRuntimeLimits(spec)` | siehe unten: `warnings`, keine Compile-Fehler |

**Der Pflichtschritt 8 ist nicht umgehbar:** Es gibt keine zweite
Konstruktionsstelle einer `RuleSpec`. Ein Sanitize-Fehler wird `{ok:false}` mit
den Fehlerstrings — **kein** Rückfall auf die Rohform. Beweis:
`tests/strategies.compiler.security.test.ts` (Spy + Sentinel-Identität,
Ceiling-Klemmung, unbekanntes Feld, fremder Operator, `SHORT`, fehlendes
Pflichtfeld, Fingerprint-Stabilität, ROLLOUT über alle sechs Templates).

**`clamped: string[]`** macht die Klemm-Differenz sichtbar
(„`action.stopLossPct: 999 → 20`“). Ein Template, das **ständig** klemmt, ist
kaputt — 03-10 und 06-01 lesen diese Liste, statt dem stillen Erfolg des
Sanitizers zu vertrauen.

**`fingerprint`** = `stc1:<sha256>` über
`canonicalJson({ templateId, version, params, timeframe, symbol, codeVersion })`
(Muster: `src/strategyLifecycle/evidence.ts`). Sortierte Keys, kein `Date.now()`,
keine Objekt-Reihenfolge — Idempotenz (04-02) und Cache (05-04) hängen daran.
Eine andere `codeVersion` (Default `APP_VERSION`) ergibt einen anderen Hash.

**`strategyClass` ist immer `template.class`** (ADR-008) — die Klasse gelangt
aus dem Artefakt in `BacktestEngineConfig.signalDecay.strategyClass` und in die
Screening-/Report-Typen. Eine zweite Klassenquelle (Namensmuster, Aufrufer)
existiert nicht.

**Laufzeit-Limits sind `warnings`.** `ruleWithinRuntimeLimits()` liest die
**marktabhängigen** Limits (`getLimits()` = Basis-Limit × Regime-/VolTarget-/
Drawdown-Faktor). Würden sie das Compile-Ergebnis bestimmen, wäre derselbe Input
je nach Marktlage gültig oder ungültig — der Fingerprint wäre nicht
prozessstabil, und die Werkseinstellung (`takeProfitRR = 1.5`) würde fünf der
sechs Templates dauerhaft blockieren. Erzwungen wird die Einhaltung weiterhin im
Ausführungspfad (`riskGateRule` im Makro-Zyklus, Sizing/`validateOrder` bei der
Order). `ok:true` heißt: sicher geklemmt und statisch zulässig — nicht „passt
gerade in die aktuelle Marktlage“.

**`exportTemplates()`** kompiliert alle Katalog-Templates mit Default-Params
über alle `supportedTimeframes` (flache Liste Template × Takt) — ohne DB, ohne
Netz, ohne Mutation; die Rollout-Probe für 03-10/06-01.

### 1.3 Template-Vertragstests + generierte Doku (STX-03-10, v0.7.6)

`tests/strategies.templates.test.ts` (60 Tests, DB-/LLM-/netzfrei) ist die
**Abnahme von Phase 3** und prüft je Template:

* **Struktur:** `validateTemplate() === []`, Params `min ≤ default ≤ max` auf dem
  `step`-Raster, `requiredFields`/`mapsTo` ⊆ `RULE_FIELDS`, Klasse ≠
  `unclassified` (ADR-008), Timeframes nicht leer/duplikatfrei/⊆
  `SUPPORTED_TIMEFRAMES`, `expectedRegimes` ohne `UNKNOWN` (ADR-009),
  `regimeGateFactor(regime, class)` + `DEFAULT_CLASS_POLICIES[class]` für alle
  fünf Regimes, eindeutige Annahmen mit ≥ 1 × `critical`.
* **Compiler-Parität:** Defaults ⇒ `{ok:true}` **ohne** `clamped`, stabiler
  `stc1:`-Fingerprint, `symbol` nur vom Aufrufer, `sourceRole: "RESEARCH"`.
* **Snapshot-Kompatibilität** je Template × Takt: deterministische
  Kurzhistorie-Fixture (tragendes Feld `null`) bleibt **inert** — fail-closed,
  kein Entry — und die Positiv-Fixture erzeugt mindestens einen Entry (kein
  totes Template).
* **Negativ-Fixtures:** eine um ein Feld verkürzte Bedingung, ein `null`-Feld
  und der Raster-Extremwert je Schwelle erzeugen **keinen** Entry.
* **Katalog-Integrität:** exakt sechs IDs, keine Duplikate,
  `getTemplate("nicht-vorhanden") ⇒ null` (kein Wurf),
  `templateByField("bbZScore") ⇒ ["bollinger-squeeze"]`,
  `templateByField("donchianBreakoutPct") ⇒ ["donchian-breakout"]`.
* **Engine ↔ Cache (Phase-2-Regression):** `buildSnapshotFromCandles` und
  `snapshotFromCache(buildIndicatorCache(...))` liefern auf identischen Kerzen
  **exakt gleiche** Werte für `bbZScore`, `priceVsUpperBbPct`,
  `priceVsLowerBbPct` und `donchianBreakoutPct` (ohne Toleranz).
* **Timeframe-Disziplin (STX-01):** `vwapPct`-Templates führen kein `1d`/`5d`.

`docs/STRATEGY_TEMPLATES.md` wird von `scripts/gen-strategy-templates-doc.ts`
aus `STRATEGY_TEMPLATES` erzeugt (`npm run docs:templates`) und im selben Test
byteweise gegen `renderStrategyTemplatesDoc()` geprüft — Doku und Katalog können
nicht auseinanderlaufen. Kein Produktivcode wurde für 03-10 geändert:
`ruleEngine.ts`, `sanitizeRuleSpec`, `indicators.ts`, `indicatorCache.ts` und der
Katalog bleiben unverändert.

### 1.4 Strategie-Persistenzschema (STX-04-01, v0.8.0)

Die append-only Migration `drizzle/2026-10-01_strategy_catalog.sql` ergänzt
`strategy_definitions` und `strategy_versions`; `src/db/schema.ts` ist der
Drizzle-Spiegel. `template_id` bleibt ein code-owned Slug ohne FK. Eine Version
trägt kompilierte `params_json`, die sanitisierte `rule_spec_json`, den
System-Timeframe, Fingerprint, `stv1:`-Content-Hash sowie Code-/Template-
Version und Ersteller. Eindeutigkeit gilt je `(definition_id, version)`, global
für `fingerprint` und global für `content_hash` (Retry-/Replay-Idempotenz).

**Abgrenzung:** Das ist bislang nur das Schemafundament. 04-02 muss den
idempotenten Schreib-/Leseservice ergänzen, bevor Strategie-Artefakte über die
Anwendung persistiert oder rekonstruiert werden können. Es gibt keinen Backfill;
`strategy_lifecycle_*` bleibt in 04-01 unverändert und bestehende Lifecycle-
Zeilen bleiben gültig. Ein direkter FK zu `strategy_versions.id` ist wegen des
expliziten Lifecycle-Table-Locks ausgeschlossen; eine erneute Prüfung braucht
einen separat abgestimmten Scope.

### 1.5 Screening-Persistenz (STX-05-03, Unreleased auf v0.8.0)

`src/screening/matrix.ts` liefert stabil sortierte Strategie×Markt×Timeframe-
Kandidaten. `keys.ts` bindet Zellen, gemeinsamen UTC-Cutoff, Code und vollständige
Gewichte/Limits in den `ssr1:`-Run-Hash; `canonicalJson` bleibt die gemeinsame
Serialisierung aus `strategyLifecycle/evidence.ts`. `store.ts` legt Runs
transaktional idempotent an und schreibt immutable Zellen in atomaren Chunks.

`strategy_screening_runs` hält PIT-Provenienz/Config und monotone Fortschritte;
`strategy_market_results` hat verpflichtende FKs auf Run und Strategieversion,
einen optionalen Backtest-FK und einen eindeutigen `ssm1:`-Key. Result-Reads sind
auf höchstens 200 Zeilen begrenzt. Kein DELETE und keine nachträgliche
Prioritäts-/Ergebnisüberschreibung. `backtest_runs`, `strategy_versions` und
`strategy_lifecycle_*` werden nicht verändert. Discovery ohne Version bleibt
rein; erst eine aufgelöste Version erlaubt die Zellpersistenz.

Migration, Store-Verträge, SQL-/Drizzle-Parität und Rollback:
[`../STRATEGY_SCREENING.md`](../STRATEGY_SCREENING.md). Runner/CLI (05-04) sind
weiterhin offen; diese Schicht führt keine Backtests oder Live-Promotion aus.

## 2. Nicht vorhanden — explizite Lücken

Folgende Pfade/Tabellen existieren **noch nicht** im Ist-Zustand (geprüft via `ls` / `grep`).
Sie sind in der Roadmap vorgesehen — siehe `../audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`
und `../audits/2026-09-29-strategy-template-ausbau/report.md`:

| Nicht vorhanden | Status | Roadmap-Verweis |
|---|---|---|
| ~~`src/strategies/compiler.ts`~~ | ✅ existiert seit `v0.7.5` (03-09) | `ROADMAP.md` Phase 3 — **erledigt:** einziger Aufrufer von `buildRule` + `sanitizeRuleSpec()`, Details in §1.2; Beweis: `tests/strategies.compiler.security.test.ts`; `types.ts` (03-01) und `catalog.ts` (03-02) existieren |
| ~~Template-Vertragstests~~ | ✅ existiert seit `v0.7.6` (03-10) | `ROADMAP.md` Phase 3 — **abgeschlossen:** Beweis: `tests/strategies.templates.test.ts` (60 Tests), Details in §1.3; generierte Doku `docs/STRATEGY_TEMPLATES.md` |
| `src/screening/runner.ts` / `scripts/run-screening.ts` | Runner/CLI fehlen; Typen/Priorität/Matrix und Persistenz sind vorhanden | `ROADMAP.md` Phase 5 — `05-04` CLI + Backtest-Job-Adapter |
| `src/copy/` | Verzeichnis fehlt | `ROADMAP.md` Phase 7 — Copy-Trading (`07-01` Typen) |

Hinweis: Die Roadmap bleibt in `v0.x` (Beta) — keine Beta-Exit-Kriterien erfüllt.
Siehe `../BETA_STATUS.md`.

## 3. Wo kommt neues dazu? — 5-zeilige Entscheidungsregel

1. **Neues Rule-Feld / Indikator:** Erweitere `src/lib/ruleFieldCatalog.ts` + `src/lib/indicators.ts` + `src/backtest/indicatorCache.ts` (Parität wahren); nie ohne Whitelist in `src/lib/ruleEngine.ts`.
2. **Neue Strategieklasse / Regime / Eligibility / Kosten:** Erweitere bestehende SSoT (`src/lib/signalDecay.ts` `STRATEGY_CLASS_KEYS`, `src/lib/marketRegime.ts` `MarketRegime`, `src/universe/*` + `crossSectional/types.ts` `EligibilityConfig`, `src/backtest/types.ts` `BacktestEngineConfig.feeModel` + `src/backtest/montecarlo.ts` `MonteCarloStressConfig`); kein zweites Vokabular, kein drittes Kostenmodell. Klassen- und Regime-Vokabular ändert nur ein neues ADR (ADR-008, ADR-009), Universe-Gewichte nur die `PortfolioConstruction`-Schicht aus ADR-010.
3. **Neues Scanner-/Ranking-Verhalten:** Erweitere `src/scanner/*` (Faktor in `factors/` + Gewicht in `scanner.config.json`) bzw. `src/crossSectional/*`; keine neue Spec-Datei, SSoT bleibt Config + bestehende Typen.
4. **Neues Lifecycle-/Evidenz-/Fill-/Symbol-Verhalten:** Erweitere `src/strategyLifecycle/*`, `src/executionQuality/` + `src/brokers/reconciliation.ts`, `src/symbols/normalize.ts`; kein Copy-Reconciler, kein String-Replace.
5. **Neue Domäne (Screening, Copy, Strategie-Persistenz):** Für Phase 4 existiert seit 04-01 (`v0.8.0`) das Schema `strategy_definitions`/`strategy_versions`; der App-Service folgt in 04-02. `src/screening/` und die eigenen Screening-Run-/Zelltabellen sind vorhanden (§1.5); Runner/CLI folgen nur gemäß Phase-5-Gates. `src/copy/` fehlt weiterhin (Phase 7). **Innerhalb** von `src/strategies/` gilt: Neue Templates gehen über `catalog.ts` + `templates/`; eine `RuleSpec` entsteht **ausschließlich** über `compiler.ts` (§1.2) — kein zweiter Aufrufer von `buildRule()`, kein `sanitizeRuleSpec()`-Aufruf außerhalb des Compilers für Template-Regeln.

## 4. Verweise

- Pipeline: `PIPELINE_MAP.md`
- DB-Schema: `DB_SCHEMA.md`
- Integrationspunkte: `INTEGRATION_POINTS.md`
- Repository-Struktur: `../REPOSITORY_STRUCTURE.md`
- Entscheidungs-Log: [`../roadmap/DECISIONS.md`](../roadmap/DECISIONS.md) (ADR-008 Strategieklasse, ADR-009 Regime, ADR-010 Universe)
- Roadmap (Lücken): `../audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`
- Findings (STX-10): `../audits/2026-09-29-strategy-template-ausbau/findings/STX-10-featurestore-ist-slice.md`
