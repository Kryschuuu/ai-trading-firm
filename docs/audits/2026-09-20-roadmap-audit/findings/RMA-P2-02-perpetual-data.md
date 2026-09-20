# RMA-P2-02: Perpetual-Daten: Funding, OI und Liquidationen

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **5–8 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-02`](../prompts/PROMPT-P2-02-perpetual-data.md)

## Verifizierte Fundstellen

- `src/scanner/types.ts::DerivativeContext` — Funding- und Open-Interest-Felder.
- `src/scanner/factors/funding.ts::fundingFactor` und `src/scanner/factors/openInterest.ts::openInterestFactor` — Faktoren mit neutralem Missing-Fallback.
- `src/lib/funding.ts::FundingAccrualEngine.dueAccruals()` und `runFundingAccrual()` — Funding-Ledgerlogik.
- `src/contracts/broker.ts::BrokerAdapter` — kein normalisierter historischer Perp-Marketdata-Port.

## Bewertung und Abgrenzung

Downstream-Faktoren und Funding-Buchhaltung sind implementiert. Es gibt aber keine verlässliche End-to-End-Ingestion samt historischer Ablage; Liquidationen sind weder im kanonischen Context noch als Zeitreihe modelliert.

## Konkretes Delta

- adapterübergreifender Vertrag für Funding, OI und Liquidationsereignisse
- normalisierte Einheiten, Vorzeichen, Venue/Symbol-Mapping und Event-/Available-Time
- idempotente historische Persistenz, Backfill und inkrementeller Sync
- Staleness-, Gap-, Outlier- und Cross-Venue-Checks für Perp-Daten
- as-of-Abfrage für Scanner, Backtest und Agenten

## Akzeptanzkriterien für `FIXED`

- [ ] keine Vermischung von Contract-, Base- und Quote-Einheiten
- [ ] Backfill plus Live-Sync erzeugt keine Duplikate
- [ ] Backtest liest ausschließlich Daten, die zum Simulationszeitpunkt verfügbar waren
- [ ] fehlende/stale Perp-Daten werden als unavailable statt Null behandelt

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
