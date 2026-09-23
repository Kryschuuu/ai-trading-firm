# Archiv — Veraltete oder historische Dokumente

> **Zweck:** Dokumente, die nicht mehr aktiv gepflegt werden, aber aus historischen Gründen erhalten bleiben. Kein Teil des aktiven Doku-Katalogs — wird nicht von `docs/README.md` verlinkt und nicht von `docs-validate` geprüft (außer explizit).

## Struktur

```
docs/archive/
├── README.md
├── CHANGELOG-legacy-v1.md   # Vollständige Legacy-Changelog-Historie (v1.x.x), unverändert
└── task-plans/
    ├── task-03-IMPLEMENTATION_PLAN.md
    ├── task-04-IMPLEMENTATION_PLAN.md
    ├── task-05-IMPLEMENTATION_PLAN.md
    ├── task-06-IMPLEMENTATION_PLAN.md
    ├── task-07-IMPLEMENTATION_PLAN.md
    ├── task-08-IMPLEMENTATION_PLAN.md
    ├── task-10-IMPLEMENTATION_PLAN.md
    └── task-11-IMPLEMENTATION_PLAN.md
```

## Was gehört hierher?

- **Legacy-Changelog** (`CHANGELOG-legacy-v1.md`): Die vollständige, unveränderte
  Beta-Entwicklungs-Historie in der internen Zählung `v1.x.x` (v1.40.0–v1.73.1),
  archiviert am 2026-09-23 mit dem Übergang auf das öffentliche v0.x.x-Schema.
  `v1.73.1` ≙ `v0.1.0 (Beta)`. Das Archiv wird **nicht mehr gepflegt** — neue
  Einträge gehören in das kanonische [`CHANGELOG.md`](../../CHANGELOG.md) im Root.
- **Task-Implementation-Pläne** (`task-*.md`): Historische Pläne für Arena-Tasks 03-11. Aktueller Stand ist in `docs/ARENA_TASKS.md` und `CHANGELOG.md` dokumentiert.
- **Alte Audit-Reports**, die durch neue Struktur ersetzt wurden (z. B. `AUDIT_REMEDIATION_2026-09.md` → `docs/audits/2026-09-03-peer-review/`)
- **Deprecated Docs**, die durch konsolidierte Versionen ersetzt wurden

## Was gehört NICHT hierher?

- Aktive Audits → `docs/audits/`
- Peer-Reviews → `docs/peer-reviews/`
- Security-Übersicht → `docs/security/`
- Aktive Topical Docs → `docs/` Root

## Hinweis

Dateien im Archiv werden **nicht gelöscht**, nur verschoben. Links aus aktiven Docs sollten nicht auf Archiv-Dateien zeigen — falls doch, auf aktive Version umbiegen.

## Migration 2026-09-05

Im Rahmen der Repository-Aufräumaktion wurden folgende Dateien hierher verschoben:

- `docs/task-03-IMPLEMENTATION_PLAN.md` bis `task-11-IMPLEMENTATION_PLAN.md` → `docs/archive/task-plans/`
- `docs/AUDIT_REMEDIATION_2026-09.md` → `docs/audits/2026-09-03-peer-review/report.md` (Original im Archiv oder gelöscht nach Migration)
- `docs/PEER_REVIEW_*.md` → `docs/peer-reviews/*/review.md`
- `docs/CHANGELOG.md` (Duplikat) → entfernt, kanonisch ist `CHANGELOG.md` im Root
- `audit-remediation/` (Root) → `docs/audits/2026-09-03-peer-review/findings/`

Siehe `docs/audits/README.md` und `docs/peer-reviews/README.md` für neue Struktur.
