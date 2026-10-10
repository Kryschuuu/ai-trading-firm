# PROMPT DC-07 — `DB_SCHEMA.md` nachführen (generiertes Schema-Inventar)

```text
TASK: Mach das Datenbank-Dokument wieder belastbar, ohne 52 Tabellen von Hand
zu beschreiben.

BEFUND (Audit docs/audits/2026-10-06-docs-code-audit/findings/DC-07-db-schema-15-von-67.md):
docs/architecture/DB_SCHEMA.md dokumentiert die 15 Tabellen des Stands 2026-09-18
(Code-Version 1.41.0). src/db/schema.ts enthält 67 pgTable-Definitionen; 34
Migrationen liegen in drizzle/. Der Scope-Hinweis wurde am 2026-10-06 ergänzt
(DC-03), die Tabellen selbst fehlen weiter: Feature Store, Forecasts,
Perp/Funding, Execution-Quality/TWAP/Workflows, Strategy-Catalog/-Lifecycle/
-Screening, Copy-Subscriptions, Regime-Snapshots, Drawdown-/Vol-Targeting,
Cross-Sectional, Sentiment, Prompt-Artefakte, Trade-Attachments.

DO:
1. Erzeuge scripts/gen-schema-inventory.ts (deterministisch):
   - Quelle: src/db/schema.ts + drizzle/*.sql
   - Ausgabe docs/generated/schema-inventory.md mit Kopfzeile
     "GENERIERT — nicht editieren (npm run docs:inventories)" und einer Tabelle:
     Tabelle | Quelle (schema.ts-Zeile) | Spalten | Migrationsdatei(en) | Zweck (TSDoc-Kurzform)
   - Sortierung stabil (Dateireihenfolge), LF, kein Zeitstempel (Stand-Datum nur
     als Parameter/Env, sonst byte-instabil).
   - Der "Zweck" wird aus dem TSDoc-Block über der Definition gezogen (erste
     Zeile); fehlt er, "—" statt Erfindung.
2. Ändere docs/architecture/DB_SCHEMA.md:
   - Kopf: Verweis auf SSoT und auf das generierte Inventar; die 15
     Kerntabellen bleiben als Prosa bestehen (sie beschreiben Verhalten, nicht
     nur Spalten).
   - Abschnitt "1. Übersicht aller Drizzle-Tabellen" verweist auf das Inventar
     statt eine unvollständige Liste zu behaupten.
   - Keine Tabelle aus dem Dokument entfernen, nur Scope korrekt einordnen.
3. Idempotenz sicherstellen: zweimal generieren => byte-identisch.
4. Optional, wenn trivial: `npm run docs:inventories` und
   `docs:inventories:check` in package.json registrieren (der eigentliche
   CI-Anschluss bleibt DC-09 vorbehalten).

AKZEPTANZ:
- `grep -c "pgTable(" src/db/schema.ts` = 67 und
  `grep -c "^| \`" docs/generated/schema-inventory.md` >= 67.
- Zweiter Lauf ohne Diff.
- `npm run docs:validate` grün (append-only-Änderungen an DB_SCHEMA.md dürfen
  keine Links brechen).
- Prompt-Output nennt die Zahl der neu inventarisierten Tabellen und die
  verbleibenden, bewusst nicht beschriebenen (falls es welche gibt).
```

## Hinweise für die ausführende Session

- Die 15 Prosa-Tabellen sind inhaltlich geprüft (Audit-Befund: korrekt bis auf
  das mit DC-03 korrigierte Candle-Limit) — nicht umschreiben, nur ergänzen.
- Keine Schema-/Migrationsänderung in diesem Prompt. Wenn dir beim Inventarisieren
  eine Tabelle mit widersprüchlichem TSDoc auffällt: im Prompt-Output melden,
  nicht „korrigieren".
- Wenn DC-09 bereits umgesetzt ist, dortigen Generator nutzen statt einen
  zweiten zu bauen (Reihenfolge 4/6 ist eine Empfehlung, keine Sperre).
