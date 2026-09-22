# Regime-Gate — Markt-Regime-Klassifikator & Strategie-Dämpfung (GAP-06)

> **Seit v1.46.0 · multidimensional seit v1.61.0** · Findings
> [`GAP-06`](audits/2026-09-18-feature-gap/findings/GAP-06-regime-gate.md) ·
> [`RMA-P2-01`](audits/2026-09-20-roadmap-audit/findings/RMA-P2-01-regime-detection.md)
> · Prompts [`PROMPT-06`](audits/2026-09-18-feature-gap/prompts/PROMPT-06-regime-gate.md) /
> [`PROMPT-P2-01`](audits/2026-09-20-roadmap-audit/prompts/PROMPT-P2-01-regime-detection.md)
> · Code: `src/lib/marketRegime.ts` (Klassifikator + Gate),
> `src/lib/regimeFeatures.ts` (Feature-Vertrag, rein),
> `src/lib/regimeFamilyInputs.ts` (Live-Loader),
> `src/lib/regimeSnapshotStore.ts` + `src/lib/regimeEvaluation.ts`
> (Persistenz/Evaluation), `src/lib/indicators.ts` (`adx()`),
> Tests: `tests/marketRegime.test.ts`, `tests/regimeMultidim.test.ts`,
> `tests/regimeSnapshot.db.test.ts` · CLI: `npm run regime:eval`.

Das Regime-Gate schließt die Lücke zwischen dem Volatilitäts-Regime des
adaptiven Risikosystems (`adaptiveRisk.ts`: NORMAL/ELEVATED/EXTREME — ein
reiner **Risikofaktor**) und der Frage, *welche Strategieklasse zum Markt
passt*: Mean-Reversion-Signale werden in Trendmärkten gedämpft und
umgekehrt — als **Datenkontext**, niemals als hartes Veto.

Seit **v1.61.0 (RMA-P2-01)** ist die Erkennung **mehrdimensional und
point-in-time-sicher**: zusätzlich zum OHLCV-Kern fließen versionierte
Preis-, Volatilitäts-, Liquiditäts-, Perp- und optionale Makro-Familien
ein; jedes Snapshot liefert **Klasse + Confidence + Coverage + Top-Treiber
+ Feature-/Modellversion**. Fehlende/stale/invalid Daten bleiben sichtbar
`MISSING`/`STALE` (keine Nullsubstitution) und degradieren explizit auf den
bewährten OHLCV-Pfad.

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

## 1b. Multidimensionale Feature-Ebene (RMA-P2-01, v1.61.0)

`classifyMarketRegimeMultidim(candles, cfg, { asOfMs, families })` ummantelt
den OHLCV-Kern additiv um den **versionierten Feature-Vertrag**
(`src/lib/regimeFeatures.ts`, `regime-features@1`; Modell `regime-rules@1`):

| Familie | Pflicht | Gewicht | Quelle (Live) | Einheit | Lookback | Staleness |
| --- | --- | --- | --- | --- | --- | --- |
| `price` | ja | 0.30 | letzter Schlusskurs der ausgewerteten Kerzen | `quote` | `lookbackCandles`×15m | 2 h |
| `volatility` | ja | 0.30 | Vol-Perzentil des OHLCV-Kerns | `percentile_0_100` | 20-Renditefenster | 2 h |
| `liquidity` | ja | 0.20 | `data/spread-cache.json` (gemessener Spread) | `fraction` | Orderbuch-Messung, TTL 6 h | 6 h |
| `perp` | ja | 0.20 | `data/perpdata/derivatives.json` (nur `PERP_DATA_ENABLED=true`) | `fraction_per_interval` | jüngster Funding-Satz; OI-Δ 24 h | 24 h |
| `macro` | optional | 0 | adaptiver VIX-Zustand (`indicators.VIX`) | `index` | jüngste Bewertung | 15 min |

**Zeitsemantik (Point-in-Time):** jedes externe Sample ist nur verwendbar,
wenn `eventTime ≤ asOf` **und** `availableAt ≤ asOf`. Später verfügbare
Daten werden als `MISSING (AVAILABLE_AT_FUTURE)` verworfen — ein Backtest
kann damit keine später eingetroffenen Makro-/Perp-Daten sehen. Der
Live-Loader (`regimeFamilyInputs.ts`) setzt `availableAt` konservativ auf
den Schreibzeitpunkt des Cache-Artefakts. Backtests/Replays übergeben
stattdessen PIT-gefilterte `RegimeFamilyInputs` aus as-of-Abfragen und
rufen den Live-Loader **nicht**.

**Coverage & Degraded Mode:**
`coverage = Gewicht der OK-Pflichtfamilien / 1.00`, geklemmt [0, 1].
Nicht-`OK` (MISSING/STALE/DISABLED) ⇒ `degraded = true` — das Snapshot läuft
dann als **expliziter OHLCV-Fallback** (die Basisklasse bleibt identisch zum
Klassifikator seit v1.46.0; `featureMode: "ohlcv"` erzwingt diesen Pfad
zusätzlich und konsultiert nie erweiterte Familien).

**Eskalations-Votes (einzige Klassenänderung durch Zusatzfamilien):**

| Stimme | Bedingung (Familie `OK` + Schwelle) | Ziel |
| --- | --- | --- |
| Spread | `liquidity.relativeSpread × 100 ≥ REGIME_LIQUIDITY_SPREAD_HIGH_PCT` (0.5 %) | `HIGH_VOL` |
| Funding | `\|funding\| ≥ REGIME_PERP_FUNDING_ABS` (0.001) | `HIGH_VOL` |
| OI-Einbruch | `OI-Δ24h ≤ −30 %` (Konstante `PERP_OI_COLLAPSE_THRESHOLD`) | `HIGH_VOL` |
| Makro | `VIX ≥ REGIME_MACRO_VIX_HIGH` (30) | `HIGH_VOL` |

Votes heben die **Rohklasse** ausschließlich zum sichereren `HIGH_VOL`
(nie `CRASH` erfinden, nie Trendrichtung drehen); bei `CRASH`/`HIGH_VOL`
im Kern bleibt die Klasse unangetastet.

**Confidence** (deterministisch, keine Online-Kalibrierung):
pro Klasse Evidenzscore aus den OHLCV-Margen plus `1` je Voting-Familie
(Formeln in `evidenceScores()`, Modell `regime-rules@1`);
`confidence = Evidenz[gewählt] / Σ Evidenzen`, geklemmt **[0.2, 0.99]**;
`null` bei `UNKNOWN`. **Top-Treiber:** bis zu 5 Beiträge mit Beitrag und
formatierter Anzeile (z. B. `ADX 41.2`, `|Funding| 0.01000 ≥ 0.001`).

**Roh vs. bestätigt:** `rawRegime`/`confidence` sind der Rohteil;
die Hysterese (§2) bestätigt wie bisher mit `confirmCandles`. Flackernde
Familien erzeugen dadurch kein Ein-Bar-Flapping (Test:
`tests/regimeMultidim.test.ts` „flackernde Familien“).

**Persistenz & Evaluation:** Bei Regime-Wechsel oder alle 15 Minuten
(`REGIME_SNAPSHOT`-Throttle im Store) schreiben Engine und Monitor eine
append-only Zeile in `regime_snapshots`
(`drizzle/2026-09-22_regime_snapshots.sql`; Idempotenz-Schlüssel =
SHA-256 über Symbol|asOf|Roh-/Bestätigtklasse|Coverage|Versionen —
Retries/Restarts schreiben nie doppelt; Retention 90 Tage).
`npm run regime:eval` wertet Stabilität, Transitions, Coverage und
regimebezogene OOS-Forward-Returns in ein geboundedes JSON-Report aus
(`data/regime-eval/report.json`, gitignored); Snapshots ohne erreichbaren
Horizont werden fail-closed ausgeschlossen (nie als 0 % gewertet).

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

**Coverage-Sicherheitsregel (seit v1.61.0):** Der Gate-Faktor ist über
`applyRegimeGate` auf [0, 2] geklemmt (nie `< 1`), wenn die Coverage unter
`REGIME_MIN_COVERAGE` (Default 0.5) liegt (`boostBlocked`): ein Degraded-
Mode oder fehlende Familien kann das Risiko **nie erhöhen** — nur
weiter dämpfen wie zuvor. `resolveRegimeGateForExecution` liefert
zusätzlich `coverage`/`degraded` für Audit und Prompt.

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
  `Regime SYMBOL · Conf … · Cov … % · degraded` je bewerteter Instanz
  (nach Schwere sortiert, CRASH zuerst), inkl. Begründung, Treiber-Hinweis
  und Stand — dieselbe `MarketRegimeGateContext`, die auch der
  Agenten-Prompt und der Mikro-Executor konsumieren.
- **Agenten-Prompt (`formatRegimeGateContext`):** bei `monitor`/`enforce`
  weist die `Regime Context:`-Zeile zusätzlich `Confidence`, `Coverage`,
  `degraded`, Feature-/Modellversion und bis zu drei Top-Treiber aus
  (Audit-Ergänzungen `conf/cov/feature_version/model_version/families`
  auf `REGIME_CHANGE`).
- **Cycle-Artefakte:** `artifacts/YYYY-MM-DD/daily/regime-history.json`
  (Schema-Version **2** mit `rawRegime`, `confidence`, `coverage`,
  `degraded`, `featureMode`/`modelVersion`, `familyStatus` je Zeile) —
  Stand + vollständiger Wechsel-Verlauf je Instrument. Wird nur
  geschrieben, wenn im Prozess mindestens ein Instrument bewertet wurde.
- **Persistierte Snapshots:** Tabelle `regime_snapshots` (siehe §1b),
  Quelle von `npm run regime:eval`.
- **Audit je Regime-Wechsel:** Event `REGIME_CHANGE` mit Code
  `regime:SYMBOL:VON→NACH` (CRASH/HIGH_VOL/UNKNOWN als WARN, sonst INFO);
  jede enforce-Dämpfung zusätzlich `REGIME_GATE_APPLIED` mit Code
  `regime-gate:SYMBOL:KLASSE:REGIME` (inkl. Coverage/Degraded, Faktor).

**Bewertungs-Anker:** Agenten-Turn (Missionssymbol, ohne Extra-Abruf),
Monitor-Tick (offene Positionen, Min-Interval 45 s je Symbol, fail-soft),
Mikro-Executor-Seed (im separaten `npm run micro`-Prozess) und der
Selection-Schritt (Candidates bereits ohne Extra-Kerzenabruf beim
Bestands-Refresh, optional `loadFamilies`). Alle vier Anker rufen
**dieselbe** `evaluateInstrumentRegime` — es gibt keine parallele
Regime-Definition.

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
| `REGIME_FEATURE_MODE` | `multidim` | `multidim` \| `ohlcv` (unbekannt → `multidim`) |
| `REGIME_MIN_COVERAGE` | `0.5` | [0, 1] — darunter `degraded`, Gate-Boosten blockiert |
| `REGIME_LIQUIDITY_SPREAD_HIGH_PCT` | `0.5` | [0.01, 100] % — Spread-Vote → `HIGH_VOL` |
| `REGIME_PERP_FUNDING_ABS` | `0.001` | [0.00001, 0.1] — Funding-Vote → `HIGH_VOL` |
| `REGIME_MACRO_VIX_HIGH` | `30` | [10, 100] — Makro-Vote → `HIGH_VOL` |
| `REGIME_SNAPSHOT_RETENTION_DAYS` | `90` | [7, 365] — `pruneRegimeSnapshots` |
| `PERP_DATA_ENABLED` | `false` | Perp-Familie nur bei `true`; sonst `MISSING` (niemals 0) |

## 6. Abweichungen / Offene Punkte

- **Zyklus-Steps (riskStep):** Die Kandidaten-Erfrischung beim
  Selection-Schritt bewertet die bereits vorhandenen Marktdaten
  (`refreshInstrumentRegimes`) — ohne zusätzliche Kerzenabrufe; das
  Regime fließt weiterhin als Kontext in Approver/Risk-Monitor, nicht als
  eigenes Veto in den Risk-Step.
- **Strategieklasse von Regeln:** Regeln tragen keine eigene Klasse; die
  Ableitung läuft über das Mission-Template. Regeln ohne Mission (MANUAL)
  bleiben ungedämpft (Faktor 1).
- **Prozessgrenzen:** der Regime-Zustand ist RAM-pro-Prozess; der separate
  Mikro-Executor-Prozess füllt ihn beim Seed. Ohne Bewertung gilt immer
  fail-safe Faktor 1. Die Snapshots in `regime_snapshots` sind die
  prozessübergreifende Beobachtungsschicht (append-only).
- **Keine Modellpfade außerhalb der Doku:** bewusst **nicht** Teil von
  RMA-P2-01: unversioniertes Online-Training, das Ersetzen harter
  Risiko-Ceilings durch Modell-Wahrscheinlichkeiten und ein Pflicht-Makro-
  Datenabruf (Makro bleibt optional).
