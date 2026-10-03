# Abgleich Findings ↔ Code-Stand — 2026-10-03

- **Audit:** [`../README.md`](../README.md) · **Roadmap:** [`../ROADMAP.md`](../ROADMAP.md) · **Tracking:** [`TRACKING.md`](TRACKING.md)
- **Datum des Abgleichs:** 2026-10-03
- **Geprüfter Stand:** `main` @ `3d13161` (`Merge pull request #216`)
- **Code-Version:** `package.json` `0.10.6` (Beta)
- **Prüfmethode:** Quelltext auf `main` + GitHub-Commit-/PR-Historie (`gh api`) + lokal ausgeführte Testsuiten
- **Audit-Version nach diesem Abgleich:** `v1.2.0` ([`../VERSIONING.md`](../VERSIONING.md))

> **Zweck:** Die Findings, die `ROADMAP.md` und `TRACKING.md` wichen vor diesem
> Abgleich voneinander ab — `ROADMAP.md`/`prompts/README.md` waren mit PR #216
> (2026-10-03) auf „alle 32 Prompts umgesetzt" gezogen worden, `TRACKING.md`,
> die 19 Finding-Dateien und die beiden Doku-Indizes nicht. Dieser Abgleich
> bestimmt pro Finding den **verifizierten** Ist-Stand und macht ihn zur
> einzigen Aussage. Jede Einstufung ist mit Dateipfad, Commit/PR oder Test belegt.

---

## 1. Methode und Grenzen der Verifizierbarkeit

**Verifiziert** heißt hier: die Behauptung ist im Quelltext auf `main` lesbar,
über die GitHub-Historie belegt oder durch einen lokal ausgeführten Test
bestätigt.

| Prüfschritt | Ergebnis |
|---|---|
| Referenzierte Commits auf GitHub | **34/34 vorhanden** (`gh api repos/Kryschuuu/ai-trading-firm/commits/<sha>`) — u. a. `7995822`, `7f28e82`, `66be0c6`, `9d73aeb`, `a90fa62`, `4267715`, `211e022`, `c797ae7`, `0915c20`, `a2de401`, `a34744b`, `0ab0d0a`, `4812f21`, `b0bfcce`, `f5af325`, `5f437d8` |
| Lokaler Klon | **Shallow** (1 Commit, `git rev-parse --is-shallow-repository` → `true`); Commit-Hashes sind deshalb **nur** über die GitHub-API verifizierbar, nicht über lokales `git log` |
| Ausgeführte Testsuiten (ohne DB) | `adrVocabulary`, `strategies.templates`, `strategies.compiler.security`, `strategies.catalog` → **195 Tests, 0 Fehler** |
| | `strategyValidation.{assumptions,overfit,stress,report,agent}` → **139 Tests, 0 Fehler** |
| | `copy.{domain,policy,engine}`, `screening.{priority,matrix,runner,backtestAdapter,keys}`, `ruleFeatureStoreParity`, `strategyScreening.keys` → **127 Tests, 0 Fehler** |
| `npm run docs:validate` | grün (8 Checks) — vor und nach diesem Abgleich |
| **Nicht ausführbar** | PostgreSQL ist in der Abgleich-Umgebung nicht vorhanden (`pg_isready` fehlt). Alle `*.db.test.ts` (`strategyCatalog.db`, `strategyCatalog.service`, `strategyScreening.db`, `copy.db`, `strategyValidation.persist`) wurden **nicht** ausgeführt |

**Konsequenz für die Einstufung:** Wo ein Abnahmekriterium ausschließlich durch
einen DB-Test belegt wird, steht im Finding ausdrücklich **„nicht verifizierbar
(kein PostgreSQL in der Abgleich-Umgebung)"**. Der Code-Pfad ist benannt und
geprüft, die Laufzeitaussage nicht. Das betrifft **STX-06** (Idempotenz des
App-Services) und Teile von **STX-07**.

---

## 2. Statusübersicht nach dem Abgleich

Legende: `☑` umgesetzt/verifiziert · `◐` teilweise · `☐` offen

| ID | Severity | Status **vor** Abgleich | Status **verifiziert** | Beleg |
|---|---|---|---|---|
| [STX-01](../findings/STX-01-rule-timeframe-blocker.md) | HIGH | `☑` FIXED | **`☑` FIXED** | `src/lib/marketdata/timeframes.ts:22-59`; `RULE_ALLOWED_TIMEFRAMES = SUPPORTED_TIMEFRAMES` (`src/lib/ruleEngine.ts:268`); Guard `executionInterval` (`src/lib/microExecutor.ts:215-218,1291`) |
| [STX-02](../findings/STX-02-strategyclass-duplikat.md) | HIGH | `◐` IN ARBEIT | **`☑` FIXED** | alle 6 Templates deklarieren `class` (`trend`×3, `breakout`×2, `mean-reversion`×1), keines `unclassified`; `CompileResult.strategyClass = template.class` (`compiler.ts:633`); Test `strategies.templates.test.ts:472-530,561` |
| [STX-03](../findings/STX-03-regime-vokabular-konflikt.md) | HIGH | `☑` FIXED | **`☑` FIXED** | `aggregateRegimeTrades()` (`validator/report.ts:438`), `UNKNOWN` ausgeschlossen, kein `RANGE`-Fallback (`report.ts:387-390,484`); Wächter `tests/adrVocabulary.test.ts:200-212` |
| [STX-04](../findings/STX-04-multiaset-spec-duplikat.md) | HIGH | `☑` FIXED | **`☑` FIXED** | kein `MultiAssetStrategySpec` in `src/`; Wächter `tests/adrVocabulary.test.ts:410-412` |
| [STX-05](../findings/STX-05-template-builder-umgeht-sanitize.md) | HIGH | `☑` FIXED | **`☑` FIXED** (Kriterium 5 präzisiert) | `compiler.ts` einziger `buildRule()`-Aufrufer, `sanitizeRuleSpec()` Pflicht, `clamped`-Nachweis; Persistenz vor Lauf in `scripts/run-screening.ts:671-694` und `scripts/run-validate-strategy.ts:461-484`; **kein** Live-/Executor-Pfad konsumiert Templates |
| [STX-06](../findings/STX-06-keine-strategy-versions-persistenz.md) | MEDIUM | `◐` IN ARBEIT | **`☑` FIXED** (Idempotenz-Nachweis nicht ausführbar) | `src/strategies/service.ts`: `ensureDefinition()` `:147`, `createVersion()` `:328`, `getVersionByFingerprint()` `:260`, `calculateVersionContentHash()` `stv1:` `:95-113` |
| [STX-07](../findings/STX-07-backtest-runs-scope.md) | MEDIUM | `☑` FIXED | **`☑` FIXED** | `strategy_screening_runs`/`strategy_market_results` (`src/db/schema.ts:3286,3317` + `drizzle/2026-10-01_strategy_screening.sql`); `backtest_runs.instrumentId` unverändert `notNull` (`schema.ts:230`) |
| [STX-08](../findings/STX-08-alpaca-ohne-websocket.md) | MEDIUM | `☐` OPEN | **`☐` OPEN** (bestätigt) | `grep -rniE "wss://\|websocket" src/brokers/alpaca/` → **0 Treffer**; `src/brokers/bitunix/ws.ts` existiert |
| [STX-09](../findings/STX-09-copysystem-duplikat-reconciliation.md) | MEDIUM | `☐` OPEN | **`☑` FIXED** | kein eigener Reconciler; `src/copy/follower/simulated.ts:54-55` nutzt `newIntent`/`synchronousResult` aus `@/executionQuality`; `copy_order_links.state` CHECK exakt `PENDING/SENT/PARTIAL/FILLED/FAILED/DIVERGED` (`drizzle/2026-10-03_copy_subscriptions.sql:60-61`); kein Cancel-Pfad nach Fill (`copy/store.ts:6,280`) |
| [STX-10](../findings/STX-10-featurestore-ist-slice.md) | MEDIUM | `◐` IN ARBEIT | **`☑` FIXED** | `RULE_FEATURE_IDS` (`src/features/definitions.ts:42-46`), Executors (`src/features/compute.ts:382-384`), Paritätstest `tests/ruleFeatureStoreParity.test.ts` grün |
| [STX-11](../findings/STX-11-cost-stress-existiert.md) | MEDIUM | `☑` FIXED | **`☑` FIXED** | `src/strategies/validator/stress.ts`: `COST_STRESS_SCENARIOS` `:95`, `DEFAULT_MAX_STRESS_RUNS = 45` `:130`; `tests/strategyValidation.stress.test.ts` grün |
| [STX-12](../findings/STX-12-backtestrule-o-n-quadratisch.md) | MEDIUM | `◐` IN ARBEIT | **`◐` PARTIAL** | `backtestRule()` rechnet weiter pro Bar über die volle Historie: `candles.slice(0, i + 1)` (`src/lib/ruleEngine.ts:894`), **kein** `IndicatorCache`-Import in `ruleEngine.ts`; Screening umgeht den Pfad (`src/screening/backtestAdapter.ts:54`); Altpfad lebt weiter in `src/lib/ruleBacktest.ts:385` |
| [STX-13](../findings/STX-13-opencode-free-tier.md) | LOW | `☑` FIXED | **`☑` FIXED** (Restpunkt → STX-21) | `LOCAL_FREE`/`OPENCODE_FREE` als Policy-Flag, kein Routing-Typ (`validator/agent.ts:44-45,175,427-429`); Ausfall ⇒ `{ unavailable: true }` (`agent.ts:183,541`); Tests `strategyValidation.agent.test.ts:143,186` grün |
| [STX-14](../findings/STX-14-changepct24h-semantik.md) | LOW | `☐` OPEN | **`◐` PARTIAL** | Prüfung `CHANGE_PCT_SEMANTICS` vorhanden (`validator/assumptions.ts:156,903-920,968`), Test `strategyValidation.assumptions.test.ts:536`; 97-Perioden-Rechnung unverändert (`ruleEngine.ts:706`); `changePctBars` existiert **nicht** (`grep` in `src/` → 0 Treffer) |
| [STX-15](../findings/STX-15-scanner-faktorzahl.md) | LOW | `☑` FIXED | **`☑` FIXED** | `src/scanner/scanner.config.json` → **14** Faktoren, exakt die im Finding genannte Liste; 17 `.ts`-Dateien in `src/scanner/factors/` (inkl. `helpers.ts`, `index.ts`) |
| [STX-16](../findings/STX-16-copy-trading-compliance.md) | LOW | `☐` OPEN | **`☑` FIXED** | `export type CopyMode = "SIMULATE_ONLY"` + `COPY_MODES` mit **einem** Wert (`src/copy/types.ts:32,39`); DB-CHECK `mode = 'SIMULATE_ONLY'` (`drizzle/2026-10-03_copy_subscriptions.sql:39`); Follower nur über `PaperBroker.submit()` (`copy/follower/simulated.ts:360`), kein `BrokerAdapter`; Test `tests/copy.engine.test.ts` grün |
| [STX-17](../findings/STX-17-info-validator-agent-kompatibel.md) | INFO | `☑` FIXED | **`☑` FIXED** | `VALIDATION_RESULTS = ["PASS","FAIL","INCONCLUSIVE"]` (`validator/report.ts:117`); Writer über `recordEvidence()` (`validator/persist.ts:30`); kein `requestTransition` (statischer Wächter `tests/strategyValidation.report.test.ts:540-545`) |
| [STX-18](../findings/STX-18-info-rulespec-traegt-templates.md) | INFO | `☑` GEKLÄRT | **`☑` VERIFIED** | 6 Templates gebaut (`src/strategies/templates/`); generierte Doku `docs/STRATEGY_TEMPLATES.md:21-28`; Vertragstests `tests/strategies.templates.test.ts` (195 Tests im Paket grün) |
| [STX-19](../findings/STX-19-info-kafka-einwand.md) | INFO | `☐` OPEN | **`☑` VERIFIED** | `package.json` `dependencies` enthalten weder Kafka noch NATS, Redis oder DuckDB; `grep -rniE "\bkafka\b\|\bnats\b\|\bredis\b\|\bduckdb\b" src/` → **0 Treffer**; `ws` bleibt die einzige zusätzliche Laufzeitabhängigkeit |
| [STX-20](../findings/STX-20-changelog-nachtrag-copy-engine.md) | LOW | — | **`☐` OPEN** (neu in diesem Abgleich) | `CHANGELOG.md` `[Unreleased]` ist **leer**; oberster Eintrag `[0.10.6]` deckt nur STX-07-02 ab; `grep "copy:paper\|NO_BASELINE\|run-copy-paper" CHANGELOG.md` → 0 Treffer, obwohl PR #215 (`5f437d8`) gemergt und `npm run copy:paper` in `package.json` vorhanden ist |
| [STX-21](../findings/STX-21-localfree-cloud-endpoint.md) | LOW | — | **`☐` OPEN** (neu in diesem Abgleich) | `LOCAL_FREE_PROVIDERS = ["ollama", "openai"]` (`validator/agent.ts:44`); `openai`-Basis-URL ist über `LLM_BASE_URL` konfigurierbar (`src/lib/llmProvider.ts:210`, Default `http://127.0.0.1:8080/v1` `:150`); `filterEnabledProviders` filtert nur nach Toggle, nicht nach Endpunkt (`src/routing/providerToggles.ts:105-110`) |

### Zählung

| Severity | Anzahl | Offen | Teilweise | Verifiziert umgesetzt |
|---|---:|---:|---:|---:|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 5 | 0 | 0 | 5 |
| MEDIUM | 7 | 1 | 1 | 5 |
| LOW | 6 | 2 | 1 | 3 |
| INFO | 3 | 0 | 0 | 3 |
| **Σ** | **21** | **3** | **2** | **16** |

**Änderungen gegenüber der Doku vor dem Abgleich:** 7 Findings wurden von
`OPEN`/`IN ARBEIT` auf **verifiziert umgesetzt** hochgestuft (STX-02, STX-06,
STX-09, STX-10, STX-16, STX-19 sowie die Präzisierung von STX-05). 1 Finding
wurde von `OPEN` auf **teilweise** korrigiert (STX-14 — die Prüfung existiert,
die Feld-Deprekation nicht). **2 Findings sind neu** (STX-20, STX-21).
Kein Finding wurde herabgestuft; kein Finding wurde als `FALSE_POSITIVE`
zurückgenommen.

---

## 3. Befundkorrekturen am Befund selbst

Der Abgleich hat drei Stellen gefunden, an denen die **Formulierung** des Audits
nicht zum Code passt. Sie sind korrigiert, ohne die Aussage zu verändern:

1. **STX-05, Kriterium 5** („Jedes erzeugte Spec wird persistiert, bevor es
   gehandelt wird") war als offen geführt mit Verweis auf 04-02. 04-02 ist
   gemergt, aber `src/strategies/service.ts` ist ausdrücklich **Registry, nicht
   Executor** (Modulkopf Zeile 12: „Live-Ausführung bleibt beim
   `trade_rules`-Pfad"). Es gibt **keinen** Live-Pfad, der Template-Specs
   handelt — das Kriterium ist für die zwei vorhandenen Pfade (Screening,
   Validierung) erfüllt, für Live-Leerlauf trivial erfüllt. Präzisiert, nicht
   abgehakt als „End-to-End verdrahtet".
2. **`TRACKING.md`, Altlasten-Tabelle** nannte in `src/lib/signalDecay.ts` die
   Funktion `classOf`. Exportiert ist **`classKey()`** (`signalDecay.ts:435`);
   `classOf` ist eine lokale Closure an `signalDecay.ts:1544`. Benennung
   korrigiert.
3. **STX-19, Beweisliste** der `dependencies` nennt `react`, nicht `react-dom`.
   Tatsächlich sind beide vorhanden. Für die Aussage (kein Kafka/NATS/Redis/
   DuckDB) ohne Belang; Liste aktualisiert.

---

## 4. Was **nicht** verifiziert werden konnte

| Punkt | Warum nicht | Folge |
|---|---|---|
| Idempotenz des Strategie-Services unter parallelem Retry (**STX-06**) | `tests/strategyCatalog.service.test.ts` und `strategyCatalog.db.test.ts` brauchen PostgreSQL; in der Abgleich-Umgebung nicht installiert | Im Finding als **„nicht verifizierbar"** markiert. Code-Pfad benannt, Laufzeitaussage offen |
| Screening-Run-/Zell-Idempotenz auf DB-Ebene (**STX-07**) | `tests/strategyScreening.db.test.ts` braucht PostgreSQL | dito; die reinen Schlüssel-Tests (`strategyScreening.keys`) sind grün |
| Copy-Order-Link-Transaktionen auf DB-Ebene (**STX-09**) | `tests/copy.db.test.ts` braucht PostgreSQL | dito; Schema-CHECKs und reine Policy-Tests sind grün |
| Evidence-Writer-Idempotenz (**STX-17**) | `tests/strategyValidation.persist.test.ts` braucht PostgreSQL | dito |
| **Gate G6** — Screening-Pilot 50 Zellen < 1 Kernstunde | braucht echte Marktdaten **und** PostgreSQL | bleibt offen, siehe [`SCREENING-PILOT.md`](SCREENING-PILOT.md) |
| Commit-Hashes über lokales `git log` | Klon ist shallow (1 Commit) | über `gh api` gegen GitHub verifiziert, siehe §1 |

---

## 5. Konsistenz der Audit-Dokumente nach dem Abgleich

| Dokument | Stand vor Abgleich | Stand nach Abgleich |
|---|---|---|
| [`ROADMAP.md`](../ROADMAP.md) | alle 32 Prompts ✅ (PR #216) | unverändert ✅, um **Phase 8** (5 Folge-Prompts) und korrigierte Gate-Tabelle ergänzt |
| [`prompts/README.md`](../prompts/README.md) | alle 32 Prompts ☑ (PR #216) | unverändert ☑, Phase 8 ergänzt |
| [`TRACKING.md`](TRACKING.md) | **veraltet** — 02-04/04-02/05-01/05-02/07-01…07-03 `☐`; STX-02/06/10/12/14 `◐`, STX-08/09/16/19 `☐` | auf den verifizierten Stand gezogen, Findings STX-20/21 ergänzt |
| [`README.md`](../README.md) | Audit `v1.1.20`, „Phasen 0–3 abgeschlossen", 6 offen / 5 in Arbeit / 8 gefixt | Audit `v1.2.0`, 21 Findings, Zählung aus §2 |
| [`VERSIONING.md`](../VERSIONING.md) | `v1.1.20`, Historie endet bei 06-05 | `v1.2.0` + Historieneintrag + Release-Plan für Phase 8 |
| [`../../../README.md`](../../../README.md) (Doku-Index) | „OPEN (Audit v1.1.14: Phasen 0–3 abgeschlossen …)" | auf `v1.2.0` und die verifizierten Findings gezogen |
| [`../../README.md`](../../README.md) (Audit-Index) | „OPEN (Audit v1.1.14 …)" | dito |

**Projektrelease:** bewusst **kein** Bump von `package.json`/`CHANGELOG.md`.
Begründung: [`../VERSIONING.md`](../VERSIONING.md) §5 V4 — reine Doku-Änderung
löst keinen Projekt-Release aus; Präzedenzfall ist PR #216 (ebenfalls reine
Audit-Doku, ohne Bump). Versioniert wird über die **Audit-Version** `v1.2.0`.
Die Lücke im Projekt-Changelog (07-03 ohne Eintrag) ist als **STX-20** erfasst
und bekommt mit [Prompt 08-01](../prompts/PROMPT-STX-08-01-changelog-nachtrag-copy-engine.md)
einen eigenen, abgegrenzten Auftrag — denn dort ist eine Release-Entscheidung
(`v0.10.7` vs. `[Unreleased]`) zu treffen, die nicht Teil eines Audit-PRs ist.
