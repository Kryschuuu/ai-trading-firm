# Strategie-Stack — Single Source of Truth (SSoT)

> **Status:** Ist-Zustand · **Stand:** 2026-09-30 · **Code-Version:** v0.6.3 (Beta)
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
| Indikator-Formeln | `src/lib/indicators.ts` (neue Band-/Donchian-Level); bestehender Backtest-Cache: `src/backtest/indicatorCache.ts` | Cache-Erweiterung erst 02-02/02-03 |
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
| Lifecycle + Evidenz | `src/strategyLifecycle/*` | — |
| Symbol-SSoT | `src/symbols/normalize.ts` | kein String-Replace |
| Fill-Reconciliation | `src/brokers/reconciliation.ts` + `src/executionQuality/` | kein Copy-Reconciler |
| Broker-WS | nur `src/brokers/bitunix/ws.ts` | Alpaca hat **keinen** |

### Erläuterungen (Ist-Zustand, stichprobenweise verifiziert)

- **Rule-Felder:** `src/lib/ruleFieldCatalog.ts` exportiert `RULE_FIELDS` (Whitelist). `src/lib/ruleEngine.ts` re-exportiert und nutzt sie in `sanitizeRuleSpec()`. Keine zweite Whitelist.
- **Rule-Ausführung:** `src/lib/ruleEngine.ts` enthält `sanitizeRuleSpec`, `compileRuleSpec` (liefert `CompiledRule.evaluate`), `buildSnapshotFromCandles`, `backtestRule`, `RULE_CEILINGS`, `RULE_ALLOWED_TIMEFRAMES`. Kein Import von LLM-Modulen (bewusst isoliert).
- **Rule-Timeframes (STX-01, v0.6.2):** `src/lib/marketdata/timeframes.ts` exportiert `SUPPORTED_TIMEFRAMES` (zehn Werte `1m … 5d`), `SUPPORTED_TIMEFRAME_MS` und `isSupportedTimeframe`; der Historical Store re-exportiert sie. `RuleWindow.timeframe` ist ein `SupportedTimeframe`, `RULE_ALLOWED_TIMEFRAMES` (`ruleEngine.ts`) und `RULE_LLM_SCHEMA` leiten sich daraus ab, die Workshop-UI liest dieselbe Liste. Der Mikro-Executor wertet nur Regeln bis zu seinem Ausführungsintervall aus (Default `1h`; `ruleTimeframeBlockReason` in `src/lib/microExecutor.ts`) und weist längere sichtbar ab. `vwapPct` ist auf `1d`/`5d` immer `null`. Tabelle: [BACKTESTING.md §1.1](../BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062).
- **Indikatoren:** `src/lib/indicators.ts` = reine Formeln (`ema`, `rsi`, `macd`, `adx`, `atr`/`atrPct`, `bollingerBandWidthPct`, `sessionVwap`); seit 02-01 (`v0.6.3`) auch `bollingerBands` (SMA ± mult·Populations-σ, `width`/`bandwidthPct` als Bruch, exakt BBW-paritätsgleich) und `donchianChannel` (High/Low der **vorherigen** entry-/exit-Perioden, ohne Signalkerze; HTF-Mindest-Timeframe in 03-08). Neue Parameter geklemmt; fehlende Werte = `null`. Noch keine Rule-Felder: 02-02/02-03 ergänzen Snapshot und `src/backtest/indicatorCache.ts` mit Paritätstests; der Cache bildet diese neuen Formeln **noch nicht** ab.
- **Strategieklasse:** `src/lib/signalDecay.ts` definiert `STRATEGY_CLASS_KEYS = ["mean-reversion", "trend", "breakout", "unclassified"]` und `DEFAULT_CLASS_POLICIES`. `StrategyClass` (drei Werte, Liste `STRATEGY_CLASSES`) stammt aus `src/lib/marketRegime.ts`. Regeln tragen keine Klasse; zur Laufzeit wird sie aus dem Mission-Template abgeleitet (`strategyClassOfTemplate`). Kein Verzeichnis `src/strategies/` vorhanden. Verbindlich: ADR-008 (Klasse deklarieren, `unclassified` ist kein Template-Status, keine neue Klasse).
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

## 2. Nicht vorhanden — explizite Lücken

Folgende Pfade/Tabellen existieren **nicht** im Ist-Zustand (geprüft via `ls` / `grep`).
Sie sind in der Roadmap vorgesehen — siehe `../audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`
und `../audits/2026-09-29-strategy-template-ausbau/report.md`:

| Nicht vorhanden | Status | Roadmap-Verweis |
|---|---|---|
| `src/strategies/` | Verzeichnis fehlt | `ROADMAP.md` Phase 3 — Template-Kern (`03-01` `types.ts`, `03-02` `catalog.ts`, `03-09` `compiler.ts`) |
| `src/screening/` | Verzeichnis fehlt | `ROADMAP.md` Phase 5 — Candidate Matrix / Screening (`05-01` Typen, `05-02` Matrix-Builder) |
| `src/copy/` | Verzeichnis fehlt | `ROADMAP.md` Phase 7 — Copy-Trading (`07-01` Typen) |
| `strategy_definitions` | Tabelle fehlt | `ROADMAP.md` Phase 4 — `04-01` Migration `strategy_definitions` + `strategy_versions` |
| `strategy_versions` | Tabelle fehlt | `ROADMAP.md` Phase 4 — `04-01` Migration, `04-02` Service |
| `strategy_screening_runs` | Tabelle fehlt | `ROADMAP.md` Phase 5 — `05-03` Persistenz + Idempotenz |
| `strategy_market_results` | Tabelle fehlt | `ROADMAP.md` Phase 5 — `05-03` je Zelle (FK auf Screening-Run, `strategy_version_id`) |

Hinweis: Die Roadmap bleibt in `v0.x` (Beta) — keine Beta-Exit-Kriterien erfüllt.
Siehe `../BETA_STATUS.md`.

## 3. Wo kommt neues dazu? — 5-zeilige Entscheidungsregel

1. **Neues Rule-Feld / Indikator:** Erweitere `src/lib/ruleFieldCatalog.ts` + `src/lib/indicators.ts` + `src/backtest/indicatorCache.ts` (Parität wahren); nie ohne Whitelist in `src/lib/ruleEngine.ts`.
2. **Neue Strategieklasse / Regime / Eligibility / Kosten:** Erweitere bestehende SSoT (`src/lib/signalDecay.ts` `STRATEGY_CLASS_KEYS`, `src/lib/marketRegime.ts` `MarketRegime`, `src/universe/*` + `crossSectional/types.ts` `EligibilityConfig`, `src/backtest/types.ts` `BacktestEngineConfig.feeModel` + `src/backtest/montecarlo.ts` `MonteCarloStressConfig`); kein zweites Vokabular, kein drittes Kostenmodell. Klassen- und Regime-Vokabular ändert nur ein neues ADR (ADR-008, ADR-009), Universe-Gewichte nur die `PortfolioConstruction`-Schicht aus ADR-010.
3. **Neues Scanner-/Ranking-Verhalten:** Erweitere `src/scanner/*` (Faktor in `factors/` + Gewicht in `scanner.config.json`) bzw. `src/crossSectional/*`; keine neue Spec-Datei, SSoT bleibt Config + bestehende Typen.
4. **Neues Lifecycle-/Evidenz-/Fill-/Symbol-Verhalten:** Erweitere `src/strategyLifecycle/*`, `src/executionQuality/` + `src/brokers/reconciliation.ts`, `src/symbols/normalize.ts`; kein Copy-Reconciler, kein String-Replace.
5. **Völlig neue Domäne (Templates, Screening, Copy, Persistenz):** Existiert nicht — siehe Roadmap `../audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`; keine vorzeitige Anlage unter `src/strategies/`, `src/screening/`, `src/copy/` oder Tabellen `strategy_definitions`, `strategy_versions`, `strategy_screening_runs`, `strategy_market_results` ohne Phase 0–4 Gates.

## 4. Verweise

- Pipeline: `PIPELINE_MAP.md`
- DB-Schema: `DB_SCHEMA.md`
- Integrationspunkte: `INTEGRATION_POINTS.md`
- Repository-Struktur: `../REPOSITORY_STRUCTURE.md`
- Entscheidungs-Log: [`../roadmap/DECISIONS.md`](../roadmap/DECISIONS.md) (ADR-008 Strategieklasse, ADR-009 Regime, ADR-010 Universe)
- Roadmap (Lücken): `../audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`
- Findings (STX-10): `../audits/2026-09-29-strategy-template-ausbau/findings/STX-10-featurestore-ist-slice.md`
