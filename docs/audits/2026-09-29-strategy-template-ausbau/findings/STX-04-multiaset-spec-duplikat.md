# STX-04 — `MultiAssetStrategySpec` dupliziert `CrossSectionalConfig`

- **ID:** STX-04
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §1.9
- **Status:** FIXED — bestätigt im Abgleich 2026-10-03 ([ADR-010](../../../roadmap/DECISIONS.md#adr-010-universe-strategie-adr-e3), `v0.6.1`)
- **Datei(en):** `src/crossSectional/types.ts`, `src/portfolio/volatilityTargeting.ts`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — unverändert bestätigt
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `grep -rn "MultiAssetStrategySpec" src/ tests/ scripts/` → **kein** Vorkommen in Produktivcode; einzige Treffer sind der Wächter selbst
- Wächter `tests/adrVocabulary.test.ts:410-412` — „keine `MultiAssetStrategySpec` in `src/` und `scripts/` (verworfen)", ausgeführt und grün
- `PortfolioConstruction` bleibt bewusst außerhalb dieser Roadmap (ADR-010)

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
