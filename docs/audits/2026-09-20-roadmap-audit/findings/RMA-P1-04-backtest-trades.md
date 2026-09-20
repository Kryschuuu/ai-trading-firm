# RMA-P1-04: Persistente `backtest_runs` und `backtest_trades`

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `CRITICAL`
- **Quick Estimate Restaufwand:** **2–3 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P1-04`](../prompts/PROMPT-P1-04-backtest-trades.md)

## Verifizierte Fundstellen

- `src/db/schema.ts::backtestRuns` — persistiert Run-Metadaten, Zeitfenster, Konfiguration und Metriken.
- `src/backtest/runStore.ts::insertBacktestRun()` — schreibt Runs.
- `src/app/api/firm/backtests/route.ts` und `src/app/api/firm/backtests/[id]/route.ts` — List-/Detailzugriff.
- `src/backtest/types.ts::BacktestTradeLog` — Trade-Daten existieren nur im Laufzeitergebnis.

## Bewertung und Abgrenzung

Run-Level-Persistenz und ein Hash des Trade-Ergebnisses sind vorhanden. Damit kann ein Lauf identifiziert und verglichen werden. Ein Hash ist aber weder abfragbar noch ausreichend für Attribution, Drift oder Debugging einzelner Fills.

## Konkretes Delta

- append-only Tabelle `backtest_trades` mit FK zum Run
- stabile Trade-ID/Sequenz sowie Instrument, Richtung, Entry/Exit, Mengen und Timestamps
- Fees, Funding, Slippage, Exit-Grund, Signal-/Regel-/Prompt-Referenzen
- atomare Run-plus-Trades-Persistenz und idempotente Wiederholung
- paginierter, begrenzter API-Zugriff ohne unbeschränkte Payloads

## Akzeptanzkriterien für `FIXED`

- [ ] Run und Trades werden in einer Transaktion oder gar nicht geschrieben
- [ ] Trade-Zeilen rekonstruieren exakt die Run-Aggregate
- [ ] identische Run-ID/Idempotency-Key erzeugt keine Duplikate
- [ ] bestehende Run-API bleibt rückwärtskompatibel

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
