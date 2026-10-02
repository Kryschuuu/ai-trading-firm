# Strategie-Validierung — Annahmen-Audit, Overfit-Auswertung & Cost-Stress-Runner

> **Stand:** `v0.10.3` ·
> **Module:** [`assumptions.ts`](../src/strategies/validator/assumptions.ts) (Teil 1, STX-06-01) ·
> [`overfit.ts`](../src/strategies/validator/overfit.ts) (Teil 2, STX-06-02) ·
> [`stress.ts`](../src/strategies/validator/stress.ts) (Teil 3, STX-06-03) ·
> [`report.ts`](../src/strategies/validator/report.ts) + [`persist.ts`](../src/strategies/validator/persist.ts) (Teil 4, STX-06-04) ·
> **Tests:** [`tests/strategyValidation.assumptions.test.ts`](../tests/strategyValidation.assumptions.test.ts) (38) ·
> [`tests/strategyValidation.overfit.test.ts`](../tests/strategyValidation.overfit.test.ts) (39) ·
> [`tests/strategyValidation.stress.test.ts`](../tests/strategyValidation.stress.test.ts) (22) ·
> [`tests/strategyValidation.report.test.ts`](../tests/strategyValidation.report.test.ts) (32) ·
> [`tests/strategyValidation.persist.test.ts`](../tests/strategyValidation.persist.test.ts) (6) ·
> **CLI:** `npm run validate:strategy` ([`scripts/run-validate-strategy.ts`](../scripts/run-validate-strategy.ts)) ·
> **Prompts:** [STX-06-01](audits/2026-09-29-strategy-template-ausbau/prompts/PROMPT-STX-06-01-assumptions-audit.md),
> [STX-06-02](audits/2026-09-29-strategy-template-ausbau/prompts/PROMPT-STX-06-02-overfit.md),
> [STX-06-03](audits/2026-09-29-strategy-template-ausbau/prompts/PROMPT-STX-06-03-cost-stress.md),
> [STX-06-04](audits/2026-09-29-strategy-template-ausbau/prompts/PROMPT-STX-06-04-validation-report.md) ·
> **Findings:** [STX-17](audits/2026-09-29-strategy-template-ausbau/findings/STX-17-info-validator-agent-kompatibel.md),
> [STX-01](audits/2026-09-29-strategy-template-ausbau/findings/STX-01-rule-timeframe-blocker.md),
> [STX-14](audits/2026-09-29-strategy-template-ausbau/findings/STX-14-changepct24h-semantik.md),
> [STX-11](audits/2026-09-29-strategy-template-ausbau/findings/STX-11-cost-stress-existiert.md)

Jede Strategie behauptet **durch ihre Existenz**, dass bestimmte Annahmen gelten
(`StrategyTemplate.assumptions`, STX-03-01). Der Annahmen-Audit (Teil 1) prüft,
ob diese Annahmen im **konkreten Lauf belegt** sind — nicht, ob sie sinnvoll
sind (das entscheidet ein Mensch), und nicht, ob die Strategie Geld verdient
(das messen 06-02/06-03).

Die Overfit-Auswertung (Teil 2) stellt die zweite methodische Frage: ob nicht
das **Parameterset, das man ausgewählt hat**, funktioniert — statt der
Strategie selbst. Sie liest den vorhandenen Walk-Forward-Nachbarschafts-Scan,
baut aber nichts neu.

Der Cost- & Slippage-Stress-Runner (Teil 3) beantwortet die dritte Frage in
zwei strikt getrennten Schichten ohne drittes Kostenmodell: ob die Edge nach
skalierten Gebühren und Slippage **im echten Engine-Lauf** (`runInEngineStress`)
noch trägt — und wie empfindlich die Trade-Pfadverteilung gegen
Ergebnisrauschen ist (`runPostHocStress` als dünner Durchreiche-Adapter auf
`runMonteCarloSimulation`).

Die Frage ist eng: **Hält der Backtest die Bedingungen ein, unter denen die
Strategie überhaupt eine Aussage ist?**

---

## 1. Warum der Audit vor den Metriken läuft

Ein Lauf mit `feeModel = { makerFee: 0, takerFee: 0 }` hat keinen informativen
Sharpe. Die Zahl ist dann nicht klein — sie ist bedeutungslos. Der Audit ist
deshalb ein **Gate**, kein Bericht:

```ts
import { auditAssumptions, assumptionGate } from "@/strategies/validator/assumptions";

const audit = auditAssumptions({ template, version, run, candles, config });
const gate = assumptionGate(audit);
if (!gate.allow) {
  // 06-02/06-03/06-04 dürfen keine Metrik auswerten.
  return { skipped: true, reason: gate.reason };
}
```

`assumptionGate()` gibt die Metrik-Auswertung **nur** bei `verdict === "PASS"`
frei. `FAIL` und `INCONCLUSIVE` sperren — mit unterschiedlicher Bedeutung:

| Gesamtstatus | Bedeutung | Folge für 06-02/06-04 |
|---|---|---|
| `PASS` | Alle Prüfungen `HOLDS` | Metriken sind auswertbar |
| `FAIL` | Eine `BLOCKING`-Prüfung ist verletzt, **ohne** dass eine kritische Template-Annahme betroffen ist | Der Lauf ist nachweislich kaputt — Metriken wären bedeutungslos |
| `INCONCLUSIVE` | Eine kritische Annahme ist verletzt **oder** nicht prüfbar (oder eine Prüfung blieb `UNKNOWN`) | Der Lauf trägt keine Aussage — **weder dafür noch dagegen** |

**Ein nicht prüfbarer Lauf ist kein Beweis gegen die Strategie.** Deshalb macht
eine kritische Annahme mit `VIOLATED` **oder** `UNKNOWN` das Gesamtergebnis zu
`INCONCLUSIVE` und ausdrücklich nicht zu `FAIL`.

---

## 2. Reine Funktion, injizierte Fakten

`auditAssumptions()` macht **keine IO, keine Uhr, keine DB, keinen Zufall**.
Sie liest ausschließlich die injizierten `*Facts`-Objekte und liefert dieselbe
Ausgabe für dieselbe Eingabe (byteweise in
`tests/strategyValidation.assumptions.test.ts` geprüft). Ein statischer Wächter
prüft zusätzlich den Quelltext auf IO-Referenzen.

```ts
type AuditInput = {
  template: StrategyTemplate;   // assumptions + requiredFields
  version: RuleSpec;            // sanierte Regel (sanitizeRuleSpec, STX-03-09)
  run: BacktestRunFacts;        // trades, equityPoints, OOS, embargoMs, purgeMs, …
  candles?: CandleFacts | null; // bars, requiredWarmupCandles, snapshots[]
  config: RunConfigFacts;       // feeModel, slippageModel, executionModel, …
};
```

**Fehlende Fakten sind `UNKNOWN`, nie `HOLDS`.** Dieses Modul erfindet keinen
einzigen Wert: Wer den Audit füttert, ist für die Herkunft der Fakten
verantwortlich.

| Fakt | Herkunft im Repo |
|---|---|
| `config.feeModel`, `slippageModel`, `fixedSlippageBps`, `executionModel`, `initialCapital` | `BacktestEngineConfig` (`src/backtest/types.ts`) |
| `candles.snapshots[].spreadPct` / `.bookDepthUsd` | `RuleSnapshot` (`src/lib/ruleEngine.ts`), gebaut in `src/backtest/engine.ts` |
| `candles.bars` / `requiredWarmupCandles` | `requiredWarmupCandles(scannerConfig)` (`src/scanner/warmup.ts`) bzw. `warmupBars` |
| `run.trades` / `equityPoints` | `MultiAssetBacktestResult` bzw. `RuleBacktestBody` |
| `run.outOfSample`, `walkForwardWindows`, `embargoMs`, `purgeMs` | `FreezeArtifact.cutoffs` (`src/backtest/walkforward.ts`) |
| `version` | `compileTemplate()` (03-09) → `sanitizeRuleSpec()` |

Gelesene Konstanten — **keine zweiten Wahrheiten**:

| Wert | Quelle |
|---|---|
| Mindeststichprobe 30 Trades | `MC_MIN_SAMPLE_TRADES` (`src/backtest/montecarlo.ts`) |
| Deckel 200 Trades / 120 Equity-Punkte | `RULE_BACKTEST_TRADE_CAP` / `RULE_BACKTEST_EQUITY_CAP` (`src/lib/ruleBacktest.ts`) |
| Timeframe-Dauern | `SUPPORTED_TIMEFRAME_MS` (`src/lib/marketdata/timeframes.ts`) |
| Semantik `changePct24h` | `RULE_FIELD_LABELS` (`src/lib/ruleFieldCatalog.ts`) |
| Annahme-Kategorien | `StrategyAssumption["category"]` (`src/strategies/types.ts`) |

---

## 3. Die elf Prüfungen

Die ersten zehn sind die Pflichtprüfungen des Prompts, in dessen Reihenfolge.
`FILLS_MODELLED` ist die begründete Ergänzung (siehe § 6).

| # | ID | Frage | `VIOLATED` wenn | Schwere | Kategorien |
|---|---|---|---|---|---|
| 1 | `FEE_NONZERO` | Waren Gebühren im Lauf > 0? | `makerFee <= 0 && takerFee <= 0` | `BLOCKING` | `COST` |
| 2 | `SLIPPAGE_NONZERO` | War Slippage > 0? | `slippageModel === "none"`, oder `fixed` mit `<= 0 bp`, oder `spread_relative` mit Faktor `<= 0` | `BLOCKING` | `COST` |
| 3 | `SPREAD_MEASURED` | Wurde der Spread **gemessen**? | `spreadPct === null` in `>= 20 %` der Snapshots (bzw. 0 Snapshots) | `BLOCKING` | `COST`, `LIQUIDITY` |
| 4 | `DEPTH_SUFFICIENT` | Trägt die Buchtiefe die Position? | `bookDepthUsd === null` in `>= 20 %`, **oder** gemessene Tiefe `< initialCapital × maxPositionPct` in `>= 20 %` | `WARNING` | `LIQUIDITY` |
| 5 | `WARMUP_MET` | Reichte der Warmup? | `bars < requiredWarmupCandles` | `BLOCKING` | `DATA` |
| 6 | `TRADES_SUFFICIENT` | Ist die Stichprobe groß genug? | **nie** — unter 30 Trades ⇒ `UNKNOWN` | `BLOCKING` | `MARKET` |
| 7 | `CAPS_RESPECTED` | Blieb der Lauf unter den Deckeln? | `trades > 200` oder `equityPoints > 120` | `BLOCKING` | `DATA` |
| 8 | `LEAKAGE_PROTECTED` | Lief Walk-Forward mit Embargo/Purge? | OOS-Fenster > 0 und `embargoMs`/`purgeMs` fehlen | `BLOCKING` | `DATA` |
| 9 | `INTRADAY_ONLY` | Wird `vwapPct` nur genutzt, wo der Anker trägt? | `vwapPct` genutzt **und** Timeframe `>= 1h` | `BLOCKING`, auf `1h` nur `WARNING` | `DATA` |
| 10 | `CHANGE_PCT_SEMANTICS` | Wird `changePct24h` als Tageswert gelesen? | Feld in `requiredFields` **oder** in der Regel | `WARNING` | `DATA` |
| 11 | `FILLS_MODELLED` | Sind Fills modelliert (nicht instant)? | `executionModel === "legacy"` | `WARNING` | `EXECUTION` |

Jede Prüfung liefert **immer eine Zahl** in `evidence` — kein „vielleicht":

```text
spreadPct fehlt in 12 von 20 Snapshots (60 % ≥ Grenze 20 %); Median 0.04 %.
7 Trades < Minimum 30 Trades (23 fehlen) — Stichprobe nicht interpretierbar, kein VIOLATED.
5 OOS-Fenster ohne embargoMs und purgeMs (2 von 2 Leakage-Schutzparametern fehlen).
```

### 3.1 `UNKNOWN` ist ein Ergebnis

`UNKNOWN` heißt: **im Lauf nicht belegbar**. Das ist ein eigenes Ergebnis, kein
Fehler und kein `HOLDS`. Beispiele: fehlendes `feeModel`, keine injizierten
Snapshot-Fakten, kein `requiredWarmupCandles`, Trade-Zahl unter 30.

`UNKNOWN` zieht den Gesamtstatus auf `INCONCLUSIVE` — niemals auf `FAIL`.

### 3.2 `critical: true` und das Kategorien-Mapping

`ASSUMPTION_CHECK_CATEGORIES` mappt jede Prüfung auf die Annahme-**Kategorien**,
zu denen sie etwas aussagen kann. Die Richtung ist bewusst asymmetrisch:

- `VIOLATED`/`UNKNOWN` **widersprechen** einer kritischen Annahme der gemappten
  Kategorie. Das ist belastbar: `makerFee = 0` widerlegt jede kritische
  `COST`-Annahme.
- `HOLDS` **beweist umgekehrt keine** Template-Annahme. „`WARMUP_MET` hält"
  heißt: die Kerzenzahl reicht. Es heißt nicht: „`bbw-kalibrierung` ist belegt".

Kritische Annahmen, zu deren Kategorie **keine** Prüfung etwas sagt (heute:
`REGIME`), stehen in `uncoveredCritical` — als Fakt, ohne den Status zu ändern.
Ihre Auswertung gehört dem Report (06-04) zusammen mit
`evaluateRegimeOos` ([ADR-009](roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2)),
nicht diesem Modul.

Das Ergebnis trägt die Zuordnung mit:

```ts
type AssumptionAudit = {
  checks: readonly AssumptionCheck[];    // alle 11, feste Reihenfolge
  violated: readonly AssumptionCheck[];
  unknown: readonly AssumptionCheck[];
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  blocking: readonly AssumptionCheck[];  // BLOCKING und nicht HOLDS
  criticalFindings: readonly string[];   // betroffene kritische Annahmen
  uncoveredCritical: readonly string[];  // kritisch, aber ohne Prüfungsbezug
  summary: string;                       // Klartext mit Zählungen
  auditVersion: "asm1";
};
```

---

## 4. Schwellen

Das „X %" des Prompts ist konfigurierbar, mit harten Bounds. Werte außerhalb
werden **abgewiesen** (geworfen), nicht still geklemmt — eine verschobene
Schwelle verändert Urteile.

| Schwelle | Default | Bounds | Wirkung |
|---|---|---|---|
| `maxMissingSpreadPct` | `20` | `[0, 100]` | Anteil Snapshots ohne `spreadPct` |
| `maxMissingBookDepthPct` | `20` | `[0, 100]` | Anteil Snapshots ohne `bookDepthUsd` |
| `minDepthToNotionalRatio` | `1` | `[0, 1000]` | Tiefe ÷ Positionsnotional |

```ts
config.thresholds = { maxMissingSpreadPct: 50 };   // Override, alle übrigen bleiben Default
```

Die restlichen Grenzen sind **nicht** konfigurierbar, weil sie keine
Modellannahmen, sondern bestehende Code-Fakten sind: 30 Trades
(`MC_MIN_SAMPLE_TRADES`), 200/120 (`RULE_BACKTEST_*_CAP`), `1h`
(`SUPPORTED_TIMEFRAME_MS["1h"]`).

---

## 5. Beispiel: derselbe Lauf, drei Urteile

```text
vwap-pullback v1: 11 Prüfungen — 11 HOLDS, 0 VIOLATED, 0 UNKNOWN;
0 kritische Annahme(n) betroffen, 0 kritische Annahme(n) ohne Prüfungsbezug ⇒ PASS.

vwap-pullback v1: 11 Prüfungen — 10 HOLDS, 1 VIOLATED, 0 UNKNOWN;
1 kritische Annahme(n) betroffen, 0 kritische Annahme(n) ohne Prüfungsbezug ⇒ INCONCLUSIVE.
```

Der zweite Satz ist derselbe Lauf mit `feeModel = { makerFee: 0, takerFee: 0 }`:
`vwap-pullback` deklariert `intraday-kosten` als **kritische** `COST`-Annahme,
also `INCONCLUSIVE` — nicht `FAIL`, und keine Metrik-Auswertung.

---

## 6. Entscheidungen und Abweichungen vom Prompt

Dokumentiert, damit nichts still abweicht (Muster: „Korrekturen am Befund" in
den Findings dieses Audits):

1. **`CAPS_RESPECTED` statt `CAPS_RESpected`:** Der Prompt nennt die ID mit
   Binnenmajuskel — offenkundig ein Tippfehler. Die ID folgt dem
   SCREAMING_SNAKE-Stil der übrigen neun.
2. **`INTRADAY_ONLY` auf `1h` ist `WARNING`, nicht `BLOCKING`:** Der Prompt
   nennt `tf >= "1h"`. `VWAP_PCT_RELIABLE_TIMEFRAMES` (STX-03-07) zählt `1h`
   zur konservativen Intraday-Menge, während der UTC-Tagesanker dort erst ab
   der zweiten Kerze des Tages trägt (STX-01). Beide Befunde sind wahr: Der
   Audit meldet `1h` deshalb als `VIOLATED` mit `WARNING` und alles ab `2h`
   als `BLOCKING`.
3. **`FEE_NONZERO` verletzt auch bei negativen Gebühren:** Der Prompt nennt
   `=== 0`. Ein negatives `feeModel` ist in diesem Repo nicht messbar — ein
   Rebate wäre erfunden (fail-closed).
4. **`DEPTH_SUFFICIENT` prüft die Position mit:** Zusätzlich zum
   `null`-Anteil wird die gemessene Tiefe gegen
   `initialCapital × action.maxPositionPct` geprüft — „Buchtiefe trägt die
   Position" ist sonst keine Aussage.
5. **`FILLS_MODELLED` ergänzt die zehn Pflichtprüfungen:** Die
   §3.4-Checkliste des Ausbaudokuments nennt „instant fills". Ohne diese
   Prüfung bliebe die Kategorie `EXECUTION` — bei vier der sechs Templates
   **kritisch** — ungeprüft. `legacy` ist dabei `WARNING`, weil es der
   eingefrorene Default-Pfad der gesamten Bestandskörperschaft ist.

### 6.1 Bewusst nicht geprüft

| Annahme | Warum nicht |
|---|---|
| Funding ≠ 0 | `AuditInput` trägt keine Instrument-Fakten (Perpetual ja/nein). Eine Zahl aus dem Nichts wäre schlimmer als ein `UNKNOWN`. |
| Survivorship / Universe-Mitgliedschaft | Gehört der Point-in-Time-Eligibility (`src/crossSectional/`); der Audit bekäme sonst eine zweite Wahrheit über Universen. |
| Regime-Passung | `expectedRegimes` misst `evaluateRegimeOos`; kritische `REGIME`-Annahmen erscheinen deshalb in `uncoveredCritical`. |
| Ob die Annahmen **sinnvoll** sind | Das ist eine menschliche Entscheidung (06-05 erklärt nur, `agent.ts`). |

Es werden **keine** Annahmen erzeugt — nur die deklarierten geprüft.

---

## 7. Abgrenzung zu den Nachbarschritten

| Schritt | Aufgabe | Verhältnis zum Audit |
|---|---|---|
| 06-02 Overfit & Robustheit | Plateau, IS/OOS-Lücke, Multiplizität, Holdout-Integrität | **umgesetzt** in [`overfit.ts`](../src/strategies/validator/overfit.ts) (Teil 2) — läuft **nach** dem Gate |
| 06-03 Cost-Stress | `feeMultiplier`/`slippageMultiplier` | läuft **nach** dem Gate — ein Kostenstress auf einen Lauf ohne Kosten ist sinnlos |
| 06-04 Report + CLI | bündelt alles, persistiert Evidence | konsumiert `AssumptionAudit` unverändert |
| 06-05 Validator-Agent (LLM) | erklärt nur | schreibt ausschließlich `detail jsonb`, nie `result` |

Gesperrt bleiben: `montecarlo.ts`, `walkforward.ts`, `marketRegime.ts`
(hier höchstens gelesen).

---

## 8. Tests des Annahmen-Audits

```bash
node --import tsx --test tests/strategyValidation.assumptions.test.ts
```

38 Fälle, keine DB, kein Netz, keine Zeitabhängigkeit:

- **1 HOLDS-Pfad** (sauberer Lauf hält alle elf Prüfungen ⇒ `PASS`),
- **17 `VIOLATED`-Pfade** (jede Pflichtprüfung mindestens einmal, plus
  Zusatzfälle wie negative Gebühren, `fixed` mit 0 bp, leere Snapshot-Reihe,
  nur `purgeMs` fehlend, `1h` vs. `4h`),
- **6 `UNKNOWN`-Pfade** (Trade-Zahl unter 30 und fehlend, keine Snapshot-Fakten,
  fehlendes `feeModel`/`slippageModel`/`executionModel`, fehlender Warmup-Bedarf),
- Verdict-Regeln (`critical` + `VIOLATED`, `critical` + `UNKNOWN`, `FAIL` nur
  bei `BLOCKING`, `WARNING` allein ändert nichts, `uncoveredCritical`),
- Determinismus, Eingabe-Treue, `evidence` immer mit Zahl, feste Reihenfolge,
  Schwellen-Override und -Ablehnung, Gate-Verhalten und der statische
  IO-Wächter über den Modulquelltext.

---

# Teil 2 — Overfit & Robustheit (`overfit.ts`, STX-06-02)

Die zentrale methodische Frage: Funktioniert die **Strategie** — oder
funktioniert **das Parameterset, das man ausgewählt hat**? Der Walk-Forward
liefert mit `FreezeArtifact.scoreTable` bereits einen vollständigen
**Nachbarschafts-Scan** (eine Score-Zeile je Kandidat und Fenster, mit
`passedGates`, `rejectionReason` und vollen Metriken). Teil 2 wertet ihn aus:
die **Breite** des stabilen Bereichs, nicht den Optimum-Punkt. Reine
Funktionen über die Typen aus `src/backtest/walkforward.ts` — das Modul wird
**gelesen**, nie geändert; Kandidaten erzeugt weiterhin nur `runWalkForward`.

## 9. Plateau statt Optimum — `plateauMetrics()`

```ts
plateauMetrics(scoreTable, { selectedCandidateId? })
```

| Eingabe | Bedeutung |
|---|---|
| flache Tabelle (`CandidateScoreRow[]`) | **ein** Fenster (z. B. `FreezeArtifact.scoreTable`) |
| verschachtelt (`CandidateScoreRow[][]`) | Tabellen **aller** Fenster in Fenster-Reihenfolge (`freezeArtifacts.map(f => f.scoreTable)`) |
| `selectedCandidateId` | der eingefrorene Kandidat (Default: Erstplatzierter des **letzten** Fensters = Holdout-Kandidat aus `runWalkForward`); `null` schaltet die Rangauswertung ab |

| Feld | Bedeutung |
|---|---|
| `robustShare` | Anteil der Kandidaten mit `passedGates` in **allen** Fenstern — die Plateau-Breite |
| `neverShare` | Anteil der Kandidaten, die in **keinem** Fenster bestanden |
| `stableCount` | Anzahl stabiler Kandidaten |
| `selectedRankMedian` | Median-Rang des gewählten Kandidaten über die Fenster |
| `selectionStability` | `1 − (Median-Rang − 1) / (Feldgröße − 1)`, geklemmt auf `[0, 1]` |

**„19 von 20 Varianten funktionieren" ist ein Plateaubefund. „19 von 20 sind
ein Ausreißer, den 1 nicht" ist Fragilität.** Genau diesen Unterschied macht
`robustShare` maschinenlesbar: 1/5 ⇒ `0.2`, 19/20 ⇒ `0.95`, 20/20 ⇒ `1.0`.

Strikt ist dabei „in ALLEN Fenstern": Ein Kandidat, der in einem Fenster fehlt
oder dort die Gates verletzt, ist **nicht** stabil — zwei von drei Fenstern
genügen nicht. Die Rangfolge spiegelt die deterministische Sortierkette des
Walk-Forwards (`compareScoreRows`: Gates vor Score, dann NetPnl ↓, Trades ↓,
Max-Drawdown ↑, Kandidaten-ID ↑); eine flache Verkettung mehrerer Fenster wird
abgewiesen (doppelte `candidateId`), weil Fenstergrenzen ohne `windowIndex`
nicht rekonstruierbar sind — lieber ein Fehler als ein falscher Median.

## 10. IS/OOS-Lücke — `trainOosGap()`

```ts
trainOosGap({ is, oos, thresholds? })
// ⇒ { isSharpe, oosSharpe, gap, verdict: "OK" | "SUSPECT" | "BROKEN" | "UNKNOWN",
//      thresholds, evidence }
```

| Regel | Default | Begründung |
|---|---|---|
| `gap > suspectGap` ⇒ `SUSPECT` | `0.5` | Eine annualisierte Sharpe-Lücke über 0.5 ist größer als das, was Sampling-Rauschen bei 30-Tage-Fenstern typischerweise erklärt — die Selektion hat sich an IS-Eigenheiten angepasst. |
| `oosSharpe <= brokenOosAtOrBelow` ⇒ `BROKEN` | `0` | Die eingefrorene Konfiguration verdient ihr Risiko out-of-sample nicht. Das entscheidet **immer**. |
| Aggregat ohne Fenster | — | `UNKNOWN` mit Grund; `gap: null`. 0 Werte sind keine Aussage — nie „OK aus 0 Werten". |

**`isSharpe` allein entscheidet nie.** Ein brillantes `isSharpe = 9.5` mit
`oosSharpe = 0` ist `BROKEN`; ein negatives IS mit besserer OOS (`gap` negativ)
ist `OK`. Die IS-Zahl geht ausschließlich als Minuend in die Lücke ein — die
Aussage trägt immer die OOS-Seite. Grenzen sind konfigurierbar, aber
fail-closed: Werte außerhalb von `[0, 100]` bzw. `[-100, 100]` werden
geworfen, nicht geklemmt.

## 11. Multiple Testing — `multipleTestingWarning()`

| Kandidaten | Ergebnis |
|---|---|
| `n <= 5` | keine Warnung |
| `6…20` | `WARNING` im Report |
| `n > 20` | `WARNING` **BLOCKING** |

Die Begründung steht im Modul-Doc-Kommentar und ist bewusst **nicht**
konfigurierbar (`MULTIPLE_TESTING_THRESHOLDS`), damit sie niemand
„wegoptimiert": Die Selektion nimmt das **Maximum** über n Varianten. Unter der
Null wächst der erwartete Bestwert mit `√(2·ln n)` Standardfehlern
(`n = 5` ⇒ ≈ 1.79, `n = 20` ⇒ ≈ 2.45, `n = 50` ⇒ ≈ 2.80), und der
Familienfehler bei nominal 5 % je Test ist `1 − 0.95ⁿ` (≈ 23 % / 64 % / 92 %).
Bei 50 Kandidaten ist der beste per Zufall gut — `BLOCKING` heißt: kein `PASS`
ohne multiplizitätsfeste Evidenz (Plateau **und** OOS **und** unberührter
Holdout). Das ist keine Übervorsicht, das ist Statistik.

## 12. Holdout-Integrität — `holdoutIntegrity()`

```ts
holdoutIntegrity(holdout, freeze, reference?)   // freeze = letztes Freeze-Artefakt
```

| Prüfung | `CONTAMINATED`, wenn … |
|---|---|
| `HOLDOUT_AFTER_OOS` | `holdout.from < freeze.oosTo` — der Holdout überlappt die IS/OOS-Entscheidungen |
| `SELECTION_FROZEN` | `holdout.candidateId !== freeze.selectedCandidateId` — nach dem Holdout wurde (re)selektiert |
| `CANDLES_HASH` | `reference.candlesHash` übergeben und `freeze.dataManifest.candlesHash` weicht ab — die Kerzenreihe wurde nach dem Freeze verändert |

Ergebnis: `CLEAN | CONTAMINATED | UNKNOWN`; `CONTAMINATED` und `UNKNOWN`
ergeben `verdict: "INCONCLUSIVE"`, `CLEAN` ergibt `"CLEAR"` — und `CLEAR` ist
ausdrücklich **kein PASS**, die übrigen Gates entscheiden. Fehlende Artefakte,
fehlende oder nicht-sha256-förmige Hashes ⇒ `UNKNOWN` (nie „clean aus 0
Prüfungen"); `CONTAMINATED` schlägt `UNKNOWN`.

**Ohne `reference` ist „unverändert" nicht beweisbar.** Der Befund
`CANDLES_HASH` ist dann `UNVERIFIED` (Hash vorhanden, 64 Hex-Zeichen, 0
Vergleiche) und beeinflusst den Gesamtstatus nicht — die Evidenz sagt das
ausdrücklich, statt den Hash stillschweigend als sauber zu verbuchen.

## 13. Vollständigkeitsgrenze: `UNKNOWN` statt Scheinrobustheit

| Situation | Ergebnis |
|---|---|
| keine Score-Tabelle (`null`, `undefined`, leer) | `plateauMetrics().status === "UNKNOWN"` mit Grund; `robustShare: null` — **nicht** „robust, weil nur ein Kandidat geprüft wurde" |
| weniger als 2 Kandidaten oder leere Fenster-Tabelle | `UNKNOWN`; ein einzelner Kandidat ist kein Nachbarschafts-Scan |
| IS- oder OOS-Aggregat ohne Fenster | `trainOosGap().verdict === "UNKNOWN"`, `gap: null` |
| Holdout/Freeze oder Pflichtfelder fehlen | `holdoutIntegrity().status === "UNKNOWN"` ⇒ `INCONCLUSIVE` |

Kennzahlen ohne Stichprobe sind `null`, nie `0` — dieselbe Konvention, die der
Report (06-04) für `parameterFragility`/`Regime`-Zellen anwendet.

## 14. Abweichungen von der Prompt-Skizze

1. **`trainOosGap({ is, oos })` statt eines einzelnen Aggregats:** Die Lücke
   braucht **beide** Seiten; ein `WalkForwardAggregate` trägt genau einen
   Sharpe.
2. **Flache Tabelle = ein Fenster:** Die Auswertung über alle Fenster braucht
   die verschachtelte Form; eine flache Verkettung wird abgewiesen.
3. **`robustShare`/`neverShare` sind `number | null`:** `null` steht für „nicht
   auswertbar" (Regel aus 06-04: keine Stichprobe ⇒ `null`, nie `0`).
4. **`holdoutIntegrity(..., reference?)`:** „unverändert" ist nur gegen eine
   Referenz prüfbar; ohne sie `UNVERIFIED` statt stilles `CLEAN`.
5. **`TrainOosGap.verdict` kennt `UNKNOWN`** als vierten Wert (Aggregat ohne
   Fenster).
6. **Additive Felder** (`candidateCount`, `windowCount`, `status`, `summary`,
   `thresholds`, `evidence`, `blocking`) tragen den Grund im Report; der
   Prompt-Shape bleibt jeweils enthalten.

## 15. Tests

```bash
node --import tsx --test tests/strategyValidation.overfit.test.ts
```

39 Fälle, keine DB, kein Netz, keine Zeitabhängigkeit, kein
`runWalkForward`-Aufruf:

- **Plateau:** die drei Fixtures 1/5, 19/20, 20/20 mit drei unterscheidbaren
  `robustShare`-Werten; strikte „in ALLEN Fenstern"-Semantik; flache Tabelle
  als Ein-Fenster-Fall; Rangfolge inklusive Gates-vor-Score und Tie-Breakern;
  Standard-Auswahl (letztes Fenster) und expliziter Kandidat;
  `UNKNOWN`-Pfade (leer/`null`/ein Kandidat/leere Fenster-Tabelle); Ablehnung
  verketteter Fenster und unbekannter Kandidaten-IDs.
- **Lücke:** `BROKEN` trotz `isSharpe = 9.5`; `SUSPECT` ab 0.51, `OK` bei genau
  0.5; negatives IS mit besserer OOS ⇒ `OK`; Schwellen-Override; `UNKNOWN` bei
  0 Fenstern; fail-closed bei falschen Schwellen/Feldern.
- **Multiplizität:** `NONE`/`WARNING`/`BLOCKING` an den Grenzen 5/6 und 20/21
  sowie bei 50/100; ungültige Eingaben werden geworfen.
- **Integrität:** Überlappung ⇒ `CONTAMINATED` + `INCONCLUSIVE`; Grenze
  `from == oosTo` ⇒ `CLEAN`; Kandidatenwechsel; Referenz-Hash gleich/ungleich;
  `UNVERIFIED` ohne Referenz; `UNKNOWN` bei fehlenden/kaputten Fakten;
  `CONTAMINATED` schlägt `UNKNOWN`; feste Prüf-Reihenfolge.
- **Struktur:** Determinismus, Eingabe-Treue und ein statischer Wächter über
  den Modulquelltext — keine Uhr/Zufall/DB/Datei, **keine Wert-Importe** (nur
  Typen aus `walkforward.ts`) und keine Kandidatengenerierung.

---

# Teil 3 — Cost- & Slippage-Stress-Runner (`stress.ts`, STX-06-03, `v0.10.2`)

> **Modul:** [`src/strategies/validator/stress.ts`](../src/strategies/validator/stress.ts) (`COST_STRESS_VERSION = "stx06-cost-stress-v1"`) ·
> **Tests:** [`tests/strategyValidation.stress.test.ts`](../tests/strategyValidation.stress.test.ts) ·
> **Finding:** [STX-11](audits/2026-09-29-strategy-template-ausbau/findings/STX-11-cost-stress-existiert.md)

## 16. Zweischichtige Architektur — kein drittes Kostenmodell

Im Repository existieren bereits zwei Kosten-Schichten ([STX-11](audits/2026-09-29-strategy-template-ausbau/findings/STX-11-cost-stress-existiert.md)):

| Schicht | Baustein | Fachliche Frage |
|---|---|---|
| **Schicht 1 — In-Engine-Stress** | `runInEngineStress` + `summarizeStressSweep` über `BacktestEngineConfig` (`feeModel`, `slippageModel: "fixed"`, `fixedSlippageBps`) | **„Ist die Edge nach realen/gestressten Kosten noch da?"** — Ein geänderter Slippage-/Fee-Satz kann im echten Engine-Lauf andere Fills, Stop-Loss-Auslösungen oder Drawdown-Schwellen erzeugen als eine reine Nachberechnung auf bestehenden Trades |
| **Schicht 2 — Post-hoc-Stress** | `runPostHocStress` als dünner Durchreiche-Adapter auf `runMonteCarloSimulation` (`src/backtest/montecarlo.ts`, `MonteCarloStressConfig`) | **„Wie empfindlich ist die Pfadverteilung gegen Ergebnisrauschen unter skalierten Kosten?"** — Keine eigene Monte-Carlo-Implementierung |

Beide Ergebnisse stehen im kombinierten Report (`StressReport` / `StressSweepOk`)
unter den Schlüsseln `inEngine` und `postHoc` **strikt getrennt** nebeneinander
und werden niemals miteinander verrechnet.

## 17. Versionierter Szenario-Katalog (`COST_STRESS_SCENARIOS`)

```ts
export const COST_STRESS_SCENARIOS = [
  { id: "base",   feeMultiplier: 1, slippageBps: 5,  label: "Basis" },
  { id: "double", feeMultiplier: 2, slippageBps: 10, label: "2× Kosten" },
  { id: "triple", feeMultiplier: 3, slippageBps: 20, label: "3× Kosten" },
] as const;
```

**Annahmen vs. Messung:** Die `slippageBps`-Werte (`5 / 10 / 20 bp`) sind
normative Stress-Annahmen für den In-Engine-Sweep (`slippageModel: "fixed"`,
`fixedSlippageBps`), **keine** aus Live-/Paper-Fills gemessenen
Ausführungs-Slippages. Ob der Referenzlauf (`base`) tatsächlich Gebühren > 0
(`FEE_NONZERO`), Slippage > 0 (`SLIPPAGE_NONZERO`) und Gesamtkosten > 0
(`COST_NONZERO`) angesetzt hat, prüft vorab das deterministische
Annahmen-Audit aus Teil 1 ([§2](#2-die-elf-prüfungen), `STX-06-01`).

## 18. In-Engine-Sweep (`runInEngineStress`) & Fail-Closed-Regeln

Pro Szenario aus `COST_STRESS_SCENARIOS` führt `runInEngineStress(input)` genau
**einen** Walk-Forward-Lauf aus:

- **`base` ist byte-identisch zum Referenzlauf:** Für `base` (`feeMultiplier = 1`,
  `slippageBps = 5`) bleibt die Referenzkonfiguration unverändert (eigener
  flacher Klon ohne Mutation), sodass `WalkForwardReport`, `configHash`,
  `freezeArtifacts` und Trade-Liste byte-identisch zum Referenzlauf sind.
- **`double` & `triple` skalieren bestehende Konfigurationsfelder:**
  `feeModel.makerFee` und `feeModel.takerFee` werden mit `feeMultiplier` (`2×`,
  `3×`) skaliert; `slippageModel` wird auf `"fixed"` mit
  `fixedSlippageBps = scenario.slippageBps` (`10`, `20`) gesetzt.
- **`executionModel` bleibt unverändert:** Das Ausführungsmodell des
  Referenzlaufs (`"legacy" | "paper" | "event_replay"`) wird in allen drei
  Szenarien beibehalten.
- **Fail-Closed ohne stilles Hochrechnen (`validateReferenceCostConfig`):**
  - `slippageModel: "none"` im Referenzlauf ⇒ `{ ok: false, errors: ["stress:slippage-none — ..."] }`, **0 Runner-Aufrufe**.
  - `slippageModel: "fixed"` mit `fixedSlippageBps <= 0` oder `slippageModel: "spread_relative"` mit `spreadSlippageFactor <= 0` ⇒ `{ ok: false, errors: ["stress:slippage-zero — ..."] }`.
  - `feeModel` mit `makerFee === 0 && takerFee === 0` oder negativen Gebühren ⇒ `{ ok: false, errors: ["stress:fee-zero — ..."] }`, da `0 × 2 = 0` den Gebühren-Stress still neutralisieren würde.

## 19. Zusammenfassung, `breakevenMultiplier` & Verdikt-Grenzen (`summarizeStressSweep`)

`summarizeStressSweep(results, options?)` verdichtet die Szenarien zu
`StressSummary`:

| Feld | Formel / Semantik |
|---|---|
| `scenarios` | `readonly { id, sharpe, netPnl, maxDrawdownPct, trades }[]` aus `aggregateOos` je Szenario |
| `degradationRatio` | Erhaltener OOS-Sharpe-Anteil unter 3× Kosten: `round4(OOS-Sharpe(triple) / OOS-Sharpe(base))`. Ist `base.sharpe <= 0` (oder fehlt `base`/`triple`), ist `degradationRatio = null` |
| `breakevenMultiplier` | Gebühren-Multiplikator, ab dem `netPnl` auf `0` fällt, bestimmt per **linearer Interpolation** zwischen benachbarten Szenarien `(m_i, pnl_i > 0)` und `(m_{i+1}, pnl_{i+1} <= 0)`: $m_{\text{be}} = m_i + \frac{\text{pnl}_i}{\text{pnl}_i - \text{pnl}_{i+1}} \cdot (m_{i+1} - m_i)$. Ist `triple.netPnl > 0`, ist `breakevenMultiplier = null` — dokumentiert als **„hält mindestens 3×"**. Ist schon `base.netPnl < 0`, wird `0` (bzw. `1` bei `base.netPnl === 0`) geliefert, damit `null` eindeutig für „mindestens 3×" reserviert bleibt |
| `verdict` | `"COST_ROBUST" \| "COST_SENSITIVE" \| "COST_DEPENDENT"` gemäß `DEFAULT_STRESS_VERDICT_THRESHOLDS` |

### Verdikt-Schwellen (`DEFAULT_STRESS_VERDICT_THRESHOLDS`, konfigurierbar)

| Verdikt | Bedingung | Fachliche Bedeutung |
|---|---|---|
| `COST_ROBUST` | `degradationRatio >= 0.6` **und** `triple.netPnl > 0` | Mindestens 60 % des Basis-OOS-Sharpe bleiben unter 3× Gebühren / 20 bp Slippage erhalten und die Strategie verdient auch bei 3× Kosten noch Geld (`breakevenMultiplier === null`) |
| `COST_SENSITIVE` | `degradationRatio ∈ [0.3, 0.6)` (oder `degradationRatio >= 0.6`, aber `triple.netPnl <= 0`) | Spürbare Kostenerosion; Strategie bricht zwischen 2× und 3× Kosten Richtung Breakeven ein |
| `COST_DEPENDENT` | `degradationRatio < 0.3` oder `degradationRatio === null` | Scheinbare Edge hängt an niedrigen Kostenannahmen oder war schon im Basislauf nicht positiv |

## 20. Post-hoc-Stress (`runPostHocStress`) & Report-Trennung (`buildStressReport`)

- `runPostHocStress(inputOrTrades, options?)` akzeptiert `MonteCarloTradeInput[]`,
  `BacktestTradeLog[]` oder `WalkForwardTradeRecord[]` (standardmäßig auf Segment
  `"OOS"` gefiltert) und reicht sie direkt an `runMonteCarloSimulation`
  (`src/backtest/montecarlo.ts`) mit `stress: { feeMultiplier, slippageMultiplier }`
  durch.
- Für das 1×/1×-Basisszenario (`feeMultiplier === 1 && slippageMultiplier === 1`)
  übergibt `runPostHocStress` kanonisch `stress: null`, da
  `resolveMonteCarloConfig` ein explizites `{ feeMultiplier: 1, slippageMultiplier: 1 }`
  als No-Op ablehnt.
- `buildStressReport({ inEngine, postHoc })` legt beide Schichten unter getrennten
  Top-Level-Feldern (`report.inEngine` vs. `report.postHoc`) ab; `postHoc`
  verändert niemals `inEngine.verdict`, `inEngine.degradationRatio` oder
  `inEngine.breakevenMultiplier`.

## 21. Laufzeitkosten, `--max-runs` & Pilot-Budget

Ein Sweep über `Szenarien × Walk-Forward-Fenster × Kandidaten` multipliziert die
Backtest-Kosten. Deshalb gelten harte Obergrenzen:

- **Default-Bound (`DEFAULT_MAX_STRESS_RUNS = 45`):**
  `MAX_STRESS_SCENARIOS (3) × MAX_STRESS_WINDOWS (3) × MAX_STRESS_CANDIDATES (5) = 45` Läufe.
- **Hartes `maxRuns`-Argument:** Überschreitet `plannedRuns = scenarioCount × windowCount × candidateCount`
  den Wert `maxRuns`, bricht `runInEngineStress` **vor** dem ersten Runner-Aufruf
  mit `{ ok: false, errors: ["stress:max-runs-exceeded — ..."] }` ab.
- **CLI-Flag `--max-runs` (`parseMaxRunsFlag`):** Unterstützt `--max-runs=45`
  und `--max-runs 45` (Default `45`); Werte `< 1` oder Nicht-Ganzzahlen werden
  fail-closed mit `{ ok: false, errors }` abgewiesen.

### Laufzeitbudget im Pilot (nicht ausgereizt)

Gemäß [BENCH-BASELINE.md](audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md)
und [SCREENING-PILOT.md](audits/2026-09-29-strategy-template-ausbau/remediation/SCREENING-PILOT.md)
dauert ein einzelner Walk-Forward-Fensterlauf auf 500–900 Kerzen in-memory
ca. **2,4–5,0 ms** (ein kompletter 3-Fenster-Walk-Forward ca. **5,9–14,2 ms**):

| Modus | Rechnung (`Szenarien × Fenster × Kandidaten`) | Geplante Läufe | Geschätzte Laufzeit (Zeit pro Lauf × Runs) | Anteil am Cap (`maxRuns = 45`) |
|---|---|---|---|---|
| **Pilot-Standard (1 eingefrorener Siegerkandidat)** | `3 × 3 × 1` | **9** | `9 × ~2,5 ms ≈ 22 ms` (p95 `< 45 ms`) | **20 %** (bewusst nicht ausgereizt) |
| **Kleiner Nachbarschafts-Check (3 Kandidaten)** | `3 × 3 × 3` | **27** | `27 × ~2,5 ms ≈ 68 ms` (p95 `< 135 ms`) | **60 %** |
| **Harter Default-Deckel (`DEFAULT_MAX_STRESS_RUNS`)** | `3 × 3 × 5` | **45** | `45 × ~2,5 ms ≈ 115 ms` (p95 `< 225 ms`) | **100 % (Obergrenze)** |

## 22. Entscheidungen und Präzisierungen gegenüber der Prompt-Skizze (Teil 3)

1. **Richtung von `degradationRatio` (`OOS-Sharpe(triple) / OOS-Sharpe(base)`):**
   Der Kurzkommentar in Punkt 3 des Prompts notiert verkürzt
   `Ratio OOS-Sharpe(base) / OOS-Sharpe(3×)`, während Punkt 5 verbindlich
   `COST_ROBUST: degradationRatio >= 0.6`, `COST_SENSITIVE: [0.3, 0.6)` und
   `COST_DEPENDENT: darunter` vorschreibt. Da höhere Gebühren und Slippage den
   Sharpe senken (`Sharpe(3×) <= Sharpe(base)`), wäre `Sharpe(base) / Sharpe(3×)`
   für jeden positiven 3×-Sharpe stets `>= 1.0` und würde bei schrumpfendem
   3×-Sharpe gegen `Infinity` streben. Implementiert ist daher der **erhaltene
   Sharpe-Anteil** `OOS-Sharpe(triple) / OOS-Sharpe(base)`.
2. **`breakevenMultiplier` für bereits im Basislauf unprofitablen Lauf (`<= 1` statt `null`):**
   Da `breakevenMultiplier: null` laut Akzeptanzkriterium ausdrücklich für
   **„hält mindestens 3×"** (`triple.netPnl > 0`) steht, liefert ein bereits bei
   `base` (`1×`) unprofitabler Lauf `0` (bei `base.netPnl < 0`) bzw. `1` (bei
   `base.netPnl === 0`), damit `null` niemals mehrdeutig ist.
3. **1×/1×-Durchreiche in `runPostHocStress`:**
   `resolveMonteCarloConfig` in `src/backtest/montecarlo.ts` weist
   `stress: { feeMultiplier: 1, slippageMultiplier: 1 }` als No-Op zurück und
   verlangt für das Basisszenario `stress: null`. `runPostHocStress` bildet
   `1×/1×` deshalb automatisch auf `stress: null` ab, ohne `montecarlo.ts` zu
   verändern.

## 23. Tests (Teil 3)

```bash
node --import tsx --test tests/strategyValidation.stress.test.ts
```

22 Testfälle in 7 Suites (mit injiziertem Runner-Stub sowie echtem
`runWalkForward`-Abgleich):

- **Katalog & Architektur-Guards:** `COST_STRESS_SCENARIOS`, `DEFAULT_MAX_STRESS_RUNS = 45`,
  statischer Quelltext-Check (nur `runMonteCarloSimulation`, kein eigener RNG,
  Verweis auf `FEE_NONZERO`/`SLIPPAGE_NONZERO`).
- **Szenario-Skalierung & `executionModel`:** Skalierung von `feeModel` (`1×/2×/3×`
  ohne IEEE-754-Drift) und `fixedSlippageBps` (`5/10/20 bp`), Beibehaltung von
  `"legacy"`, `"paper"` und `"event_replay"`.
- **Byte-Identität von `base`:** sowohl gegen den injizierten Runner-Stub als
  auch gegen einen echten `runWalkForward`-Lauf auf synthetischen Kerzen.
- **Fail-Closed:** `slippageModel: "none"`, `fixedSlippageBps: 0`,
  `spreadSlippageFactor: 0` und `feeModel: { makerFee: 0, takerFee: 0 }` liefern
  `{ ok: false, errors }` bei 0 Runner-Aufrufen.
- **Zusammenfassung & Interpolation:** `COST_ROBUST`, `COST_SENSITIVE` (inkl.
  Abstufung bei `triple.netPnl <= 0`), `COST_DEPENDENT`, lineare Interpolation
  von `breakevenMultiplier` über alle Stützstellen sowie Schwellen-Override.
- **Laufzeit-Bounds:** Grenze 45 (`3 × 3 × 5`), Abbruch bei 54 (`3 × 3 × 6`) und
  explizitem `maxRuns`, CLI-Parser `parseMaxRunsFlag` für `--max-runs`.
- **Post-hoc-Durchreiche & Report-Trennung:** Byte-Gleichheit von
  `runPostHocStress` mit direktem `runMonteCarloSimulation`-Aufruf, Konvertierung
  von `WalkForwardTradeRecord[]` und strikte Trennung von `inEngine` und `postHoc`
  in `buildStressReport`.


## 24. Ein Report, drei Urteile — `StrategyValidationReport` (Teil 4)

Teil 1–3 stellen drei methodische Fragen; **Teil 4 (STX-06-04) führt sie in
genau eine Entscheidung zusammen und legt sie als Evidenz ab.** Der Report ist
reine Ausgabe — keine Gewichtung, kein Score, kein „knapp bestanden":

```ts
export const VALIDATION_RESULTS = ["PASS", "FAIL", "INCONCLUSIVE"] as const;
export type ValidationResult = (typeof VALIDATION_RESULTS)[number];
```

`buildValidationReport()` ist **rein** (keine Uhr, keine DB, kein Zufall) und
liefert den vollständigen, tief gefrorenen Bericht. Die vom Prompt geforderte
Form bleibt vollständig erhalten:

| Feld | Bedeutung |
| --- | --- |
| `result` | `PASS` \| `FAIL` \| `INCONCLUSIVE` — Ergebnis der Kette, laufzeitseitig geprüft (`assertValidationResult`). |
| `strategyKey`, `strategyVersion`, `strategyVersionId`, `templateId`, `templateVersion`, `class` | Identität und Provenienz des geprüften Stands (`StrategyClassKey`). |
| `metrics` | `sharpe`, `sortino`, `maxDrawdownPct`, `winRate`, `profitFactor`, `expectancy`, `netPnl` (`number \| null`) und `tradeCount` (`number`) — nie `NaN`/`Infinity`. |
| `robustness` | `parameterSensitivity` (= `1 − robustShare`), `costStress` (= `degradationRatio`), `slippageStress` (= Sharpe(3×)/Sharpe(2×), `null` statt Division durch 0), `regimeStability`. |
| `overfitting` | `trainOosGap`, `parameterFragility` (= `1 − selectionStability`), `multipleTestingWarning`, `lookaheadWarning`, `holdoutIntegrity` (`CLEAN` \| `CONTAMINATED` \| `UNKNOWN`). |
| `assumptions` | `{ id, status, evidence }[]` — die Prüfungen des Audits, unverändert durchgereicht. |
| `regimes` | `{ regime, trades, sharpe }[]` — siehe § 27. |
| `notes` | Freitext **nur für Menschen**; nie maschinell ausgewertet. |
| `evidenceHash`, `idempotencyKey` | `sle1:<sha256>` aus `evidenceContentHash()` bzw. `slei1:<sha256>` aus `evidenceIdempotencyKey()` (`strategyLifecycle/evidence.ts`) — **keine eigene Hashfunktion**. |
| `policyVersion`, `codeVersion`, `dataVersion` | `slp1:<sha256>` der Policy, `APP_VERSION`, Datenstand (oder `null`). |
| `eventTime`, `availableAt`, `computedAt` | Zeit-Semantik der Evidenz-Zeile; `buildValidationReport` erzwingt `eventTime ≤ availableAt ≤ computedAt` (DB-CHECK). `computedAt` ist **nie** ein Zulässigkeitskriterium. |

Additiv (Prompt-Form bleibt erhalten): `schemaVersion: "svr1"`, `windowStart`/`windowEnd`,
`backtestRunId`, `symbol`, `timeframe`, `dataQualityScore`, `gates[]`
(`{ id, step, status, evidence }` — auch die übersprungenen), `regimeEvidence`
(Zähler + Feature-/Modellversionen), `auditVersion` und `summary`.

`validationEvidenceInput()` übersetzt den Report in den `EvidenceInput`; das
Metrik-Snapshot trägt dabei auch den `data.quality`-Wert, damit der Lifecycle
sein eigenes Gate prüfen kann. Vor dem Schreiben prüft
`assertReportHashIntegrity()` beide Hashfelder — ein nachträglich veränderter
Report wird fail-closed abgewiesen.

## 25. Die achtstufige Gate-Kette — deterministisch und in dieser Reihenfolge

`VALIDATION_GATE_IDS` ist die Auswertungsreihenfolge. **Die erste Stufe, die
nicht `PASS` liefert, entscheidet**; alle späteren Stufen stehen als `SKIPPED`
im Protokoll und werden nicht ausgewertet. So kann kein sauberes Sharpe einen
vorher gefundenen Bruch überstimmen, und ein `FAIL` an früher Stelle wird nie
durch ein späteres „vielleicht" zu `INCONCLUSIVE` verwässert (und umgekehrt:
`INCONCLUSIVE` wird nicht durch einen späteren `FAIL` überstimmt — er wird gar
nicht mehr erreicht).

| # | Gate | `INCONCLUSIVE` | `FAIL` | `PASS` |
| --- | --- | --- | --- | --- |
| 1 | `ASSUMPTIONS` | Audit fehlt; `verdict = INCONCLUSIVE` (kritische Annahme verletzt/UNKNOWN oder irgendein UNKNOWN) | `verdict = FAIL` (BLOCKING verletzt, keine kritische Annahme) | `verdict = PASS` |
| 2 | `HOLDOUT_INTEGRITY` | Prüfung fehlt; `verdict = INCONCLUSIVE` (Status `CONTAMINATED` oder `UNKNOWN`) | — (Holdout-Kontamination ist ein „keine Aussage"-Fall, kein Edge-Beweis) | `verdict = CLEAR` |
| 3 | `DATA_SUFFICIENCY` | `tradeCount < MC_MIN_SAMPLE_TRADES (30)`; `oosWindows < 1`/fehlt; `sharpe`/`maxDrawdownPct`/`profitFactor` `null` | — | Stichprobe, OOS-Fenster und Kennzahlen liegen vor |
| 4 | `OOS_POLICY_GATES` | `evaluateBacktestGate` liefert `ok = false` ohne `FAIL`-Check (fehlende Fakten) | mindestens ein Check `FAIL` | `ok = true` (alle Checks `PASS`) |
| 5 | `TRAIN_OOS_GAP_AND_PLATEAU` | `gap`/`plateau` fehlt; `gap.verdict = UNKNOWN`; `plateau.status = UNKNOWN` oder `robustShare = null` | `gap.verdict ∈ {BROKEN, SUSPECT}`; `robustShare < minPlateauRobustShare` | Lücke akzeptabel **und** Plateau ≥ Grenze |
| 6 | `COST_STRESS` | Sweep fehlt (`stress = null`) | `verdict = COST_DEPENDENT` | `COST_ROBUST`/`COST_SENSITIVE` |
| 7 | `MULTIPLE_TESTING` | Auswertung fehlt | `blocking = true` (> 20 Kandidaten) | `NONE`/`WARNING` |
| 8 | `FINAL` | — | — | nur wenn alle sieben Stufen `PASS` waren (sonst `SKIPPED` mit Verweis auf die entscheidende Stufe) |

Die Stufen 1–3 fragen „sind die Fakten überhaupt belastbar?", 4–7 fragen
„trägt die Strategie die Bedingungen?". Fehlende Vorstufen (`null`) sind
grundsätzlich **`INCONCLUSIVE`, nie stilles `PASS`** — ein unvollständiger Lauf
darf nicht wie ein bestandener aussehen.

## 26. Grenzen der Gates — eine Quelle, kein Duplikat

Alle Schwellen kommen aus der bestehenden Promotion-Policy
(`src/strategyLifecycle/policies.ts`); der Validator definiert keine zweiten
Zahlen:

- **Stufe 4** nutzt unverändert `evaluateBacktestGate()` mit
  `DEFAULT_PROMOTION_POLICY`: `backtestMinTrades = 100`,
  `backtestMaxDrawdownPct = 25`, `backtestMinProfitFactor = 0.9`
  (`backtestMinWinRate = null`), `backtestMinDataQuality = 0.8`,
  `backtestMinDurationMs = 14 Tage`, `backtestEvidenceMaxAgeMs = 30 Tage`.
  Bewertungszeitpunkt ist `nowMs` (Default `availableAt`); die Frischeprüfung
  gehört dem Lifecycle zum Antragszeitpunkt, nicht dem Validator.
- **Stufe 3** nutzt `MC_MIN_SAMPLE_TRADES = 30` aus
  `src/backtest/montecarlo.ts` (dieselbe Stichprobengrenze wie der
  Post-hoc-Stress).
- **Stufe 5** nutzt `plateauMetrics()`/`trainOosGap()` aus `overfit.ts`
  (Gap: `BROKEN` bei `oosSharpe <= 0`, `SUSPECT` bei `gap > 0.5`) und die
  Plateau-Grenze `minPlateauRobustShare` (Default **0.5**).
  Deren **Gültigkeitsbereich** steht in der Lifecycle-Policy:
  `PROMOTION_POLICY_BOUNDS.validationMinPlateauShare = [0, 1]`;
  `resolveValidationGateBounds()` wirft außerhalb dieser Grenzen fail-closed.
  Der Vorgabewert selbst gehört zum Gate — die Policy liefert nur den Rahmen
  (Erweiterung aus 06-04, siehe Commit-Begründung).
- **Stufe 6** nutzt `DEFAULT_STRESS_VERDICT_THRESHOLDS` aus `stress.ts`
  (`robustMinRatio 0.6`, `sensitiveMinRatio 0.3`, `minTripleNetPnl 0`).
- **Stufe 7** nutzt `multipleTestingWarning()` (`NONE ≤ 5`, `WARNING 6–20`,
  `BLOCKING > 20`).

## 27. Regime-Aggregation — point-in-time, ohne `RANGE`-Fallback (ADR-009/ADR-E2)

`aggregateRegimeTrades()` ist rein und ordnet jedem Trade den **letzten
bestätigten** `regime_snapshots`-Eintrag mit `asOf <= Entry` zu (sortiert nach
`(asOf, featureVersion, modelVersion)`, deterministisch bei Gleichstand).
`evaluateRegimeOos` bleibt unverändert — es vermisst den **Markt**, nicht die
Strategie.

- Zulässige Zellen sind ausschließlich `REGIME_EVAL_LABELS` **ohne `UNKNOWN`**;
  ein `UNKNOWN`-Snapshot oder ein unbekanntes Label wird **ausgeschlossen und
  gezählt** (`unknownRegimeTrades`) — es gibt keinen `RANGE`-Fallback.
- Trades ohne passenden Snapshot sind `unattributedTrades`, ebenfalls gezählt
  und ausgeschlossen; `returnlessTrades` zählt Trades ohne `pnlPct` und ohne
  belastbares `pnl/notional`.
- Eine Zeile `{ regime, trades, sharpe }` entsteht nur für Zellen mit ≥ 1 Trade.
  `sharpe` ist `null` (nie `0`), solange die Zelle unter `minSampleTrades`
  (Default 30, kleinster Wert 2) liegt oder keine Streuung hat; berechnet wird
  der nicht annualisierte Per-Trade-Sharpe über dieselbe Kennzahl wie
  `portfolio/metrics.ts`.
- Das Aggregat trägt `featureVersions`/`modelVersions` der verwendeten
  Snapshots; `regimeStability` ist der Anteil der Zellen mit positivem Sharpe.

## 28. Evidenz schreiben und die CLI `npm run validate:strategy`

`writeValidationEvidence(report)` / `writeValidationEvidenceDetailed(report)`
rufen **ausschließlich** `recordEvidence()` aus `@/strategyLifecycle` auf — es
gibt keinen direkten DB-Zugriff und kein `requestTransition` in der
Validator-Domäne. Der Lifecycle-Schreibpfad garantiert Idempotenz: Ein zweiter
Lauf mit identischem Inhalt liefert dieselbe Zeile (`created: false`), der
UNIQUE-Index auf `content_hash`/`idempotency_key` hält, und parallele Schreiber
werden über die `23505`-Behandlung zusammengeführt.

Die CLI (`scripts/run-validate-strategy.ts`, `npm run validate:strategy -- …`):

```bash
npm run validate:strategy -- --strategy-version-id=<uuid> --from=<ISO|ms> --to=<ISO|ms>
npm run validate:strategy -- --create --template=<id> --symbol=<id> --timeframe=<tf> \
    --from=<ISO|ms> --to=<ISO|ms> [--params=<json>] [--max-runs=N] [--out=<pfad>] [--no-write]
```

- Genau eine Quelle: `--strategy-version-id` **oder** `--create`
  (letzteres braucht `--template`/`--symbol`/`--timeframe` und schließt
  `--no-write` aus, weil die angelegte Version über die Evidenz referenziert
  wird). `--params` akzeptiert ein Objekt oder ein Array von Objekten
  (Nachbarschafts-Scan, Obergrenze `MAX_STRESS_CANDIDATES = 5`).
- Der Lauf lädt Kerzen aus dem `HistoricalStore`, ruft `runWalkForward`,
  wertet 06-02 (Lücke/Plateau/Multiple Testing/Holdout), 06-03
  (`runInEngineStress`, Fehler nur geloggt ⇒ `stress = null` ⇒ `INCONCLUSIVE`)
  und 06-01 (`auditAssumptions`; Spread/Orderbuch-Tiefe bewusst `UNKNOWN`) aus
  und baut den Report. `--out` schreibt den Report als JSON.
- **Exit-Codes:** `0` nur bei `PASS`, `1` bei `FAIL`/`INCONCLUSIVE` oder
  Laufzeitfehler, `2` bei Bedienfehlern (unbekanntes Argument, fehlendes
  `--from`/`--to`, ungültige UUID …). `--max-runs` deckelt den Sweep (Default
  45 = `3 × 3 × 5`) und wird vor dem ersten Lauf geprüft.
- **Die CLI promoviert nie** — sie schreibt Evidenz und endet. Über Promotion
  entscheidet der Lifecycle (`evaluatePromotionGate` + `requestTransition`).

## 29. Entscheidungen und Präzisierungen gegenüber der Prompt-Skizze (Teil 4)

1. **`FINAL` ist eine Protokollzeile, kein achtes Prüf-Gate.** Die vom Prompt
   geforderte Kette endet logisch nach Schritt 7 (`else PASS`); `VALIDATION_GATE_IDS`
   führt `FINAL` als achte Stufe, damit das Protokoll jeden Ausgang explizit
   ausweist (bei `PASS` bestätigend, sonst `SKIPPED` mit Verweis).
2. **Holdout-Kontamination ist `INCONCLUSIVE`, nicht `FAIL`.** `integrity.verdict`
   kennt nur `CLEAR`/`INCONCLUSIVE`; ein kontaminierter oder unbekannter Holdout
   ist ein „keine Aussage"-Fall (Prompt-Schritt 2), kein Nachweis fehlender Edge.
3. **`slippageStress` als Verhältnis, `null` statt Division durch 0** — der
   Report enthält nie `Infinity`/`NaN`.
4. **Zusätzliche Felder sind additiv**, damit Provenienz (`backtestRunId`,
   Fenster), Auditierbarkeit (`gates`, `auditVersion`) und der
   Lifecycle-Check `data.quality` ohne zweiten Report möglich sind.
5. **`validationMinPlateauShare` in `PROMOTION_POLICY_BOUNDS`** ist die einzige
   Änderung an `src/strategyLifecycle/**`: Der Rahmen gehört zur Policy, der
   Default zum Gate — Begründung im Commit.

## 30. Tests (Teil 4)

```bash
node --import tsx --test tests/strategyValidation.report.test.ts
DATABASE_URL=postgresql://test:test@0.0.0.0:5432/test node --import tsx --test tests/strategyValidation.persist.test.ts
```

`tests/strategyValidation.report.test.ts` (32 Fälle):

- **Ergebnismenge:** `result` ist typ- und laufzeitseitig auf
  `PASS|FAIL|INCONCLUSIVE` begrenzt; `assertValidationResult` weist alles
  andere ab.
- **Je eine Regel der Kette:** Annahmen-FAIL, Annahmen-`INCONCLUSIVE`,
  Holdout-Kontamination, zu wenige Trades, fehlende OOS-Fenster,
  Policy-Gate-FAIL, fehlende Datenqualität, Gap `BROKEN`/`SUSPECT`/`UNKNOWN`,
  Plateau unter/über der Grenze, fehlendes Plateau, `COST_DEPENDENT`,
  `MULTIPLE_TESTING` blocking, vollständiger Durchlauf ⇒ `PASS`.
- **`INCONCLUSIVE` schlägt `FAIL`:** unklarer Audit + Policy-Verstoß + zu
  wenige Trades ⇒ `INCONCLUSIVE`, spätere Gates stehen als `SKIPPED`.
- **Skip-Semantik:** Nach der ersten nicht-`PASS`-Stufe wird keine weitere
  Stufe ausgewertet (auch kein späterer `FAIL` mehr gemeldet).
- **Regime (ADR-009):** `UNKNOWN`-Snapshot erzeugt keine Zeile; ein Trade ohne
  Snapshot wird gezählt und ausgeschlossen, nie `RANGE`; fehlende Streuung ⇒
  `sharpe = null`, nie `0`; Point-in-time: ein Snapshot **nach** dem Entry
  zählt nicht.
- **Hash/Guard:** Report-Hash ist stabil, Manipulation eines Feldes lässt
  `assertReportHashIntegrity`/`writeValidationEvidence` scheitern; statische
  Quelltext-Wächter (kein `Date.now`/`new Date`/Zufall/`@/db` in `report.ts`,
  kein `requestTransition(`-Aufruf in allen sechs Validator-Modulen).

`tests/strategyValidation.persist.test.ts` (6 Fälle, echtes PostgreSQL): genau
eine Evidenz-Zeile, `created true → false` beim Retry, parallele Schreiber
deduplizieren über UNIQUE, `content_hash`/`idempotency_key`/Zeitsemantik/
`sample_size`/Metriken stimmen, `availability`-CHECK hält, `INCONCLUSIVE` wird
ebenfalls geschrieben, und weder `strategy_lifecycle_transitions` noch
`strategy_lifecycle_states` erhalten eine Zeile (kein `requestTransition`).
