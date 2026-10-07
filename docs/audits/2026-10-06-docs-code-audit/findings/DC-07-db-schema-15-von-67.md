# DC-07 — `DB_SCHEMA.md` dokumentiert 15 von 67 Tabellen

- **ID:** DC-07
- **Severity:** MEDIUM
- **Bereich:** Datenmodell-Dokumentation
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Mengenabgleich `pgTable(` vs. Doku
- **Status:** ☐ **OPEN** (Sofort-Klarstellung bereits in DC-03 erfolgt)
- **Prompt:** [`../prompts/PROMPT-DC-07-db-schema-nachfuehren.md`](../prompts/PROMPT-DC-07-db-schema-nachfuehren.md)
- **Datei(en):** `docs/architecture/DB_SCHEMA.md`, `src/db/schema.ts`, `drizzle/*.sql` (34 Migrationen)

## Beschreibung

`docs/architecture/DB_SCHEMA.md` bezeichnet sich als „Kanonisches Datenbank- und
Persistenzverzeichnis" und behauptete bis 2026-10-06, **alle** Drizzle-Tabellen
zu spezifizieren — tatsächlich sind es die **15** Tabellen des Stands
2026-09-18 (`Code-Version 1.41.0`). `src/db/schema.ts` enthält inzwischen
**67 `pgTable`-Definitionen**; mit DC-03 wurde der Scope klargestellt, die
fehlenden Tabellen sind aber weiterhin nicht dokumentiert.

Nicht (oder nur am Rand) dokumentiert sind u. a.:

| Themenfeld | Tabellen (Auszug) |
|-----------|-------------------|
| Feature Store | `feature_definitions`, `feature_values` (PIT) |
| Forecasts/Sentiment | Forecast-, Resolution-, Score-Tabellen |
| Perp/Funding | Perp-Instrument-/Funding-/Open-Interest-Daten |
| Execution | Execution-Quality-Intents/Events, TWAP-Eltern/Kinder, Workflows |
| Strategie | Strategy-Catalog/-Versionen, Lifecycle-Evidence, Screening-Runs/-Zellen |
| Copy-Trading | Copy-Subscriptions/-Links |
| Risiko | Regime-Snapshots, Drawdown-/Vol-Targeting-Snapshots |
| Research | Cross-Sectional-Rankings, Prompt-Artefakte/Metriken, Trade-Attachments |

Die **dateigestützten** Persistenzstrukturen im selben Dokument (candles.ndjson,
kill-switch-Datei, Artefakt-Bäume) sind dagegen aktuell und geprüft (bis auf das
mit DC-03 korrigierte Candle-Limit).

## Wirkung

- **Betrieb/Migration:** Wer aus dem Dokument das Schema ableitet (Backup-Umfang,
  Retention, FK-Analyse), übersieht 52 Tabellen — bei Audit-Arbeit (SEC/DSGVO)
  ist das ein Blindfleck.
- **Doppelpflege:** Jede neue Tabelle muss manuell nachgezogen werden; 6
  Migrationen seit dem Stand sind der Nachweis, dass das nicht passiert.
- `DB_SCHEMA.md` ist als „verbindliche Referenz" verlinkt (u. a. aus
  `ARCHITECTURE.md`), trägt diese Rolle aber nicht mehr.

## Lösungsvorschlag (Prompt DC-07)

1. **Entscheidung im Prompt-Output:** Ersatz durch ein **generiertes** Verzeichnis
   (`docs/generated/schema-inventory.md`, erzeugt aus `src/db/schema.ts` +
   Migrationsliste) **plus** handgepflegte Erklärtexte nur für Kernbereiche.
   Das generierte Inventar ist die einzige Wahrheit für „welche Tabellen gibt
   es"; `DB_SCHEMA.md` verweist darauf und behält die Prosa für die 15
   Kerntabellen.
2. Der Generator (Teil von DC-09) muss **deterministisch** sein und in
   `docs:validate` auf Aktualität geprüft werden (Diff gegen Neu-Erzeugung).
3. Bis dahin: Verweis auf `src/db/schema.ts` als SSoT bleibt (DC-03),
   Liste der undokumentierten Tabellen als offene Punkte hier führen.
4. Keine Schema-Änderungen im Audit-Prompt — es geht ausschließlich um Doku.

## Verifikation nach Umsetzung

```bash
grep -c "pgTable(" src/db/schema.ts            # 67 (SSoT)
grep -c "^| \`" docs/generated/schema-inventory.md   # >= 67 Tabellenzeilen
npm run docs:validate                           # Diff-Check des Generats grün
```
