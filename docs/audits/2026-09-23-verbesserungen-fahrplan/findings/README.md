# Befunde — Audit „Verbesserungen“ (2026-09-23)

Quelle: Big-Pickle-Audit „verbesserungen“ (2026-09-20). Die Datei
`docs/audits/2026-09-20-big-pickle-verbesserungen/AUDIT.md` liegt in diesem
Checkout nicht. Jeder Punkt unten ist gegen den Code von `ba772cc` geprüft
und in `v0.2.0` abgeschlossen (FIXED, VERIFIED oder WONTFIX).

Umsetzungs-Prompts gibt es nur für FIXED-Punkte:
[`../prompts/README.md`](../prompts/README.md).

| ID | Status | Kurz |
| --- | --- | --- |
| [VBF-O1](VBF-O1-rule-fields.md) | VERIFIED | Whitelist, Ceilings, `evaluateRule` sind da |
| [VBF-O2](VBF-O2-walk-forward.md) | VERIFIED | Walk-Forward, Ledger, Funding, CLI |
| [VBF-O3](VBF-O3-exits.md) | VERIFIED | SL/TP/Trailing/Time-Stop, Fill-Simulator |
| [VBF-O4](VBF-O4-mtf.md) | VERIFIED | MTF-Konfluenz, nicht drei getrennte Strategien |
| [VBF-O5-kfold](VBF-O5-kfold.md) | WONTFIX | K-Fold würde Zeitreihen leaken |
| [VBF-O5-ulcer](VBF-O5-ulcer.md) | WONTFIX | Ulcer ist Kosmetik neben MaxDD |
| [VBF-O6](VBF-O6-regime-field.md) | WONTFIX | Eigenes Regel-Feld wäre ein zweites Regime-System |
| [VBF-P1-01](VBF-P1-01-cost-aware-rule-backtest.md) | FIXED | Paper-Default auf der bestehenden Route |
| [VBF-P1-02](VBF-P1-02-workshop-step-5.md) | FIXED | Workshop-Schritt 5, nur DRAFT |
| [VBF-P2-01](VBF-P2-01-trusted-indicators.md) | FIXED | Code überschreibt RSI/ATR, MACD im Block |
| [VBF-P2-02](VBF-P2-02-macd-fields.md) | FIXED | `macd` / `macdSignal` / `macdHistogram` |
| [VBF-P2-03](VBF-P2-03-wilson-prompt-length.md) | FIXED | Wilson-Intervall und 2000-Zeichen-Warnung |
| [VBF-P3-01](VBF-P3-01-exit-parity.md) | FIXED | Paritätstest `detectExit` vs. `detectExitTrigger` |
| [VBF-P3-02](VBF-P3-02-ceiling-warning.md) | FIXED | Warnung ab 75 % des Positionsdeckels |
| [VBF-P3-03](VBF-P3-03-copy-raw.md) | FIXED | Rohantwort in den Editor, kein Autosave |
| [VBF-W2](VBF-W2-binomial.md) | WONTFIX | Binomial wäre ein zweites Unsicherheitsmaß |
| [VBF-W4](VBF-W4-history.md) | WONTFIX | Prompt-Historie ohne Lesepfad |
| [VBF-D-yahoo](VBF-D-yahoo.md) | WONTFIX | Kein stilles Yahoo auf dem Paper-Pfad |
| [VBF-D-polygon](VBF-D-polygon.md) | WONTFIX | Kein neuer Vendor ohne Vertrag |
| [VBF-D-fred](VBF-D-fred.md) | WONTFIX | Makrodaten sind kein OHLCV-Adapter |
| [VBF-D-finnhub](VBF-D-finnhub.md) | WONTFIX | Kein zweiter News-Vendor in diesem Schnitt |
| [VBF-D-av](VBF-D-av.md) | WONTFIX | Alpha Vantage ersetzt keine bestehende Quelle |
| [VBF-P-arena](VBF-P-arena.md) | WONTFIX | Prompt-Generator ist kein Produktfeature |
| [VBF-A-agents](VBF-A-agents.md) | WONTFIX | AGENTS.md-Edits ändern kein Verhalten |
| [VBF-engine-default](VBF-engine-default.md) | WONTFIX | Engine-Default bleibt `"legacy"` |
| [VBF-live-exit](VBF-live-exit.md) | WONTFIX | Live-`detectExit` wird nicht ersetzt |
