# Regime-Gate — Markt-Regime-Klassifikator & Strategie-Dämpfung (GAP-06)

> **Seit v1.46.0** · Finding
> [`GAP-06`](audits/2026-09-18-feature-gap/findings/GAP-06-regime-gate.md) ·
> Prompt [`PROMPT-06`](audits/2026-09-18-feature-gap/prompts/PROMPT-06-regime-gate.md)
> · Code: `src/lib/marketRegime.ts` (Klassifikator + Gate),
> `src/lib/indicators.ts` (`adx()`), Tests: `tests/marketRegime.test.ts`.

Das Regime-Gate schließt die Lücke zwischen dem Volatilitäts-Regime des
adaptiven Risikosystems (`adaptiveRisk.ts`: NORMAL/ELEVATED/EXTREME — ein
reiner **Risikofaktor**) und der Frage, *welche Strategieklasse zum Markt
passt*: Mean-Reversion-Signale werden in Trendmärkten gedämpft und
umgekehrt — als **Datenkontext**, niemals als hartes Veto.

## 1. Klassifikator (D1) — deterministisch, kein LLM

`classifyMarketRegime(candles, cfg)` arbeitet ausschließlich auf Kerzen
(Zeitmaske: nur abgeschlossene Daten ≤ t, kein Lookahead) und liefert eines
von fünf Regimes:

| Regime | Bedeutung |
| --- | --- |
| `TREND_UP` / `TREND_DOWN` | Richtungsmarkt mit Tragfähigkeit |
| `RANGE` | Seitwärtsphase ohne Trend |
| `HIGH_VOL` | Realisierte Volatilität im oberen Perzentil-Bereich |
| `CRASH` | Scharfer Einbruch (Drawdown vom Fensterhoch + negativer Slope) |
| `UNKNOWN` | Zu wenig Kerzen (< 30) — wird **nie still** angenommen |

**Features** (alle reine Arithmetik):

- **ADX** (Wilder, Periode 14, `adx()` in `src/lib/indicators.ts`) —
  Trendstärke ohne Richtung. Handrechnungs-Referenztest in
  `tests/indicators.test.ts`.
- **Regressions-Slope** über die Schlusskurse (OLS), normalisiert auf den
  Mittelkurs in %/Kerze.
- **Realisierte Volatilität** (StdDev der Returns, 20-Kerzen-Fenster) als
  **Perzentil-Rang** über alle Fenster des Lookbacks. Entartungsschutz:
  völlig konstante Volatilität ergibt kein Perzentil (Gleichstände würden
  sonst immer als „100 %" zählen).
- **Drawdown** vom Fensterhoch (Schlusskurse) in %.

**Regeln** (Schwellen inklusive `≥`), strikte Priorität bei
Mehrfachtreffern **CRASH > HIGH_VOL > TREND\_\* > RANGE**:

1. `CRASH` wenn Drawdown ≥ `CRASH_DRAWDOWN_PCT` **und** Slope < 0
   (eine V-Erholung mit bereits gedrehtem Slope ist kein Crash).
2. `HIGH_VOL` wenn Vol-Perzentil ≥ `HIGH_VOL_PERCENTILE`.
3. `TREND_UP`/`TREND_DOWN` wenn ADX ≥ `REGIME_TREND_ADX` **und**
   |Slope| ≥ `REGIME_TREND_SLOPE_PCT` (Vorzeichen gibt die Richtung).
4. sonst `RANGE`.

## 2. Hysterese — Whipsaw-Schutz nach dem `adaptiveRisk`-Muster

`MarketRegimeStateMachine` (an `RegimeStateMachine` aus `adaptiveRisk.ts`
angelehnt, für fünf Klassen statt drei):

- **Erstbewertung** wird sofort übernommen.
- **Eskalation** (Schwere ↑: `RANGE`(0) < `TREND_*`(1) < `HIGH_VOL`(2) <
  `CRASH`(3)) ist **sofort** — die sichere Richtung (Dämpfung schaltet
  schneller ein als aus).
- **Seitwärts- und De-Eskalation** (z. B. `TREND_UP → TREND_DOWN` oder
  `HIGH_VOL → RANGE`) erst nach `REGIME_CONFIRM_CANDLES` (Default 3)
  konsekutiven bestätigenden Bewertungen. Eine einzelne Gegenkerze wechselt
  das Regime nicht; ein abweichender Kandidat setzt die Streak zurück.
- `UNKNOWN`-Bewertungen lassen die Maschine unangetastet (kein Raten, keine
  De-Eskalation auf Teil-/Fehldaten).

## 3. Gate (D2) — Datenkontext, kein Veto

`applyRegimeGate({ regime, strategyClass, weight, mode })` multipliziert ein
Signalgewicht mit dem Dämpfungsfaktor je **Regime × Strategieklasse**
(`mean-reversion`, `trend`, `breakout`); Werte werden auf **[0, 2]**
geklemmt. Defaults (Vorschlag aus dem Finding):

| Regime | mean-reversion | trend | breakout |
| --- | --- | --- | --- |
| `TREND_UP` / `TREND_DOWN` | **× 0.5** | × 1 | × 1 |
| `RANGE` | × 1 | × 1 | **× 0.5** |
| `HIGH_VOL` / `CRASH` | × 1 | × 1 | × 1 |

Über `REGIME_GATE_FACTORS` frei konfigurierbar, Grammatik
`REGIME:klasse=faktor,…` (z. B. `TREND_UP:mean-reversion=0.25`); kaputte
Einträge werden übersprungen, nie still scharfgeschaltet.

**Modi** (`REGIME_GATE_MODE`, unbekannter Wert → fail-closed `monitor`):

| Modus | Verhalten |
| --- | --- |
| `off` | Faktor 1, keine Ausweisung — Prompt/Entscheidungspfad byte-identisch. |
| `monitor` (**Default**) | Ausweis (Ops-Center, Prompt-Kontext) + Audit je Regime-Wechsel — **keine Wirkung** auf Entscheidungen. Rollout monitor-first. |
| `enforce` | Faktor wirkt: Engine-Risikobudget im Prompt der Mission × Faktor; Mikro-Executor-Sizing `riskBudgetPct × Faktor` (stets gegen `maxRiskPerTrade` geklemmt → nie über den Code-Ceilings; Faktoren > 1 werden dort von den Guardrails begrenzt). Jede Dämpfung schreibt ein `REGIME_GATE_APPLIED`-Audit. |

Die **Strategieklasse** wird deterministisch aus dem Mission-Template
abgeleitet (`strategyClassOfTemplate`: `…mean-reversion…` →
mean-reversion, `…breakout…` → breakout, `…trend…/…momentum…` → trend).
Ohne ableitbare Klasse gilt Faktor 1 — keine stillschweigende Zuordnung.
`UNKNOWN`-Regime → Faktor 1 + explizite Kennzeichnung (nie still).

### Wo das Gate wirkt (und wo nicht)

- **Engine-Turn (Approver-Kontext):** Regime-Klassifikation über dieselben
  Kerzen des Markt-Kontexts (kein Extra-Abruf); bei `monitor`/`enforce`
  erhält der Prompt eine `REGIME-GATE …`-Zeile, bei `enforce` zusätzlich
  das gedämpfte Risikobudget. `off` lässt den Prompt unverändert.
- **Mikro-Executor (ruleEngine-Ausführung):** nur `enforce` dämpft das
  Risikobudget der Regel; das Regime stammt aus dem RAM-Snapshot
  (Seed-Zeit + Monitor-Tick), fehlendes Snapshot → fail-safe Faktor 1.
- **Kein Veto:** keine Order wird wegen des Regimes abgelehnt oder
  verschoben — dafür bleiben `adaptiveRisk` (Limits) und Risk-Guards
  zuständig.

## 4. Sichtbarkeit (D3)

- **Ops-Center, Risk-Sektion:** `Markt-Regime-Gate` (Modus) plus
  `Regime SYMBOL` je bewerteter Instanz (nach Schwere sortiert, CRASH
  zuerst), inkl. Begründung und Stand.
- **Cycle-Artefakte:** `artifacts/YYYY-MM-DD/daily/regime-history.json`
  (Schema-Version 1) — Stand + vollständiger Wechsel-Verlauf je Instrument.
  Wird nur geschrieben, wenn im Prozess mindestens ein Instrument bewertet
  wurde.
- **Audit je Regime-Wechsel:** Event `REGIME_CHANGE` mit Code
  `regime:SYMBOL:VON→NACH` (CRASH/HIGH_VOL/UNKNOWN als WARN, sonst INFO);
  jede enforce-Dämpfung zusätzlich `REGIME_GATE_APPLIED` mit Code
  `regime-gate:SYMBOL:KLASSE:REGIME`.

**Bewertungs-Anker:** Agenten-Turn (Missionssymbol, ohne Extra-Abruf),
Monitor-Tick (offene Positionen, Min-Interval 45 s je Symbol, fail-soft)
und Mikro-Executor-Seed (im separaten `npm run micro`-Prozess).

## 5. Konfiguration (Bounds + Defaults)

Alle Schwellen: `CONFIGURATION.md` §„Regime-Gate“ und `.env.example`.

| Flag | Default | Bounds |
| --- | --- | --- |
| `REGIME_LOOKBACK_CANDLES` | `100` | [20, 500] |
| `CRASH_DRAWDOWN_PCT` | `10` | [3, 50] |
| `HIGH_VOL_PERCENTILE` | `90` | [50, 99] |
| `REGIME_CONFIRM_CANDLES` | `3` | [1, 20] |
| `REGIME_TREND_ADX` | `25` | [10, 60] |
| `REGIME_TREND_SLOPE_PCT` | `0.05` | [0.005, 1] |
| `REGIME_GATE_MODE` | `monitor` | `off` \| `monitor` \| `enforce` |
| `REGIME_GATE_FACTORS` | s. Tabelle oben | Werte geklemmt [0, 2] |

## 6. Abweichungen / Offene Punkte

- **Zyklus-Steps (riskStep/selectionStep):** Der Risk-Manager-Step nutzt
  weiterhin das Vol-Regime des Analytics-Ports; eine Anreicherung der
  Kandidaten mit dem Markt-Regime (bis zu 40 Kerzen-Abrufe je Lauf) ist
  bewusst nicht Teil dieses Deltas.
- **Strategieklasse von Regeln:** Regeln tragen keine eigene Klasse; die
  Ableitung läuft über das Mission-Template. Regeln ohne Mission (MANUAL)
  bleiben ungedämpft (Faktor 1).
- **Prozessgrenzen:** der Regime-Zustand ist RAM-pro-Prozess; der separate
  Mikro-Executor-Prozess füllt ihn beim Seed. Ohne Bewertung gilt immer
  fail-safe Faktor 1.
