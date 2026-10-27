# Audit 2026-09-20 — Strategien, Workshop & Datenquellen (Quelle: Big Pickle)

**Quelle:** Externer, codebasierter Audit durch den LLM-Agenten **Big Pickle**
(OpenCode-Session `ses_f3f64b5f5ffeKRXvx1rovoU9uJ`, Provider-Variante
`opencode/big-pickle`). Alle Befunde sind gegen den konkreten Code belegt —
keine generischen Best-Practice-Aussagen ohne Fundstelle.
**Audit-Basis:** `7d8b07b` (`main`, Produktversion `v1.51.3`)
**Audit-PR:** noch offen — Umsetzung über die beigelegten Arena-Prompts auf
`arena/*`-Branches (aktivieren die CI-Vorvalidierung).
**Scope:** Trading-Strategien (Regel-Engine, Backtest, Exit-Management),
Workshop (Missions-/Prompt-Lernpfad) und Marktdaten-/Datenquellen-Pipeline.
**Status:** **OPEN** — 10 Befunde (2 HIGH, 4 MEDIUM, 4 LOW bis offen bewertet),
10 eigenständige Umsetzungs-Prompts.

> **Abgrenzung:** Dieses Audit **ersetzt** weder das
> [feature-gap-Audit](../2026-09-18-feature-gap/README.md) noch das
> [roadmap-Audit](../2026-09-20-roadmap-audit/README.md). Es prüft einen
> eigenen, schmalen Sollzustand (Regel-Bedingungsschicht, Workshop-Lernpfad,
> Datenquellen-Grundversorgung) gegen den Code. Wo ein Befund eine Roadmap-
> Komponente tangiert (z. B. Regime oder Event-Replay), verweist er ausdrücklich
> auf das parallele Finding und schneidet seinen eigenen Umfang so, dass keine
> doppelte Implementierung entsteht.

## Status-Zusammenfassung

| # | Befund | Severity | Aufwand | Finding | Umsetzungs-Prompt |
|---|---|---|---:|---|---|
| BP-01 | Regel-Engine: ADX/BB-Bandbreite/Return-StdDev implementiert, aber nicht abfragbar; MACD fehlt | HIGH | 3–5 PT | [BP-01](findings/BP-01-rule-field-indikatoren.md) | [PROMPT-BP-01](prompts/PROMPT-BP-01-rule-field-indikatoren.md) |
| BP-02 | Technical-Analyst-Step lässt das LLM Indikatoren schätzen statt sie zu berechnen | HIGH | 2–4 PT | [BP-02](findings/BP-02-technical-analyst-berechnete-daten.md) | [PROMPT-BP-02](prompts/PROMPT-BP-02-technical-analyst-berechnete-daten.md) |
| BP-03 | Workshop endet bei der Trefferquote; keine Brücke zu Backtest & Regel-Export | HIGH | 5–8 PT | [BP-03](findings/BP-03-workshop-backtest-bruecke.md) | [PROMPT-BP-03](prompts/PROMPT-BP-03-workshop-backtest-bruecke.md) |
| BP-04 | Workshop ohne Baseline-/Signifikanz-Anzeige, Prompt-Preview und Übungen | MEDIUM | 3–5 PT | [BP-04](findings/BP-04-workshop-baseline-prompt-preview.md) | [PROMPT-BP-04](prompts/PROMPT-BP-04-workshop-baseline-prompt-preview.md) |
| BP-05 | Backtest kennt keine Trailing-/Time-Stops; Live-Monitor schon (Exit-Drift) | HIGH | 4–6 PT | [BP-05](findings/BP-05-backtest-live-exit-konsistenz.md) | [PROMPT-BP-05](prompts/PROMPT-BP-05-backtest-live-exit-konsistenz.md) |
| BP-06 | Einfacher Regel-Backtest kostenfrei; keine Buy-&-Hold-Referenz | MEDIUM | 2–4 PT | [BP-06](findings/BP-06-backtest-kosten-und-benchmark.md) | [PROMPT-BP-06](prompts/PROMPT-BP-06-backtest-kosten-und-benchmark.md) |
| BP-07 | Regeln nur mit fester `stopLossPct`; kein ATR-basierter Stop trotz vorhandener Logik | MEDIUM | 2–3 PT | [BP-07](findings/BP-07-atr-stops-in-regeln.md) | [PROMPT-BP-07](prompts/PROMPT-BP-07-atr-stops-in-regeln.md) |
| BP-08 | Yahoo-`getCandles()` existiert, füllt den HistoricalStore aber nicht (nur Feed) | MEDIUM | 3–5 PT | [BP-08](findings/BP-08-yahoo-historik.md) | [PROMPT-BP-08](prompts/PROMPT-BP-08-yahoo-historik.md) |
| BP-09 | Kein Makro-/Kalenderdaten-Feed (FRED); Regime & Event-Shield ohne Makro-Input | LOW–MEDIUM | 2–4 PT | [BP-09](findings/BP-09-fred-makro-feed.md) | [PROMPT-BP-09](prompts/PROMPT-BP-09-fred-makro-feed.md) |
| BP-10 | Keine geregelte Evaluation zusätzlicher Datenquellen mit Keys (Polygon/Finnhub) | LOW | 4–8 PT | [BP-10](findings/BP-10-datenquellen-integration.md) | [PROMPT-BP-10](prompts/PROMPT-BP-10-datenquellen-integration.md) |

**Verteilung:** 3× HIGH · 5× MEDIUM · 1× LOW–MEDIUM · 1× LOW.
**Gesamtschätzung:** 30–52 PT bei sequenzieller Umsetzung (siehe `report.md`).

## TOP-3-Gating-Faktoren

1. **BP-01 — Bedingungswerkzeug der Regel-Engine ist ausgereizt:** Das System
   berechnet ADX/BBW/StdDev bereits für das Volatilitätsregime, kann diese Werte
   aber nicht als Regel-Bedingungen formulieren; MACD fehlt komplett. Solange das
   offen ist, sind alle vorgeschlagenen Strategie-Feinschliffe (Konfluenz,
   Trendfilter, Squeeze) Formulare ohne Engine-Unterstützung.
2. **BP-05 — Backtest/Live-Exit-Drift:** Sobald Trailing- oder Time-Stops
   aktiviert werden (`RISK_*`-Flags), weicht das Live-Verhalten (Monitor nutzt
   `decideExit()`) vom Backtest ab, weil beide Replay-Pfade nur SL/TP kennen.
   Ohne Replay der Exit-Konfiguration sind Backtests keine brauchbare
   Vorhersage für Live.
3. **BP-03 — Workshop ohne Strategie-Rückkopplung:** Der Workshop misst, ob das
   Modell „TRADE“ sagt, aber nicht, ob die Regel im Backtest Geld verdient. Er
   endet damit, ohne dass ein iteriertes Ergebnis produktiv werden kann.

## Artefakte

- [`report.md`](report.md) — Methodik, verifizierter Status quo, Befunde und
  der vollständige Implementierungsplan (4 Wellen, Dateien, Tests, Gates).
- [`findings/`](findings/) — ein belegter Befund mit Akzeptanzkriterien pro Thema.
- [`prompts/README.md`](prompts/README.md) — Reihenfolge, Abhängigkeiten und
  Benutzung der 10 Arena-Umsetzungs-Prompts.
- [`prompts/PROMPT-00-baseline.md`](prompts/PROMPT-00-baseline.md) — gemeinsame
  Produktions-/Security-Baseline als Reviewer-Checkliste.
- [`remediation/TRACKING.md`](remediation/TRACKING.md) — Status-SSoT.

## Statusmodell

- `OPEN`: geforderte Funktion fehlt oder ist nicht ausreichend verdrahtet.
- `PARTIAL`: ähnliche Infrastruktur existiert, das konkrete Ziel ist nicht
  vollständig erfüllt (im Unterschied zum Roadmap-Audit hier nicht vergeben,
  siehe Einzelfindings).
- `VERIFIED`: Ziel ist im Code belegt (kein Befund in diesem Audit).
- `IN_PROGRESS`, `FIXED`, `WONTFIX`: Remediation-Status nach Start eines Prompts
  (Eintragung in `remediation/TRACKING.md`).