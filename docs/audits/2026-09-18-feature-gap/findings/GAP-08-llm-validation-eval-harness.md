# GAP-08 — LLM-Output-Validierung & Prompt-Eval-Harness

**Nutzen:** ★★★★ · **Aufwand (Co-Audit):** 🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧🔧
**Kategorie:** Qualität · **Prompt:** [`PROMPT-08`](../prompts/PROMPT-08-llm-validation-eval-harness.md)

## Befund (Co-Audit)

Prompt-Edits sind versioniert, aber nicht *bewertet* — ein „verbesserter“
Prompt kann Performance still ruinieren. Schutz vor Halluzinationen (Agent
nennt Kurse, die es nicht gibt). Kleine lokale Modelle halten Schemata
schlechter ein → Fallback-Logik nötig.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/cycle/schemas.ts` validiert jede Step-Ausgabe mit handgeschriebenen
  TS-Validatoren — bewusst **ohne** Zod (keine neue Runtime-Dep; Repo-Stil
  beibehalten, keine Schema-Library importieren).
- `LLM_ROUTING` hat Budget-Deckel + Eskalation; Prompt-Edits sind versioniert
  (Optimistic Locking, W2-Fix).
- **Aber:** keine Plausibilitäts-Schicht (Confidence vs. Begründungsqualität,
  Richtung vs. genannte Indikatoren, Kurs-Halluzinationen vs. Datenlage),
  kein Golden-Dataset, kein Eval-Runner, Turn-Budget-Lücken möglich.

## Delta

1. Plausibilitäts-Validatoren über der Schema-Schicht (Zahlenbereiche,
   Confidence/Konsistenz-Heuristiken, Kursbezug vs. letzter Known-Good-Kurs)
   mit strukturierter Ablehnung + begrenzter Retry-Policy (max. 1 Retry,
   danach deterministischer Fallback).
2. Golden-Dataset (`tests/fixtures/golden/`) mit historischen Situationen +
   Eval-Runner als CLI (`scripts/eval-prompts.ts`): deterministischer
   Offline-Modus (gestubbter Provider) für Schema-/Plausibilitäts-Regression
   nach Prompt-Änderungen; optionaler Live-Modus gegen konfigurierten Provider.
3. Token-/Latenz-Hartdeckel je Turn prüfen und Lücken schließen (Audit bei
   Überschreitung).

## Akzeptanzkriterien (kurz)

Validator-Gut/Schlecht-Fälle, Retry-Policy-Test, Eval-Runner deterministisch
(zwei Läufe → identischer Report), Budget-Test, keine neue Runtime-Dep.
