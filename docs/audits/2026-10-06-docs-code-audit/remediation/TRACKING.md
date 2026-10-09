# Remediation-Tracking — Docs↔Code-Audit 2026-10-06

- **Audit:** [`../README.md`](../README.md) · **Bericht:** [`../../../DOCS_CODE_AUDIT_2026-10-06.md`](../../../DOCS_CODE_AUDIT_2026-10-06.md)
- **Prüfbasis:** `main` @ `104aaef` (2026-10-06) · Code-Version **0.17.2**
- **Stand:** 2026-10-09 · **9 Findings:** 6 FIXED (DC-01…DC-06), 3 OPEN (DC-07…DC-09)
- **Konvention:** ein Prompt = eine Coding-Session; nach Erledigung Status hier und in `../README.md` nachziehen (Nummern der Findings unverändert lassen).

## Statusübersicht

| ID | Severity | Titel | Status | Beleg / Prompt |
|----|----------|-------|--------|----------------|
| DC-01 | HIGH | Proposal-Freigabe ohne Autorisierung | ☑ **FIXED** (2026-10-06) | `src/app/api/firm/proposals/[id]/approve/route.ts` (Guard `firm.write` + CSRF vor DB), `tests/proposalApprove.auth.test.ts` (7 Tests), `tests/routes.asyncParams.test.ts` angepasst |
| DC-02 | HIGH | `REQUIRE_HUMAN_APPROVAL` zwei Semantiken | ☑ **FIXED** (2026-10-06) | `src/app/api/firm/route.ts` nutzt `humanApprovalRequired()`, `tests/firmHumanApproval.parity.test.ts` (Parität + Quell-Drift) |
| DC-03 | MEDIUM | Doku-Kleinfindings (12 Punkte) | ☑ **FIXED** (2026-10-06) | Änderungen in `STRATEGY_STACK.md`, `PORTFOLIO_ANALYTICS.md`, `PIPELINE_MAP.md`, `DB_SCHEMA.md`, `VERSION.md`, `CONTRIBUTING.md`, `docs/ci/README.md`, `docs/README.md`, `audits/README.md`, `BETA_STATUS.md`, `HANDBUCH.md`, `DAILY_WEEKLY_RESEARCH.md`, `SYMBOLS.md`, `SETUP_PG_TROUBLESHOOTING.md`, `security/README.md`; `docs:validate` grün |
| DC-04 | MEDIUM | Versions-/Status-Header: 4/45 auf Code-Stand | ☑ **FIXED** (2026-10-09) | [`../findings/DC-04-versions-header-drift.md`](../findings/DC-04-versions-header-drift.md) § Umsetzung · PR [#236](https://github.com/Kryschuuu/ai-trading-firm/pull/236) · [PROMPT-DC-04](../prompts/PROMPT-DC-04-versions-header-bump.md) |
| DC-05 | MEDIUM | Env-Flags ohne Read; `.env.example` lückenhaft | ☑ **FIXED** (2026-10-09) | `src/cycle/artifacts.ts` + `src/cycle/service.ts` (Retention env-konfigurierbar, Pruning am Lauf-Ende), `tests/cycle.artifacts.test.ts` (3 neue Tests), Doku: `PIPELINE_MAP.md`, `DB_SCHEMA.md`, `LLM_ROUTING.md`, `EQUITY_CURVE.md`, `.env.example`, `CONFIGURATION.md`; Details: [DC-05 § Umsetzung](../findings/DC-05-env-flags-ohne-implementierung.md) |
| DC-06 | MEDIUM | Symbol-/Pfad-Drift in der Architektur-Doku | ☑ **FIXED** (2026-10-09) | 34 Korrekturen in `PIPELINE_MAP.md`, `INTEGRATION_POINTS.md`, `MISSIONS.md`, `DOCS_SYNC_AUDIT.md`; neue Absätze „Zwei Risk-Guards, zwei Zwecke" + „8. Pflege dieser Karte"; Regression `tests/docsArchitectureSymbols.test.ts` (9 Tests); Details: [DC-06 § Umsetzung](../findings/DC-06-symbol-und-pfad-drift.md) · [PROMPT-DC-06](../prompts/PROMPT-DC-06-symbol-pfad-abgleich.md) |
| DC-07 | MEDIUM | `DB_SCHEMA.md` 15 von 67 Tabellen | ☐ OFFEN (Scope-Hinweis gefixt) | [PROMPT-DC-07](../prompts/PROMPT-DC-07-db-schema-nachfuehren.md) |
| DC-08 | MEDIUM | `docs:validate`: fünf Check-Lücken; Test-Suite in keiner CI | ☐ OFFEN | [PROMPT-DC-08](../prompts/PROMPT-DC-08-docs-validate-ausbau.md) |
| DC-09 | LOW | Kein generiertes Inventar, kein Release-Bump | ☐ OFFEN | [PROMPT-DC-09](../prompts/PROMPT-DC-09-inventare-und-release-bump.md) |

## Empfohlene Abarbeitungsreihenfolge

```text
DC-04  (Sichtbarkeit/Kopfzeilen)  ✔ erledigt ─┐
DC-05  (Env-Flags entscheiden)    ✔ erledigt │  inhaltliche Nachführung
DC-06  (Symbole/Pfade)            ✔ erledigt │
DC-07  (Schema-Inventar)                  ─┘  ← offen
DC-08  (docs:validate verschärfen)         ← erst NACH 04–07, sonst sofort rot
DC-09  (Inventare + Bump-Skript)           ← kann 07/08 vorbereiten
```

## Erledigt-Nachweise (Kurzform)

- **DC-01:** Route prüft `requirePermission(request, "firm.write") ?? checkCsrfGuard(request)` **vor** jedem DB-Zugriff; `authenticatedActor` (`actorAuditId`) zusätzlich in beiden Audit-Stufen (`PRECHECK`/`APPLIED`) und in der Response. Tests decken anonym (401), gefälschte Header, Viewer (403), fehlendes CSRF (403), Operator (Guard passiert), `local-open` (CSRF bleibt Pflicht) und den Quell-Drift ab.
- **DC-02:** eine Semantik über `src/live-gate/config.ts`, `src/brokers/alpaca/config.ts`, `src/brokers/bitunix/config.ts` und die Firm-Anzeige; nur exakt `"false"` hebt die Human-Gate-Bedingung auf.
- **DC-03:** jede der 12 Einzelstellen mit Vorher/Nachher in [`../findings/DC-03-doku-kleinfindings.md`](../findings/DC-03-doku-kleinfindings.md); `npm run docs:validate` grün, Typecheck/Lint grün.
- **DC-04 (PR #236, gemergt 2026-10-08, Commit `977e0bc`):** Header klassifiziert (3 × a verifiziert `v0.17.2`, 3 × b Dokument-/Review-Version, 63 × c Bestandsdokument mit „Vollabgleich offen“). Header-Scan: 66 Treffer, 0 falsch. `npm run docs:validate` grün. Details: [`../findings/DC-04-versions-header-drift.md`](../findings/DC-04-versions-header-drift.md) § Umsetzung.
- **DC-05 (2026-10-09):** Pro Flag eine Entscheidung — `CYCLE_RETENTION_DAYS`/`_WEEKS` **implementiert** (`envInt` in `src/cycle/artifacts.ts`, Defaults 30/12, Bounds [1, 3650]/[1, 520]; `pruneArtifacts()` läuft best-effort am Abschluss jedes Daily-/Weekly-Laufs in `src/cycle/service.ts`), `ROUTING_POLICY_VERSION` **gestrichen** (`LLM_ROUTING.md` nennt `DEFAULT_POLICY_VERSION`/`version`-Feld der Policy-Datei als Quelle), `RISK_MAX_EQUITY_DRAWDOWN_PCT` **gestrichen** (`EQUITY_CURVE.md` nennt `DEFAULT_LIMITS.maxEquityDrawdownPct` + `LIMIT_CEILINGS` [0.03, 0.5] + `risk_config`-Laufzeit-Tuning), `MICRO_FEED_TYPE` → **`MICRO_FEED`** korrigiert (Werte `binance`|`sim`, Verweis auf Feed-Klassen `simulator`/`sequence`). `.env.example` + `CONFIGURATION.md` auf den echten Lese-Bestand ergänzt (14 Variablen inkl. der neuen Retention-Flags; die fünf bisher undokumentierten mit je einem Satz). Tests: `tests/cycle.artifacts.test.ts` +3 (Env-Override, Defaults, Clamp), `tests/cycle.engine.test.ts` isoliert die Artefakt-Ablage. `tests/cycle.*.test.ts` 85/85 grün, `npm run typecheck`/`lint`/`docs:validate` grün. Details: [`../findings/DC-05-env-flags-ohne-implementierung.md`](../findings/DC-05-env-flags-ohne-implementierung.md) § Umsetzung.
- **DC-06 (2026-10-09):** 34 Symbol-/Pfad-Korrekturen, alle mit realem Export belegt (vollständige Tabelle „Fundstelle | dokumentiert | real | Korrektur" im Befund). Kernpunkte: `FunnelResult` nach `src/scanner/funnel.ts` (Stufen-Typ gestrichen), `weeklyReviewStep`/`createWeeklySteps` statt `executeWeeklyReview` und `classifyWeekly` korrekt in `src/scanner/weekly.ts`, `saveDailyCycleArtifacts`/`saveWeeklyCycleArtifacts` statt `writeCycleArtifact`, `updateAdaptiveRisk`/`getAdaptiveRiskStatus`/`assessRegime`/`RegimeStateMachine` statt `getAdaptiveRiskFactor`/`evaluateMarketRegime` (Anwendung des Faktors: `applyAdaptiveRisk` in `src/lib/riskGuard.ts`), `applyRiskGuard`/`resolveGuardConfig`/`assertAuthorityChain`/`capFor` statt der drei erfundenen Portfolio-Guards, `optimizeWithGuard` nach `src/portfolio/pipeline.ts`, `computeMetrics`/`correlationMatrix`/`correlationClusters`/`RawOptimizationResult`/`RiskGuardResult`/`GuardedPortfolio`, Rule-Matching-Einstieg `RuleCache.match()` (`src/lib/microExecutor.ts:622`) mit dokumentiertem Verhalten bei erschöpftem `maxExecutionsPerDay` (**still übersprungen**, keine `rule_executions`-Zeile, kein Log/Counter), `getActiveRules`/`listRuleExecutions` statt `listActiveRules`/`recordRuleExecution`, `FeedTick`/`CachedRule[]`/`ExecutionOutcome` statt `PriceTick`/`RuleMatchResult`/`RuleExecutionRecord`, `ValidateContext`/`GuardrailResult` statt `OrderValidationParams`/`ValidationResult`, `LiveGateTransitionResult`, `FIRM_API_TOKEN` statt `FIRM_OPERATOR_TOKEN`, reale Audit-Events (`ORDER_SENT`/`ORDER_REJECTED`/`KILL_SWITCH`/`KILL_SWITCH_DISARMED`), Kerzen-Speicher ohne Env-Flag (Store-`dir` + `resolveRuntimePath`) und `maxBarsPerSeries` 100.000 statt 5.000, `backtestRule` statt `backtestRuleOnCandles`, `src/perpdata/consumers.ts`, `restorePaperBrokerState`/`ensurePaperBrokerHydrated` (`src/lib/brokerHydration.ts`) statt `restoreFirmState`, `src/components/ui/InfoTip.tsx`. Die vier `FIRM_MAX_*`-Env-Flags hatten nie einen Code-Read → gestrichen und durch die reale Quelle ersetzt (`DEFAULT_LIMITS` + `risk_config`-Tuning innerhalb `LIMIT_CEILINGS`; Drawdown-Default 10 % → **15 %** berichtigt). Neu in der Karte: Absatz „Zwei Risk-Guards, zwei Zwecke" und Abschnitt „8. Pflege dieser Karte" (Quelle ist der Code, Symbole nur mit realem Export, Wächter folgt in DC-08); Status-Header beider Architekturdoks von „Vollabgleich offen" auf „Symbol-/Pfadabgleich erledigt". Regression: `tests/docsArchitectureSymbols.test.ts` (9 Tests, statisch ohne DB). Verifikation: Pfad-Skript des Befunds meldet nur die 2 whitelisted Altpfade, Acceptance-`grep` 0 Treffer, `typecheck`/`lint`/`docs:validate` grün, `tests/docs*.test.ts` 46/46. Details: [`../findings/DC-06-symbol-und-pfad-drift.md`](../findings/DC-06-symbol-und-pfad-drift.md) § Umsetzung.

## Verifikationsstand dieser Session

| Prüfung | Ergebnis |
|---------|----------|
| `npm run typecheck` | grün |
| `npm run lint` | grün |
| `npm run docs:validate` | grün (9 Checks, 10 Hilfe-Dateien) |
| `npm test` (ohne externes PostgreSQL, nach den Fixes) | 4.769 Tests · **4.731 pass** · 2 fail · 36 skip — beide Fehler sind die bekannten DB-abhängigen PAPER-Contract-Tests (`ECONNREFUSED 0.0.0.0:5432`). Zahlen vollständig in `evidence/README.md` (Logdateien sind per `.gitignore` nicht versioniert) |
| Neue Tests | `tests/proposalApprove.auth.test.ts` (7), `tests/firmHumanApproval.parity.test.ts` (2), `tests/cycle.artifacts.test.ts` (+3: Env-Retention, Defaults, Clamp), `tests/docsArchitectureSymbols.test.ts` (9, DC-06: Pfade/Symbole der Architektur-Doku gegen `src/` + `scripts/`) grün |

## CI-Stand des Fix-Commits (Nachtrag 2026-10-07)

| Workflow | Ergebnis | Anmerkung |
|----------|----------|-----------|
| `docs-validate` | ✅ success | Typecheck + Docs-Validierung (inkl. Link-/App-Link-Check des neuen Audit-Ordners) |
| `security-live-gate` | ✅ **fixed 2026-10-06** (Folge-Session) | Der Workflow brach im **ersten** Schritt `npm audit --audit-level=high --omit=dev` ab (fail-closed) wegen neuer Advisories: `sharp < 0.35.5` (CVE-2026-96889, via `next@16.3.8`) und `source-map-js ≤ 1.2.1` (GHSA-68fv-2mgg-jv7q). Beide sind per `overrides` in `package.json` gehoben (`sharp` **0.35.5**, `source-map-js` **1.2.2**, `@img/sharp-libvips-*` 1.3.4). Der SEC-03-Gate-Floor (`tests/sec03.nextDependencies.test.ts`) wurde auf die neuen Advisory-Untergrenzen gesetzt (SEC-04-Prinzip: Gate nie weicher als das Advisory) — deshalb ist `security:live-gate` mit `test:security:next` als erstem Schritt konsistent. Details: [`../../../security/README.md` § Dependency-Floors](../../../security/README.md). |

**Verifikation des Dependency-Fixes (lokal, Node 22):** `npm audit
--audit-level=high --omit=dev` → exit 0 (nur noch 2 moderate im
Auslieferungspfad); `npm ls ws --all` → `ws@8.21.3 overridden` (16/16 SEC-04);
`test:security:next` 26/26 (inkl. geladenem libheif ≥ 1.23.2); `typecheck`,
`lint`, `build` und die vollständige `security:live-gate`-Suite grün.

**Bewusst offen (nicht blockierend, `--audit-level=high`):**
`postcss-selector-parser < 7.1.6` (moderat; `@tailwindcss/typography@0.5.20`
pinnt exakt `6.0.10` — der „Fix" von `npm audit fix --force` wäre ein Downgrade
der Typography-Version) und `braces` (hoch, **keine verfügbare Fix-Version**,
nur im Dev-Lint-Pfad über `eslint-config-next`). Beide im Security-README als
beobachtete Restpunkte geführt. Das Repo kuratiert npm-Abhängigkeiten bewusst
manuell (`.github/dependabot.yml` deckt nur `github-actions` ab).

## Offene Beobachtungen ohne eigenen Finding-Status

- **`pruneArtifacts()` wird produktiv nie aufgerufen** (`src/cycle/artifacts.ts`) — gehört fachlich zu DC-05 (Flag-Entscheidung), wird dort mitentschieden.
- **`addAllowedHost` / keine weiteren Alias-Funde** aus dem Symbol-Scan wurden bewusst nicht gemeldet (kein Doku-Beleg).
- **„Schnittstellen"-Widersprüche zwischen Audit-Dokumenten** (z. B. `DOCS_SYNC_AUDIT.md` „0 offene Diskrepanzen" bei gleichzeitig 41 falschen Versions-Headern) sind Folgefehler von DC-04; nach dessen Umsetzung erneut prüfen und den Text in `DOCS_SYNC_AUDIT.md` auf den dann aktuellen Stand setzen (im Prompt-Output von DC-04 mitführen).
