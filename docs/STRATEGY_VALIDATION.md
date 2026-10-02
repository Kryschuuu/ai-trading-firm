# Strategie-Validierung — Annahmen-Audit & Overfit-Auswertung

> **Stand:** `v0.10.1` ·
> **Module:** [`assumptions.ts`](../src/strategies/validator/assumptions.ts) (Teil 1, STX-06-01) ·
> [`overfit.ts`](../src/strategies/validator/overfit.ts) (Teil 2, STX-06-02) ·
> **Tests:** [`tests/strategyValidation.assumptions.test.ts`](../tests/strategyValidation.assumptions.test.ts) (38) ·
> [`tests/strategyValidation.overfit.test.ts`](../tests/strategyValidation.overfit.test.ts) (39) ·
> **Prompts:** [STX-06-01](audits/2026-09-29-strategy-template-ausbau/prompts/PROMPT-STX-06-01-assumptions-audit.md),
> [STX-06-02](audits/2026-09-29-strategy-template-ausbau/prompts/PROMPT-STX-06-02-overfit.md) ·
> **Findings:** [STX-17](audits/2026-09-29-strategy-template-ausbau/findings/STX-17-info-validator-agent-kompatibel.md),
> [STX-01](audits/2026-09-29-strategy-template-ausbau/findings/STX-01-rule-timeframe-blocker.md),
> [STX-14](audits/2026-09-29-strategy-template-ausbau/findings/STX-14-changepct24h-semantik.md)

Jede Strategie behauptet **durch ihre Existenz**, dass bestimmte Annahmen gelten
(`StrategyTemplate.assumptions`, STX-03-01). Der Annahmen-Audit (Teil 1) prüft,
ob diese Annahmen im **konkreten Lauf belegt** sind — nicht, ob sie sinnvoll
sind (das entscheidet ein Mensch), und nicht, ob die Strategie Geld verdient
(das messen 06-02/06-03).

Die Overfit-Auswertung (Teil 2) stellt die zweite methodische Frage: ob nicht
das **Parameterset, das man ausgewählt hat**, funktioniert — statt der
Strategie selbst. Sie liest den vorhandenen Walk-Forward-Nachbarschafts-Scan,
baut aber nichts neu.

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
