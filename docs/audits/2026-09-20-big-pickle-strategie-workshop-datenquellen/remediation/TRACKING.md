# Remediation-Tracking — 2026-09-20-big-pickle-strategie-workshop-datenquellen

> Status-SSoT dieses Auditzyklus. Einträge werden **erst** bei belegter
> Definition of Done (PR, Commit, Tests, Fix-Version) auf `FIXED` gesetzt.
> Quelle: LLM-Agent **Big Pickle** — Audit-Basis `7d8b07b` (`v1.51.3`).

| # | Befund | Status | Pr/Vesion | Commit | Tests | Fix-Version | Prompts |
|---|---|---|---|---|---|---|---|
| BP-01 | Regel-Engine: ADX/BBW/MACD als Regel-Felder | `OPEN` | — | — | — | — | [PROMPT-BP-01](../prompts/PROMPT-BP-01-rule-field-indikatoren.md) |
| BP-02 | Technical-Analyst: berechnete Indikatoren | `OPEN` | — | — | — | — | [PROMPT-BP-02](../prompts/PROMPT-BP-02-technical-analyst-berechnete-daten.md) |
| BP-03 | Workshop-Schritt „5 · Regel-Backtest“ + Export | `OPEN` | — | — | — | — | [PROMPT-BP-03](../prompts/PROMPT-BP-03-workshop-backtest-bruecke.md) |
| BP-04 | Workshop: Baseline/Prompt-Preview/Übungen | `OPEN` | — | — | — | — | [PROMPT-BP-04](../prompts/PROMPT-BP-04-workshop-baseline-prompt-preview.md) |
| BP-05 | Backtest/Live-Exit-Konsistenz (`decideExit`) | `OPEN` | — | — | — | — | [PROMPT-BP-05](../prompts/PROMPT-BP-05-backtest-live-exit-konsistenz.md) |
| BP-06 | Kostenmodell + Buy-&-Hold-Benchmark | `OPEN` | — | — | — | — | [PROMPT-BP-06](../prompts/PROMPT-BP-06-backtest-kosten-und-benchmark.md) |
| BP-07 | ATR-Stop (`atrStopK`) in der Regel-Sprache | `OPEN` | — | — | — | — | [PROMPT-BP-07](../prompts/PROMPT-BP-07-atr-stops-in-regeln.md) |
| BP-08 | Yahoo-Historik in den HistoricalStore | `OPEN` | — | — | — | — | [PROMPT-BP-08](../prompts/PROMPT-BP-08-yahoo-historik.md) |
| BP-09 | FRED-Makro-Feed | `OPEN` | — | — | — | — | [PROMPT-BP-09](../prompts/PROMPT-BP-09-fred-makro-feed.md) |
| BP-10 | Datenquellen-Evaluation + Polygon-env-gated | `OPEN` | — | — | — | — | [PROMPT-BP-10](../prompts/PROMPT-BP-10-datenquellen-integration.md) |

## Benutzung

1. Genau ein Prompt pro PR (Ausnahmen siehe `prompts/README.md`).
2. Reihenfolge: Welle 1 (BP-01, BP-08) → Welle 2 (BP-02, BP-06, BP-05) →
   Welle 3 (BP-07, BP-03, BP-04) → Welle 4 (BP-09, BP-10).
3. Pflichtgates vor `FIXED`: `npm run typecheck`, `npm run lint`,
   relevante Tests, `npm run docs:validate`; Doku +
   Root-`CHANGELOG.md` aktualisiert; PR/Branch/Commit/Version dokumentiert.
4. Abweichungen vom Akzeptanzvertrag: Finding/Prompt versioniert anpassen,
   nicht still umgehen.