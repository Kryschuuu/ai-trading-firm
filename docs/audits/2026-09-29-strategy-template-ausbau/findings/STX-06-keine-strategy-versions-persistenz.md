# STX-06 — Kein versioniertes Strategie-Artefakt persistiert

- **ID:** STX-06
- **Severity:** MEDIUM
- **Bereich:** Persistenz / Strategy-Lifecycle
- **Quelle:** Ausbaudokument §7
- **Status:** OPEN
- **Datei(en):** `drizzle/2026-09-23_strategy_lifecycle.sql`, `src/strategyLifecycle/evidence.ts`

## Beschreibung

Die zentrale Diagnose des Dokuments ist **bestätigt**: `strategy_lifecycle_states` trägt
`strategy_key` (Freitext, Shape-Constraint) und `strategy_version` (Integer ≥ 1) — aber
**nirgends liegt das versionierte Strategie-Artefakt selbst.** Es gibt keine
`strategy_definitions`-/`strategy_versions`-Tabelle.

## Beweis

```sql
-- strategy_lifecycle_states
"strategy_key" text NOT NULL,
"strategy_version" integer NOT NULL,
-- CHECK: length BETWEEN 1 AND 128 AND ~ '^[A-Za-z0-9._:@/-]+$'
```

Der Key ist eine **Bezeichnung**, kein FK. `evidence` hat `content_hash` + `idempotency_key`
+ `code_version` + `data_version` + `policy_version` — aber die *Strategie*, die evaluiert
wurde, ist nicht referenziert.

## Remediation

1. Neue, **append-only** Migration: `strategy_definitions` (id, `strategy_class`,
   `template_id`, `scope`, `description`, `created_at`) und `strategy_versions`
   (id, definition_id, `version`, `params_json`, `rule_spec_json`, **`content_hash`**,
   `code_version`, `created_by`, `created_at`).
2. `UNIQUE (definition_id, version)`; `UNIQUE (content_hash)` (analog zu
   `strategy_lifecycle_evidence_hash_unique`).
3. `strategy_lifecycle_states` erhält einen optionalen FK `strategy_version_id` (additiv,
   bestehende Zeilen bleiben gültig — Bootstrap LEER, wie in der Lifecycle-Migration
   dokumentiert).

## Akzeptanzkriterien

- [ ] Append-only; keine Änderung bestehender Migrationen
- [ ] Ein `content_hash` genügt, um eine Version zu identifizieren
- [ ] Bestehende `strategy_key`-Zeilen bleiben gültig (kein Backfill-Zwang)
- [ ] Idempotenz: gleiche `(definition_id, params, code_version)` ⇒ dieselbe Version

## Versions-Hinweis

Minor (rein additive Migration).
