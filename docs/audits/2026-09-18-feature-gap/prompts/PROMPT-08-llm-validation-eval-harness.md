# PROMPT-08 — LLM-Output-Validierung & Prompt-Eval-Harness (GAP-08)

> **Finding:** [GAP-08](../findings/GAP-08-llm-validation-eval-harness.md) ·
> **Reihenfolge:** Schritt 8 ·
> **Voraussetzungen:** keine harten ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: Plausibilitäts-Schicht über Agenten-Outputs + Golden-Dataset-
# Eval-Harness + Turn-Budget-Hartdeckel (GAP-08)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: src/cycle/schemas.ts validiert jede Step-Ausgabe
mit handgeschriebenen TS-Validatoren (bewusst OHNE Zod — Repo-Stil
beibehalten!). Prompt-Edits sind versioniert (Optimistic Locking), aber nicht
BEWERTET: ein „verbesserter“ Prompt kann Performance still ruinieren.
LLM_ROUTING hat Budget-Deckel. Ziele: (1) Plausibilitäts-Checks, die
Halluzinationen und Inkonsistenzen strukturiert abfangen, (2) ein
deterministischer Eval-Runner, der nach jedem Prompt-Edit Regressionen
zeigt, (3) ein Hartdeckel je Turn.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/cycle/schemas.ts (Validatoren je Step + Fehler-Stil),
src/cycle/engine.ts + steps/*.ts (WO Validierung greift, Retry-Verhalten),
src/routing/** (Budget-Deckel, Latenz-Messung), src/lib/llmProvider.ts +
ollama.ts (Provider-Schnittstelle — für den Stub-Modus), tests/cycle.steps.
test.ts + tests/cycle.architecture.test.ts + tests/routing.*.test.ts.
Erwartet laut Audit: Schema-Validierung ja, Plausibilitäts-Schicht nein,
Eval-Harness nein. Abweichung → Rest-Delta, im PR dokumentieren.

## Schritt 2 — Delta umsetzen

D1 PLAUSIBILITÄTS-SCHICHT (neu src/cycle/plausibility.ts, auf die
   Schema-Validierung NACHgeschaltet — valide Struktur ist Voraussetzung):
   - Maschinenprüfbare Regeln je Setup-/Entscheidungs-Output:
     (a) Monotonie je Richtung (LONG: stopLoss < entry < takeProfit; SHORT
     gespiegelt), (b) Preisnähe: entry/stop/tp innerhalb ±
     PLAUSIBILITY_PRICE_BAND_PCT (Default 15, Bounds [1, 90]) um den letzten
     Known-Good-Kurs der übergebenen Kerzen — fängt Kurs-Halluzinationen,
     (c) Konsistenz Confidence: außerhalb [0,1] bereits Schema; hier: sehr
     hohe Confidence ohne Begründung (rationale < PLAUSIBILITY_MIN_RATIONALE_CHARS,
     Default 40, Bounds [0, 1000]) → Befund, (d) Zahlenbezug: genannte
     Kurse im Begründungstext müssen innerhalb [minLow, maxHigh] der
     übergebenen Kerzen liegen (Halluzinations-Heuristik, regex-basiert
     Zahlen extrahieren — dokumentierte Grenzen dieser Heuristik).
   - Befund = strukturiertes {code, field, detail} (codes: PRICE_RANGE,
     MONOTONICITY, RATIONALE_MISSING, HALLUCINATED_PRICE, …).
   - Retry-Policy: max. 1 Retry mit Fehlermeldungs-Kontext an den Provider;
     danach deterministischer Fallback (Step skipped + audit_log
     „plausibility:CODE“ + sichtbarer DATA_UNAVAILABLE-artiger Zustand im
     Artefakt) — niemals still weiterrechnen.
D2 GOLDEN-DATASET + EVAL-RUNNER:
   - Fixtures tests/fixtures/golden/<step>/*.json: Eingabe (Kerzen-Auszüge,
     Provider-Response-Fixtures — synthetisch, NUR in tests/) + Erwartung
     (valid/invalid + erwartete codes).
   - Runner scripts/eval-prompts.ts: Offline-Modus (Default) mit gestubbtem
     Provider → führt Validierung + Plausibilitäts-Schicht über alle
     Fixtures aus, Report (JSON + MD) nach data/eval/ via
     resolveRuntimePath, Exit-Code != 0 bei Regression. Zwei Läufe →
     byte-identischer Report (Determinismus-Test). npm-Script
     „eval:prompts“ ergänzen.
   - Optionaler --provider-Modus (nutzt konfigurierten Provider, kostet
     Tokens): nur mit explizitem Flag + Budget-Hinweis im Report.
D3 TURN-BUDGET-HARTDECKEL: Bestehende Budget-Deckel der Routing-Schicht
   prüfen; Lücke schließen: LLM_MAX_TOKENS_PER_TURN (Default = bestehender
   Wert bzw. 20000, Bounds [1000, 200000]) + LLM_MAX_TURN_MS (Default
   120000, Bounds [10000, 900000]); Überschreitung → Turn sauber abbrechen
   mit strukturiertem Fehler + audit_log („llm-budget:tokens“), keine
   Teil-Results als Erfolg.

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only · Fail-closed (Befund → sichtbarer Skip, nie still) · KEINE neue
Runtime-Dependency — kein Zod/joi, Validatoren handgeschrieben im Stil von
src/cycle/schemas.ts · Schwellen mit Bounds + Default + Eintrag in
.env.example UND CONFIGURATION.md · keine Secrets (Provider-Keys berühren
die Fixtures nicht) · audit_log bei Skip/Budget-Bruch · Determinismus
(Offline-Eval ohne Netz) · Pflicht-Checks: npm run typecheck && npm run
lint && npm test && npm run docs:validate — 0 Failures (Ausnahme ENV-01) ·
CHANGELOG + Versions-Bump (package.json, Status-Header, docs/README.md) ·
nur dieses Delta; Neben-Bugs in „Offene Punkte“.

## Schritt 3 — Tests (neu tests/plausibility.test.ts + tests/evalPrompts.test.ts)

- Gut-Fälle: valide Setups passieren die Plausibilitäts-Schicht unverändert.
- Schlechtfälle je Code: Monotonie-Verstoß, Preis außerhalb Band,
  Halluzinierter Kurs (außerhalb [minLow, maxHigh]), leere Begründung +
  hohe Confidence → je korrekter {code, field}.
- Retry: erster Aufruf invalid, zweiter valid → genau ein Retry; beide
  invalid → Skip + audit_log + sichtbarer Zustand (kein Ergebnis-Export).
- Eval-Runner: alle Fixtures ausgewertet, Regression (kaputte Erwartung) →
  Exit != 0, zwei Läufe → identischer Report-Hash.
- Budget: Token-/Zeit-Bruch mit Fake-Provider → sauberer Abbruch + Audit.

## Schritt 4 — Docs & Meta

- docs/LLM_ROUTING.md oder docs/DAILY_WEEKLY_RESEARCH.md: Sektion
  „Plausibilitäts-Schicht & Eval-Harness“ (Regeln, Retry-Politik, Fixtures-
  Pflege-HowTo).
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat, Minor-Bump)
  + Status-Header + docs/README.md. TRACKING.md pflegen; Finding „Umsetzung“
  ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert; D1–D3 umgesetzt und je getestet
[ ] Repo-Stil der Validatoren beibehalten (keine Schema-Library)
[ ] Offline-Eval deterministisch (Hash-Test)
[ ] Flags in .env.example + CONFIGURATION.md
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig
```
