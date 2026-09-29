# STX-00-03 — Drei Vokabular-Entscheidungen fixieren (ADR)

- **Phase:** 0 · **Paket:** 00-02 · **Findings:** STX-02, STX-03, STX-04
- **Risiko:** keines (Doku), aber **Gate** für Phase 1

## Zweck

> **Hinweis:** Dieser Prompt ist das **Gate** vor Phase 1. Solange die drei Entscheidungen
> nicht schriftlich fixiert sind, wird kein weiterer Prompt gestartet. Jede spätere
> Template-/Validator-Arbeit setzt eine dieser Entscheidungen voraus.

## Zweck

Drei Entscheidungen, die das Ausbaudokument übersehen hat, sind offen. Ohne Festlegung
entstehen im Repo **zwei Wahrheiten** über Strategieklasse, Regime und
Universe-Mitgliedschaft — der teuerste Posten der ganzen Roadmap (nicht Code, sondern
dauerhafte Doku-/Test-Duplikation).

## Kontext

| Frage | Ausgangslage |
|---|---|
| **E1 Strategieklasse** | `StrategyClass = "mean-reversion" \| "trend" \| "breakout"` existiert (`marketRegime.ts:86`), plus `"unclassified"` in `signalDecay.ts:102`. Wirkt auf Regime-Gate **und** Decay-Policies **und** `microExecutor.ts:779`. |
| **E2 Regime** | `MarketRegime = TREND_UP \| TREND_DOWN \| RANGE \| HIGH_VOL \| CRASH` + `UNKNOWN`, klassifiziert in `marketRegime.ts`, persistiert in `regime_snapshots`, ausgewertet in `regimeEvaluation.ts` (`evaluateRegimeOos` misst bereits regimebezogene OOS-Kennzahlen). |
| **E3 Universe-Strategie** | `CrossSectionalConfig` + `EligibilityConfig` decken `ranking`, `selection`, `rebalance`, PIT ab. Fehlt ist nur **Portfolio-Sizing**. |

## Auftrag

Schreibe **drei** ADR-Einträge in `docs/roadmap/DECISIONS.md` im dortigen Format.
Jeder: Kontext, Optionen, **Entscheidung**, Konsequenzen, Auswirkung auf die Roadmap.

### ADR-E1 — Strategie-Klassifikation

- **Entscheidung:** `StrategyTemplate.class: StrategyClassKey` ist Pflicht, typisiert
  gegen `STRATEGY_CLASS_KEYS`. Kein eigener Union-Typ in `src/strategies/`.
- **Zu klären:** Bekommt `unclassified` einen eigenen Template-Status, oder ist ein
  Template ohne Klasse ein **Fehler**? Empfehlung: **Fehler** — jedes Template deklariert
  eine Klasse; `unclassified` bleibt manuellen Regeln vorbehalten.
- **Zu klären:** Braucht eine neue Klasse (z. B. `momentum`)? MACD/RSI sind derzeit
  `mean-reversion` oder `trend` — MACD-Momentum ist eher `trend`, RSI eher
  `mean-reversion`. **Keine neue Klasse in dieser Roadmap.**

### ADR-E2 — Regime-Vokabular

- **Entscheidung:** Die 7er-Taxonomie des Ausbaudokuments
  (bull/bear/sideways/high-vol/low-vol/high-volume/low-volume) wird **verworfen**.
  Strategie-Per-Regime-Auswertung erfolgt über das bestehende
  `MarketRegime` + `regime_snapshots` + `evaluateRegimeOos`.
- **Zu klären:** `UNKNOWN` fail-closed ausschließen (nie als „Regime ohne Edge" zählen).
- **Zu klären:** High-/Low-Volume ist im Repo **kein** Regime, sondern ein Scanner-Faktor
  (`volumeRatio`). Wenn Volume-Regime gebraucht werden, ist das ein **Faktor**-Vorschlag,
  kein Regime. Vorerst: nicht Teil dieser Roadmap.

### ADR-E3 — Universe-Strategie

- **Entscheidung:** **Keine** `MultiAssetStrategySpec`. Stattdessen eine
  `PortfolioConstruction`-Schicht, die einen `CrossSectionalConfig`-Snapshot liest und
  Gewichte erzeugt (`EQUAL_WEIGHT | INVERSE_VOLATILITY`), geklemmt über die Bounds aus
  `src/portfolio/volatilityTargeting.ts`.
- **Zu klären:** Rebalance-Frequenz = `CrossSectionalConfig.timeframe` (nicht neu erfinden).

## Akzeptanzkriterien

- [ ] Drei ADRs mit je Kontext/Optionen/Entscheidung/Konsequenzen
- [ ] Jede Roadmap-Phase, die ein Vokabular berührt, verweist auf die ADR-Nummer
- [ ] Die im Ausbaudokument vorgeschlagenen Alternativen stehen als **verworfen** drin,
      mit Begründung — damit die Entscheidung nicht in 3 Monaten neu diskutiert wird
- [ ] `npm run docs:validate` grün, kein Code geändert

## Gesperrt

- Keine Code-Änderung in diesem Prompt.
- Keine „vielleicht später"-Formulierungen: jede ADR endet in **einer** Entscheidung.
