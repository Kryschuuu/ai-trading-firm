# Operations — Runbook „Funnel ist leer“

> **Status-Header:** **Implementiert** (OPS-011) · **2026-08-31** ·
> Code-Version **1.33.0** · Module `src/ops/collectMarketData.ts`,
> `src/marketdata/syncStatus.ts`, `src/components/ops/MarketDataPanel.tsx` ·
> Endpunkt `GET /api/ops` (read-only)

Dieses Runbook beantwortet die häufigste Betriebsfrage des Scanners:
**„Der Funnel zeigt sechs Nullen — was jetzt?“** Seit v1.33.0 zeigt das
Operations Center dafür die Sektion **„Market Data“ oberhalb des Funnels**
(Payload-Feld `marketData`, Typ `MarketDataOpsSnapshot`). Sie unterscheidet
die drei Fälle, die vorher ununterscheidbar waren:

1. **„Wir haben keine Kerzen geladen“** → `WARMING` (Warmup, behebbar per Sync)
2. **„Der Ticker-/Depth-Abruf ist ausgefallen“** → `ERROR` (Infrastruktur)
3. **„Der Markt bietet aktuell nichts Geeignetes“** → `READY` (fachlich korrekt)

Der Funnel selbst bleibt unverändert erhalten; bei `WARMING`/`ERROR` erklärt
das Panel explizit, dass dessen Nullen datenbedingt sind.

---

## 1. Entscheidungsbaum

Lies die Zeile `Scanner-ready` der Market-Data-Sektion und folge dem Baum von
oben nach unten — der **erste** zutreffende Ast ist der dominierende Blocker
(dieselbe Reihenfolge implementiert `buildReadinessHint()` in
`src/ops/collectMarketData.ts`):

```text
Scanner-ready = NO?
│
├─ Fehler-Counter > 0 (Status ERROR)?
│    → Venue-Incident: Market-Data-Abrufe schlagen fehl (z. B. RATE_LIMITED,
│      UPSTREAM_5XX, TIMEOUT). Der leere Funnel ist ein Infrastrukturproblem,
│      keine Marktbewertung.
│      Nächster Schritt: Venue-Status und Request-Budget prüfen
│      (docs/OBSERVABILITY.md, docs/ERROR_HANDLING_MARKETDATA.md);
│      danach Sync wiederholen. Ein fehlerfreier Lauf löscht das
│      Fehler-Manifest (data/market-data-errors.json).
│
├─ Candles 0 / 61 (keine Kerzenhistorie, Status WARMING)?
│    → Sync ausführen:  npm run market:sync -- --venue=BITUNIX
│      Benötigt werden 61 Kerzen je Instrument (dynamisch aus dem Faktorsatz:
│      EMA50 + Momentum-Lookback 60 + 1 Referenzkerze, requiredWarmupCandles()).
│
├─ Spread-ready = 0 bei vorhandenen Kerzen (Status WARMING)?
│    → Depth-Abruf prüfen: der Spread stammt aus dem Orderbook
│      (/market/depth) — der Ticker-Endpoint liefert ihn nicht. Ohne Spread
│      lehnt der Scanner mit rule=max-spread ab (Datenqualität, nicht
│      Marktqualität). Siehe docs/MARKET_DATA_PIPELINE.md §3.
│
├─ Warming > 0 (Teil-Warmup, Status WARMING)?
│    → „Worst offenders“ aufklappen: die Tabelle nennt die Instrumente mit
│      den wenigsten Kerzen. Sync erneut ausführen; einzelne Symbole gezielt:
│      npm run market:sync -- --venue=BITUNIX --symbols=BTCUSDT
│
└─ Scanner-ready = YES (Status READY) und trotzdem Eligible 0?
     → Fachliche Bewertung: Datenbasis vollständig — ein leerer Funnel ist
       hier eine echte Aussage der Eignungsfilter (Markt/Kosten). Details je
       Instrument: Ablehnungs-Diagnose (eligibilityDiagnostics) in der
       Market-Data-Karte bzw. docs/OPERATIONS_CENTER.md §3.
```

## 2. Die Sektion „Market Data“ im Detail

```text
Market Data                        Nach erfolgreichem Sync
────────────                       ────────────
Registry        26                 Registry        42
Discovered      26                 Discovered      42
Data-ready       0                 Data-ready      42
Warming         26                 Warming          0
Candles       0 / 61               Candles      42 / 61
Ticker-ready     0                 Ticker-ready    42
Spread-ready     0                 Spread-ready    42
Scanner-ready   NO                 Scanner-ready  YES
```

| Zeile | Herkunft | Sollwert |
| --- | --- | --- |
| `Registry` | Instrument-Registry (`registry.size`) | > 0 (Seed/Discovery) |
| `Discovered` | `lastSeen` ≤ 24 h | = Registry |
| `Data-ready` | Instrumente mit ≥ `requiredCandles` Kerzen im Scanner-Timeframe (`data/history`) | = Registry |
| `Warming` | `Registry − Data-ready` | 0 |
| `Candles X/Y` | X = Instrumente mit vollständiger Historie, Y = benötigte Kerzen **je Instrument** (`requiredWarmupCandles()`) | X = Registry |
| `Ticker-ready` | `volume24h ≠ null` (Ticker-Enrichment) | = Registry |
| `Spread-ready` | `spread ≠ null` (Orderbook-/depth-Enrichment) | = Registry |
| `Scanner-ready` | `YES` ⇔ Status `READY` (alles vollständig) | YES |

Dazu zeigt das Panel:

* **Letzter Sync je Venue** — Zeitpunkt, `degraded`-Flag und Fehlerzähler
  nach Ursache (geschlossene MDERR-006-Taxonomie). Quelle:
  `data/market-sync-status.json`, geschrieben vom Sync-CLI
  (`src/marketdata/syncStatus.ts`). Nie gesynct = `lastSyncAt: null`.
* **Worst offenders** (ausklappbar) — bis zu 10 Instrumente mit den
  wenigsten Kerzen, deterministisch sortiert.
* **Hinweistext** — genau ein handlungsleitender Satz je dominierendem
  Blocker (`buildReadinessHint()`), zentral implementiert statt in der UI
  verstreut.

## 3. Sicherheits- und Betriebsgrenzen

* **Read-only:** `GET /api/ops` liest nur; es gibt **keinen** Endpoint, der
  einen Sync auslöst. Ein Sync läuft ausschließlich über die CLIs
  (`npm run market:sync`, `npm run scan -- --sync-first`).
* **Keine Secrets:** Der Snapshot enthält Zähler, ISO-Zeitstempel,
  Instrument-IDs und klassifizierte Fehler-Ursachen — keine Credentials,
  keine Env-Variablen, keine internen Dateipfade, keine Stacktraces, keine
  rohen Upstream-Messages.
* **Gekappte Antwort:** `venues` und `worstOffenders` sind auf je 10
  Einträge begrenzt; der persistierte Sync-Status validiert Venue-Namen und
  die geschlossene `reason`-Aufzählung beim Laden.
* **Fail-soft:** Schlägt die Aggregation fehl, steht `marketData: null` im
  Payload — Funnel und übrige Sektionen bleiben lesbar.

## Verwandte Dokumente

* [`OPERATIONS_CENTER.md`](OPERATIONS_CENTER.md) — Diagnose-Walkthrough und API-Vertrag des Operations Centers
* [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) — Discovery, Enrichment, Backfill, Readiness (§6)
* [`OBSERVABILITY.md`](OBSERVABILITY.md) — Fehler-Metriken und Alerting (MDERR-006)
* [`ERROR_HANDLING_MARKETDATA.md`](ERROR_HANDLING_MARKETDATA.md) — Fehlertaxonomie und Behandlung
