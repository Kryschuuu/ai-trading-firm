# Docs↔Code-Audit — Ist/Soll-Abgleich der Dokumentation

> **Status-Header:** **Bestandsdokument** · **Stand:** 2026-10-06 (Umsetzungsstand § 0.0 nachgeführt 2026-10-10) · **Code-Version:** v0.17.2 (Beta) · Architektur-Doku gegen `src/` + `scripts/` abgeglichen — [DC-06](audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md) **FIXED** 2026-10-09 · Prüfbasis laut Bericht `main` @ `104aaef` (im Klon nicht auffindbar; Pfadverweise teils veraltet).

Dies ist ein **externer Audit-Bericht** (kein Modul-Status-Header im Sinne der
Doku-Konvention). Er beschreibt den Abgleich zwischen `docs/` (338
Markdown-Dateien, rund 54.800 Zeilen, dazu `help/`-JSON und `ci/`-Workflows)
und dem tatsächlichen Code-/Commit-Stand von
`v0.17.2`.

---

## 0.0 Umsetzungsstand (Nachtrag 2026-10-10)

Dieser Bericht ist zugleich der Ausgangspunkt eines **Audit-Zyklus**:
[`docs/audits/2026-10-06-docs-code-audit/`](audits/2026-10-06-docs-code-audit/README.md)
führt die Befunde als DC-01…DC-09 mit Status, Tracking und kopierfertigen
Prompts. Bereits **behoben** (Nachweis in Tracking und Findings):

| Befund | vorher | jetzt |
|--------|--------|-------|
| **DC-01** (H1) | `POST /api/firm/proposals/[id]/approve` ohne `requirePermission`/CSRF | `firm.write` + `checkCsrfGuard` **vor** jedem DB-Zugriff; Actor-Identität im Audit (`authenticatedActor`); `tests/proposalApprove.auth.test.ts` (7 Tests) |
| **DC-02** (H2) | Anzeige `=== "true"` vs. Gates `!== "false"` | eine Semantik über `humanApprovalRequired()` (live-gate), `tests/firmHumanApproval.parity.test.ts` |
| **DC-03** (M4/M5/M7/M8/N1–N5/N7/N8) | 12 Doku-Einzelfehler | behoben, siehe [DC-03](audits/2026-10-06-docs-code-audit/findings/DC-03-doku-kleinfindings.md) (Vorher/Nachher-Tabelle) |

| **DC-04** (M1) | 4 von 45 Dokumenten mit passendem Versions-/Status-Header | Header klassifiziert (3 × verifiziert `v0.17.2`, 3 × Dokument-/Review-Version, 63 × „Bestandsdokument · Vollabgleich offen"); PR #236 · [DC-04 § Umsetzung](audits/2026-10-06-docs-code-audit/findings/DC-04-versions-header-drift.md) |
| **DC-05** (M2/N6) | 4 dokumentierte Env-Flags ohne Code-Read; `.env.example` lückenhaft | zwei Flags implementiert (`CYCLE_RETENTION_DAYS`/`_WEEKS`), zwei gestrichen (Doku nennt die echten Quellen), `MICRO_FEED_TYPE` → `MICRO_FEED`; `.env.example` + `CONFIGURATION.md` auf den echten Lese-Bestand ergänzt · [DC-05 § Umsetzung](audits/2026-10-06-docs-code-audit/findings/DC-05-env-flags-ohne-implementierung.md) |
| **DC-06** (M6) | 34 Symbole/Pfade in der Architektur-Doku ohne Code-Entsprechung | reale Exporte + korrekte Modulgrenzen in `PIPELINE_MAP.md`, `INTEGRATION_POINTS.md`, `MISSIONS.md`, `DOCS_SYNC_AUDIT.md`; neue Absätze „Zwei Risk-Guards, zwei Zwecke" und „8. Pflege dieser Karte"; `tests/docsArchitectureSymbols.test.ts` (9 Tests) · [DC-06 § Umsetzung](audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md) |
| **DC-07** (M7) | `DB_SCHEMA.md` zeigt 15 statt 67 Tabellen | Generator `scripts/gen-schema-inventory.ts`, `docs/generated/schema-inventory.md` 67/67 · [DC-07](audits/2026-10-06-docs-code-audit/findings/DC-07-db-schema-15-von-67.md) |
| **DC-08** (M8b) | fünf Lücken im Docs-Wächter und PAPER-Contract-DB-Fehler | L1–L4 Checks + Counterprobes; L2 bleibt Warnung; L5 Variante A: `npm test` in `docs-validate`, Broker-Contracts starten Embedded-PostgreSQL und bestehen 42/42 · [DC-08](audits/2026-10-06-docs-code-audit/findings/DC-08-ci-waechter-luecken.md) |

**Stand:** Alle neun Befunde sind erledigt (DC-09 am 2026-10-10: generierte Inventare, Header-Bump, Konvention). DC-01…DC-08 waren vorher erledigt; die Befundtexte unten bleiben als Audit-Historie unverändert.

Die Befund-Nummern unten (H1/H2/M…/N…) bleiben als Audit-Historie unverändert;
die Zuordnung zu DC-IDs steht in der Tabelle
[`audits/2026-10-06-docs-code-audit/README.md`](audits/2026-10-06-docs-code-audit/README.md).

---

## 0. Auftrag, Vorgehen, Prüfbasis

Geprüft wurden alle `docs/`-Bäume (Top-Level, `architecture/`, `roadmap/`,
`security/`, `help/`, `ci/`, Einzel-Audits) sowie die Root-Dokumente
(`README.md`, `VERSION.md`, `CHANGELOG.md`, `CONFIGURATION.md`,
`CONTRIBUTING.md`, `INSTALL.md`). Methodik:

1. **Reproduzierbare Prüfungen** an diesem Stand ausgeführt
   (`tsc`, `eslint`, `docs:validate`, volle Testsuite; siehe §2).
2. **Mengenabgleich** Code → Doku und Doku → Code: Datei- und Pfad-Referenzen,
   Env-Flags, API-Routen, Drizzle-Tabellen, Migrations, Symbole/Funktionsnamen,
   Feature-IDs, Versions-Header, Commit-Spuren.
3. **Stichprobenanalyse** verdächtiger Stellen (Plausibilität von
   Schweregrad und Laufzeitwirkung), inkl. Historie via `git log -S`.
4. **Gegenprobe**: gefundene Abweichungen wurden gegen `docs:validate`
   (dem eignen CI-Wächter des Repos) gehalten, um zu trennen, was CI *nicht
   sehen kann* und was echte Regressionen sind.

Randbedingungen: Kein laufendes PostgreSQL, kein Netzwerkzugang zu Venues/LLMs;
LLM- oder Broker-Endpunkte wurden nicht live geprüft.

### 0.1 Reproduzierbare Prüfbasis (ausgeführt am 2026-10-06, Node v22.22.3)

| Prüfung | Ergebnis | Log |
| --- | --- | --- |
| `npx tsc --noEmit` | **exit 0** (keine Fehler) | `/home/user/audit/tsc.log` |
| `npx eslint .` | **exit 0** (keine Warnungen/Fehler) | `/home/user/audit/eslint.log` |
| `npm run docs:validate` | **exit 0** — „9 Checks, 10 Hilfe-Dateien. OK" | `/home/user/audit/docsvalidate.log` |
| `npm test` (ohne externes PostgreSQL) | vor den Fixes: **4.760 / 4.722 pass / 2 fail / 36 skip** (237 s) · nach den Fixes: **4.769 / 4.731 pass / 2 fail / 36 skip** (229 s, Δ = 9 neue Regressionstests) | Zahlen im Repo dokumentiert: [`audits/2026-10-06-docs-code-audit/remediation/evidence/README.md`](audits/2026-10-06-docs-code-audit/remediation/evidence/README.md) (Logdateien selbst sind per `.gitignore` bewusst nicht versioniert) |
| Link-Auflösung im Doku-Viewer | 1.427 korrekt / 126 Code-Text | docs-validate |
| API-Routen im Code | 87 `route.ts`, 16 Namespaces | Zählung |
| Drizzle-Tabellen | 67 `pgTable`, 0 `pgEnum` | `src/db/schema.ts` |
| Drizzle-Migrationen | 34 `drizzle/*.sql` (neueste `2026-10-05_trade_rules_notify.sql`) | Verzeichnis |
| Versions-Header in `docs/` | 45 Fachdokumente mit „Stand/Version/Code-Version"-Angabe, davon **nur 4 auf Stand `0.17.2`** | Regex-Scan |

Die beiden Testfehler sind **keine Code-Fehler**: `tests/brokerContracts.test.ts`
(Zeilen 154 und 284) scheitern an `ECONNREFUSED 0.0.0.0:5432`, weil kein
PostgreSQL läuft. Mit temporärem Embedded-PostgreSQL ist die Datei laut
`CHANGELOG.md` 42/42 grün. Die Zahl ist im Changelog **exakt korrekt**
dokumentiert (4.722/2/36/4.760) — dieser Punkt ist ein Positivbefund (§5.1)
für die historische Prüfbasis 2026-10-06; die Ursache wurde anschließend in DC-08 behoben.

### 0.2 DC-08-Nachprüfung (2026-10-10)

`npm run typecheck`, `npm run lint` und `npm run docs:validate` sind grün.
`docs:validate` zeigt 12 Checks, 10 Hilfe-Dateien, vier neue L1–L4-Checks und
0 L2-Warnungen. Die Break-and-reset-Counterprobes in
`tests/docsValidateChecks.test.ts` bestehen 4/4. `tests/brokerContracts.test.ts`
besteht mit `BROKER_CONTRACTS_REQUIRE_DB=true` und temporärem Embedded-
PostgreSQL 42/42. `BROKER_CONTRACTS_REQUIRE_DB=true npm test` besteht mit
4.790 Tests (4.754 pass, 0 fail, 36 optionale DB-Skips). Die versionierte Workflow-Quelle unter `docs/ci/` und der
Workflow-Spiegel unter `.github/workflows/` sind byte-identisch; der
Branch-Protection-Required-Check heißt `docs-validate`. Details und
Gegenproben: [DC-08](audits/2026-10-06-docs-code-audit/findings/DC-08-ci-waechter-luecken.md).

---

## 1. Kurzfassung (Ist-Zustand)

Die Dokumentation ist in Summe außergewöhnlich umfangreich und in den
Kernbereichen (Live-Gate-Zustandsmaschine, Scanner-Faktoren und -Gewichte,
Regel-Felder, API-Routenmenge, Kill-Switch-Persistenz, Test- und
Versions-Zahlen des Changelogs) **nachweislich korrekt**; der eigene
CI-Wächter `docs:validate` ist grün, ebenso Typecheck und Lint. Die Drift liegt
systematisch dort, wo **`docs:validate` nicht prüft**: veraltete
Versions-/Status-Header (nur 4 von 45 Dokumenten auf Code-Stand), Mengenangaben (Drizzle-Tabellen,
Feature-Slices, Candle-Limits), dokumentierte Env-Flags und Symbole **ohne
Code-Implementierung** sowie ein zwischen Dokumenten widersprüchlicher
Audit-Status. Eine sicherheitsrelevante Lücke fällt erst durch den Abgleich auf:
der einzige Approval-Endpunkt für Proposals
(`POST /api/firm/proposals/[id]/approve`) hat von 46 Firm-Routen als einzige
schreibende **keine RBAC-/Token-Prüfung**, obwohl die Sicherheitsdoku genau diesen Pfad als
sicherheitskritisch markiert. Dazu kommen Widersprüche zwischen Dokumenten
(Audit-Index v1.2.5 ↔ v1.2.2; VERSION.md ↔ CHANGELOG.md; „sieben Phasen" ↔
acht Zeilen) und vier dokumentierte Env-Flags, die im Code nie gelesen werden —
inklusive der Cycle-Retention-Flags, deren Löschfunktion zwar existiert, aber
nirgends aufgerufen wird.

---

## 3. Befunde: Doku ↔ Code

### 3.1 Schweregrad HOCH

**H1 — Proposal-Freigabe ohne jede Autorisierung (Bug + Doku-Lücke) — ☑ FIXED am 2026-10-06 als DC-01**
`POST /api/firm/proposals/[id]/approve/route.ts` (seit `4e762e4`, H6, v1.36.7;
letzte Änderung `00c30de`) prüft **weder** `requirePermission(...)` **noch**
`guardWrite(...)`/`checkApiToken(...)`/CSRF. Von 46 Routen unter
`src/app/api/firm/**` sind 4 ohne jeden Guard — `devils-advocate`, `micro`,
`risk` (alle nur lesend) und diese — und `POST …/approve` ist davon die
**einzige mit schreibender HTTP-Methode**. Wirkung: In `AUTH_MODE=token-required` kann **jeder ohne
Credential** ein `PENDING`-Proposal auf `APPROVED` setzen und damit die
H6-Approval-Chain (der Executor führt nur APPROVED-Proposals aus) aushebeln.
Die Doku trägt das mit: `docs/security/README.md` nennt die Proposal-Freigabe
als sicherheitskritischen Pfad und führt sie unter „Failed-closed … Proposal-
Freigabe ohne durablen Beleg ⇒ 503" (Zeile 307) — prüft aber nur den
Audit-Beleg, nicht die Identität. `SEC-02` (FIXED v1.36.31, Commit `d900a71`)
hat reale Read-Routen auf `firm.read` umgestellt, diesen Schreibpfad aber nicht
erfasst; die aggregierte Security-Doku meldet „keine offenen Critical/High-
Findings". Regression `tests/routes.asyncParams.test.ts` deckt nur die
Signaturen, nicht die Autorisierung ab.
*Schweregrad: HOCH (Sicherheit). Empfehlung R1 — **umgesetzt**: `requirePermission(request, "firm.write") ?? checkCsrfGuard(request)` vor jedem DB-Zugriff, `authenticatedActor` im Audit, Regression `tests/proposalApprove.auth.test.ts` (7 Tests). Details: [DC-01](audits/2026-10-06-docs-code-audit/findings/DC-01-proposal-approve-ohne-autorisierung.md).*

**H2 — `REQUIRE_HUMAN_APPROVAL`: Anzeige und Gates widersprechen sich — ☑ FIXED am 2026-10-06 als DC-02**
Vier Code-Stellen interpretieren das Flag; drei (Enforcement) verwenden
`!== "false"` — Default **true/fail-closed**: `src/live-gate/config.ts:134`,
`src/brokers/alpaca/config.ts:75`, `src/brokers/bitunix/config.ts:48`.
Die Operator-Anzeige in `src/app/api/firm/route.ts:124` verwendet dagegen
`=== "true"` — bei ungesetzter Variable meldet das Dashboard
`requireHumanApproval: false`, obwohl das Gate die Freigabe verlangt. Die Doku
(`ARCHITECTURE.md`, `BITUNIX.md:457`) beschreibt die strenge Semantik.
*Schweregrad: HOCH (falsches Operator-Signal in einem Sicherheits-Flag).
Empfehlung R2 — **umgesetzt**: Anzeige nutzt `humanApprovalRequired()` aus
`src/live-gate/config.ts`, Paritätstest
`tests/firmHumanApproval.parity.test.ts`. Details:
[DC-02](audits/2026-10-06-docs-code-audit/findings/DC-02-require-human-approval-zwei-semantiken.md).*

### 3.2 Schweregrad MITTEL

**M1 — Doku-Versions-Header: nur 4 von 45 Dokumenten auf dem Code-Stand**
Ausgewertet wurden alle Fachdokumente (Top-Level + `architecture/`,
`roadmap/`, `security/`, `peer-reviews/`; ohne Audits/Archive und ohne diesen
Bericht). Nur `docs/README.md`, `PERPETUAL_DATA.md`,
`architecture/INTEGRATION_POINTS.md` und `roadmap/STATUS.md` tragen `0.17.2`.
**22 Dokumente** stehen wortgleich auf der Beta-Baseline `0.1.0` (u. a.
`LIVE_TRADING.md`, `BROKER_ARCHITECTURE.md`, `CAPABILITIES.md`,
`POST_ONLY_FALLBACK.md`, `MONTE_CARLO.md`, `MARKET_UNIVERSE.md`,
`ERROR_HANDLING_MARKETDATA.md`, `REPOSITORY_STRUCTURE.md`), weitere auf
Zwischenständen: `DB_SCHEMA.md` 1.41.0, `BACKTEST_ENGINE.md` 1.41.0,
`LLM_ROUTING.md` 1.22.0, `INDICATORS.md`/`DOCS_VIEWER.md` 0.14.0,
`EQUITY_CURVE.md` 0.13.0, `CLAUDE_TRADING_INDICATOR.md` 0.12.0,
`STRATEGY_VALIDATION.md` 0.10.4, `STRATEGY_STACK.md` 0.10.2,
`UI_LAYOUT.md` 0.16.1, `MARKET_DATA_PIPELINE.md` 0.16.0, `MISSIONS.md` 0.2.0,
`ARCHITECTURE.md` 0.6.2, `STRATEGY_SCREENING.md` 0.9.0. Ursache ist strukturell: `docs-validate` prüft den
`Code-Version`-Header nur in `CHANGELOG.md` und die Versionszeile nur in
`docs/README.md` (`scripts/docs-validate.ts:556-584`) — alle anderen Dokumente
driften ungehindert. Zusätzlich mischen mehrere Architektur-Dokumente die
interne Legacy-Zählung `v1.x` und das öffentliche `v0.x` (`PIPELINE_MAP.md`,
`DB_SCHEMA.md`, `BACKTEST_ENGINE.md`, `LLM_ROUTING.md`, `ARENA_TASKS.md`).
*Schweregrad: MITTEL. Empfehlung R5/R6.*

**M2 — Dokumentierte Env-Flags ohne Implementierung (4 Stück)**
Kein einziger `process.env`-Zugriff im Code für:

| Flag | Dokumentiert in | Realität |
| --- | --- | --- |
| `CYCLE_RETENTION_DAYS` | `PIPELINE_MAP.md:207`, `DB_SCHEMA.md:337` | `pruneArtifacts()` hat harte Defaults 30 Tage/12 Wochen (`src/cycle/artifacts.ts`) und wird **nirgends aufgerufen** (nur Definition + Tests) |
| `CYCLE_RETENTION_WEEKS` | `PIPELINE_MAP.md:208`, `DB_SCHEMA.md:338` | s. o. |
| `ROUTING_POLICY_VERSION` | `LLM_ROUTING.md:483` | Version kommt aus `DEFAULT_POLICY_VERSION = "1.0.0"` (`src/routing/policy.ts:38`) |
| `RISK_MAX_EQUITY_DRAWDOWN_PCT` | `EQUITY_CURVE.md:135-137` („harte Risiko-Limits") | real: `maxEquityDrawdownPct: 0.15`, Deckel `[0.03, 0.5]` (`src/lib/riskGuard.ts:57,76,96`) |

Beim Flag `MICRO_FEED_TYPE` (`PIPELINE_MAP.md:402`, Werte „binance | simulator |
sequence") ist sogar der **Name falsch**: der Code liest `MICRO_FEED`
(`scripts/micro-executor.ts:40`); `HANDBUCH.md:1645` nutzt korrekt
`MICRO_FEED=sim`. Der CI-Check „Env-Flags==Code" kann das nicht finden: er
akzeptiert jeden Großbuchstaben-Token im Codequelltext mit begrenzter
Suffix-Liste (`*_URL|_KEY|_TOKEN|_ENABLED|_DIR|_MS|_CTX|_PORT|_BASE|_PATH|_DATA|_AUDIT|_MODEL|_PROVIDER|_BUDGET|_FLAG`,
`scripts/docs-validate.ts:389-420`) und verlangt **keinen** echten
`process.env`-Read. `_DAYS`, `_WEEKS`, `_VERSION`, `_PCT`, `_TYPE` fallen durch
das Raster. Wirkung: Ein Betreiber setzt ein dokumentiertes Flag und ändert
nichts. *Schweregrad: MITTEL (Betriebsirreführung). Empfehlung R3/R5.*

**M3 — `DB_SCHEMA.md` beschreibt 15 von 67 Drizzle-Tabellen**
`docs/architecture/DB_SCHEMA.md:7` behauptet vollmundig „alle 15
Drizzle-Tabellen", Stand `v1.41.0`/2026-09-18. `src/db/schema.ts` enthält
**67** `pgTable`-Definitionen (plus 34 Migrationen, deren zwei jüngste Tabellen
noch nicht einmal in den 15 enthalten sind). Nicht dokumentiert sind u. a.
Feature-Store, Forecasts, Perp-/Funding-Daten, Execution-Quality/TWAP/Workflows,
Strategy-Catalog/-Lifecycle/-Screening, Copy-Subscriptions, Regime-Snapshots,
Drawdown-/Vol-Targeting, Cross-Sectional-Analytics, Sentiment, Prompt-Artefakte
und Trade-Attachments. Das Dokument ist damit kein Schema-SSoT, sondern ein
historischer Auszug. *Schweregrad: MITTEL (Schema-Doku nicht belastbar).
Empfehlung R4.*

**M4 — Feature-Store-Umfang in `STRATEGY_STACK.md` veraltet**
`src/features/definitions.ts` registriert 6 Features: `FEATURE_IDS`
(`scanner.rsi/_atr/_atr_band`, Zeile 35 ff.) **und** `RULE_FEATURE_IDS`
(`rule.bb_zscore/_price_vs_upper_bb_pct/_donchian_breakout_pct`, Zeile 42 ff.,
Paritätstest `tests/ruleFeatureStoreParity.test.ts`). `FEATURE_STORE.md`
dokumentiert beide Slices (§3.1/§3.2) korrekt, `STRATEGY_STACK.md:12,35,66`
spricht weiter von „3 Features" (Slice `scanner.*`). Widerspruch innerhalb der
Architektur-Doku. *Schweregrad: MITTEL. Empfehlung R4.*

**M5 — Dokumentiertes API-Feld `allowShortSelling` existiert nicht**
`docs/PORTFOLIO_ANALYTICS.md:339` übergibt im curl-Beispiel
`"bounds": { …, "allowShortSelling": false }`, die Prosa (Zeile 80) und
`PIPELINE_MAP.md:345` erklären es als Konfigfeld. Die Route akzeptiert aber nur
`minWeight`, `maxWeight`, `lower`, `upper`
(`src/app/api/portfolio/optimize/route.ts:132-135`; Parser
`src/portfolio/optimize.ts:94-113` kennt nur `longOnly` als **Funktionsargument**
mit Default `true`). Das Fremdfeld wird still ignoriert — wer es zur
Steuerung nutzt, erhält unbemerkt das Default-Verhalten. *Schweregrad: MITTEL
(falsch dokumentierte API). Empfehlung R4.*

**M6 — Symbole und Pfade in `PIPELINE_MAP.md`/`INTEGRATION_POINTS.md`, die es nicht gibt**
Recursive Suche in `src/` + `scripts/` ergibt 0 Treffer für: `FunnelStageResult`
(als Export von `src/scanner/types.ts` behauptet, `PIPELINE_MAP.md:167`;
`FunnelResult` existiert, aber in `src/scanner/funnel.ts`),
`getAdaptiveRiskFactor`/`evaluateMarketRegime` (`PIPELINE_MAP.md:296`,
`INTEGRATION_POINTS.md:122` — real exportiert `src/lib/adaptiveRisk.ts`
`updateAdaptiveRisk`/`getAdaptiveRiskStatus`/`RegimeStateMachine`;
`applyAdaptiveRisk` liegt in `src/lib/riskGuard.ts`),
`guardPortfolioAllocations`/`enforcePositionLimits`/`enforceCorrelationLimits`
(`PIPELINE_MAP.md:327`; real exportiert `src/portfolio/riskGuard.ts`
`applyRiskGuard`, `resolveGuardConfig`, `assertAuthorityChain`, `capFor`),
`matchRule` (`PIPELINE_MAP.md:386`; real: `src/lib/ruleService.ts` mit
`listRules`/`getActiveRules`/`upsertRuleSpec`), `RuleMatchResult`/
`RuleExecutionRecord` (`PIPELINE_MAP.md:394`), `HISTORICAL_DATA_DIR`
(`PIPELINE_MAP.md:119/466`), `executeWeeklyReview` (`PIPELINE_MAP.md:193`;
real `weeklyReviewStep`, `src/cycle/weekly.ts:44`). Dazu zwei Datei-Referenzen,
die es nicht (mehr) gibt: `src/components/workshop/InfoTip.tsx`
(`DOCS_SYNC_AUDIT.md:139`, `MISSIONS.md:242`; real:
`src/components/ui/InfoTip.tsx`) und `src/perpdata/consumer.ts`
(`INTEGRATION_POINTS.md:149`; real: `src/perpdata/consumers.ts`, Plural).
Nicht als Fehler gewertet: `src/lib/riskGuard.ts` mit
`validateOrder`/`killSwitch`/`RISK_LIMITS`/`LIMIT_CEILINGS`
(`PIPELINE_MAP.md:295`) existiert genau so; die Treffer
`src/scanner/historicalStore.ts` (`MARKET_DATA_PIPELINE.md:47`) und
`scripts/drizzle.config.json` (`security/SECURITY_AUDIT.md:36`) sind
dokumentierte Alt-/Migrationspfade in Audit-/Migrationstabellen.
*Schweregrad: MITTEL (Doku als Einstiegspunkt unbrauchbar). Empfehlung R4/R5.*

**M7 — `SCANNER_CONFIG_FILE`-Default: Doku „version: 1", Code version 2**
`PIPELINE_MAP.md:158` nennt als internen Default `version: 1`. Real:
`DEFAULT_SCANNER_CONFIG.version = 2` (`src/scanner/config.ts:359`) und auch die
ausgelieferte `src/scanner/scanner.config.json` trägt `version: 2` (Umstellung
der Volatilitäts-Annualisierung, v1.37.0). Nebenbefund: `scanner.config.json`
hat 14 Faktor-Blöcke, die 15. ID `crossSectionalMomentum` ist bewusst nur ein
Diagnose-Faktor ohne Config-Block — das ist in sich konsistent, die Doku sollte
es aber sagen. *Schweregrad: MITTEL. Empfehlung R4.*

**M8 — VERSION.md ↔ CHANGELOG.md: Testzahlen weichen ab**
`CHANGELOG.md:46` nennt „4.722 bestanden, 2 fehlgeschlagen, 36 übersprungen
(4.760 insgesamt)" — das entspricht **exakt** dem reproduzierten Lauf.
`VERSION.md:443` nennt für denselben Sachstand „4.719 bestanden, 2
fehlgeschlagen, 36 übersprungen". Eine der beiden kanonischen Stellen ist um 3
Tests falsch; beide werden von `docs-validate` nicht gegeneinander geprüft.
Dazu widersprechen sich die Doku-Aussagen zur Suite selbst:
`CONTRIBUTING.md:35` und `docs/ci/README.md:99` behaupten, DB-gegatete Tests
„überspringen sich ohne PostgreSQL" — zwei PAPER-Contract-Tests **scheitern**
statt zu skippen. *Schweregrad: MITTEL (Vertrauen in Prüfaussagen).
Empfehlung R4/R5.*

### 3.3 Schweregrad NIEDRIG

**N1 — `DB_SCHEMA.md` ↔ `HISTORY.md`: Candle-Limit widersprüchlich**
`DB_SCHEMA.md:337` begrenzt `data/history/candles.ndjson` auf „max 5.000
Kerzen"; `docs/HISTORY.md:77` und der Code
(`DEFAULT_MAX_BARS_PER_SERIES`/`MAX_CANDLES_PER_SERIES` = 100.000,
`src/lib/marketdata/limits.ts`) nennen 100.000.

**N2 — `docs/README.md` widerspricht sich selbst im Versionsstand**
Kopf: `Version: v0.17.2`; Fuß: „v0.2.0 (Beta)". Der Wächter liest nur den Kopf.

**N3 — Audit-Index widerspricht sich (v1.2.5 ↔ v1.2.2)**
Prosa/Status: „OPEN (Audit v1.2.5 …)" (`docs/README.md:154`,
`audits/README.md:71`). Dieselben Dateien zeigen in ihren Baumdiagrammen
weiterhin „OPEN v1.2.2" (`docs/README.md:302`, `audits/README.md:53`).

**N4 — `BETA_STATUS.md`: „sieben Phasen" vs. acht (0–7)**
Abschnitt 7 listet acht Phasen (0…7), der Text darunter sagt „Alle sieben
Phasen erfüllen kein einziges Kriterium".

**N5 — API-Route ohne Doku-Erwähnung**
`GET /api/firm/execution-quality` (Route existiert, RBAC `firm.read`, bounded
Read-API) kommt in keiner Dokumentation namentlich vor; dokumentiert ist nur das
Modul `src/executionQuality/`. Alle anderen 86 Routen sind mindestens in einer
Route-/Broker-Übersicht erwähnt. Der CI-Routencheck prüft nur Doku → Code,
nicht die Gegenrichtung.

**N6 — `.env.example` unvollständig (beispielhaft verifiziert)**
Genutzt, aber in `.env.example` (251 Keys, inkl. auskommentierter) nicht
aufgeführt: `SCANNER_ARTIFACTS_DIR`, `CYCLE_ARTIFACTS_DIR`,
`SCANNER_CONFIG_FILE`, `UNIVERSE_POLICY_FILE`, `UNIVERSE_AUDIT_DB`,
`PORTFOLIO_AUDIT`/`_DIR`/`_DB`, `WATCHDOG_HEALTH_URL`, `WATCHDOG_TIMEOUT_MS`,
`ALPACA_TIMEOUT_MS`, `FORECAST_RESOLVER_INTERVAL_MIN`, `START_MICRO`. Ein Teil
davon ist in `docs/` beschrieben (`WATCHDOG_TIMEOUT_MS`, `ALPACA_TIMEOUT_MS`,
`START_MICRO`, `MICRO_SEED_CANDLES`, `MICRO_SIM_INTERVAL_MS` in **keiner** Doku).

**N7 — Drei Top-Level-Dokumente sind im Doku-Index nicht gelistet**
`docs/PEER_REVIEW_BITUNIX_EXECUTION.md`, `docs/PEER_REVIEW_LIVE_TRADING.md`,
`docs/PEER_REVIEW_ROUTING_OVERRIDES.md` (je 5-Zeilen-Redirect-Stubs). Alle
anderen Top-Level-Dokumente stehen in `docs/README.md`.

**N8 — Status-Header fehlen** in `DAILY_WEEKLY_RESEARCH.md`,
`SETUP_PG_TROUBLESHOOTING.md`, `SYMBOLS.md`.

---

## 4. Weitere technische Beobachtungen (Code, in Doku nicht als Risiko erwähnt)

1. **`pruneArtifacts()` ist toter Code für den Betrieb**: Die Funktion
   (`src/cycle/artifacts.ts:386`) wird produktiv nie aufgerufen; Cycle-Artefakte
   wachsen unbegrenzt, obwohl `DB_SCHEMA.md` eine Aufbewahrung (30 Tage /
   12 Wochen) zusichert. Die Tests `tests/cycle.artifacts.test.ts` prüfen nur
   die Funktion selbst.
2. **`RISK_MAX_EQUITY_DRAWDOWN_PCT` „harte Risiko-Limits"**: `EQUITY_CURVE.md`
   verkauft das Flag als harte Grenze; tatsächlich sind die harten Grenzen
   `DEFAULT_LIMITS.maxEquityDrawdownPct = 0.15` bzw. der Deckel `[0.03, 0.5]`
   (`src/lib/riskGuard.ts:57,76,96`). Ein Betreiber, der 0.5 „erlaubt", bekommt
   per Code maximal 0.5 — das ist konsistent, aber der dokumentierte
   Steuerungsweg existiert nicht.
3. **Scheduler-Fail-open**: `SCHEDULER_ENABLED !== "false"` (Default an) in
   `src/instrumentation.ts:110` und gespiegelt in `src/app/api/firm/route.ts:108`
   ist dokumentiert als „enabled ist Default", aber die Fail-open-Semantik
   (ein Tippfehler wie `SCHEDULER_ENABLED=0` aktiviert den Scheduler) wird
   nirgends erklärt.
4. **Microrun-Doku**: `HANDBUCH.md:1645` (`MICRO_FEED=sim`) ist korrekt, aber
   die zugesagte Werteliste in `PIPELINE_MAP.md:402` (`simulator|sequence`)
   spiegelt die realen Feed-Klassen wider, während der Env-Wert `sim` heißt —
   drei Namensräume (Flag, Wert, Klasse) sind nicht konsistent dokumentiert.
5. **`docs:validate` prüft die Test-Suite nicht** — auch nicht in keinem der
   beiden Workflows (`main.yml` = `npm ci` + Mirror-Diff + `typecheck` +
   `docs:validate`; `security-live-gate.yml` = Audit/Lint/Build/Coverage-Gate).
   Die 2 bekannt roten Contract-Tests normalisieren damit rote Zahlen; der
   Changelog ist ehrlich, die PR-Pflicht („`npm test` lokal ausführen", s.
   `CONTRIBUTING.md:35`) aber nicht automatisiert.

---

## 5. Bewertung der Vollständigkeit

### 5.1 Nachweislich korrekt dokumentiert

* **Live-Gate-Zustandsmaschine**: 9 Zustände / 8 legale Übergänge in
  `src/live-gate/states.ts` ↔ `docs/LIVE_TRADING.md` §1 (CI-Check grün).
* **Kill-Switch-Persistenz**: NDJSON-Datei, `kill-switch.json`,
  0600-Rechte, „neuester Eintrag bestimmt den Zustand" ↔ `src/live-gate/killFile.ts`.
* **Scanner**: „15 Faktoren (9 gewichtet + 6 diagnostisch)" stimmt in
  `INDICATORS.md`, `HANDBUCH.md`, `DAILY_WEEKLY_RESEARCH.md`,
  `src/scanner/types.ts` (`FACTOR_IDS`, `SCORE_COMPONENTS`,
  `COMPONENT_FACTOR` inkl. `volume → volumeRatio`); Gewichte
  25/15/15/10/10/10/5/5/5, Trichter 2.000→500→100 (+20–40 Deep),
  Regime-Multiplikatoren (0,25/0,6/1,2) und Filtergrenzen stimmen mit
  `src/scanner/scanner.config.json` überein; `docs/help/scanner.help.json`
  ist schema-valide (27 Felder).
* **Regel-Felder**: 25 Felder in `src/lib/ruleFieldCatalog.ts` ↔
  `INDICATORS.md`/`STRATEGY_STACK.md`; keine zweite Whitelist.
* **Risiko-Grenzen**: `maxPositionPct 0.25`, `maxRiskPerTrade 0.02`,
  Stop-Loss-Pflicht, TP 1.5 R, ATR-Faktor 2 (`src/lib/riskGuard.ts` ↔
  `HANDBUCH.md`).
* **API-Routen**: 87 Routen, 16 Namespaces; der CI-Check „Route in Doku nicht
  im Code" ist grün; nur eine Route ist nicht erwähnt (N5).
* **Tests/Version**: `CHANGELOG.md`-Testzahlen exakt reproduziert; Version
  0.17.2 konsistent zwischen `package.json`, `CHANGELOG.md`-Header und
  `docs/README.md`-Kopf.
* **CI-Spiegel**: `docs/ci/*.workflow.yml` ist byte-identisch zu
  `.github/workflows/*` (CI-Schritt „Spiegel-Sync").
* **Migrationsstand**: 34 Migrationen inkl. TASK-07-Trigger
  (`2026-10-05_trade_rules_notify.sql`) vorhanden.
* **Kein einziges Top-Level-Src-Modul (35) ist undokumentiert** — jedes wird in
  `REPOSITORY_STRUCTURE.md` oder einem Fachdokument erwähnt.

### 5.2 Vollständig fehlend oder nur partiell dokumentiert

| Bereich | Status |
| --- | --- |
| `src/db/schema.ts` (67 Tabellen) | 15 dokumentiert, 52 fehlen |
| Feature-Store `rule.*`-Slice in `STRATEGY_STACK.md` | fehlt (nur 3 Scanner-Features) |
| Env-Flags `WATCHDOG_TIMEOUT_MS`, `ALPACA_TIMEOUT_MS`, `START_MICRO`, `MICRO_SEED_CANDLES`, `MICRO_SIM_INTERVAL_MS` | in keiner Doku |
| `GET /api/firm/execution-quality` | Route nicht dokumentiert |
| `AUTH_MODE`-Verhalten der Proposal-Freigabe | nirgends als „ungeschützt" markiert (weil nicht bemerkt) |
| 3 Peer-Review-Redirect-Stubs | nicht im Doku-Index |
| Status-Header in 3 Dokumenten | fehlen |

---

## 6. Remediation-Empfehlungen (priorisiert)

**Sofort (Sicherheit/Betrieb):**

* **R1** — `POST /api/firm/proposals/[id]/approve` mit
  `requirePermission(req, "firm.write")` (bzw. `guardWrite`) absichern, den
  Pfad in `docs/security/README.md` als Schreibpfad dokumentieren und einen
  Regressionstest analog `tests/sec02.unauthenticatedGetApis.test.ts` ergänzen.
* **R2** — `REQUIRE_HUMAN_APPROVAL` in `firm/route.ts` über die zentrale
  Funktion `humanApprovalRequired()` aus `src/live-gate/config.ts` auswerten
  (eine Semantik, ein Default) und einen Test auf die Dashboard-Anzeige legen.
* **R3** — Die vier Flags aus M2 entscheiden: entweder implementieren (Cycle-
  Retention inkl. Aufruf von `pruneArtifacts` im Daily-/Weekly-Cycle, Routing-
  Policy-Version aus Env, Drawdown-Limit aus Env) **oder** aus der Doku streichen.
  `MICRO_FEED_TYPE` in der Doku auf `MICRO_FEED` korrigieren.

**Kurzfristig (Doku-Wahrheit):**

* **R4** — Einzelkorrekturen: `DB_SCHEMA.md` (Tabellenzahl/Auszug klarstellen,
  ggf. generierte Tabellenliste), `STRATEGY_STACK.md` (6 Features),
  `PORTFOLIO_ANALYTICS.md` (Bounds-Felder), `PIPELINE_MAP.md` (Symbole,
  `version: 2`, `MICRO_FEED`), `CAPABILITIES.md` (Stand-Header `v0.1.0` und
  missverständliche Überschrift „Aktuelle Stub-Venues", obwohl der Abschnitt
  BITUNIX/ALPACA als produktive Integrationen mit `live: true` beschreibt), `HISTORY.md`/`DB_SCHEMA.md` (100.000),
  `VERSION.md` (4.722), `BETA_STATUS.md` (acht Phasen),
  Audit-Baumdiagramme (v1.2.5), `docs/README.md` (Footer).
* **R5** — CI-Wächter erweitern (`scripts/docs-validate.ts`):
  1. Env-Check auf echte `process.env`-Reads stützen und **Gegenrichtung**
     prüfen (`process.env.X`, das weder in `CONFIGURATION.md` noch in
     `.env.example` steht → Warnung, mit Whitelist für Framework-Variablen).
  2. Doku-behauptete Symbole/Dateien/`pgTable`-Namen existieren im Code
     (Mengenabgleich statt Stichprobe).
  3. Versions-Header **aller** Dokumente (nicht nur `docs/README.md` und
     `CHANGELOG.md`) gegen `package.json` prüfen.
  4. Routen-Gegenrichtung: neue Route ohne Doku-Erwähnung ⇒ Fehler.
  5. Test-Suite in CI mit Ephemeral-PostgreSQL (oder die zwei Contract-Tests
     sauber DB-gaten), damit `npm test` ein belastbares Signal wird.

**Prozess:**

* **R6** — Release-Schritt „Docs-Version bumpen": ein Skript, das alle
  `Code-Version`-Header in einem Release-Commit automatisiert auf die neue
  Version setzt (macht M1 strukturell unmöglich statt nur sichtbar).
* **R7** — Generierte Inventare (`docs/generated/route-inventory.md`,
  `env-inventory.md`, `schema-inventory.md`) aus dem Code erzeugen und in der
  Doku referenzieren; Handpflege nur noch für Erklärtexte.
* **R8** — Peer-Review-Stubs in `docs/README.md` aufnehmen oder entfernen;
  Status-Header in den drei Dokumenten aus N8 ergänzen.

### 6.1 Zuordnung Empfehlung → Befund → Prompt

| Empfehlung | Befund | Umsetzung |
| --- | --- | --- |
| R1 (Approve-Route absichern) | DC-01 / H1 | ☑ FIXED 2026-10-06 (diese Session) |
| R2 (eine `REQUIRE_HUMAN_APPROVAL`-Semantik) | DC-02 / H2 | ☑ FIXED 2026-10-06 (diese Session) |
| R4a (Doku-Einzelkorrekturen) | DC-03 | ☑ FIXED 2026-10-06 (diese Session) |
| R4b (Mengen-/Symbol-Nachführung) | DC-06, DC-07 | [PROMPT-DC-06](audits/2026-10-06-docs-code-audit/prompts/PROMPT-DC-06-symbol-pfad-abgleich.md), [PROMPT-DC-07](audits/2026-10-06-docs-code-audit/prompts/PROMPT-DC-07-db-schema-nachfuehren.md) |
| R3 (Env-Flags entscheiden) + R5.1 (Env-Check) | DC-05 | [PROMPT-DC-05](audits/2026-10-06-docs-code-audit/prompts/PROMPT-DC-05-env-flags-entscheiden.md) (Entscheidung), dann DC-08 |
| R5.2–R5.5 (Wächter ausbauen, Test-Suite) | DC-08 | [PROMPT-DC-08](audits/2026-10-06-docs-code-audit/prompts/PROMPT-DC-08-docs-validate-ausbau.md) |
| R6/R7 (Bump-Skript, generierte Inventare) | DC-09 | [PROMPT-DC-09](audits/2026-10-06-docs-code-audit/prompts/PROMPT-DC-09-inventare-und-release-bump.md) |
| R5.3 (Versions-Header prüfen) | DC-04 | [PROMPT-DC-04](audits/2026-10-06-docs-code-audit/prompts/PROMPT-DC-04-versions-header-bump.md) |
| R8 (Stubs/Status-Header) | DC-03 / N7, N8 | ☑ FIXED 2026-10-06 (diese Session) |

---

## 7. Anhang — Reproduktionskommandos

```bash
npx tsc --noEmit                                  # exit 0
npx eslint .                                      # exit 0
npm run docs:validate                             # OK, 9 Checks, 10 Hilfe-Dateien
npm test                                          # 4760 / 4722 pass / 2 fail / 36 skipped
grep -rn "CYCLE_RETENTION_DAYS" src scripts       # 0 Treffer (nur Docs)
grep -rn "process.env.REQUIRE_HUMAN_APPROVAL" src # zwei unterschiedliche Vergleiche
grep -c "pgTable(" src/db/schema.ts               # 67
find src/app/api -name route.ts | wc -l           # 87
git log -1 --format="%h %ad %s" --date=short      # 104aaef 2026-10-06
```

Belege in `/home/user/audit/`: `tsc.log`, `eslint.log`, `docsvalidate.log`,
`test-summary.log`, `envcheck.py`/`env_report.txt` (Env-Abgleich), sowie die
Auswertungen der Tabellen-, Routen- und Symbol-Mengenabgleiche. Der
Test-Volltext (1,8 MB) lag unter `/tmp/test.log` und ist nicht Teil des Repos.
