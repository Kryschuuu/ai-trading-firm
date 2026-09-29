# STX-06-02 — Overfit- & Robustheitsauswertung

- **Phase:** 6 · **Paket:** 06-01, 04-02 · **Finding:** STX-17
- **Risiko:** mittel (Statistik)

## Zweck

Die zentrale methodische Frage: funktioniert die Strategie, oder funktioniert **das
Parameterset, das man ausgewählt hat**? Das Ausbaudokument §3.3 nennt das richtig
(IS/OOS-Lücke, Parameterfragilität) — aber es existiert im Repo bereits mehr, als das
Dokument sieht.

## Kontext — vorhanden, nicht neu bauen

`src/backtest/walkforward.ts` liefert bereits:
- `WalkForwardCandidate` + `validateCandidates`
- `SelectorGates { minTrades, minWinRate, minSharpeRatio, minProfitFactor, maxDrawdownPct }`
- `CandidateScoreRow` — **eine vollständige Score-Zeile je Kandidat und Fenster**,
  mit `passedGates`, `rejectionReason` und vollen Metriken
- `FreezeArtifact` mit `scoreTable`, `candidateHash`, `freezeHash`, `dataManifest`
- `computeWalkForwardWindows`, `aggregateWindowEvals`, `filterCandlesWithLeakageProtection`
- `HoldoutReport` — ein **endgültiger, unberührter** Holdout

**Das ist bereits ein Nachbarschafts-Scan.** Was fehlt, ist die Auswertung: die
**Breite** des stabilen Bereichs, nicht der Optimum-Punkt.

## Auftrag

Lege `src/strategies/validator/overfit.ts` an. Reine Funktionen.

1. **`plateauMetrics(scoreTable: CandidateScoreRow[]): PlateauMetrics`**
   Aus der Score-Tabelle über alle Fenster:
   ```ts
   {
     /** Anteil der Kandidaten, die in ALLEN Fenstern die Gates bestanden haben. */
     robustShare: number;
     /** Anteil der Kandidaten, die in KEINEM Fenster bestanden haben. */
     neverShare: number;
     /** Anzahl stabiler Kandidaten. */
     stableCount: number;
     /** Median der Rangfolge des gewählten Kandidaten über die Fenster. */
     selectedRankMedian: number | null;
     /** 0..1: wie stabil ist der gewählte Kandidat relativ zur Menge? */
     selectionStability: number | null;
   }
   ```
   *Begründung der Metrik:* „19 von 20 Parametervarianten funktionieren" ist ein
   Plateau. „19 von 20 sind ein Ausreißer, den 1 nicht" ist Fragilität. `robustShare`
   ist genau das, maschinenlesbar.

2. **`trainOosGap(aggregate: WalkForwardAggregate): TrainOosGap`**
   ```ts
   { isSharpe, oosSharpe, gap, verdict: "OK" | "SUSPECT" | "BROKEN" }
   ```
   Grenzen **konfigurierbar**, Defaults mit Begründung: `gap > 0.5` ⇒ `SUSPECT`,
   `oosSharpe <= 0` ⇒ `BROKEN`. **`isSharpe` allein entscheidet nie.**

3. **`multipleTestingWarning(nCandidates: number): Warning`**
   - `n <= 5` ⇒ keine
   - `n <= 20` ⇒ `WARNING` im Report
   - `n > 20` ⇒ `WARNING` **BLOCKING** (bei 50 Kandidaten ist der beste per
     Zufall gut — das ist keine Übervorsicht, das ist Statistik)
   *Formuliere die Begründung im Doc-Kommentar, damit sie niemand „wegoptimiert".*

4. **`holdoutIntegrity(holdout: HoldoutReport, freeze: FreezeArtifact): IntegrityCheck`**
   - `holdout.from >= freeze.oosTo` — **sonst** ist der Holdout kontaminiert
   - `holdout.candidateId === freeze.selectedCandidateId` — keine Auswahl **nach** dem Holdout
   - `freeze.dataManifest.candlesHash` unverändert
   - Ergebnis: `CLEAN` | `CONTAMINATED` | `UNKNOWN`; `CONTAMINATED` ⇒ `INCONCLUSIVE`

5. **Vollständigkeitsgrenze:** Wenn **keine** `CandidateScoreRow`-Tabelle vorliegt
   (kein Walk-Forward gelaufen), ist das Ergebnis `UNKNOWN` mit Grund — **nicht**
   „robust, weil nur ein Kandidat geprüft wurde".

## Akzeptanzkriterien

- [ ] Keine IO, keine Uhr
- [ ] `plateauMetrics` auf einer Fixture-Tabelle mit 1/5, 19/20 und 20/20 stabilen Kandidaten ⇒ drei unterscheidbare Ergebnisse
- [ ] `oosSharpe <= 0` ⇒ `BROKEN`, unabhängig vom IS-Sharpe
- [ ] `nCandidates > 20` ⇒ BLOCKING
- [ ] `holdout.from < freeze.oosTo` ⇒ `CONTAMINATED`
- [ ] Fehlende Score-Tabelle ⇒ `UNKNOWN` + Grund
- [ ] `tests/strategyValidation.overfit.test.ts` grün
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine Änderung** an `walkforward.ts` — dieser Prompt **liest** die Strukturen.
- **Keine** neue Kandidatengenerierung (das ist `runWalkForward` mit
  `WalkForwardCandidate[]`).
- Keine LLM-Auswertung (06-05).
- **Keine** MC-Stress-Auswertung (06-03) — die beiden sind getrennte Prompts.
