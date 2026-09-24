# bookDepthUsd + Orderbuch-Qualitätsgrenze je Venue — Umsetzung 2026-09-24

> **Status-Header:** **Umgesetzt** · **v0.4.0** · 2026-09-24 ·
> Quelle `arena` (Prioritäten-Auftrag: IAD-T-06 — höchster Daytrading-Nutzen
> unter den offenen Ideen, logische Fortsetzung von `spreadPct`) ·
> Branch `arena/01a0d3d5-ai-trading-firm` · Status-SSoT:
> [`remediation/TRACKING.md`](remediation/TRACKING.md)

## 1. Warum dieser Zyklus

`spreadPct` (v0.3.0) beantwortet nur „wie teuer ist der Touch?". Ein enger
Spread auf einem dünnen Buch (ein Level, dann nichts) ist für einen
Daytrader trotzdem teuer, sobald er größenordnungsmäßig handelt. Die offene
Idee `IAD-T-06` (`bookDepthUsd` als Regelfeld) schließt diese Lücke — unter
der Auflage, **dass** eine belastbare Qualitätsgrenze je Venue mitgeliefert
wird. Sonst würde die Regel das Rauschen (oder Fake-Liquidität) gewinnen.

## 2. Was gebaut wurde

### 2.1 `bookDepthUsd` als Regelfeld

- **Definition:** Tiefe der abriegelnden Seite `min(Σ bid×qty, Σ ask×qty)`
  in Quote-Währung (z. B. USDT). Die schwächere Seite ist die Engstelle.
- **Messpunkte:** `src/lib/bookDepth.ts` (`computeBookDepth`, rein
  deterministisch), verdrahtet in
  - `market-sync` (`enrichWithOrderBooks` misst aus denselben Depth-Levels
    wie der Spread — kein Extra-Request),
  - `MarketInstrument.bookDepthUsd` (Registry + Upsert + Spread-/Depth-Cache
    `data/spread-cache.json`, abwärtskompatibel zu v0.3.0-Dateien),
  - Mikro-Executor (`updateBook`, Live-Buch aus dem Binance-`@depth5`-Stream),
  - `RuleSnapshot`/`RULE_FIELDS`/`accessor`/`buildSnapshotFromCandles`/
    `snapshotFromCache` (Regel-Engine, Backtest),
  - `TrustedReading.bookDepthUsd` (Messwert für den technischen Analysten).
- **Fail-closed:** `null` (kein/gekreuztes Buch, einseitiges Buch, nur
  Null-Mengen, unter der Venue-Grenze) blockiert die Bedingung. Eine `0`
  wäre eine erfundene Tiefe und wird nie geliefert.

### 2.2 Qualitätsgrenze je Venue

`src/lib/bookDepthProvenance.ts` setzt die Grenze auf die **Erhebung**, nicht
auf den Messwert:

| Venue | Qualität | Tiefe |
| --- | --- | --- |
| BINANCE / BITUNIX / KRAKEN | `depth` (echtes Multi-Level-Buch) | ≥ 3 Levels je Seite, Snapshot ≤ 5 s ⇒ `VERIFIED` |
| YAHOO | `top` (Preise ohne Lotgröße) | nie (`UNQUALIFIED`) |
| sonst / PAPER-Presets | `none` | nie (`UNQUALIFIED`) |

Unbekannte Venues fallen auf `none` (nie auf `depth`) — eine Plug-and-play-
Venue ohne dokumentierte Buchqualität liefert keine erfundene Tiefe.

## 3. Nachweis

- `tests/bookDepth.test.ts` — 13 Fälle: min(bid,ask), Ordnungsunabhängigkeit,
  gekreuzt/einseitig/Null-Mengen → null, Kappung, kaputte Einträge,
  Venue-Qualitätsgrenze, `bookDepthVerdict`.
- `tests/ruleEngine.test.ts` — `bookDepthUsd` im Snapshot, Bedingung
  fail-closed (null/0/negativ ⇒ kein Fire), Whitelist-Eintrag.
- `tests/microExecutor.test.ts` — Snapshot-Durchreichung + End-to-End:
  dünnes Buch ⇒ kein Fire, `@depth5`-Buch ⇒ Fire.
- `tests/marketdata/enrichment.test.ts` — Tiefe nur bei belastbarem Buch,
  dünn/Yahoo ⇒ null.
- `tests/marketdata/spreadCache.test.ts` — Depth-Persistenz (kein
  Halb-Artefakt) + Abwärtskompatibilität alter Cache-Dateien.
- `tests/trustedIndicators.test.ts` — `bookDepthUsd` im Reading + `readBookDepth`.
- Grün: `npm run typecheck`, `npm run lint` (0 warnings), `npm test`
  (3629 Tests, 3593 pass, 0 fail, 36 skipped), `npm run test:security:next`
  (26), `npm run docs:validate` (8 Checks).

## 4. Bewusst nicht gebaut (aus den Audits)

- `IAD-T-07` Limit-/Stop-Markt/OCO am Broker — gehört in `src/execution`,
  nicht in die Regel-DSL.
- `IAD-T-08` Session-VWAP mit börsenlokaler Tagesgrenze — braucht einen
  Exchange-Kalender im Store.
- Shorts (`RULE_ALLOWED_SIDE=LONG`) bleiben Risikoentscheidung.
- `1m`-Backfill als Sync-Default — Request-Sturm.
