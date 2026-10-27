# PROMPT-BP-04 — Workshop: Baseline-Vergleich, Prompt-Preview und Übungseinheit

## Auftrag

Verbessere den Lernpfad des Workshops im Repository `Kryschuuu/ai-trading-firm`
um drei gezielte Bausteine: **Baseline-Vergleich/Signifikanz** im
Hit-Rate-Panel, **Prompt-Preview** des realen System-Prompts und eine
**abschaltbare Übungseinheit** „Erste Schritte“. Der Prompt ist eigenständig;
Audit-Basis war Commit `7d8b07b` (`v1.51.3`). Bei Code-Abweichung adaptiere
minimal und vermerke sie im PR.

Zugehöriger Befund: [`../findings/BP-04-workshop-baseline-prompt-preview.md`](../findings/BP-04-workshop-baseline-prompt-preview.md)
Priorität/Schwere: **MEDIUM**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- `src/components/workshop/HitRatePanel.tsx` zeigt Verteilungskategorien, aber
  keinen Vergleich zur Baseline-Vorlage `baseline-hold` und keine
  Stichproben-Warnung (n < 30).
- `src/components/workshop/PromptPanel.tsx` zeigt editierbaren Prompt, aber
  keinen Ausschnitt der realen System-Prompt-Zeilen
  (`MISSION:`/`SEGMENT:`/`UNIVERSUM:`-Blöcke), die `src/lib/missionUniverse.ts`
  baut.
- Die Pädagogik besteht aus Handbuch-Kapiteln + Feldhilfe
  (`docs/help/workshop.help.json`, 3 Ebenen); es gibt keine interaktiven
  Übungen oder Before/After-Prompt-Beispiele.

## Zielzustand

Ein Nutzer sieht sofort, wie gut seine Mission relativ zur `baseline-hold`-
Basis steht und ab wann die Stichprobe aussagekräftig ist; er sieht beim
Iterieren exakt die Prompt-Zeilen, die der Agent real bekommt; wahlweise führt
ihn eine Übungseinheit in drei Schritten durch die Iterationslogik.

## Vor Beginn gezielt prüfen

- `src/components/workshop/HitRatePanel.tsx`, `PromptPanel.tsx`,
  `WorkshopTab.tsx`, `AgentRunPanel.tsx`
- `src/lib/workshop.ts` (Hit-Rate-Aggregation, Kategorien)
- `src/lib/missionUniverse.ts` (Prompt-Zeilen-Bau), `src/lib/engine.ts`
  (System-Prompt-Aufbau, ggf. Legacy)
- `docs/help/workshop.help.json` (Feld-IDs)
- bestehende UI-Tests (`test/ui/`)

## Verbindlicher Implementierungsumfang

1. **Baseline/Delta:** Im HitRatePanel `baseline-hold` als Referenzmission
   anbieten (gleiche Aufgabe, SPY-Hold); Delta-Trefferquote plus
   Stichproben-Warnung „n < 30“ mit Hinweistext; Verteilungszählung unverändert.
2. **Prompt-Preview:** lesbaren Block mit den ersten Zeilen der realen
   MISSION-/SEGMENT-/UNIVERSUM-Zeilen rendern — **aus derselben Quelle** wie
   der tatsächliche Prompt (kein Duplikat der Prompt-Logik); Treffer
   `MISSION_SCOPE_VIOLATION`-Hinweise an den sichtbaren Block knüpfen.
3. **Übungseinheit:** optionaler, abschaltbarer Schritt „Erste Schritte“ mit
   drei Übungen:
   - A: prüfbare Mission bauen (Checkliste: ≥1 Zahl, Abbruchkriterium,
     Stop-Band) mit Live-Feedback der Soft-Warnungen;
   - B: Fehler im Prompt finden (3 Snippets; korrekt auf JSON-Hinweis, Länge,
     Scope),
   - C: A/B-Prompt-Vergleich (gleiche Mission, zwei Varianten, Trefferzahlen
     nebeneinander).
4. **Kein neuer Zustandsspeicher:** Übungszustand lokal im Workshop-Tab.

## Explizit nicht Teil dieses Changes

- kein neuer Backtest-/Exportschritt (siehe PROMPT-BP-03)
- keine Änderung der Engine-/Prompt-Inhalte selbst (nur deren Anzeige)
- kein entfernbares Shared-Settings-Feature

## Produktions- und Sicherheitsregeln

- Anzeige des System-Prompts darf **keine Secrets/Tokens** enthalten —
  vor dem Rendern maskieren; Test, der das sicherstellt.
- Externe Texte bleiben Daten; die Anzeige erzeugt keine Prompt-Instruktion.
- UI-Zustände fail-soft: leerer Store, fehlende Mission ⇒ lesbarer Zustand.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.
- Keine Regression der bestehenden 4 Schritte.

## Pflicht-Tests

- [ ] Baseline-Delta korrekt für n = 1 … 50 (Handwerte)
- [ ] Warnung „n < 30“ erscheint/verschwindet an den Grenzen
- [ ] Prompt-Preview maskiert Secrets; zeigt niemals Tokens
- [ ] Übungen A/B/C haben deterministische Bewertungslogik (Snippets fix)
- [ ] UI-Tests (`test/ui/`) decken Leerzustand und A/B-Vergleich ab
- [ ] bestehende Workshop-Tests grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Baseline-, Warnungs- und Preview-Funktionen sind in der UI sichtbar und
      in Tests belegt.
- [ ] Übungseinheit ist optional und ohne zusätzliche Secrets nutzbar.
- [ ] kein Verhaltensbruch der Schritt-Navigation.

## Dokumentation, Versionierung und Tracking

1. `docs/HANDBUCH.md` (Workshop-Kapitel) um Baseline-/Warnungskonzept und die
   Übungseinheit ergänzen.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, implementierte Lernpfad-Bausteine, Kompatibilitätshinweise,
ausgeführte Tests mit Ergebnis, verbleibende Risiken sowie Commit-/PR-Link.