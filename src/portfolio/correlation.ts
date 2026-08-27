/**
 * Korrelation und Kovarianz des Portfolio-Moduls (Task 05).
 *
 * Alle Funktionen sind rein und deterministisch. Unbrauchbare Eingaben
 * (NaN/±∞, unterschiedliche Serienlängen) werfen einen `PortfolioError`.
 *
 * Konventionen:
 *   - Gerechnet wird auf **logarithmischen Renditen** pro Periode.
 *   - `ddof = 1` ⇒ erwartungstreue Stichprobenkovarianz.
 *   - EWMA folgt RiskMetrics: `Σ_t = λ·Σ_{t−1} + (1−λ)·r_t·r_tᵀ` mit
 *     `Σ_0 = r_0·r_0ᵀ`. Die Gewichtssumme ist damit exakt 1, es ist keine
 *     Bias-Korrektur nötig (Beweis: `λ^{T−1} + (1−λ)·Σ_{k=0}^{T−2} λ^k = 1`).
 *   - Eine Korrelation mit Nullvarianz ist mathematisch undefiniert; sie wird
 *     als `0` geliefert und das Symbol in `degenerate` genannt — niemals als 1.
 */

import {
  DEFAULT_CLUSTER_THRESHOLD,
  DEFAULT_COVARIANCE_METHOD,
  DEFAULT_DDOF,
  DEFAULT_EWMA_DECAY,
  OUTPUT_DECIMALS,
  assertWithinLimits,
  roundTo,
  validateAnnualization,
} from "./config";
import { PortfolioError, requireFinite } from "./errors";
import { mean, ranks, fromRows, toRows, type Matrix } from "./numeric";
import type { CorrelationCluster, CorrelationMatrix, CorrelationMethod, CovarianceEstimate, SeriesInput } from "./types";
import { resolveLogReturns } from "./metrics";

/**
 * Pearson-Korrelationskoeffizient.
 *
 * Formel: `ρ = Σ(xᵢ − x̄)(yᵢ − ȳ) / √(Σ(xᵢ − x̄)² · Σ(yᵢ − ȳ)²)`.
 *
 * Annahmen: linearer Zusammenhang, metrische Daten. Grenzen: erfasst keine
 * nichtlinearen Abhängigkeiten und reagiert empfindlich auf Ausreißer; in
 * Stressphasen springen Korrelationen gegen 1 (Diversifikation verschwindet).
 *
 * @throws PortfolioError `LENGTH_MISMATCH` (< 2 gemeinsame Werte).
 * @returns `ρ ∈ [−1, 1]`; `0` wenn eine Varianz 0 ist (undefiniert ⇒ neutral).
 */
export function pearsonCorrelation(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) {
    throw new PortfolioError("INSUFFICIENT_DATA", `Korrelation benötigt ≥ 2 Werte, gefunden ${n}`, {
      field: "series",
    });
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      throw new PortfolioError("INVALID_INPUT", `Wert ${i} ist keine endliche Zahl`, {
        field: "series",
        details: { index: i },
      });
    }
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  const denom = Math.sqrt(vx * vy);
  if (!(denom > 0)) return 0;
  const r = cov / denom;
  if (!Number.isFinite(r)) return 0;
  return Math.max(-1, Math.min(1, r));
}

/**
 * Spearman-Rangkorrelation.
 *
 * Formel: `ρ_s = Pearson(rank(x), rank(y))` mit Durchschnittsrängen bei
 * Gleichstand.
 *
 * Annahmen: monotoner Zusammenhang genügt. Grenzen: verwirft Betragsinformation
 * — ein Ausreißer verändert nur den Rang, nicht die Stärke.
 */
export function spearmanCorrelation(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) {
    throw new PortfolioError("INSUFFICIENT_DATA", `Korrelation benötigt ≥ 2 Werte, gefunden ${n}`, {
      field: "series",
    });
  }
  return pearsonCorrelation(ranks(x.slice(0, n)), ranks(y.slice(0, n)));
}

/**
 * Korrelationsmatrix über mehrere Serien.
 *
 * Formel: `C_{ij} = ρ(r_i, r_j)`; Diagonale = 1, Matrix symmetrisch.
 * Nur das obere Dreieck wird berechnet (`O(n²/2)` Paare).
 *
 * @throws PortfolioError `LENGTH_MISMATCH` wenn Serienlängen abweichen.
 */
export function correlationMatrix(
  series: readonly (readonly number[])[],
  options?: { symbols?: readonly string[]; method?: CorrelationMethod }
): CorrelationMatrix {
  const n = series.length;
  if (n === 0) throw new PortfolioError("INVALID_INPUT", "keine Serien übergeben", { field: "series" });
  const length = series[0].length;
  for (let i = 1; i < n; i++) {
    if (series[i].length !== length) {
      throw new PortfolioError("LENGTH_MISMATCH", `Serie ${i} hat Länge ${series[i].length}, erwartet ${length}`, {
        field: "series",
        details: { index: i, length: series[i].length, expected: length },
      });
    }
  }
  assertWithinLimits(n, length);
  const method = options?.method ?? "pearson";
  const symbols = options?.symbols ?? series.map((_, i) => `asset-${i}`);
  if (symbols.length !== n) {
    throw new PortfolioError("LENGTH_MISMATCH", `${symbols.length} Symbole für ${n} Serien`, { field: "symbols" });
  }
  const pairwise = method === "spearman" ? spearmanCorrelation : pearsonCorrelation;
  const matrix: number[][] = [];
  const degenerate: string[] = [];
  const zeroVariance = series.map((s) => {
    const m = mean(s);
    return s.every((v) => v === m);
  });
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    row[i] = 1;
    if (zeroVariance[i]) degenerate.push(symbols[i]);
    for (let j = 0; j < i; j++) {
      const r = roundTo(pairwise(series[i], series[j]), OUTPUT_DECIMALS);
      row[j] = r;
      matrix[j][i] = r;
    }
    matrix.push(row);
  }
  return { method, symbols: symbols.slice(), matrix, observations: length, degenerate };
}

/** Optionen der Kovarianzschätzung. */
export interface CovarianceOptions {
  /** Symbole in Serienreihenfolge. */
  symbols?: readonly string[];
  /** `sample` (Default) oder `ewma`. */
  method?: CovarianceEstimate["method"];
  /** EWMA-Decay `λ ∈ (0, 1)` (Default 0.94). */
  decay?: number;
  /** Freiheitsgrade der Sample-Kovarianz (Default 1). */
  ddof?: number;
}

/**
 * Kovarianzmatrix mehrerer Renditeserien.
 *
 * Formeln:
 *   - Sample: `C_{ij} = Σ_t (r_{it} − r̄_i)(r_{jt} − r̄_j) / (T − ddof)`
 *   - EWMA:   `Σ_t = λ·Σ_{t−1} + (1−λ)·r_t·r_tᵀ`, Start `Σ_0 = r_0·r_0ᵀ`
 *
 * Annahmen: alle Serien gleich lang und zeitlich aligned (gleiche Periode t).
 * Grenzen: Sample-Kovarianz ist bei `T < n` singulär (mehr Assets als
 * Beobachtungen) — deshalb gibt es die konfigurierbare
 * `singularMatrixPolicy`. Kosten `O(T · n²)`.
 */
export function covarianceMatrix(
  series: readonly (readonly number[])[],
  options: CovarianceOptions = {}
): CovarianceEstimate {
  const n = series.length;
  if (n === 0) throw new PortfolioError("INVALID_INPUT", "keine Serien übergeben", { field: "series" });
  const T = series[0].length;
  for (let i = 1; i < n; i++) {
    if (series[i].length !== T) {
      throw new PortfolioError("LENGTH_MISMATCH", `Serie ${i} hat Länge ${series[i].length}, erwartet ${T}`, {
        field: "series",
        details: { index: i, length: series[i].length, expected: T },
      });
    }
  }
  if (T < 2) {
    throw new PortfolioError("INSUFFICIENT_DATA", `Kovarianz benötigt ≥ 2 Beobachtungen, gefunden ${T}`, {
      field: "series",
    });
  }
  assertWithinLimits(n, T);
  const method = options.method ?? DEFAULT_COVARIANCE_METHOD;
  const symbols = (options.symbols ?? series.map((_, i) => `asset-${i}`)).slice();
  if (symbols.length !== n) {
    throw new PortfolioError("LENGTH_MISMATCH", `${symbols.length} Symbole für ${n} Serien`, { field: "symbols" });
  }

  const rows: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  if (method === "ewma") {
    const lambda = options.decay ?? DEFAULT_EWMA_DECAY;
    requireFinite(lambda, "decay");
    if (!(lambda > 0 && lambda < 1)) {
      throw new PortfolioError("INVALID_INPUT", "decay λ muss in (0, 1) liegen", { field: "decay" });
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) rows[i][j] = series[i][0] * series[j][0];
    for (let t = 1; t < T; t++) {
      const w = 1 - lambda;
      for (let i = 0; i < n; i++) {
        const ri = series[i][t];
        for (let j = i; j < n; j++) {
          const v = lambda * rows[i][j] + w * ri * series[j][t];
          rows[i][j] = v;
          rows[j][i] = v;
        }
      }
    }
    return {
      method,
      symbols,
      rows: rows.map((row) => row.map((v) => roundTo(v, OUTPUT_DECIMALS))),
      observations: T,
      decay: lambda,
      denominator: 1,
    };
  }

  const ddof = options.ddof ?? DEFAULT_DDOF;
  if (T - ddof <= 0) {
    throw new PortfolioError("INSUFFICIENT_DATA", `Kovarianz benötigt T > ddof, gefunden T = ${T}, ddof = ${ddof}`, {
      field: "series",
    });
  }
  const means = new Array<number>(n);
  for (let i = 0; i < n; i++) means[i] = mean(series[i]);
  const centered = series.map((s, i) => {
    const out = new Float64Array(T);
    for (let t = 0; t < T; t++) out[t] = s[t] - means[i];
    return out;
  });
  const denom = T - ddof;
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let acc = 0;
      for (let t = 0; t < T; t++) acc += centered[i][t] * centered[j][t];
      const v = acc / denom;
      rows[i][j] = v;
      rows[j][i] = v;
    }
  }
  return {
    method: "sample",
    symbols,
    rows: rows.map((row) => row.map((v) => roundTo(v, OUTPUT_DECIMALS))),
    observations: T,
    decay: null,
    denominator: denom,
  };
}

/**
 * Korrelationsmatrix aus einer Kovarianzmatrix.
 *
 * Formel: `ρ_{ij} = C_{ij} / √(C_{ii}·C_{jj})`; Diagonale = 1;
 * `ρ_{ij} = 0` falls eine Varianz 0 ist (undefiniert ⇒ neutral).
 */
export function correlationFromCovariance(cov: Matrix, symbols?: readonly string[]): CorrelationMatrix {
  const n = cov.n;
  const data = toRows(cov);
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const degenerate: string[] = [];
  const names = (symbols ?? data.map((_, i) => `asset-${i}`)).slice();
  for (let i = 0; i < n; i++) {
    out[i][i] = 1;
    if (!(data[i][i] > 0)) degenerate.push(names[i]);
    for (let j = 0; j < i; j++) {
      const denom = Math.sqrt(data[i][i] * data[j][j]);
      const r = denom > 0 ? Math.max(-1, Math.min(1, data[i][j] / denom)) : 0;
      const rounded = roundTo(Number.isFinite(r) ? r : 0, OUTPUT_DECIMALS);
      out[i][j] = rounded;
      out[j][i] = rounded;
    }
  }
  return { method: "pearson", symbols: names, matrix: out, observations: 0, degenerate };
}

/**
 * Korrelationscluster (Single-Linkage / Union-Find).
 *
 * Regel: zwei Instrumente gehören zum selben Cluster, wenn `|ρ_{ij}| ≥
 * threshold` gilt — direkt oder über eine Kette weiterer Instrumente
 * (transitiver Abschluss).
 *
 * Annahmen: `|ρ|` misst Risikogemeinschaft unabhängig von der Richtung.
 * Grenzen: Single-Linkage kann Ketten bilden (A–B stark, B–C stark, A–C
 * schwach ⇒ ein Cluster); die Schwelle ist deshalb konservativ zu wählen.
 *
 * Deterministische Sortierung: Cluster aufsteigend nach ihrem kleinsten Symbol,
 * Mitglieder aufsteigend sortiert.
 */
export function correlationClusters(
  correlation: CorrelationMatrix,
  threshold = DEFAULT_CLUSTER_THRESHOLD
): CorrelationCluster[] {
  requireFinite(threshold, "threshold");
  if (threshold < 0 || threshold > 1) {
    throw new PortfolioError("INVALID_INPUT", "Cluster-Schwelle muss in [0, 1] liegen", { field: "threshold" });
  }
  const n = correlation.symbols.length;
  const parent = new Array<number>(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur];
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let i = 0; i < n; i++) {
    const row = correlation.matrix[i];
    if (!row || row.length !== n) {
      throw new PortfolioError("LENGTH_MISMATCH", `Korrelationszeile ${i} hat die falsche Länge`, {
        field: "matrix",
      });
    }
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(row[j]) >= threshold) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }
  const clusters: CorrelationCluster[] = [];
  for (const members of groups.values()) {
    const symbols = members.map((i) => correlation.symbols[i]).sort();
    let maxAbs = 0;
    for (const a of members) {
      for (const b of members) {
        if (a === b) continue;
        maxAbs = Math.max(maxAbs, Math.abs(correlation.matrix[a][b]));
      }
    }
    clusters.push({ id: 0, symbols, maxAbsCorrelation: roundTo(maxAbs, OUTPUT_DECIMALS) });
  }
  clusters.sort((a, b) => (a.symbols[0] < b.symbols[0] ? -1 : a.symbols[0] > b.symbols[0] ? 1 : 0));
  clusters.forEach((c, i) => {
    c.id = i;
  });
  return clusters;
}

/** Vollständiges Cluster-Ergebnis inkl. Schwelle und Verfahren. */
export function clusterAnalysis(
  correlation: CorrelationMatrix,
  threshold = DEFAULT_CLUSTER_THRESHOLD
): { threshold: number; method: CorrelationMethod; symbols: string[]; clusters: CorrelationCluster[] } {
  return {
    threshold,
    method: correlation.method,
    symbols: correlation.symbols.slice(),
    clusters: correlationClusters(correlation, threshold),
  };
}

/**
 * Baut aus {@link SeriesInput}s die ausgerichtete Renditematrix.
 *
 * Alle Serien müssen gleich lang sein — sonst `LENGTH_MISMATCH` (ein
 * „Auffüllen" würde die Kovarianz verfälschen).
 */
export function returnsMatrix(
  inputs: readonly SeriesInput[]
): { symbols: string[]; columns: number[][]; observations: number } {
  if (inputs.length === 0) {
    throw new PortfolioError("INVALID_INPUT", "mindestens eine Serie erforderlich", { field: "series" });
  }
  const symbols: string[] = [];
  const seen = new Set<string>();
  const columns = inputs.map((s) => {
    const symbol = typeof s.symbol === "string" ? s.symbol : "";
    if (!symbol) throw new PortfolioError("INVALID_SYMBOL", "symbol fehlt", { field: "symbol" });
    if (seen.has(symbol)) {
      throw new PortfolioError("INVALID_SYMBOL", `Symbol ${symbol} doppelt übergeben`, { field: "symbol" });
    }
    seen.add(symbol);
    symbols.push(symbol);
    return resolveLogReturns(s);
  });
  const length = columns[0].length;
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].length !== length) {
      throw new PortfolioError(
        "LENGTH_MISMATCH",
        `Serie ${symbols[i]} hat ${columns[i].length} Renditen, erwartet ${length}`,
        { field: "series", details: { symbol: symbols[i] } }
      );
    }
  }
  return { symbols, columns, observations: length };
}

/**
 * Kovarianz als {@link Matrix} (Float64Array) — Eingabe für den Optimierer.
 */
export function covarianceAsMatrix(estimate: CovarianceEstimate): Matrix {
  return fromRows(estimate.rows, "covariance");
}

/** Annualisiert eine Kovarianzmatrix (`Σ_a = A · Σ_p`). */
export function annualizeCovariance(cov: Matrix, annualization: number): Matrix {
  const A = validateAnnualization(annualization);
  const data = new Float64Array(cov.data.length);
  for (let i = 0; i < data.length; i++) data[i] = cov.data[i] * A;
  return { n: cov.n, data };
}
