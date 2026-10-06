# Remediation-Tracking — Docs↔Code-Audit 2026-10-06

- **Audit:** [`../README.md`](../README.md) · **Bericht:** [`../../../DOCS_CODE_AUDIT_2026-10-06.md`](../../../DOCS_CODE_AUDIT_2026-10-06.md)
- **Prüfbasis:** `main` @ `104aaef` (2026-10-06) · Code-Version **0.17.2**
- **Stand:** 2026-10-06 · **9 Findings:** 3 FIXED (DC-01, DC-02, DC-03), 6 OPEN (DC-04…DC-09)
- **Konvention:** ein Prompt = eine Coding-Session; nach Erledigung Status hier und in `../README.md` nachziehen (Nummern der Findings unverändert lassen).

## Statusübersicht

| ID | Severity | Titel | Status | Beleg / Prompt |
|----|----------|-------|--------|----------------|
| DC-01 | HIGH | Proposal-Freigabe ohne Autorisierung | ☑ **FIXED** (2026-10-06) | `src/app/api/firm/proposals/[id]/approve/route.ts` (Guard `firm.write` + CSRF vor DB), `tests/proposalApprove.auth.test.ts` (7 Tests), `tests/routes.asyncParams.test.ts` angepasst |
| DC-02 | HIGH | `REQUIRE_HUMAN_APPROVAL` zwei Semantiken | ☑ **FIXED** (2026-10-06) | `src/app/api/firm/route.ts` nutzt `humanApprovalRequired()`, `tests/firmHumanApproval.parity.test.ts` (Parität + Quell-Drift) |
| DC-03 | MEDIUM | Doku-Kleinfindings (12 Punkte) | ☑ **FIXED** (2026-10-06) | Änderungen in `STRATEGY_STACK.md`, `PORTFOLIO_ANALYTICS.md`, `PIPELINE_MAP.md`, `DB_SCHEMA.md`, `VERSION.md`, `CONTRIBUTING.md`, `docs/ci/README.md`, `docs/README.md`, `audits/README.md`, `BETA_STATUS.md`, `HANDBUCH.md`, `DAILY_WEEKLY_RESEARCH.md`, `SYMBOLS.md`, `SETUP_PG_TROUBLESHOOTING.md`, `security/README.md`; `docs:validate` grün |
| DC-04 | MEDIUM | Versions-/Status-Header: 4/45 auf Code-Stand | ☐ OFFEN | [PROMPT-DC-04](../prompts/PROMPT-DC-04-versions-header-bump.md) |
| DC-05 | MEDIUM | Env-Flags ohne Read; `.env.example` lückenhaft | ☐ OFFEN | [PROMPT-DC-05](../prompts/PROMPT-DC-05-env-flags-entscheiden.md) |
| DC-06 | MEDIUM | Symbol-/Pfad-Drift in der Architektur-Doku | ☐ OFFEN | [PROMPT-DC-06](../prompts/PROMPT-DC-06-symbol-pfad-abgleich.md) |
| DC-07 | MEDIUM | `DB_SCHEMA.md` 15 von 67 Tabellen | ☐ OFFEN (Scope-Hinweis gefixt) | [PROMPT-DC-07](../prompts/PROMPT-DC-07-db-schema-nachfuehren.md) |
| DC-08 | MEDIUM | `docs:validate`: fünf Check-Lücken; Test-Suite in keiner CI | ☐ OFFEN | [PROMPT-DC-08](../prompts/PROMPT-DC-08-docs-validate-ausbau.md) |
| DC-09 | LOW | Kein generiertes Inventar, kein Release-Bump | ☐ OFFEN | [PROMPT-DC-09](../prompts/PROMPT-DC-09-inventare-und-release-bump.md) |

## Empfohlene Abarbeitungsreihenfolge

```text
DC-04  (Sichtbarkeit/Kopfzeilen)          ─┐
DC-05  (Env-Flags entscheiden)             │  inhaltliche Nachführung
DC-06  (Symbole/Pfade)                     │
DC-07  (Schema-Inventar)                  ─┘
DC-08  (docs:validate verschärfen)         ← erst NACH 04–07, sonst sofort rot
DC-09  (Inventare + Bump-Skript)           ← kann 07/08 vorbereiten
```

## Erledigt-Nachweise (Kurzform)

- **DC-01:** Route prüft `requirePermission(request, "firm.write") ?? checkCsrfGuard(request)` **vor** jedem DB-Zugriff; `authenticatedActor` (`actorAuditId`) zusätzlich in beiden Audit-Stufen (`PRECHECK`/`APPLIED`) und in der Response. Tests decken anonym (401), gefälschte Header, Viewer (403), fehlendes CSRF (403), Operator (Guard passiert), `local-open` (CSRF bleibt Pflicht) und den Quell-Drift ab.
- **DC-02:** eine Semantik über `src/live-gate/config.ts`, `src/brokers/alpaca/config.ts`, `src/brokers/bitunix/config.ts` und die Firm-Anzeige; nur exakt `"false"` hebt die Human-Gate-Bedingung auf.
- **DC-03:** jede der 12 Einzelstellen mit Vorher/Nachher in [`../findings/DC-03-doku-kleinfindings.md`](../findings/DC-03-doku-kleinfindings.md); `npm run docs:validate` grün, Typecheck/Lint grün.

## Verifikationsstand dieser Session

| Prüfung | Ergebnis |
|---------|----------|
| `npm run typecheck` | grün |
| `npm run lint` | grün |
| `npm run docs:validate` | grün (9 Checks, 10 Hilfe-Dateien) |
| `npm test` (ohne externes PostgreSQL, nach den Fixes) | 4.769 Tests · **4.731 pass** · 2 fail · 36 skip — beide Fehler sind die bekannten DB-abhängigen PAPER-Contract-Tests (`ECONNREFUSED 0.0.0.0:5432`). Zahlen vollständig in `evidence/README.md` (Logdateien sind per `.gitignore` nicht versioniert) |
| Neue Tests | `tests/proposalApprove.auth.test.ts` (7), `tests/firmHumanApproval.parity.test.ts` (2) grün |

## Offene Beobachtungen ohne eigenen Finding-Status

- **`pruneArtifacts()` wird produktiv nie aufgerufen** (`src/cycle/artifacts.ts`) — gehört fachlich zu DC-05 (Flag-Entscheidung), wird dort mitentschieden.
- **`addAllowedHost` / keine weiteren Alias-Funde** aus dem Symbol-Scan wurden bewusst nicht gemeldet (kein Doku-Beleg).
- **„Schnittstellen"-Widersprüche zwischen Audit-Dokumenten** (z. B. `DOCS_SYNC_AUDIT.md` „0 offene Diskrepanzen" bei gleichzeitig 41 falschen Versions-Headern) sind Folgefehler von DC-04; nach dessen Umsetzung erneut prüfen und den Text in `DOCS_SYNC_AUDIT.md` auf den dann aktuellen Stand setzen (im Prompt-Output von DC-04 mitführen).
