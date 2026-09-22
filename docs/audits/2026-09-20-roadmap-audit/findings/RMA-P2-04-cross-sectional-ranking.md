# RMA-P2-04: Cross-Sectional Momentum Ranking

- **Antwort:** Ja (v1.63.0)
- **Tracking-Status:** `FIXED` (v1.63.0, Commit `c03ee05`)
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

- [x] alle Instrumente eines Rankings verwenden denselben As-of-Cutoff
- [x] nachträglich verfügbare Daten verändern historische Ränge nicht
- [x] Tie-Breaks sind stabil und unabhängig von Eingabereihenfolge
- [x] unzureichende Historie wird explizit ausgeschlossen und mit Grund berichtet

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)

## Umsetzung (v1.63.0)

- **Modul `src/crossSectional/` (Code-Version `cross-sectional@1`, Config v1):**
  Universe-Eligibility mit geschlossenen Exclusion-Gründen (`INACTIVE` …
  `INVALID_INPUT`), Momentum-Renditen über versionierte Horizonte
  (Default `h72`/`h168`/`h336` auf 1h, Gewichte 0.2/0.3/0.5, Skip-Period),
  Querschnitt Winsorize → z → Composite → Rang (Tie-Break: kanonische
  Instrument-ID) → Perzentil `(n−rank+1)/n`. Deterministische Snapshot-ID
  `xs1:<sha256(v1|timeframe|asOf|universeHash|dataHash|configHash|codeVersion)>`;
  gleicher fachlicher Key ⇒ gleicher Idempotenz-Key ⇒ nie zweite Zeile.
- **Point-in-Time ohne Look-ahead (Policy `ingested`):** nur Kerzen mit
  `barEnd ≤ asOf` **und** `fetchedAt ≤ asOf`; späterer Backfill ist für alle
  früheren as-of-Zeitpunkte strukturell unsichtbar — historische Ränge ändern
  sich durch spätere Daten nie (Look-ahead-Test: State „Bar fehlt“ vs. „Bar
  spät backgefillt“ ⇒ byte-identische Snapshots).
- **Persistenz:** append-only, zweifach anwendbare Migration
  `drizzle/2026-09-22_cross_sectional_ranking.sql` (`cross_sectional_snapshots`
  + `cross_sectional_rankings`), `value_hash`-Konflikt-Guard (abweichende
  Zeilen werden protokolliert, **nie** überschrieben), PIT-Load
  (`as_of ≤ asOf`), Stabilität/Turnover gegen den Vorgänger (Top-K-Overlap,
  Rank-Shift, Common-Count), Retention-Pruning mit FK-Cascade (keine
  Orphane). Parallel deterministische Artefakte
  `artifacts/cross-sectional/YYYY-MM-DD/<snapshotId>.json` als
  Cross-Prozess-Medium der Scanner-Integration.
- **Scanner-Integration (additiv, Gewicht 0):** Diagnose-Faktor
  `crossSectionalMomentum` (15. Faktor): `normalized = percentile`,
  `raw = composite`, Provenienz im Detail; ohne Snapshot/stale/Flag aus ⇒
  explizit `unavailable` mit Neutralwert 0.5 (nie 0-Momentum). Dokumentierte
  Gewichtsentscheidung: Score-Gewicht 0 — der Market Score ist mit/ohne
  Cross-Sectional-Karte nachweislich identisch (Invarianz-Test), kein stilles
  Doppeltzählen des instrument-lokalen `momentum`.
- **Ops & Observability:** CLI `npm run research:cross-sectional`
  (`--as-of`, `--dry`, `--top`; Exit 0/1 fail-loud), read-only
  `GET /api/research/cross-sectional` (PIT über `?asOf`; 200/NO_SNAPSHOT,
  400, 503 generisch); bounded Metriken `cross_sectional_runs_total{result}`,
  `cross_sectional_persist_total{persist}`, `cross_sectional_rank_conflicts_total`
  (keine IDs als Labels) + Audit-Events `cross_sectional_snapshot_persisted`,
  `cross_sectional_ranking_conflict`.
- **Tests (50 neue):** `tests/crossSectional.unit.test.ts` (22),
  `tests/crossSectional.db.test.ts` (8, eingebettete Postgres),
  `tests/crossSectional.api.test.ts` (16), `tests/crossSectional.scanner.test.ts`
  (4). Gesamtsuite: `npm test` 3120 Tests: 3084 pass / 0 fail / 36 Skip
  (Umgebungs-DB); typecheck/lint (0 Errors)/docs:validate grün.
- **Doku:** [`docs/CROSS_SECTIONAL_RANKING.md`](../../CROSS_SECTIONAL_RANKING.md)
  (Architektur, Zeitsemantik, Eligibility, Formeln, Identität/Persistenz,
  Scanner-Integration, Operations, Monitoring, Testmatrix, Grenzen),
  `docs/DAILY_WEEKLY_RESEARCH.md` (15. Faktor, Gewicht 0),
  `docs/architecture/PIPELINE_MAP.md`, `docs/HANDBUCH.md`,
  `docs/help/scanner.help.json`, `CONFIGURATION.md`, `.env.example`,
  `CHANGELOG.md` (v1.63.0).
- **Evidenz:** Fix-Version v1.63.0, Commit `c03ee05`; Rollback: Redeploy auf
  v1.62.0 oder `CROSS_SECTIONAL_ENABLED=false` (exaktes Vor-Verhalten).
- **Bewusst nicht Teil (Scope-Grenze PROMPT-P2-04):** survivorship-bias-freie
  Universums-Rekonstruktion (Lücke dokumentiert, Survivorship-Note je
  Snapshot), implizite Order-Generierung, Ersatz des Scanner-Rankers.
