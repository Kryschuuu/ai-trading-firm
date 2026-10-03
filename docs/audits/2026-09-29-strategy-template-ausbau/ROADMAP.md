# Roadmap — Strategie-Templates, Screening, Validator, Copy-Trading

> Grundlage: [`report.md`](report.md) · Findings: [`findings/`](findings/) ·
> Versionierung: [`VERSIONING.md`](VERSIONING.md) ·
> Status: [`remediation/TRACKING.md`](remediation/TRACKING.md) · Ausgangs-Commit `e3509fd`
>
> **Vollabgleich 2026-10-03 + STX-08-04-Abschluss** (Audit `v1.2.4`): der historische Abgleich
> verifizierte alle 21 Findings gegen `main` @ `3d13161` —
> [`remediation/RECONCILE-2026-10-03.md`](remediation/RECONCILE-2026-10-03.md). Nach dem
> 08-04-Fix: **21 Findings** — 18 FIXED, 1 PARTIAL ([STX-14](findings/STX-14-changepct24h-semantik.md)),
> 2 OPEN ([STX-08](findings/STX-08-alpaca-ohne-websocket.md),
> [STX-21](findings/STX-21-localfree-cloud-endpoint.md)). **Alle 32 Ursprungs-Prompts
> umgesetzt.** In **Phase 8** sind 08-01…08-04 erledigt; 08-05/STX-21 bleibt offen.

## ⚠️ Diese Roadmap beendet die Beta-Phase nicht

> **Selbst nach vollständiger Umsetzung aller 32 Prompts bleibt das Projekt in der
> Beta-Phase.** Die Roadmap liefert die **Werkzeuge**, um Produktionsreife zu prüfen —
> nicht deren **Nachweise**. Keine der acht Phasen erfüllt ein Beta-Exit-Kriterium.
> Kriterien `B1…B8`: [`../../BETA_STATUS.md`](../../BETA_STATUS.md) · Begründung:
> [`report.md` §8](report.md#8-beta-positionierung-der-roadmap).

Alle geplanten Releases liegen in `0.x` (`v0.6.0` … `v0.11.1`) — siehe
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
| 02-04 | *optional* [Feature-Store-Slice `rule.*`](prompts/PROMPT-STX-02-04-featurestore-rule-slice.md) | ✅ `rule.*@1` Slice (commit `7995822`, PR #188-Vorstufe, Doku `docs/FEATURE_STORE.md` §3.2): `rule.bb_zscore`, `rule.price_vs_upper_bb_pct`, `rule.donchian_breakout_pct` in `src/features/definitions.ts` + `compute.ts`, PIT-Materialisierung, Paritätstest `tests/ruleFeatureStoreParity.test.ts` | 02-02, 02-03 |

**Stand 2026-10-03:** 02-01, 02-02, 02-03 **und** 02-04 abgeschlossen (Formeln + Bollinger- **und**
Donchian-Regelfeld in Snapshot und Cache, Parität getestet, **inkl. optionalem** Feature-Store-Slice 02-04
— commit `7995822` `feat(features): add rule.* feature store slice`, STX-10 damit umgesetzt). Damit ist die
Feldseite inkl. Store-Anbindung komplett; Phase 2 ist vollständig. Donchian-Template 03-08 muss mindestens `1h`
erlauben, nicht niedrigere Timeframes (geplant: `1h`, `4h`).

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
| 03-01 | [Template-Typen](prompts/PROMPT-STX-03-01-template-types.md) | ✅ `src/strategies/types.ts` (`v0.7.0`) | 01-01, 00-03 |
| 03-02 | [Katalog + Validierung](prompts/PROMPT-STX-03-02-catalog.md) | ✅ `src/strategies/catalog.ts` (`v0.7.0`) | 03-01 |
| 03-03 | [Template: EMA/ADX Trend](prompts/PROMPT-STX-03-03-template-ema-adx.md) | ✅ 1 Template (`v0.7.1`) | 03-02 |
| 03-04 | [Template: MACD Momentum](prompts/PROMPT-STX-03-04-template-macd.md) | ✅ 1 Template (`v0.7.2`) | 03-02 |
| 03-05 | [Template: RSI Mean-Reversion](prompts/PROMPT-STX-03-05-template-rsi.md) | ✅ 1 Template (`v0.7.3`, erste Klasse `mean-reversion`) | 03-02 |
| 03-06 | [Template: Bollinger Squeeze](prompts/PROMPT-STX-03-06-template-bollinger.md) | ✅ 1 Template (`v0.7.4`, erste Klasse `breakout`, `bbZScore` aus 02-02; σ-Korrektur siehe [SSoT §1.1](../../architecture/STRATEGY_STACK.md#11-bollinger-squeeze-stx-03-06-v074)) | 03-02, 02-02 |
| 03-07 | [Template: VWAP (Snapshot)](prompts/PROMPT-STX-03-07-template-vwap.md) | ✅ 1 Template (`v0.7.4`, zustandsloser Tages-Bias, kein Pullback/Reclaim) | 03-02 |
| 03-08 | [Template: Donchian Breakout](prompts/PROMPT-STX-03-08-template-donchian.md) | ✅ 1 Template (`v0.7.4`, Higher-Timeframe-only, `donchianBreakoutPct` aus 02-03) | 03-02, 02-03 |
| 03-09 | [Compiler + Sanitize-Nachweis](prompts/PROMPT-STX-03-09-compiler.md) | ✅ `src/strategies/compiler.ts` (`v0.7.5`, STX-05 behoben: einziger Aufrufer von `buildRule` + `sanitizeRuleSpec()`, `clamped`-Nachweis, `stc1:`-Fingerprint, `exportTemplates()`; Beweis `tests/strategies.compiler.security.test.ts`) | 03-03…03-08 |
| 03-10 | [Template-Tests](prompts/PROMPT-STX-03-10-template-tests.md) | ✅ `tests/strategies.templates.test.ts` (`v0.7.6`, 60 Tests: Struktur, Compiler-Parität, Positiv-/Negativ-Fixtures je Template × Takt, Katalog-Integrität, Engine-↔-Cache-Parität) + generierte Doku `docs/STRATEGY_TEMPLATES.md`; Beweis für Gate G3 | 03-09 |

**Reihenfolge-Logik:** 03-01 → 03-02 ist das Fundament. Die fünf Template-Prompts sind
bewusst **einzeln** — jedes ist ~60 Zeilen, liefert sofort einen lauffähigen
Katalogeintrag und hat keine Abhängigkeit von den anderen. 03-09 kommt **vor** 03-10,
weil der Compiler die Sanitize-Kette beweisen muss, bevor Tests ihn fixieren; 03-09
wurde mit `v0.7.5` ausgeliefert (eigenes Release, weil der Übergang sicherheitskritisch
und einzeln rollbackbar ist), 03-10 mit `v0.7.6`. **Phase 3 ist damit abgeschlossen,
Gate G3 erfüllt** — sechs Templates kompilieren über den unveränderten
Sicherheitspfad und sind vertraglich abgesichert.

**Vokabular-Bindung:** `class: StrategyClassKey` (Pflicht, `unclassified` = Fehler, `CompileResult.strategyClass`) nach [ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1);
`expectedRegimes: readonly MarketRegime[]` (ohne `UNKNOWN`) nach [ADR-009 (E2)](../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2); `scope: "SINGLE_SYMBOL"` nach [ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3).

**Was hier bewusst NICHT gebaut wird:** Sequenz-Trigger `RECLAIM`/`CROSS` (STX-18) und
`MultiAssetStrategySpec` (STX-04, [ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)).

---

## Phase 4 — Versionierte Persistenz

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 04-01 | [Migration `strategy_definitions`/`strategy_versions`](prompts/PROMPT-STX-04-01-strategy-persistenz-migration.md) | ✅ `v0.8.0` (commit `7f28e82`, PR #201): 2 append-only Tabellen + Drizzle-Schema + DB-/Rollback-Tests; kein Schreibpfad | 03-09 ✅ |
| 04-02 | [Service + Lifecycle-Bridging](prompts/PROMPT-STX-04-02-strategy-service.md) | ✅ `src/strategies/service.ts` (`v0.10.4`, commit `66be0c6`, PR #202, Fix `9d73aeb` PR #203): `ensureDefinition()`, `createVersion()`, `calculateVersionContentHash()` (`stv1:`/`stc1:`), Lifecycle-Bridging über `recordEvidence()`, `STRATEGY_CLASSES` aus SSoT, Audit `STRATEGY_VERSION_CREATED` | 04-01, 00-02 |

**Ergebnis 04-01 (2026-10-01, `v0.8.0`, commit `7f28e82`):** Das Schema für Definitionen und
unveränderliche Strategie-Versionen ist idempotent angelegt. Es gibt keinen
Backfill und keinen Anwendungsschreibpfad; STX-06 bleibt bis 04-02 in Arbeit.
Die Lifecycle-Tabellen bleiben unangetastet; der optionale nullable FK ist wegen
des ausdrücklichen Locks nicht Teil dieses freigegebenen Scopes.

**Ergebnis 04-02 (2026-10-02, `v0.10.4`, commit `66be0c6` PR #202, Fix `9d73aeb` PR #203):** Der Service ist
Registry, kein Executor: `ensureDefinition()` legt `strategy_definitions` idempotent an,
`createVersion()` kompiliert über `compileTemplate()` und persistiert `strategy_versions` mit
`fingerprint = stc1:<sha256>` und `content_hash = stv1:<sha256>` (Idempotenzanker für 05-03/05-04).
`calculateVersionContentHash()` nutzt `canonicalJson`. Lifecycle-Bridging erfolgt ausschließlich
über `recordEvidence()` (kein `requestTransition`). `STRATEGY_CLASSES` wird aus der SSoT
`src/lib/marketRegime.ts` gelesen (vierter Altlast-Fall aus 00-03 damit behoben). Audit-Event
`STRATEGY_VERSION_CREATED` ist im `AUDIT_EVENT_CATALOG` beschrieben. Tests:
`tests/strategyCatalog.db.test.ts` + `tests/strategyCatalog.service.test.ts` + `tests/adrVocabulary.test.ts`.

**Vokabular-Bindung:** `strategy_class` mit CHECK auf die drei Klassen, ohne `unclassified` ([ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)).

**Warum nicht im Dokument priorisiert, sondern hier:** Das Dokument nennt die Tabellen in
§7, führt sie aber nicht als P0. Ohne sie hat der Lifecycle-Key
`("ema-adx", 3)` keinen auflösbaren Inhalt — Version 3 wäre nicht rekonstruierbar.

---

## Phase 5 — Candidate Matrix / Screening

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 05-01 | [Screening-Typen + Priorität](prompts/PROMPT-STX-05-01-screening-types.md) | ✅ `src/screening/types.ts` + `priority.ts` (`v0.9.0`-Vorstufe, commit `a90fa62`, PR #204): `SCREENING_RUN_KINDS`, `CandidateStatus`, `SCREENING_CELL_RESULTS`, `StrategyMarketCandidate`, konfigurierbare Gewichte mit Invarianztest | 00-01, 03-01 |
| 05-02 | [Matrix-Builder](prompts/PROMPT-STX-05-02-matrix-builder.md) | ✅ `src/screening/matrix.ts` (`v0.9.0`-Vorstufe, commit `4267715`, PR #205): Matrix aus Scanner-Funnel, `buildCandidateMatrix()`, Filterung nach Datenqualität/Liquidität/Freshness, bounded Reads | 05-01, 01-01 |
| 05-03 | [Persistenz + Idempotenz](prompts/PROMPT-STX-05-03-screening-persistenz.md) | ✅ `v0.9.0`-Vorstufe / Unreleased auf `v0.8.0` (commit `211e022`, PR #206): 2 additive Tabellen `strategy_screening_runs`/`strategy_market_results`, transaktionaler Store, `ssr1:`/`ssm1:` (`canonicalJson`), immutable Zellen, monotone Fortschritte, DB-/Schema-Paritätstests | 05-02, 04-01 |
| 05-04 | [CLI + Backtest-Job-Adapter](prompts/PROMPT-STX-05-04-screening-cli.md) | ✅ `src/screening/{runner,backtestAdapter}.ts` + `scripts/run-screening.ts` (`v0.9.0`, commit `c797ae7`, PR #207): `runScreening()`, `runMultiAssetBacktest()` als einziger Engine-Pfad (`SCREENING_BACKTEST_PATH = "multiAsset"`), CLI `npm run screening` mit `--dry-run` Default, `--max-cells`, bounded Concurrency, Pilot-Runbook | 05-03, 00-01 |

**Ergebnis 05-01 (2026-10-01, commit `a90fa62`):** Screening-Typen und Prioritätsbewertung sind reine Verträge
(`types.ts` + `priority.ts`), ohne Scanner-/Store-/Registry-Importe. `scoreCandidate()` bleibt `null` bei
nicht belegbaren Metriken; Korrelationszuschlag `null` = kein Zuschlag. Gewichte aus §4.3 des Dokuments sind
konfigurierbar (Muster `src/scanner/config.ts`) und per Invarianztest fixiert.

**Ergebnis 05-02 (2026-10-01, commit `4267715`):** `buildCandidateMatrix()` baut die Strategie×Markt-Matrix aus dem
Scanner-Funnel (READY-Artefakt + Volumen-Rückfall), klassifiziert nach Datenqualität/Liquidität/Freshness und
liefert `StrategyMarketCandidate` mit `priority` und `reasons`. Bounded Reads, keine Prioritäts-Überschreibung.

**Ergebnis 05-03 (2026-10-01, commit `211e022`):** Screening-Persistenz liegt in eigenen Run-/Zelltabellen
(`strategy_screening_runs`/`strategy_market_results`); `backtest_runs` bleibt single-instrument und unverändert.
Strategieversions-FK ist Pflicht, Backtest-Link optional. `ssr1:`/`ssm1:`-Idempotenz über `canonicalJson`,
transaktionaler Store, monotone Fortschritte, kein DELETE-/Prioritäts-Overwrite-Pfad. Details/Migration/Rollback:
[STRATEGY_SCREENING.md](../../STRATEGY_SCREENING.md). DB-Tests beweisen SQL-/Drizzle-Parität.

**Ergebnis 05-04 (2026-10-02, `v0.9.0`, commit `c797ae7`):** Runner (`runScreening()`), Backtest-Job-Adapter
(`runMultiAssetBacktest()` als einziger Screening-Engine-Pfad; laut damaliger Prä-Cache-Messung in `BENCH-BASELINE.md` §6 121,7× schneller als das damalige `backtestRule()`) und CLI (`npm run screening`, `--dry-run` Default, `--execute` für echten Lauf) sind umgesetzt
und mit 38 Tests belegt — harte `maxCells`, Caps ⇒ `BLOCKED` statt Kappung, bounded Concurrency ohne
`worker_threads`, bounded Telemetrie, Abbruch ⇒ `ABORTED` mit Fortsetzung über `--run-id`. `backtest_run_id`
bleibt bewusst `null` (Naht: `persist`-Hook im Adapter). Pilot-Runbook: `remediation/SCREENING-PILOT.md`
(50 Zellen, >1 Kernstunde ⇒ Pilot blockiert und Ursache untersucht; STX-12 ist seit `v0.11.0` geschlossen). Gate G5 erfüllt, G6 Pilot offen.

**Vokabular-Bindung:** `strategyClass: StrategyClassKey` in den Screening-Typen ([ADR-008 (E1)](../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)); `crossSectionalMomentum` bleibt ein
optionaler, lesender Faktor (`CrossSectionalRankContext`), keine zweite Eligibility ([ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)).

**Die 0.30/0.25/0.20/…-Gewichte aus §4.3 des Dokuments werden in 05-01 konfigurierbar
gemacht** (Muster `src/scanner/config.ts`) und mit einem Invarianztest festgeschrieben (commit `a90fa62`).

**Skalierungs-Gate (erfüllt):** 05-04 startet mit `--dry-run` und einem harten
`--max-cells`-Bound. Die historische 00-01-Messung vor 08-04 zeigte, dass ein Lauf ≤ Zeitbudget liegt — **aber nur
über `runMultiAssetBacktest()`** (7 500 Zellen = 0,44 Kernstunden; das damalige O(n²)-`backtestRule()`
wurde mit 54,14 Kernstunden hochgerechnet). Heute nutzt `backtestRule()` den Cache; der Screening-Adapter bleibt unverändert. Der echte Backtest-Adapter ist freigeschaltet und hängt am
Engine-Pfad (`src/screening/backtestAdapter.ts`, `SCREENING_BACKTEST_PATH = "multiAsset"`,
Entscheidung in [`remediation/BENCH-BASELINE.md`](remediation/BENCH-BASELINE.md) §6, commit `c797ae7`).

---

## Phase 6 — Validator

| # | Prompt | Ergebnis | Hängt ab von |
|---|---|---|---|
| 06-01 | [Annahmen-Audit (deterministisch)](prompts/PROMPT-STX-06-01-assumptions-audit.md) | ✅ `src/strategies/validator/assumptions.ts` (`v0.10.0`): elf Prüfungen über injizierte `*Facts`, `UNKNOWN` statt Scheingenauigkeit, `assumptionGate()` | 03-09 |
| 06-02 | [Overfit & Robustheit](prompts/PROMPT-STX-06-02-overfit.md) | ✅ `src/strategies/validator/overfit.ts` (`v0.10.1`): Plateau-`robustShare`, IS/OOS-Lücke (`oosSharpe <= 0` ⇒ `BROKEN`), Multiple-Testing bis `BLOCKING` ab 21 Kandidaten, Holdout-Integrität (`CONTAMINATED` ⇒ `INCONCLUSIVE`) | 06-01, 04-02 |
| 06-03 | [Cost-Stress-Runner](prompts/PROMPT-STX-06-03-cost-stress.md) | ✅ `src/strategies/validator/stress.ts` (`v0.10.2`): `COST_STRESS_SCENARIOS` (1×/2×/3×, 5/10/20 bp), `runInEngineStress()`, `summarizeStressSweep()` (`degradationRatio`, `breakevenMultiplier`), `runPostHocStress()`, `maxRuns = 45` (`--max-runs`) | 06-01 |
| 06-04 | [Report + Evidence + CLI](prompts/PROMPT-STX-06-04-validation-report.md) | ✅ `src/strategies/validator/report.ts` + `persist.ts` (`v0.10.3`): achtstufige Gate-Kette (`PASS`/`FAIL`/`INCONCLUSIVE`, kein Score), Regime-Aggregation point-in-time, `recordEvidence()`-Writer, CLI `npm run validate:strategy` | 06-02, 06-03, 04-02 |
| 06-05 | [Validator-Agent (LLM)](prompts/PROMPT-STX-06-05-validator-agent.md) | ✅ `agent.ts` + `agentPrompt.ts` (`v0.10.4`): allowlistete Aggregatprojektion, striktes JSON-Schema, Injection-Block, Shadow-Default, `LOCAL_FREE` / opt-in `OPENCODE_FREE`, bounded Telemetrie; keine Verdict- oder Persistenzänderung | 06-04 |

**Ergebnis 06-01 (2026-10-02, `v0.10.0`):** Der Annahmen-Audit ist das Gate vor
jeder Metrik-Auswertung — 38 Tests, [`docs/STRATEGY_VALIDATION.md`](../../STRATEGY_VALIDATION.md).

**Ergebnis 06-02 (2026-10-02, `v0.10.1`):** Die Overfit- & Robustheitsauswertung
liest den vorhandenen Walk-Forward-Nachbarschafts-Scan, statt ihn neu zu bauen:
`plateauMetrics()` misst die Breite des stabilen Bereichs (`robustShare`), nicht
den Optimum-Punkt; `trainOosGap()` lässt **nie** den IS-Sharpe allein entscheiden
(`oosSharpe <= 0` ⇒ `BROKEN`); `multipleTestingWarning()` blockiert ab 21
Kandidaten; `holdoutIntegrity()` erkennt Kontamination (`INCONCLUSIVE`).
Fehlende Score-Tabellen sind `UNKNOWN` mit Grund. Keine Änderung an
`walkforward.ts`, keine Kandidatengenerierung, keine IO/Uhr — 39 Tests.

**Ergebnis 06-03 (2026-10-02, `v0.10.2`):** Der Cost- & Slippage-Stress-Runner
(`src/strategies/validator/stress.ts`) schließt **STX-11** ohne drittes
Kostenmodell: In-Engine-Walk-Forward-Sweep über `COST_STRESS_SCENARIOS`
(`base` byte-identisch zum Referenzlauf, `slippageModel: "none"` ⇒ `{ ok: false }`,
`executionModel` unverändert), `summarizeStressSweep()` mit `degradationRatio`,
linearer Interpolation von `breakevenMultiplier` (`null` ⇒ „hält mindestens 3×")
und Verdikten `COST_ROBUST`/`COST_SENSITIVE`/`COST_DEPENDENT` sowie dünner
Durchreiche `runPostHocStress()` an `runMonteCarloSimulation()` (im Report
strikt getrennt). Laufzeit-Bounds: `DEFAULT_MAX_STRESS_RUNS = 45` (`--max-runs`).
22 Tests.

**Ergebnis 06-04 (2026-10-02, `v0.10.3`):** Report, Gate-Kette und Evidenz
sind implementiert. `buildValidationReport()` (rein, keine Uhr/DB/Zufall) fällt
genau ein Urteil aus `PASS|FAIL|INCONCLUSIVE`; die acht Stufen laufen in fester
Reihenfolge, die erste ohne `PASS` entscheidet und alle späteren stehen als
`SKIPPED` im `gates[]`-Protokoll — kein Score, keine Gewichtung. Fehlende
Vorstufen sind immer `INCONCLUSIVE` (nie stilles `PASS`), Schwellen kommen aus
der SSoT (`evaluateBacktestGate()`, `MC_MIN_SAMPLE_TRADES`, `trainOosGap()`/
`plateauMetrics()`, `DEFAULT_STRESS_VERDICT_THRESHOLDS`, `multipleTestingWarning()`);
nur für die Plateau-Grenze wurde `PROMOTION_POLICY_BOUNDS.validationMinPlateauShare
= [0, 1]` ergänzt (Default 0.5 am Gate). Die Regime-Aggregation ordnet Trades
point-in-time dem letzten `regime_snapshots`-Eintrag mit `asOf <= Entry` zu,
schließt `UNKNOWN`/nicht zuordenbare Trades gezählt aus (kein `RANGE`-Fallback)
und lässt `evaluateRegimeOos` unverändert. `writeValidationEvidence()` schreibt
idempotent über `recordEvidence()` (kein `requestTransition`, keine eigene
Hashfunktion). CLI `npm run validate:strategy` mit Exit 0 nur bei `PASS`. 32 + 6
Tests; **STX-17 geschlossen**, **STX-03 abgeschlossen**; Phase 6 ist mit 06-05
(2026-10-02, `v0.10.4`, commit `4812f21`) vollständig — Gate G7 erfüllt.

**Ergebnis 06-05 (2026-10-02, `v0.10.4`, commit `4812f21` PR #212):** Der Validator-Agent ist die einzige
LLM-Stelle in Phase 6. `runValidatorAgent()` sendet ausschließlich allowlistete
aggregierte Report-Daten (Prompt < 8 KiB), escaped untrusted content und blockt
erkannte Prompt-Boundary-Overrides als `INJECTION_ATTEMPT`. Die Ausgabe ist
striktes JSON; Provider-/Schema-Ausfälle liefern `{ unavailable: true }` und
verändern `result` nicht. `LOCAL_FREE` bleibt cloud-frei, `OPENCODE_FREE` ist
opt-in und Best-Effort. Shadow-Mode ist default-on; Telemetrie nutzt feste
Ergebnis-Labels. Acht fokussierte Tests. `AgentInterpretation` wird by-value
zurückgegeben; automatische Speicherung in `detail jsonb` und Workflow-Verdrahtung
sind nicht enthalten — die Entscheidung bleibt beim Aufrufer.

**Reihenfolge-Logik:** Der Agent kommt **zuletzt**. Ein LLM-Auditor über einen
nicht-deterministischen Report ist wertlos. 06-01…06-04 sind reine Funktionen ohne
Netzwerk; 06-05 ist die einzige Stelle mit LLM-Zugriff und gibt eine separate
Interpretation zurück. Es gibt keinen Schreibpfad zu `result` oder Evidence-Writer.

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
| 07-01 | [Copy-Typen, Mapping, Sizing](prompts/PROMPT-STX-07-01-copy-domain.md) | ✅ `src/copy/{types,mapping,sizing}.ts` (rein, `v0.10.5`, commit `b0bfcce`, PR #213): `NormalizedLeaderTrade`, `CopyMode=SIMULATE_ONLY`, SSoT-Mapping `mapLeaderSymbol()`, Sizing `FIXED_AMOUNT`/`FIXED_RATIO`/`EQUITY_RATIO` | 00-02 |
| 07-02 | [Policy-Engine + Order-Links](prompts/PROMPT-STX-07-02-copy-policy.md) | ✅ `policy.ts` + `copy_order_links` + `copy_subscriptions` (`v0.10.6`, commit `f5af325`, PR #214): `cpl1:`-Versionen, `evaluatePolicy()` fail-closed, `copy_order_links` + `copy_subscriptions` Tabellen, `SIMULATE_ONLY` CHECK, `store.ts` idempotent | 07-01 |
| 07-03 | [Bitunix-Leader-Adapter](prompts/PROMPT-STX-07-03-copy-leader-bitunix.md) | ✅ `src/copy/{leader/bitunix, follower/simulated, engine}.ts` + `scripts/run-copy-paper.ts` (commit `5f437d8`, PR #215, Unreleased auf `v0.10.6`, Changelog-Nachtrag 08-01 am 2026-10-03, kein Versions-Bump): `npm run copy:paper`, Bitunix-WS-Order-Frames → Normalisierung → Policy → Simulate-only-Follower auf Paper-Ledger, Baseline-Snapshot-Gate `NO_BASELINE`, Heartbeat-Pause, Dedupe über `copy_order_links` | 07-02 |

**Ergebnis 07-01 (2026-10-02, `v0.10.5`, commit `b0bfcce` PR #213):** Reines Domänenmodell
(`src/copy/types.ts`, `mapping.ts`, `sizing.ts`): `NormalizedLeaderTrade` normalisiert auf Handlungsabsicht
`OPEN|INCREASE|DECREASE|CLOSE`, `CopyMode = "SIMULATE_ONLY"` (Enum mit genau einem Wert, STX-16, kein Live-Pfad),
`mapLeaderSymbol()` nutzt SSoT `tryNormalizeVenueSymbol` (kein `String.replace`), `computeFollowerNotional()`
mit `FIXED_AMOUNT`/`FIXED_RATIO`/`EQUITY_RATIO` fail-closed, `applyLeveragePolicy()` mit
`FOLLOW_LEADER`/`CAP`/`IGNORE`/`RISK_NORMALIZED`. Keine IO/DB/Netz. Test `tests/copy.domain.test.ts`.

**Ergebnis 07-02 (2026-10-03, `v0.10.6`, commit `f5af325` PR #214):** Versionierte Copy-Policy
(`cpl1:<sha256>` in `src/copy/config.ts`) und fail-closed Vorabprüfung `evaluatePolicy()` in `policy.ts`
gegen `HALTED`, Notional/Day-Limits, Spread (`spreadPct`/`scannerSpread`), Positionen, Tagesverlust, Hebel und
Mapping (`NO_MAPPING`). Additive Migration `drizzle/2026-10-03_copy_subscriptions.sql`: `copy_subscriptions`
(`enabled=false`, CHECK `mode='SIMULATE_ONLY'`) und `copy_order_links` (`UNIQUE(leader_event_id,follower_intent_id)`,
`UNIQUE(follower_intent_id)`, Status-/Policy-CHECKs, FK auf `execution_quality_intents.id` TEXT). `store.ts`:
`createIntent()` insert-or-return-existing, Transitionen vorwärts über Zeilensperren, `FILLED`-Retry No-Op,
`DIVERGED` terminal, `follower_notional` gemessen nicht storniert. Tests `copy.policy.test.ts` + `copy.db.test.ts`.

**Ergebnis 07-03 (2026-10-03, commit `5f437d8` PR #215, Unreleased auf `v0.10.6`, Changelog-Nachtrag 08-01 am 2026-10-03, `npm run copy:paper`):**
Erster lauffähiger Copy-Loop Paper-only, Bitunix-first: `src/copy/leader/bitunix.ts` nutzt ausschließlich
vorhandene Bitunix-Infrastruktur (`BitunixPublicWs` + `openHardenedWs`, `orders.ts:clientOrderIdFor`,
`privateClient.ts`, `secrets.ts`, `redactor.ts`), kein zweiter WS-Client. Reihenfolge: erst Baseline-Snapshot
(`getPositions` + Equity), dann Frame-Strom; ohne Baseline kein `LIVE` — `connect()` wirft `BASELINE_UNAVAILABLE`,
Engine-Gate `NO_BASELINE`, keine Zeile geschrieben. Heartbeat-Lücke ⇒ `PAUSED_NO_HEARTBEAT`. Dekodiert
`ch:"order"`-Frames deterministisch zu `OPEN`/`INCREASE`/`DECREASE`/`CLOSE` (Net- und Hedge-Modus), filtert
`INIT`/`NEW`/`CANCELED`/`PART_FILLED_CANCELED`. `src/copy/follower/simulated.ts`: `SIMULATE_ONLY`-Follower auf
Paper-Ledger (`PaperBroker.submit()`/`close()`), Ergebnisse über `executionQuality` in `execution_quality_intents`,
kein `BrokerAdapter`, kein Venue-Order-Pfad. `src/copy/engine.ts`: Orchestrierung mit persistenter Dedupe über
`copy_order_links` (`followerIntentIdFor(leader_event_id)`), Leader-Tor (LIVE + Baseline), SSoT-Mapping, Sizing,
`evaluatePolicy`, Follower-Simulation, `SENT`/`PARTIAL`/`FILLED`, fail-closed je Schritt mit Audit + Telemetrie
(`copy.events`, `copy.latency`, `copy.leader`). Migration `drizzle/2026-10-04_copy_engine_gates.sql`: `NO_BASELINE`
in CHECK, Spalte `follower_notional` + CHECK (0…1e15) als Basis für `maxNotionalPerDay`. CLI
`scripts/run-copy-paper.ts` mit `--leader-account`, `--symbols`, `--duration`, `--max-events`,
`--policy`, `--dry-run` (Default), `--write`/`--no-write`, `--replay`. Tests `tests/copy.engine.test.ts`
(20 Tests, kein Netzwerk, injizierte Frames, Baseline-Reihenfolge, Heartbeat-Pause, Doppelzustellung inkl.
Neustart, `HALTED`-Blockade, Latenz-Finding, Grep „kein `submit()` gegen echte Venue“).

**Abgrenzung ([ADR-010 (E3)](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)):** Das `SizingMode` aus 07-01 (Follower-Notional) gehört zur Copy-Domäne und ist nicht
`PortfolioConstruction`.

**Alpaca ist NICHT in dieser Roadmap** (STX-08: kein WS vorhanden → eigener Adapter-Audit).
**Kein Reconciler** (STX-09: `executionQuality` existiert). **Kein Slippage-Cancel**
(nachträglich messen, nicht stornieren). **Kein Live-Copy** (STX-16: `SIMULATE_ONLY` per DB-CHECK).

**Phase 7 damit abgeschlossen (2026-10-03):** 07-01 (`v0.10.5`), 07-02 (`v0.10.6`), 07-03 (commit `5f437d8`, Unreleased auf `v0.10.6`, Changelog-Nachtrag 08-01; kein Projektversions-Bump) — Gate G8 erfüllt.

---

## Phase 8 — Folge-Prompts aus dem Abgleich 2026-10-03

> **Herkunft:** der Vollabgleich [`remediation/RECONCILE-2026-10-03.md`](remediation/RECONCILE-2026-10-03.md)
> hat 21 Findings gegen `main` @ `3d13161` verifiziert. Die 32 Ursprungs-Prompts sind
> umgesetzt; 08-01…08-04 sind am 2026-10-03 erledigt, 08-05/STX-21 bleibt als
> einziger Phase-8-Prompt offen. Jeder Prompt ist ein eigenständiger, abgegrenzter
> Auftrag mit Ziel, betroffenen Dateien, Randbedingungen, Abnahmekriterien und Tests.
>
> **Ausführungsreihenfolge:** 08-04 wurde nach 08-01…08-03 als hochriskantes Paket
> zuletzt und allein umgesetzt; 08-05 ist unabhängig davon offen.

| # | Prompt | Finding | Risiko | Ergebnis | Hängt ab von |
|---|---|---|---|---|---|
| 08-01 | [Changelog-Nachtrag Copy-Engine](prompts/PROMPT-STX-08-01-changelog-nachtrag-copy-engine.md) | [STX-20](findings/STX-20-changelog-nachtrag-copy-engine.md) | minimal (Doku) | ✅ erledigt: `[Unreleased]` (Code-Version `0.10.6`, 2026-10-03; kein Projekt-Bump) | — |
| 08-02 | [Doku-Viewer: `docs/architecture/` + `docs/roadmap/`](prompts/PROMPT-STX-08-02-docscatalog-suchpfade.md) | Altlast 3 (OP-6) | minimal | ✅ erledigt: `v0.10.8` + `tests/docsCatalog.test.ts` (8 Tests), Altlast 3 behoben | — |
| 08-03 | [Klassen-Literale in `signalDecay*` aus der SSoT](prompts/PROMPT-STX-08-03-signaldecay-klasse-ssot.md) | [STX-02](findings/STX-02-strategyclass-duplikat.md)-Rest / Altlast 1 | gering | ✅ erledigt: `v0.10.9` — `STRATEGY_CLASS_KEYS` aus `STRATEGY_CLASSES` abgeleitet, Lookup statt Literale, Quelltext-Wächter in `tests/adrVocabulary.test.ts`, Altlast 1 behoben | — |
| 08-05 | [`LOCAL_FREE`-Endpunkt absichern](prompts/PROMPT-STX-08-05-localfree-endpoint-haertung.md) | [STX-21](findings/STX-21-localfree-cloud-endpoint.md) | gering | ⏳ offen | — |
| 08-04 | [`backtestRule()` auf den Indicator-Cache](prompts/PROMPT-STX-08-04-backtestrule-indicatorcache.md) | [STX-12](findings/STX-12-backtestrule-o-n-quadratisch.md) | **hoch** | ✅ erledigt: `v0.11.0`, einmaliger Cache-Aufbau, Goldens unverändert, vollständige Feldparität, 144 fokussierte Tests; PR [#221](https://github.com/Kryschuuu/ai-trading-firm/pull/221) | 00-01, 02-02/02-03 |

**Warum diese fünf und in dieser Reihenfolge:**

- **08-01 zuerst und am 2026-10-03 erledigt:** Der Nachtrag zu `npm run copy:paper` und
  `2026-10-04_copy_engine_gates.sql` steht jetzt unter `[Unreleased]`; es gab keinen
  Projektversions-Bump und der veröffentlichte Block `[0.10.6]` blieb unverändert.
- **08-02 und 08-03 haben am 2026-10-03 zwei der drei dokumentierten Code-Altlasten (OP-6)
  abgeräumt** — beides kleine, isolierte Änderungen mit sofortigem Nutzen (ADR-Log im
  Browser lesbar; eine neue Klasse braucht künftig nur noch ein ADR).
- **08-05** schließt die Lücke zwischen dem **Namen** `LOCAL_FREE` und seiner
  **Garantie**. Unabhängig von allem anderen, kleiner Testaufwand.
- **08-04 wurde zuletzt und allein ausgeführt**, weil er als einziger Handelslogik
  anfasst und Byte-Identität verlangt. Die offizielle Messung vom 00-01 beschreibt
  den damaligen Direktpfad; die ergänzende synthetische Same-Series-Messung unter
  [`BENCH-BASELINE.md` §11](remediation/BENCH-BASELINE.md#11-folgemessung-stx-08-04--einmaliger-indicator-cache-in-backtestrule)
  zeigt 314,1×, ersetzt aber nicht die echte HistoricalStore-Baseline.

**Abhängigkeiten:** 08-01…08-03 und 08-05 haben **keine** untereinander. 08-04
braucht die Messmethode aus 00-01 und das Paritätsmuster aus 02-02/02-03 — beides
vorhanden. Kein Prompt dieser Phase blockiert einen anderen.

---

## Reihenfolge- und Abhängigkeitsübersicht

```
00-01 ─────────────────────────────▶ 05-04 ✅ (Skalierungs-Gate)
00-02 ──▶ 00-03 ✅─┬──▶ 01-01 ✅─┬──▶ 02-02 ✅ ──▶ 03-06 ✅─┐
                  │             └──▶ 02-03 ✅ ──▶ 03-08 ✅─┤
                  ├──▶ 02-01 ✅─┘                          │
                  └──▶ 03-01 ✅ ──▶ 03-02 ✅ ──▶ 03-03…03-07 ✅┴──▶ 03-09 ✅ ──▶ 03-10 ✅
                                    │                           │
                                    └──▶ 04-01 ✅ ──▶ 04-02 ✅ ──┴──▶ 05-01 ✅ ──▶ 05-02 ✅ ──▶ 05-03 ✅
                                                                                       │
                                    03-09 ✅ ──▶ 06-01 ✅ ──▶ 06-02 ✅ ──▶ 06-04 ✅ ◀──────────┘
                                               └──────▶ 06-03 ✅ ─────┘       │
                                                                         06-05 ✅
00-02 ✅ ──▶ 07-01 ✅ ──▶ 07-02 ✅ ──▶ 07-03 ✅      (vollständig unabhängig, Gate G8 erfüllt)
02-04 ✅ (optional, `rule.*@1`, commit 7995822) — fachlich Phase 2 vollständig

Phase 8 (Abgleich 2026-10-03; 08-04 abgeschlossen):
  08-01 ✅ (STX-20 Doku)   08-02 ✅ (Altlast 3)   08-03 ✅ (Altlast 1)
  08-04 ✅ (STX-12, v0.11.0; Handelslogik, zuletzt und allein)
  08-05 ⏳ (STX-21)
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

---

## Zurückgestellt — warum jetzt nicht sinnvoll

Nicht alles Offene ist auch **jetzt** sinnvoll. Die folgenden Punkte sind bewusst
nicht als Phase-8-Prompt ausgeschrieben, mit dem jeweiligen Blocker:

| Punkt | Status | Warum jetzt nicht |
|---|---|---|
| **Alpaca-WebSocket** ([STX-08](findings/STX-08-alpaca-ohne-websocket.md)) | offen | Der Adapter ist REST-only (0 WS-Treffer in `src/brokers/alpaca/`). Ein Leader-Adapter bräuchte einen eigenen WS-Client mit Reconnect, Heartbeat und Backfill — das ist ein **eigener Adapter-Audit**, kein Anhängsel. Phase 7 ist über Bitunix abgeschlossen und braucht Alpaca nicht. |
| **`changePctBars` + Deprekation von `changePct24h`** ([STX-14](findings/STX-14-changepct24h-semantik.md)) | teilweise | Die Semantik-Prüfung `CHANGE_PCT_SEMANTICS` ist da (`v0.10.0`); die 97-Perioden-Rechnung bleibt unverändert. Ein **neues** `RULE_FIELDS`-Feld ist ein Versionsereignis mit Migrationsimplikationen für bestehende `trade_rules` — und aktuell nutzt **kein** Template `changePct24h`. Ohne Konsumenten ist der Nutzen null, das Risiko positiv. |
| **`VolatilityRegime`-Konsolidierung** (Altlast 2, OP-6) | dokumentiert | Drei gleichnamige Typen in `adaptiveRisk.ts`, `portfolio/types.ts`, `scanner/types.ts`. Kein Laufzeitfehler, Nutzen rein kosmetisch — aber die Berührungsfläche (drei Domänen, öffentliche Typen) ist größer als bei Altlast 1 und 3. 08-03 (Altlast 1) ist erledigt; die Konsolidierung bleibt dokumentiert und ungeplant (kein Laufzeitfehler). |
| **Screening-Pilot, Gate G6** | ausstehend | Verlangt 50 echte Zellen gegen echte Marktdaten **und** PostgreSQL. In einer Abgleich-Umgebung nicht ausführbar; das Ergebnis wäre eine Zahl ohne Aussage. Runbook liegt vor: [`remediation/SCREENING-PILOT.md`](remediation/SCREENING-PILOT.md). |
| **`strategy_lifecycle_states.strategy_version_id`** (FK) | gesperrt | In 04-01 **ausdrücklich** ausgeschlossen („wegen des expliziten Locks auf `strategy_lifecycle_*` … eine erneute Prüfung erfordert einen separat abgestimmten Scope"). Ohne diese Scope-Abstimmung kein Prompt. |
| **`PortfolioConstruction`-Schicht** ([ADR-010](../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) | außerhalb | Die einzige echte Lücke aus STX-04 (Universe-Gewichte, `INVERSE_VOLATILITY`). ADR-010 fixiert die Form, erklärt sie aber ausdrücklich **nicht** zum Teil dieser Roadmap. |
| **Feature-Store-Ausbau auf alle `RULE_FIELDS`** | kein Befund | STX-10 ist mit `rule.*@1` (drei Felder) geschlossen. Eine Ausweitung auf 22 Felder verdoppelt die Paritätsfläche ohne aktuellen Engpass — das ist eine Kapazitätsfrage, kein Audit-Finding. |
| **`worker_threads`-Parallelisierung** | nicht Teil von 08-04; nur nach eigener Messung neu bewerten | `backtestRule()` nutzt jetzt den einmaligen O(n)-Cache-Pfad. Es gibt keinen Parallelisierungsauftrag; falls ein neuer Engpass belegt wird, braucht er einen separat abgegrenzten Prompt. |
| **Parquet/DuckDB** | Phase 3 | 00-01 hat gezeigt: Store + Cache tragen die Matrix. Kein Bedarf belegt. |

**Faustregel dieser Roadmap:** Ein Punkt wird erst dann ein Prompt, wenn (a) der
Nutzen benennbar ist, (b) die Abgrenzung ohne Rückfragen klar ist und (c) kein
Blocker aus einer früheren Entscheidung dagegensteht. Alles andere bleibt hier
stehen — sichtbar, aber nicht als Auftrag getarnt.
