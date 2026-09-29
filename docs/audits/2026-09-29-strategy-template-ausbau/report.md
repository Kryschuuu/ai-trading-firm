# Audit-Report — Validierung des Ausbaudokuments „Strategie-Templates, Copy-Trading, Validator"

- **Datum:** 2026-09-29
- **Commit:** `e3509fd9e84fc45c80817f04e6fe74c0c5fd8f67` (`main`)
- **Methode:** Jede Aussage des Ausbaudokuments wurde gegen den Quelltext geprüft.
  Verifiziert über: `src/lib/ruleEngine.ts`, `src/lib/ruleFieldCatalog.ts`, `src/lib/indicators.ts`,
  `src/lib/marketRegime.ts`, `src/lib/signalDecay.ts`, `src/lib/regimeEvaluation.ts`,
  `src/backtest/{types,walkforward,montecarlo,indicatorCache}.ts`,
  `src/strategyLifecycle/**`, `src/crossSectional/**`, `src/features/**`, `src/scanner/**`,
  `src/brokers/{alpaca,bitunix}/**`, `src/routing/**`, `src/db/schema.ts`, `drizzle/*.sql`.

---

## 0. Kurzfassung des Ergebnisses

Das Dokument ist **in der Diagnose richtig und in der Bestandsaufnahme unausgewogen**.

Von 23 im Detail geprüften Code-Behauptungen sind:
- **15 bestätigt** (die Architektur-Kernaussage trägt),
- **5 irreführend** (bestehende Bausteine werden als fehlend dargestellt),
- **2 falsch** (Faktorzahl, Alpaca-WebSocket),
- **1 verspätet relevant** (OpenCode-Free-Tier).

Hinzu kommen **6 nicht erwähnte Aspekte**, davon zwei harte Blocker (§5, L1–L12).

Die Kernidee — *Strategy Template, Candidate Matrix, Validator-Report* als drei neue
Kernobjekte — ist richtig und wird hier bestätigt. Die **Reihenfolge** des Dokuments ist
jedoch falsch: Es stellt den Template-Katalog (P0) voran, obwohl zwei Voraussetzungen noch
nicht erfüllt sind (Timeframe-Abdeckung, Indikator-Grundlage) und vier der vorgeschlagenen
Abstraktionen zuerst gegen bestehende Domänenmodelle abgegrenzt werden müssen.

| Dimension | Bewertung |
|---|---|
| **Architektur-Ablauf (LLM → RuleSpec → sanitize → compile → execute)** | ✅ korrekt erkannt, richtig bewertet |
| **Diagnose „kein versioniertes Strategie-Artefakt"** | ✅ bestätigt, die wichtigste Lücke des Dokuments |
| **Diagnose „keine Screening-Schicht"** | ✅ bestätigt |
| **Diagnose „kein Copy-Trading"** | ✅ bestätigt |
| **Bestandsaufnahme Feature Store / Regime / Stress / StrategyClass** | ❌ zu pessimistisch |
| **Bestandsaufnahme Alpaca WS / Faktorzahl** | ❌ falsch |
| **Timeframe-Abdeckung** | ❌ nicht erwähnt → Blocker |
| **Reihenfolge/Abhängigkeiten** | ⚠️ 4 Abhängigkeiten nicht benannt |

---

## 1. Validierung der Bestandsaufnahme

### 1.1 Bestätigt

| Aussage des Dokuments | Verifikation |
|---|---|
| `RuleEngine` ist deterministisch und kennt keine LLMs | `src/lib/ruleEngine.ts:1-25` — Modulkopf dokumentiert explizit „DIE Datei, die bewusst NICHTS über LLMs weiß"; keine `ollama`/`llmProvider`-/`engine`-Imports |
| Whitelist + numerische Ceilings + flache Evaluatoren | `RULE_FIELDS` (`ruleFieldCatalog.ts`), `RULE_CEILINGS` (`ruleEngine.ts:158-175`), `compileRuleSpec()` |
| `RuleSpec`-Shape wie im Dokument gezeigt | `ruleEngine.ts:96-108` — Feldnamen und Typen stimmen exakt |
| `sanitizeRuleSpec()` / `backtestRule()` existieren | `ruleEngine.ts` bzw. `ruleEngine.ts:729` |
| `trend`, `adx14`, `priceVsEma50Pct`, `volumeRatio`, `atrPct`, `macdHist`, `ema50`, `rsi14`, `bbwPct`, `vwapPct`, `priceVsEma21Pct` sind Rule-Felder | Alle 22 Felder in `RULE_FIELDS` vorhanden |
| `bbwPct` misst **Breite**, nicht Position → `bbZScore` fehlt | `ruleFieldCatalog.ts`: „Bollinger-Bandbreite in Prozent". `indicators.ts:103` bietet nur `bollingerBandWidthPct` — **keine** Band-Level-Funktion |
| Donchian fehlt vollständig | `grep -ri donchian src/` → 0 Treffer |
| Regel-Dialekt ist zustandsorientiert, nicht sequenzorientiert | `RuleOp = lt\|lte\|gt\|gte\|eq\|between\|in` — kein `CROSS`/`RECLAIM`/`BREAKOUT` |
| Long-only ist Absicht | `RULE_ALLOWED_SIDE = "LONG"`, `RuleAction.side: "LONG"` |
| Backtest / Walk-Forward / Monte-Carlo vorhanden | `src/backtest/{engine,walkforward,montecarlo}.ts` |
| 9 Zustände + Evidence + Drift | `src/strategyLifecycle/{states,evidence,drift,service,orderGate}.ts` |
| Mission-Templates sind Prompt-Vorlagen, keine quantitativen Objekte | `src/lib/missionTemplates.ts` (1.257 Zeilen) — reine Missions-/Segment-Katalogdaten |
| Cross-Sectional-Momentum-Module existiert | `src/crossSectional/*` (10 Dateien) inkl. PIT-Semantik |
| Historischer Store ist NDJSON | `src/lib/marketdata/historicalStore.ts:4` |
| Kein `src/strategies/`, `src/screening/`, `src/copy/` | Verzeichnisse existieren nicht |

### 1.2 Irreführend (Baustein existiert bereits, wird als Lücke dargestellt)

| Aussage | Realität | Auswirkung |
|---|---|---|
| *„Strategie-Klassifikation fehlt"* | `StrategyClass = "mean-reversion" \| "trend" \| "breakout"` existiert in `marketRegime.ts:86` und `signalDecay.ts:107` (dort `+ "unclassified"`) und wirkt bereits auf Regime-Gate und Decay-Policies | **STX-02** — ein neues Template-System ohne Mapping baut ein zweites Klassifikationsmodell |
| *„Regime Validation fehlt (bull/bear/sideways/…)"* | `MarketRegime = TREND_UP \| TREND_DOWN \| RANGE \| HIGH_VOL \| CRASH` + `UNKNOWN`, klassifiziert in `marketRegime.ts`, ausgewertet in `regimeEvaluation.ts` (`evaluateRegimeStability`, `evaluateRegimeOos`) und `regime_snapshots` (Tabelle existiert) | **STX-03** — die 7er-Taxonomie des Dokuments ist ein konkurrierendes Vokabular |
| *„Feature Store → zentraler Feature-Layer"* | `src/features/*` existiert, umfasst aber genau **3** Features: `scanner.rsi`, `scanner.atr`, `scanner.atr_band` | **STX-10** — „zentraler Layer" ist eine Größenordnungs-Unterschätzung um Faktor ~8 |
| *„Cost Stress ×1/×2/×3 ist neu"* | `MonteCarloStressConfig { feeMultiplier, slippageMultiplier }` existiert in `montecarlo.ts:171`; Bound `[1,100]`; `MC_STRESS_MULTIPLIER_BOUNDS`. Zusätzlich Scanner-Faktor `executionCost` | **STX-11** — nicht neu, aber **an anderer Stelle** (post-hoc auf Trade-Logs, nicht im Backtest) |
| *„Parameter-Sensitivität fehlt"* | `WalkForwardCandidate` + `SelectorGates` + `CandidateScoreRow` + `FreezeArtifact` erzeugen bereits eine **volle Score-Tabelle je Fenster** | teilweise vorhanden; es fehlt nur die *Breite* des stabilen Bereichs (Plateau-Messung) |

### 1.3 Falsch

| Aussage | Realität | Beleg |
|---|---|---|
| *„Scanner: 15+ Faktoren"* | **14 aktive** Faktoren | `src/scanner/scanner.config.json` → `liquidity, spread, atr, volatility, momentum, trend, volumeRatio, rsi, drawdown, correlation, news, funding, openInterest, execution` |
| *„Alpaca bietet WS … das ist ideal für einen Leader-Adapter … der Adapter ist weitgehend fertig"* | `src/brokers/alpaca/` enthält **keine** WS-Implementierung (kein `ws.ts`, kein `wss://`, kein `trade_updates`-Consumer). Nur `src/brokers/bitunix/ws.ts` existiert | `ls src/brokers/alpaca/` → adapter, audit, config, errors, execution, gates, http, index, mapping, orders, paper, privateClient, publicClient, redactor, secrets, types |

### 1.4 Nicht erwähnt, aber entscheidend

**`RuleWindow.timeframe` ist auf `1m | 5m | 15m | 30m | 1h` beschränkt**
(`ruleEngine.ts:87`, `ALLOWED_TIMEFRAMES` in `ruleEngine.ts:205`, JSON-Schema in `ruleEngine.ts:883`).
Der Historical Store unterstützt dagegen `1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 5d`
(`historicalStore.ts:45-56`).

Konsequenz: Das Dokument schlägt eine Candidate Matrix über „mehrere Timeframes" vor,
`MultiAssetStrategySpec` mit `rebalance.timeframe: "1d"` und ein Screening „× 3 Timeframes" —
**keiner dieser Vorschläge ist mit der aktuellen `RuleSpec` ausdrückbar.** Das ist der
einzige echte **Blocker** des Vorhabens. → **STX-01**

---

## 2. Bewertung der zentralen Abstraktionen

### 2.1 `StrategyTemplate` — **bestätigt, aber mit Korrektur am Entwurf**

**Bestätigt:** Die Grundidee eines versionierten, technischen Artefakts statt eines
Prompt-Textes ist richtig und schließt die größte Lücke (STX-06).

**Korrektur 1 — statisch statt dynamisch.** Das Dokument schlägt vor:

```ts
buildRule?: (ctx: StrategyContext) => RuleSpec;   // ❌ Runtime-Builder
```

Das widerspricht dem Kern-Sicherheitsmodell. `RuleSpec` ist heute ein **statisches,
sanitisiertes Artefakt**, das `sanitizeRuleSpec()` durchläuft und in `trade_rules`
**persistiert** wird. Ein Builder, der zur Laufzeit aus einem Kontext eine `RuleSpec`
erzeugt, eröffnet einen **zweiten Pfad**, der an der Whitelist, den `RULE_CEILINGS` und der
Persistenz vorbeiläuft. Ein LLM, das `ctx` kontrolliert, könnte dann Parameter wählen, die
nie durch `sanitizeRuleSpec()` gingen.

**Korrektur 2 — Template ist Parameter-Raster, nicht Code.** Richtig ist:

```ts
export interface StrategyTemplate {
  id: string;                 // stabil, schema-validiert
  version: number;            // monotonic, Teil des Artefakt-Hashs
  class: StrategyClassKey;    // ← Mapping auf das BESTEHENDE Modell (STX-02)
  scope: "SINGLE_SYMBOL";
  supportedTimeframes: readonly SupportedTimeframe[];  // ← Store-Vokabular (STX-01)
  params: Record<string, ParamSpec>;   // Typ + Default + Bounds
  buildRule(p: Record<string, number>): RuleSpecInput;  // PUR, deterministisch, ohne ctx
  assumptions: readonly StrategyAssumption[];
}
```

Der Builder ist eine **pure Funktion von Parametern** (nicht von Marktdaten) — das Output
geht **immer** durch `sanitizeRuleSpec()`. → **STX-05**

**Korrektur 3 — `MultiAssetStrategySpec` nicht neu erfinden.** Siehe 2.3.

### 2.2 `StrategyMarketCandidate` — **bestätigt, Persistenz braucht neue Tabelle**

Die Prioritätsformel des Dokuments

```
0.30·dataQuality + 0.25·liquidity + 0.20·freshness + 0.15·strategyFit + 0.10·volatilityOpportunity − correlationPenalty
```

ist als **Rechenlast-Priorisierung** richtig eingeschätzt (kein Handelssignal). Aber:

- **`backtest_runs` kann sie nicht speichern**: `instrument_id` ist `NOT NULL`, der Lauf ist
  konzeptionell single-instrument (`schema.ts:226-230`). → **STX-07**
- Die Gewichte sind **Magic Numbers ohne Herleitung**. Sie brauchen einen
  Konfigurationsort (`src/scanner/config.ts`-Muster) und einen Test, der die
  Reihenfolge-Invarianz festschreibt.
- `correlationPenalty` braucht eine **Definition**: gegen welche Benchmark? Das
  Korrelations-Faktor-Modul des Scanners ist instrument-vs-Benchmark, nicht Matrix-intern.

### 2.3 `MultiAssetStrategySpec` — **nicht neu bauen (Duplikat)**

`src/crossSectional/` enthält bereits:

| Dokument will | Repo hat bereits |
|---|---|
| `ranking: { metric, lookback, direction }` | `CrossSectionalConfig.horizons: MomentumHorizonConfig[]` (lookback, skip, weight) |
| `selection: { topN, minLiquidityUsd }` | `EligibilityConfig { minVolume24h, minCandles, maxStaleBars, assetClasses, maxUniverseSize }` |
| `rebalance: { timeframe: "1d" }` | `CrossSectionalConfig.timeframe` + `AvailabilityPolicy` |
| `sizing: { mode: "INVERSE_VOLATILITY" }` | **fehlt** — das ist der einzige echte Baustein-Lückenschluss |
| PIT-Semantik | `asOf` / `availableAt` / `computedAt` + `ingested`/`bar_close`-Policy, vollständig dokumentiert |

Eine zweite Spec für denselben Zweck erzeugt **zwei Wahrheiten** über
Universe-Mitgliedschaft. Der einzige echte Zugewinn ist das **Sizing** — und dafür
existiert bereits `src/portfolio/volatilityTargeting.ts`. → **STX-04**

### 2.4 `StrategyValidationReport` — **bestätigt, mit Kompatibilitätsnachweis**

Der Vorschlag

```ts
result: "PASS" | "FAIL" | "INCONCLUSIVE";
```

ist **exakt** das Vokabular des bestehenden CHECK-Constraints:

```sql
CHECK ("result" IN ('PASS','FAIL','INCONCLUSIVE'))   -- strategy_lifecycle_evidence
```

Die Struktur des Dokuments (`metrics`, `robustness`, `overfitting`, `assumptions`,
`evidenceHash`) passt auf das vorhandene Evidenz-Schema (`kind`, `result`, `metrics jsonb`,
`detail jsonb`, `content_hash`, `idempotency_key`, `policy_version`, `code_version`,
`data_version`, `sample_size`, `window_start/end`). **Kein Schema-Umbau nötig.** → **STX-17**

**Die Trennung „Agent erklärt, Code entscheidet" ist richtig und im Repo bereits
institutionell verankert** (`devilsAdvocate` mit `shadowMode` + `humanReviewThreshold`,
`config.ts:11-19`). Der Validator-Agent ist die glebe Idee, auf eine zweite Domäne
angewandt.

### 2.5 Copy-Trading — **bestätigt als Lücke, aber in Teilen zu teuer für den Nutzen**

| Teil | Bewertung |
|---|---|
| Domänenmodell `NormalizedLeaderTrade` | ✅ richtig; `action: OPEN\|INCREASE\|DECREASE\|CLOSE` ist die entscheidende Normalisierung („Intent statt Order") |
| Symbol-Mapping über die SSoT | ✅ richtig und wichtig — `src/symbols/normalize.ts` mit `tryNormalizeVenueSymbol` existiert bereits |
| Leverage-Policy `FOLLOW_LEADER\|CAP\|IGNORE\|RISK_NORMALIZED` | ✅ richtig |
| Partial-Fill-Zustandsmaschine | ✅ richtig, aber **Reconciliation existiert bereits** (`src/brokers/reconciliation.ts`, `src/executionQuality/*`, 5 Tabellen) → **STX-09** |
| Slippage-Cancel | ⚠️ **problematisch**: Wer cancellt eine bereits gefüllte Order? Korrekt ist *nachträglich* messen (`executionQuality` lernt `actualPriceDeviationBps`) und **künftige** Orders drosseln. Ein nachträglicher Cancel ist unmöglich. |
| Leader = Alpaca | ❌ **blockiert** — kein WS vorhanden (STX-08). Polling ist keine brauchbare Leader-Quelle (Latenz, Rate-Limits, `getOrderUpdates` ist paginiert) |
| 6 neue Tabellen | ⚠️ Für Paper-first sind **2** Tabellen ausreichend (`copy_subscriptions`, `copy_order_links`); `copy_positions` ist eine Projektion aus `positions` |
| Infrastruktur-Reihenfolge | ✅ Bitunix zuerst (WS existiert), Alpaca später |

### 2.6 Infrastruktur-Migration (Event-Bus / Parquet / DuckDB) — **Einwand bestätigt, Reihenfolge nicht**

- **Kein Kafka: ✅ bestätigt.** Für die vorliegende Lastdimension ist ein In-Process-Bus
  korrekt. Der bestehende `src/marketdata/manager.ts` + `failover.ts` ist bereits die
  Abstraktionsstelle.
- **Parquet/DuckDB: ⚠️ zu früh als Priorität.** Vor dem Datenformat ist der **Leseweg**
  zu messen. Der NDJSON-Store lädt die gesamte Datei pro Query
  (`historicalStore.ts:353` → `candles.ndjson`). Bei 500 Instrumenten × 5 Timeframes ist
  das der Engpass — aber die *richtige* Behebung ist ein **Index/Partition-Split**, nicht
  sofort ein Formatwechsel mit zusätzlicher Runtime-Abhängigkeit.
- **Worker-Parallelisierung: ✅ richtig priorisiert**, aber mit einer Einschränkung, die
  das Dokument übersieht: `backtestRule()` ist **O(n²)**
  (`ruleEngine.ts:787`: `candles.slice(0, i + 1)` je Bar, danach `buildSnapshotFromCandles`
  mit `closes = candles.map(...)`, `ema(closes, …)` usw.). Die Multi-Asset-Engine hat das
  bereits gelöst (`src/backtest/indicatorCache.ts`, „O(n) vorrechnen"), der
  **Single-Rule-Pfad nicht**. → **STX-12** (diese Prompts priorisieren den Benchmark vor
  der Parallelisierung).

---

## 3. Abhängigkeitsmatrix

```
Phase 0  Messung ─────────────────────────────────────────────┐
  00-01 Benchmark          ──▶ 05-04 Screening-Skalierung      │
  00-02 Stack-SSoT (Doku)   ──▶ alle späteren Phasen            │
  00-03 Vokabular-ADR      ──▶ 03-01/03-02 (StrategyClass)     │
                                  06-01 (Regime-Mapping)       │
                                                             │
Phase 1  BLOCKER ─────────────────────────────────────────────┤
  01-01 Timeframe-Angleichung ──▶ 03-01 ──▶ 05-* ──▶ 06-*    │
                                                             │
Phase 2  Features ─────────────────────────────────────────────┤
  02-01 bollingerBands/donchian ──▶ 02-02 ──▶ 02-03          │
  02-02 bbZScore/priceVs*BbPct   ──▶ 03-06 (Bollinger)        │
  02-03 donchianBreakoutPct      ──▶ 03-08 (Donchian)         │
                                                             │
Phase 3  Template-Kern ────────────────────────────────────────┤
  03-01 types ──▶ 03-02 catalog ──▶ {03-03…03-08 Templates}    │
                    └──▶ 03-09 compiler ──▶ 03-10 tests        │
                                                             │
Phase 4  Persistenz ───────────────────────────────────────────┤
  04-01 Migration ──▶ 04-02 Service (bridged auf lifecycle)   │
                                                             │
Phase 5  Screening  (unabhängig von 3/4, braucht 1+0-01)      │
  05-01 types ──▶ 05-02 builder ──▶ 05-03 persist ──▶ 05-04  │
                                                             │
Phase 6  Validator  (braucht 3, 4, 5)                          │
  06-01 Annahmen ──▶ 06-02 Overfit ──▶ 06-03 Stress            │
                          └──▶ 06-04 Report+Evidence+CLI        │
                                  06-05 Agent (LLM)            │
                                                             │
Phase 7  Copy (unabhängig; KEIN Blocker für 1-6)               │
  07-01 types/mapping/sizing ──▶ 07-02 policy+links            │
                                     07-03 Bitunix-Leader (WS) │
```

**Unabhängig ausführbar:** `00-01`, `00-02`, `07-*` (vollständig parallelisierbar zu 1–6).
**Kritischer Pfad:** `01-01 → 03-01 → 03-09 → 04-01 → 05-04 → 06-04`.

**Zentrale Fehlannahme des Dokuments:** Es behandelt Phase 1 (Timeframes) als nicht
notwendig und setzt sie nirgends in der P0-Reihenfolge. Damit ist **jeder** Screening- und
Validator-Schritt vor Phase 1 blockiert.

---

## 4. Wirtschaftliche und organisatorische Bewertung

### 4.1 Was der Ausbau wirtschaftlich kauft

| Nutzen | Realistisch? |
|---|---|
| Strategien werden **versioniert reproduzierbar** statt als Prompt | ✅ Ja — das ist der eigentliche Hebel. Heute existiert keine Antwort auf „welche Parameter standen in Version 2?" |
| Screening skaliert von „manuell 3 Symbole" auf „systematisch N×M" | ✅ Ja, aber erst nach STX-12 |
| Validator verhindert Promotion schwacher Strategien | ✅ Ja — der Lifecycle hat die Gates bereits, es fehlt nur die Evidenzproduktion |
| Copy-Trading als **eigener Umsatzpfad** | ⚠️ **Nein, nicht im Paper-Repo.** Siehe 4.2 |

### 4.2 Was der Ausbau wirtschaftlich kostet

1. **Copy-Trading verschiebt das Haftungsprofil.** Das Projekt positioniert sich
   explizit als *„Autonome KI-Trading-Firma (Paper-Trading) — BETA (v0.x), nicht
   produktionsreif. … Educational purposes only"*. Ein Copy-Engine, der **fremde**
   Positionen spiegelt, ist in mehreren Rechtsordnungen eine regulierte Tätigkeit
   (Fremdkapitalverwaltung / Anlagevermittlung), unabhängig davon, ob Code oder Menschen
   sie ausüben. Das steht in keinem der 19 Abschnitte des Dokuments. → **STX-16**
2. **Template-Fragilisierung.** Jede neue Regel-Semantik (Bollinger-Z-Score, Donchian,
   Sequenz-Trigger) verändert `RULE_FIELDS`, `RuleSnapshot` **und** den
   IndicatorCache. Das sind drei gekoppelte Stellen plus JSON-Schema plus
   `sanitizeRuleSpec`. Jede Änderung ist ein **Versionsereignis**, kein Feature.
3. **Zwei Wahrheiten.** Regime (STX-03), Strategie-Klasse (STX-02), Cross-Sectional-Spec
   (STX-04) und Stress (STX-11) sind jeweils Stellen, an denen das Dokument eine neue
   neben einer bestehenden baut. Das ist der teuerste Posten — nicht Code, sondern
   dauerhafte Doku- und Test-Duplikation.

### 4.3 Was ausdrücklich **nicht** gebaut werden soll

Das Dokument empfiehlt selbst vier Dinge, die **richtig** sind und übernommen werden:
kein Kafka, `RuleEngine` bleibt deterministisch, Shorts bleiben global gesperrt,
Versionierung statt Überschreiben. Diese vier Einwände werden in der Roadmap als
**Gesperrt-Klauseln** in jedem Prompt festgeschrieben.

---

## 5. Fehlende Aspekte im Ausbaudokument

| # | Fehlender Aspekt | Warum es zählt |
|---|---|---|
| L1 | **Timeframe-Grenze der `RuleSpec`** | Härtester Blocker (STX-01); ohne sie ist Phase 5 nicht umsetzbar |
| L2 | **`StrategyClass`-Mapping** | Sonst zwei Klassifikationsmodelle (STX-02) |
| L3 | **Regime-Vokabular-Entscheidung** | Sonst zwei Regime-Modelle (STX-03) |
| L4 | **`backtest_runs`-Scope** | Sonst kein persistierbares Screening-Ergebnis (STX-07) |
| L5 | **Sequence-Trigger (`RECLAIM`/`CROSS`) als Versionsfrage** | Sie erfordern **Zustand im Executor** — der heutige Evaluator ist zustandslos. Das ist kein `RULE_FIELDS`-Patch, sondern ein Eingriff in `compileRuleSpec()`/`MicroExecutor` mit echter Regressionsgefahr |
| L6 | **O(n²) in `backtestRule()`** | Bestimmt, ob 7.500 Screening-Jobs überhaupt laufen (STX-12) |
| L7 | **Alpaca hat keinen WS** | Zwei der Copy-Prompts des Dokuments sind auf einer falschen Annahme aufgebaut (STX-08) |
| L8 | **Copy-Slippage-Cancel ist unmöglich** | Nachträglich messen statt canceln |
| L9 | **Parity-/Regressionsvertrag mit `indicatorCache`** | Jede neue Formel muss **zwei** Implementierungen deckungsgleich halten — das Repo hat dafür bereits `features:parity` und `backtest.step.nosynthetic.test.ts` als Muster |
| L10 | **Versionierung von `buildRule`-Code** | Ein Template ist Code. `APP_VERSION` allein reicht nicht; das Artefakt braucht einen Code-Hash, sonst ist „Version 3" nicht reproduzierbar |
| L11 | **Begrenzung des Backtest-Trade-Caps** | `RULE_BACKTEST_TRADE_CAP = 200`, `RULE_BACKTEST_EQUITY_CAP = 120` — ein Screening-Lauf darüber ist nicht vergleichbar |
| L12 | **`RULE_BACKTEST_MIN_BARS = 100`** | Bei 5-Strategien × 500-Instrumenten ist die Warmup-Verfügbarkeit der eigentliche Filter, nicht die Strategie |

---

## 6. Priorisierung — Abweichung vom Dokument

Das Dokument setzt **P0** auf: (1) Strategy Catalog, (2) Candidate Matrix.

**Korrigierte P0-Reihenfolge:**

| Rang | Arbeit | Begründung |
|---|---|---|
| **P0-a** | Messung + Vokabular-Entscheidung (00-01…00-03) | Drei offene Fragen, deren Antworten jede spätere Entscheidung prägen. Kein Code-Risiko. |
| **P0-b** | Timeframe-Blocker (01-01) | Ohne ihn sind alle P0-Ziele des Dokuments unerreichbar. |
| **P0-c** | Indikator-Grundlage (02-01…02-03) | Bedingung für 2 der 5 Templates, die das Dokument als P0 führt. |
| **P1** | Template-Kern (03-01…03-10) | Die eigentliche Diagnose des Dokuments. |
| **P1** | Persistenz (04-01, 04-02) | Bedingung für Screening *und* Validator. |
| **P1** | Screening (05-01…05-04) | Value, aber erst nach Messung skalierbar. |
| **P2** | Validator deterministisch (06-01…06-04) | Höchster Hebel auf die Promote-Qualität; braucht 03+04. |
| **P2** | Validator-Agent (06-05) | Erst wenn der deterministische Report existiert. |
| **P3** | Copy-Trading, Paper-only, Bitunix (07-01…07-03) | Unabhängig, aber **organisatorisch** die riskanteste Arbeit. |
| **P3** | Parquet/DuckDB, Multi-Prozess-Bus | Erst wenn Messung L1–L3 aus Phase 0 zeigen, dass es der Engpass ist. |

**Verworfen (bewusst nicht in der Roadmap):** Sequence-Trigger `RECLAIM`/`CROSS`
(→ eigener Audit, siehe L5); `DerivativeStrategySpec` für Shorts (→ eigener Audit);
Kafka (→ bestätigt nicht); Alpaca-WS (→ Voraussetzung ist ein eigener Adapter-Audit).

---

## 7. Ergebnis-Verdikt

| Vorschlag des Dokuments | Verdikt |
|---|---|
| Strategy-Templates als versionierte Artefakte | ✅ **übernehmen** — mit statischem statt dynamischem Builder |
| EMA/ADX, MACD, RSI Templates | ✅ **übernehmen** — unverändert umsetzbar |
| Bollinger-Squeeze Template | ✅ **übernehmen** — **nach** 02-01/02-02 |
| Bollinger-/Donchian-Felder ergänzen | ✅ **übernehmen** — korrekte Diagnose, sauberer Lösungsweg |
| Donchian-Breakout Template | ⚠️ **verschieben** (P1 → nach 02-03) |
| VWAP-Pullback Template | ⚠️ **halbieren** — die `RECLAIM`-Sequenz ist ein eigener Audit |
| Cross-Sectional Momentum Template | ❌ **nicht neu bauen** — `src/crossSectional/` erweitern |
| Candidate Matrix | ✅ **übernehmen** — nach 01-01, mit eigener Tabelle + konfigurierbaren Gewichten |
| Validator-Orchestrator | ✅ **übernehmen** — die Agent/PASS-Trennung ist richtig |
| Cost-Stress ×1/×2/×3 | ⚠️ **an bestehende Monte-Carlo-Stress-Semantik andocken**, nicht neu |
| Regime-Validation (7er-Taxonomie) | ❌ **ablehnen** — bestehendes Vokabular erweitern |
| Copy-Trading Domänenmodell | ✅ **übernehmen** (Paper-only, Bitunix-first) |
| Copy-Reconciler | ⚠️ **ablehnen als neuen Pfad** — bestehende Reconciliation erweitern |
| Alpaca-Leader | ❌ **verschieben** — kein WS vorhanden (eigener Adapter-Audit) |
| Kein Kafka | ✅ **bestätigt** |
| Parquet/DuckDB | ⚠️ **P3** — erst messen (00-01), dann entscheiden |
| OpenCode-Routing-Klassen | ⚠️ **als Policy-Flag, nicht als harte Klassen** — Free-Tier rotiert (STX-13) |

---

## 8. Beta-Positionierung der Roadmap

> **Selbst nach vollständiger Umsetzung aller 32 Prompts bleibt das Projekt in der
> Beta-Phase.** Diese Aussage ist verbindlich in
> [`../../BETA_STATUS.md`](../../BETA_STATUS.md) festgeschrieben.

### 8.1 Warum die Roadmap kein Beta-Exit ist

Das Ausbaudokument beschreibt ausschließlich **Infrastruktur**: Strategie-Artefakte,
Screening, Validierung, Copy-Engine. Jedes dieser Elemente ist ein **Messgerät**.

```
Markt → Scanner → Kandidat → Strategie → Backtest → Validator → Paper
        └──────────────────── MESSGERÄT ───────────────────────┘
                                                    │
                                                    ▼
                                    ERGEBNIS: FAIL / INCONCLUSIVE / PASS
```

Der typische, gesunde Ausgang dieses Prozesses ist eine **Ablehnung**. Eine Pipeline,
die nur `PASS` produziert, hat einen Fehler — typischerweise einen zu laschen Filter
oder ein zu kleines Testfenster. Die Roadmap ist deshalb so gebaut, dass sie
**brauchbare Strategien verwirft**: `INCONCLUSIVE` schlägt `FAIL` (06-04), Annahmen-
Verletzungen blockieren, Holdout-Kontamination wird erkannt (06-02).

### 8.2 Zuordnung Roadmap → Beta-Exit-Kriterien

| Phase | Liefert | Berührt | Erfüllt? |
|---|---|---|---|
| 0 — Messung & ADRs | Performance-Baseline, SSoT, 3 Vokabular-Entscheidungen | — | **nein** |
| 1 — Timeframe-Angleichung | `4h`/`1d` regelformulierbar | — | **nein** |
| 2 — Indikatoren | 4 neue Regel-Felder | — | **nein** |
| 3 — Template-Kern | 6 versionierte Strategie-Artefakte | Instrument für `B2` | **nein** |
| 4 — Versionierte Persistenz | rekonstruierbare Strategieversionen | Instrument für `B1` | **nein** |
| 5 — Candidate Matrix | systematische Versuchsplanung | Instrument für `B1`/`B2` | **nein** |
| 6 — Validator | deterministische Gates + erklärender Agent | Instrument für `B1`/`B2` | **nein** |
| 7 — Copy-Trading | `SIMULATE_ONLY`-Simulation | macht `B5` **sichtbar** | **nein** |

**Ergebnis: 0 von 8 Kriterien, 0 von 8 Phasen.** Das ist kein Mangel der Roadmap,
sondern ihr korrektes Zielbild. Die Kriterien `B1` (Out-of-Sample über 12 Monate
Live-Paper), `B3` (Live-Readiness-Audit über 8 Wochen realer Verkehr), `B5`
(Rechtsprüfung) und `B7` (unabhängige Drittprüfung) verlangen **externe Evidenz**.
Eine Codebasis kann sie nicht selbst erzeugen — das ist die Grenze jedes
selbst-prüfenden Systems.

### 8.3 Die Kopplung, die die Roadmap ausdrücklich verhindert

Phase 7 (Copy-Trading) ist die einzige Stelle, an der diese Roadmap das Produktprofil
tatsächlich verschieben könnte: aus „die Firma handelt für sich" zu „die Firma handelt
für Dritte". Deshalb:

- `CopyMode` ist ein **Enum mit genau einem Wert** (`SIMULATE_ONLY`), kein Env-Flag
  (STX-16, Prompt 07-01)
- der `mode`-CHECK erzwingt das **auf DB-Ebene** (07-02)
- Phase 7 ist **organisatorisch** getrennt: sie erfüllt `B5` nicht, sie macht die
  Frage sichtbar, die `B5` beantworten muss

Eine Roadmap, die am Ende ein Live-Copy-Feature ausliefert, hätte die
Beta-Positionierung stillschweigend aufgehoben — ohne dass ein Kriterium erfüllt
worden wäre. Deshalb steht das Verbot **in den Prompts**, nicht nur hier.

### 8.4 Versionsplan

Alle Releases aus [`VERSIONING.md`](VERSIONING.md) liegen in `0.x`
(`v0.6.0` … `v0.11.2`, verzahnt mit [VERSIONING.md](VERSIONING.md) §2). SemVer: `0.x` heißt in diesem Projekt **Beta**; ein Sprung auf
`1.0` wäre eine Behauptung, die keine Phase dieser Roadmap einlöst.

---

## 9. Verwandte Dokumente

- [`README.md`](README.md) — Audit-Index, Findings-Übersicht
- [`VERSIONING.md`](VERSIONING.md) — Audit-Version, Release-Plan, Bruchstellen
- [`ROADMAP.md`](ROADMAP.md) — 8 Phasen, Gates, Abhängigkeitsgraph
- [`prompts/`](prompts/) — 32 kopierfertige Prompts
- [`remediation/TRACKING.md`](remediation/TRACKING.md) — Status, Gates, offene Punkte
- [`../../BETA_STATUS.md`](../../BETA_STATUS.md) — Beta-Zusage, Kriterien `B1…B8`
