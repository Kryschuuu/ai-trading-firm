# Versionierung — Audit 2026-09-29 & Roadmap

> Verbindliche Versionierungs-Planung für dieses Audit und die daraus folgende
> Umsetzung. **Alle Zielversionen liegen in `0.x` — das Projekt bleibt Beta.**

## 1. Version des Audits

| Feld | Wert |
| --- | --- |
| **Audit-Version** | `audit-2026-09-29 v1.2.2` |
| **Schema** | `MAJOR.MINOR.PATCH` für den **Audit-Inhalt**, unabhängig von der Projekt-Version |
| **Gültig ab** | Commit `d734fe1` (Erstfassung), fortgeführt in diesem PR |
| **Projekt-Version bei Erstellung** | `v0.5.0` (Beta) |
| **Status** | `OPEN` — **21 Findings** (19 Ursprung + STX-20/STX-21 aus dem Abgleich 2026-10-03), davon 5 HIGH; **vollständig abgeglichen gegen `main` @ `3d13161`** ([`remediation/RECONCILE-2026-10-03.md`](remediation/RECONCILE-2026-10-03.md)): 17 verifiziert umgesetzt, 2 teilweise (STX-12, STX-14), 2 offen (STX-08, STX-21); **alle 32 Ursprungs-Prompts umgesetzt**, Phase 8 ergänzt 5 Folge-Prompts, 08-01 erledigt (Doku-Nachtrag ohne Bump), 08-02 erledigt (`v0.10.8`, Altlast 3); Phase 0 umgesetzt (00-01 `v0.6.0`, 00-02/00-03 `v0.6.1`), Phase 1 umgesetzt (01-01 `v0.6.2`, STX-01 behoben), Phase 2 fachlich abgeschlossen (02-01 `v0.6.3`, 02-02 `v0.6.4`, 02-03 `v0.6.5`; offen nur der optionale Slice 02-04), **Phase 3 abgeschlossen** (Template-Reihe 03-01…03-08, Compiler 03-09 `v0.7.5`, Vertragstests 03-10 `v0.7.6`; Gate G3 erfüllt); **Phase 4 begonnen** (04-01 Schema `v0.8.0`; 04-02 Service/Schreibpfad offen; STX-06 in Arbeit); **Phase 6 abgeschlossen** (06-01 Annahmen-Audit `v0.10.0`, 06-02 Overfit- & Robustheitsauswertung `v0.10.1`, 06-03 Cost- & Slippage-Stress-Runner `v0.10.2`, STX-11 behoben; 06-04 Report + Gate-Kette + Evidence-Writer + CLI `v0.10.3`, STX-17 geschlossen; 06-05 Validator-Agent `v0.10.4` umgesetzt, STX-13 geschlossen) |

### 1.1 Audit-Versionsregeln

| Änderung am Audit | Bump | Beispiel |
| --- | --- | --- |
| Neuer Befund gegen neuen Code-Stand | MINOR | `v1.1.0` — „STX-20 nach v0.6.0" |
| Neue Phase in der Roadmap | MINOR | `v1.1.0` — „Phase 8 ergänzt" |
| Ein Finding wird behoben (`☐` → `☑`) | PATCH | `v1.0.1` |
| Formulierung, Tippfehler, Linkfix | PATCH | `v1.0.1` |
| Befund zurückgenommen (FALSE_POSITIVE) | MAJOR | `v2.0.0` — „STX-04 war falsch" |
| Grundsatzänderung der Roadmap-Reihenfolge | MAJOR | `v2.0.0` |

### 1.2 Versionshistorie

| Version | Datum | Änderung |
| --- | --- | --- |
| `v1.0.0` | 2026-09-29 | Erstfassung: 19 Findings, 32 Prompts, 8 Phasen |
| `v1.1.0` | 2026-09-29 | 00-01 gemessen (`v0.6.0`, [BENCH-BASELINE](remediation/BENCH-BASELINE.md)); Release-Plan verzahnt: `v0.6.0` = Benchmark, `v0.6.1` = SSoT + ADRs, 0.6.x-Folge nachgezogen; STX-12 auf „Patch mit Paritätstest“ herabgestuft |
| `v1.1.1` | 2026-09-29 | 00-02/00-03 umgesetzt (`v0.6.1`): ADR-008…010, Gate G0 erfüllt; STX-04/15 behoben, STX-02/03/10/11 in Arbeit; Präzisierungen an STX-01…04 (Findings, Prompts, `report.md`); Severity-Tabelle im Audit-README korrigiert |
| `v1.1.2` | 2026-09-29 | 01-01 umgesetzt (`v0.6.2`): STX-01 behoben, Gate G1 erfüllt; Befundkorrekturen an STX-01 (`sessionVwap` war auf `1d` bereits fail-closed; `sanitizeRuleSpec` fällt auf `15m` statt zu „verwerfen“ und kleinschreibt `"1H"`); OP-1 mit Default beantwortet |
| `v1.1.3` | 2026-09-30 | 02-01 umgesetzt (`v0.6.3`): reine Bollinger-/Donchian-Formeln, Rule-Felder/Cache weiter offen; kein Finding geschlossen |
| `v1.1.4` | 2026-09-30 | 02-02 umgesetzt (`v0.6.4`): Bollinger-Regelfelder + Paritäts-/Golden-Test; STX-18 zur Hälfte erledigt (Donchian folgt 02-03) |
| `v1.1.5` | 2026-09-30 | 02-03 umgesetzt (`v0.6.5`): Donchian-Regelfeld + Lookahead-/O(n)-/Paritätstest; STX-18-Feldseite vollständig (Templates offen) |
| `v1.1.6` | 2026-10-01 | 03-01/03-02 umgesetzt (`v0.7.0`): Template-Vertrag (`src/strategies/types.ts`) + Katalog mit Import-Zeit-Validierung |
| `v1.1.7` | 2026-10-01 | 03-03 umgesetzt (`v0.7.1`): Template EMA/ADX Trend + eigene Testsuite |
| `v1.1.8` | 2026-10-01 | 03-04 umgesetzt (`v0.7.2`): Template MACD Momentum, Referenztemplate für 06-02 |
| `v1.1.9` | 2026-10-01 | 03-05 umgesetzt (`v0.7.3`): Template RSI Mean-Reversion — erste Klasse `mean-reversion`, Nachweis dass das Regime-Gate (ADR-008) trägt |
| `v1.1.10` | 2026-10-01 | 03-06/03-07/03-08 umgesetzt (`v0.7.4`): Templates Bollinger Squeeze, VWAP-Bias (Snapshot) und Donchian Breakout — sechs von sechs Templates gebaut, Phase-3-Abnahme über 03-09/03-10 offen |
| `v1.1.11` | 2026-10-01 | 03-09 umgesetzt (`v0.7.5`): Compiler `Template → buildRule(params) → sanitizeRuleSpec() → RuleSpec` mit `clamped`-Nachweis, stabilem `stc1:`-Fingerprint und `exportTemplates()`; **STX-05 behoben** (HIGH), offen nur 03-10 |
| `v1.1.12` | 2026-10-01 | 03-10 umgesetzt (`v0.7.6`): Template-Vertragstests (`tests/strategies.templates.test.ts`, 60 Tests) + generierte Doku `docs/STRATEGY_TEMPLATES.md`; **Phase 3 abgeschlossen**, Gate G3 erfüllt (STX-18 damit auf der Abnahmeseite geklärt) |
| `v1.1.13` | 2026-10-01 | 04-01 umgesetzt (`v0.8.0`): append-only Schema für `strategy_definitions`/`strategy_versions` + DB-Tests; STX-06 teilweise remediated, bleibt bis 04-02-Service in Arbeit |
| `v1.1.15` | 2026-10-02 | 05-04 umgesetzt (`v0.9.0`): Screening-Runner, Backtest-Job-Adapter (`runMultiAssetBacktest()`) und CLI (`npm run screening`, `--dry-run` Default); `backtest_run_id` bewusst `null`; Annahme steht unter dem Vorbehalt des Pilots (Gate G6) |
| `v1.1.14` | 2026-10-01 | Nachtrag ohne Projekt-Release (Eintrag unter `[Unreleased]`): bekannte Code-Altlasten im TRACKING geführt (OP-6); `PR_SUMMARY.md` als Schnappschuss markiert; `report.md` §6 P0-a nachgezogen; CSRF-Negativtest deterministisch; zwei rote Wächter aus 04-02 behoben (kopierte Klassenliste, fehlende Audit-Event-Beschreibung) |
| `v1.1.16` | 2026-10-02 | 06-01 umgesetzt (`v0.10.0`): deterministischer Annahmen-Audit `src/strategies/validator/assumptions.ts` (elf Prüfungen, `UNKNOWN` statt Scheingenauigkeit, `critical` ⇒ `INCONCLUSIVE`, `assumptionGate()` vor 06-02/06-03) + 38 Tests + [`docs/STRATEGY_VALIDATION.md`](../../STRATEGY_VALIDATION.md); STX-14 bekommt seine Prüfung, STX-17 bleibt bis 06-04 offen |
| `v1.1.17` | 2026-10-02 | 06-02 umgesetzt (`v0.10.1`): Overfit- & Robustheitsauswertung `src/strategies/validator/overfit.ts` (Plateau-`robustShare`, IS/OOS-Lücke mit `BROKEN`/`SUSPECT`, Multiple-Testing-Warnung bis `BLOCKING` ab 21 Kandidaten, Holdout-Integrität `CLEAN`/`CONTAMINATED`/`UNKNOWN`) + 39 Tests + Teil 2 in [`docs/STRATEGY_VALIDATION.md`](../../STRATEGY_VALIDATION.md); STX-17 bleibt bis 06-04 in Arbeit; 06-05-Planung von `v0.10.1` auf `v0.10.4` verschoben (06-02/06-03/06-04 ziehen als eigene Releases vor) |
| `v1.1.18` | 2026-10-02 | 06-03 umgesetzt (`v0.10.2`): Cost- & Slippage-Stress-Runner `src/strategies/validator/stress.ts` (`COST_STRESS_SCENARIOS` 1×/2×/3× und 5/10/20 bp, `runInEngineStress()`, `summarizeStressSweep()` mit `degradationRatio` und linearer Interpolation von `breakevenMultiplier`, `runPostHocStress()` als Durchreiche an `runMonteCarloSimulation()`, `maxRuns = 45` / `--max-runs`) + 22 Tests + Teil 3 in [`docs/STRATEGY_VALIDATION.md`](../../STRATEGY_VALIDATION.md); **STX-11 behoben** |
| `v1.1.19` | 2026-10-02 | 06-04 umgesetzt (`v0.10.3`): Report + achtstufige Gate-Kette + Regime-Aggregation `src/strategies/validator/report.ts` (`VALIDATION_RESULTS`, `aggregateRegimeTrades()` point-in-time ohne `UNKNOWN`/`RANGE`-Fallback, `buildValidationReport()`, `assertReportHashIntegrity()`) und Evidence-Writer `persist.ts` (`recordEvidence()`, kein `requestTransition`), CLI `npm run validate:strategy` (`scripts/run-validate-strategy.ts`); `PROMOTION_POLICY_BOUNDS.validationMinPlateauShare` ergänzt; 32 + 6 Tests + Teil 4 in [`docs/STRATEGY_VALIDATION.md`](../../STRATEGY_VALIDATION.md); **STX-17 geschlossen**, STX-03 abgeschlossen |

| `v1.1.20` | 2026-10-02 | 06-05 umgesetzt (`v0.10.4`): erklärender Validator-Agent mit allowlisteter Report-Projektion, Injection-Block, strengem JSON-Schema, Shadow-Default, `LOCAL_FREE`/opt-in `OPENCODE_FREE` und bounded Telemetrie; 8 fokussierte Tests + Teil 5 in [`docs/STRATEGY_VALIDATION.md`](../../STRATEGY_VALIDATION.md); STX-13 geschlossen. Interpretation by-value; Persistenz/Workflow bleibt beim Aufrufer. |
| `v1.2.0` | 2026-10-03 | **Vollabgleich aller Findings gegen den Code-Stand** (`main` @ `3d13161`, Code-Version `0.10.6`) — [`remediation/RECONCILE-2026-10-03.md`](remediation/RECONCILE-2026-10-03.md). (a) **MINOR — neue Befunde:** [STX-20](findings/STX-20-changelog-nachtrag-copy-engine.md) (07-03 gemergt, aber ohne Changelog-Eintrag) und [STX-21](findings/STX-21-localfree-cloud-endpoint.md) (`LOCAL_FREE` garantiert Lokalität nur per Default-Konfiguration). (b) **MINOR — neue Phase:** Phase 8 mit 5 Folge-Prompts (08-01…08-05). (c) 7 Findings hochgestuft (STX-02, STX-06, STX-09, STX-10, STX-16, STX-19; STX-05 präzisiert), 1 korrigiert (STX-14 `OPEN` → `PARTIAL`), 0 zurückgenommen. (d) `TRACKING.md`, `ROADMAP.md`, Audit-`README.md` und die beiden Doku-Indizes auf denselben Stand gezogen — vorher wichen `ROADMAP`/`prompts/README` (PR #216) von `TRACKING` und den Findings ab. (e) **Kein Projekt-Release** (reine Doku, §5 V4; Präzedenz PR #216) |
| `v1.2.1` | 2026-10-03 | **PATCH — STX-20 behoben:** Prompt 08-01 ergänzt den Changelog-Nachtrag zu PR #215 unter `[Unreleased]` (Form A), mit Code-Version `0.10.6`; kein Projektversions-Bump, `[0.10.6]` bleibt unverändert. 21 Findings: 17 verifiziert umgesetzt, 2 teilweise, 2 offen (STX-08, STX-21). Ein Phase-8-Prompt erledigt, 4 offen |
| `v1.2.2` | 2026-10-03 | **PATCH — Altlast 3 behoben:** Prompt 08-02 ergänzt im Doku-Viewer (`resolveDoc()` in `src/lib/docsCatalog.ts`) die Suchpfade `docs/architecture/` und `docs/roadmap/` (nach `docs/security/`, vor `docs/archive/`) — Projekt-Release `v0.10.8` (Patch), `0.10.7` bleibt frei (08-01 als Form A ohne Bump). Parent-Referenzen (`..`) werden im Existenz-Fallback zusätzlich abgewiesen, `DOCS_CATALOG` bleibt unverändert; 8 neue Tests in `tests/docsCatalog.test.ts`. Ein Phase-8-Prompt zusätzlich erledigt, 3 offen |
| `v1.2.3` | 2026-10-03 | **PATCH — Altlast 1 behoben:** Prompt 08-03 leitet `STRATEGY_CLASS_KEYS` in `src/lib/signalDecay.ts` aus `STRATEGY_CLASSES` ab (`[...STRATEGY_CLASSES, "unclassified"]`), ersetzt die Literalvergleiche in `isStrategyClassKey()`, in der lokalen Closure `classOf()` (Risk-Config-Overrides `sdc.<klasse>.<feld>`) und in `metricClass()` (`src/lib/signalDecayRuntime.ts`) durch einen Lookup gegen die SSoT-Liste und ergänzt einen Quelltext-Wächter in `tests/adrVocabulary.test.ts` — die Muster werden aus `STRATEGY_CLASS_KEYS` gebaut, damit eine per ADR ergänzte fünfte Klasse sofort mitgeprüft wird; Projekt-Release `v0.10.9` (Patch). Typ, Reihenfolge und Werte unverändert, kein Verhaltenswechsel; **STX-02-Rest abgeschlossen, Altlast 1 behoben**, einzige dokumentierte Literalstelle bleiben die append-only DB-CHECKs. Zwei Phase-8-Prompts zusätzlich erledigt (08-01, 08-02, 08-03), 2 offen |

## 2. Release-Plan der Roadmap

Die Roadmap wird in **kleinen Minor-Releases** umgesetzt. Jede Phase bzw. jedes
Prompt-Paket ist ein eigener Release. **Kein Release überschreitet `0.x`.**

| Release | Inhalt | Prompts | Typ | Status Beta |
| --- | --- | --- | --- | --- |
| `v0.5.1` | Audit + Roadmap (PR #180) — **in `v0.6.0` gefaltet**, kein eigener Release | — | Doku | **Beta** |
| `v0.6.0` | **Backtest-Performance-Baseline** (00-01) + Audit-Doku aus PR #180 | 00-01 | Doku + Mess-Skript | **Beta** |
| `v0.6.1` | Strategie-Stack-SSoT + 3 ADRs (ausgeliefert 2026-09-29) | 00-02, 00-03 | Doku (+ lesender ADR-Test) | **Beta** |
| `v0.6.2` | **Timeframe-Angleichung** (STX-01, ausgeliefert 2026-09-29) | 01-01 | Minor (neue Felder im Vokabular) | **Beta** |
| `v0.6.3` | Indikatoren: `bollingerBands`, `donchianChannel` (ausgeliefert 2026-09-30) | 02-01 | Minor (additive pure Funktionen) | **Beta** |
| `v0.6.4` | Bollinger-Regelfelder + Parität (ausgeliefert 2026-09-30) | 02-02 | Minor (3 Felder) | **Beta** |
| `v0.6.5` | **Donchian-Regelfeld + Parität** (ausgeliefert 2026-09-30) | 02-03 | Minor (1 Feld) | **Beta** |
| `v0.7.0` | **Template-Vertrag** (`types.ts`, Katalog, Validierung) — ausgeliefert 2026-10-01 | 03-01, 03-02 | Minor (neue Domäne) | **Beta** |
| `v0.7.1` | Template EMA/ADX — ausgeliefert 2026-10-01 (Abnahme über 03-09 `v0.7.5` / 03-10 `v0.7.6` nachgezogen) | 03-03 | Minor | **Beta** |
| `v0.7.2` | Template MACD — ausgeliefert 2026-10-01 | 03-04 | Minor | **Beta** |
| `v0.7.3` | Template RSI Mean-Reversion — ausgeliefert 2026-10-01 | 03-05 | Minor | **Beta** |
| `v0.7.4` | Templates Bollinger Squeeze, VWAP (Snapshot) & Donchian Breakout — ausgeliefert 2026-10-01 (die geplanten Einzel-Releases `v0.7.5`/`v0.7.6` entfallen: ein Bump pro PR, die drei Artefakte wurden zusammen abgenommen) | 03-06, 03-07, 03-08 | Minor | **Beta** |
| `v0.7.5` | **Compiler + Sanitize-Nachweis** — ausgeliefert 2026-10-01 (eigenes Release statt Faltung in ein Template-Release: der sicherheitskritische Übergang braucht einen eigenen, einzeln rollbackbaren Release-Punkt) | 03-09 | Minor (neues Modul) | **Beta** |
| `v0.7.6` | **Template-Vertragstests + Katalog-Doku** — ausgeliefert 2026-10-01 (Phase-3-Abnahme: Struktur, Compiler-Parität, Positiv-/Negativ-Fixtures je Template × Takt, Katalog-Integrität, Engine-↔-Cache-Parität; `docs/STRATEGY_TEMPLATES.md` aus dem Katalog generiert) | 03-10 | Test + Doku (kein Produktivcode) | **Beta** |
| `v0.8.0` | Schemafundament `strategy_definitions` + `strategy_versions` (04-01); der App-Service/Schreibpfad aus 04-02 bleibt für die vollständige Phase-4-Abnahme erforderlich | 04-01 (04-02 folgt) | Minor (additive Migration) | **Beta — Schema ausgeliefert, Service offen** |
| `v0.9.0` | Screening: Typen, Priorität, Matrix, Persistenz, Runner + CLI | 05-01…05-04 | Minor | **Beta** |
| `v0.10.0` | Validator deterministisch, Stufe 1: Annahmen-Audit — ausgeliefert 2026-10-02 | 06-01 | Minor | **Beta — Overfit/Stress/Report offen** |
| `v0.10.1` | Validator deterministisch, Stufe 2: Plateau, IS/OOS-Lücke, Multiple Testing, Holdout-Integrität — ausgeliefert 2026-10-02 | 06-02 | Minor (neues Modul) | **Beta — Stress/Report offen** |
| `v0.10.2` | Validator deterministisch, Stufe 3: Cost- & Slippage-Stress-Runner — ausgeliefert 2026-10-02 | 06-03 | Minor (neues Modul) | **Beta — Report offen** |
| `v0.10.3` | Validator-Report + Evidence-Writer + CLI — ausgeliefert 2026-10-02 | 06-04 | Minor | **Beta — nur Agent (06-05) offen** |
| `v0.10.4` | Validator-Agent (Shadow-Mode, erklärt nur) — umgesetzt 2026-10-02 | 06-05 | Minor | **Beta — Phase 6 abgeschlossen** |
| `v0.11.0` | Copy-Domänenmodell (rein) | 07-01 | Minor | **Beta** |
| `v0.11.1` | Copy-Policy + Order-Links (`SIMULATE_ONLY`) | 07-02 | Minor | **Beta** |
| `v0.11.2` | Bitunix-Leader + Simulate-only-Follower | 07-03 | Minor | **Beta** |
| `[Unreleased]` (kein Projektversions-Bump) | Changelog-Nachtrag Copy-Engine 07-03 — [STX-20](findings/STX-20-changelog-nachtrag-copy-engine.md), 08-01 erledigt am 2026-10-03; Code-Version `0.10.6` | 08-01 | Doku | **Beta** |
| `v0.10.8` | Doku-Viewer-Suchpfade `docs/architecture/` + `docs/roadmap/` (Altlast 3) — ausgeliefert 2026-10-03 | 08-02 | Patch | **Beta** |
| `v0.10.9` | Klassen-Literale in `signalDecay*` aus der SSoT (STX-02-Rest, Altlast 1) — ausgeliefert 2026-10-03 | 08-03 | Patch | **Beta** |
| `v0.10.10` *(vorgeschlagen)* | `LOCAL_FREE`-Endpunkt absichern — [STX-21](findings/STX-21-localfree-cloud-endpoint.md) | 08-05 | Patch | **Beta** |
| `v0.11.0` *(vorgezogen)* | `backtestRule()` auf den Indicator-Cache mit Paritätsnachweis — [STX-12](findings/STX-12-backtestrule-o-n-quadratisch.md); **Kollision mit dem geplanten Copy-Release `v0.11.0`** — Nummer beim Umsetzen neu vergeben | 08-04 | Minor (Handelslogik, byte-identisch) | **Beta** |
| *(optional)* | Feature-Store-Slice `rule.*` | 02-04 | Minor | **Beta** |

**Entschieden (2026-10-01):** 03-09 wurde als eigenes Release `v0.7.5`
ausgeliefert — der Compiler ist der sicherheitskritische Übergang (Finding
STX-05) und bekommt damit einen eigenen Rollback-Punkt; 03-10 folgte als
Template-Vertragstests in `v0.7.6` und schließt Phase 3 ab (Gate G3).

**Entschieden (2026-10-01):** `v0.8.0` eröffnet Phase 4 mit 04-01 als
Schemafundament. Die Migration kann Definitionen und Versionen speichern, aber
ohne 04-02 existiert noch kein Anwendungspfad; STX-06 bleibt deshalb in Arbeit.

**Entschieden (2026-10-03):** 08-01 folgt **Form A**: Der Nachtrag für 07-03
steht unter `[Unreleased]`; es gibt keinen Projektversions-Bump, und der
Projekt-Code-Stand bleibt `0.10.6`. STX-20 ist mit Audit-PATCH `v1.2.1`
geschlossen.

**Entschieden (2026-10-03):** 08-03 wird wie geplant als `v0.10.9` ausgeliefert
(Patch — `src/lib/signalDecay.ts`/`src/lib/signalDecayRuntime.ts` plus Wächter,
kein Schema, kein Verhaltenswechsel).

**Entschieden (2026-10-03):** Wegen Form A bleibt `v0.10.7` unbenutzt; 08-02
wird im vorliegend geplanten Slot `v0.10.8` ausgeliefert (Patch — nur
`src/lib/docsCatalog.ts` plus Tests). Die Nummern der übrigen Phase-8-Prompts
(`v0.10.9` 08-03, `v0.10.10` 08-05, 08-04 Minor) bleiben damit gültig.

**Entschieden (2026-10-02):** 06-02 wurde als eigenes Release `v0.10.1`
ausgeliefert (ein Prompt = ein Bump, wie in Phase 3). Damit verschiebt sich die
Planung der restlichen Phase-6-Prompts: Cost-Stress (06-03) ⇒ `v0.10.2`,
Report + CLI (06-04) ⇒ `v0.10.3`, Validator-Agent (06-05) ⇒ `v0.10.4`. Grund:
Die Validator-Stufen sind einzeln prüf- und rollbackbare Artefakte; ein
Sammel-Release würde den Rollback-Punkt verwischen. 06-05 ist mit `v0.10.4`
umgesetzt; der Agent gibt ausschließlich eine Interpretation zurück, eine
automatische Persistenz in `detail jsonb` ist nicht Teil dieses Releases.

### 2.1 Warum eigene Releases je Template

Jedes Template ist ein **eigenständig prüfbares Artefakt** mit eigener
Annahme-Kette. Ein Release je Template bedeutet:

- ein Rollback-Punkt pro Strategie
- ein Changelog-Eintrag, der eine fachliche Aussage macht
- eine getrennte Sichtbarkeit: „wir haben 3 von 6 geprüft" ist eine ehrliche
  Zwischenmeldung, „wir haben 6" erst nach dem sechsten

### 2.2 Was **kein** Release dieses Plans auslöst

| Ereignis | Folge |
| --- | --- |
| Alle 32 Prompts `☑` | **Kein** Beta-Exit. Siehe [`BETA_STATUS.md`](../../BETA_STATUS.md). |
| Alle 6 Templates `PASS` im Validator | **Kein** Beta-Exit. Ein `PASS` ist ein Filterergebnis, kein Nachweis. |
| `v0.11.2` erreicht | **Kein** Beta-Exit. `SIMULATE_ONLY` bleibt `SIMULATE_ONLY`. |
| Sicherheitsaudit ohne offene Findings | **Kein** Beta-Exit. Erfüllt allein `B4`. |

## 3. Versionsregeln für die Umsetzung

1. **Jeder Release beginnt mit `CHANGELOG.md` unter `[Unreleased]`.**
2. **Migrationen sind append-only** und folgen `drizzle/YYYY-MM-DD_kurzname.sql`.
3. **Bestehende Backtest-Ergebnisse bleiben byte-identisch**, außer der Release
   ändert das ausdrücklich im Changelog. `executionModel` defaultet weiter auf
   `"legacy"`.
4. **Kein Release entfernt eine `RULE_FIELDS`-Option.** Felder werden addiert;
   ihr Wegfallen ist ein MAJOR-Bruch und braucht eine Migrationsstrategie für
   `trade_rules`.
5. **Pflicht-Checks** vor jedem Release:
   `npm run typecheck && npm run lint && npm test && npm run docs:validate`.
6. **`VERSION.md` und `README.md`** werden im selben Commit wie der Versions-Bump
   aktualisiert (Status-Header + Komponentenliste), weil `docs:validate` die
   Versions-Konsistenz über `package.json` ↔ `CHANGELOG.md` ↔ Status-Header prüft.

## 4. Abwärtskompatibilität in `0.x`

SemVer erlaubt in `0.x` Breaking Changes, wenn sie dokumentiert sind. Für diese
Roadmap sind drei echte Bruchstellen vorgesehen — alle drei bewusst:

| Bruchstelle | Release | Was bricht | Migrationspfad |
| --- | --- | --- | --- |
| `RuleWindow.timeframe` wird von 5 auf 10 Werte erweitert | `v0.6.2` (umgesetzt) | Code, der `ALLOWED_TIMEFRAMES` als geschlossene Menge behandelt | `RULE_ALLOWED_TIMEFRAMES` ist jetzt exportiert und aus `SUPPORTED_TIMEFRAMES` abgeleitet; der Mikro-Executor wertet weiter nur bis `1h` aus (Timeframe-Guard) |
| `RuleSnapshot` und `IndicatorCache` wachsen um 4 Felder | `v0.6.4`/`v0.6.5` (umgesetzt) | Code, der `RuleSnapshot` als geschlossene Union typisiert | Felder sind additiv, aber die **Parität** beider Snapshot-Pfade wird jetzt getestet (Bollinger- und Donchian-Feld, Bar für Bar; seit `v0.7.6` zusätzlich exakt in `tests/strategies.templates.test.ts` festgenagelt) |
| `COPY_MODE`-Enum existiert | `v0.11.0` | Kein bestehender Code (Modul ist neu) | keine |

## 5. Offene Versionsfragen

| # | Frage | Entscheidung |
| --- | --- | --- |
| V1 | Muss ein Templates-Release auch eine `v1`-Version der Strategie-Bibliothek tragen? | Empfehlung: **nein** — `templateVersion` im Artefakt-Hash genügt (04-01). |
| V2 | Wann wird `0.x` verlassen? | **Nicht durch diese Roadmap planbar.** Erst wenn `B1…B8` belegt sind, siehe [`BETA_STATUS.md`](../../BETA_STATUS.md). |
| V3 | Braucht Phase 7 ein eigenes Release-Train? | Empfehlung: **nein**, sie folgt `v0.11.0–v0.11.2`, weil sie organisatorisch abhängig (`B5`) ist. |
| V4 | Muss `v0.5.1` existieren, wenn nur Doku geändert wurde? | **Nein** — die Audit-Doku aus PR #180 wurde ohne eigenen Bump gemergt und ist in `v0.6.0` gefaltet (siehe `CHANGELOG.md`); so bleibt „ein Release = ein prüfbares Paket“ gewahrt. |

---

## Verwandte Dokumente

- [`README.md`](README.md) — Audit-Index
- [`ROADMAP.md`](ROADMAP.md) — Phasen, Gates, Abhängigkeiten
- [`../../../VERSION.md`](../../../VERSION.md) — Projekt-Versions-Metadaten
- [`../../BETA_STATUS.md`](../../BETA_STATUS.md) — Beta-Zusage und Exit-Kriterien
- [`../../../CHANGELOG.md`](../../../CHANGELOG.md) — Changelog
- [`../../../docs/README.md`](../../../docs/README.md) — Doku-Index
