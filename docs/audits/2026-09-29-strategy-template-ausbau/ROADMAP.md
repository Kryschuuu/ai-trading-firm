# Roadmap — Strategie-Templates, Screening, Validator, Copy-Trading

> Grundlage: [`report.md`](report.md) · Findings: [`findings/`](findings/) ·
> Versionierung: [`VERSIONING.md`](VERSIONING.md) ·
> Status: [`remediation/TRACKING.md`](remediation/TRACKING.md) · Ausgangs-Commit `e3509fd`

## ⚠️ Diese Roadmap beendet die Beta-Phase nicht

> **Selbst nach vollständiger Umsetzung aller 32 Prompts bleibt das Projekt in der
> Beta-Phase.** Die Roadmap liefert die **Werkzeuge**, um Produktionsreife zu prüfen —
> nicht deren **Nachweise**. Keine der acht Phasen erfüllt ein Beta-Exit-Kriterium.
> Kriterien `B1…B8`: [`../../BETA_STATUS.md`](../../BETA_STATUS.md) · Begründung:
> [`report.md` §8](report.md#8-beta-positionierung-der-roadmap).

Alle geplanten Releases liegen in `0.x` (`v0.6.0` … `v0.11.2`) — siehe
[`VERSIONING.md`](VERSIONING.md).

## 0. Grundregeln für alle Prompts

**Jeder Prompt ist eine eigene, kleine, abgeschlossene Aufgabe.** Ein Prompt = ein PR
(oder eine Commit-Reihe), der für sich grün ist. Kein Prompt baut auf einem anderen auf,
außer er nennt ihn explizit als Voraussetzung.

### Global gesperrt (in **jedem** Prompt gilt das)

| Gesperrt | Begründung |
|---|---|
| `RuleEngine` darf kein LLM importieren | `ruleEngine.ts:1-25` — „DIE Datei, die bewusst NICHTS über LLMs weiß" |
| Jede erzeugte `RuleSpec` läuft durch `sanitizeRuleSpec()` | STX-05 |
| `RuleAction.side` bleibt `LONG` | `RULE_ALLOWED_SIDE` — Shorts global gesperrt |
| Bestehende Backtest-Läufe bleiben byte-identisch | `executionModel` defaultet auf `"legacy"` |
| Append-only Migrationen | Repo-Konvention (alle `drizzle/*.sql`) |
| Kein Kafka, kein NATS, kein Redis, kein DuckDB | STX-19 — `ws` bleibt einzige neue Runtime-Dependency (die auch schon da ist) |
| `changePct24h` nicht umrechnen | STX-14 |
| Kein Strategie-Klassen-Vokabular, kein Regime-Vokabular, keine Eligibility-Spec, kein Kostenmodell neu erfinden | STX-02 ([ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)), STX-03 ([ADR-009 (E2)](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2)), STX-04 ([ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)), STX-11 |
| Bestehende Tests, `npm run typecheck`, `npm run lint`, `npm run docs:validate` bleiben grün | `CONTRIBUTING.md` |

---

## Phase 0 — Messung & Entscheidungen (kein Produktivcode)

> **Warum zuerst:** Drei Fragen sind offen, deren Antwort jede spätere Architekturentscheidung
> prägt. Phase 0 ändert **kein** Laufzeitverhalten — sie ist die billigste Phase der ganzen
> Roadmap und verhindert die beiden teuersten Fehler (Timeframe-Blocker STX-01,
> Duplikat-Vokabulare STX-02/03/04).

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 00-01 | [Backtest-Perfenz-Baseline](prompts/PROMPT-STX-00-01-backtest-perf-baseline.md) | ✅ [`remediation/BENCH-BASELINE.md`](remediation/BENCH-BASELINE.md) — `backtestRule` O(n^1,99) = 54,1 Kernstunden/7 500 Zellen, Engine O(n^1,01) = 0,44 | — |
| 00-02 | [Strategie-Stack-SSoT](prompts/PROMPT-STX-00-02-strategy-stack-ssot.md) | ✅ [`docs/architecture/STRATEGY_STACK.md`](../../architecture/STRATEGY_STACK.md) (`v0.6.1`) | — |
| 00-03 | [Vokabular-ADR](prompts/PROMPT-STX-00-03-vokabular-adr.md) | ✅ [ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), [ADR-009 (E2)](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), [ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) in [`docs/roadmap/DECISIONS.md`](../../roadmap/DECISIONS.md) (`v0.6.1`) | 00-02 |

**Gate Phase 0 → 1:** 00-03 ist abgeschlossen und die drei Entscheidungen sind
schriftlich fixiert. Ohne dieses Gate wird Phase 1 **nicht** gestartet.

**Ergebnis 00-02/00-03 (2026-09-29, `v0.6.1`):** Gate **G0** ist erfüllt. Die Entscheidungen im Überblick:
[ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1) — Klasse ist Pflichtfeld aus `STRATEGY_CLASS_KEYS`, `unclassified` ist ein Fehler, keine neue Klasse ·
[ADR-009 (E2)](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) — `MarketRegime` (5) + `UNKNOWN` fail-closed, 7er-Taxonomie verworfen ·
[ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) — keine `MultiAssetStrategySpec`, `PortfolioConstruction` liest den Snapshot
(nicht Teil der 32 Prompts). Die Karte der Bausteine: [`STRATEGY_STACK.md`](../../architecture/STRATEGY_STACK.md).

**Zwischenergebnis 00-01 (2026-09-29):** Die Messung ist abgeschlossen; das
Screening-Gate **G5** ist erfüllt — der Single-Rule-Pfad ist quadratisch
(Exponent 1,99), die Engine-linear (1,01). 05-04 fährt über
`runMultiAssetBacktest()`; Einzelheiten: [`remediation/BENCH-BASELINE.md`](remediation/BENCH-BASELINE.md).

---

## Phase 1 — Blocker: Timeframe-Abdeckung

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 01-01 | [Rule-Timeframes angleichen](prompts/PROMPT-STX-01-01-rule-timeframes.md) | ✅ `RuleSpec` auf `1m…5d`; Timeframe-Guard im Mikro-Executor (`v0.6.2`) | 00-03 |

**Warum das der härteste Punkt der Roadmap war:** `RuleWindow.timeframe` war bis `v0.6.1` auf
`1m|5m|15m|30m|1h` beschränkt (`ruleEngine.ts:87,205,883`). Ohne diesen Prompt wären
**alle** Screening- und Validator-Ziele unerreichbar geblieben.

**Abgrenzung ([ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)):** Die Universe-Strategie braucht diesen Prompt nicht — `CrossSectionalConfig.timeframe`
akzeptiert bereits alle zehn `SUPPORTED_TIMEFRAMES`. 01-01 gilt für Einzel-Symbol-Regeln (`4h`/`1d`).

**Gate Phase 1 → 2:** `sanitizeRuleSpec` akzeptiert `4h`/`1d`, verwirft weiterhin
Unbekanntes, und ein Test beweist, dass `1m…1h` unverändert bleibt.

**Ergebnis 01-01 (2026-09-29, `v0.6.2`):** Gate **G1** ist erfüllt. `RULE_ALLOWED_TIMEFRAMES` leitet sich aus
`SUPPORTED_TIMEFRAMES` ab (Heimat: `src/lib/marketdata/timeframes.ts`, ein Vokabular für Regel-Pfad, LLM-Schema,
Mikro-Executor und Workshop-UI); ein Golden-Test belegt `1m…1h` byte-identisch. Der Mikro-Executor wertet nur bis
zu seinem Ausführungsintervall (Default `1h`) aus und weist `2h…5d` sichtbar ab. Zwei Befundkorrekturen:
`vwapPct` war auf `1d` bereits fail-closed (`null`), und „verwerfen“ heißt real „Default `15m`“. Die
Feld-Tabelle je Timeframe: [`BACKTESTING.md` §1.1](../../BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062).

---

## Phase 2 — Indikator-Grundlage

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 02-01 | [Bollinger-Bänder + Donchian](prompts/PROMPT-STX-02-01-indikatoren.md) | ✅ 2 pure Funktionen in `indicators.ts` (`v0.6.3`), BBW-Parität und Lookahead-Test | 00-03 |
| 02-02 | [Bollinger-Regelfelder](prompts/PROMPT-STX-02-02-bollinger-felder.md) | ✅ `bbZScore`, `priceVsUpperBbPct`, `priceVsLowerBbPct` in Snapshot + Cache (`v0.6.4`), Paritätstest und Golden-Hash | 02-01, 01-01 |
| 02-03 | [Donchian-Regelfeld](prompts/PROMPT-STX-02-03-donchian-feld.md) | ✅ `donchianBreakoutPct` in Snapshot + Cache (`v0.6.5`), Lookahead-/O(n)-/Paritätstest | 02-01, 01-01 |
| 02-04 | *optional* [Feature-Store-Slice `rule.*`](prompts/PROMPT-STX-02-04-featurestore-rule-slice.md) | PIT-Materialisierung + Parität | 02-02, 02-03 |

**Stand 2026-09-30:** 02-01, 02-02 und 02-03 abgeschlossen (Formeln + Bollinger- **und**
Donchian-Regelfeld in Snapshot und Cache, Parität getestet). Damit ist die Feldseite
komplett; offen in Phase 2 ist nur der **optionale** Feature-Store-Slice 02-04
(STX-10). Donchian-Template 03-08 muss mindestens `1h` erlauben, nicht
niedrigere Timeframes (geplant: `1h`, `4h`).

**Reihenfolge-Logik:** 02-01 ist die Voraussetzung für 02-02 **und** 02-03. Ohne
02-02/02-03 sind die Templates 03-06 (Bollinger) und 03-08 (Donchian) nicht
referenzierbar. 02-04 ist **optional** und blockiert nichts (STX-10).

**Achtung Parität:** Jede neue Formel muss **zwei** Implementierungen deckungsgleich halten —
`buildSnapshotFromCandles` (`ruleEngine.ts`) und `buildIndicatorCache`
(`src/backtest/indicatorCache.ts`). Der Cache ist **nicht** automatisch mitgepflegt.
02-02 setzt das um: `tests/backtest.multiAsset.test.ts` vergleicht die drei Bollinger-Felder
Bar für Bar über drei Symbole und hält über einen Golden-Hash fest, dass Läufe ohne
Bollinger-Feld byte-identisch bleiben.
02-03 setzt dasselbe für `donchianBreakoutPct` um (Bar-für-Bar-Parität über drei
Symbole, Golden-Hash unverändert) und belegt zusätzlich per Lookahead-Test, dass das
Kanalhoch ausschließlich aus den **vorigen** 20 Kerzen stammt, sowie per Quelle-Review-Test,
dass der Cache das laufende Maximum in O(n) über eine monotone Deque führt.

---

## Phase 3 — Template-Kern (die eigentliche Diagnose des Dokuments)

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 03-01 | [Template-Typen](prompts/PROMPT-STX-03-01-template-types.md) | `src/strategies/types.ts` | 01-01, 00-03 |
| 03-02 | [Katalog + Validierung](prompts/PROMPT-STX-03-02-catalog.md) | `src/strategies/catalog.ts` | 03-01 |
| 03-03 | [Template: EMA/ADX Trend](prompts/PROMPT-STX-03-03-template-ema-adx.md) | 1 Template | 03-02 |
| 03-04 | [Template: MACD Momentum](prompts/PROMPT-STX-03-04-template-macd.md) | 1 Template | 03-02 |
| 03-05 | [Template: RSI Mean-Reversion](prompts/PROMPT-STX-03-05-template-rsi.md) | 1 Template | 03-02 |
| 03-06 | [Template: Bollinger Squeeze](prompts/PROMPT-STX-03-06-template-bollinger.md) | 1 Template | 03-02, 02-02 |
| 03-07 | [Template: VWAP (Snapshot)](prompts/PROMPT-STX-03-07-template-vwap.md) | 1 Template | 03-02 |
| 03-08 | [Template: Donchian Breakout](prompts/PROMPT-STX-03-08-template-donchian.md) | 1 Template | 03-02, 02-03 |
| 03-09 | [Compiler + Sanitize-Nachweis](prompts/PROMPT-STX-03-09-compiler.md) | `src/strategies/compiler.ts` | 03-03…03-08 |
| 03-10 | [Template-Tests](prompts/PROMPT-STX-03-10-template-tests.md) | `tests/strategies.*.test.ts` | 03-09 |

**Reihenfolge-Logik:** 03-01 → 03-02 ist das Fundament. Die fünf Template-Prompts sind
bewusst **einzeln** — jedes ist ~60 Zeilen, liefert sofort einen lauffähigen
Katalogeintrag und hat keine Abhängigkeit von den anderen. 03-09 kommt **vor** 03-10,
weil der Compiler die Sanitize-Kette beweisen muss, bevor Tests ihn fixieren.

**Vokabular-Bindung:** `class: StrategyClassKey` (Pflicht, `unclassified` = Fehler, `CompileResult.strategyClass`) nach [ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1);
`expectedRegimes: readonly MarketRegime[]` (ohne `UNKNOWN`) nach [ADR-009 (E2)](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2); `scope: "SINGLE_SYMBOL"` nach [ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3).

**Was hier bewusst NICHT gebaut wird:** Sequenz-Trigger `RECLAIM`/`CROSS` (STX-18) und
`MultiAssetStrategySpec` (STX-04, [ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)).

---

## Phase 4 — Versionierte Persistenz

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 04-01 | [Migration `strategy_definitions`/`strategy_versions`](prompts/PROMPT-STX-04-01-strategy-persistenz-migration.md) | 2 append-only Tabellen | 03-09 |
| 04-02 | [Service + Lifecycle-Bridging](prompts/PROMPT-STX-04-02-strategy-service.md) | `src/strategies/service.ts` | 04-01, 00-02 |

**Vokabular-Bindung:** `strategy_class` mit CHECK auf die drei Klassen, ohne `unclassified` ([ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)).

**Warum nicht im Dokument priorisiert, sondern hier:** Das Dokument nennt die Tabellen in
§7, führt sie aber nicht als P0. Ohne sie hat der Lifecycle-Key
`("ema-adx", 3)` keinen auflösbaren Inhalt — Version 3 wäre nicht rekonstruierbar.

---

## Phase 5 — Candidate Matrix / Screening

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 05-01 | [Screening-Typen + Priorität](prompts/PROMPT-STX-05-01-screening-types.md) | `src/screening/types.ts` + `priority.ts` | 00-01, 03-01 |
| 05-02 | [Matrix-Builder](prompts/PROMPT-STX-05-02-matrix-builder.md) | Matrix aus Scanner-Funnel | 05-01, 01-01 |
| 05-03 | [Persistenz + Idempotenz](prompts/PROMPT-STX-05-03-screening-persistenz.md) | 2 Tabellen | 05-02, 04-01 |
| 05-04 | [CLI + Backtest-Job-Adapter](prompts/PROMPT-STX-05-04-screening-cli.md) | `scripts/run-screening.ts` | 05-03, 00-01 |

**Vokabular-Bindung:** `strategyClass: StrategyClassKey` in den Screening-Typen ([ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)); `crossSectionalMomentum` bleibt ein
optionaler, lesender Faktor (`CrossSectionalRankContext`), keine zweite Eligibility ([ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)).

**Die 0.30/0.25/0.20/…-Gewichte aus §4.3 des Dokuments werden in 05-01 konfigurierbar
gemacht** (Muster `src/scanner/config.ts`) und mit einem Invarianztest festgeschrieben.

**Skalierungs-Gate:** 05-04 startet mit `--dry-run` und einem harten
`--max-cells`-Bound. 00-01 hat gezeigt, dass ein Lauf ≤ Zeitbudget liegt — **aber nur
über `runMultiAssetBacktest()`** (7 500 Zellen = 0,44 Kernstunden; über `backtestRule()`
wären es 54,14). Der echte Backtest-Adapter wird freigeschaltet, wenn er am
Engine-Pfad hängt ([`remediation/BENCH-BASELINE.md`](remediation/BENCH-BASELINE.md) §6).

---

## Phase 6 — Validator

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 06-01 | [Annahmen-Audit (deterministisch)](prompts/PROMPT-STX-06-01-assumptions-audit.md) | `src/strategies/validator/assumptions.ts` | 03-09 |
| 06-02 | [Overfit & Robustheit](prompts/PROMPT-STX-06-02-overfit.md) | `overfit.ts` | 06-01, 04-02 |
| 06-03 | [Cost-Stress-Runner](prompts/PROMPT-STX-06-03-cost-stress.md) | `stress.ts` | 06-01 |
| 06-04 | [Report + Evidence + CLI](prompts/PROMPT-STX-06-04-validation-report.md) | `report.ts` + `scripts/run-validate-strategy.ts` | 06-02, 06-03, 04-02 |
| 06-05 | [Validator-Agent (LLM)](prompts/PROMPT-STX-06-05-validator-agent.md) | `agent.ts` + Routing-Klassen | 06-04 |

**Reihenfolge-Logik:** Der Agent kommt **zuletzt**. Ein LLM-Auditor über einen
nicht-deterministischen Report ist wertlos. 06-01…06-04 sind reine Funktionen ohne
Netzwerk; 06-05 ist die einzige Stelle mit LLM-Zugriff — und sie darf ausschließlich
`detail jsonb` schreiben, nie `result`.

**Was 06-02/06-03 wiederverwenden (nicht neu bauen):**
- `WalkForwardCandidate` + `SelectorGates` + `CandidateScoreRow` + `FreezeArtifact` (Plateau-Messung)
- `MonteCarloStressConfig { feeMultiplier, slippageMultiplier }` (post-hoc)
- `BacktestEngineConfig.feeModel` / `slippageModel` (in-engine)
- `regimeEvaluation.ts`: Vokabular und `RegimeEvalRow` ([ADR-009 (E2)](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2)) — `evaluateRegimeOos` misst den Markt, die Strategie je Regime
  misst der Aggregator in 06-04; `UNKNOWN` wird ausgeschlossen

---

## Phase 7 — Copy-Trading (Paper-only, Bitunix-first)

> **Unabhängig** von Phase 1–6. Kann parallel laufen. **Organisatorisch** die riskanteste
> Arbeit des Projekts (STX-16) — `README.md` positioniert die Firma als Paper-Trading,
> „nicht produktionsreif, educational purposes only".

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 07-01 | [Copy-Typen, Mapping, Sizing](prompts/PROMPT-STX-07-01-copy-domain.md) | `src/copy/{types,mapping,sizing}.ts` (rein) | 00-02 |
| 07-02 | [Policy-Engine + Order-Links](prompts/PROMPT-STX-07-02-copy-policy.md) | `policy.ts` + `copy_order_links` | 07-01 |
| 07-03 | [Bitunix-Leader-Adapter](prompts/PROMPT-STX-07-03-copy-leader-bitunix.md) | Leader-Quelle + Simulate-only-Follower | 07-02 |

**Abgrenzung ([ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)):** Das `SizingMode` aus 07-01 (Follower-Notional) gehört zur Copy-Domäne und ist nicht
`PortfolioConstruction`.

**Alpaca ist NICHT in dieser Roadmap** (STX-08: kein WS vorhanden → eigener Adapter-Audit).
**Kein Reconciler** (STX-09: `executionQuality` existiert). **Kein Slippage-Cancel**
(nachträglich messen, nicht stornieren).

---

## Reihenfolge- und Abhängigkeitsübersicht

```
00-01 ─────────────────────────────▶ 05-04 (Skalierungs-Gate)
00-02 ──▶ 00-03 ──┬──▶ 01-01 ──┬──▶ 02-02 ──▶ 03-06 ─┐
                  │             └──▶ 02-03 ──▶ 03-08 ─┤
                  ├──▶ 02-01 ──┘                       │
                  └──▶ 03-01 ──▶ 03-02 ──▶ 03-03…03-07 ┴──▶ 03-09 ──▶ 03-10
                                    │                        │
                                    └──▶ 04-01 ──▶ 04-02 ──┴──▶ 05-01 ──▶ 05-02 ──▶ 05-03
                                                                                    │
                                    03-09 ──▶ 06-01 ──▶ 06-02 ──▶ 06-04 ◀──────────┘
                                            └──────▶ 06-03 ─────┘       │
                                                                      06-05
00-02 ──▶ 07-01 ──▶ 07-02 ──▶ 07-03      (vollständig unabhängig)
```

**Kritischer Pfad:** `00-03 → 01-01 → 03-01 → 03-02 → 03-09 → 04-01 → 04-02 → 05-… → 06-04`
**Längster Pfad:** `00-01 → 05-01 → 05-02 → 05-03 → 05-04` (Screening)
**Schnellster greifbarer Nutzen:** `03-03` (EMA/ADX-Template) nach 5 Voraussetzungen

---

## Abgelehnte / vertagte Vorschläge

| Vorschlag | Status | Begründung |
|---|---|---|
| Kafka | ❌ | STX-19 |
| Parquet/DuckDB | ⏸ P3 | 00-01 gemessen: Store+Cache tragen die Matrix — kein Bedarf, offen für spätere Zellzahlen |
| `MultiAssetStrategySpec` | ❌ | STX-04, [ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) — `CrossSectionalConfig` bleibt die Wahrheit; `PortfolioConstruction` liest den Snapshot |
| `PortfolioConstruction`-Schicht (Universe-Gewichte) | ⏸ eigener Prompt außerhalb der 32 | [ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) — Form fixiert, nicht Teil dieser Roadmap |
| Regime-Taxonomie (7er) | ❌ | STX-03, [ADR-009 (E2)](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) — bestehendes `MarketRegime` |
| Eigene/neue Strategieklasse (z. B. `momentum`) | ❌ | STX-02, [ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1) — `STRATEGY_CLASS_KEYS` |
| Sequence-Trigger `RECLAIM`/`CROSS` | ⏸ eigener Audit | STX-18 — zustandsloser Evaluator |
| `DerivativeStrategySpec` (Shorts) | ⏸ eigener Audit | §13 des Dokuments, bestätigt richtig |
| Alpaca-Leader | ⏸ eigener Adapter-Audit | STX-08 |
| Copy-Reconciler | ❌ | STX-09 — `executionQuality` erweitern |
| Live-Copy | ❌ | STX-16 |
| Neues Kosten-/Stressmodell | ❌ | STX-11 — vorhandene Semantik nutzen |
