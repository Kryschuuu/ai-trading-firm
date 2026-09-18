# PROMPT-00 — Baseline (Pflicht-Präfix für alle Sessions der Serie)

> **Verwendung:** Diesen Block **über** den jeweiligen `PROMPT-XX`-Block
> einfügen. Alle nummerierten Prompts enthalten die Baseline bereits in
> Kurzform — dieser Volltext ist für Sessions, die mehr Kontext vertragen,
> und als Nachschlag für Reviewer.

## Session-Prompt

```text
Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ — einem
autonomen KI-Trading-System (Paper-Trading), Node.js 20+/TypeScript strict,
Next.js 16, Drizzle ORM + PostgreSQL, Tests mit node:test (NICHT jest/vitest),
Docs-as-Code mit `npm run docs:validate`. Die volle Feature-Gap-Analyse liegt
in docs/audits/2026-09-18-feature-gap/ (report.md = Ursprung, findings/ =
je Lücke, remediation/TRACKING.md = Status-SSoT).

Diese Session implementiert GENAU EIN Delta daraus (steht im nachfolgenden
Aufgabenblock) — nichts mehr, nichts weniger. Es gelten ohne Ausnahme:

REGELN (hart, nicht verhandelbar)

R1  PAPER-ONLY: Keine Änderung am Live-Trading-Pfad oder an der Enforcement-
    Logik von src/live-gate/**; der Live-Modus bleibt hart verriegelt.
    Notfall-Pfade (Kill-Switch, EmergencyBroker) darfst du NUTZEN, nicht
    umbauen.
R2  FAIL-CLOSED: Fehlende, fehlerhafte oder stale Daten führen zu einem
    sichtbaren UNKNOWN-/DATA_UNAVAILABLE-Zustand mit konservativem Verhalten —
    niemals ein stiller Fallback, niemals synthetische/erzeugte Daten in
    Produktionspfaden (synthetische Fixtures ausschließlich unter tests/).
    Muster: adaptiveRisk UNKNOWN-Zustand (v1.36.21), MDERR-Taxonomie
    (src/marketdata/dataErrors.ts).
R3  KEINE NEUEN RUNTIME-DEPENDENCIES ohne zwingenden technischen Grund +
    ausdrückliche Begründung im PR. Validatoren im Repo-Stil handgeschrieben
    (Muster: src/cycle/schemas.ts). Kein Zod/joi/valibot.
R4  LIMITS & FLAGS: Jeder neue Schwellenwert bekommt Bounds (Muster:
    LIMIT_CEILINGS in src/lib/riskGuard.ts), einen sicheren Default und wird
    als Env-Flag in .env.example UND CONFIGURATION.md dokumentiert (Name im
    UPPER_SNAKE-Stil der Datei). Flags ohne Docs gelten als nicht umgesetzt.
R5  SECRETS: Keine Credentials/Tokens in Code, Logs, Tests, Docs oder
    Fixtures. Neue Credentials ausschließlich über die bestehende
    Secret-Store-Infrastruktur (src/brokers/control-plane/secretStore.ts).
R6  AUDIT: Jede Mutation (Order, Exit, Kill-Switch, Risiko-Änderung) bleibt
    revisionssicher im audit_log; Ablehnungsgründe maschinenlesbar im Schema
    „kategorie:detail“ (Muster: „position-size:max-25%-of-equity“).
R7  DATENBANK: Migrationen bevorzugt append-only (ADD COLUMN / neue Tabellen),
    SQL-Datei nach Konvention in drizzle/ (YYYY-MM-DD_<kurzname>.sql), Schema
    in src/db/schema.ts pflegen; bestehende Tests dürfen nicht brechen.
R8  DETERMINISMUS: Gleiche Eingaben → gleiche Ausgaben. Kein Date.now()/
    Math.random() in getesteter Fachlogik ohne injizierbare Clock (Muster:
    src/cycle/clock.ts). Zeit- und Zufallsquellen als Parameter.
R9  TESTS: Neue Datei tests/<thema>.test.ts im node:test-Stil (Muster der
    Nachbar-Tests lesen). Pflicht vor dem PR:
      npm run typecheck && npm run lint && npm test && npm run docs:validate
    Ergebnis: 0 Failures. Bekannte, dokumentierte Ausnahme: der
    Test-Isolation-Befund ENV-01 in tests/secretStore.test.ts (siehe
    remediation/TRACKING.md) zählt als Umweltartefakt, wenn und nur wenn
    unter DATABASE_URL eine erreichbare DB liegt — im Testbericht nennen,
    nicht umgehen.
R10 DOCS-SYNC: CHANGELOG.md erhält oben einen Eintrag im Hausformat
    (## [x.y.z] — Datum · type(scope): Zusammenfassung) mit Abschnitten
    Hinzugefügt/Geändert/Fixiert nach Bedarf; Versions-Bump in package.json
    UND Status-Header von CHANGELOG.md UND docs/README.md (die Konsistenz
    wird von tests/docsVersioning.test.ts + docs:validate geprüft — SemVer
    begründen: feat → minor, fix/docs → patch). Betroffene docs/*.md
    aktualisieren, neue Docs in die Tabelle docs/README.md und bei
    Dashboard-Sichtbarkeit in src/lib/docsCatalog.ts eintragen.
R11 SCOPE-DISZIPLIN: Neben-Bugs, die du findest, werden im PR unter „Offene
    Punkte“ dokumentiert — nicht still mitfixiert. Ausnahme: direkte
    Regressionen deines Deltas.
R12 KEINE BEHAUPTUNG OHNE BELEG: Jeder „implementiert“-Punkt hat Code + Test.
    Der PR-Testbericht nennt ausgeführte Befehle und Ergebniszahlen
    (Tests gesamt/bestanden/fehlgeschlagen).

ARBEITSWEISE

A1  VERIFIKATION ZUERST: Lies zuerst die im Aufgabenblock genannten Dateien
    vollständig. Der beschriebene Ist-Stand stammt aus dem Audit vom
    2026-09-18 — prüfe ihn gegen den aktuellen Code. Abweichungen → im PR
    dokumentieren und nur das verbleibende Delta umsetzen.
A2  Wenn eine Voraussetzung des Deltas fehlt (z. B. ein abhängiger Prompt
    wurde noch nicht umgesetzt): abbrechen statt improvised bauen — im PR
    begründen und TRACKING.md auf IN_PROGRESS mit Blocker-Notiz setzen.
A3  Commits im Conventional-Commits-Stil (feat/fix/docs/test/refactor(scope):
    …), PR-Beschreibung mit: Motivation (GAP-XX-Link), Umsetzung (je
    Anforderung R-Punkt), Testbericht, Docs-Sync-Liste, Offene Punkte.
A4  Aktualisiere im selben PR remediation/TRACKING.md (Status, Version,
    PR) und ergänze im findings/GAP-XX-*.md einen kurzen „Umsetzung“-
    Abschnitt mit den wichtigsten Datei-/Testpfaden.

Wenn alle Punkte erfüllt sind, erstelle den PR. Halte dich an den
Aufgabenblock — bei Konflikten zwischen Aufgabenblock und diesen Regeln
gelten die Regeln (R1–R12), und der Konflikt wird im PR dokumentiert.
```

## Hinweise für Reviewer

- Der Block ist bewusst dupliziert in jedem `PROMPT-XX` (Kurzfassung) —
  Prompts müssen ohne diesen Präfix-Copy funktionieren, weil Sessions oft
  nur einen Block bekommen.
- Änderungen an der Baseline → alle zehn Prompt-Dateien synchron anpassen
  (grep nach „R1  PAPER-ONLY“).
