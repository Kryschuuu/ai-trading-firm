# STX-04 — `MultiAssetStrategySpec` dupliziert `CrossSectionalConfig`

- **ID:** STX-04
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §1.9
- **Status:** OPEN
- **Datei(en):** `src/crossSectional/types.ts`, `src/portfolio/volatilityTargeting.ts`

## Beschreibung

§1.9 definiert eine neue `MultiAssetStrategySpec` mit `ranking`, `selection`, `rebalance`,
`sizing`. Vier von fünf Feldern existieren bereits in einer PIT-validierten,
hash-versionierten Konfiguration.

## Beweis / Mapping

| Dokument | Repo (`src/crossSectional/`) |
|---|---|
| `ranking: { metric, lookback, direction }` | `CrossSectionalConfig.horizons: MomentumHorizonConfig[] { id, lookback, skip, weight }` |
| `selection: { topN, minLiquidityUsd }` | `EligibilityConfig { minVolume24h, minCandles, maxStaleBars, assetClasses, maxUniverseSize }` |
| `rebalance: { timeframe: "1d" }` | `CrossSectionalConfig.timeframe` + `AvailabilityPolicy` |
| PIT-Semantik | `SnapshotTimestamps { asOf, computedAt }` + `AvailabilityPolicy: "ingested" \| "bar_close"` |
| `sizing: { mode: "INVERSE_VOLATILITY" }` | **fehlt** — einziger echter Zugewinn; `src/portfolio/volatilityTargeting.ts` existiert bereits |

Zusätzlich vorhanden, vom Dokument nicht erwähnt: `store.ts` (persistierte Snapshots),
`artifact.ts` (Univers-/Data-/Config-Hash), `scripts/run-cross-sectional.ts` (CLI).

## Remediation

1. **Kein** `MultiAssetStrategySpec` in `src/strategies/`.
2. Stattdessen eine `PortfolioConstruction`-Schicht, die einen
   `CrossSectionalConfig`-Snapshot **liest** und daraus Gewichte erzeugt
   (`INVERSE_VOLATILITY` | `EQUAL_WEIGHT`), geklemmt über die bestehenden
   `volatilityTargeting`-Bounds.
3. Universe-Mitgliedschaft bleibt **eine** Wahrheit: `EligibilityConfig` + `universe.ts`.

## Akzeptanzkriterien

- [ ] Keine zweite Eligibility-/Ranking-Spec
- [ ] Gewichte summieren auf 1 ± Toleranz, NaN-Handling fail-closed
- [ ] Test: gleiche Config ⇒ gleiche Gewichte (Hash-Stabilität)

## Versions-Hinweis

Minor.
