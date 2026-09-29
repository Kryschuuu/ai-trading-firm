# STX-04-01 — Migration: `strategy_definitions` + `strategy_versions`

- **Phase:** 4 · **Paket:** 03-09 · **Finding:** STX-06
- **Risiko:** mittel (Schema) · **Additive Migration, kein Datenverlust**

## Zweck

Die zentrale Diagnose des Ausbaudokuments: `strategy_lifecycle_states` trägt
`strategy_key` (Freitext) und `strategy_version` (Integer) — aber **nirgends liegt das
versionierte Strategie-Artefakt**. Version 3 einer Strategie ist damit nicht
rekonstruierbar. Dieser Prompt schafft die fehlende Persistenz.

## Kontext

Muster: `drizzle/2026-09-23_strategy_lifecycle.sql` — append-only, idempotent
(`IF NOT EXISTS`), `DO $$ … EXCEPTION WHEN duplicate_object` für Constraints,
`gen_random_uuid()`, ausführbar per `psql` **und** `drizzle-kit push`.
Die Migration beginnt mit einem **Bootstrap-Hinweis** („LEER starten") — übernehmen.

Hash- und Idempotenz-Muster ebenfalls aus dieser Migration:
`content_hash ~ '^sle1:[0-9a-f]{64}$'`, `transition_key ~ '^slt1:[0-9a-f]{64}$'`.

## Auftrag

1. **`drizzle/2026-09-2X_strategy_catalog.sql`** (Datum = Umsetzungstag):

   **`strategy_definitions`**
   - `id uuid PK`
   - `template_id text NOT NULL` (FK-Kandidat auf den Katalog, **kein** FK — der Katalog
     ist Code, nicht DB; Shape-Constraint `^[a-z0-9-]{3,64}$`)
   - `strategy_class text NOT NULL` CHECK in `('mean-reversion','trend','breakout')`
     — **kein** `unclassified` (ADR-E1)
   - `name text NOT NULL`, `description text NOT NULL`
   - `created_by text NOT NULL DEFAULT 'system'`, `created_at timestamptz NOT NULL DEFAULT now()`
   - `UNIQUE (template_id, name)` — ein Template kann mehrere benannte Definitionen haben
     (z. B. „BTC-EMA", „ETH-EMA")

   **`strategy_versions`**
   - `id uuid PK`, `definition_id uuid NOT NULL REFERENCES strategy_definitions(id)`
   - `version integer NOT NULL CHECK (version >= 1)`
   - `params_json jsonb NOT NULL` — die kompilierten Parameter
   - `rule_spec_json jsonb NOT NULL` — die **sanitisierte** `RuleSpec` (aus 03-09)
   - `timeframe text NOT NULL` CHECK in der Store-Liste
   - `fingerprint text NOT NULL` — aus 03-09
   - **`content_hash text NOT NULL` CHECK (`~ '^stv1:[0-9a-f]{64}$'`)**
   - `code_version text NOT NULL` — `APP_VERSION` zum Erzeugungszeitpunkt
   - `template_version integer NOT NULL`
   - `created_by text NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`
   - `UNIQUE (definition_id, version)` **und** `UNIQUE (fingerprint)`
   - Index auf `(definition_id, created_at DESC)`

2. **`src/db/schema.ts`**: Drizzle-Definitionen ergänzen, Spaltennamen/SQL-Typen
   deckungsgleich zur Migration. Kommentiere die Zuordnung.

3. **Optionaler, additiver FK** auf `strategy_lifecycle_states`:
   `strategy_version_id uuid REFERENCES strategy_versions(id)` — **nullable**, damit
   bestehende Zeilen gültig bleiben. Kein Backfill-Zwang, kein `NOT NULL`.
   *Wenn die Abhängigkeit 04-02 zu zyklisch macht, lass sie weg und hole sie in 04-02 nach.*

4. **Rollback-Block** im SQL-Kommentar (Muster der Lifecycle-Migration):
   `DROP TABLE IF EXISTS …` in umgekehrter Reihenfolge, plus der Hinweis, dass der
   Lifecycle-Risikofaktor unabhängig davon bleibt.

## Akzeptanzkriterien

- [ ] Migration ist idempotent (zweimal ausführbar, kein Fehler)
- [ ] `psql -f` **und** `drizzle-kit push` führen zum selben Schema
- [ ] Rollback-Block dokumentiert **und** getestet (auf einer Wegwerf-DB)
- [ ] `strategy_lifecycle_states`-Zeilen bleiben gültig (kein NOT NULL, kein Backfill)
- [ ] `npm run typecheck && npm run lint` grün
- [ ] **Kein** Backfill, **keine** Änderung bestehender Migrationen
- [ ] Kommentar im SQL: **warum** `content_hash` UNIQUE ist (Idempotenz, keine Dubletten)

## Tests

`tests/strategyCatalog.db.test.ts` (Muster `tests/backtest.montecarlo.db.test.ts`,
`tests/crossSectional.db.test.ts`):
- Constraint-Tests: `version = 0`, `strategy_class = 'unclassified'`,
  `template_id = 'Bad Id'`, Hash-Format ⇒ alle **schlagen fehl**
- `UNIQUE (fingerprint)` verhindert Doppelpersistenz derselben Version
- `UNIQUE (definition_id, version)` verhindert Versions-Sprung

## Gesperrt

- **Keine Änderung** an `strategy_lifecycle_*`, `backtest_runs`, `trade_rules`.
- **Kein** `DELETE`-Pfad auf `strategy_versions` (immutable — Korrekturen sind neue
  Versionen).
- **Kein** `strategy_screening_*` (kommt in 05-03).
- Keine Spalte, die nur für Bequemlichkeit da ist — jede Spalte wird gelesen.
