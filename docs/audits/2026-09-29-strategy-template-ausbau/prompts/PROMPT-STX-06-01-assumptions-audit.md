# STX-06-01 — Deterministischer Annahmen-Audit

- **Phase:** 6 · **Paket:** 03-09 · **Finding:** STX-17
- **Risiko:** niedrig (reine Funktion)

## Zweck

Jede Strategie behauptet durch ihre Existenz, dass bestimmte Annahmen gelten. Dieser
Prompt prüft, ob diese Annahmen im konkreten Lauf **belegt** sind. Nicht: ob sie
sinnvoll sind — das ist eine Frage, die ein Mensch beantwortet. Sondern: hält der
Backtest die Bedingungen ein, unter denen die Strategie überhaupt eine Aussage ist?

## Kontext

Das Ausbaudokument §3.4 nennt eine Checkliste: `zero fees`, `zero spread`, `zero
slippage`, `instant fills`, `100% fill probability`, `lookahead`, `future indicator
values`, `future universe membership`, `survivorship bias`, `continuous futures without
roll`, `unrealistic crypto funding`.

Die **meisten** davon kann dieses Repo heute schon aus seinen eigenen Strukturen
**beweisen** — das ist der eigentliche Wert des Audits:

| Annahme | Wo sie im Repo nachweisbar ist |
|---|---|
| Gebühren/Slippage > 0 | `BacktestEngineConfig.feeModel`, `SlippageModel`, `fixedSlippageBps` |
| Spread ≠ 0 | `RuleSnapshot.spreadPct`, Scanner-Faktor `spread`, `bookDepthUsd` |
| Fills nicht instant | `event_replay`-Pfad: Latenz, Depth-Impact, Order-TTL, Partial Fills |
| Funding ≠ 0 | `replayFunding.ts`, `positions_funding` |
| Kein Look-ahead (Indikatoren) | `filterCandlesWithLeakageProtection` (`walkforward.ts:351`), `Cutoff`/`embargoMs`/`purgeMs` |
| Kein Look-ahead (Verfügbarkeit) | `AvailabilityPolicy "ingested"` in Feature Store und Cross-Sectional |
| Kein Survivorship | Universe-Registry + `EligibilityConfig` (Kandidaten werden **zum Zeitpunkt** bestimmt) |
| Vorhandene Datenqualität | `src/marketdata/quality`, `assessDataReadiness` (`src/scanner/warmup.ts`), `EligibilityConfig.maxStaleBars` |

## Auftrag

Lege `src/strategies/validator/assumptions.ts` an. Reine, IO-freie Funktion.

1. **`AuditInput`**: `{ template, version: RuleSpec, run: BacktestRunFacts, candles?: CandleFacts, config: RunConfigFacts }`

2. **`auditAssumptions(input): AssumptionAudit`**
   ```ts
   type AssumptionAudit = {
     checks: readonly AssumptionCheck[];
     violated: readonly AssumptionCheck[];   // status === "VIOLATED"
     unknown: readonly AssumptionCheck[];   // status === "UNKNOWN" — nicht prüfbar
   };
   type AssumptionCheck = {
     assumptionId: string;        // aus template.assumptions
     status: "HOLDS" | "VIOLATED" | "UNKNOWN";
     evidence: string;            // Klartext mit Zahl
     severity: "BLOCKING" | "WARNING";
   };
   ```

3. **Prüfungen (mindestens diese 10):**

   | ID | Prüfung | VIOLATED wenn |
   |---|---|---|
   | `FEE_NONZERO` | Gebühren im Lauf > 0 | `makerFee === 0 && takerFee === 0` |
   | `SLIPPAGE_NONZERO` | Slippage > 0 | `slippageModel === "none"` |
   | `SPREAD_MEASURED` | Spread wurde **gemessen** | `spreadPct === null` in ≥ X % der Snapshots |
   | `DEPTH_SUFFICIENT` | Buchtiefe trägt die Position | `bookDepthUsd === null` in ≥ X % der Snapshots |
   | `WARMUP_MET` | Warmup ausgereicht | `bars < requiredWarmupCandles(tf)` |
   | `TRADES_SUFFICIENT` | `trades >= MC_MIN_SAMPLE_TRADES` (30) | darunter ⇒ `UNKNOWN`, nicht `VIOLATED` |
   | `CAPS_RESpected` | `RULE_BACKTEST_TRADE_CAP`/`EQUITY_CAP` nicht erreicht | darüber |
   | `LEAKAGE_PROTECTED` | Walk-Forward lief mit Embargo/Purge | `embargoMs`/`purgeMs` fehlen bei OOS |
   | `INTRADAY_ONLY` | `vwapPct` wird nur genutzt, wo der Anker trägt | `vwapPct ∈ requiredFields && tf >= "1h"` (STX-01) |
   | `CHANGE_PCT_SEMANTICS` | `changePct24h` wird nicht als Tageswert gelesen | Feld in `requiredFields` ⇒ `WARNING` (STX-14) |

4. **`critical: true`-Regel:** Jede Annahme des Templates mit `critical: true`, die den
   Status `VIOLATED` oder `UNKNOWN` hat, macht das **Gesamtergebnis** zu
   `INCONCLUSIVE` — nicht `FAIL`. *Ein nicht prüfbarer Lauf ist kein Beweis gegen die
   Strategie.*

5. **Reihenfolge:** dieser Audit läuft **vor** allen Metrik-Auswertungen (06-02). Ein
   Lauf mit verletzter Gebührenannahme hat keinen informativen Sharpe.

## Akzeptanzkriterien

- [ ] Keine IO, keine Uhr, keine DB (nur injizierte `*Facts`)
- [ ] `TRADES_SUFFICIENT` liefert `UNKNOWN`, **nicht** `VIOLATED`, unter 30 Trades
- [ ] `critical: true` + `VIOLATED` ⇒ Gesamt-Status `INCONCLUSIVE`
- [ ] `tests/strategyValidation.assumptions.test.ts` ≥ 12 Fälle (10 VIOLATED-Pfade,
      3 UNKNOWN-Pfade, 1 HOLDS)
- [ ] `evidence` enthält **immer** eine Zahl (kein „vielleicht")
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine** Änderung an `montecarlo.ts`, `walkforward.ts`, `marketRegime.ts`.
- **Keine** LLM-Auswertung (06-05).
- **Keine** Metrik-Auswertung (06-02, 06-03).
- Keine Erzeugung von Annahmen — nur Prüfung der deklarierten.
