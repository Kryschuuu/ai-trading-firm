# STX-08-04 — `backtestRule()` auf den Indicator-Cache (mit Paritätsnachweis)

- **Phase:** 8 · **Paket:** eigenständig, aber **nach** 08-01…08-03 · **Finding:** [STX-12](../findings/STX-12-backtestrule-o-n-quadratisch.md)
- **Risiko:** **hoch** (Handelslogik, Ergebnis-Byte-Identität gefordert)

## Zweck

`backtestRule()` ist quadratisch und bleibt es: Bei 17 520 Kerzen kostet ein
Lauf 25 986 ms gegenüber 213,5 ms über die Engine — Faktor **121,7×**
(gemessen in [`../remediation/BENCH-BASELINE.md`](../remediation/BENCH-BASELINE.md),
Prompt 00-01). Das Screening umgeht den Pfad seit 05-04, aber der **Altpfad lebt
weiter** und bedient die UI:

- `src/lib/ruleEngine.ts:894` — pro Bar `candles.slice(0, i + 1)`
- `src/lib/ruleBacktest.ts:385` — ruft `backtestRule()` für den Referenzpfad
- `src/app/api/firm/rules/[id]/backtest/route.ts` — API-Endpunkt darüber

Dieser Prompt stellt `backtestRule()` auf den vorhandenen Cache um, **ohne** ein
Ergebnis zu verändern.

## Kontext — was schon da ist

Der Cache-Pfad ist gebaut, getestet und im Engine-Pfad im Einsatz:

```
src/backtest/indicatorCache.ts
  buildIndicatorCache(...)   // O(n), einmal pro Symbol
  snapshotFromCache(...)     // O(1) je Bar
```

Modulkopf `indicatorCache.ts:1-9` benennt exakt dieses Problem und diese Lösung.
`src/backtest/engine.ts` nutzt `buildIndicatorCache`/`snapshotFromCache` —
`src/lib/ruleEngine.ts` tut es **nicht** (`grep indicatorCache src/lib/ruleEngine.ts`
→ 0 Treffer).

**Zwei Snapshot-Pfade existieren** und müssen deckungsgleich bleiben:
`buildSnapshotFromCandles` (`ruleEngine.ts:675`) und `snapshotFromCache`
(`indicatorCache.ts`). Seit 02-02/02-03 ist diese Parität getestet
(`tests/backtest.multiAsset.test.ts`, Bar für Bar über drei Symbole) und seit
03-10 in `tests/strategies.templates.test.ts` festgenagelt.

## Auftrag

1. **Vor der Änderung:** friere einen Golden-Referenzlauf ein. Mindestens
   3 Symbole × 2 Timeframes × je eine Regel mit Stop/Target/Cooldown, jeweils
   als deterministischer Hash über Trades, Kennzahlen und Snapshots.
2. Stelle `backtestRule()` auf `buildIndicatorCache` + `snapshotFromCache` um.
   Der Cache wird **einmal** vor der Schleife gebaut; in der Schleife entfällt
   `candles.slice(0, i + 1)`.
3. **Feld-Parität prüfen, nicht annehmen:** `buildSnapshotFromCandles` und
   `snapshotFromCache` müssen für **jedes** `RULE_FIELDS`-Feld denselben Wert
   liefern — inklusive der `null`-Fälle (`vwapPct` bei < 2 Kerzen am UTC-Tag,
   `bookDepthUsd`, `spreadPct`, `donchianBreakoutPct`, die drei
   Bollinger-Felder). Jedes Feld ohne Cache-Äquivalent ist ein **Blocker**:
   entweder Cache ergänzen (mit eigenem Paritätstest) oder das Feld als
   dokumentierte Ausnahme führen.
4. `ruleEngine.ts` darf den Cache **nicht** neu implementieren — importieren.
5. Messung wiederholen (Muster `scripts/bench-backtest.ts`, Prompt 00-01) und
   das Ergebnis in [`../remediation/BENCH-BASELINE.md`](../remediation/BENCH-BASELINE.md)
   als Folgemessung ergänzen — alte Zahlen nicht überschreiben.

## Randbedingungen — nicht anfassen

- **Kein** Ergebnis darf sich ändern. Byte-Identität ist das Abnahmekriterium,
  nicht „ungefähr gleich".
- **Keine** Änderung an `sanitizeRuleSpec`, `RULE_FIELDS`, `RULE_CEILINGS`,
  `RULE_ALLOWED_SIDE`, `RuleAction`.
- **Keine** Änderung an `executionModel`; der Default bleibt `"legacy"`.
- **Kein** Entfernen einer `RULE_FIELDS`-Option
  ([`../VERSIONING.md`](../VERSIONING.md) §3 Regel 4).
- **Keine** Änderung am Screening-Pfad (`src/screening/**`) — der fährt weiter
  über `runMultiAssetBacktest()`.
- **Kein** `worker_threads`, keine Parallelisierung in diesem Prompt — erst die
  Einzel-Laufzeit, dann ggf. ein eigener Prompt.
- **Kein** Kafka/NATS/Redis/DuckDB ([STX-19](../findings/STX-19-info-kafka-einwand.md)).

## Abnahmekriterien

- [ ] Golden-Referenzlauf **vor** der Änderung eingecheckt und nach der Änderung
      identisch (Hash-Vergleich im Test, nicht nur Augenschein)
- [ ] Bar-für-Bar-Parität `buildSnapshotFromCandles` ↔ `snapshotFromCache` für
      **alle** `RULE_FIELDS`, über ≥ 3 Symbole und ≥ 2 Timeframes
- [ ] Jede `null`-Semantik bleibt erhalten (Test je Feld)
- [ ] `backtestRule()` enthält kein `candles.slice(0, i + 1)` mehr
- [ ] Gemessene Laufzeit bei n = 17 520 sinkt um mindestens eine Größenordnung
      gegenüber 25 986 ms; Zahl in `BENCH-BASELINE.md` dokumentiert
- [ ] `src/lib/ruleBacktest.ts` und der API-Pfad bleiben unverändert grün
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] [STX-12](../findings/STX-12-backtestrule-o-n-quadratisch.md) auf `FIXED`
      mit Version, Tests und PR

## Tests

```bash
npm test -- tests/ruleBacktest.test.ts tests/ruleEngine.test.ts tests/backtest.multiAsset.test.ts
npm test -- tests/strategies.templates.test.ts      # Engine-↔-Cache-Parität
npm run bench:backtest                              # Folgemessung
npm run typecheck && npm run lint
```

**Abbruchkriterium:** Weicht auch nur ein Feld ab, wird **nicht** „angepasst",
sondern der Prompt als blockiert zurückgegeben — mit dem abweichenden Feld,
zwei Beispielwerten und der betroffenen Kerzenposition. Eine nachträgliche
Anpassung des Golden-Hashes ist nur mit ausdrücklicher Freigabe erlaubt.
