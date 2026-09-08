# RESTORE-01 — Restore des Firmenzustands pro Aufrufer (blockierend, ungedeckelt, ohne Index)

- **ID:** RESTORE-01 (Quelle: Prompt 13 „[DbRestoreStateSync]“, externe Arena-Review-Serie)
- **Severity:** MEDIUM
- **Bereich:** Betriebs-/Verfügbarkeitshärtung (Datenbankzugriff auf dem Hot Path)
- **Quelle:** Arena-Review-Serie, Prompt 13 — formuliert für einen Django-Bot
  (`trading/trading_bot.py`, Zeilen 236–249, 289); für diesen Stack übersetzt
  und gegen den realen Code verifiziert
- **Status:** FIXED
- **Fix-Version:** v1.36.37 (2026-09-08)
- **Fix-PR:** PR [#123](https://github.com/Kryschuuu/ai-trading-firm/pull/123) (Branch `arena/01a080a3-ai-trading-firm`)
- **Datei(en):** `src/lib/engine.ts`, `src/lib/stateRegistry.ts`, `src/db/schema.ts`, `drizzle/2026-09-08_positions_open_idx.sql` (neu), `tests/engine.stateRestore.test.ts` (neu), `tests/stateRegistry.test.ts`

> Der Status und die Validierung sind unter „Remediation (umgesetzt,
> v1.36.37)“ und „Akzeptanzkriterien / Validierung“ festgehalten. Der überprüfte Wortlaut des Findings (Python/`sync_to_async`)
> ist unter „Triage des Wortlauts“ dokumentiert und für dieses Repository als
> nicht anwendbar bewertet — die Schwachstellenklasse dagegen ist real und
> wurde behoben.

## Triage des Wortlauts (warum die Befehlsdatei hier nicht existiert)

Das Finding nennt `trading/trading_bot.py` mit `db_restore_state()`,
`@sync_to_async(thread_sensitive=False, executor=_BOT_DB_EXECUTOR)`,
`db_safe(suppress=True)`, `TradingBot.__init__`/`main_loop()` und ein
Django-Projekt „t-bot-lokal“. Diese Namen sind im Repository nicht vorhanden
und waren es nie:

| Prüfschritt | Ergebnis |
|-------------|----------|
| Python-Dateien im Repo (alle, außer `.git`/`node_modules`) | 0 |
| Verzeichnis `trading/` | existiert nicht |
| `git log --all -- '**/trading_bot.py'` | kein Treffer (auch nicht in der Historie) |
| Suche nach `db_restore_state` / `TradingBot` / `sync_to_async` / `db_safe` / `t-bot-lokal` | keine Treffer in Code, Docs oder Configs |
| Stack laut `package.json` | Next.js 16 + Drizzle ORM + PostgreSQL (`pg`), TypeScript |

Ein `@sync_to_async`-Decorator wäre in Node.js wirkungslos (es gibt keinen
blockierenden Thread, der in den Executor verlagert werden müsste — der
Event-Loop ist das Risiko). **Der übertragene Maßstab ist deshalb:** die
Zustandswiederherstellung darf (a) nicht pro Aufrufer laufen, (b) die
Datenbank bei Fehlern nicht unbegrenzt nachladen lassen und (c) bei großen
Tabellen nicht den einzigen Laufstrang des Prozesses blockieren.

## Beschreibung des realen Pfads (vor v1.36.37)

`getBroker()` in `src/lib/engine.ts` ist der einzige Weg zum Paper-Ledger und
stellt beim ersten Zugriff nach einem Prozessstart den persistenten Zustand aus
PostgreSQL wieder her (offene Positionen, Cash-Hinweis aus
`equity_snapshots`, Kill-Switch-Stand). Ausgelöst wird er unter anderem von:

- jedem HTTP-Request auf `/api/firm` (und damit vom Dashboard-Refresh),
- dem Scheduler-Tick alle 60 s (`src/lib/monitor.ts`, der selbst ebenfalls
  `getBroker()` aufruft),
- der Agenten-Pipeline und `flattenAll()`.

Vor dem Fix galt:

```ts
// src/lib/engine.ts (v1.36.36, vereinfacht)
if (!state.firmHydrated.get()) {
  try {
    const openRows = await db.select().from(positions).where(eq(positions.status, "OPEN"));
    broker.hydrate(openRows.map(…), { cashHint });
    state.firmHydrated.set(true);
  } catch (e) {
    console.error("[getBroker] Hydration fehlgeschlagen:", msg);
    state.firmHydrated.set(false);   // ← jeder nächste Aufruf versucht ALLES erneut
  }
}
```

Drei Mängel am selben Pfad:

1. **Keine Bündelung (Thundering Herd).** Das Flag wird erst nach den `await`s
   gesetzt, also passieren bei N gleichzeitigen Kaltstartern N vollständige
   Restores. Messbar: 10 parallele Aufrufe → 10 Restore-Läufe, 200 parallele
   Leser → 200 Restore-Läufe (rot dokumentiert in
   `tests/engine.stateRestore.test.ts`).
2. **Kein Versuchsdeckel.** Jeder Fehlschlag (DB-Wegfall, Replikations-
   fenster, fehlendes Schema nach `drizzle-kit push`-Vergessen) führte dazu,
   dass *jeder* folgende Zugriff den teuersten Query-Pfad des Prozesses
   erneut komplett ausführte — unbegrenzt, mit voller Fehler-Logzeile pro
   Aufruf. Bei einer bereits degradierten Datenbank ist das ein
   Selbstverstärker der Überlastung.
3. **Kein Index.** `positions` ist append-only (geschlossene Trades bleiben
   erhalten) und hatte keinerlei Index. `WHERE status = 'OPEN'` war damit ein
   Sequenz-Scan über die gesamte Tabelle — derselbe „große Tabellen“-Effekt,
   den das Finding beschreibt, nur in der Query statt im Thread. Dieselbe
   Abfrage nutzt der Monitor-Tick (alle 60 s), `src/ops/collect.ts` und der
   Mikro-Executor (`src/lib/microExecutor.ts`, pro Order).

Zusätzlich, aus der Struktur folgend: zwei überlappende `broker.hydrate()`-
Läufe konnten denselben Ledger erst leeren (`positions.clear()`) und dann mit
dem jeweils vorher gelesenen Stand füllen — ein zwischenzeitlich gebuchter
Fill konnte so im In-Memory-Zustand verschwinden, obwohl er in der DB stand.

## Ausnutzbarkeit / Belastungsvektoren

Kein Auth-Bypass, keine Order-Manipulation, kein Datenabfluss. Der Pfad ist
ein Verfügbarkeitsvektor:

- **Lastverstärker gegen die eigene Datenbank:** billige, wiederholte Leser
  (Dashboard-Refresh, Tick, Retries eines Clients) vervielfachen die teuerste
  Query, solange die DB gestört ist — genau dann, wenn Kapazität knapp ist.
- **Journal-Spam:** ein Fehler pro Aufruf bläht Logs auf (Cost + Rauschen bei
  Incident-Analyse).
- **Kaltpfad nach jedem Deploy/Restart:** `systemd`-Neustarts und Deploys
  treffen den ungebündelten Pfad zwangsläufig parallel.

## Remediation (umgesetzt, v1.36.37)

1. **Single-Flight:** `ensureFirmStateRestored()` teilt den laufenden Restore
   über `state.firmHydration` (Registry-Slot, Muster identisch zu
   `controlPlaneHydrating` der Control Plane). Alle parallelen Aufrufer hängen
   sich an dasselbe Promise; der Slot wird beim Abschluss freigegeben.
2. **Backoff:** nach einem Fehlschlag wird frühestens nach
   `FIRM_HYDRATION_RETRY_MS` (5 s) wieder versucht. `firmHydrated` bleibt
   `false` (kein vorgetäuschter aktueller Zustand).
   `invalidateBrokerCache()` — genutzt u. a. von `POST /api/firm/kill` — hebt
   das Fenster gezielt auf, Operator-Pfade bleiben also sofort wirksam.
3. **Clock-Skew-Grenze:** ein zurückspringender Systemtakt darf ein offenes
   Backoff-Fenster nicht verlängern (Fristen außerhalb ihrer eigenen Länge
   werden verworfen). Lektion aus SEC-08/v1.36.35.
4. **Log-Dedup:** `reportRestoreFailureOnce()` meldet den Restore-Fehler
   einmal pro Fenster statt einmal pro Aufruf.
5. **Kosten der Abfrage:** partieller Index `positions_open_idx` auf
   `positions (symbol) WHERE status = 'OPEN'` — deklariert in
   `src/db/schema.ts` (damit `drizzle-kit push` ihn nicht wieder entfernt) und
   idempotent gemigriert in `drizzle/2026-09-08_positions_open_idx.sql`.
   Der Index enthält nur offene Zeilen und bedient zugleich die
   Symbol-Lookups des Flatten-Pfads und des Mikro-Executors.

### Warum der Versuchsdeckel sicher bleibt

Ein gedeckelter Restore heißt: bis zu 5 s lang kann der In-Memory-Ledger
unhydratisiert sein (leere Positionen, volles Startkapital). Genau dieser Fall
ist bereits durch H2 (v1.36.19) abgesichert — `submitAtomic()` prüft die
Positions- und Cash-Wahrheit **in der Datenbank** (`pg_advisory_xact_lock` je
Konto + `order_intents`-Reservierung) **vor** dem In-Memory-Guard. Ein auf
veraltetem Ledger getroffener Guard kann daher keinen zweiten Slot für ein
offenes Symbol eröffnen und kein Cash überziehen. Der vor dem Fix existierende
„Retry bei jedem Aufruf“ war in diesem Sinne kein Sicherheitsnetz, sondern nur
ein teurerer.

Bewusst **nicht** geändert: der Restore bleibt eine `async`/`await`-Abfrage
gegen den `pg`-Pool (kein blockierender Aufruf, kein blockierendes I/O), und
`PaperBroker.hydrate()` bleibt synchron — die reinen Arrayschritte sind
O( offene Positionen ) und damit vernachlässigbar; das Problem war die
Query-Kosten- und Wiederholungsseite, nicht die Schleife. Eine künstliche
Zerkleinerung der Hydration hätte keinen messbaren Gewinn, aber neue
Zwischenzustände im Ledger eingeführt.

## Akzeptanzkriterien / Validierung

| Kriterium (aus dem Prompt) | Übertragener Maßstab | Ergebnis |
|---------------------------|----------------------|----------|
| `db_restore_state()` hat `@sync_to_async` | Restore nicht pro Aufruf, sondern gebündelt | ✅ `ensureFirmStateRestored()` |
| `_restore_state()` ist async | Restore ist async, blockiert den Event-Loop nicht | ✅ unverändert `async` (war es hier schon) |
| `main_loop()` ruft mit `await` auf | alle Aufrufer awaiten denselben Lauf | ✅ `await ensureFirmStateRestored(broker)` |
| Bot blockiert nicht bei großen Tabellen | Restore-Kosten + Wiederholungen gedeckelt | ✅ Backoff + `positions_open_idx` |
| Tests bestehen | Suite grün, neue Tests erst rot dann grün | ✅ 2005 Tests, 0 Fehler |
| Commit-Message „fix(bot): make db_restore_state async…“ | repo-konforme Conventional-Commit-Message | ✅ `fix(engine): …` (siehe unten) |

Der vorgeschlagene Commit-Titel des Findings („make db_restore_state async“)
wurde an die Realität dieses Repos angepasst: `db_restore_state` existiert
hier nicht, und „async machen“ wäre keine Verhaltensänderung. Der Fix ist
sinngemäß: `fix(engine): RESTORE-01 — Restore des Firmenzustands gebündelt,
gedeckelt und indexgestützt`.

Rot→Grün: die Verhaltenstests in `tests/engine.stateRestore.test.ts` waren
vor dem Fix rot (10 / 200 / 20 Restore-Läufe statt jeweils 1, 12 Logzeilen
statt 1, fehlender Index/Migration) und sind nach dem Fix grün. Die
Semantik-Tests (Positionen, Cash-Hinweis, SL/TP bleiben korrekt hydratisiert)
waren vorher grün und sind es danach — der Fix verändert keine Buchführung.

## Upgrade

- Index anlegen: `npx drizzle-kit push` **oder**
  `psql "$DATABASE_URL" -f drizzle/2026-09-08_positions_open_idx.sql`.
- Fehlt der Index: alles funktional unverändert, nur ohne den
  Geschwindigkeitsvorteil.
- Keine neue Umgebungsvariable, keine Datenmigration, keine API-Änderung.
