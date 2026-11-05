# PROMPT-BP-06 — Kostenmodell + Buy-&-Hold-Benchmark im Backtest

## Auftrag

Ergänze im Repository `Kryschuuu/ai-trading-firm` den **einfachen
Regel-Backtest** (`backtestRule()`, API `POST /api/firm/rules/[id]/backtest`)
um nutzbare Transaktionskosten und führe eine **Buy-&-Hold-Referenzlinie** in
die Backtest-Metriken ein. Der Prompt ist eigenständig; Audit-Basis war
`7d8b07b` (`v1.51.3`). Bei Abweichung adaptiere minimal und dokumentiere sie.

Zugehöriger Befund: [`../findings/BP-06-backtest-kosten-und-benchmark.md`](../findings/BP-06-backtest-kosten-und-benchmark.md)
Priorität/Schwere: **MEDIUM**
Schätzung des Restaufwands: **2–4 PT**
Abhängigkeit: Basis für PROMPT-BP-03 (Workshop-Backtest).

## Verifizierter Ausgangszustand

- `src/app/api/firm/rules/[id]/backtest/route.ts:51` ruft `backtestRule()` aus
  `src/lib/ruleEngine.ts:674-776` — **ohne** Gebühren, Slippage, Spread,
  Funding; Entry am Kerzenschluss, SL/TP über Folgekerzen.
- `src/backtest/engine.ts` bietet `DEFAULT_BACKTEST_CONFIG` und einen
  Slippage-/Fee-/Funding-Pfad (Funding nur `"paper"`-Modus); `legacy` als
  eingefrorener Default.
- `src/backtest/metrics.ts` — reichhaltige Kennzahlen, aber kein Benchmark;
  `annualizedReturn` (Zeile ~151, `totalReturnPct * annualizationFactor/len`)
  ist eine reviewwürdige Sonderformel.

## Zielzustand

Der Schnell-Backtest zeigt realistische Netto-Renditen (Taker-Fee + Slippage,
optional Spread/Funding), geliefert aus **einer** Kostenquelle statt
duplizierter Defaults; die Metriken enthalten je Symbol eine Buy-&-Hold-
Referenz (Excess Return, relatives MDD), aus der „schlägt die Regel passives
Halten?“ direkt ablesbar ist.

## Vor Beginn gezielt prüfen

- `src/lib/ruleEngine.ts` (`backtestRule`, Signaturen, Defaults)
- `src/app/api/firm/rules/[id]/backtest/route.ts`
- `src/backtest/engine.ts` (`DEFAULT_BACKTEST_CONFIG`, Slippage-/Fee-Modell)
- `src/backtest/metrics.ts`, `src/portfolio/metrics.ts`
- `tests/backtest.unit.test.ts`, `tests/backtest.metrics.test.ts` (oder
  aktuell äquivalente Pfade)

## Verbindlicher Implementierungsumfang

1. **Kosten im Regel-Backtest:** Fee-/Slippage-Parameter (Default aus
   `DEFAULT_BACKTEST_CONFIG`) in `backtestRule()` buchen; DKosten-Dokumentation
   im JSDoc; optional Spread-/Funding-Schalter — Default aus, verhaltensneutral.
2. **Eine Wahrheit:** Kosten-Defaults nur an zentraler Stelle
   (`DEFAULT_BACKTEST_CONFIG`), vom Regel-Pfad referenziert; keine
   Kopie im ruleEngine-Modul.
3. **Benchmark:** je Symbol Buy-&-Hold-Equity-Kurve aus demselben Kerzenfenster;
   Metriken `excessReturnPct`, `relativeMaxDrawdownPct` (und sinnvolle Ergänzung
   „Anzahl Trades“ wo fehlend) im `BacktestMetrics`-Typ standardisiert.
4. **Formel-Review:** `annualizedReturn` auf korrekte Perioden-Annualisierung
   prüfen, bei Fehler korrigieren (Golden-Test sichern) und im Changelog als
   Bugfix kennzeichnen.
5. **Doku:** `docs/BACKTESTING.md` um Kosten-Defaults und Benchmark-Felder
   erweitern.

## Explizit nicht Teil dieses Changes

- keine Änderung am Multi-Asset-Engine-Verhalten selbst (nur Defaults
  verifizieren, keine doppelte Quelle bauen)
- kein Trailing-/Time-Stop-Replay (siehe PROMPT-BP-05)
- keine neuen Execution-Modelle

## Produktions- und Sicherheitsregeln

- Legacy-/Default-Verhalten nicht unbemerkt ändern: bestehende gespeicherte
  Runs nicht uminterpretieren; neue Felder additiv.
- Keine Look-ahead-Vorteile durch Kostenkonfiguration (Kosten immer zum
  Fill-Zeitpunkt).
- Metriken fail-closed: fehlende Kosten-/Candle-Daten ⇒ markierter Zustand,
  nicht stille 0.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] Golden-Werte: exakt dokumentierte Fee+Slippage auf bekannte Trades
- [ ] derselbe Trade mit/ohne Kosten ⇒ erwartete Differenz
- [ ] Benchmark-Kurve je Symbol aus identischem Fenster (Handrechnung)
- [ ] `annualizedReturn`-Regression (bzw. korrigierte Formel) mit Fixture
- [ ] bestehende Metriken-/Backtest-Tests grün (Legacy-Default unverändert)

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] `POST /api/firm/rules/[id]/backtest` liefert Netto-Ergebnisse inkl.
      Feldern für Gebühren/Slippage und Benchmark.
- [ ] Kosten-Defaults kommen aus einer zentralen Quelle.
- [ ] kein Verhaltensbruch bestehender Runs ohne neue Konfig.

## Dokumentation, Versionierung und Tracking

1. `docs/BACKTESTING.md` und API-Doku aktualisieren.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, implementierte Kosten-/Benchmark-Semantik,
Kompatibilitätshinweise inkl. `annualizedReturn`-Befund, ausgeführte Tests mit
Ergebnis, verbleibende Risiken sowie Commit-/PR-Link.