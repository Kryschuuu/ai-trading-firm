# ASA-11 — Fehlende Sekundärindizes auf Kerntabellen, unbegrenzte Full-Table-Loads und fehlendes `statement_timeout`

- **ID:** ASA-11
- **Severity:** MEDIUM
- **Bereich:** Performance / Datenbank
- **Status:** OPEN
- **Datei(en):** `src/db/schema.ts:15-175`, `src/db/index.ts:35-60`, `src/lib/signalDecayRuntime.ts:251-273`, `src/app/api/firm/route.ts:45-60`, `src/lib/monitor.ts:318-323, 574-590`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md`](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md)

## Beschreibung

Den sechs meistgenutzten Kerntabellen der ersten Schema-Generation fehlen sämtliche Sekundärindizes; zudem laden mehrere Hot-Paths komplette Tabellen ohne `LIMIT` in den Node.js-Prozess, und dem PostgreSQL-Pool fehlt ein `statement_timeout`.

## Technischer Nachweis

1. **Keine Sekundärindizes (`src/db/schema.ts:15-175`):** `positions`, `agent_messages`, `equity_snapshots`, `audit_log`, `missions` und `trade_rules` besitzen außer dem Primärschlüssel keinen einzigen Index, obwohl Dashboard, Monitor und Executor permanent nach `status`, `active`, `run_id`, `event`, `recorded_at` und `created_at DESC` filtern und sortieren.
2. **Unbegrenzte SELECTs:** `refreshDecayFromDb()` (`src/lib/signalDecayRuntime.ts:253`) und `GET /api/firm` (`src/app/api/firm/route.ts:47`) führen `db.select().from(positions)` ohne `LIMIT` aus.
3. **Serielle Einzel-Updates (`src/lib/monitor.ts:318-323, 574-590`):** Regel-Deaktivierungen und Forecast-Auflösungen laufen in `for (... await db.update ...)`-Schleifen statt mit `inArray(...)`.
4. **Fehlendes `statement_timeout` (`src/db/index.ts:35-60`):** Hängende Abfragen können alle 10 Pool-Verbindungen unbegrenzt blockieren; `ensureDbConnection()` reicht `err.message` ungefiltert weiter.

## Konkreter Lösungsvorschlag

- Neue append-only Migration `drizzle/<n>_core_table_indexes.sql` (`CREATE INDEX IF NOT EXISTS ...`) plus passende `index(...)`-Definitionen in `src/db/schema.ts` für die sechs Kerntabellen ergänzen und danach `npm run docs:inventories` ausführen.
- `refreshDecayFromDb()` auf `WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 2000` beschränken; `GET /api/firm` auf offene Positionen + letzte `N` geschlossene Positionen begrenzen; Schleifen-Updates in `monitor.ts` mit `inArray` zusammenfassen.
- Im `pg.Pool` (`src/db/index.ts`) `statement_timeout: 15_000` setzen und Verbindungsfehler in `ensureDbConnection` sanitisieren.

## Akzeptanzkriterien / Verifikation

- [ ] `src/db/schema.ts` und `drizzle/*.sql` definieren Indizes für alle sechs Kerntabellen; `npm run docs:inventories:check` ist grün.
- [ ] Weder `signalDecayRuntime.ts` noch `GET /api/firm` führen ein unbegrenztes `select().from(positions)` ohne `LIMIT` / Filter aus.
- [ ] `pg.Pool` konfiguriert ein deterministisches `statement_timeout`.
