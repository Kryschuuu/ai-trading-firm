# PROMPT-00 — Gemeinsame Baseline der Verbesserungen-Serie

> Reviewer-Referenz. Jeder Prompt dieser Serie wiederholt die gesperrten
> Punkte, damit er eigenständig lesbar bleibt. Die Serie ist in `v0.2.0`
> umgesetzt; diese Datei ist keine neue Aufgabe.

## Repository-Kontext

Du arbeitest im TypeScript-/Next.js-Repository `Kryschuuu/ai-trading-firm`.
Prüfe Branch, Arbeitsbaum und Tests selbst. Die Audit-Basis der Prüfung war
`ba772cc`. Weicht der Code ab, übernimm die Absicht mit minimalem Scope.

## Nicht verhandelbar

1. `backtestRule` bleibt byte-identisch. Der gebührenfreie Pfad heißt
   `model=reference`.
2. `runMultiAssetBacktest` defaultet weiter auf `executionModel: "legacy"`.
3. Keine neue API-Route. Der Regel-Backtest bleibt
   `POST /api/firm/rules/[id]/backtest`.
4. Kein stilles Yahoo auf dem Paper-Pfad. Fehlende Kerzen sind 422.
5. `detectExit` wird nicht durch `detectExitTrigger` ersetzt.
6. Workshop-Schritt 5 speichert nur `DRAFT`. `activate` wird nicht gesendet.
7. Fail-closed: fehlende Historie ist nicht `0` und nicht ein erfundener Kurs.
8. Keine Secrets, keine neuen Vendor-Keys, keine zweite Datenquelle „auf Vorrat“.

## Pflicht vor Abschluss

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

Doku, `CHANGELOG.md` und `package.json` gehören in denselben PR. WONTFIX
bekommt keinen Umsetzungs-Prompt.
