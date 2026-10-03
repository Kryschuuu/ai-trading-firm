# Remediation-Tracking — Audit 2026-09-29

- **Audit:** [`../README.md`](../README.md) · **Roadmap:** [`../ROADMAP.md`](../ROADMAP.md)
- **Commit-Baseline:** `e3509fd9e84fc45c80817f04e6fe74c0c5fd8f67`
- **Stand:** 2026-10-03 · **Vollabgleich aller Findings gegen `main` @ `3d13161`** ([`RECONCILE-2026-10-03.md`](RECONCILE-2026-10-03.md), Audit `v1.2.1`): **21 Findings** — 17 verifiziert umgesetzt, 2 teilweise (STX-12, STX-14), 2 offen (STX-08, STX-21). **Alle 32 Ursprungs-Prompts sind umgesetzt**; von den 5 Phase-8-Folge-Prompts ist 08-01 erledigt, 4 bleiben offen. 7 Findings wurden hochgestuft (STX-02/06/09/10/16/19, Präzisierung STX-05), 1 korrigiert (STX-14), 2 neu erfasst (STX-20, STX-21). **Nicht verifizierbar:** alle `*.db.test.ts` — in der Abgleich-Umgebung fehlt PostgreSQL. · **Phase 6 abgeschlossen:** 06-01 (`v0.10.0`) liefert den deterministischen Annahmen-Audit (`src/strategies/validator/assumptions.ts`) als Gate vor jeder Metrik-Auswertung, 06-02 (`v0.10.1`) die Overfit- & Robustheitsauswertung (`src/strategies/validator/overfit.ts`), 06-03 (`v0.10.2`) den zweischichtigen Cost- & Slippage-Stress-Runner (`src/strategies/validator/stress.ts`, schließt **STX-11**), 06-04 (`v0.10.3`) Report, achtstufige Gate-Kette, Regime-Aggregation, Evidence-Writer und CLI (`src/strategies/validator/report.ts` + `persist.ts`, `npm run validate:strategy`, schließt **STX-17** und die Regime-Naht aus **STX-03**); 06-05 (`v0.10.4`) erklärt nur und lässt `result` unverändert; STX-13 geschlossen · **Phase 5 abgeschlossen:** 05-01 (`a90fa62` PR #204) Screening-Typen + konfigurierbare Priorität, 05-02 (`4267715` PR #205) Matrix-Builder, 05-03 (`211e022` PR #206) Persistenz mit `ssr1:`/`ssm1:`-Idempotenz, 05-04 (`v0.9.0`, `c797ae7` PR #207) Runner + `runMultiAssetBacktest()` + `npm run screening` — **Gate G5 erfüllt, G6 (Pilotlauf) bleibt offen** · **Phase 7 abgeschlossen:** 07-01 (`v0.10.5`, `b0bfcce` PR #213) Domänenmodell mit `CopyMode = "SIMULATE_ONLY"`, 07-02 (`v0.10.6`, `f5af325` PR #214) Policy + `copy_order_links`, 07-03 (`5f437d8` PR #215) Bitunix-Leader + Simulate-only-Follower + Engine + `npm run copy:paper` — **Gate G8 erfüllt**, **STX-09**, **STX-16** und **STX-20** geschlossen; Changelog-Nachtrag 08-01 unter `[Unreleased]` (Code-Version `0.10.6`, 2026-10-03) · · **Phase 4 abgeschlossen:** 04-01 (`v0.8.0`) liefert Migration + Drizzle-Schema für `strategy_definitions`/`strategy_versions`, 04-02 (`v0.10.4`, `66be0c6` PR #202) den App-Service mit `ensureDefinition()`/`createVersion()`, Lifecycle-Bridging über `recordEvidence()` und `stv1:`/`stc1:`-Hashes — **Gate G4 erfüllt**, STX-06 geschlossen · **Phase 3 abgeschlossen:** 03-09 (`v0.7.5`) schließt die Sanitize-Kette (`buildRule` → `sanitizeRuleSpec` → `RuleSpec`) und behebt **STX-05**; 03-10 (`v0.7.6`) liefert die Template-Vertragstests (60 Tests) und die generierte Doku `docs/STRATEGY_TEMPLATES.md` — **Gate G3 erfüllt** · **Template-Reihe vollständig:** 03-01/03-02 (`v0.7.0`), 03-03 (`v0.7.1`), 03-04 (`v0.7.2`), 03-05 (`v0.7.3`) und 03-06/03-07/03-08 (`v0.7.4`) abgeschlossen — sechs von sechs Templates gebaut · 02-01 (`v0.6.3`), 02-02 (`v0.6.4`) und 02-03 (`v0.6.5`) abgeschlossen (inkl. optionalem Slice 02-04, `7995822` PR #189) · **Phase 0 abgeschlossen** (00-01 `v0.6.0`, 00-02/00-03 `v0.6.1`) · **Phase 1 abgeschlossen** (01-01 `v0.6.2`, Gate G1) — Pfad-Entscheidung in [`BENCH-BASELINE.md`](BENCH-BASELINE.md), Vokabular-Entscheidungen in [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)

**Nachtrag 08-01 (2026-10-03, `[Unreleased]`, Projekt-Code-Version `0.10.6`):**
Der Copy-Engine-Eintrag zu PR #215 steht im Changelog; Form A wurde gewählt,
`package.json` und Projektversionsmetadaten bleiben unverändert. Der Eintrag
nennt CLI-Defaults und Flags, `NO_BASELINE`, `PAUSED_NO_HEARTBEAT`, persistente
Dedupe über `copy_order_links`, den ausschließlich auf dem Paper-Ledger
arbeitenden Follower sowie beide Änderungen der Migration
`drizzle/2026-10-04_copy_engine_gates.sql`. `tests/copy.engine.test.ts` deckt 20
Tests ohne Netzwerk mit injizierten Frames ab; `docs:validate` und `typecheck`
sind grün. **STX-20 geschlossen; Audit-Version `v1.2.1`.**

**Nachtrag 06-05 (2026-10-02, `v0.10.4`):** `runValidatorAgent()` liefert eine
separate, strikt schema-geprüfte Interpretation aus allowlisteten aggregierten
Reportdaten; `notes` und Rohdaten gehen nicht an den Provider. Boundary-Overrides
werden als `INJECTION_ATTEMPT` blockiert, Provider-/Schema-Ausfälle liefern
`{ unavailable: true }`. `LOCAL_FREE` nutzt keine Cloud-Provider,
`OPENCODE_FREE` ist opt-in/Best-Effort; Shadow-Default und bounded Telemetrie
sind umgesetzt. Acht fokussierte Tests; `npm test` wurde entsprechend der
Aufgabenanweisung nicht ausgeführt. Die Interpretation wird by-value zurückgegeben;
`persist.ts` blieb unangetastet, automatische `detail jsonb`-Speicherung und
Workflow-Verdrahtung bleiben beim Aufrufer.

**Nachtrag 06-04 (2026-10-02, `v0.10.3`):** Report, Gate-Kette und Evidenz-Writer sind umgesetzt. `buildValidationReport()` (`src/strategies/validator/report.ts`, rein — keine Uhr, keine DB, kein Zufall) fällt ein Urteil aus `PASS|FAIL|INCONCLUSIVE` über die **achtstufige Kette** `ASSUMPTIONS → HOLDOUT_INTEGRITY → DATA_SUFFICIENCY → OOS_POLICY_GATES → TRAIN_OOS_GAP_AND_PLATEAU → COST_STRESS → MULTIPLE_TESTING → FINAL`: Die erste Stufe ohne `PASS` entscheidet, alle späteren stehen als `SKIPPED` im `gates[]`-Protokoll (kein Score, keine Gewichtung, `INCONCLUSIVE` wird nicht durch einen späteren `FAIL` überstimmt). Fehlende Vorstufen sind immer `INCONCLUSIVE`, nie stilles `PASS`; Schwellen kommen aus der SSoT (`evaluateBacktestGate()`/`DEFAULT_PROMOTION_POLICY`, `MC_MIN_SAMPLE_TRADES = 30`, `plateauMetrics()`/`trainOosGap()`, `DEFAULT_STRESS_VERDICT_THRESHOLDS`, `multipleTestingWarning()`); für die Plateau-Grenze wurde `PROMOTION_POLICY_BOUNDS.validationMinPlateauShare = [0, 1]` ergänzt (Default 0.5 am Gate — die einzige Lifecycle-Änderung). `aggregateRegimeTrades()` ordnet Trades point-in-time dem letzten `regime_snapshots`-Eintrag mit `asOf <= Entry` zu, liest nur `REGIME_EVAL_LABELS` ohne `UNKNOWN`, schließt `UNKNOWN`/nicht zuordenbare Trades gezählt aus (**kein `RANGE`-Fallback**, `sharpe` `null` statt `0` unter Mindeststichprobe); `evaluateRegimeOos` bleibt unverändert. `writeValidationEvidence()` ruft ausschließlich `recordEvidence()` aus `@/strategyLifecycle` (idempotent über `sle1:`/`slei1:`, keine eigene Hashfunktion, kein `requestTransition`). CLI `npm run validate:strategy` (`scripts/run-validate-strategy.ts`): `--strategy-version-id` XOR `--create`, `--params` (Objekt oder Nachbarschafts-Array ≤ 5), `--from`/`--to`, `--max-runs`, `--out`, `--no-write`; Exit 0 nur bei `PASS`, 1 bei `FAIL`/`INCONCLUSIVE`/Laufzeit, 2 bei Bedienfehlern. 32 + 6 Tests (`tests/strategyValidation.report.test.ts`, `tests/strategyValidation.persist.test.ts`, letztere mit echtem PostgreSQL inkl. Idempotenz- und Transition-Leer-Nachweis). [Doku](../../../STRATEGY_VALIDATION.md) Teil 4 · **STX-17 geschlossen**, **STX-03** abgeschlossen.

**Nachtrag 06-03 (2026-10-02, `v0.10.2`):** Der Cost- & Slippage-Stress-Runner (`src/strategies/validator/stress.ts`) ist umgesetzt und schließt **STX-11** ohne drittes Kostenmodell: Schicht 1 (`runInEngineStress()`, `summarizeStressSweep()`) fährt pro Szenario aus `COST_STRESS_SCENARIOS` (`base` 1×/5 bp, `double` 2×/10 bp, `triple` 3×/20 bp) genau einen Walk-Forward-Lauf mit angepasstem `BacktestEngineConfig` (`feeModel` skaliert, `slippageModel: "fixed"`, `fixedSlippageBps`, `executionModel` unverändert; `base` byte-identisch zum Referenzlauf; `slippageModel: "none"` ⇒ `{ ok: false, errors }`, kein Hochrechnen). `summarizeStressSweep()` berechnet `degradationRatio = OOS-Sharpe(triple) / OOS-Sharpe(base)`, interpoliert `breakevenMultiplier` linear (`null` bei `triple.netPnl > 0` ⇒ „hält mindestens 3×") und vergibt `COST_ROBUST` (`>= 0.6` **und** `triple.netPnl > 0`), `COST_SENSITIVE` (`[0.3, 0.6)`) oder `COST_DEPENDENT` (`< 0.3`). Schicht 2 (`runPostHocStress()`) reicht das Trade-Log dünn an `runMonteCarloSimulation()` durch; im Report (`buildStressReport()`) stehen `inEngine` und `postHoc` strikt getrennt. Laufzeit-Bounds: `DEFAULT_MAX_STRESS_RUNS = 45` (`3 × 3 × 5`), hartes `maxRuns`-Argument, CLI-Parser `parseMaxRunsFlag()` (`--max-runs`). 22 Tests in `tests/strategyValidation.stress.test.ts`. [Doku](../../../STRATEGY_VALIDATION.md) Teil 3.

**Nachtrag 06-02 (2026-10-02, `v0.10.1`):** Die Overfit- & Robustheitsauswertung ist umgesetzt — vier reine Funktionen über die vorhandenen Walk-Forward-Strukturen (`overfit.ts`): Plateau (`robustShare` = Kandidaten mit `passedGates` in **allen** Fenstern; 1/5 ⇒ `0.2`, 19/20 ⇒ `0.95`), IS/OOS-Lücke (`gap > 0.5` ⇒ `SUSPECT`, `oosSharpe <= 0` ⇒ `BROKEN`, `isSharpe` entscheidet nie), Multiple-Testing-Warnung (`6…20` ⇒ `WARNING`, `> 20` ⇒ `BLOCKING`), Holdout-Integrität (`holdout.from >= freeze.oosTo`, eingefrorener Kandidat, `candlesHash`; `CONTAMINATED` ⇒ `INCONCLUSIVE`). Fehlende Score-Tabellen sind `UNKNOWN` mit Grund — nie „robust, weil nur ein Kandidat geprüft wurde". Keine Änderung an `walkforward.ts`, keine Kandidatengenerierung, keine IO/Uhr. 39 Tests, darunter der statische IO-Wächter. [Doku](../../../STRATEGY_VALIDATION.md) · STX-17 bleibt bis 06-04 in Arbeit.

**Nachtrag 05-03 (2026-10-01):** Eigene Screening-Run-/Zelltabellen, transaktionale `ssr1:`-/`ssm1:`-Idempotenz, Pflicht-Strategieversions-FK, optionale Backtests, immutable Prioritäten, monotone Fortschritte und bounded Reads sind implementiert. DB-Tests beweisen SQL-/Drizzle-Parität; Runner/CLI bleiben 05-04 vorbehalten. [Runbook + Rollback](../../../STRATEGY_SCREENING.md).

**Nachtrag 06-01 (2026-10-02, `v0.10.0`):** Der deterministische Annahmen-Audit ist umgesetzt — elf reine Prüfungen über injizierte `*Facts` (keine IO, keine Uhr, keine DB), `UNKNOWN` statt Scheingenauigkeit unter 30 Trades, `critical: true` + `VIOLATED`/`UNKNOWN` ⇒ Gesamt-Status `INCONCLUSIVE` (nie `FAIL`), `assumptionGate()` als ausdrückliche Reihenfolge-Naht vor 06-02/06-03. 38 Tests, darunter ein statischer IO-Wächter über den Modulquelltext. STX-14 hat damit seine Prüfung; STX-17 bleibt bis 06-04 offen. [Doku](../../../STRATEGY_VALIDATION.md).

**Nachtrag 05-04 (2026-10-02, `v0.9.0`):** Runner (`runScreening()`), Backtest-Job-Adapter (`runMultiAssetBacktest()` als einziger Engine-Pfad) und CLI (`npm run screening`, `--dry-run` Default) sind umgesetzt und mit 38 Tests belegt — harte `maxCells`, Caps ⇒ `BLOCKED` statt Kappung, bounded Concurrency ohne `worker_threads`, bounded Telemetrie, Abbruch ⇒ `ABORTED` mit Fortsetzung über `--run-id`. `backtest_run_id` bleibt bewusst `null` (Naht: `persist`-Hook im Adapter). Die Annahme von 05-04 steht unter dem Vorbehalt des verbindlichen Pilots (50 Zellen) — [Pilot-Runbook](SCREENING-PILOT.md).

## Legende

`☐` offen · `◐` in Arbeit · `☑` fertig · `⊘` zurückgestellt · `✗` verworfen

---

## Findings

| ID | Severity | Status | Behoben durch |
|---|---|---|---|
| STX-01 Timeframe-Blocker | HIGH | ☑ | 01-01 ☑ (`v0.6.2`) — [Abgleich](RECONCILE-2026-10-03.md) bestätigt: `RULE_ALLOWED_TIMEFRAMES = SUPPORTED_TIMEFRAMES` |
| STX-02 `StrategyClass`-Duplikat | HIGH | ☑ | 00-03 ☑ ([ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), `v0.6.1`) → 03-01/03-02 ☑ (`v0.7.0`) → 03-09 ☑ (`v0.7.5`); [Abgleich](RECONCILE-2026-10-03.md): sechs Templates deklarieren `class`, keines `unclassified`, `CompileResult.strategyClass` getestet. Restpunkt Klassenliterale in `signalDecay*` → [08-03](../prompts/PROMPT-STX-08-03-signaldecay-klasse-ssot.md) |
| STX-03 Regime-Vokabular-Konflikt | HIGH | ☑ | 00-03 ☑ ([ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), `v0.6.1`) → 06-04 ☑ (`v0.10.3`: `aggregateRegimeTrades()` liest `REGIME_EVAL_LABELS` ohne `UNKNOWN`, kein `RANGE`-Fallback, point-in-time) |
| STX-04 `MultiAssetStrategySpec`-Duplikat | HIGH | ☑ | 00-03 ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3), `v0.6.1`); Sizing-Schicht bewusst außerhalb der Roadmap; Wächter `tests/adrVocabulary.test.ts:410` |
| STX-05 Builder umgeht Sanitize | HIGH | ☑ | 03-01 ☑ (`v0.7.0`, `buildRule(params) => RuleSpecInput`, kein `ctx`) → 03-09 ☑ (`v0.7.5`, Compiler + Sanitize-Nachweis); [Abgleich](RECONCILE-2026-10-03.md): Kriterium 5 präzisiert — Service ist Registry, kein Live-Template-Pfad |
| STX-06 Keine Versions-Persistenz | MEDIUM | ☑ | 04-01 ☑ (`v0.8.0`, Schema) → 04-02 ☑ (`v0.10.4`, `66be0c6` PR #202, Fix `9d73aeb` PR #203: `ensureDefinition()`, `createVersion()`, `stv1:`/`stc1:`); DB-Idempotenz im Abgleich **nicht verifizierbar** (kein PostgreSQL) |
| STX-07 `backtest_runs`-Scope | MEDIUM | ☑ | 05-03 ☑ (`211e022` PR #206, eigene Run-/Zelltabellen; `backtest_runs.instrumentId` unverändert `notNull`) |
| STX-08 Alpaca ohne WS | MEDIUM | ☐ | [Abgleich](RECONCILE-2026-10-03.md) bestätigt: 0 WebSocket-Treffer in `src/brokers/alpaca/`; bewusst eigener Adapter-Audit, nicht Teil dieser Roadmap |
| STX-09 Copy-Reconciliation-Duplikat | MEDIUM | ☑ | 07-02 ☑ (`f5af325` PR #214) + 07-03 ☑ (`5f437d8` PR #215): kein Reconciler, `executionQuality`-Intents, `copy_order_links.state` exakt 6 Werte, kein Cancel nach Fill |
| STX-10 Feature Store ist Slice | MEDIUM | ☑ | 00-02 ☑ (Doku, `v0.6.1`) → 02-04 ☑ (optional umgesetzt, `7995822` PR #189: `rule.bb_zscore`, `rule.price_vs_upper_bb_pct`, `rule.donchian_breakout_pct` + Paritätstest) |
| STX-11 Cost-Stress existiert | MEDIUM | ☑ | 00-02 ☑ (Doku, `v0.6.1`) → 06-03 ☑ (`v0.10.2`, `src/strategies/validator/stress.ts`) |
| STX-12 `backtestRule` O(n²) | MEDIUM | ◐ | 00-01 (Messung ✓, `v0.6.0`) → Screening umgeht den Pfad seit 05-04 (`v0.9.0`, `runMultiAssetBacktest()`); **Code unverändert quadratisch** ([Abgleich](RECONCILE-2026-10-03.md): `ruleEngine.ts:894`, kein Cache-Import), Altpfad lebt in `ruleBacktest.ts:385` → Folge-Patch [08-04](../prompts/PROMPT-STX-08-04-backtestrule-indicatorcache.md) |
| STX-13 OpenCode-Free-Tier | LOW | ☑ | 06-05 (`v0.10.4`): best effort statt Verfügbarkeitsgarantie; Ausfall bleibt `unavailable`. Restpunkt Lokalitäts-Garantie ausgegliedert → [STX-21](../findings/STX-21-localfree-cloud-endpoint.md) |
| STX-14 `changePct24h`-Semantik | LOW | ◐ | 03-01 ☑ (Doku) → 06-01 ☑ (`v0.10.0`, Prüfung `CHANGE_PCT_SEMANTICS`: Nutzung ⇒ `VIOLATED` mit `WARNING`, Semantik aus `RULE_FIELD_LABELS`); offen bleibt die Feld-Deprekation (`changePctBars`) — **ohne aktuellen Konsumenten** (kein Template nutzt das Feld), zurückgestellt |
| STX-15 Faktorzahl (14 ≠ 15+) | LOW | ☑ | 00-02 (`v0.6.1`); [Abgleich](RECONCILE-2026-10-03.md) nachgezählt: 14 Faktoren in `scanner.config.json` |
| STX-16 Copy-Compliance | LOW | ☑ | 07-01 ☑ (`b0bfcce`) → 07-02 ☑ (`f5af325`): `CopyMode` mit **einem** Wert, DB-CHECK `mode='SIMULATE_ONLY'`, Follower nur `PaperBroker`; rechtliche Prüfung bleibt außerhalb ([OP-4](#offene-punkte-für-den-reviewer)) |
| STX-17 Validator kompatibel | INFO | ☑ | bestätigt — 06-01 ☑ (`v0.10.0`, deterministischer Annahmen-Audit), 06-02 ☑ (`v0.10.1`, Overfit- & Robustheitsauswertung), 06-04 ☑ (`v0.10.3`, Report + Gate-Kette + `recordEvidence()`-Writer); 06-05 nutzt denselben Vertrag |
| STX-18 `RuleSpec` trägt 5/7 Templates | INFO | ☑ | bestätigt und abgeschlossen — Bollinger 02-02 ☑ (`v0.6.4`), Donchian 02-03 ☑ (`v0.6.5`); Templates 03-03 ☑ (`v0.7.1`), 03-04 ☑ (`v0.7.2`), 03-05 ☑ (`v0.7.3`), 03-06/03-07/03-08 ☑ (`v0.7.4`) — alle sechs gebaut; Compiler-Abnahme 03-09 ☑ (`v0.7.5`, sechs Templates ohne Klemmung durch den Sicherheitspfad); Vertragstests 03-10 ☑ (`v0.7.6`, `tests/strategies.templates.test.ts`) |
| STX-19 Kafka-Einwand | INFO | ☑ | bestätigt und **erfüllt** — global gesperrt ([`../ROADMAP.md`](../ROADMAP.md) §0); [Abgleich](RECONCILE-2026-10-03.md): kein Kafka/NATS/Redis/DuckDB in `dependencies`, 0 Treffer in `src/` |
| STX-20 Changelog-Nachtrag Copy-Engine | LOW | ☑ | 08-01 erledigt (2026-10-03): Eintrag unter `[Unreleased]`, Projekt-Code-Version `0.10.6` ohne Bump; Details im [Finding](../findings/STX-20-changelog-nachtrag-copy-engine.md) |
| STX-21 `LOCAL_FREE`-Endpunkt | LOW | ☐ | neu im [Abgleich](RECONCILE-2026-10-03.md): `LOCAL_FREE_PROVIDERS` enthält `openai` mit konfigurierbarer `LLM_BASE_URL`; Filter prüft nur Toggles → [08-05](../prompts/PROMPT-STX-08-05-localfree-endpoint-haertung.md) |

## Prompts

### Phase 0 — Messung & Entscheidungen (Gate vor Phase 1)

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 00-01 | [Backtest-Perfenz-Baseline](../prompts/PROMPT-STX-00-01-backtest-perf-baseline.md) | ☑ | STX-12 | [`v0.6.0`](BENCH-BASELINE.md) |
| 00-02 | [Strategie-Stack-SSoT](../prompts/PROMPT-STX-00-02-strategy-stack-ssot.md) | ☑ | STX-10/11/15 | [`v0.6.1`](../../../architecture/STRATEGY_STACK.md) |
| 00-03 | [Vokabular-ADR](../prompts/PROMPT-STX-00-03-vokabular-adr.md) | ☑ | STX-02/03/04 | [`v0.6.1`](../../../roadmap/DECISIONS.md) |

### Phase 1 — Blocker

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 01-01 | [Rule-Timeframes angleichen](../prompts/PROMPT-STX-01-01-rule-timeframes.md) | ☑ | STX-01 | [`v0.6.2`](../../../BACKTESTING.md#11-rule-timeframe--unterstützte-felder-stx-01-v062) |

### Phase 2 — Indikator-Grundlage

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 02-01 | [Bollinger-Bänder + Donchian](../prompts/PROMPT-STX-02-01-indikatoren.md) | ☑ | STX-18 | `v0.6.3` |
| 02-02 | [Bollinger-Regelfelder](../prompts/PROMPT-STX-02-02-bollinger-felder.md) | ☑ | STX-18 | [`v0.6.4`](../../../BACKTESTING.md#12-bollinger-bandlage-stx-02-02-v064) |
| 02-03 | [Donchian-Regelfeld](../prompts/PROMPT-STX-02-03-donchian-feld.md) | ☑ | STX-18 | [`v0.6.5`](../../../BACKTESTING.md#13-donchian-ausbruch-stx-02-03-v065) |
| 02-04 | [Feature-Store-Slice `rule.*` *(optional)*](../prompts/PROMPT-STX-02-04-featurestore-rule-slice.md) | ☑ | STX-10 | `7995822` PR #189 (`rule.*@1`, Paritätstest) |

### Phase 3 — Template-Kern

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 03-01 | [Template-Typen](../prompts/PROMPT-STX-03-01-template-types.md) | ☑ | STX-05 | `v0.7.0` |
| 03-02 | [Katalog + Validierung](../prompts/PROMPT-STX-03-02-catalog.md) | ☑ | STX-02/05 | `v0.7.0` |
| 03-03 | [Template: EMA/ADX Trend](../prompts/PROMPT-STX-03-03-template-ema-adx.md) | ☑ | STX-18 | `v0.7.1` |
| 03-04 | [Template: MACD Momentum](../prompts/PROMPT-STX-03-04-template-macd.md) | ☑ | STX-18 | `v0.7.2` |
| 03-05 | [Template: RSI Mean-Reversion](../prompts/PROMPT-STX-03-05-template-rsi.md) | ☑ | STX-18 | `v0.7.3` |
| 03-06 | [Template: Bollinger Squeeze](../prompts/PROMPT-STX-03-06-template-bollinger.md) | ☑ | STX-18 | `v0.7.4` |
| 03-07 | [Template: VWAP (Snapshot)](../prompts/PROMPT-STX-03-07-template-vwap.md) | ☑ | STX-18 | `v0.7.4` |
| 03-08 | [Template: Donchian Breakout](../prompts/PROMPT-STX-03-08-template-donchian.md) | ☑ | STX-18 | `v0.7.4` |
| 03-09 | [Compiler + Sanitize-Nachweis](../prompts/PROMPT-STX-03-09-compiler.md) | ☑ | STX-05 | `v0.7.5` |
| 03-10 | [Template-Tests](../prompts/PROMPT-STX-03-10-template-tests.md) | ☑ | STX-18 | `v0.7.6` |

### Phase 4 — Versionierte Persistenz

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 04-01 | [Migration `strategy_definitions`/`versions`](../prompts/PROMPT-STX-04-01-strategy-persistenz-migration.md) | ☑ | STX-06 | `v0.8.0` (Schema; Service folgt) |
| 04-02 | [Service + Lifecycle-Bridging](../prompts/PROMPT-STX-04-02-strategy-service.md) | ☑ | STX-06/17 | `v0.10.4` (`66be0c6` PR #202, Fix `9d73aeb` PR #203) |

### Phase 5 — Candidate Matrix

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 05-01 | [Screening-Typen + Priorität](../prompts/PROMPT-STX-05-01-screening-types.md) | ☑ | STX-07 | `v0.9.0`-Vorstufe (`a90fa62` PR #204) |
| 05-02 | [Matrix-Builder](../prompts/PROMPT-STX-05-02-matrix-builder.md) | ☑ | STX-07 | `4267715` PR #205 |
| 05-03 | [Persistenz + Idempotenz](../prompts/PROMPT-STX-05-03-screening-persistenz.md) | ☑ | STX-07 | `211e022` PR #206 (`ssr1:`/`ssm1:`) |
| 05-04 | [CLI + Backtest-Job-Adapter](../prompts/PROMPT-STX-05-04-screening-cli.md) | ☑ | STX-07/12 | `v0.9.0` (Annahme unter Pilot-Vorbehalt, [SCREENING-PILOT.md](SCREENING-PILOT.md)) |

### Phase 6 — Validator

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 06-01 | [Annahmen-Audit](../prompts/PROMPT-STX-06-01-assumptions-audit.md) | ☑ | STX-14/17 | `v0.10.0` ([Doku](../../../STRATEGY_VALIDATION.md)) |
| 06-02 | [Overfit & Robustheit](../prompts/PROMPT-STX-06-02-overfit.md) | ☑ | STX-17 | `v0.10.1` ([Doku](../../../STRATEGY_VALIDATION.md)) |
| 06-03 | [Cost-Stress-Runner](../prompts/PROMPT-STX-06-03-cost-stress.md) | ☑ | STX-11 | `v0.10.2` ([Doku](../../../STRATEGY_VALIDATION.md#teil-3--cost---slippage-stress-runner-stressts-stx-06-03-v0102)) |
| 06-04 | [Report + Evidence + CLI](../prompts/PROMPT-STX-06-04-validation-report.md) | ☑ | STX-03/17 | `v0.10.3` ([Doku](../../../STRATEGY_VALIDATION.md)) |
| 06-05 | [Validator-Agent](../prompts/PROMPT-STX-06-05-validator-agent.md) | ☑ | STX-13 | `v0.10.4` ([Doku](../../../STRATEGY_VALIDATION.md#31-agent-grenzen-stx-06-05)) |

### Phase 7 — Copy-Trading (Paper-only, unabhängig)

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 07-01 | [Copy-Domänenmodell](../prompts/PROMPT-STX-07-01-copy-domain.md) | ☑ | STX-16 | `v0.10.5` (`b0bfcce` PR #213) |
| 07-02 | [Policy + Order-Links](../prompts/PROMPT-STX-07-02-copy-policy.md) | ☑ | STX-09/16 | `v0.10.6` (`f5af325` PR #214) |
| 07-03 | [Bitunix-Leader-Adapter](../prompts/PROMPT-STX-07-03-copy-leader-bitunix.md) | ☑ | STX-08/09/16 | `5f437d8` PR #215 (Unreleased auf `v0.10.6`; Changelog-Nachtrag 08-01 am 2026-10-03 ergänzt, [STX-20](../findings/STX-20-changelog-nachtrag-copy-engine.md) geschlossen) |


### Phase 8 — Folge-Prompts aus dem Abgleich 2026-10-03

> Entstanden aus dem Vollabgleich [`RECONCILE-2026-10-03.md`](RECONCILE-2026-10-03.md).
> Jeder Prompt ist eigenständig, abgegrenzt und ohne Rückfragen ausführbar.
> Reihenfolge-Empfehlung: 08-01 → 08-02 → 08-03 → 08-05 → 08-04 (das
> hochriskante Paket zuletzt).

| # | Titel | Status | Finding | Version |
|---|---|---|---|---|
| 08-01 | [Changelog-Nachtrag Copy-Engine](../prompts/PROMPT-STX-08-01-changelog-nachtrag-copy-engine.md) | ☑ | STX-20 | `[Unreleased]` (Code-Version `0.10.6`, 2026-10-03; kein Projekt-Bump) |
| 08-02 | [Doku-Viewer: `docs/architecture/` + `docs/roadmap/`](../prompts/PROMPT-STX-08-02-docscatalog-suchpfade.md) | ☐ | Altlast 3 (OP-6) | — |
| 08-03 | [Klassen-Literale in `signalDecay*` aus der SSoT](../prompts/PROMPT-STX-08-03-signaldecay-klasse-ssot.md) | ☐ | STX-02-Rest / Altlast 1 | — |
| 08-04 | [`backtestRule()` auf den Indicator-Cache](../prompts/PROMPT-STX-08-04-backtestrule-indicatorcache.md) | ☐ | STX-12 | — |
| 08-05 | [`LOCAL_FREE`-Endpunkt absichern](../prompts/PROMPT-STX-08-05-localfree-endpoint-haertung.md) | ☐ | STX-21 | — |

---

## Abgelehnte Vorschläge (bewusst nicht umgesetzt)

| Vorschlag | Entscheidung | Begründung | Dokumentiert in |
|---|---|---|---|
| Kafka | ✗ abgelehnt | STX-19 | `ROADMAP.md` §Abgelehnt |
| `MultiAssetStrategySpec` | ✗ abgelehnt | STX-04 | 00-03 ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) |
| `PortfolioConstruction`-Schicht (Universe-Gewichte) | ⊘ eigener Prompt außerhalb der 32 | STX-04 (Sizing-Lücke) | [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3) |
| Regime-Taxonomie (7er) | ✗ abgelehnt | STX-03 | 00-03 ([ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2)) |
| Eigene Strategieklasse / neue Klasse (`momentum`) | ✗ abgelehnt | STX-02 | 00-03 ([ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)) |
| Copy-Reconciler | ✗ abgelehnt | STX-09 | 07-02 |
| Slippage-Cancel nach Fill | ✗ abgelehnt | STX-09 | 07-02 |
| Alpaca-Leader | ⊘ zurückgestellt | STX-08 (kein WS) | `ROADMAP.md` §Abgelehnt |
| Parquet/DuckDB | ⊘ Phase 3 der Roadmap | Messung offen | 00-01 |
| `RuleTrigger` `CROSS`/`RECLAIM` | ⊘ eigener Audit | STX-18 | 03-07 |
| `DerivativeStrategySpec` (Shorts) | ⊘ eigener Audit | Ausbaudokument §13 | — |
| Live-Copy | ✗ abgelehnt | STX-16 | 07-01/07-02 |

## Abhängigkeits-Gates

| Gate | Bedingung | Prompts dahinter |
|---|---|---|
| **G0** | ✅ **erfüllt** (00-03: 3 ADRs fixiert, `v0.6.1` — [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)) | 01-01, 02-01, 03-01, 07-01 |
| **G1** | ✅ **erfüllt** (01-01: Timeframes `1m…5d`, Intraday byte-identisch per Golden-Test, `v0.6.2`) | 02-02, 02-03, 03-01, 05-02 |
| **G2** | ✅ **erfüllt** (02-02/02-03: `bbZScore`/`priceVs*BbPct` `v0.6.4`, `donchianBreakoutPct` `v0.6.5`, Paritäts- und Lookahead-Tests) | 03-06, 03-08 |
| **G3** | ✅ **erfüllt** (03-10: `tests/strategies.templates.test.ts` grün — 6 Templates vertraglich abgesichert, `v0.7.6`) | 04-01 |
| **G4** | ✅ **erfüllt** (04-02: `ensureDefinition()`/`createVersion()` mit `stv1:`/`stc1:`, `getVersionByFingerprint()`; `v0.10.4`, `66be0c6` PR #202 — DB-Nachweis im Abgleich nicht ausführbar) | 05-03, 06-02, 06-04 |
| **G5** | ✅ **erfüllt** (00-01: Screening über `runMultiAssetBacktest`, [BENCH-BASELINE.md](BENCH-BASELINE.md)) | 05-04 |
| **G6** | 05-04 Pilotlauf < 1 Kernstunde/50 Zellen — ausstehend ([SCREENING-PILOT.md](SCREENING-PILOT.md)) | Phase 6 |
| **G7** | ✅ **erfüllt** (06-04: `buildValidationReport()` + `writeValidationEvidence()` grün, 32 + 6 Tests, `npm run validate:strategy`, `v0.10.3`) | 06-05 |
| **G8** | ✅ **erfüllt** (07-01 `v0.10.5`, 07-02 `v0.10.6`, 07-03 `5f437d8` PR #215; `tests/copy.{domain,policy,engine}.test.ts` grün, 20/20 in `copy.engine`) | — |

## Bekannte Code-Altlasten (durch 00-03 aufgedeckt, nicht Teil der 32 Prompts)

00-03 sperrte Code-Änderungen; diese Punkte sind deshalb dokumentiert und **nicht** still korrigiert. Jeder ist eine kleine, eigenständige Änderung an Laufzeit-Code (eigener Prompt, Patch-Release). Ob und wann sie folgen, steht als OP-6 unten. Stand geprüft am 2026-10-01 gegen `main`.

| Altlast | Fundort | Risiko | Details |
|---|---|---|---|
| Die vier Klassenwerte stehen als Literale statt nur aus `STRATEGY_CLASS_KEYS` | `src/lib/signalDecay.ts` (`STRATEGY_CLASS_KEYS` `:107`, `isStrategyClassKey` `:433`, lokale Closure `classOf` `:1545` — exportiert ist `classKey()` `:435`), `src/lib/signalDecayRuntime.ts:494`, CHECKs `positions_strategy_class_check` und `signal_decay_events_class_check` (`drizzle/2026-09-22_signal_decay.sql`) | Eine künftige Klasse müsste an allen Stellen zugleich ergänzt werden (ADR-008: nur per neuem ADR) | [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), Konsequenzen |
| `VolatilityRegime` ist dreifach definiert (Volatilitäts-Stufen, kein Markt-Regime) | `src/lib/adaptiveRisk.ts` (`NORMAL`/`ELEVATED`/`EXTREME`), `src/portfolio/types.ts` und `src/scanner/types.ts` (`LOW`/`NORMAL`/`HIGH`/`EXTREME`) | Namensnähe zu `MarketRegime`; kein Laufzeitfehler | [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), Kontext |
| In-App-Doku-Viewer löst `docs/architecture/` und `docs/roadmap/` nicht auf | `resolveDoc` in `src/lib/docsCatalog.ts` (Suchpfade ohne diese beiden Ordner) | `STRATEGY_STACK.md`, `PIPELINE_MAP.md` und der ADR-Log sind nur im Repo und auf GitHub lesbar, nicht im Browser-Viewer | [`CHANGELOG.md`](../../../../CHANGELOG.md), Eintrag `0.6.1` |

Der in `src/strategies/service.ts` (04-02) entstandene **vierte** Fall — eine erneut kopierte Klassenliste — ist **behoben**: Der Service liest `STRATEGY_CLASSES` aus der SSoT, der Wächter `tests/adrVocabulary.test.ts` deckt ihn ab.

## Offene Punkte für den Reviewer

- **OP-1:** Soll `4h`/`1d` im Micro-Executor überhaupt je erreichbar sein, oder bleibt
  der Live-Executor Intraday-only und `4h`+ gilt nur für Backtest/Screening?
  ◐ **Mit Default beantwortet, Policy offen:** 01-01 (`v0.6.2`) hat die Guard-Schicht gebaut — der
  Executor wertet nur Regeln bis `executionInterval` aus (Default `1h`), längere weist er sichtbar ab.
  `4h`+ gilt damit für Backtest/Screening. Eine Anhebung des Intervalls ist eine bewusste
  Policy-Entscheidung, keine reine Konfiguration: Der Loop bewertet die laufende Kerze.
- **OP-2:** ✅ **beantwortet** durch [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1) (2026-09-29): `unclassified` ist **kein** Template-Status — ein
  Template ohne Klasse oder mit `unclassified` ist ein Fehler (Validierung 03-02, Compiler 03-09, DB-CHECK 04-01).
- **OP-3:** Sollen `strategy_versions` an die `regime_snapshots`/`feature_store` des
  jeweiligen Laufs gebunden werden (Data-Version-Provenienz), oder reicht
  `data_version` als Freitext? ([ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) legt nur fest, dass Per-Regime-Ergebnisse
  `featureVersion`/`modelVersion` der verwendeten Snapshots tragen; die Frage für `strategy_versions` bleibt offen.)
- **OP-4:** Kopieren-Projekt: Wer trägt die rechtliche Prüfung für den Fall, dass aus
  `SIMULATE_ONLY` später doch Live werden soll? (STX-16 — nicht Teil dieses Repos.)
- **OP-5:** ✅ **beantwortet** im [Abgleich 2026-10-03](RECONCILE-2026-10-03.md): 02-04 ist
  umgesetzt (`7995822` PR #189, `rule.*@1` mit drei Regelfeatures und Paritätstest
  `tests/ruleFeatureStoreParity.test.ts`). STX-10 ist damit geschlossen; eine Ausweitung
  auf die übrigen `RULE_FIELDS` ist kein Befund mehr, sondern eine Kapazitätsfrage.
- **OP-6:** Sollen die [bekannten Code-Altlasten](#bekannte-code-altlasten-durch-00-03-aufgedeckt-nicht-teil-der-32-prompts)
  als eigene Prompts/Patch-Releases folgen oder bleiben sie dokumentiert und ungeplant?
