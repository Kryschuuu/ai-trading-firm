# RMA-P6-01: Point-in-Time Feature Store

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **7–12 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P6-01`](../prompts/PROMPT-P6-01-point-in-time-feature-store.md)

## Verifizierte Fundstellen

- `src/lib/marketdata/historicalStore.ts::HistoricalStore` — Rohkerzen nach Instrument/Timeframe mit Provenance.
- `src/lib/marketdata/historicalStore.ts::HistoricalCandleEntry` — Eventzeit und Fetch-Provenance.
- `src/scanner/artifacts.ts` und `src/cycle/artifacts.ts` — versionierte Ergebnisartefakte.
- Kein Feature-Registry-/Materialisierungs-/As-of-Join-Modul gefunden.

## Bewertung und Abgrenzung

Der Historical Store liefert ein gutes Rohdatenfundament. Er speichert aber keine Featuredefinition, keinen Berechnungszeitpunkt und keine Verfügbarkeitssemantik; dadurch ist eine Look-ahead-sichere Wiederverwendung berechneter Features nicht garantiert.

## Konkretes Delta

- Feature-Registry mit Name, semantischer Version, Schema und Code-/Config-Hash
- Werte mit Entity, `event_time`, `available_at`, `computed_at` und Provenance
- idempotente Batch-/inkrementelle Materialisierung
- Point-in-Time-Join API, die nur `available_at <= as_of` zulässt
- Offline-/Online-Paritätschecks, Retention und Backfill-Manifest

## Akzeptanzkriterien für `FIXED`

- [ ] synthetischer verspäteter Datensatz beweist Schutz gegen Look-ahead
- [ ] gleicher Feature-Key und gleiche Version sind idempotent
- [ ] Definitionen sind immutable; Änderungen erzeugen neue Version
- [ ] Abfrage ist begrenzt, indexiert und berichtet Missingness explizit

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
