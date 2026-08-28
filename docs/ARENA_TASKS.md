# Arena-Tasks — Task-Tracker (1–12)

> **Status-Header (Task 12):** **Implementiert** (Task 12, Doku) ·
> **2026-08-28** · Version **1.19.0** · Branch: `arena/01a049f7-ai-trading-firm`

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
| 10 | Operations Center + RBAC | Implementiert | v1.18 | #8 | ✓ [S10](#) | ✓ | — |
| 11 | Live-Trading-Gate | Implementiert | v1.19 | #9 | ✓ [S11](#) | ✓ [R](#) | LG-01…LG-04 |
| **12** | **Dokumentation (Docs-Sync)** | **Implementiert** | **1.19.0** | **dieser PR** | **✓ [S12](#)** | **✓ [R12](#)** | **siehe unten** |

> Security-Spalte verweist auf die Kapitel in [SECURITY_AUDIT.md](SECURITY_AUDIT.md);
> die Anker `[S01]`…`[S12]` bezeichnen die jeweiligen Task-Kapitel.

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
- Audit-Report `docs/DOCS_SYNC_AUDIT.md`: 60 verifizierte Behauptungen,
  13 Diskrepanzen → 0 offen.
- Security-Kapitel Task 12 in `SECURITY_AUDIT.md`.

**Testbericht Task 12 (Doku-Task):**

- `npm run docs:validate` → **grün** (7 Checks, 9 Hilfe-Dateien).
- `npm run typecheck` → grün (siehe unten).
- Keine funktionalen Code-Änderungen (nur `package.json`-Skript + neue
  `scripts/docs-validate.ts`); bestehende Tests unverändert.

**Offene Punkte Task 12:** keine blockierenden; Nachpflege gemäß
„Wie Docs hier gepflegt werden“ (`ARCHITECTURE.md §12`).

---

## Empfohlene Nachpflege (Backlog)

- Branch-Protection inkl. Required Checks `docs-validate` + `security-live-gate`
  durch Repo-Admin einrichten (LG-03).
- Geplante (Task NN) Features bei Merge in `docs/` von „Geplant“ auf
  „Implementiert“ stellen.
