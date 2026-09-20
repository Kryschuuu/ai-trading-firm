# Vollständiger Roadmap-Auditbericht

## 1. Auftrag und Bewertungsmaßstab

Geprüft wurde der Stand von Commit `df3163e` (`v1.51.1`) gegen 25
konkrete Roadmap-Komponenten. Maßgeblich war ausführbarer Code samt Schema,
Migrationen und Tests — nicht eine bloße Erwähnung in Dokumentation.

- **VERIFIED (Ja):** Das geforderte Verhalten ist im produktiven Pfad
  implementiert und testbar.
- **PARTIAL (Teilweise):** Nahe Infrastruktur ist vorhanden, mindestens ein
  wesentlicher Teil des Sollverhaltens fehlt jedoch.
- **OPEN (Nein):** Das Sollverhalten hat keinen produktiven End-to-End-Pfad.

Jeder Detailbefund nennt exakte Pfade und Symbole, grenzt bestehende ähnliche
Funktionalität vom Soll ab und schätzt nur das verbleibende Delta. Alle
PARTIAL-/OPEN-Befunde besitzen einen eigenständigen Implementierungs-Prompt.

## 2. Ergebnis

| Priorität | VERIFIED | PARTIAL | OPEN | Restaufwand |
|---|---:|---:|---:|---:|
| P1 — Backtest und Wahrheitsquellen | 1 | 4 | 1 | 22–34 PT |
| P2 — Research-Signale | 0 | 4 | 1 | 15–25 PT |
| P3 — Agenten-Evaluation | 0 | 1 | 2 | 10–17 PT |
| P4 — Execution | 0 | 2 | 1 | 12–19 PT |
| P5 — Risiko und Exits | 2 | 2 | 1 | 7–12 PT |
| P6 — Datenfundament | 1 | 0 | 2 | 10–17 PT |
| **Gesamt** | **4** | **13** | **8** | **76–124 PT** |

Die vollständige 25-Zeilen-Tabelle mit Links steht in [`README.md`](README.md).

## 3. Priorität 1 — belastbarer Backtest und Trade-Wahrheit

### P1.1 Event-Replay mit Friktionen — PARTIAL

`runMultiAssetBacktest()` verarbeitet sortierte Bar-Events deterministisch;
`createPaperExecutionRuntime()` modelliert über `fillEntry()`/`fillExit()`
Spread, Slippage, partielle Fills und Gebühren. Das ist mehr als ein reiner
Return-Rechner. Es fehlen jedoch Orderbuch-/Depth-Impact,
Latenz-Ereignisse, ein vollständiger Partial-Fill-Lifecycle mit Exit-Restmenge
und eine historische Funding-Zeitreihe. Simulatorseitige Partial Fills sind
vorhanden, aber ein partieller Exit wird in der Engine noch wie ein kompletter
Positionsschluss behandelt. Der vorhandene Funding-Konfigurationswert ist kein
zeitpunktgenaues Perp-Replay.

→ [Detail](findings/RMA-P1-01-event-replay-frictions.md) · [Prompt](prompts/PROMPT-P1-01-event-replay-frictions.md)

### P1.2 90d/30d Walk-Forward — PARTIAL

`computeWalkForwardWindows()` baut konfigurierbare IS-/OOS-Fenster und
`runWalkForward()` rechnet beide Abschnitte deterministisch. Der gleiche
Strategieinput wird aber in beiden Abschnitten abgespielt. Es gibt keine
Parameter-/Modellselektion nur auf IS, kein Freeze-Artefakt und keinen finalen
unberührten Holdout. Das ist Split-and-Replay, noch kein echter
Train-Select-Freeze-Test-Prozess.

→ [Detail](findings/RMA-P1-02-walk-forward-training.md) · [Prompt](prompts/PROMPT-P1-02-walk-forward-training.md)

### P1.3 Kennzahlen — VERIFIED

`computeBacktestMetrics()` liefert Trade-Anzahl, Win Rate, Profit Factor,
Expectancy, Sharpe, Sortino, Max Drawdown und Equity-basierte Kennzahlen. Das
Portfolio-Metrikmodul dokumentiert Log-Returns und `ddof=1`. Im Peer-Review
wurde nur ein konkreter Verdrahtungsbug bei annualisierter Volatilität gefunden
und in diesem PR korrigiert; die Roadmap-Komponente als Ganzes ist vorhanden.

→ [Detail](findings/RMA-P1-03-backtest-metrics.md)

### P1.4 Persistente Runs und Trades — PARTIAL

`backtest_runs`, `insertBacktestRun()` und die Backtest-APIs persistieren
Run-Konfiguration, Metriken, Hashes und Zeitfenster. Ein relationaler
`backtest_trades`-Datensatz mit Entry/Exit, Gebühren, Funding, Signal- und
Attributionsreferenzen fehlt. Trade-Hashes beweisen Reproduzierbarkeit, ersetzen
aber keine abfragbare Trade-Wahrheitsquelle.

→ [Detail](findings/RMA-P1-04-backtest-trades.md) · [Prompt](prompts/PROMPT-P1-04-backtest-trades.md)

### P1.5 Lifecycle und Backtest↔Paper↔Live-Drift — OPEN 🔴

Es existieren immutable Regelversionen und Zustände wie DRAFT/ACTIVE/PAUSED.
Es gibt aber keine Lifecycle-State-Machine `BACKTEST_PASSED → PAPER → LIVE`,
keine standardisierten Drift-Fenster/-Metriken und keine automatische
Degradation bei Performance- oder Execution-Abweichung. Ein manuelles
Rule-Lifecycle ist nicht dasselbe wie evidenzbasierte Promotion.

→ [Detail](findings/RMA-P1-05-lifecycle-drift.md) · [Prompt](prompts/PROMPT-P1-05-lifecycle-drift.md)

### P1.6 Trade-Attribution — PARTIAL

Das Trade-Journal speichert Decision Snapshots, Votes sowie Proposal-/Rule-
Zuordnung und berechnet gruppierte Agentenstatistiken. Es fehlt eine
normalisierte Attribution von realisiertem Trade-PnL auf Signal-/Faktorbeiträge
mit der zum Entscheidungszeitpunkt verwendeten Prompt-, Daten- und
Strategieversion. Vote-Historie ist eine gute Quelle, aber noch keine kausale
oder deterministisch definierte PnL-Attribution.

→ [Detail](findings/RMA-P1-06-trade-attribution.md) · [Prompt](prompts/PROMPT-P1-06-trade-attribution.md)

## 4. Priorität 2 — Research-Signale

### P2.1 Regime-Erkennung — PARTIAL

`classifyMarketRegime()`, `MarketRegimeStateMachine` und `applyRegimeGate()`
liefern Trend-/Range-/High-Vol-/Crash-Regime mit Hysterese und produktivem
Risikofaktor. Makro-/Liquiditätsmerkmale oder eine lernende
Regime-Wahrscheinlichkeit fehlen; die Klassifikation ist deterministisch und
OHLCV-basiert.

→ [Detail](findings/RMA-P2-01-regime-detection.md) · [Prompt](prompts/PROMPT-P2-01-regime-detection.md)

### P2.2 Perpetual-Daten — PARTIAL

Funding- und Open-Interest-Faktoren sind im Scanner modelliert und das
Paper-Ledger kann Funding verbuchen. Adapter liefern jedoch keine
persistierende, punktgenaue Funding-/OI-/Liquidationshistorie; dadurch sind die
Faktoren häufig neutral/unavailable und im Backtest nicht historisch
reproduzierbar.

→ [Detail](findings/RMA-P2-02-perpetual-data.md) · [Prompt](prompts/PROMPT-P2-02-perpetual-data.md)

### P2.3 Multi-Timeframe-Konfluenz — PARTIAL

Der technische Analyst fordert Multi-Timeframe-Views an, der Marketdata-Store
kann mehrere Timeframes halten, und Artefakte werden versioniert. Eine
explizite, deterministische Konfluenzformel mit As-of-Ausrichtung,
Vollständigkeitsflags und einem persistierten Score fehlt. LLM-Zusammenfassung
ist nicht gleich reproduzierbare MTF-Feature-Berechnung.

→ [Detail](findings/RMA-P2-03-multi-timeframe-confluence.md) · [Prompt](prompts/PROMPT-P2-03-multi-timeframe-confluence.md)

### P2.4 Cross-Sectional Momentum Ranking — OPEN

Der Scanner rangiert Instrumente nach einem gewichteten Multi-Faktor-Score.
Das ist ein Querschnittsranking, aber kein dedizierter, universumsweit
berechneter Momentum-Rang mit Returns über definierte Horizonte,
Liquidity-Eligibility und as-of-sicherer Persistenz.

→ [Detail](findings/RMA-P2-04-cross-sectional-ranking.md) · [Prompt](prompts/PROMPT-P2-04-cross-sectional-ranking.md)

### P2.5 Strukturierte Sentiment-Outputs — PARTIAL

News- und Analystenpfade normalisieren Richtung, Confidence und These in JSON.
Es fehlen belastbare Felder für Zeithorizont, Ereignistyp, Quellenabdeckung,
Unsicherheit und stabile Entity-Zuordnung; außerdem kein systematischer
Outcome-Link zur späteren Kalibrierung.

→ [Detail](findings/RMA-P2-05-structured-sentiment.md) · [Prompt](prompts/PROMPT-P2-05-structured-sentiment.md)

## 5. Priorität 3 — Agenten-Evaluation

### P3.1 Brier Score und Kalibrierung — OPEN

Confidence-Werte werden persistiert, aber nicht als zeitgebundene probabilistische
Forecasts mit binärem oder kategorialem Outcome aufgelöst. Ohne
Forecast-Ledger, Resolver, Brier Score und Reliability Bins ist keine
Kalibrierungsmessung möglich.

→ [Detail](findings/RMA-P3-01-forecast-calibration.md) · [Prompt](prompts/PROMPT-P3-01-forecast-calibration.md)

### P3.2 Prompt-Version-Metrikvergleich — PARTIAL

Agenten und Regelkonfigurationen sind versioniert; Analysen und Journal-Votes
werden persistiert. Die konkrete Prompt-Version beziehungsweise ein stabiler
Prompt-Hash wird nicht lückenlos mit jedem Forecast und Outcome verbunden, und
es gibt keinen zeit-/regimebereinigten Vergleich von Qualität, Kalibrierung,
PnL oder Kosten pro Prompt-Version.

→ [Detail](findings/RMA-P3-02-prompt-performance.md) · [Prompt](prompts/PROMPT-P3-02-prompt-performance.md)

### P3.3 Devil’s Advocate — OPEN

Risk- und CEO-Schritte prüfen Vorschläge, sind aber keine unabhängige,
strukturierte Gegenhypothese mit verpflichtender Evidenz, Falsifikatoren,
Disagreement-Score und persistiertem Einfluss auf die finale Entscheidung.

→ [Detail](findings/RMA-P3-03-devils-advocate.md) · [Prompt](prompts/PROMPT-P3-03-devils-advocate.md)

## 6. Priorität 4 — Execution

### P4.1 Execution-Benchmarking — PARTIAL

Broker-Resultate und Auditpfade enthalten Fills, Gebühren sowie teilweise
Slippage-/Latenzinformationen. Es fehlt ein venueübergreifendes
Execution-Quality-Schema mit Arrival Price, Decision Price, VWAP,
Implementation Shortfall, Fill Ratio und p50/p95-Latenz sowie aggregierten
Vergleichen zwischen Backtest, Paper und Live.

→ [Detail](findings/RMA-P4-01-execution-benchmarking.md) · [Prompt](prompts/PROMPT-P4-01-execution-benchmarking.md)

### P4.2 Post-Only + Timeout + Market-Fallback — PARTIAL

Limitorders und venue-spezifische Ordertypen sind vorhanden. Keine gemeinsame,
persistierbare Policy steuert Post-Only-Reject, TTL, Cancel/Replace und einen
risikobegrenzten Market-Fallback idempotent über Alpaca, Bitunix und Paper.

→ [Detail](findings/RMA-P4-02-post-only-fallback.md) · [Prompt](prompts/PROMPT-P4-02-post-only-fallback.md)

### P4.3 TWAP / Depth — OPEN

Orderbuch-Snapshots können abgefragt werden, aber es existiert kein Child-Order-
Scheduler, Participation Cap, Depth-Impact-Modell oder persistenter Parent-
Order-Zustand. Einzelorders und ein Orderbook-Read erfüllen keine algorithmische
Ausführung.

→ [Detail](findings/RMA-P4-03-twap-depth.md) · [Prompt](prompts/PROMPT-P4-03-twap-depth.md)

## 7. Priorität 5 — Risiko und Exits

### P5.1 Volatility Targeting — PARTIAL

Adaptive Risk dämpft globale Limits anhand diskreter Volatilitätsregime. Das
ist sinnvolle Risikoadaption, aber kein kontinuierliches Portfolio-Volatility-
Target mit prognostizierter Kovarianz, Leverage-Bounds und nachgewiesener
Realisierungsabweichung.

→ [Detail](findings/RMA-P5-01-volatility-targeting.md) · [Prompt](prompts/PROMPT-P5-01-volatility-targeting.md)

### P5.2 Fractional Kelly — VERIFIED

`resolveKellyEdge()` leitet Full Kelly aus belastbaren Journalstatistiken ab;
`computePositionSize()` wendet die konfigurierte Fraction als Notional-Deckel
hinter dem harten Risikobudget an. Missing-/Zero-Edge-Fälle und Bounds sind
getestet; nachgelagerte Positions-/Portfolio-Ceilings bleiben autoritativ.

→ [Detail](findings/RMA-P5-02-fractional-kelly.md)

### P5.3 Cluster-Limits — VERIFIED

`applyRiskGuard()` begrenzt Symbole, Cluster und Bruttoexposure, dokumentiert
die Authority Chain und behandelt Cash-/Residualbedingungen. Korrelation und
Cluster werden im Portfolio-/Zykluspfad berechnet und weitergereicht.

→ [Detail](findings/RMA-P5-03-cluster-limits.md)

### P5.4 Drawdown-Scaling — PARTIAL

Max-Drawdown wird gemessen und Daily-Loss-/Risk-Ceilings existieren. Eine
kontinuierliche, hysteretische Skalierungsfunktion aus aktuellem
High-Water-Mark-Drawdown in das zulässige Risikobudget samt Recovery-Policy
fehlt.

→ [Detail](findings/RMA-P5-04-drawdown-scaling.md) · [Prompt](prompts/PROMPT-P5-04-drawdown-scaling.md)

### P5.5 Signal-Decay-Exits — OPEN

`decideExit()` unterstützt SL, TP, Trailing und Time Stop. Der ursprüngliche
Signalzustand wird aber nicht gegen einen aktuellen Score beziehungsweise eine
Halbwertszeit geprüft; daher gibt es keinen Exit bei Alpha-Verfall.

→ [Detail](findings/RMA-P5-05-signal-decay-exits.md) · [Prompt](prompts/PROMPT-P5-05-signal-decay-exits.md)

## 8. Priorität 6 — Datenfundament und Robustheit

### P6.1 Point-in-Time Feature Store — OPEN

Der Historical Store ist zeit- und timeframebewusst und speichert Provenance.
Er speichert jedoch Rohkerzen, keine versionierten Featurewerte mit
`event_time`, `available_at`, Feature-Definition und point-in-time Join API.
Ein Candle Store verhindert Look-ahead nicht automatisch auf Feature-Ebene.

→ [Detail](findings/RMA-P6-01-point-in-time-feature-store.md) · [Prompt](prompts/PROMPT-P6-01-point-in-time-feature-store.md)

### P6.2 Monte Carlo — OPEN

Es gibt deterministische Backtests und Walk-Forward-Aggregate, aber keine
Trade-/Block-Resampling-Engine, keine reproduzierbaren Seeds und keine
Quantile für Drawdown, Ruin, Sharpe oder End-Equity.

→ [Detail](findings/RMA-P6-02-monte-carlo.md) · [Prompt](prompts/PROMPT-P6-02-monte-carlo.md)

### P6.3 Data Quality — VERIFIED

`validateCandleSeries()`, `crosscheckCandles()`, Staleness-Prüfung,
strict/log-Modi, persistierte Reports und Scan-/Sync-Gates decken Gaps,
Duplikate, ungültige OHLCV, Outlier, Cross-Venue-Abweichungen und Staleness ab.
Der in QA-02 korrigierte Loader-Verlust war ein lokaler Persistenzfehler, kein
fehlendes Quality-System.

→ [Detail](findings/RMA-P6-03-data-quality.md)

## 9. Abhängigkeiten und empfohlene Reihenfolge

```text
P6.1 Point-in-Time Features ─┬─> P2.1 Regime
                             ├─> P2.3 MTF
                             └─> P2.4 Cross-Sectional Ranking
P2.2 Perp-Daten ───────────────> P1.1 Friction Replay
P1.4 Backtest-Trades ─┬────────> P1.6 Attribution
                      ├────────> P6.2 Monte Carlo
                      └────────> P1.5 Lifecycle/Drift
P1.2 Walk-Forward ─────────────> P1.5 Lifecycle/Drift
P4.1 Benchmarks ──────┬────────> P4.2 Fallback-Policy
                      └────────> P1.5 Lifecycle/Drift
P3.1 Forecast Ledger ─┬────────> P3.2 Prompt-Vergleich
                      └────────> P3.3 Devil’s Advocate Evaluation
P5.1 Vol Target ──────┬────────> P5.4 Drawdown-Scaling
                      └────────> P1.5 Lifecycle/Drift
```

Empfohlene Umsetzung: gemeinsame Datenwahrheiten zuerst (P1.4, P6.1, P2.2,
P3.1, P4.1), darauf Research/Backtest/Evaluation, danach automatisierte
Promotion, komplexe Execution und Monte Carlo. Jeder Prompt ist absichtlich als
eigener reviewbarer PR geschnitten.

## 10. Peer-Review-Korrekturen dieses Audit-PRs

### QA-01 — Annualisierte Backtest-Volatilität

**Fehler:** `src/backtest/metrics.ts::computeBacktestMetrics()` las
`(sharpeRes as any).volatility`. `src/portfolio/metrics.ts::sharpeRatio()` gibt
nur `perPeriod` und `annualized` zurück. Der Ausdruck fiel deshalb immer auf
`0` zurück.

**Korrektur:** Stichproben-Standardabweichung der bereits berechneten
Equity-Log-Returns (`ddof=1`) wird mit `sqrt(annualization)` annualisiert und in
Prozent ausgegeben. Ein Regressionstest fordert positive, mathematisch
korrekte Volatilität bei nichtkonstanten Returns.

### QA-02 — Verlust von Quality-Report-Summen beim Laden

**Fehler:** `src/marketdata/quality.ts::loadQualityReport()` validierte
Serieneinträge, setzte danach aber sämtliche aggregierten Zähler hart auf `0`
und verwarf `crosscheckCompared`.

**Korrektur:** Der Loader rekonstruiert alle Aggregate aus den validierten
Serien und übernimmt `crosscheckCompared` defensiv. Ein Roundtrip-Test sichert
Summen und Crosscheck-Zähler.

## 11. Peer-Review- und Validierungsevidenz dieses Audit-PRs

Der Peer-Review kombinierte die gezielte Prüfung aller Roadmappfade mit
Schema-/Migrationsabgleich, Testsichtung, repositoryweiter Symbolsuche sowie den
statischen Projektgates. Ähnliche Funktionalität wurde jeweils gegen den
konkreten Sollvertrag abgegrenzt. Kleine, eindeutig behebbar abgegrenzte
Bestandsfehler wurden als QA-01/QA-02 korrigiert; größere Deltas wurden nicht
als „Bugfix“ getarnt, sondern in die 21 reviewbaren Remediation-Prompts
überführt.

Ausgeführt und erfolgreich:

- `npm ci` — 503 Pakete installiert, npm-Audit: 0 Schwachstellen.
- `npm run typecheck` — erfolgreich.
- `npm run lint` — erfolgreich, 0 Fehler; vier bereits vorhandene Warnungen zu
  überflüssigen `eslint-disable`-Direktiven in `src/scanner/service.ts` und
  `src/universe/registry.ts`.
- `npm run docs:validate` — acht Checks, zehn Hilfe-Dateien, erfolgreich.
- `node --import tsx --test tests/backtest.unit.test.ts` — 10/10 Tests grün.
- `node --import tsx --test test/marketdata/quality.test.ts` — 35/35 Tests grün.
- `node --import tsx --test tests/docsVersioning.test.ts` — 8/8 Tests grün.
- Inventarcheck — 25 Findings, 21 komponentenspezifische Prompts und alle
  Pflichtabschnitte vorhanden.

`npm run test` wurde auf ausdrückliche Auftraggeberanweisung **nicht**
ausgeführt. Das ist keine Behauptung eines grünen vollständigen Testlaufs; die
gezielten Regressionstests und statischen Gates ersetzen diese Transparenz
nicht. Der ausgelassene Gesamtlauf muss auch im PR vermerkt bleiben.

## 12. Definition of Done für die Remediation-Serie

Ein Finding darf erst auf `FIXED` gesetzt werden, wenn:

1. produktiver End-to-End-Pfad und defensive Fehlerbehandlung implementiert sind,
2. Migrationen append-only und rückwärtskompatibel sind,
3. Unit-, Integrations-, deterministische Replay- und relevante Negative-Path-
   Tests grün sind,
4. `npm run typecheck`, `npm run lint`, `npm test` und
   `npm run docs:validate` erfolgreich sind,
5. README, API-/Code-Dokumentation, Kommentare, kanonischer `CHANGELOG.md`,
   Paketversion und Tracking konsistent aktualisiert sind,
6. keine Secrets/PII und keine unbeschränkten High-Cardinality-Labels entstehen,
7. das Finding einen Evidenzblock mit PR, Commit, Tests und Fix-Version erhält.
