# RMA-P2-04: Cross-Sectional Momentum Ranking

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-04`](../prompts/PROMPT-P2-04-cross-sectional-ranking.md)

## Verifizierte Fundstellen

- `src/marketdata/sync.ts::rankInstruments()` — operative Priorisierung beim Sync.
- `src/scanner/ranker.ts` — gewichteter Scanner-Gesamtscore über mehrere Faktoren.
- `src/scanner/factors/momentum.ts` — instrumentlokaler Momentumfaktor.
- Kein Modul persistiert universumsweite Momentum-Perzentile für einen gemeinsamen As-of-Zeitpunkt.

## Bewertung und Abgrenzung

Der Scanner kann Instrumente insgesamt sortieren und besitzt Momentum als einen Faktor. Das ist nicht der geforderte reine Querschnitt: Momentum wird nicht universumsweit relativiert und ist nicht als eigenständiger, historisch as-of-abfragbarer Rang verfügbar.

## Konkretes Delta

- Eligibility-Snapshot für ein liquiditätsgefiltertes Universum
- Returns über konfigurierbare Horizonte mit Skip-Period-Option
- Winsorizing, z-Score/Perzentil und stabile Tie-Breaks im Querschnitt
- as-of-sichere Rangpersistenz einschließlich Daten-/Config-Version
- Turnover-/Coverage-Metriken und Neutralisierung optionaler Gruppen

## Akzeptanzkriterien für `FIXED`

- [ ] alle Instrumente eines Rankings verwenden denselben As-of-Cutoff
- [ ] nachträglich verfügbare Daten verändern historische Ränge nicht
- [ ] Tie-Breaks sind stabil und unabhängig von Eingabereihenfolge
- [ ] unzureichende Historie wird explizit ausgeschlossen und mit Grund berichtet

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
