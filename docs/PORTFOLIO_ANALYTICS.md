# Portfolio-Analytics, Optimizer & Risk-Guard-Kette (Task 05)

**Modul:** `src/portfolio/` · **API:** `/api/portfolio/{metrics,correlation,optimize}` ·
**Version:** `PORTFOLIO_CONFIG_VERSION = 1`

Dieses Dokument beschreibt die deterministische Rechenschicht, die Portfoliogewichte
erzeugt. Der Kernsatz der Architektur gilt hier ohne Ausnahme:

> **Der Optimizer rechnet. Die Risk Guard entscheidet. Das LLM interpretiert.**

Alle Funktionen der Kernbibliothek sind **rein** (keine I/O, kein Netzwerk, keine Uhr,
kein Zufall, kein LLM-Import), jede exportierte Rechenfunktion trägt die Formel im TSDoc,
und jede Entscheidung der Risk Guard landet strukturiert im `audit_log`.

---

## Inhalt

1. [Formelkatalog](#1-formelkatalog)
2. [Optimizer: drei Modi](#2-optimizer-drei-modi)
3. [Risk-Guard-Kette](#3-risk-guard-kette)
4. [Konvergenz und Numerik](#4-konvergenz-und-numerik)
5. [API-Referenz](#5-api-referenz)
6. [Agenten-Schnittstelle](#6-agenten-schnittstelle-getanalysiscontext)
7. [Warum das LLM keine Gewichte berechnet](#7-warum-das-llm-keine-gewichte-berechnet)
8. [Benchmark](#8-benchmark)
9. [Grenzen und bewusste Nicht-Entscheidungen](#9-grenzen-und-bewusste-nicht-entscheidungen)

---

## 1. Formelkatalog

Alle Größen beziehen sich auf **logarithmische Renditen**
`r_t = ln(P_t / P_{t−1})`. Konventionen: `n` = Anzahl Assets, `T` = Anzahl Beobachtungen,
`A` = Annualisierungsfaktor, `r_f` = risikofreier Zins (Dezimalanteil, annualisiert),
`σ` = Volatilität, `Σ` = Kovarianzmatrix, `w` = Gewichtsvektor.

### 1.1 Renditen und Volatilität

| Größe | Formel | Annahmen / Grenzen |
| --- | --- | --- |
| **Log-Rendite** | `r_t = ln(P_t / P_{t−1})` = `log1p(P_t/P_{t−1} − 1)` | Preise > 0. Additiv über die Zeit (Vorteil gegenüber einfachen Renditen), symmetrisch bei Gewinn/Verlust. Ein Preis von 0 ist ein definierter Fehler (`INVALID_INPUT`), kein `-Infinity`. |
| **Standardabweichung** | `σ = sqrt( 1/(T − ddof) · Σ(r_t − r̄)² )`, `ddof ∈ {0, 1}` | Default `ddof = 1` (Stichproben-σ, unbiased). **Achtung:** Der Scanner (Task 04) nutzt Populations-σ (`ddof = 0`); die beiden Werte sind bei `T = 30` um Faktor `sqrt(30/29) ≈ 1,017` unterschiedlich. Beide sind hier konfigurierbar, damit kein stiller Bruch entsteht. |
| **Realisierte Volatilität** | `σ_ann = σ · √A` | √T-Skalierung gilt nur unter i.i.d.-Annahme. Bei Volatilitätsclustering (GARCH-Effekt) unterschätzt sie lange Horizonte; bei Mean-Reversion überschätzt sie. `A` je Anlageklasse: Krypto 365, Aktien/ETF/Indizes/FX/Rohstoffe 252 (überschreibbar). |
| **Annualisierte Rendite** | `μ_ann = r̄ · A` | Arithmetische Skalierung der Log-Rendite. Exakter wäre `exp(r̄·A) − 1` für einfache Renditen; hier bleibt die Log-Konvention konsistent. |
| **ATR (Average True Range)** | `TR_t = max(H_t − L_t, |H_t − C_{t−1}|, |L_t − C_{t−1}|)`, danach Wilder-RMA: `ATR_t = (ATR_{t−1}·(p−1) + TR_t)/p`, Startwert = arithmetisches Mittel der ersten `p` TR | Default `p = 14`. **Wichtig:** `TR_t` benötigt den Vortagesschluss ⇒ aus `T` Kerzen entstehen `T − 1` True Ranges, die erste Kerze ist nie validiert. Für `p = 14` sind also **15 Kerzen** nötig. ATR ist ein Kursdifferenz-Maß, keine Rendite — für `atrPct` wird durch den letzten Schluss geteilt. |

### 1.2 Risiko-Rendite-Kennzahlen

| Größe | Formel | Annahmen / Grenzen |
| --- | --- | --- |
| **Sharpe Ratio** | `Sharpe = (r̄ − r_f/A) / σ` je Periode; annualisiert `· √A` | Setzt normalverteilte, symmetrische Renditen voraus. Überschätzt Strategien mit negativem Skew (z. B. Optionsverkauf). `σ = 0` ⇒ definierter Fehler `DIVISION_BY_ZERO`. `r_f` wird **je Periode** abgezogen (`r_f/A`), sonst wäre der Zins fälschlich annualisiert. |
| **Sortino Ratio** | `Sortino = (r̄ − r_f/A) / σ_down`, `σ_down = sqrt( 1/(T − ddof) · Σ min(r_t − m, 0)² )` mit Target `m` (Default `r_f/A`) | Bestraft nur Verluste unter dem Target. `σ_down = 0` (keine einzige Periode unter Target) ⇒ `DIVISION_BY_ZERO`. Die Downside-Deviation teilt durch **alle** `T − ddof` Beobachtungen, nicht nur durch die Verlustperioden — das ist die übliche Konvention (Semi-Deviation), sonst wären kurze Serien massiv überschätzt. |
| **Max Drawdown** | `MDD = max_t ( (Peak_t − P_t)/Peak_t )`, `Peak_t = max_{s ≤ t} P_s` | Aus den kumulierten Log-Renditen als `P_t = exp(Σ_{s≤t} r_s)` (Start 1). Zusätzlich berichtet: `peakIndex`, `troughIndex`, `recoveryIndex`, `durationPeriods = recoveryIndex − peakIndex` (ohne Recovery: bis zum Serienende), `peakToTrough`. MDD ist ein **Pfadmaß** — derselbe Wert kann in drei Tagen oder drei Jahren entstehen; deshalb immer die Dauer mitlesen. |
| **Profit Factor** | `PF = Σ Gewinne / |Σ Verluste|` über Renditen `> 0` bzw. `< 0` | `grossLoss = 0` ⇒ `PF = Infinity` (gewinnende Serie, kein Fehler); `grossProfit = 0` ⇒ `PF = 0`. Zählt keine Trades, sondern Perioden — ein Backtest-Profit-Factor pro Trade ist etwas anderes. |
| **Volatilitätsregime** | `LOW` falls `σ_ann < low`, `NORMAL` falls `< normal`, `HIGH` falls `< high`, sonst `EXTREME` | Default-Schwellen `0.25 / 0.60 / 1.20` (annualisiert), vollständig überschreibbar. Gleiche Semantik wie `src/scanner/regime.ts`, damit beide Ebenen dasselbe Wort meinen. Ein Regime ist ein Zustand, keine Prognose. |

### 1.3 Zusammenhangsmaße

| Größe | Formel | Annahmen / Grenzen |
| --- | --- | --- |
| **Pearson** | `ρ_xy = Σ(x_i − x̄)(y_i − ȳ) / sqrt( Σ(x_i − x̄)² · Σ(y_i − ȳ)² )` | Misst **linearen** Zusammenhang, `∈ [−1, 1]`. Eine Variable mit Varianz 0 ist undefiniert ⇒ hier definiert **0** (neutral), nie `NaN` — und die Serie wird im Report als `degenerate` markiert. Pearson = 0 heißt nicht unabhängig (z. B. `y = x²`). |
| **Spearman** | `ρ_s = Pearson(rank(x), rank(y))` | Rangkorrelation, robust gegen Ausreißer und monotone Nichtlinearität. Gleichstände erhalten den **Durchschnittsrang** (z. B. `[1,2,2,4]` → `[1, 2.5, 2.5, 4]`). |
| **Kovarianz (Sample)** | `Σ_ij = 1/(T − 1) · Σ_t (x_it − x̄_i)(x_jt − x̄_j)` | Rang `≤ T − 1` ⇒ für `n ≥ T` **immer** singulär. Das ist kein Bug, sondern Mathematik: der Optimizer meldet dann `SINGULAR_MATRIX` oder regularisiert (Abschnitt 4). |
| **Kovarianz (EWMA)** | `Σ_ij = (1−λ)·Σ_t λ^(T−t)·x_it·x_jt / (1 − λ^T)` | Default `λ = 0.94` (RiskMetrics). Gewichtet die jüngste Beobachtung am stärksten, reagiert schneller auf Regimewechsel, kennt aber keinen Mean-Reversion-Term und ist bei langen Serien praktisch gedächtnislos. Die Renditen werden **nicht** um den Mittelwert zentriert (Standard bei EWMA-Kovarianz). |
| **Cluster** | Union-Find über alle Paare mit `|ρ_ij| ≥ threshold` (Default `0.8`) | Single-Linkage: transitiv — A~B und B~C verbindet A und C auch bei `ρ_AC ≈ 0.5`. Bewusst gewählt (konservativ: größere Cluster ⇒ strengere Limits). |

---

## 2. Optimizer: drei Modi

**Gemeinsame Nebenbedingungen** (alle Modi, konfigurierbar):

```
Σ_i w_i = 1                                  (voll investiert, kein Cash-Rest)
l_i ≤ w_i ≤ u_i                              (Bounds, Default l=0, u=1 ⇒ long-only)
```

`allowShortSelling = false` (Default) ⇒ `l_i = maxWeightPerInstrument`,
`u_i = maxWeightPerInstrument`. Bounds sind **immer** aktiv — auch bei Risk Parity,
dort per Projektion, weil das analytische Risk-Parity-Gewicht sonst die Limits bricht.

| Modus | Zielfunktion | Nebenbedingung | Solver |
| --- | --- | --- | --- |
| `min_variance` | `min wᵀΣw` | `Σw = 1`, Bounds | FISTA (beschleunigtes projiziertes Gradientenverfahren) + Neustart beim Funktionswert + Active-Set-Polish über das KKT-System `[[2Σ, 1],[1ᵀ, 0]]·[w, μ] = [0, 1]` via Cholesky. Für 2 Assets deckungsgleich mit der analytischen Lösung `w₁ = (σ₂² − σ₁₂)/(σ₁² + σ₂² − 2σ₁₂)`. |
| `max_sharpe` | `max (μᵀw − r_f)/√(wᵀΣw)` | `Σw = 1`, Bounds | Monotoner projizierter Aufstieg auf `f(w) = (μᵀw − r_f)/√(wᵀΣw)` mit adaptiver Schrittweite (Rückzug bei Verschlechterung), drei deterministische Starts (gleichverteilt, `1/σ²`, `1/σ`), bestes Ergebnis gewinnt. Ohne Bounds identisch zur Tangentialportfoliolösung `w ∝ Σ⁻¹(μ − r_f)`. |
| `risk_parity` | gleichmäßige Risikobeiträge `w_i(Σw)_i = (1/n)·wᵀΣw` | `Σw = 1`, Bounds (Projektions-Schritt) | Newton-Verfahren auf der **Spinu-Formulierung** `min ½wᵀΣw − (1/n)·Σ ln w_i`, `H = Σ + diag(1/(n·w_i²))`, Halving-Liniensuche. Konvergiert quadratisch und ohne Startwertsuche; Start immer `w = 1/n`. |

**Ausgabe jedes Laufs** (`OptimizationResult`):

```jsonc
{
  "mode": "risk_parity",
  "symbols": ["A", "B", "C"],
  "weights": [0.4541260399, 0.3027506933, 0.2431232668],
  "diagnostics": {
    "converged": true,
    "iterations": 11,
    "objective": 0.000123,
    "stationarity": 8.8e-11,
    "variance": 0.000123,
    "volatility": 0.0111,
    "sharpe": 6.94,
    "riskContributions": [0.3333333, 0.3333333, 0.3333333],
    "polished": true,
    "regularization": { "applied": "none", "ridge": 0 },
    "notes": []
  }
}
```

* `weights` summiert **exakt** auf 1 (Rundung auf 12 Nachkommastellen, Rest wird dem
  größten Gewicht zugeschlagen — `closeRoundingGap`).
* `notes[]` trägt maschinenlesbare Hinweise: `NOT_CONVERGED:iterations=2000`,
  `COVARIANCE_REGULARIZED:ridge`, `BOUNDS_PROJECTED:violations=3`.
  `convergenceWarning(result)` liefert den Warnhinweis oder `null`.
* `riskContributions[i] = w_i(Σw)_i / (wᵀΣw)` — bei `risk_parity` alle `≈ 1/n`.

**Feasibility.** Nicht jede Kombination aus Limits ist erfüllbar. Der Optimizer liefert
dann ein Ergebnis, das die **Risk Guard** verwirft (Abschnitt 3) — niemals ein Ergebnis,
das die Limits verletzt. Typische Fallen: `maxWeightPerInstrument = 0.2` bei nur 4
Assets (Kapazität 0.8 < 1) oder `maxClusterExposure = 0.3` bei 4 Clustern
(0.3 · 4 = 1.2, aber ein einzelner Cluster mit 80 % Exposure lässt sich nicht auffüllen).

---

## 3. Risk-Guard-Kette

```
   ┌─────────────────────┐
   │  Portfolio Optimizer │  min_variance · max_sharpe · risk_parity
   │  (src/portfolio/     │  liefert Gewichte + Diagnose, nichts sonst
   │   optimize.ts)       │
   └──────────┬──────────┘
              │ authority = "portfolio-optimizer"   ← Pflichtfeld, sonst INVALID_INPUT
              ▼
   ┌─────────────────────┐
   │      Risk Guard      │  applyRiskGuard() — nimmt NUR Optimizer-Ausgaben an,
   │  (src/portfolio/     │  erzwingt die Kettenreihenfolge per assertAuthorityChain()
   │   riskGuard.ts)      │
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │    Position Limits   │  maxWeightPerInstrument (Default 20 %)
   │                      │  maxPositions · minWeight (Splitter werden entfernt)
   └──────────┬──────────┘  frei gewordenes Gewicht wird neu verteilt
              ▼
   ┌─────────────────────┐
   │   Correlation Limits │  Cluster aus |ρ| ≥ 0.8, maxClusterExposure (Default 50 %)
   └──────────┬──────────┘  überzogene Cluster werden skaliert
              ▼
   ┌─────────────────────┐
   │  Verifikation        │  Σw = 1 (oder ≤ 1 bei allowCashResidual),
   │                      │  Bounds, Cluster-Exposure, maxAdjustmentRounds
   └──────────┬──────────┘
              ▼
        Ausgabe an Agent / API          ┌──────────────────────────┐
                                        │  audit_log (1 Eintrag je │
   jede Entscheidung ─────────────────► │  Entscheidung + Summary) │
                                        └──────────────────────────┘
```

**Erzwingung im Code, nicht in der Doku:**

* `AUTHORITY_CHAIN = ["portfolio-optimizer", "risk-guard", "position-limits", "correlation-limits"]`
  ist eine Konstante in `types.ts`.
* `assertAuthorityChain(chain, { complete })` prüft, dass die durchlaufene Kette ein
  **Präfix** dieser Konstante ist; bei `complete` (also `rejected === false`) müssen alle
  vier Stationen enthalten sein. Ein Optimizer-Ergebnis, das die Guard überspringt,
  kann die API nicht passieren.
* `applyRiskGuard` **lehnt Eingaben ab**, deren `authority` nicht `"portfolio-optimizer"`
  ist — der Optimizer ist der einzige zulässige Lieferant.
* `optimizeWithGuard()` in `pipeline.ts` ist der einzige öffentliche Weg zur Gewichtsberechnung;
  `/api/portfolio/optimize` ruft ausschließlich diese Funktion.

**Ergebnisstruktur:**

```jsonc
{
  "rejected": false,
  "adjusted": true,
  "reasons": [
    "position-limits/POSITION_LIMIT_CAPPED: A von 34.00 % auf 20.00 % gekappt",
    "correlation-limits/CLUSTER_EXPOSURE_CAPPED: Cluster 0 (A, B, C) mit 78.09 % über dem Limit von 50.00 % — skaliert"
  ],
  "decisions": [
    { "stage": "position-limits", "code": "POSITION_LIMIT_CAPPED", "level": "WARN",
      "symbols": ["A"], "before": 0.34, "after": 0.2, "message": "…" }
  ],
  "clusterExposures": [ { "clusterId": 0, "symbols": ["A","B","C"], "before": 0.78, "after": 0.5, "limit": 0.5, "violated": true } ],
  "auditEvents": [ … eine je Entscheidung …, { "event": "RISK_GUARD_SUMMARY" } ]
}
```

**Codes:** `POSITION_COUNT_EXCEEDED` · `POSITION_LIMIT_CAPPED` · `MIN_WEIGHT_DROPPED` ·
`WEIGHT_REDISTRIBUTED` · `CLUSTER_EXPOSURE_CAPPED` · `GUARD_VERIFICATION_FAILED` ·
`CASH_RESIDUAL` · `POSITION_LIMITS_INFEASIBLE` · `CORRELATION_LIMITS_INFEASIBLE`.

**Audit-Invariante:** `auditEvents.length === decisions.length + 1` — jede Entscheidung
genau ein Eintrag, plus ein zusammenfassender Eintrag (`RISK_GUARD_PASS` bei `INFO`,
`RISK_GUARD_REJECTION` bei `ERROR`). `optimizeWithGuard` stellt zusätzlich das
`PORTFOLIO_OPTIMIZATION`-Ereignis an den Anfang, sodass `audit.length === 2 + decisions.length`.
Ein unverändertes Portfolio erzeugt **keine** Entscheidung und genau ein `RISK_GUARD_PASS`.

**Verwurf.** Ist nach allen Runden (Default `maxAdjustmentRounds = 50`) Kapital übrig,
das innerhalb der Limits keinen Platz findet, wird das Portfolio **verworfen**
(`rejected: true`), nicht teilweise ausgeliefert. `/api/portfolio/optimize` antwortet
dann mit `422 RISK_GUARD_REJECTION`. Wer das vermeiden will, setzt
`allowCashResidual: true` — dann bleibt der Rest bewusst als Cash stehen
(`CASH_RESIDUAL`-Eintrag, `Σw ≤ 1`).

---

## 4. Konvergenz und Numerik

| Regel | Umsetzung |
| --- | --- |
| **Toleranz** | `DEFAULT_SOLVER_TOLERANCE = 1e-9` — bewusst enger als die geforderte Prüftoleranz `1e-6`, damit Golden-Tests auch bei schlecht konditionierten Matrizen stabil bleiben. Konfigurierbar über `solver.tolerance`. |
| **Iterationslimit** | `DEFAULT_MAX_ITERATIONS = 2000`, konfigurierbar. Wird es erreicht, steht `converged: false` **und** `notes: ["NOT_CONVERGED:iterations=2000"]` — kein stiller Abbruch. |
| **Konvergenzmaß** | min_variance/max_sharpe: ∞-Norm des (projizierten) Gradienten bzw. der Schrittweite, relativ zur Skala. risk_parity: `‖Σw − (1/n)w⁻²‖_∞ / max(1, ‖Σw‖_∞)`; berichtet wird zusätzlich der Risk-Contribution-Spread. Ein bei Maschinengenauigkeit stehender Solver gilt damit als konvergiert, auch wenn die Schrittweite nicht mehr messbar sinkt. |
| **Deterministischer Start** | `risk_parity`: immer `w = 1/n`. `min_variance`: gleichverteilt. `max_sharpe`: drei **feste** Starts, bestes Ergebnis — keine Zufalls-Multistarts, kein `Math.random`. |
| **NaN/Inf** | Jede Eingabe wird geprüft (`requireFinite`). `NaN`, `±Infinity` oder eine negative Varianz ⇒ `PortfolioError` mit Code (`INVALID_INPUT`, `NUMERIC_FAILURE`, `DIVISION_BY_ZERO`, `NOT_POSITIVE_DEFINITE`). Nicht-endliche Werte gelangen nie in eine Antwort: `roundTo` bildet sie auf 0 ab. |
| **Singuläre Kovarianz** | Drei **konfigurierbare** Policies: `error` (Default, wirft `SINGULAR_MATRIX`), `ridge` (`Σ + τ·I`, `τ` startet bei `1e-10 · mean(diag)` und wird bis zu 8× verdoppelt), `pseudo-inverse` (Eigenzerlegung, Eigenwerte `< rcond · λ_max` werden auf 0 gesetzt). Es gibt **keinen** stillen Fallback: was passiert ist, steht in `diagnostics.regularization` und in `notes[]`. |
| **Fast-singulär** | Die Cholesky-Zerlegung erklärt einen Pivot unter `MIN_RELATIVE_PIVOT = 1e-12 · max(diag)` für singulär. Zwei perfekt korrelierte Assets haben Determinante 0, liefern in Gleitkomma aber oft ein Pivot von `1e-19` — ohne diese Schwelle „gelingt" die Zerlegung und produziert danach Unsinn. |
| **Symmetrie** | Kovarianzmatrizen werden vor der Zerlegung gespiegelt (`(Σ + Σᵀ)/2`), damit Rundungsasymmetrien die Cholesky-Zerlegung nicht zerstören. |
| **Ausgabe-Rundung** | `OUTPUT_DECIMALS = 12`. Danach `closeRoundingGap`: der Rundungsrest (`|Σw − 1| ≤ 1e-9`) wird dem größten zulässigen Gewicht zugeschlagen, damit `Σw` **exakt** 1 ist. Bei `allowCashResidual` wird das übersprungen — dort ist ein Rest gewollt. |
| **Byte-Stabilität** | Gleiche Eingabe ⇒ bit-identische JSON-Ausgabe (ohne Zeitstempel). Getestet in `tests/portfolio.api.test.ts`. |

---

## 5. API-Referenz

Alle drei Endpunkte sind **read-only**: `POST`-Abfragen, `GET` liefert `405`.
Kein Endpunkt schreibt Portfolio-, Positions- oder Orderzustand.

**Fehlerformat** (einheitlich):

```json
{ "ok": false, "error": "INVALID_INPUT", "message": "human readable", "details": { "field": "series[0].prices" } }
```

| Status | Bedeutung |
| --- | --- |
| `400` | `INVALID_INPUT`, `INSUFFICIENT_DATA`, `LENGTH_MISMATCH`, `INVALID_CONFIG`, `INVALID_JSON` |
| `405` | `METHOD_NOT_ALLOWED` (alles außer `POST`) |
| `413` | `LIMIT_EXCEEDED` (mehr als 1000 Serien, Serie länger als 2000, `Serien × Länge > 400.000`, Body > 16 MiB) |
| `422` | `RISK_GUARD_REJECTION`, `SINGULAR_MATRIX`, `NOT_POSITIVE_DEFINITE`, `NUMERIC_FAILURE`, `DIVISION_BY_ZERO` |
| `500` | unerwarteter Fehler (Details bleiben im Log, nie im Body) |

**DoS-Schutz:** Body-Limit, harte Obergrenzen je Dimension (`PORTFOLIO_LIMITS`),
`O(T·n²)`-Bremse über `maxCovarianceSamples`, keine Rekursion über Nutzereingaben,
keine Dateipfade aus dem Request (Audit-Dateiname wird gegen `^[A-Za-z0-9._-]{1,64}$`
geprüft), Symbole werden getrimmt, auf Großbuchstaben normalisiert und gegen eine
strikte Zeichenklasse validiert (kein Zeilenumbruch ⇒ keine Log-Injection).

### 5.1 `POST /api/portfolio/metrics`

```bash
curl -sX POST http://localhost:3000/api/portfolio/metrics \
  -H 'content-type: application/json' -d '{
    "series": [
      { "symbol": "nvda", "prices": [100,102,101,105,103,110,108,112,115,113], "assetClass": "equity" },
      { "symbol": "btcusdt", "logReturns": [0.01,-0.02,0.03,0.005,-0.01], "assetClass": "crypto" }
    ],
    "riskFreeRate": 0.03,
    "ddof": 1
  }'
```

Antwort (echter Auszug, `riskFreeRate: 0.03`, `ddof: 1`):

```json
{ "ok": true, "configVersion": 1,
  "metrics": [ {
    "symbol": "NVDA", "observations": 9, "annualization": 252,
    "meanLogReturn": 0.013579736969, "annualizedReturn": 29.63348575248,
    "volatilityPerPeriod": 0.031018072122, "volatility": 0.492396629904,
    "sharpe": 6.888945842177, "sharpePerPeriod": 0.433962797471,
    "sortino": 19.095874749706, "sortinoPerPeriod": 1.202927039404,
    "downsideDeviation": 0.011189946613,
    "maxDrawdown": { "value": 0.019047619048, "peakIndex": 3, "troughIndex": 4,
                     "recoveryIndex": 5, "peakToTroughPeriods": 1,
                     "durationPeriods": 2, "recovered": true },
    "profitFactor": 2.880933746517, "grossProfit": 0.187194739414, "grossLoss": 0.06497710669,
    "atr": null, "atrPct": null, "atrPeriod": null,
    "riskFreeRate": 0.03, "regime": "NORMAL" } ] }
```

`sharpe`/`sortino`/`volatility` sind annualisiert, `…PerPeriod` die Werte je
Beobachtung. Ohne `candles` sind `atr`, `atrPct` und `atrPeriod` `null`.

Eingabe je Serie: **genau eine** Quelle `prices` (Schlusskurse, > 0) **oder** `returns`
(einfache Renditen, werden per `ln(1+r)` zu Log-Renditen) **oder** `logReturns`; optional
`candles` (`{high, low, close}` mit `high ≥ low`) für die ATR, `assetClass`
(steuert den Annualisierungsfaktor), `riskFreeRate`, `weight` (nur Information).

### 5.2 `POST /api/portfolio/correlation`

```bash
curl -sX POST http://localhost:3000/api/portfolio/correlation \
  -H 'content-type: application/json' -d '{
    "series": [
      { "symbol": "A", "logReturns": [0.01,-0.02,0.03,0.005,-0.01] },
      { "symbol": "B", "logReturns": [0.02,0.01,-0.01,0.03,0.0] }
    ],
    "method": "pearson",
    "clusterThreshold": 0.8
  }'
```

Antwort:

```json
{ "ok": true, "configVersion": 1,
  "correlation": { "method": "pearson", "symbols": ["A","B"], "observations": 5,
                   "matrix": [[1, -0.246598480958], [-0.246598480958, 1]],
                   "degenerate": [] },
  "clusters": { "threshold": 0.8, "method": "pearson", "symbols": ["A","B"],
                "clusters": [ { "id": 0, "symbols": ["A"], "maxAbsCorrelation": 0 },
                              { "id": 1, "symbols": ["B"], "maxAbsCorrelation": 0 } ] } }
```

`method`: `pearson` (Default) oder `spearman`. `matrix` ist eine `n × n`-Liste in
Zeilenreihenfolge mit Diagonale 1. `clusters` erscheint nur, wenn
`clusterThreshold` übergeben wurde; Serien mit Nullvarianz stehen in
`correlation.degenerate[]` und ihre Korrelation ist definiert `0` (neutral), nie `1`.

### 5.3 `POST /api/portfolio/optimize`

```bash
curl -sX POST http://localhost:3000/api/portfolio/optimize \
  -H 'content-type: application/json' -d '{
    "series": [ {"symbol":"NVDA","prices":[…]}, {"symbol":"QQQ","prices":[…]},
                {"symbol":"SPY","prices":[…]}, {"symbol":"GLD","prices":[…]}, {"symbol":"TLT","prices":[…]} ],
    "mode": "risk_parity",
    "covariance": { "method": "ewma", "decay": 0.94 },
    "solver": { "tolerance": 1e-9, "maxIterations": 2000, "singularMatrixPolicy": "error" },
    "bounds": { "minWeight": 0, "maxWeight": 1, "allowShortSelling": false },
    "expectedReturns": [0.0004, 0.0003, 0.00025, 0.0001, 0.0002],
    "riskFreeRate": 0,
    "guard": { "position": { "maxWeightPerInstrument": 0.2, "maxPositions": 12, "minWeight": 0.001 },
               "correlation": { "maxClusterExposure": 0.5, "clusterThreshold": 0.8 } },
    "audit": { "actor": "api", "reference": "request-4711" }
  }'
```

Antwort (`200`, Auszug) — der vollständige Guard-Report ist Teil der Antwort:

```json
{ "ok": true, "configVersion": 1,
  "chain": ["portfolio-optimizer","risk-guard","position-limits","correlation-limits"],
  "symbols": ["NVDA","QQQ","SPY","GLD","TLT"],
  "weights": [0.2,0.2,0.2,0.2,0.2],
  "mode": "risk_parity", "rejected": false, "adjusted": true,
  "reasons": ["position-limits/POSITION_LIMIT_CAPPED: NVDA von 34.00 % auf 20.00 % gekappt"],
  "diagnostics": { "converged": true, "iterations": 11, "notes": [] },
  "guard": { "decisions": [ … ], "clusterExposures": [ … ], "caps": [0.2,0.2,0.2,0.2,0.2] },
  "audit": [ { "event": "PORTFOLIO_OPTIMIZATION", … }, { "event": "RISK_GUARD_DECISION", … }, { "event": "RISK_GUARD_SUMMARY", … } ] }
```

**Audit-Senke.** Standard ist die Memory-Senke: die Ereignisse stehen in `audit[]` und
es wird **nichts** geschrieben. Mit `PORTFOLIO_AUDIT_DIR=data/portfolio` (oder
`PORTFOLIO_AUDIT=1`) schreibt die Route zusätzlich append-only nach
`data/portfolio/audit-log.ndjson` — atomar über temporäre Datei + `rename`, ein JSON-Objekt
pro Zeile. Die Datei-Senke lebt in `src/portfolio/auditFile.ts` und ist als
Integrationspunkt für die zentrale `audit_log`-Tabelle gekennzeichnet
(`// vgl. task-01/06`); `dbAuditSink` ist vorbereitet, aber nicht aktiv, damit dieses
Modul ohne Datenbank läuft.

---

## 6. Agenten-Schnittstelle (`getAnalysisContext`)

```ts
import { getAnalysisContext } from "@/portfolio";

const context = getAnalysisContext(returns, symbols, { clusterThreshold: 0.8 });
// → { generatedBy, symbols, observations, metrics[], correlation, rankCorrelation,
//     clusters, limits, authority, interpretation }
```

Der Kontext enthält **ausschließlich fertige Ergebnisse** — Kennzahlen, beide
Korrelationsmatrizen, Cluster und die wirksamen Limits. Er enthält **keine Gewichte**,
keine Zielfunktion, keine Solver-Parameter und keinen Rechenauftrag. Zusätzlich trägt er
die Leitplanke direkt im Payload:

```json
"interpretation": {
  "llmMay":   ["die Risiken und Zielkonflikte der fertigen Zahlen erklären",
               "Cluster und Konzentrationsrisiken benennen",
               "Fragen zu den Annahmen (Zeitraum, Annualisierung, ddof) beantworten"],
  "llmMustNot": ["Gewichte, Zielgrößen oder Positionen berechnen oder vorschlagen",
                 "die Risk Guard umgehen oder Limits aufweichen",
                 "Renditen prognostizieren oder Zusagen machen"]
}
```

Gewichte entstehen ausschließlich über `optimizeWithGuard()`. Ein Prompt, der ein
Modell nach Gewichten fragt, ist ein Architekturfehler, kein Modellfehler.

---

## 7. Warum das LLM keine Gewichte berechnet

**1. Determinismus ist überprüfbar, Kreativität nicht.** `min_variance` auf dieselbe
Kovarianzmatrix liefert auf jeder Maschine, zu jeder Zeit, unter jeder Temperatur
dasselbe Ergebnis — mit einem analytischen Kontrollwert auf 12 Nachkommastellen. Ein
LLM liefert bei identischem Prompt verschiedene Zahlen und kann sie nicht beweisen.
Ein Portfolio, das niemand reproduzieren kann, ist nicht auditierbar.

**2. Die Nebenbedingungen sind der ganze Punkt.** `Σw = 1`, `w ≤ 20 %`,
`Cluster ≤ 50 %`, Long-only — das sind **harte** Bedingungen. Ein Optimizer verletzt sie
nie, ein Sprachmodell verletzt sie gelegentlich und merkt es nicht. Genau für solche
Verletzungen gibt es die Risk Guard; ein LLM-Ergebnis, das erst geprüft werden muss,
ist kein Gewinn gegenüber einem Optimierer, der gar nicht erst falsch rechnet.

**3. Prompt-Injection wird zur Positionsgröße.** Wer Gewichtsberechnung ins Modell legt,
macht jede Webseite, jede News-Meldung und jede Research-Zusammenfassung zu einem
Eingang in die Risiko-Entscheidung. In dieser Architektur kann ein manipuliertes Modell
höchstens Unsinn *interpretieren* — die Zahl dahinter kommt aus `Σ` und den Limits.

**4. Kleine lokale Modelle sind keine Numeriker.** Das Referenz-Setup läuft auf 3B–14B
Modellen. Die sind gut darin, strukturierte Aussagen zu produzieren, und schlecht in
quadratischer Optimierung unter Nebenbedingungen. Ihnen das zuzumuten heißt,
vorhersagbar falsche Antworten zu ernten.

**5. Verantwortung muss zuordenbar sein.** „Das Modell hatte heute so ein Gefühl" ist
kein Audit-Eintrag. `position-limits/POSITION_LIMIT_CAPPED: NVDA von 34.00 % auf 20.00 %
gekappt` ist einer.

**Was das LLM stattdessen tut:** Es erklärt, warum ein Cluster zu groß ist, welche
Annahmen hinter einer Zahl stehen (Zeitraum, `ddof`, Annualisierungsfaktor), wo ein
Ergebnis fragil ist, und welche Fragen der Nutzer als Nächstes stellen sollte. Das ist
eine wertvolle und zugleich harmlose Aufgabe — sie kann die Gewichte nicht verändern.

---

## 8. Benchmark

`tests/portfolio.benchmark.test.ts`, Budget **30 s**:

| Schritt | 500 Assets × 750 Perioden (375.000 Stichproben) |
| --- | --- |
| Kovarianzmatrix | ≈ 0,21 s |
| `min_variance` | ≈ 0,45 s |
| `max_sharpe` | ≈ 3,7 s |
| `risk_parity` | ≈ 0,52 s |
| vollständige Pipeline (`optimizeWithGuard`) | ≈ 1,0 s |
| **Summe** | **≈ 5,8 s von 30 s** |

Unter `--experimental-test-coverage` skaliert der Test sein Budget um Faktor 20 —
dort wird die Instrumentierung gemessen, nicht die Bibliothek.

Die Kombination 500 × 750 ist bewusst gewählt: `500 × 750 = 375.000 ≤ 400.000`
(`maxCovarianceSamples`) und `T = 750 > n = 500`, damit die Sample-Kovarianz vollen Rang
hat. Bei `T ≤ n` wäre sie mathematisch zwingend singulär — ein Benchmark mit
`T = 252` hätte nur die Regularisierung gemessen.

---

## 9. Grenzen und bewusste Nicht-Entscheidungen

* **Kein Ledoit-Wolf / kein Faktor-Modell.** Die Sample-Kovarianz ist für `n ≫ T`
  schlecht konditioniert; Shrinkage ist der richtige nächste Schritt, aber eine eigene
  Aufgabe. Aktuell gibt es `ridge` und `pseudo-inverse` als **dokumentierte** Notlösung.
* **Keine Transaktionskosten, keine Steuern, keine Leerkosten** in der Zielfunktion.
  Ein Optimierer ohne Kosten handelt zu viel.
* **Keine Rebalancing-Logik, keine Ordergenerierung.** Dieses Modul liefert Gewichte
  und einen Guard-Report — nichts davon wird ausgeführt, und kein Portfolio- oder
  Orderzustand wird verändert.
* **Keine erwarteten Renditen aus der Zukunft.** `max_sharpe` braucht `μ`; wer historische
  Mittelwerte einsetzt, optimiert gegen Rauschen. `min_variance` und `risk_parity`
  brauchen kein `μ` — deshalb sind sie die robustere Voreinstellung.
* **Korrelation ist keine Kausalität und nicht stabil.** In Stressphasen laufen
  Korrelationen gegen 1; Cluster aus Vergangenheitsdaten sind dann wertlos.
* **`src/scanner/factors/correlation.ts`** (Task 04) enthält noch eine eigene
  Pearson/Spearman-Implementierung. Der Umzug auf `src/portfolio` ist dokumentiert,
  aber bewusst nicht in diesem Task gemacht: Der Scanner bleibt unverändert lauffähig.
