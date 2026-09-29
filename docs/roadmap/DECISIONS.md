# Architecture Decision Records (ADR)

> **Stand:** 2026-09-30 · **Code-Version:** v0.6.1 (Beta)  
> **Verantwortlich:** `docs/roadmap/DECISIONS.md`

Dieses Dokument dokumentiert die verbindlichen architektonischen Entscheidungen, Annahmen und Invarianten des Gesamtsystems.

**Konventionen:** ADR-Nummern sind fortlaufend und werden nie wiederverwendet; maßgeblich ist die Nummer. Eine Entscheidung ändert nur ein neues ADR, das sie ausdrücklich ersetzt. Audit-lokale Kurznamen stehen in Klammern hinter dem Titel (`ADR-E1` … `ADR-E3` im [Strategie-Audit 2026-09-29](../audits/2026-09-29-strategy-template-ausbau/README.md)). Die Verortung der betroffenen Bausteine steht in [`architecture/STRATEGY_STACK.md`](../architecture/STRATEGY_STACK.md). Ab ADR-008 folgt jeder Eintrag dem Schema Status · Kontext · Optionen (Verworfenes mit Begründung) · Entscheidung · Konsequenzen · Auswirkung auf die Roadmap.

---

## ADR-001: Strikte Trennung von Interpretation, Berechnung und Risiko-Autorität

- **Status:** Angenommen & Verbindlich
- **Kontext:** LLMs neigen bei numerischen Aufgaben zu Halluzinationen und Nicht-Determinismus. Ein Trading-System erfordert jedoch absolute mathematische Reproduzierbarkeit und strikte Risikoeinhaltung.
- **Entscheidung:**
  1. **LLM = Interpretation:** LLMs generieren Thesen, analysieren Text/Sentiment und schlagen Setups vor (`isProposal: true`).
  2. **Mathematik = Berechnung:** Alle Kennzahlen (RSI, ATR, EMA, Renditen, Volatilität, Sharpe, Sortino, Drawdown, Portfoliogewichte) werden in reinem TypeScript/Mathematik berechnet.
  3. **Risk Engine = Autorität:** Die `riskGuard` und der Portfolio-Optimizer haben Vetorecht und kappen/blockieren jede Aktion, die Limits verletzt.
  4. **Code-Sicherheit:** Unbekannte Felder werden in Schemas strikt verworfen; externe Daten werden vor der Übergabe an LLMs als `untrusted_external_data` gewrappt.

---

## ADR-002: Deterministischer Scanner ohne Netzwerk- und Datenbank-I/O

- **Status:** Angenommen & Verbindlich
- **Kontext:** Das Scannen von 10.000+ Instrumenten darf weder externe APIs überlasten noch durch Netzwerkfluktuationen instabil werden.
- **Entscheidung:**
  - `src/scanner/` ist eine reine Funktionsbibliothek ohne Netzwerk-, DB- oder Uhrzeitabhängigkeit.
  - Alle Marktdaten werden vorab durch den `MarketDataSyncService` lokal synchronisiert (`data/universe/instruments.ndjson` und `data/history/candles.ndjson`).
  - Ein CI-Architekturtest (`tests/scanner.architecture.test.ts`) erzwingt die Importfreiheit von Netzwerk- und DB-Modulen.

---

## ADR-003: Atomare Mehrprozess-Order-Reservierung (`submitAtomic`)

- **Status:** Angenommen & Verbindlich
- **Kontext:** Bei parallelen Node.js-Prozessen (Next.js-Worker + Standalone Micro-Executor) bestand das Risiko von Race Conditions und doppelten Positionseröffnungen (Befund H2).
- **Entscheidung:**
  - Alle Order-Eröffnungen laufen über `PaperBroker.submitAtomic()` bzw. `withAccountLock`.
  - Verwendung von PostgreSQL `pg_advisory_xact_lock(hashtext(account))` zur Kontoserialisierung.
  - Vorab-Prüfung der echten DB-Wahrheit in `positions` (`status = 'OPEN'`).
  - DB-seitige Reservierung in `order_intents` mit partiellem Unique-Index (`UNIQUE (symbol) WHERE status = 'RESERVED'`).
  - Bei Unique-Konflikt erfolgt ein automatischer Rollback des In-Memory-Ledgers (Fail-Closed).

---

## ADR-004: Zentrale Singleton-Verwaltung über `stateRegistry.ts`

- **Status:** Angenommen & Verbindlich
- **Kontext:** Verstreute `globalThis`-Definitionen führten zu unübersichtlichen Zustandsdrifts und erschwerten saubere Test-Resets (Befund S2).
- **Entscheidung:**
  - Sämtliche prozessweiten Singletons und RAM-Caches sind typisiert in `src/lib/stateRegistry.ts` unter dem Namensraum `__AITF_STATE_REGISTRY__` gebündelt.
  - Tests nutzen ausschließlich `__resetAllSingletonsForTests()`, um den Urzustand deterministisch wiederherzustellen.

---

## ADR-005: 4-faches Live-Trading-Gate mit Single Point of Enforcement

- **Status:** Angenommen & Verbindlich
- **Kontext:** Versehentliches oder unberechtigtes Senden von Live-Orders an echte Börsen muss mit absoluter Sicherheit ausgeschlossen sein.
- **Entscheidung:**
  - `src/live-gate/enforcer.ts` (`assertLiveOrderAllowed`) ist der einzige Wächter vor jeder echten Order.
  - Vierfache Bedingung:
    1. Persistierter State-Machine-Zustand = `LIVE_ENABLED`
    2. Plattform-Flag `LIVE_TRADING_ENABLED=true`
    3. Venue-Flag `BITUNIX_LIVE_ENABLED=true`
    4. Human-Approval erfüllt (`REQUIRE_HUMAN_APPROVAL=false` oder Human-Gate passiert)
  - Zusätzlich: Gültiger CI-Security-Suite-Stamp (`passed: true`), aktiver Control-Plane-Zustand und inaktiver Kill-Switch (In-Memory + Disk-Failsafe).

---

## ADR-006: Schema-Version v2 für historische Kerzendaten mit Timeframe-Pflicht

- **Status:** Angenommen & Verbindlich
- **Kontext:** Im Legacy-Schema v1 fehlte die explizite Timeframe-Zuordnung in den Kerzenzeilen, was zum Mischen verschiedener Auflösungen in Analyse-Reihen führen konnte.
- **Entscheidung:**
  - `HistoricalStore` (`data/history/candles.ndjson`) nutzt Schema-Version **v2** mit Pflichtfeld `timeframe` aus der Allowlist (`1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `1d`, `5d`).
  - Logischer Primärschlüssel ist `instrumentId + timeframe + ts`.
  - Automatische Kompaktierung (`compact()`) auf max. 5.000 Kerzen je Reihe beim Batch-Append.

---

## ADR-007: Event-Driven Multi-Asset Backtesting & Stop-Vorrang-Invariante (Task 02)

- **Status:** Angenommen & Verbindlich
- **Kontext:** Isolierte Einzeltitel-Backtests übersehen Liquiditätsengpässe, gleichzeitige Signale und Portfolio-Klumpenrisiken.
- **Entscheidung:**
  - Die Backtest-Engine (`src/backtest/`) arbeitet zeitachsensynchronisiert über alle Instrumente hinweg ohne Lookahead-Bias.
  - Ein zentrales Portfolio verwaltet Cash, offene Positionen und Notional-Caps über alle parallelen Trades.
  - Bei zeitgleicher Berührung von Stop-Loss und Take-Profit innerhalb derselben Kerze greift ausnahmslos der **Stop-Loss-Vorrang**.
  - Metriken werden aus der kontinuierlichen Equity-Kurve abgeleitet (Sharpe, Sortino, Max Drawdown mit Recovery-Dauer, Profit Factor, Win Rate, Expectancy).

---

## ADR-008: Strategie-Klassifikation (ADR-E1)

- **Status:** Angenommen & Verbindlich — entschieden 2026-09-29 (Prompt STX-00-03, `v0.6.1`). Befund: [STX-02](../audits/2026-09-29-strategy-template-ausbau/findings/STX-02-strategyclass-duplikat.md).
- **Kontext:**
  - Das Repo besitzt bereits ein Klassen-Vokabular, das bis in die Ausführung wirkt (am 2026-09-29 gegen den Code verifiziert):
    - `StrategyClass = "mean-reversion" | "trend" | "breakout"` (`src/lib/marketRegime.ts`, Liste `STRATEGY_CLASSES`) steuert das Regime-Gate (`regimeGateFactor`: Faktor je Regime × Klasse, genutzt im Engine-Turn und im Mikro-Executor).
    - `StrategyClassKey = StrategyClass | "unclassified"` mit `STRATEGY_CLASS_KEYS` (`src/lib/signalDecay.ts`) steuert die Decay-Policies (`DEFAULT_CLASS_POLICIES`, Backtest-`signalDecay`) und ist persistiert (`positions.strategy_class` und `signal_decay_events.strategy_class`, jeweils mit CHECK über die vier Werte: `drizzle/2026-09-22_signal_decay.sql`).
  - Eine Regel trägt heute **keine** Klasse. Sie wird aus dem *Mission*-Template abgeleitet (`strategyClassOfTemplate(mission.templateId)`, Namens-Heuristik auf `…mean-reversion…`, `…breakout…`, `…trend…`/`…momentum…`). Ohne Treffer gilt im Gate `null` (Faktor 1), im Decay-Pfad `unclassified` (Policy default-off).
  - Ein `StrategyTemplate` (Phase 3 der Strategie-Roadmap) ist ein deklariertes, versioniertes Artefakt. Ohne Festlegung entsteht ein zweites Klassen-Enum — oder ein Template, das **still** die Risiko-Logik seiner Klasse verliert.
- **Optionen:**
  1. Bestehendes Vokabular `StrategyClassKey`/`STRATEGY_CLASS_KEYS` wiederverwenden, Klasse als Pflichtfeld — **gewählt**.
  2. Eigener Union-Typ oder eigene Liste im Template-Modul (`src/strategies/`) — **verworfen:** zweites Klassen-Enum. `gateFactors` (`Record<MarketRegime, Record<StrategyClass, number>>`) und `DEFAULT_CLASS_POLICIES` (`Record<StrategyClassKey, …>`) sind über das bestehende Vokabular definiert; ein abweichender Wert fällt dort still auf Faktor 1 bzw. `unclassified` — eine Risiko-Abschwächung ohne Fehlermeldung.
  3. `unclassified` als gültiger Template-Status (Fallback statt Fehler) — **verworfen:** `unclassified` heißt „Decay-Policy default-off, keine Halbwertszeit“ und im Gate Faktor 1. Bei einem geprüften, versionierten Artefakt ist die Klasse eine Fachaussage, keine Voreinstellung; ein Template ohne Klasse hätte seine Schutzlogik verloren, bevor es läuft.
  4. Neue Klasse (z. B. `momentum`) für MACD oder RSI — **verworfen:** jede Klasse ist ein kalibrierter Vertrag aus Gate-Faktoren in allen fünf Regimes, Decay-Policy, DB-CHECK und Env-Grammatik (`REGIME_GATE_FACTORS`, `SIGNAL_DECAY_CLASS_*`); eine vierte Klasse hätte weder Kalibrierung noch Verbraucher. MACD-Momentum ist Trendfolge (`trend`), RSI-Überverkauft-Kauf ist Mean-Reversion (`mean-reversion`).
  5. Klasse aus der Template-ID ableiten (Heuristik von `strategyClassOfTemplate`) statt sie zu deklarieren — **verworfen:** das Substring-Matching liefert für zwei der sechs geplanten Template-IDs (`bollinger-squeeze`, `vwap-pullback`) `null`; eine implizite Ableitung ist für versionierte Artefakte zu fragil.
- **Entscheidung:**
  1. `StrategyTemplate.class` ist ein **Pflichtfeld** vom Typ `StrategyClassKey` (Import aus `src/lib/signalDecay.ts`), zur Laufzeit gegen `STRATEGY_CLASS_KEYS` geprüft. In `src/strategies/` gibt es **keinen** eigenen Union-Typ, keine eigene Liste und keine eigene Konstante für Klassen.
  2. Ein Template ohne Klasse oder mit `class: "unclassified"` ist ein **Fehler** (Katalog-Validierung, Compiler und DB-CHECK lehnen es ab). `unclassified` ist **kein** Template-Status; es bleibt Regeln ohne Klassen-Herkunft vorbehalten (manuelle Regeln, Positionen ohne ableitbare Klasse).
  3. Es gibt **keine neue Klasse** in dieser Roadmap. Jedes Template gehört einer der drei bestehenden Klassen an (Zuordnung unter *Konsequenzen*). Das Klassen-Vokabular ändert nur ein neues ADR, das Gate, Decay-Policies, DB-CHECK und Env-Grammatik gemeinsam migriert.
- **Konsequenzen:**
  - Der Typ `StrategyClassKey` enthält `unclassified`. Der Ausschluss ist deshalb eine **Laufzeitregel** (Fehlercode im Katalog, Ablehnung im Compiler), keine Typ-Eigenschaft. Die zulässige Menge ist exakt `STRATEGY_CLASSES` — dieselben drei Werte, keine zweite Liste.
  - Zuordnung der sechs geplanten Templates (bindend für 03-03 … 03-08):

    | Template | Klasse |
    | --- | --- |
    | `ema-adx-trend` | `trend` |
    | `macd-momentum` | `trend` |
    | `rsi-mean-reversion` | `mean-reversion` |
    | `bollinger-squeeze` | `breakout` |
    | `vwap-pullback` | `trend` |
    | `donchian-breakout` | `breakout` |

  - **Wirkungsgrenze (verifiziert):** Der Compiler reicht die Klasse als `strategyClass` im `CompileResult` weiter; Aufrufer setzen sie in den Backtest-Kontext (`BacktestEngineConfig.signalDecay.strategyClass`, Opt-in, Decay-Policy) sowie in die Screening- und Report-Typen. Der Backtest wendet **kein** Regime-Gate an — das Gate läuft nur im Engine-Turn und im Mikro-Executor. Die Live-Ausführung bleibt bei der Mission-Ableitung: `RuleSpec`/`trade_rules` tragen weiterhin keine Klasse, und der Strategie-Service (04-02) ist Registry, nicht Executor. Eine Regel ohne Mission läuft mit Gate-Faktor 1 (fail-safe); die Roadmap ändert dieses Verhalten **nicht**.
  - Begriffe: *Mission-Template* (`src/lib/missionTemplates.ts`, Prompt-Vorlage, Klasse per Namens-Heuristik) und *StrategyTemplate* (`src/strategies/`, quantitatives Artefakt, Klasse deklariert) sind verschiedene Dinge; beide liefern Werte aus demselben Vokabular.
  - Kontrakt-Invariante: Jede Klasse aus `STRATEGY_CLASSES` hat in **allen** fünf Regimes einen Gate-Faktor und eine Decay-Policy. `tests/adrVocabulary.test.ts` hält das fest, ebenso die Tabelle oben gegen die Template-Prompts.
  - Bekannte Altlast (Verhalten unverändert, nicht Teil der Roadmap): die vier Klassenwerte stehen zusätzlich als Literale in `isStrategyClassKey`/`classOf` (`signalDecay.ts`), in `signalDecayRuntime.ts` und in den CHECKs von `positions` und `signal_decay_events`. Neuer Code importiert `STRATEGY_CLASS_KEYS`/`STRATEGY_CLASSES`, statt die Werte zu kopieren.
- **Auswirkung auf die Roadmap:**
  - **Phase 3:** 03-01 (`class: StrategyClassKey`, Pflicht) und 03-02 (Validierung: in `STRATEGY_CLASS_KEYS` und ungleich `unclassified`) setzen die Entscheidung um; 03-03 … 03-08 tragen die Klasse aus der Tabelle; 03-09 liefert `CompileResult.strategyClass` und lehnt `unclassified` ab; 03-10 prüft die Kontrakt-Invariante.
  - **Phase 4/5/6:** 04-01 legt `strategy_class` mit CHECK auf die drei Klassen an (ohne `unclassified`); 05-01 und 06-04 führen `class: StrategyClassKey` nur als lesendes Feld.
  - **OP-2** (`unclassified` als Template-Status) ist beantwortet: **nein, Fehler**. Kein Prompt ändert `STRATEGY_CLASS_KEYS`, `StrategyClass` oder `DEFAULT_CLASS_POLICIES` (03-01 sperrt `signalDecay.ts`).

---

## ADR-009: Regime-Vokabular (ADR-E2)

- **Status:** Angenommen & Verbindlich — entschieden 2026-09-29 (Prompt STX-00-03, `v0.6.1`). Befund: [STX-03](../audits/2026-09-29-strategy-template-ausbau/findings/STX-03-regime-vokabular-konflikt.md).
- **Kontext:**
  - Das Regime-Vokabular existiert durchgängig: `MarketRegime = TREND_UP | TREND_DOWN | RANGE | HIGH_VOL | CRASH` und `MarketRegimeLabel = MarketRegime | "UNKNOWN"` (`src/lib/marketRegime.ts`). Der Klassifikator ist deterministisch (Priorität `CRASH > HIGH_VOL > TREND_* > RANGE`, Hysterese, kein LLM). `regime_snapshots` persistiert je Snapshot genau **ein** bestätigtes Label (`confirmed_regime`, daneben `raw_regime`; append-only, CHECK über die sechs Werte, `feature_version`/`model_version`, Retention Default 90 Tage). `src/lib/regimeEvaluation.ts` wertet aus (`REGIME_EVAL_LABELS`, `evaluateRegimeStability`, `evaluateRegimeOos`). Das Beta-Kriterium B2 in [`BETA_STATUS.md`](../BETA_STATUS.md) ist bereits über „5 `MarketRegime`-Klassen“ definiert.
  - Das Ausbaudokument (§3.6) schlägt für die Regime-Validierung eine 7er-Taxonomie vor: bull / bear / sideways / high-vol / low-vol / high-volume / low-volume.
  - Präzisierung zum Befund: `evaluateRegimeOos` aggregiert **Markt**-Forward-Returns je bestätigtem Regime (`RegimeEvalRow.forwardReturnPct`, außerhalb berechnet in `scripts/regime-eval.ts`) — keine Strategie-Kennzahlen. `UNKNOWN` weist es als eigenen Bucket aus (Messbericht, bewusst vollständig). Ein Aggregator „Strategie je Regime“ existiert noch nicht.
  - Die drei `VolatilityRegime`-Typen (`src/lib/adaptiveRisk.ts`: `NORMAL | ELEVATED | EXTREME`, Risikofaktor auf Positionsgrößen; `src/portfolio/types.ts` und `src/scanner/types.ts`: `LOW | NORMAL | HIGH | EXTREME`, Kennzahl-Stufen) sind Volatilitäts-Stufen und **kein** Markt-Regime im Sinne dieses ADR.
- **Optionen:**
  1. Bestehendes `MarketRegime` + `regime_snapshots` + Zeilenformat von `regimeEvaluation.ts` — **gewählt**.
  2. 7er-Taxonomie bull/bear/sideways/high-vol/low-vol/high-volume/low-volume — **verworfen:**
     - Es gibt dafür weder Klassifikator noch Persistenz, Gate oder Auswertung — es wäre eine vollständige zweite Pipeline.
     - Vier der sieben Klassen sind Synonyme des Bestands: bull = `TREND_UP`, bear = `TREND_DOWN` (extrem: `CRASH`), sideways = `RANGE`, high-vol = `HIGH_VOL`. `low-vol` hat kein Gegenstück und keinen Verbraucher (`RANGE` ist der Rückfall der Klassifikation).
     - Die sieben Klassen sind nicht disjunkt (bull und high-vol gleichzeitig), `regime_snapshots.confirmed_regime` trägt aber genau ein Label und ist per CHECK auf sechs Werte beschränkt. Eine Umstellung wäre eine Schema-Migration plus Neu-Klassifikation der gespeicherten Historie.
     - B2 würde still umdefiniert: ein Beta-Exit-Kriterium ändert sich nicht durch ein Audit.
  3. High-/Low-Volume als Regime — **verworfen:** Volumen ist im Repo der Scanner-Faktor `volumeRatio` (`scanner.config.json`) und ein Regel-Feld (`RULE_FIELDS`) — eine Messgröße, die Bedingungen speist, kein Marktzustand. Ein Volume-Regime wäre ein Faktor-Vorschlag und ist nicht Teil dieser Roadmap.
  4. Eigener Regime-Typ für Templates (`expectedRegimes`) oder eigener Klassifikator für die Validierung — **verworfen:** zweites Vokabular; `expectedRegimes` importiert `MarketRegime`.
  5. `UNKNOWN` als auswertbares Regime („Regime ohne Edge“) zählen oder auf `RANGE` abbilden — **verworfen:** `UNKNOWN` heißt „kein belastbares Datum“, nicht „der Markt bietet keinen Edge“. Eine Strategie, die in `UNKNOWN`-Phasen schlecht aussieht, hat ein Datenproblem, kein Regime-Problem.
- **Entscheidung:**
  1. Das Regime-Vokabular ist `MarketRegime` (fünf Werte) mit `MarketRegimeLabel` (zusätzlich `UNKNOWN` als Zustandslabel). Es gibt kein zweites Regime-Vokabular; die 7er-Taxonomie entfällt.
  2. Die Per-Regime-Auswertung einer Strategie nimmt ihre Labels ausschließlich aus `regime_snapshots` und nutzt Zeilenformat und Label-Liste von `regimeEvaluation.ts` (`RegimeEvalRow`, `REGIME_EVAL_LABELS`). Ein neuer **Aggregator** (06-04) ordnet jeden Trade point-in-time dem letzten bestätigten Snapshot mit `asOf ≤ Entry` zu. `evaluateRegimeOos` bleibt unverändert — es misst den Markt, nicht die Strategie.
  3. `UNKNOWN` wird **fail-closed ausgeschlossen:** Snapshots mit `UNKNOWN` (oder einem Label außerhalb der fünf) und Trades ohne zuordenbaren Snapshot fließen in keine Regime-Kennzahl der Strategie ein. Sie erscheinen nur als ausgewiesener Ausschluss-Zähler und führen nie zu einem Urteil „kein Edge in Regime X“. Regime-Kennzahlen ohne ausreichende Stichprobe sind `null`, nie `0`.
  4. `StrategyTemplate.expectedRegimes` ist `readonly MarketRegime[]` — `UNKNOWN` ist dort ein Validierungsfehler (analog zu `unclassified` in ADR-008).
  5. High-/Low-Volume ist kein Regime und nicht Teil dieser Roadmap.
- **Konsequenzen:**
  - Der Befund-Test „`evaluateRegimeOos` schließt `UNKNOWN` aus“ (STX-03) gilt für den **Aggregator**, nicht für `evaluateRegimeOos`: dessen `UNKNOWN`-Bucket ist Teil des Messberichts und bleibt. `tests/adrVocabulary.test.ts` hält dieses Ist-Verhalten fest, damit eine Änderung bewusst ein neues ADR auslöst.
  - Datenabdeckung: `regime_snapshots` enthält nur Zeiträume, in denen der Regime-Evaluator lief (Retention Default 90 Tage, `REGIME_SNAPSHOT_RETENTION_DAYS` Bounds [7, 365]). Backtest-Fenster ohne Snapshots sind nicht per Regime auswertbar und werden als Abdeckungslücke ausgewiesen; der Validator klassifiziert nicht still nach. Die Mindeststichprobe je Regime legt 06-04 als geklemmte Schwelle fest.
  - Jedes Per-Regime-Ergebnis trägt `featureVersion` und `modelVersion` der verwendeten Snapshots (beide existieren in `regime_snapshots` und `RegimeStabilityReport`), damit es reproduzierbar bleibt.
  - Die `VolatilityRegime`-Typen bleiben unverändert. Sie dienen nicht als Regime-Label für Templates, `regime_snapshots` oder Per-Regime-Auswertungen; ihre Zusammenführung ist nicht Teil dieser Roadmap.
- **Auswirkung auf die Roadmap:**
  - **Phase 3:** 03-01/03-02 typisieren `expectedRegimes` als `readonly MarketRegime[]` (statt `MarketRegimeLabel`) und lehnen `UNKNOWN` ab; 03-10 testet das. Die `expectedRegimes` der Templates 03-03 … 03-08 nutzen bereits nur die fünf Werte.
  - **Phase 6:** 06-01 nutzt für die Annahmen-Kategorie `REGIME` dieselben Labels; 06-04 führt `regimes[].regime` als `MarketRegime` (ohne `UNKNOWN`) über den Aggregator. Die Formulierung „`evaluateRegimeOos` wiederverwenden“ in 06-02/06-03 bedeutet: Vokabular und Zeilenformat, nicht die Markt-Kennzahlen.
  - Kein neuer Prompt; der Aggregator entsteht ausschließlich in 06-04.

---

## ADR-010: Universe-Strategie (ADR-E3)

- **Status:** Angenommen & Verbindlich — entschieden 2026-09-29 (Prompt STX-00-03, `v0.6.1`). Befund: [STX-04](../audits/2026-09-29-strategy-template-ausbau/findings/STX-04-multiaset-spec-duplikat.md).
- **Kontext:**
  - Das Ausbaudokument (§1.9) definiert eine neue `MultiAssetStrategySpec` mit `ranking`, `selection`, `rebalance` und `sizing`.
  - `src/crossSectional/` deckt den Kern bereits ab: `CrossSectionalConfig` ist versioniert und hash-identifiziert (`configHash` mit Präfix `xc1:`; eine Änderung erzeugt eine neue Snapshot-Identität) mit `horizons` (Ranking), `eligibility: EligibilityConfig` (Membership: `minVolume24h`, `minCandles`, `maxStaleBars`, `assetClasses`, `maxUniverseSize`), `timeframe: SupportedTimeframe` (Default `1h`; alle zehn `SUPPORTED_TIMEFRAMES` inklusive `1d`/`5d` sind gültig) und Point-in-Time-Semantik (`asOf`/`computedAt`, `availabilityPolicy`). Snapshots sind persistiert (DB + Artefakt); das Modul enthält bewusst **keine** Orders.
  - Verifizierte Lücken (Präzisierung zu Befund und Prompt 00-03):
    - `sizing` fehlt: weder `EQUAL_WEIGHT` noch `INVERSE_VOLATILITY` existieren; `src/portfolio/optimize.ts` kennt nur `min_variance`, `max_sharpe` und `risk_parity`.
    - `selection.topN` ist **nicht** durch `maxUniverseSize` gedeckt: `UNIVERSE_CAP` kappt nach `volume24h` (Liquidität), nicht nach Composite-Rang.
    - Die Bounds in `src/portfolio/volatilityTargeting.ts` (`VOLATILITY_TARGETING_BOUNDS`) begrenzen den **Risiko-Multiplikator** (`minMultiplier`/`maxMultiplier` ∈ [0,05; 1], `maxMultiplier` hart ≤ 1), nicht einzelne Gewichte. Gewichts-Schranken liegen in `WeightBounds` (`src/portfolio/types.ts`).
  - Universe-Filter gibt es in drei Stufen mit je eigenem Zweck: Registry-Policy (`src/universe/policy.ts`), Scanner-Trichter (`checkEligibility`, `src/scanner/filters.ts`) und Snapshot-Membership (`EligibilityConfig`, `src/crossSectional/universe.ts`). Für Universe-Strategien ist die dritte maßgeblich.
- **Optionen:**
  1. `PortfolioConstruction`-Schicht, die einen `CrossSectionalConfig`-Snapshot liest und Gewichte erzeugt — **gewählt**.
  2. `MultiAssetStrategySpec` (Ausbaudokument §1.9) als neue Spec — **verworfen:** `ranking`, Liquiditäts-`selection`, `rebalance` und PIT existieren bereits in `CrossSectionalConfig`; eine zweite Spec erzeugt zwei Wahrheiten über Universe-Mitgliedschaft und Ranking. Der vorgeschlagene `buildUniverseStrategy(ctx)` wäre zudem ein Runtime-Builder, der `sanitizeRuleSpec()` umgeht (STX-05).
  3. `sizing` als neues Feld in `CrossSectionalConfig` — **verworfen:** die Sizing-Wahl würde `configHash` und damit jede Snapshot-Identität ändern, obwohl Ranking und Eligibility gleich bleiben. Außerdem vermischt es Messung (Ranking) mit Entscheidung (Gewichte) in einem Modul, das bewusst order-frei ist.
  4. `equal_weight`/`inverse_vol` als weitere `OptimizationMode` — **verworfen:** `src/portfolio/` nimmt laut Architektur-Regel 1 (`types.ts`) ausschließlich Renditezeitreihen und Parameter; Snapshots, Rang und Provenance kennt es nicht, und eine Abhängigkeit `portfolio → crossSectional` würde diese Grenze verletzen. Die neue Schicht **nutzt** den Portfolio-Vertrag (`WeightBounds`, Autoritätskette), sie ersetzt ihn nicht.
  5. Eigenes Rebalance-Feld (Frequenz oder Zeitplan) — **verworfen:** `CrossSectionalConfig.timeframe` ist die Periodizität; eine zweite Frequenz erzeugt Snapshots ohne Gewichte oder Gewichte ohne Snapshot.
- **Entscheidung:**
  1. **Keine** `MultiAssetStrategySpec` — weder in `src/strategies/` noch anderswo. Universe-Mitgliedschaft und Ranking sind ausschließlich `CrossSectionalConfig` (`EligibilityConfig`, `horizons`); es gibt keine zweite Eligibility- oder Ranking-Spec.
  2. Gewichte erzeugt eine eigene, dünne **`PortfolioConstruction`-Schicht**: eine reine Funktion `(CrossSectionalSnapshot, Parameter) → Gewichte` mit den Modi `EQUAL_WEIGHT` und `INVERSE_VOLATILITY`. Eingabe sind ausschließlich `RANKED`-Mitglieder; die Rang-Auswahl (`topN`) ist ein Parameter dieser Schicht, nicht der Eligibility. Die Gewichte sind Long-only mit Σw = 1.
  3. **Klemmung über bestehende Grenzen, keine eigenen:** Die Gewichte sind der Eingabevertrag des Volatility-Targetings (`VolatilityForecastSeries.weight`: Long-only, ≥ 0); der daraus abgeleitete Multiplikator bleibt in `VOLATILITY_TARGETING_BOUNDS` (`maxMultiplier` ≤ 1: nie risikosteigernd). Per-Asset-Schranken verwenden `WeightBounds`. Die Schicht definiert keine eigenen Bounds.
  4. Die Gewichte sind ein **Vorschlag** (ADR-001) und erreichen eine Order nur über die bestehende Autoritätskette `portfolio-optimizer → risk-guard → position-limits → correlation-limits` (`AUTHORITY_CHAIN`).
  5. **Rebalance-Frequenz = `CrossSectionalConfig.timeframe`:** genau ein Gewichtsvektor je Snapshot, gebunden an `snapshotId` und `configHash`. Es gibt kein eigenes Rebalance-Feld. Gleicher Snapshot und gleiche Parameter ergeben bit-identische Gewichte.
  6. Fail-closed: Ein Mitglied ohne belastbare Volatilität (`INVERSE_VOLATILITY`) oder mit `NaN` erhält kein Gewicht und wird mit geschlossenem Grund ausgewiesen — nie `0` oder ein Mittelwert als Ersatz. Bleibt kein Mitglied übrig, ist das Ergebnis leer (Cash), kein stiller Wechsel auf `EQUAL_WEIGHT`.
- **Konsequenzen:**
  - `src/crossSectional/` bleibt unverändert und order-frei. Die Abhängigkeit läuft einseitig: die Schicht importiert Typen aus `crossSectional/types` und Verträge aus `src/portfolio/`; `crossSectional` und `portfolio` kennen die Schicht nicht.
  - Keine eigene Volatilitäts- oder Kovarianzschätzung: `INVERSE_VOLATILITY` nutzt die bestehende as-of-sichere Return-Serien-Konvention (`logReturns` mit `eventTimes`).
  - Abnahmekriterien jeder Umsetzung (aus dem Befund übernommen): Σw = 1 innerhalb einer Toleranz; `NaN` fail-closed; gleiche Config und gleicher Snapshot ergeben gleiche Gewichte (Hash-Stabilität); keine zweite Eligibility- oder Ranking-Spec.
  - „Sizing“ bezeichnet vier getrennte Zuständigkeiten ohne Überschneidung:

    | Baustein | Zuständigkeit |
    | --- | --- |
    | `src/lib/positionSizing.ts` | Stückzahl je Trade aus Risikobudget und Stop-Abstand |
    | Volatility-Targeting (`src/portfolio/volatilityTargeting.ts`) | Risiko-Multiplikator ≤ 1 auf das Budget |
    | `PortfolioConstruction` (dieses ADR) | relative Zielgewichte innerhalb eines Universe-Snapshots |
    | `src/copy/sizing.ts` (Prompt 07-01) | Follower-Notional aus einem Leader-Trade (Copy-Domäne) |

  - `StrategyTemplate.scope` bleibt `"SINGLE_SYMBOL"`. Der Wert stammt aus dem bestehenden `MissionScope` (`src/lib/missionTemplates.ts`: `SINGLE_SYMBOL`, `SCAN_UNIVERSE`); ein Universe-Scope für Templates entfällt.
  - Die Universe-Strategie ist von `RuleWindow.timeframe` unabhängig: `CrossSectionalConfig.timeframe` akzeptiert heute alle zehn `SUPPORTED_TIMEFRAMES`. 01-01 bleibt für Einzel-Symbol-Regeln nötig, ist aber keine Voraussetzung für die Universe-Strategie.
- **Auswirkung auf die Roadmap:**
  - **Phase 1:** Die Begründung „Tages-Rebalance des Cross-Sectional-Moduls nicht ausdrückbar“ entfällt in STX-01/01-01; der Prompt bleibt wegen der Einzel-Symbol-Regeln (`4h`/`1d`) bindend.
  - **Phase 3:** 03-01 führt `scope: "SINGLE_SYMBOL"`, kein `buildUniverseStrategy`, keine `MultiAssetStrategySpec` (im Prompt bereits gesperrt).
  - **Phase 5:** 05-02 nutzt `CrossSectionalRankContext` weiter als optionalen, lesenden Scanner-Faktor; keine zweite Eligibility.
  - **Außerhalb der 32 Prompts:** Die `PortfolioConstruction`-Schicht wird in dieser Roadmap **nicht** gebaut — kein Prompt und kein Release `v0.6.x` … `v0.11.x` liefert sie. Wer sie baut, baut genau die Form der Entscheidungen 2–6 und beauftragt sie als eigenen Prompt mit eigenem Release. STX-04 gilt mit diesem ADR als entschieden.
