# Operations Center — Market-Data-Readiness & Funnel-Diagnose

> **Status-Header:** **Implementiert** (OPS-010) · **2026-08-30** ·
> Code-Version **1.27.0** · Module `src/ops/`, `src/scanner/eligibilityDiagnostics.ts`,
> `src/components/ops/OperationsCenterPanel.tsx` · Endpunkt `GET /api/ops`

Das Operations Center ist die Control Plane der Firma: zehn Sektionen
(Universum, Scanner, Portfolio, Research, Broker, LLM, Agenten, Risiko, Audit,
Hilfe), jede fail-soft aus einem bestehenden Modul aggregiert. Seit v1.27.0
ergänzt der strukturierte **Market-Data-Readiness-Report** (OPS-010) die
bisherige Funnel-Ansicht des Scanners um eine Diagnose **entlang der
Datenpipeline-Stufen** — Discovery → Enrichment → Backfill → Readiness.

---

## 1. Warum diese Sektion existiert

Bis v1.26 war nur der **Endzustand** des Scanner-Funnels sichtbar
(„Gescannt 26, Eligible 0, Interesting 0, Daily 0, Deep 0“). Sechs Nullen
sagen **nicht**, ob der Markt fachlich ungeeignet ist oder die Datenpipeline
nie gelaufen ist — und wenn Letzteres, nicht **wo** sie steckt. Die
Readiness-Sektion beantwortet genau das: Sie ist eine reine Aggregation aus
Instrument-Registry, Historical Store und Scanner-Konfiguration — ohne
Netzwerk-I/O, ohne neuen Zustand (Quelle:
`src/ops/marketDataReadiness.ts`, `collectMarketDataReadiness()`).

Anzeige im Dashboard (Tab „Operations Center“, Karte **Market Data** direkt
neben der Scanner-Karte):

```text
Market Data
───────────
Registry        26
Discovered      26
Data-ready      0
Warming         26
Candles         0 / 61
Ticker-ready    0
Spread-ready    0
Scanner-ready   NO
```

Bedeutung der Zeilen (Tooltip-Texte auch inline in der UI):

| Zeile | Bedeutung | Engpass-Hinweis |
| --- | --- | --- |
| `Registry` | Instrumente im Gesamtbestand (`registry.size`) | `0` ⇒ Discovery lief nie → `npm run market-sync` |
| `Discovered` | `lastSeen` ≤ 24 h alt (`DISCOVERY_FRESHNESS_WINDOW_MS`) | `< Registry` ⇒ Discovery-Daten veraltet → Sync neu anstoßen |
| `Data-ready` | Kerzen ≥ Mindestanzahl **und** Volumen bekannt **und** Spread bekannt | `0` bei voller Registry ⇒ Enrichment/Backfill fehlt |
| `Warming` | `Registry − Data-ready` | wie viele Instrumente noch auf Daten warten |
| `Candles X/Y` | X = Summe geladener Kerzen (Scanner-Timeframe `1h`), Y = Mindestanzahl **je Instrument** aus `requiredWarmupCandles()` (EMA50, Momentum60 → Default 61) | `X = 0` ⇒ kein Backfill durchgeführt oder fehlgeschlagen |
| `Ticker-ready` | `volume24h !== null` (Schritt `tickers`) | `0` ⇒ Ticker-Enrichment fehlt/fehlgeschlagen |
| `Spread-ready` | `spread !== null` (Schritt `depth`) | `0` ⇒ Orderbook-Enrichment fehlt → max-spread-Rejectionen |
| `Scanner-ready` | `YES` ⇔ `Data-ready > 0` | Mindestvoraussetzung für einen nutzbaren Scan |

## 2. Anleitung: „Wie diagnostiziere ich einen leeren Scanner-Funnel?"

Der Scanner-Funnel zeigt `Eligible 0` (bzw. durchgehend Nullen). Gehe die
Market-Data-Karte **von oben nach unten** durch — die erste Zeile, die vom
Erwartungswert abweicht, lokalisiert die Pipeline-Stufe:

1. **`Registry = 0`?**
   Die Registry ist leer → Discovery lief nie. `npm run market-sync`
   ausführen (Sync-Holz: `docs/MARKET_DATA_PIPELINE.md` §1).
2. **`Discovered < Registry`?**
   Der Bestand ist älter als 24 h → Sync veraltet oder abgebrochen. Sync
   erneut ausführen und dessen Exit-Code/Report prüfen.
3. **`Candles 0 / 61`?**
   Es wurden noch **keine** Kerzen geladen (Backfill fehlt) oder der
   Kerzenabruf ist fehlgeschlagen. Beides ist ein Betriebszustand, kein
   Markturteil:
   - Kein Sync: `npm run market-sync`.
   - Sync lief mit Fehlern: Scanner-Sektion → Readiness `ERROR` und Manifest
     `data/market-data-errors.json`; Klassifikation je Ursache
     (`RATE_LIMITED`, `UPSTREAM_5XX`, …) siehe
     [ERROR_HANDLING_MARKETDATA.md](ERROR_HANDLING_MARKETDATA.md) und
     [OBSERVABILITY.md](OBSERVABILITY.md).
4. **`Candles X / 61` mit `0 < X`, aber `Data-ready = 0`?**
   Backfill unvollständig **oder** Enrichment fehlt — weiter mit 5/6.
5. **`Ticker-ready = 0`?**
   Das `tickers`-Enrichment lief nie oder lieferte nichts → `volume24h` bleibt
   `null` → jedes Instrument scheitert an `min-volume` („24h-Volumen wurde
   nicht geladen“, Data-Quality).
6. **`Spread-ready = 0`?**
   Das `depth`-Enrichment lief nie → `spread` bleibt `null` → jedes
   Instrument scheitert an `max-spread` — **auch dann, wenn Kerzen und
   Volumen vollständig sind** (der Spread-Faktor hat keinen Kerzen-Fallback,
   `docs/MARKET_DATA_PIPELINE.md` §3).
7. **`Scanner-ready = YES`, aber der Funnel bleibt fachlich leer?**
   Dann liegen **echte** Markt-/Kostenfilter vor (Volumen zu klein, Spread zu
   breit, Extrem-Regime). Das ist die einzige Konstellation, in der „Eligible
   0“ ein fachliches Ergebnis ist. Belege liefert die Ablehnungs-Diagnose
   (§3): `dataQuality: false`.

## 3. Ablehnungs-Diagnose (Eligibility Diagnostics)

Unterhalb der Karte liegt die einklappbare **Ablehnungs-Diagnose**
(`eligibilityDiagnostics`): je abgelehntem Instrument die greifende Regel
plus den **vollständigen Datenzustand** zum Ablehnungszeitpunkt:

```json
{
  "instrument": "BITUNIX:BTCUSDT",
  "eligibility": {
    "status": "rejected",
    "rule": "max-spread",
    "dataQuality": true,
    "data": { "candles": 150, "volume24h": 2840000000, "spread": null }
  }
}
```

Lesart: 150 Kerzen (≥ 61 nötig), 2,84 Mrd. Volumen — aber `spread: null`.
Das ist **kein** „BTC ist ungeeignet“, sondern „Spread wurde nicht geladen“
→ depth-Enrichment nachfahren (`npm run market-sync`). Umgekehrt wäre
`dataQuality: false` mit z. B. `rule: "min-volume"` die fachliche Aussage
„24h-Volumen unter dem Schwellwert“.

> **Determinismus-Hinweis:** Das „erste Regel gewinnt“-Routing des
> Eignungsfilters ist unverändert — die Diagnose (`src/scanner/eligibilityDiagnostics.ts`)
> reichert die bestehenden Ablehnungen nur an und dient ausschließlich
> Monitoring/Debugging (siehe Dateikopf des Moduls).

## 4. API-Vertrag (additive Erweiterung, kein Breaking Change)

`GET /api/ops` liefert seit v1.27.0 zwei **neue, optionale** Felder;
Sektionen und Funnel-Metriken sind unverändert:

```jsonc
{
  "ok": true,
  "sections": [ /* unverändert: zehn Sektionen inkl. Scanner-Funnel */ ],
  "marketDataReadiness": {
    "venue": "ALL",
    "registryCount": 26,
    "discoveredCount": 26,
    "dataReadyCount": 0,
    "warmingCount": 26,
    "candlesLoaded": 0,
    "candlesRequired": 61,
    "tickerReadyCount": 0,
    "spreadReadyCount": 0,
    "scannerReady": false
  },
  "eligibilityDiagnostics": {
    "total": 26,
    "truncated": false,
    "items": [ /* EligibilityDiagnostic[] (max. 50) */ ]
  }
}
```

* Beide Felder sind `null`, wenn die Aggregation fail-soft fehlschlug —
  Sektionen und Funnel bleiben davon unberührt lesbar (kein „grün“ bei
  fehlenden Daten).
* `eligibilityDiagnostics.items` ist auf `MAX_ELIGIBILITY_DIAGNOSTICS` (50)
  gedeckelt; `total` zählt immer die volle Ablehnungszahl, `truncated`
  markiert die Kürzung.

## 5. Security & Performance

* **Keine sensiblen Daten:** Der Report enthält ausschließlich aggregierte
  Zähler; die Diagnose zusätzlich Instrument-IDs (`VENUE:SYMBOL`) mit
  Regel-ID und öffentlichen Marktmetriken (Kerzenzahl, 24h-Volumen,
  Spread). Keine API-Keys, keine interne Adapter-Konfiguration, keine
  Pfade/Hostnamen. Der Secret-Scan über den Payload ist Testbestandteil.
* **Kein Netzwerk-I/O:** Beide Felder aggregieren ausschließlich vorhandene
  In-Memory-/Persistenz-Zustände (Registry, Historical Store, letzter
  Scan). Ein Sync wird durch das Lesen des Cockpits nie ausgelöst.
* **Keine DoS-Fläche:** Die Aggregation ist ein linearer Durchlauf über den
  ohnehin gescannten Bestand (hart gekappt auf `MAX_SERVICE_INSTRUMENTS`);
  die Diagnose-Ausgabe ist auf 50 Einträge begrenzt (`total` bleibt
  vollzählig) — Antwortgröße und Rechenzeit sind damit nach oben
  beschränkt, unabhängig von der Universumsgröße.

## Verwandte Dokumente

* [MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md) — Discovery/Enrichment/Backfill, Readiness-Zustände, `$ npm run market-sync`
* [ERROR_HANDLING_MARKETDATA.md](ERROR_HANDLING_MARKETDATA.md) — Entscheidungsbaum bei Sync-Fehlern (`DATA_UNAVAILABLE`, Manifest)
* [OBSERVABILITY.md](OBSERVABILITY.md) — Fehlertaxonomie, Metriken, strukturierte Logs
