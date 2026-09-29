# STX-04 — `MultiAssetStrategySpec` dupliziert `CrossSectionalConfig`

- **ID:** STX-04
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §1.9
- **Status:** FIXED — durch Entscheidung ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3), 00-03, `v0.6.1`); die Sizing-Schicht liegt bewusst außerhalb der Roadmap
- **Datei(en):** `src/crossSectional/types.ts`, `src/portfolio/volatilityTargeting.ts`

## Beschreibung

§1.9 definiert eine neue `MultiAssetStrategySpec` mit `ranking`, `selection`, `rebalance`,
`sizing`. Vier von fünf Feldern existieren bereits in einer PIT-validierten,
hash-versionierten Konfiguration.

## Beweis / Mapping

| Dokument | Repo (`src/crossSectional/`) |
|---|---|
| `ranking: { metric, lookback, direction }` | `CrossSectionalConfig.horizons: MomentumHorizonConfig[] { id, lookback, skip, weight }` |
| `selection: { minLiquidityUsd }` | `EligibilityConfig { minVolume24h, minCandles, maxStaleBars, assetClasses, maxUniverseSize }` (Volumen in Quote-Währung) |
| `selection: { topN }` | **fehlt** — `maxUniverseSize` kappt nach `volume24h` (Liquidität), nicht nach Composite-Rang; die Rang-Auswahl ist Parameter der `PortfolioConstruction` |
| `rebalance: { timeframe: "1d" }` | `CrossSectionalConfig.timeframe` + `AvailabilityPolicy` |
| PIT-Semantik | `SnapshotTimestamps { asOf, computedAt }` + `AvailabilityPolicy: "ingested" \| "bar_close"` |
| `sizing: { mode: "INVERSE_VOLATILITY" }` | **fehlt** — einziger echter Zugewinn. `src/portfolio/volatilityTargeting.ts` liefert nur den Risiko-Multiplikator (Bounds ≤ 1), keine Gewichte; `optimize.ts` kennt `min_variance`, `max_sharpe`, `risk_parity` |

Zusätzlich vorhanden, vom Dokument nicht erwähnt: `store.ts` (persistierte Snapshots),
`artifact.ts` (Univers-/Data-/Config-Hash), `scripts/run-cross-sectional.ts` (CLI).

## Remediation

1. **Kein** `MultiAssetStrategySpec` in `src/strategies/`.
2. Stattdessen eine `PortfolioConstruction`-Schicht, die einen
   `CrossSectionalConfig`-Snapshot **liest** und daraus Gewichte erzeugt
   (`INVERSE_VOLATILITY` | `EQUAL_WEIGHT`); die Exposure bleibt über den bestehenden
   Vol-Targeting-Multiplikator (`VOLATILITY_TARGETING_BOUNDS`, ≤ 1) begrenzt, Per-Asset-Schranken
   nutzen `WeightBounds`.
3. Universe-Mitgliedschaft bleibt **eine** Wahrheit: `EligibilityConfig` + `universe.ts`.

## Akzeptanzkriterien

- [x] Entscheidung schriftlich fixiert ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3), `v0.6.1`); keine `MultiAssetStrategySpec` in `src/` (Guard in `tests/adrVocabulary.test.ts`)
- [x] Keine zweite Eligibility-/Ranking-Spec (Entscheidung 1)
- [ ] *Abnahmekriterien der künftigen Umsetzung (außerhalb der Roadmap, [ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3)):* Gewichte summieren auf 1 ± Toleranz, NaN-Handling fail-closed
- [ ] *Künftige Umsetzung:* Test: gleiche Config und gleicher Snapshot ⇒ gleiche Gewichte (Hash-Stabilität)

## Versions-Hinweis

Minor.
