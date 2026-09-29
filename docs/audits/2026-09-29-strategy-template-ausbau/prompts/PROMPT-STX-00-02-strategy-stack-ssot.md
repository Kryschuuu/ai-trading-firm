# STX-00-02 — Strategie-Stack als SSoT dokumentieren

- **Phase:** 0 · **Paket:** Voraussetzung für 00-03, 04-02, 07-01 · **Finding:** STX-10
- **Risiko:** keines (Doku)

## Zweck

Das Ausbaudokument hat den Bestand **falsch eingeschätzt** (Feature Store =
3 Features, kein „zentraler Layer"; Regime = bereits 5+1; Strategie-Klasse =
bereits vorhanden; Alpaca-WS = nicht vorhanden). Damit das nicht erneut passiert,
braucht das Repo **eine** Karte, die sagt, welcher Baustein wofür zuständig ist —
und wohin neue Arbeit gehört.

## Kontext

`docs/architecture/` enthält `PIPELINE_MAP.md`, `DB_SCHEMA.md`,
`INTEGRATION_POINTS.md`. Es fehlt die **Entscheidungs-** Karte: „Welche Komponente
besitzt Regel-Felder, Strategie-Klassen, Regime, Eligibility, Kostenmodelle, Evidenz?"

## Auftrag

Lege `docs/architecture/STRATEGY_STACK.md` an. Inhalt:

1. **Komponenten-Tabelle** mit exakten Pfaden und Verantwortung:

   | Thema | SSoT | Nicht hier |
   |---|---|---|
   | Rule-Felder (Whitelist) | `src/lib/ruleFieldCatalog.ts` | — |
   | Rule-Ausführung + Sanitize | `src/lib/ruleEngine.ts` | nicht im Strategie-Modul |
   | Indikator-Formeln | `src/lib/indicators.ts` + `src/backtest/indicatorCache.ts` | — |
   | Strategieklasse | `src/lib/signalDecay.ts` (`STRATEGY_CLASS_KEYS`) | nicht neu in `src/strategies/` |
   | Regime | `src/lib/marketRegime.ts` (`MarketRegime`) + `regime_snapshots` | kein zweites Vokabular |
   | Regime-Auswertung | `src/lib/regimeEvaluation.ts` | — |
   | Universe-Mitgliedschaft | `src/universe/*` + `crossSectional/types.ts` (`EligibilityConfig`) | kein zweites Eligibility |
   | Cross-Sectional-Ranking | `src/crossSectional/*` | keine neue Spec |
   | Scanner-Faktoren | `src/scanner/scanner.config.json` (**14 aktive**) | nicht die Dateiliste |
   | Feature Store | `src/features/*` (3 Features) | nicht „zentraler Layer" |
   | Backtest / WF / MC | `src/backtest/*` | keine zweite Engine |
   | Kostenmodell | `BacktestEngineConfig.feeModel` + `MonteCarloStressConfig` | kein drittes |
   | Lifecycle + Evidenz | `src/strategyLifecycle/*` | — |
   | Symbol-SSoT | `src/symbols/normalize.ts` | kein String-Replace |
   | Fill-Reconciliation | `src/brokers/reconciliation.ts` + `src/executionQuality/` | kein Copy-Reconciler |
   | Broker-WS | nur `src/brokers/bitunix/ws.ts` | Alpaca hat **keinen** |

2. **Nicht vorhanden** (explizit als Lücke markieren, mit Verweis auf die Roadmap):
   `src/strategies/`, `src/screening/`, `src/copy/`, `strategy_definitions`,
   `strategy_versions`, `strategy_screening_runs`, `strategy_market_results`.

3. **„Wo kommt neues dazu?"** — eine 5-zeilige Entscheidungsregel.

4. Verlinke aus `docs/REPOSITORY_STRUCTURE.md` und `docs/architecture/PIPELINE_MAP.md`
   (dort `docs:validate` prüft alle relativen Links).

## Akzeptanzkriterien

- [ ] Jede Zeile der Tabelle nennt einen **existierenden** Pfad (stichprobenweise prüfen)
- [ ] Keine Aussage „geplant" ohne Roadmap-Verweis
- [ ] `npm run docs:validate` grün
- [ ] Kein Code geändert

## Gesperrt

- Keine neuen `src/`-Module in diesem Prompt.
- Keine Bewertung, keine Roadmap-Wiedergabe — nur Ist-Zustand.
