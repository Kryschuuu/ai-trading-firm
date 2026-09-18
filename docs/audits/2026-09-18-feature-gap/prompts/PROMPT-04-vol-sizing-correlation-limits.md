# PROMPT-04 — Vol-Sizing + Korrelations-Exposure-Limits (GAP-04)

> **Finding:** [GAP-04](../findings/GAP-04-vol-sizing-correlation-limits.md) ·
> **Reihenfolge:** Schritt 4 ·
> **Voraussetzungen:** keine harten (PROMPT-02/05/10 empfohlen) ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: ATR-/Vol-basiertes Position-Sizing + Cluster-Exposure-Guardrail
# (GAP-04)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: Die Cluster-Mathematik existiert bereits
(src/portfolio/correlation.ts: pearson/spearman, correlationMatrix,
correlationClusters, clusterAnalysis — inkl. Tests, exponiert über
/api/portfolio/correlation). riskGuard begrenzt maxPositionPct FIX
(LIMIT_CEILINGS-Konvention), adaptiveRisk skaliert per Vol-Regime. Es fehlt:
ATR-basiertes Sizing, ein Fractional-Kelly-Deckel und die Verdrahtung der
Cluster-Mathematik ALS GUARDRAIL im Order-Pfad. Ziel: Größe nach Volatilität,
Exposure nach Korrelations-Clustern — alles geklemmt, alles fail-closed.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/lib/riskGuard.ts (LIMIT_CEILINGS, Prüf-Reihenfolge,
Ablehnungsgründe), src/lib/adaptiveRisk.ts (Regime-Faktor, UNKNOWN-Muster
v1.36.21), src/portfolio/correlation.ts + src/portfolio/index.ts,
src/lib/indicators.ts (vorhandene Indikatoren; fehlt ATR? dann nach R-Regeln
ergänzen), src/lib/marketData.ts + src/lib/marketdata/historicalStore.ts
(Kerzen-Quelle für ATR/Korrelationen), src/lib/ruleActor.ts +
src/lib/microExecutor.ts + src/cycle/steps/riskStep.ts (WO die Größe
berechnet wird), tests/riskGuard* + tests/portfolio*.test.ts. Abweichung vom
Audit-Stand → Rest-Delta, im PR dokumentieren.

## Schritt 2 — Delta umsetzen

D1 ATR-SIZING (neu src/lib/positionSizing.ts):
   - computePositionSize({ equity, riskPerTradePct, atr, entryPrice,
     stopLoss }): qty = (equity * riskPerTradePct) / |entry − stop|;
     ATR dient als Stop-Distanz-Fallback, wenn kein expliziter Stop
     vorliegt (stop = entry − k * ATR; k = RISK_ATR_STOP_MULT, Default 2,
     Bounds [0.5, 6]).
   - Fractional-Kelly als OBERGRENZE: kellyFraction =
     RISK_KELLY_FRACTION (Default 0 = aus, Bounds [0, 1]); wenn > 0 und
     Trefferquote/Payoff aus dem Trade-Journal (falls GAP-03 bereits
     umgesetzt) oder aus der Regel-Statistik (ruleExecutions) verfügbar:
     maxNotional = equity * kellyFraction * edge-basierte Größe — sonst
     wirkungslos (dokumentiert, kein stiller Zwangswert).
   - Ergebnis IMMER an bestehende Grenzen geklemmt: maxPositionPct,
     maxRiskPerTrade via LIMIT_CEILINGS — Sizing verschärft, lockert nie.
   - Fail-closed: ATR/Kerzen fehlen oder stale → Fallback auf heutige
     Basis-Größe + Kennzeichnung UNKNOWN im Entscheidungskontext + Audit-
     Notiz (Muster adaptiveRisk v1.36.21) — kein Block, kein stiller Wert.
D2 CLUSTER-EXPOSURE-GUARDRAIL (in riskGuard, Schicht 3):
   - Vor Freigabe: Cluster des neuen Symbols gegen offene Positionen
     berechnen (correlationClusters über rollierende Renditen aus dem
     HistoricalStore; Fenster RISK_CORR_WINDOW_CANDLES, Default 90,
     Bounds [30, 365]).
   - Limits: RISK_MAX_PER_CLUSTER (Default 3, Bounds [1, 10]) Positionen je
     Cluster; Schwelle RISK_CORR_THRESHOLD (Default 0.7, Bounds [0.3, 0.99]).
   - Cache mit TTL RISK_CORR_CACHE_TTL_MS (Default 900000, Bounds [60000,
     3600000]); stale Daten → fail-closed: Aufstockung in möglicherweise
     korrelierte Cluster wird abgelehnt (Grund „cluster-exposure:correlation-
     stale“), dokumentieren.
   - Modus RISK_CLUSTER_LIMITS_MODE: „monitor“ (Default: nur Audit-Notiz +
     Log mit der protokollierten Würde-Prüfung) | „enforce“ (echte Ablehnung
     „cluster-exposure:max-per-cluster:N“). Rollout bewusst monitor-first.
   - Rechenlast: Berechnung nur je Order-Prüfung mit Cache, kein Hintergrund-
     Job in diesem PR.
D3 TRANSPARENZ: Ablehnungs-/Monitor-Entscheidungen je Guardrail revisionssicher
   ins audit_log; GET /api/firm/risk (bzw. bestehender Risiko-Endpunkt)
   zeigt effektive Sizing-/Cluster-Parameter + UNKNOWN-Zustände.

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only · Fail-closed (UNKNOWN statt stiller Werte) · keine neuen Runtime-
Dependencies (Korrelations-Mathe ist vorhanden — WIEDERVERWENDEN, nicht
kopieren) · Schwellen mit Bounds + Default + Eintrag in .env.example UND
CONFIGURATION.md · Mutationen ins audit_log, Gründe maschinenlesbar · keine
Schema-Änderung nötig (falls doch: append-only + drizzle/-Konvention) ·
Determinismus · Pflicht-Checks: npm run typecheck && npm run lint && npm
test && npm run docs:validate — 0 Failures (Ausnahme ENV-01) · CHANGELOG +
Versions-Bump (package.json, Status-Header, docs/README.md) · nur dieses
Delta; Neben-Bugs in „Offene Punkte“.

## Schritt 3 — Tests

- tests/positionSizing.test.ts: Sizing-Mathe (Standardfall, Short gespiegelt),
  ATR-Fallback-Stop, Kelly-Deckel wirkt nur bei verfügbaren Statistiken,
  Clamp an LIMIT_CEILINGS, UNKNOWN-Pfad bei fehlendem ATR.
- tests/riskGuard.cluster.test.ts: Ablehnung bei Cluster-Überlauf (enforce),
  monitor-Modell ändert Entscheidung nicht (nur Audit/Log), stale-Korrelation
  → konservative Ablehnung, Cache-TTL (Fake-Clock), Schwelle-Grenzfälle
  (0.699 vs 0.7).
- Bestehende riskGuard-/portfolio-Tests bleiben unverändert grün (Defaults!).

## Schritt 4 — Docs & Meta

- docs/PORTFOLIO_ANALYTICS.md: Abschnitt „Sizing & Cluster-Limits im
  Order-Pfad“ (Formeln, Wiederverwendung correlation.ts, Rollout-Modus).
- docs/HANDBUCH.md: kurzer Ops-Hinweis (monitor→enforce Umschaltung).
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat, Minor-Bump)
  + Status-Header + docs/README.md. TRACKING.md pflegen; Finding „Umsetzung“
  ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert; D1–D3 umgesetzt und je getestet
[ ] Keine Duplikation der Korrelations-Mathematik (Import aus src/portfolio)
[ ] Flags in .env.example + CONFIGURATION.md; Default = monitor/neutral
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig
```
