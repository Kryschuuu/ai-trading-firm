# Umsetzungs-Prompts — nur für implementierte Punkte

Stand: umgesetzt in `v0.2.0`. Diese Dateien sind die Spezifikation der
Fixes, keine offenen Aufträge. WONTFIX-Befunde haben bewusst keinen Prompt.

Gemeinsame Regeln: [PROMPT-00](PROMPT-00-baseline.md).

Reihenfolge, in der gebaut wurde:

1. [P1.1 Kostenbewusster Regel-Backtest](PROMPT-VBF-P1-01-cost-aware-rule-backtest.md)
2. [P1.2 Workshop-Schritt 5](PROMPT-VBF-P1-02-workshop-step-5.md)
3. [P2.1 Trusted RSI/ATR/MACD](PROMPT-VBF-P2-01-trusted-indicators.md)
4. [P2.2 MACD-Regelfelder](PROMPT-VBF-P2-02-macd-fields.md)
5. [P2.3 Wilson und Prompt-Länge](PROMPT-VBF-P2-03-wilson-prompt-length.md)
6. [P3.1 Exit-Parität](PROMPT-VBF-P3-01-exit-parity.md)
7. [P3.2 75-%-Deckel-Warnung](PROMPT-VBF-P3-02-ceiling-warning.md)
8. [P3.3 Rohantwort kopieren](PROMPT-VBF-P3-03-copy-raw.md)

Nicht verhandelbar in allen acht Prompten: `backtestRule` bleibt
byte-identisch, der Engine-Default bleibt `"legacy"`, keine neue
API-Route, kein stilles Yahoo auf dem Paper-Pfad.
