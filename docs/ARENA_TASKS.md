# Arena-Tasks — Task-Tracker (1–12)

> **Status-Header (Task 12):** **Implementiert** (Task 12, Doku) ·
> **2026-08-29** · Version **1.23.0** · Branch: `arena/01a049f7-ai-trading-firm`
>
> **Nachtrag 2026-08-29 (v1.23.0):** Task 10 wurde nachgeprüft. Das Operations
> Center war im Code eine Phase-1-Hülle (sieben Karten, fünf davon `stub`),
> während dieser Tracker „Implementiert“ auswies. Phase 2–4 des Task-10-Plans
> sind jetzt umgesetzt: zehn Sektionen mit echten Daten, keine Stub-Zustände.
> Der Status bleibt **Implementiert** — der Code hat die Doku eingeholt, nicht
> umgekehrt (Details siehe „Task 10 im Detail“).

Kanonischer Tracker „welcher Task steckt in welcher Version, mit welchem PR,
welchem Security-Audit und welchem Review-Status“. Spalten:
**Status** (Implementiert / Teilweise / Geplant), **Branch/PR**,
**Security-Audit** (✓/✗ + Link), **Review** (✓/✗), **offene Punkte**.

## Gesamtübersicht

| # | Titel | Status | Version | Branch/PR | Security ✓ | Review ✓ | Offene Punkte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Projekt-Setup | Implementiert | (vor 1.0) | initial | ✓ [S01](#) | ✓ | — |
| 02 | Konten-Struktur / Trading-Kern | Implementiert | v1.2 ff. | #1 | ✓ [S02](#) | ✓ | — |
| 03 | 6-Agenten-Pipeline | Implementiert | v1.6 ff. | #2 | ✓ [S03](#) | ✓ | — |
| 04 | LLM-Provider-Integration | Implementiert | v1.7 ff. | #3 | ✓ [S04](#) | ✓ | — |
| 05 | Bitunix-Vorbereitung | Implementiert | v1.15 ff. | #4 | ✓ [S05](#) | ✓ | — |
| 06 | Market-Universe-Registry | Implementiert | v1.8 | #4 | ✓ [S06](#) | ✓ | — |
| 07 | Paper-Trading + Schutzkette | Implementiert | v1.9 ff. | #5 | ✓ [S07](#) | ✓ | — |
| 08 | Security-Härtung + Audit-View | Implementiert | v1.10 ff. | #6 | ✓ [S08](#) | ✓ | — |
| 09 | Bitunix-Adapter (7. Venue) | Implementiert | v1.15 | #7 | ✓ [S09](#) | ✓ | — |
| 10 | Operations Center + RBAC | Implementiert | v1.18 → v1.23.0 | #8 | ✓ [S10](#) | ✓ | keine (Nachaudit v1.23.0) |
| 11 | Live-Trading-Gate | Implementiert | v1.19 | #9 | ✓ [S11](#) | ✓ [R](#) | LG-01…LG-04 |
| **12** | **Dokumentation (Docs-Sync)** | **Implementiert** | **1.19.0** | **dieser PR** | **✓ [S12](#)** | **✓ [R12](#)** | **siehe unten** |

> Security-Spalte verweist auf die Kapitel in [SECURITY_AUDIT.md](SECURITY_AUDIT.md);
> die Anker `[S01]`…`[S12]` bezeichnen die jeweiligen Task-Kapitel.

## Task 10 im Detail (Operations Center)

**Quelle:** Arena-Session `01a04cc9` · Branch `arena/01a04cc9-ai-trading-firm`
· PR `feat(ops): vollständiges Operations Center — zehn Sektionen statt Phase-1-Hülle (task-10)`.

**Befund der Nachprüfung (Code vor diesem Stand):**

- `src/components/ops/OperationsCenterPanel.tsx` bezeichnete sich als
  „Phase-1-Hülle“ und erklärte den Tab zur leeren Hülle.
- `src/auth/ops.ts` lieferte sieben Module; Universe, Scanner, Portfolio, Cycle
  und Routing standen auf Status `stub`.
- `GET /api/ops` beschrieb sich selbst als „Operations-Center-Hülle“.
- `docs/ARENA_TASKS.md` wies Task 10 gleichzeitig als „Implementiert“ aus —
  die beanstandete Doc-Code-Diskrepanz.

**Umsetzung (Aggregation, kein zweites Backend):**

| Sektion | Quelle (bestand bereits) |
| --- | --- |
| Market Universe | `src/universe` (InstrumentRegistry) |
| Scanner | `src/scanner` (ScannerService, Trichter + Ranking) |
| Portfolio Analytics | `GET /api/firm` (Positionen, Equity) + `src/portfolio` |
| Research Operations | `src/cycle` (Runs, Daily/Weekly-Artefakte) |
| Broker Operations | `GET /api/brokers` (Registry, Capabilities, Health) |
| LLM Operations | `GET /api/routing` (MODEL_ROUTER) + Provider-Status |
| Agent Operations | `GET /api/firm` (Agenten, Missionen, Nachrichten) |
| Risk | `src/lib/riskGuard` + `src/lib/adaptiveRisk` + `src/live-gate` |
| Audit | `GET /api/firm/log` (audit_log) + Live-Gate-Hash-Kette |
| Help | `docs/help/*.help.json` + `src/lib/docsCatalog.ts` |

**Eigenschaften:**

- Zehn Sektionen, jede mit `status`, `asOf`, `metrics`, `items`, `note`/`error`
  und sichtbaren `sources`. Kein `stub` mehr im Zustandsraum
  (`ready | degraded | empty | locked | unavailable`).
- Fail-soft je Sektion: eine nicht erreichbare Quelle (z. B. Datenbank aus)
  macht **nur** ihre Sektion `unavailable` — das Cockpit bleibt lesbar.
- Keine neue Fachlogik, keine Mutation, keine Secrets im Payload.
- `GET /api/ops` bleibt read-only und ohne Token ladbar; Rolle und Live-Sperre
  stehen weiterhin in der Kopfzeile (Live-Lock bleibt hart `false`).

**Testbericht:** `tests/ops.api.test.ts`, `tests/opsSections.test.ts`
(Payload, Aggregation, Fehler-/Leer-/Ladezustand, Render) und
`tests/task10.architecture.test.ts` (keine Platzhalter-Terminologie, zehn
Sektionen, kein Schreibpfad im Aggregator).

---

## Task 11 im Detail (v1.19.0)

**Quelle:** Arena-Session `01a0498d` · Branch `arena/01a0498d-ai-trading-firm`
· PR `feat(live-gate): auditierte Live-Trading-State-Machine + Enforcement +
Kill-Switch (task-11) — aktiviert kein Live`.

- Transitionsmatrix: 81 Kombinationen → 8 erlaubt, 73 abgelehnt, **0 Durchlässe**.
- Enforcement-Matrix: 9 States × 16 Flag-Kombis × Suite × Control Plane → **0 falsche Allows**.
- Kill-Drill aus allen 9 Zuständen inkl. Failsafe-Datei.
- Audit-Hash-Kette erkennt Verändern/Einfügen/Entfernen/Truncation.
- `npm run security:live-gate`: 78 Tests grün, Coverage **95,81 % Zeilen** (Tor 95 %); Gesamt `npm test` **1065/1065**.
- **Live bleibt OFF** — keine State-File, Flags false, kein Suite-Stamp im Betrieb.

**Bekannte Follow-ups (LG-01…LG-04):** LG-01 echte 4-Augen-Token-Identität
(Task 12+); LG-02 Venue-Testnet-Anbindung; LG-03 Branch-Protection
(Required Check `security-live-gate`); LG-04 Coverage-Tor nur Zeilen.

## Task 12 im Detail (Dokumentation)

**Quelle:** Arena-Session `01a049f7` · Branch `arena/01a049f7-ai-trading-firm`
· PR `docs: vollständige, code-synchronisierte Dokumentation + Hilfe-Systematik (task-12)`.

**Lieferumfang:**

- 15/15 Zieldokumente in `docs/` vorhanden, alle mit **Status-Header**.
- Root-Docs neu: `README.md`, `INSTALL.md` (Env-Flag-Tabelle), `CHANGELOG.md`.
- Hilfe-Systematik: `docs/help/help.schema.json` (neu) + alle 9 `*.help.json`
  schema-valid (fehlende `risiko`-Ebene ergänzt).
- CI-Job `docs-validate` (`docs/ci/docs-validate.workflow.yml`, `scripts/docs-validate.ts`,
  npm-Skript `docs:validate`): Schema, Link-Check, Markdown-Lint, Secret-Scan,
  Konsistenz-Checks (Env-Flags / API-Routen / State-Enum).
- Audit-Report `docs/DOCS_SYNC_AUDIT.md`: 99 verifizierte Behauptungen,
  13 Diskrepanzen → 0 offen.
- Security-Kapitel Task 12 in `SECURITY_AUDIT.md`.

**Testbericht Task 12 (Doku-Task):**

- `npm run docs:validate` → **grün** (7 Checks, 9 Hilfe-Dateien).
- `npm run typecheck` → grün (siehe unten).
- Keine funktionalen Code-Änderungen (nur `package.json`-Skript + neue
  `scripts/docs-validate.ts`); bestehende Tests unverändert.

**Offene Punkte Task 12:** keine blockierenden; Nachpflege gemäß
„Wie Docs hier gepflegt werden“ (`ARCHITECTURE.md §13`).

---

## Empfohlene Nachpflege (Backlog)

- Branch-Protection inkl. Required Checks `docs-validate` + `security-live-gate`
  durch Repo-Admin einrichten (LG-03).
- Geplante (Task NN) Features bei Merge in `docs/` von „Geplant“ auf
  „Implementiert“ stellen.
