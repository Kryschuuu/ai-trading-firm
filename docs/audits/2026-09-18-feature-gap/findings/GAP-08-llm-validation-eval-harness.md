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

## Umsetzung (v1.49.0, 2026-09-19)

- **D1 Plausibilitäts-Schicht:** `src/cycle/plausibility.ts` — läuft NACH
  der Schema-Validierung über Research-Setups (voll) und Makro-Output
  (Confidence/Begründung): Monotonie je Richtung (`MONOTONICITY`,
  LONG `stop < entry < tp` strikt, SHORT gespiegelt), Preisband
  (`PRICE_RANGE`, ± `PLAUSIBILITY_PRICE_BAND_PCT` 15 [1, 90], Kante
  inklusive, um den jüngsten Known-Good-Schlusskurs aus dem
  HistoricalStore), Confidence-Konsistenz (`RATIONALE_MISSING`,
  Confidence ≥ 0.9 verlangt ≥ `PLAUSIBILITY_MIN_RATIONALE_CHARS` 40
  [0, 1000] Zeichen, `0` = Regel aus), regex-basierter Zahlenbezug
  (`HALLUCINATED_PRICE`, genannte Kurse müssen in `[minLow, maxHigh]`
  liegen). Strukturierte Befunde `{code, field, detail}`; genau EIN Retry
  mit Fehlermeldungs-Kontext (`invokeAgent`-Befehl, Provider-Prompt
  ergänzt), danach deterministischer Skip (leerer Fallback +
  `CYCLE_STEP_SKIPPED` `plausibility:CODE` + sichtbarer `plausibility`-Block
  in `07-research.json`/`02-macro-analyst.json`); eskalierte Antworten
  werden mitgeprüft (ohne weiteres Retry); ohne Kerzen `referenceMissing`
  (sichtbar, nicht blockierend). Verdrahtet via `spec.plausibility`
  (`AgentInvocationSpec`, `ports.ts`); Heuristik-Grenzen dokumentiert
  (`docs/LLM_ROUTING.md` §17.1).
- **D2 Eval-Harness:** Golden-Dataset mit 12 Fixtures
  (`tests/fixtures/golden/<step>/*.json`), Offline-Default (Stub-Antworten,
  deterministisch, byte-identische Reports), JSON- + MD-Reports nach
  `data/eval/` (`EVAL_OUTPUT_DIR`/`--out-dir`, `resolveRuntimePath`),
  Exit 0/1/2 (bestanden/Regression/Fixture-Fehler), optionaler
  Provider-Rauchtest (`--provider`, nur mit explizitem Flag, Budget-Hinweis
  im Report); `npm run eval:prompts`; Pflege-HowTo im Fixture-README.
- **D3 Turn-Budget:** `src/routing/turnBudget.ts` — `TurnBudget` je
  Agenten-Turn (Hauptaufruf + Retries): `LLM_MAX_TOKENS_PER_TURN` (20000,
  [1000, 200000]) + `LLM_MAX_TURN_MS` (120000, [10000, 900000],
  Aufrufgrenzen-Prüfung). Überschreitung → `TurnBudgetExceededError` +
  Routing-Audit `llm-budget:tokens`/`llm-budget:time` (`budget_blocked`,
  Sicherheitsklasse); Fehler propagiert bis zur Step-Engine und wird NIE in
  einen Fallback umgewandelt. Tages-Deckel + Einzelaufruf-Limits
  unverändert.
- **Tests:** `tests/plausibility.test.ts` (25), `tests/turnBudget.test.ts`
  (9), `tests/evalPrompts.test.ts` (11) — Validator-Gut/Schlecht-Fälle,
  Retry-Policy, Eval-Determinismus (SHA-256-identisch), Budget-Brüche
  (Token + injizierte Zeit), Port-No-Fallback; bestehende
  Cycle-/Routing-Suites unverändert grün (182 Tests). Keine neue
  Runtime-Dependency.
- **Docs:** `docs/LLM_ROUTING.md` §8/§13/§17, `CONFIGURATION.md`-Sektion,
  `.env.example`-Flags, CHANGELOG 1.49.0.

**Offene Punkte (bewusst nicht in diesem Release):** Plausibilitäts-Regeln
für weitere Steps (Backtest/Schlussfolgerung nur Schema-geprüft);
Heuristik-(d)-Fehlbefunde bei Kennzahlen ohne Kursbezug (dokumentiert,
Ausnahmen `%`/Jahre/Wortbindung); Token-Zählung = gemeldeter
`routeChat`-Verbrauch (Provider-interne Retries unsichtbar); keine
qualitativen LLM-as-Judge-Scores (nur deterministische Regeln).
