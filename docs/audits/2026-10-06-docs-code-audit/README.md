# Docs↔Code-Audit 2026-10-06 — Befunde & Remediation

- **Audit:** Docs↔Code-Ist/Soll der gesamten `docs/`-Landschaft gegen Code und Commit-Historie
- **Bericht (Volltext):** [`../../DOCS_CODE_AUDIT_2026-10-06.md`](../../DOCS_CODE_AUDIT_2026-10-06.md)
- **Prüfbasis:** `main` @ `104aaef` (Merge PR #234, 2026-10-06) · Code-Version **0.17.2**
- **Reviewer:** Arena-Agent-Session (externer Abgleich; Methodik im Bericht §0)
- **Status:** **ERLEDIGT** — 9 Befunde: 9 FIXED (DC-01…DC-09)
- **Prompts:** [`prompts/README.md`](prompts/README.md) — kopierfertig für Folge-Sessions
- **Tracking:** [`remediation/TRACKING.md`](remediation/TRACKING.md)

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt |
|----------|--------|-------|-----------|--------|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 2 | 0 | 0 | **2** (DC-01, DC-02) |
| MEDIUM | 6 | 0 | 0 | **6** (DC-03…DC-08) |
| LOW | 1 | 1 | 0 | 0 |
| **Summe** | **9** | **1** | **0** | **8** |

## Befundliste

| ID | Severity | Titel | Bereich | Status | Prompt |
|----|----------|-------|---------|--------|--------|
| [DC-01](findings/DC-01-proposal-approve-ohne-autorisierung.md) | HIGH | Proposal-Freigabe ohne Autorisierung (einzige schreibende Firm-Route ohne Guard) | Security / API | ☑ **FIXED** 2026-10-06 | — (in dieser Session) |
| [DC-02](findings/DC-02-require-human-approval-zwei-semantiken.md) | HIGH | `REQUIRE_HUMAN_APPROVAL`: Anzeige (`=== "true"`) vs. Enforcement (`!== "false"`) | Security / Konsistenz | ☑ **FIXED** 2026-10-06 | — (in dieser Session) |
| [DC-03](findings/DC-03-doku-kleinfindings.md) | MEDIUM | Doku-Kleinfindings (12 Einzelpunkte: Feature-Zahl, API-Feld, Versionen, Zahlen) | Doku-Wahrheit | ☑ **FIXED** 2026-10-06 | — (in dieser Session) |
| [DC-04](findings/DC-04-versions-header-drift.md) | MEDIUM | Versions-/Status-Header: nur 4 von 45 Dokumenten auf Code-Stand | Doku-Wahrheit | ☑ **FIXED** 2026-10-09 (PR #236) | [DC-04](prompts/PROMPT-DC-04-versions-header-bump.md) |
| [DC-05](findings/DC-05-env-flags-ohne-implementierung.md) | MEDIUM | 4 dokumentierte Env-Flags ohne Code-Read; `.env.example` lückenhaft | Betrieb / Doku | ☑ **FIXED** 2026-10-09 | [DC-05](prompts/PROMPT-DC-05-env-flags-entscheiden.md) |
| [DC-06](findings/DC-06-symbol-und-pfad-drift.md) | MEDIUM | Symbole/Pfade in Architektur-Doku ohne Code-Entsprechung | Architektur-Doku | ☑ **FIXED** 2026-10-09 | [DC-06](prompts/PROMPT-DC-06-symbol-pfad-abgleich.md) |
| [DC-07](findings/DC-07-db-schema-15-von-67.md) | MEDIUM | `DB_SCHEMA.md` beschreibt 15 von 67 Tabellen | Datenmodell-Doku | ☑ FIXED (2026-10-09) | [DC-07](prompts/PROMPT-DC-07-db-schema-nachfuehren.md) · [Invenar](../../generated/schema-inventory.md) |
| [DC-08](findings/DC-08-ci-waechter-luecken.md) | MEDIUM | `docs:validate` sieht die Drift nicht (5 Check-Lücken); 2 Contract-Tests scheitern statt zu skippen | CI / Prozess | ☑ **FIXED** 2026-10-10 | [Finding + Counterprobes](findings/DC-08-ci-waechter-luecken.md) · [Prompt](prompts/PROMPT-DC-08-docs-validate-ausbau.md) |
| [DC-09](findings/DC-09-prozess-inventare-und-bump.md) | LOW | Kein generiertes Inventar & kein automatisierter Versions-Bump-Schritt | Prozess | ☑ FIXED (2026-10-10) | [DC-09](prompts/PROMPT-DC-09-inventare-und-release-bump.md) |

## Was in dieser Session bereits behoben wurde

| Befund | Änderung | Verifikation |
|--------|----------|--------------|
| DC-01 | `requirePermission(req,"firm.write") ?? checkCsrfGuard(req)` **vor** jedem DB-Zugriff in `src/app/api/firm/proposals/[id]/approve/route.ts`; Actor-Identität (`actorAuditId`) zusätzlich im Audit-`detail`/Response | `tests/proposalApprove.auth.test.ts` (7 Tests: anonym 401, gefälschte Header, Viewer 403, CSRF 403, Operator passiert, local-open, Quell-Drift-Schutz) |
| DC-02 | `src/app/api/firm/route.ts` nutzt `humanApprovalRequired()` aus `src/live-gate/config.ts` statt eigener `=== "true"`-Auswertung | `tests/firmHumanApproval.parity.test.ts` (Parität über live-gate/ALPACA/BITUNIX + Quell-Drift-Schutz) |
| DC-03 | 12 Doku-Korrekturen (Details im Befund) + Status-Header für 3 Dokumente + Index-/Audit-Baum-Einträge | `npm run docs:validate` grün |
| DC-04 | Header klassifiziert (a/b/c), Legacy-Zählung in Dokumenttiteln als Klammerhinweis (PR #236, gemergt 2026-10-08) | Header-Scan: 66 Treffer, 0 falsch; `npm run docs:validate` grün · Details: [DC-04 § Umsetzung](findings/DC-04-versions-header-drift.md) |
| DC-05 | Env-Flags entschieden: `CYCLE_RETENTION_DAYS`/`_WEEKS` implementiert (envInt in `src/cycle/artifacts.ts`, Pruning am Daily-/Weekly-Abschluss in `src/cycle/service.ts`), `ROUTING_POLICY_VERSION` + `RISK_MAX_EQUITY_DRAWDOWN_PCT` gestrichen (Doku nennt die echten Quellen), `MICRO_FEED_TYPE` → `MICRO_FEED` korrigiert; `.env.example` + `CONFIGURATION.md` auf den echten Lese-Bestand ergänzt | `grep`-Reads der implementierten Flags; `tests/cycle.*.test.ts` 85/85 grün (3 neue Retention-Tests); `npm run typecheck`/`lint`/`docs:validate` grün · Details: [DC-05 § Umsetzung](findings/DC-05-env-flags-ohne-implementierung.md) |
| DC-06 | 34 Symbol-/Pfad-Korrekturen in `architecture/PIPELINE_MAP.md`, `architecture/INTEGRATION_POINTS.md`, `MISSIONS.md`, `DOCS_SYNC_AUDIT.md` (reale Exporte statt erfundener Namen; korrekte Modulgrenzen `scanner/weekly` ↔ `cycle/weekly`, `portfolio/pipeline` ↔ `portfolio/optimize`, `lib/riskGuard` ↔ `portfolio/riskGuard`; `perpdata/consumers.ts`, `components/ui/InfoTip.tsx`); neu: Absatz „Zwei Risk-Guards, zwei Zwecke“, Abschnitt „8. Pflege dieser Karte“, Rule-Matching-Einstieg `RuleCache.match()` inkl. still übersprungenem `maxExecutionsPerDay` | Verifikations-Skript des Befunds: nur die 2 whitelisted Altpfade; Symbol-/Attributions-Scan 0 Treffer; `tests/docsArchitectureSymbols.test.ts` 9/9; `typecheck`/`lint`/`docs:validate` grün · Details: [DC-06 § Umsetzung](findings/DC-06-symbol-und-pfad-drift.md) |
| DC-08 | L1–L4 inklusive AST-Env-Reads/dynamischer `env[name]`-Auflösung, nicht-blockierender L2 Code→Doku-Warnungen, `Code-Version`-Header und Pfad-/Export-Checks; L5 Variante A verdrahtet `npm test` im Required Job `docs-validate`, Broker-Test nutzt temporäres Embedded-PostgreSQL | Counterprobes 4/4; `docs:validate` 12/12 Checks ohne L2-Warnungen; `brokerContracts` 42/42; `npm test` 4.754 pass/0 fail/36 Skip; beide Workflow-Spiegel byte-identisch · Details: [DC-08](findings/DC-08-ci-waechter-luecken.md) |

## Nicht-Ziele dieses Audits

- Kein Live-Test gegen Venues/LLMs (Sandbox ohne Netzwerkzugang) — Aussagen zu Broker-/LLM-Verhalten stammen aus Code- und Doku-Abgleich.
- Keine Neubewertung der Beta-Kriterien `B1…B8` ([`BETA_STATUS.md`](../../BETA_STATUS.md) bleibt gültig).
- DC-04…DC-09 wurden als Folgemaßnahmen umgesetzt; DC-09 umfasst generierte Inventare, den Code-Version-Bump und die Konvention in `CONTRIBUTING.md` (siehe `remediation/TRACKING.md`).
