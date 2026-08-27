# Task 05 — Implementierungsplan: Deterministische Portfolio-Analytics, Optimizer & Risk-Guard-Kette

**Umfang:** Kennzahl-Bibliothek (reine Funktionen) · Pearson/Spearman-Matrix ·
Kovarianz (Sample/EWMA) · 3 Optimizer-Modi · Risk-Guard-Autoritätskette ·
3 read-only API-Routen · Agenten-Kontext · Benchmark · Docs.

## RECON-Ergebnis (Pfadabweichungen, verbindlich)

| Erwartung aus dem Task | Realität im Repo | Konsequenz |
| --- | --- | --- |
| Root `README.md` | existiert **nicht**, Doku unter `docs/README.md` | Doku-Index + `/api/docs`-Whitelist dort ergänzen |
| Branch `feature/task-05-portfolio-analytics` | Diese Session ist fest auf `arena/01a044b9-ai-trading-firm` gebunden | Arbeit erfolgt auf dem Arena-Branch; PR-Titel wie gefordert |
| Bestehendes `math/`- oder `analytics/`-Modul | existiert nicht. Numerik liegt verteilt: `src/scanner/math.ts` (Scanner-Faktoren), `src/lib/indicators.ts` (Legacy-Indikatoren), `src/scanner/factors/correlation.ts` (Pearson/Spearman) | **Neues Modul `src/portfolio/`** als einzige Portfolio-Numerik. Scanner/Legacy bleiben unangetastet (kein zweiter Rechenweg *innerhalb* des Portfoliomoduls); `src/scanner/factors/correlation.ts` verweist bereits auf Task 05 — Umzug bleibt Folgeaufgabe, wird hier dokumentiert |
| `audit_log`-Infrastruktur | vorhanden, aber DB-gebunden (`src/db`, `auditLog`-Tabelle); Datei-Muster in `src/universe/audit.ts` | Unabhängigkeitsklausel greift: Interface `AuditSink` + Memory-Senke im Kern, `fileAuditSink`/`dbAuditSink` in `auditFile.ts` mit `// vgl. task-01/06` |
| `RiskGuard` | `src/lib/riskGuard.ts` = **Order-Guardrails** (max. 25 % Position, Stop-Pflicht) — andere Ebene | Kein Namenskonflikt auf Dateiebene; `src/portfolio/riskGuard.ts` ist die **Portfolio-**Ebene (Gewichte, Cluster). Kette wird in `pipeline.ts` erzwungen, Order-Guardrails bleiben unberührt |
| Feldnamen | camelCase (Repo-Konvention) | camelCase, kein snake_case |

## Architektur

Neues Modul **`src/portfolio/`** — rein deterministisch, read-only, ohne I/O im Kern:

```
src/portfolio/
  types.ts        ReturnSeries, MetricSet, CorrelationMatrix, OptimizationRequest,
                  RiskGuardResult, PortfolioAuditEvent (TSDoc, Formeln)
  errors.ts       PortfolioError + Codes (INVALID_INPUT, SINGULAR_MATRIX,
                  NOT_CONVERGED, LIMIT_EXCEEDED, INFEASIBLE_CONSTRAINTS …)
  config.ts       Defaults + Validierung (Annualisierung je Asset-Klasse, Limits,
                  Solver-Toleranz 1e-9, Regime-Schwellen)
  numeric.ts      Vektor-/Matrix-Primitives: dot, matVec, cholesky, choleskySolve,
                  jacobiEigen, pseudoInverse, Regularisierung, Konditions-Schätzung
  metrics.ts      logReturns, Realized Volatility, ATR(14), Sharpe, Sortino,
                  Max Drawdown (Dauer/Tiefpunkt), Profit Factor, Volatility-Regime
  correlation.ts  Pearson, Spearman (Ränge), Matrix, Kovarianz (Sample/EWMA-λ),
                  Cluster (Single-Linkage auf |ρ| ≥ Schwelle)
  optimize.ts     min_variance / max_sharpe / risk_parity (deterministisch)
  riskGuard.ts    Position Limits → Correlation Limits, {rejected, adjusted, reasons[]}
  pipeline.ts     optimizeWithGuard(): Autoritätskette, einzige Autorisierungsstufe
  audit.ts        AuditSink-Interface, Memory-/Null-Senke, Event-Bauer (rein)
  auditFile.ts    fileAuditSink (NDJSON) + dbAuditSink  // vgl. task-01/06
  context.ts      getAnalysisContext(returns, symbols) → fertige Zahlen fürs LLM
  index.ts        öffentliche API
src/app/api/portfolio/{metrics,correlation,optimize}/route.ts
```

**Determinismus:** kein `Math.random`, kein `fetch`, kein `node:http(s)`, kein
LLM-Import, keine Uhr im Kern (`Date.now()`/`new Date()` verboten — Zeitstempel
werden über `now()` injiziert), kein `process.env` im Kern außer der Whitelist
`PORTFOLIO_CONFIG_FILE` / `PORTFOLIO_AUDIT_DIR` (nur `auditFile.ts`/`config.ts`).
Ausgaben gerundet auf 12 Dezimalen ⇒ byte-identische JSON-Antworten.

## Solver-Wahl (Begründung)

| Modus | Verfahren | Warum |
| --- | --- | --- |
| `min_variance` | FISTA (beschleunigtes projiziertes Gradientenverfahren) mit adaptivem Restart, Schrittweite `1/λ_max` (Power-Iteration, deterministischer Startvektor) + **exakter Active-Set-Polish** (KKT-System auf der freien Menge per Cholesky) | Konvexes QP ⇒ global optimal. FISTA ist O(n²)/Iteration (nur Matrix-Vektor), skaliert auf 500+ Assets; der Polish liefert Maschinenpräzision, damit Golden-Tests auf 1e-6/1e-12 halten |
| `max_sharpe` | projiziertes Gradienten-**aufstiegs**verfahren mit Armijo-Backtracking auf `S(w) = (μ'w − rf)/√(w'Σw)` über der Box-Simplex-Menge, **Multi-Start** aus 3 deterministischen Punkten (gleichgewichtet, Min-Variance, Vertex des höchsten Excess-Return), bestes Ergebnis gewinnt | `S` ist quasikonkav ⇒ jedes lokale Maximum auf der konvexen Menge ist global. Multi-Start garantiert ≥ gleichgewichtetem Sharpe und ist vollständig deterministisch (kein Random). Gegenprüfung im Test: Gittersuche auf dem 3-Simplex |
| `risk_parity` | Newton-Verfahren auf der **konvexen Spinu-Funktion** `F(w) = ½ w'Σw − (1/n)·Σ ln wᵢ`, Start `w = 1/n`, Hesse-Matrix `Σ + (1/n)·diag(1/wᵢ²)` (immer positiv definit ⇒ Cholesky bricht nie ab), Damped-Line-Search | Am Optimum gilt exakt `wᵢ(Σw)ᵢ = 1/n` ⇒ gleiche Risk Contributions; quadratische Konvergenz in ~10–20 Iterationen, deterministisch, ohne Eigenzerlegung |

Projektion auf `{Σw = 1, l ≤ w ≤ u}`: exakt über Bisektion + Newton-Korrektur des
dualen Multiplikators `λ` (`g(λ) = Σ clamp(wᵢ−λ, lᵢ, uᵢ)` ist monoton, Bracket
`[min(xᵢ−uᵢ), max(xᵢ−lᵢ)]`). Unlösbar (`Σl > 1` oder `Σu < 1`) ⇒
`INFEASIBLE_CONSTRAINTS`, nie stille Reparatur.

**Numerik-Regeln:** NaN/±∞/nicht-positive Preise ⇒ `INVALID_INPUT` mit Feld und
Index. Singuläre/nicht positiv definite Kovarianz ⇒ konfigurierbare Policy
`error` (Default) | `ridge` | `pseudo-inverse` (Jacobi-Eigenzerlegung, `rcond`
1e-12). Toleranz Default 1e-9 (enger als die geforderte Prüftoleranz 1e-6, damit
Golden-Tests stabil bestehen), `maxIterations` konfigurierbar, Nicht-Konvergenz
⇒ `converged: false` + `NOT_CONVERGED`-Diagnose im Ergebnis (kein stilles
Ergebnis). Kovarianz-Kosten O(T·n²) ⇒ harte Obergrenze `n × T ≤ 250.000`.

## Umsetzungsschritte (Conventional Commits `(task-05)`, ≥ 4)

1. `feat(portfolio): metrics-lib` — types/errors/config/numeric/metrics + Golden-Tests.
2. `feat(portfolio): correlation+matrix` — Pearson/Spearman-Matrix, Kovarianz
   (Sample/EWMA), Cluster + Tests.
3. `feat(portfolio): optimizer+guard-chain` — 3 Modi, Active-Set-Polish,
   Risk-Guard-Kette, Audit + Eigenschafts-/Robustheitstests.
4. `feat(portfolio): api+context` — 3 read-only Routen, `getAnalysisContext`,
   Contract-Tests, Architekturtest, Benchmark.
5. `docs(portfolio): …` — PORTFOLIO_ANALYTICS.md, help-JSON, CHANGELOG,
   SECURITY_AUDIT-Kapitel, `/api/docs`-Whitelist.

## Teststrategie

`tests/portfolio.metrics.test.ts` (Golden 1e-6: Vol, ATR, Pearson/Spearman,
Sharpe, Sortino, MaxDD inkl. Dauer, Profit Factor; Edge: leer, konstant, NaN/Inf),
`portfolio.correlation.test.ts` (Matrix-Symmetrie/Diagonale, EWMA vs. Sample,
Cluster-Schwellen), `portfolio.optimizer.test.ts` (2-Asset-Closed-Form,
Gewichtssumme 1, Bounds, Min-Variance ≤ Gleichverteilung, Max-Sharpe ≥
gleichgewichtet + Gittersuche, Risk Parity `|RCᵢ−RCⱼ| < 1e-4`, Konvergenz-
warnung bei Iterationslimit, singuläre Matrix → Policy), `portfolio.riskGuard.test.ts`
(Kappung, Cluster-Ablehnung, Audit je Entscheidung, Kettenreihenfolge),
`portfolio.api.test.ts` (Contract, Größenlimits, 405/400/413/422),
`portfolio.architecture.test.ts` (kein LLM/Netzwerk/Random/FS im Kern, TSDoc-
Formel je Funktion, help-JSON vollständig), `portfolio.benchmark.test.ts`
(500 Assets × 252 Renditen, Budget-Absage bei Überschreitung).
Coverage: `npm run test:coverage:portfolio` (Ziel ≥ 95 % Zeilen).
Referenzwerte werden zusätzlich unabhängig in Python (ohne Bibliothek)
nachgerechnet und als Kommentar im Test hinterlegt.

## Sicherheits-Leitpranken

Read-only (keine Order, keine Portfolio-Mutation, keine DB), harte Größenlimits
(max. 1.000 Serien, max. 2.000 Punkte/Serie, `n × T ≤ 250.000`, Body ≤ 16 MB),
Validierung jeder Zahl, keine Secrets in Antworten (`publicErrorMessage`),
Audit-Senke schreibt nur Ereignisse (Symbole, Gewichte, Gründe) — niemals
Roh-Requests.
