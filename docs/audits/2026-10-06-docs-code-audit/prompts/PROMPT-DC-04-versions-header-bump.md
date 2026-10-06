# PROMPT DC-04 — Versions-/Status-Header auf Code-Stand bringen

```text
TASK: Behebe die Versions-Header-Drift der Fachdokumente.

BEFUND (Audit docs/audits/2026-10-06-docs-code-audit/findings/DC-04-versions-header-drift.md):
Von 45 Fachdokumenten mit "Stand/Version/Code-Version"-Angabe tragen nur 4 die
aktuelle Code-Version 0.17.2 (docs/README.md, PERPETUAL_DATA.md,
architecture/INTEGRATION_POINTS.md, roadmap/STATUS.md). 22 Dokumente stehen auf
der Beta-Baseline 0.1.0, weitere auf Zwischenständen bis 1.41.0
(architecture/DB_SCHEMA.md, BACKTEST_ENGINE.md, LLM_ROUTING.md, INDICATORS.md,
DOCS_VIEWER.md, EQUITY_CURVE.md, CLAUDE_TRADING_INDICATOR.md,
STRATEGY_VALIDATION.md, architecture/STRATEGY_STACK.md, UI_LAYOUT.md,
MARKET_DATA_PIPELINE.md, MISSIONS.md, ARCHITECTURE.md, STRATEGY_SCREENING.md).
Ein Teil der Architektur-Dokumente mischt zusätzlich die interne Legacy-Zählung
v1.x in die Titelzeile. Der CI-Check prüft nur CHANGELOG.md und docs/README.md
(scripts/docs-validate.ts, Check F).

DO:
1. Erzeuge zuerst eine Klassifikationsliste (Ausgabe im Prompt-Ergebnis, dann
   verarbeiten): für JEDES Dokument mit Versionsangabe entscheide
   (a) CODE-VERSION   -> Header beschreibt den Modulstand => auf die Version aus
       package.json setzen (Stand = Datum des tatsächlichen Abgleichs; wenn du
       den Inhalt nicht gegen den Code geprüft hast, NICHT auf 0.17.2 setzen,
       sondern (b) verwenden).
   (b) DOKUMENT-VERSION -> die Zahl ist eine eigene Vokabular-/Formatversion
       (z. B. PORTFOLIO_CONFIG_VERSION = 1; LLM_ROUTING.md nennt bewusst seine
       Policy-Version) => Header in "Dokument-Version" umbenennen, Zahl behalten.
   (c) BESTANDSDOKUMENT -> Inhalt nicht in dieser Session prüfbar => Header
       "Bestandsdokument · Stand <Datum> · Code-Version 0.17.2 (Beta) ·
       Vollabgleich offen" + Verweis auf DC-06-Finding.
   Für (b)/(c) gilt: keine Schein-Aktualität.
   Wichtig: Der falsche Anschein ist schlimmer als ein alter Stand. Wenn der
   letzte inhaltliche Nachweis zu einem Dokument fehlt, wähle (c).
2. Ersetze Legacy-Versionsnummern in den Titelzeilen ("(v1.41.0)") durch das
   öffentliche Schema; die interne Zählung darf höchstens als Klammer-Hinweis
   mit Verweis auf die Zuordnung in CHANGELOG.md stehen bleiben.
3. Prüfe, dass jedes Dokument GENAU EINEN Status-Header hat (nicht zwei, nicht
   widersprüchliche Angaben in Kopf und Fuß — Beispiel-Fund: docs/README.md
   hatte oben v0.17.2 und unten v0.2.0; Fuß wurde am 2026-10-06 korrigiert).
4. Aktualisiere danach den Abschnitt "Generierte/aktualisierte Dokumente" falls
   vorhanden NICHT — Doku-only-Änderung, kein Versions-Bump des Projekts.

HINWEIS: Ein automatisches Kürzen/Streichen von Dokumenten ist NICHT Teil des
Prompts. Es geht um die Kopfzeilen.

AKZEPTANZ:
- `python3 - <<'PY' ... PY`-Scan (siehe Finding DC-04, Verifikationsabschnitt)
  meldet 0 Dokumente mit falschem `Code-Version`-Header.
- `npm run docs:validate` grün (Check F bleibt grün, weil CHANGELOG.md und
  docs/README.md unverändert korrekt sind).
- Im Prompt-Ergebnis steht die vollständige Tabelle Dokument -> Klasse (a/b/c) ->
  neue Kopfzeile, damit der Reviewer die Entscheidungen nachvollziehen kann.
```

## Hinweise für die ausführende Session

- **Nicht** die `Stand`-Daten durch das heutige Datum ersetzen, ohne den Inhalt
  anzusehen — das erzeugt genau die Schein-Aktualität, die DC-04 beschreibt.
- `docs/audits/**` und `docs/archive/**` bleiben unangetastet (historische
  Dokumente; ihre Versionsangaben sind absichtlich alt).
- Wenn dir bei der Durchsicht weitere Kopfzeilen auffallen, die widersprüchliche
  Angaben enthalten, in die Liste aufnehmen (Scope-Erweiterung erlaubt, solange
  es nur Kopfzeilen sind).
