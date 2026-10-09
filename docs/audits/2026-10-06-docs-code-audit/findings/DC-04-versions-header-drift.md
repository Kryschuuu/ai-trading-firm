# DC-04 — Versions-/Status-Header: nur 4 von 45 Dokumenten auf Code-Stand

- **ID:** DC-04
- **Severity:** MEDIUM
- **Bereich:** Doku-Wahrheit / Release-Prozess
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Headerscan über alle Fachdokumente
- **Status:** ☑ **FIXED** (2026-10-09, PR [#236](https://github.com/Kryschuuu/ai-trading-firm/pull/236))
- **Prompt:** [`../prompts/PROMPT-DC-04-versions-header-bump.md`](../prompts/PROMPT-DC-04-versions-header-bump.md)
- **Datei(en):** 41 Fachdokumente unter `docs/**` (ohne `audits/`, `archive/`, `help/`)

## Beschreibung

Von 45 Dokumenten mit „Stand/Version/Code-Version"-Angabe tragen nur **4** die
aktuelle Code-Version `0.17.2`: `docs/README.md`, `PERPETUAL_DATA.md`,
`architecture/INTEGRATION_POINTS.md`, `roadmap/STATUS.md`.

**22 Dokumente** stehen wortgleich auf der Beta-Baseline `0.1.0` (u. a.
`LIVE_TRADING.md`, `BROKER_ARCHITECTURE.md`, `CAPABILITIES.md`,
`ERROR_HANDLING_MARKETDATA.md`, `MONTE_CARLO.md`, `POST_ONLY_FALLBACK.md`,
`MARKET_UNIVERSE.md`, `REPOSITORY_STRUCTURE.md`, `HISTORY.md`,
`OPERATIONS.md`, `OBSERVABILITY.md`, `FEATURE_STORE.md`, `ALPACA.md`,
`BITUNIX.md`, `DEVILS_ADVOCATE.md`, `FRONTEND_CONTROL_PLANE.md`,
`HOWTO_UPDATE.md`, `SETUP_BUGS.md`, `DOCS_SYNC_AUDIT.md`, `ARENA_TASKS.md`,
`OPERATIONS_CENTER.md`, `architecture/PIPELINE_MAP.md`), weitere auf
Zwischenständen bis `1.41.0` (`architecture/DB_SCHEMA.md`,
`BACKTEST_ENGINE.md`) und `1.22.0` (`LLM_ROUTING.md`).

Dazu mischt ein Teil der Architektur-Dokumente die interne Legacy-Zählung
`v1.x` mit dem öffentlichen Schema `v0.x` (u. a. Titelzeilen
`PIPELINE_MAP.md`: „(v1.41.0)", `DB_SCHEMA.md`: „(v1.41.0)").

## Ursache (warum das nicht auffällt)

`npm run docs:validate` prüft die Version nur an drei Stellen
(`scripts/docs-validate.ts`, Check F): oberster `## [x.y.z]`-Eintrag und
Status-Header von `CHANGELOG.md`, Versionszeile in `docs/README.md`. Die
Header der übrigen 44 Dokumente sind **nicht** Teil des Checks — Drift ist
damit unsichtbar, obwohl `CONTRIBUTING.md` das Aktualisieren der Header
ausdrücklich verlangt („Status-Header jeder Doku-Datei aktualisieren, wenn sich
das Modul ändert").

## Wirkung

Ein Leser kann nicht unterscheiden, ob ein Dokument den Zustand von `v0.1.0`
(2026-09-23) oder von `v0.17.2` (2026-10-05) beschreibt. Besonders schädlich
bei Sicherheits-/Betriebsdokumenten (`LIVE_TRADING.md`, `CAPABILITIES.md`,
`BROKER_ARCHITECTURE.md`), weil dort Aussagen über Freigaben und Venue-Fähigkeiten
getroffen werden, die sich seither geändert haben (siehe DC-03/DC-06).

## Lösungsvorschlag (Prompt DC-04)

1. **Klassifizieren** statt blind bumpen: pro Dokument prüfen, ob der Header die
   *Code-Version des zuletzt verifizierten Modulstands* meint (dann auf `0.17.2`
   setzen, wenn der Abgleich stattgefunden hat) oder eine *dokumenteigene
   Vokabular-/Formatversion* (z. B. `PORTFOLIO_CONFIG_VERSION = 1`,
   `LLM_ROUTING.md` „v1.22.0" = interne Zählung). Für Letztere einen anderen
   Header („Dokument-Version") verwenden — sonst kollidiert die Angabe mit
   `package.json`.
2. **Legacy-Versionsangaben in Titeln** auf das öffentliche Schema umstellen und
   die interne Zählung nur noch als Klammer-Hinweis führen
   (Zuordnungstabelle existiert in `CHANGELOG.md`).
3. **Kein Blind-Bump ohne Abgleich:** Dokumente, die inhaltlich nicht gegen
   `v0.17.2` geprüft wurden, bekommen den Header „Bestandsdokument · Stand
   <Datum> · Vollabgleich offen (DC-06)" statt einer falschen Aktualität.
4. Optional (empfohlen, gehört zu DC-09): Bump-Skript im Release-Schritt, das
   alle `Code-Version`-Header aus `package.json` synchronisiert.

## Verifikation nach Umsetzung

```bash
python3 - <<'PY'
import os,re
cur="0.17.2"; bad=[]
for dp,dn,fn in os.walk("docs"):
    if "/archive" in dp or "/audits" in dp: continue
    for f in fn:
        if not f.endswith(".md"): continue
        t=open(os.path.join(dp,f),encoding="utf-8").read()[:2000]
        m=re.search(r'Code-Version[:\*\s]*\**\s*`?v?(\d+\.\d+\.\d+)',t)
        if m and m.group(1)!=cur: bad.append((os.path.join(dp,f),m.group(1)))
print(len(bad),"Header ohne Code-Stand",cur); [print(" ",*b) for b in bad]
PY
```

Erwartung: nur noch 0 Treffer bzw. ausschließlich Dokumente mit
ausgewiesenem „Dokument-Version"-Header.

## Umsetzung

- **Status:** ☑ **FIXED** am 2026-10-09
- **PR:** [#236](https://github.com/Kryschuuu/ai-trading-firm/pull/236) „docs(DC-04): Versions- und Status-Header klassifizieren (doc-only, kein Bump)“ — gemergt am 2026-10-08, Commit `977e0bc`, Merge `3123920` auf `main`
- **Umfang:** nur Dokument-Kopfzeilen und Titelzeilen; kein Code, kein Versions-Bump (`package.json` bleibt `0.17.2`)
- **Vorgehen:** Klassifikation (a/b/c) nach `PROMPT-DC-04`. Stand-Daten wurden nicht durch das heutige Datum ersetzt (z. B. `DB_SCHEMA.md` bleibt „Stand 2026-09-18“). Legacy-Zählung in Dokumenttiteln nur noch als Klammerhinweis mit Verweis auf die Zuordnung in `CHANGELOG.md`.

### Klassenübersicht (Stand 2026-10-09)

| Klasse | Anzahl | Kopfzeile | Beispiele |
|--------|--------|-----------|-----------|
| (a) CODE-VERSION, verifiziert | 3 | `Code-Version: v0.17.2` | `PERPETUAL_DATA.md`, `architecture/STRATEGY_STACK.md`, `roadmap/STATUS.md` |
| (b) DOKUMENT-VERSION | 3 | „Dokument-Version“ bzw. „Review-Version“ (Zahl bleibt) | `MIGRATION_TIMEFRAME_FIELD.md`, `PORTFOLIO_ANALYTICS.md`, `peer-reviews/2026-08-26-routing-overrides/review.md` |
| (c) BESTANDSDOKUMENT | 63 | „Bestandsdokument · Stand … · Code-Version v0.17.2 (Beta) · Vollabgleich offen“ mit Verweis auf DC-06/DC-07 | `LIVE_TRADING.md`, `CAPABILITIES.md`, `architecture/DB_SCHEMA.md`, `LLM_ROUTING.md` |

Zusätzlich trägt `docs/README.md` die Versionszeile im Fuß mit `v0.17.2` (unverändert korrekt).

Hinweis zur Einstufung: `architecture/INTEGRATION_POINTS.md` stand im Befund als korrekt auf `0.17.2`. Im Diff von PR #236 ist die Kopfzeile jetzt als (c) „Bestandsdokument“ markiert, weil kein erneuter Abgleich gegen den Code stattfand. Das entspricht Regel 3 („keine Schein-Aktualität“).

### Verifikation

| Prüfung | Ergebnis |
|---------|----------|
| Header-Scan (Abschnitt „Verifikation nach Umsetzung“) | 66 Treffer mit `Code-Version`, **0** mit falschem Code-Stand (≠ `0.17.2`) |
| `npm run docs:validate` | grün (9 Checks, 10 Hilfe-Dateien, Exit 0) |
| Dokumenttitel (H1) | Legacy-Zählung nur noch als Klammerhinweis, z. B. `PIPELINE_MAP.md`: „(v0.1.0 · Legacy-Zählung v1.41.0 — Zuordnung: CHANGELOG.md)“ |

### Bewusst offen (nicht Teil von DC-04)

- **Abschnittsüberschriften mit `v1.x`:** 82 Überschriften (`##` und tiefer) in 22 Dokumenten nennen weiterhin historische Task-Versionen (z. B. `ARCHITECTURE.md` §8–11, `ARENA_TASKS.md`). Sie sind Task-Bezeichnungen und keine Dokumenttitel. Ein Umbau würde Anker und Links ändern. Entscheidung offen, ggf. im Rahmen von DC-09.
- **`DOCS_SYNC_AUDIT.md`:** Die Aussage „0 offene Diskrepanzen“ bezieht sich auf die Code-Behauptungen zum Stand 2026-08-29 und wurde durch DC-04 nicht geändert. Ein datierter Nachtrag steht im Dokument.
- **CHANGELOG:** Eintrag unter `[Unreleased]` → „Changed“ (von `CONTRIBUTING.md` verlangt).
