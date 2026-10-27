# BP-04: Workshop ohne Baseline-Vergleich, Prompt-Preview und Übungen

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-04`](../prompts/PROMPT-BP-04-workshop-baseline-prompt-preview.md)

## Verifizierte Fundstellen

- `docs/help/workshop.help.json:87` — warnt korrekt „Eine hohe TRADE-Quote ist
  kein Erfolg“, aber `src/components/workshop/HitRatePanel.tsx` bietet keinen
  Vergleich zur vorhandenen Baseline-Vorlage (`baseline-hold`, Missionen-
  Katalog) und keine Stichproben-Warnung.
- `src/components/workshop/PromptPanel.tsx` — kein sichtbarer Ausschnitt des
  realen System-Prompts (`MISSION:`/`SEGMENT:`/`UNIVERSUM:`-Blöcke), obwohl
  `src/lib/missionUniverse.ts` genau diese Zeilen baut.
- Keine interaktiven Übungen (Before/After-Prompts, Fehler-Beispiele) im
  Workshop; die pädagogische Schleife bleibt auf Handbuch-Text beschränkt.

## Bewertung und Abgrenzung

Die Feldhilfe ist inhaltlich stark (3 Ebenen, `MISSIONS.md`), aber die UI gibt
dem Nutzer keine Kalibrierung: „Was ist eine gute Trefferquote bei n=10?“ Eine
Baseline-Mission (`baseline-hold`) existiert bereits als Messwerkzeug, wird aber
nicht angebunden. Prompt-Iteration bleibt Blackbox — Scope-Verstöße
(`MISSION_SCOPE_VIOLATION`) sind nicht am tatsächlichen Prompt nachvollziehbar.

## Konkretes Delta

- `HitRatePanel.tsx`: Baseline-Delta gegen `baseline-hold` (gleiche Mission),
  Signifikanz-/Warnzustände (n < 30), Export als JSON.
- `PromptPanel.tsx`: lesbarer System-Prompt-Ausschnitt (erste Zeilen der
  MISSION-/SEGMENT-/UNIVERSUM-Blöcke), gerendert aus `missionUniverse.ts`.
- Übungseinheit „Erste Schritte“: 3 Übungen (prüfbare Mission bauen; Fehler im
  Prompt finden; A/B-Prompt-Vergleich) mit fester Checkerlogik.
- Tests: Rendering/Leerzustand, Kein-Secret-Leak, Baseline-Berechnung mit
  n=1 bis n=50.

## Akzeptanzkriterien für `FIXED`

- [ ] Baseline-Delta und n-basierte Warnung sind ins Hit-Rate-Panel integriert.
- [ ] Prompt-Preview zeigt exakt die Zeilen, die der Agent sieht (gleiche Quelle).
- [ ] Übungseinheit ist optional abwählbar und ohne zusätzliche Secrets nutzbar.
- [ ] Pflichtgates grün; UI-Tests (`test/ui/`) erweitert.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: Komponenten- und Help-JSON-Pfadprüfung.