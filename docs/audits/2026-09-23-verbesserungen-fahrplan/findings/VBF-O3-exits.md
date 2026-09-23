# VBF-O3 — Exits und Fill-Simulator existieren

- **Status:** VERIFIED
- **Audit-Punkt:** O3 „Stops und realistische Fills fehlen“

## Befund

Paper-Monitor und Mikro-Executor schließen über Stop, Take-Profit, Trailing
und Time-Stop. Fills laufen durch `FillSimulator`. Zwei Detektoren
(`detectExit`, `detectExitTrigger`) bleiben bewusst getrennt; ihre Parität
ist getestet (VBF-P3-01), nicht vereinheitlicht.

## Entscheidung

Kein Ersatz des Live-Detektors.
