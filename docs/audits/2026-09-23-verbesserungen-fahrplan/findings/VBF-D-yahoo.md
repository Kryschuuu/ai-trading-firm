# VBF-D-yahoo — Stilles Yahoo auf dem Paper-Backtest

- **Status:** WONTFIX
- **Audit-Punkt:** Datenquellen, Yahoo als Fallback

## Befund

Der Paper-Pfad des Regel-Backtests darf keine zweite Quelle erfinden.
Fehlende Kerzen sind 422. Yahoo bleibt, wo es schon als öffentlicher Feed
verdrahtet ist — nicht als stiller Lückenfüller dieser Route.

## Entscheidung

Kein Prompt. Der Test verbietet den Aufruf auf dem Paper-Pfad.
