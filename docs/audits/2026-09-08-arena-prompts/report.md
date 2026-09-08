# Prüfbericht — Arena-Review-Serie, Stand 2026-09-08

**Geprüft:** Prompt 13 („[DbRestoreStateSync] — `db_restore_state()` async-fähig
machen“) gegen den realen Stand dieses Repositories (Basis `main`, v1.36.36).
**Auftrag:** Everything prüfen, alles fixen, versionieren, Changelogs und
Readmes aktualisieren, PR.
**Ergebnis:** 1 Finding → Klasse real und behoben (v1.36.37), Wortlaut
nachweislich nicht anwendbar. Weitere Findings wurden in dieser Sitzung nicht
übergeben und sind hier nicht bewertet.

## 1. Was genau geprüft wurde

Die übergebene Befehlsdatei und ihre Symbole wurden hart gegengeprüft — nicht
nur per Dateinamen-Vermutung:

```bash
find . -name "*.py" -not -path "./node_modules/*" -not -path "./.git/*" | wc -l
# 0   → kein einziges Python-File im Repository

ls trading/
# ls: cannot access 'trading/': No such file or directory

grep -rn "db_restore_state\|TradingBot\|sync_to_async\|db_safe\|_BOT_DB_EXECUTOR\|t-bot-lokal" \
  --include="*.ts" --include="*.tsx" --include="*.js" --include="*.json" --include="*.md" .
# keine Treffer (Code, Docs, Configs)

git log --all --oneline -- "**/trading_bot.py"
# kein Treffer — die Datei existierte auch nie in der Historie dieses Baums
```

Der Stack ist Next.js 16 + Drizzle ORM + `pg` (siehe `package.json`).
`asgiref.sync.sync_to_async` hat hier kein Gegenstück: Es gibt keinen
Python-Thread, den man in einen Executor verlagern könnte. Der äquivalente
Risikomaßstab in Node.js ist der einzige Event-Loop — also: Was läuft pro
Aufrufer, was wiederholt sich ungedeckelt, und welche Query eine große Tabelle scannt?

## 2. Übertragener Befund (RESTORE-01)

Der Wiederherstellungspfad des Firmenzustands ist `getBroker()` in
`src/lib/engine.ts`. Drei Mängel am selben Pfad wurden bestätigt und behoben
— Details, Code, Validierung:
[RESTORE-01](./findings/RESTORE-01-state-restore-blocking.md).

| # | Mangel | Vorher (gemessen) | Nachher |
|---|--------|-------------------|---------|
| 1 | keine Bündelung paralleler Restores | 10 parallele Kaltstarts → 10 Restore-Läufe | 1 |
| 1 | Lastverstärker bei Request-Flut | 200 parallele Leser → 200 Restore-Läufe | 1 |
| 2 | kein Versuchsdeckel nach Fehlschlag | 20 Aufrufe → 20 teure Versuche | 1 pro Backoff-Fenster |
| 3 | Journal-Spam | 12 Fehlerzeilen für 12 Aufrufe | 1 pro Fenster |
| 4 | Sequenz-Scan auf `positions` | kein Index deklariert | `positions_open_idx` (partiell) |

Nr. 1–3 sind Verhaltenstests (`tests/engine.stateRestore.test.ts`, Fake-DB am
existierenden Injektions-Haken `globalThis.__arenaNextJsPostgresqlDb`),
4 ist durch Schema- und Migrations-Guard abgedeckt. Alle waren vor dem Fix rot.

## 3. Angrenzende Pfade, die geprüft und für gut befunden wurden

Bewusst einbezogen, weil die Klasse „blockiert den Loop / häuft Last“ dort
identisch aufgetreten wäre — kein Befund:

| Pfad | Prüfung | Ergebnis |
|------|---------|----------|
| `src/lib/microExecutor.ts` (Restore pro Order) | eigener `SELECT … status = 'OPEN'` + `broker.hydrate()` | bewusste Re-Hydration des Executor-Prozesses vor jeder Order (frische Wahrheit statt Cache); Kosten jetzt durch `positions_open_idx` gedeckelt, Semantik bleibt |
| `src/lib/monitor.ts` | Tick alle 60 s, eigener `SELECT … OPEN` | bereits durch `GLOBAL.__tickLock` einzeln ausgeführt; Query profitiert vom Index |
| `src/brokers/control-plane/service.ts` | Venue-Hydration | hatte Single-Flight (`controlPlaneHydrating`) und Warn-Dedup schon — Muster, das der Engine-Pfad jetzt übernimmt |
| `src/brokers/control-plane/secretScan.ts` | rekursiver `readFileSync`-Walk | nur in Build-/CLI-Skripten (`scripts/scan-secrets.ts`, `scripts/scan-live-gate-secrets.ts`), kein HTTP-Handler → kein Event-Loop-Risiko |
| `sync fs` in `src/cycle/*`, `src/history/migration.ts` | `readFileSync`/`writeFileSync` | Boot-/Artefakt-Pfade, keine Request-Pfade; keine API-Route importiert synchrone FS-Aufrufe (`grep` über `src/app/api` = 0 Treffer) |
| `PaperBroker.hydrate()` | synchrone Schleife über Zeilen | O( offene Positionen ), keine I/O; Zerkleinern hätte Zwischenzustände statt Nutzen gebracht |

## 4. Versionierung, Doku, CI

- **Version:** `1.36.36` → `1.36.37` (SemVer: abwärtskompatibler Fix, keine
  API-/Schema-Brüche, Index additiv).
- **CHANGELOG:** neuer Eintrag `## [1.36.37]` im kanonischen Root-`CHANGELOG.md`
  plus aktualisierter Status-Header (`docs/CHANGELOG.md` bleibt Stub).
- **READMEs:** Root-`README.md` (Dokumentationsstand, Audit-Tabelle) und
  `docs/README.md` (Versionszeilen, Struktur-Baum, Audit-Eintrag) — die
  Version ist an vier Stellen verbindlich und wird von
  `npm run docs:validate` (Check F) erzwungen.
- **Findings-Doku:** dieser Ordner (Status `FIXED`, Verweis auf Fix-Version
  und PR).
- **Betriebsdoku:** `docs/BROKER_ARCHITECTURE.md` (Ledger-Hydration),
  `docs/HANDBUCH.md` (Diagnosebild im Störungsfall).
- **CI:** `npm run typecheck`, `npm run lint`, `npm run docs:validate`,
  `npm test` lokal grün; die GitHub-Actions-Jobs `docs-validate` und
  `security-live-gate` laufen auf dem PR-Branch.
