# GAP-04 — Volatilitätsbasiertes Position-Sizing + Korrelations-Exposure-Limits

**Nutzen:** ★★★★★ · **Aufwand (Co-Audit):** 🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧🔧
**Kategorie:** Rendite/Risiko · **Prompt:** [`PROMPT-04`](../prompts/PROMPT-04-vol-sizing-correlation-limits.md)

## Befund (Co-Audit)

Größter Einzelhebel auf risikoadjustierte Rendite; verhindert, dass 5
„unabhängige“ Trades in Wahrheit ein BTC-Beta-Trade sind. Vol-Schätzer
versagen bei Regime-Brüchen → Fail-closed nötig.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/portfolio/correlation.ts`: Pearson/Spearman, `correlationMatrix`,
  `covarianceMatrix`, `correlationClusters`, `clusterAnalysis` — inklusive
  Tests; `/api/portfolio/correlation` exponiert die Matrix.
- `riskGuard` begrenzt `maxPositionPct` **fix** (LIMIT_CEILINGS-Konvention);
  `adaptiveRisk` skaliert per Vol-Regime. **Aber:** kein ATR-basiertes Sizing,
  kein Fractional-Kelly-Deckel, Cluster-Mathematik ist **nicht** als
  Guardrail verdrahtet (keine Cluster-Exposure-Ablehnung im Order-Pfad).

## Delta

1. ATR-/Vol-basiertes Sizing (Risiko-Budget / ATR-Distanz → qty) mit
   Fractional-Kelly als Obergrenze; alles an `LIMIT_CEILINGS` geklemmt;
   ATR nicht verfügbar → konservative Fallback-Größe (UNKNOWN-Muster wie
   adaptiveRisk v1.36.21).
2. Cluster-Exposure-Guardrail (Schicht 3, `riskGuard`): max. Cluster,
   max. Positionen je Cluster, Korrelationsschwelle; maschinenlesbarer
   Ablehnungsgrund `cluster-exposure:…`; Audit-Eintrag.
3. Korrelations-Cache mit TTL + Stale-Policy (alte Daten → konservativ
   ablehnen, nicht raten).

## Akzeptanzkriterien (kurz)

Sizing-Mathe-Tests, Clamp-Tests, Cluster-Ablehnungstest, Stale-Policy-Test,
keine neuen Runtime-Dependencies.
