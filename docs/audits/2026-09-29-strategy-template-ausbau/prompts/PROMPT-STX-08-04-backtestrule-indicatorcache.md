# STX-08-04 — `backtestRule()` auf den Indicator-Cache (mit Paritätsnachweis)

- **Phase:** 8 · **Paket:** eigenständig, aber **nach** 08-01…08-03 · **Finding:** [STX-12](../findings/STX-12-backtestrule-o-n-quadratisch.md)
- **Risiko:** **hoch** (Handelslogik, Ergebnis-Byte-Identität gefordert)
- **Abschluss:** erledigt in `v0.11.0`; STX-12 FIXED; PR [#221](https://github.com/Kryschuuu/ai-trading-firm/pull/221).

## Ergebnis (2026-10-03)

`backtestRule()` baut den bestehenden Indicator-Cache genau einmal vor der Bar-Schleife auf. Die Goldens aus `bbfc799` blieben unverändert. Alle aktuellen `RULE_FIELDS` sind über 576 Bar-Snapshots (3 Symbole × 2 Timeframes) strikt identisch; Null-/Ungültigfälle sind explizit getestet. Die ergänzende synthetische 17 520-Bar-Messung zeigt 314,1× bei tiefergebnisgleichen Alt-/Neu-Rückgaben; sie ersetzt nicht die echte HistoricalStore-Baseline, deren Reihe hier fehlt.

**Gezielter Cache-Fix bei Null-ATR:** Vor der Korrektur war auf flachen Kerzen `atrPct` im direkten Snapshot `null`, im alten Cache-Snapshot `0` (ab dem ersten vollständigen ATR-Fenster, z. B. Fixture-Bar 24). Der Cache wurde so geändert, dass ATR = 0/ungültig ebenfalls `null` liefert; direkte Engine-Logik und Golden-Hashes wurden nicht angepasst. Ein `atrPct eq 0`-Signal wird damit bei flachen Kerzen fail-closed.

**Verifikation:** 144 fokussierte Tests bestanden; `npm run typecheck`, `npm run lint` und `npm run docs:validate` sind grün. Das vollständige `npm test` wurde auf ausdrückliche Nutzeranweisung übersprungen und wird nicht als bestanden behauptet.

## Zweck

**Ausgangslage beim Erstellen des Prompts (vor 08-04):** `backtestRule()` war
quadratisch. In der historischen Messung vom 2026-09-29 kostete ein Lauf bei
17 520 Kerzen 25 986 ms gegenüber 213,5 ms über die Engine — Faktor **121,7×**
([`../remediation/BENCH-BASELINE.md`](../remediation/BENCH-BASELINE.md), Prompt
00-01). Das Screening umging den Pfad seit 05-04, während der **Altpfad** weiter
die UI bediente:

- `src/lib/ruleEngine.ts:894` — pro Bar `candles.slice(0, i + 1)`
- `src/lib/ruleBacktest.ts:385` — ruft `backtestRule()` für den Referenzpfad
- `src/app/api/firm/rules/[id]/backtest/route.ts` — API-Endpunkt darüber

Dieser Prompt stellt `backtestRule()` auf den vorhandenen Cache um, **ohne** ein
Ergebnis zu verändern.

## Ausgangskontext vor 08-04

Der Cache-Pfad ist gebaut, getestet und im Engine-Pfad im Einsatz:

```
src/backtest/indicatorCache.ts
  buildIndicatorCache(...)   // O(n), einmal pro Symbol
  snapshotFromCache(...)     // O(1) je Bar
```

Modulkopf `indicatorCache.ts:1-9` benennt exakt dieses Problem und diese Lösung.
`src/backtest/engine.ts` nutzte `buildIndicatorCache`/`snapshotFromCache` —
`src/lib/ruleEngine.ts` importierte den Cache **damals** noch nicht (Pre-Fix-
Beobachtung, `grep indicatorCache src/lib/ruleEngine.ts` → 0 Treffer).

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

- [x] Golden-Referenzlauf **vor** der Änderung eingefroren und nach der Änderung identisch (SHA-256-Test; unveränderte Hashes aus `bbfc799`)
- [x] Bar-für-Bar-Parität für alle `RULE_FIELDS` über 3 Symbole × 2 Timeframes (576 Snapshots)
- [x] Null-/Ungültigsemantik je Feld getestet; ATR-Nullabweichung gezielt im Cache behoben, ohne Direktpfad/Goldens anzupassen
- [x] `backtestRule()` enthält kein `candles.slice(0, i + 1)` mehr und baut den bestehenden Cache nur einmal auf
- [x] Same-Series-Benchmark bei 17 520 Bars: 314,1×; echte HistoricalStore-Reihe fehlt, synthetische Folgemessung ist ausdrücklich kein Ersatz der offiziellen 25 986,2-ms-Baseline
- [x] `src/lib/ruleBacktest.ts`, API-/Referenzpfad und Screening-Pfad unverändert angebunden; fokussierte Regressionstests grün
- [x] 144 fokussierte Tests sowie typecheck, lint und docs:validate grün; das vollständige `npm test` wurde auf ausdrückliche Nutzeranweisung übersprungen
- [x] [STX-12](../findings/STX-12-backtestrule-o-n-quadratisch.md) auf `FIXED`, Version `v0.11.0`; PR [#221](https://github.com/Kryschuuu/ai-trading-firm/pull/221)

## Tests

Fokussierte Regressionstests (ohne Aufruf von `npm test`):

```bash
STARTING_EQUITY=10000 node --import tsx --test \
  tests/ruleBacktest.cacheGolden.test.ts \
  tests/ruleEngine.indicatorCacheParity.test.ts \
  tests/ruleBacktest.test.ts tests/ruleEngine.test.ts \
  tests/backtest.multiAsset.test.ts tests/strategies.templates.test.ts
npm run typecheck && npm run lint && npm run docs:validate
```

Die offizielle `npm run bench:backtest`-Messung auf HistoricalStore wurde nicht
wiederholt, da die Originaldatenreihe in diesem Checkout fehlt. Die ergänzende
synthetische Alt-vs-Neu-Messung steht mit Methodik und Caveat in
[`BENCH-BASELINE.md` §11](../remediation/BENCH-BASELINE.md#11-folgemessung-stx-08-04--einmaliger-indicator-cache-in-backtestrule).

**Abbruchkriterium:** Weicht auch nur ein Feld ab, wird **nicht** „angepasst",
sondern der Prompt als blockiert zurückgegeben — mit dem abweichenden Feld,
zwei Beispielwerten und der betroffenen Kerzenposition. Eine nachträgliche
Anpassung des Golden-Hashes ist nur mit ausdrücklicher Freigabe erlaubt.
