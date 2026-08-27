/**
 * Portfolio-Optimizer (Task 05) — deterministisch, ohne Zufall und ohne I/O.
 *
 * Drei Modi:
 *
 * **`min_variance`** — `min w'Σw` unter `Σw = 1`, `l ≤ w ≤ u`
 * (Default long-only: `l = 0`). Konvexes QP ⇒ jedes lokale Minimum ist global.
 * Solver: FISTA (beschleunigtes projiziertes Gradientenverfahren) mit
 * Funktionswert-Restart, Schrittweite `1/λ_max` (Power-Iteration), danach ein
 * **exakter Active-Set-Polish**: das KKT-System auf der freien Menge wird per
 * Cholesky gelöst, wodurch die Lösung Maschinenpräzision erreicht.
 *
 * **`max_sharpe`** — `max (μ'w − rf)/√(w'Σw)` unter denselben Nebenbedingungen.
 * `S(w)` ist quasikonkav, d. h. jedes lokale Maximum auf der konvexen Menge ist
 * global. Solver: monotones projiziertes Gradienten-**aufstiegs**verfahren mit
 * adaptiver Schrittweite und **Multi-Start** aus drei deterministischen Punkten
 * (gleichgewichtet, Min-Variance, Vertex des höchsten Excess-Return).
 *
 * **`risk_parity`** — gleiche Risk Contributions `wᵢ(Σw)ᵢ = wⱼ(Σw)ⱼ`.
 * Solver: Newton-Verfahren auf der konvexen Spinu-Funktion
 * `F(w) = ½·w'Σw − (1/n)·Σ ln wᵢ`, deren Optimum exakt `wᵢ(Σw)ᵢ = 1/n`
 * erfüllt. Hesse-Matrix `Σ + (1/n)·diag(1/wᵢ²)` ist stets positiv definit ⇒
 * Cholesky bricht nie ab. Start `w = 1/n` (deterministisch).
 *
 * Konvergenz wird **immer** gemeldet (`converged`, `iterations`,
 * `stationarity`); bei Nicht-Konvergenz wird das Ergebnis nicht verschwiegen,
 * sondern mit `converged: false` und einer `NOT_CONVERGED`-Diagnose geliefert.
 */

import {
  closeRoundingGap,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_SOLVER_TOLERANCE,
  OUTPUT_DECIMALS,
  resolveSolverOptions,
  roundTo,
  roundVector,
  validateAnnualization,
} from "./config";
import { PortfolioError, requireFinite } from "./errors";
import {
  cholesky,
  choleskySolve,
  estimateMaxEigenvalue,
  matVec,
  projectOntoBoxSimplex,
  quadForm,
  regularizeCovariance,
  submatrix,
  type Matrix,
} from "./numeric";
import { OPTIMIZER_AUTHORITY, type OptimizationDiagnostics, type OptimizationMode, type RawOptimizationResult, type SolverOptions, type WeightBounds } from "./types";

/** Anfrage an den Optimierer (alles pro Periode, keine Uhr, kein I/O). */
export interface OptimizationRequest {
  /** Symbole in Matrix-Reihenfolge. */
  symbols: readonly string[];
  /** Kovarianzmatrix pro Periode. */
  covariance: Matrix;
  /** Erwartete Renditen pro Periode (Pflicht für `max_sharpe`). */
  expectedReturns?: readonly number[];
  /** Risikofreier Zins **pro Periode** (Default 0). */
  riskFreeRate?: number;
  /** Optimierungs-Modus. */
  mode: OptimizationMode;
  /** Gewichtsschranken. */
  bounds?: WeightBounds;
  /** Long-only (Default true) — setzt die Untergrenze auf `max(0, minWeight)`. */
  longOnly?: boolean;
  /** Solver-Parameter. */
  solver?: SolverOptions;
  /** Annualisierungsfaktor für die Berichterstattung (Default 252). */
  annualization?: number;
}

/** Wirksame Bounds (nach Auflösung von Defaults und Overrides). */
export interface ResolvedBounds {
  /** Untergrenzen je Asset. */
  lower: number[];
  /** Obergrenzen je Asset. */
  upper: number[];
  /** Summe der Untergrenzen. */
  sumLower: number;
  /** Summe der Obergrenzen. */
  sumUpper: number;
}

/**
 * Löst Defaults, Long-only-Flag und Asset-Overrides zu konkreten Bounds auf.
 *
 * @throws PortfolioError `INFEASIBLE_CONSTRAINTS` wenn `Σl > 1` oder `Σu < 1` —
 *         dann existiert **kein** zulässiges Portfolio.
 */
export function resolveBounds(n: number, bounds: WeightBounds = {}, longOnly = true): ResolvedBounds {
  const minWeight = bounds.minWeight ?? 0;
  const maxWeight = bounds.maxWeight ?? 1;
  requireFinite(minWeight, "bounds.minWeight");
  requireFinite(maxWeight, "bounds.maxWeight");
  if (maxWeight <= 0) {
    throw new PortfolioError("INVALID_INPUT", "bounds.maxWeight muss > 0 sein", { field: "bounds.maxWeight" });
  }
  const lower = new Array<number>(n);
  const upper = new Array<number>(n);
  let sumLower = 0;
  let sumUpper = 0;
  for (let i = 0; i < n; i++) {
    let lo = bounds.lower ? bounds.lower[i] : minWeight;
    let hi = bounds.upper ? bounds.upper[i] : maxWeight;
    if (bounds.lower && !Number.isFinite(lo)) {
      throw new PortfolioError("INVALID_INPUT", `bounds.lower[${i}] ist keine endliche Zahl`, { field: "bounds.lower" });
    }
    if (bounds.upper && !Number.isFinite(hi)) {
      throw new PortfolioError("INVALID_INPUT", `bounds.upper[${i}] ist keine endliche Zahl`, { field: "bounds.upper" });
    }
    if (longOnly) lo = Math.max(0, lo);
    if (lo > hi) {
      throw new PortfolioError("INFEASIBLE_CONSTRAINTS", `Untergrenze ${lo} > Obergrenze ${hi} bei Asset ${i}`, {
        field: "bounds",
        details: { index: i, lower: lo, upper: hi },
      });
    }
    lower[i] = lo;
    upper[i] = hi;
    sumLower += lo;
    sumUpper += hi;
  }
  if (sumLower - 1 > 1e-12) {
    throw new PortfolioError(
      "INFEASIBLE_CONSTRAINTS",
      `Σ Untergrenzen = ${sumLower} > 1: kein zulässiges Portfolio`,
      { field: "bounds", details: { sumLower } }
    );
  }
  if (sumUpper - 1 < -1e-12) {
    throw new PortfolioError(
      "INFEASIBLE_CONSTRAINTS",
      `Σ Obergrenzen = ${sumUpper} < 1: kein zulässiges Portfolio`,
      { field: "bounds", details: { sumUpper } }
    );
  }
  return { lower, upper, sumLower, sumUpper };
}

/**
 * Risk Contributions eines Portfolios.
 *
 * Formel: `RCᵢ = wᵢ·(Σw)ᵢ / (w'Σw)`; `Σᵢ RCᵢ = 1`.
 * Bei `w'Σw = 0` wird ein Gleichanteil `1/n` geliefert (defensiv, dokumentiert).
 */
export function riskContributions(weights: readonly number[], covariance: Matrix): number[] {
  const sw = matVec(covariance, weights);
  const total = quadForm(covariance, weights);
  const n = weights.length;
  if (!(total > 0)) return new Array<number>(n).fill(1 / n);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = (weights[i] * sw[i]) / total;
  return out;
}

/** Erwartete Portfoliorendite `μ'w` (pro Periode). */
export function expectedPortfolioReturn(weights: readonly number[], expectedReturns: readonly number[]): number {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) acc += weights[i] * expectedReturns[i];
  return acc;
}

/** Internes Solver-Ergebnis (vor der Diagnose). */
interface SolverOutput {
  weights: number[];
  converged: boolean;
  iterations: number;
  objective: number;
  stationarity: number;
  polished: boolean | null;
}

/**
 * Exakte Projektion auf die Box-Simplex-Menge (weitergereicht an
 * {@link projectOntoBoxSimplex}).
 */
function project(x: readonly number[], lower: readonly number[], upper: readonly number[]): number[] {
  return Array.from(projectOntoBoxSimplex(x, lower, upper, 1));
}

/**
 * `min_variance`: FISTA + Active-Set-Polish.
 *
 * Zielfunktion `f(w) = ½·w'Σw`, Gradient `∇f = Σw`.
 * Abbruchkriterium: Gradientenabbildung `‖y − P(y − ∇f(y)/L)‖∞ ≤ tol`.
 */
function solveMinVariance(
  covariance: Matrix,
  bounds: ResolvedBounds,
  options: { tolerance: number; maxIterations: number }
): SolverOutput {
  const n = covariance.n;
  const lambdaMax = Math.max(1e-300, estimateMaxEigenvalue(covariance));
  const step = 1 / lambdaMax;
  const zero = new Array<number>(n).fill(0);
  let wPrev = project(zero, bounds.lower, bounds.upper);
  let y = wPrev.slice();
  let t = 1;
  let objective = 0.5 * quadForm(covariance, wPrev);
  let iterations = 0;
  let converged = false;
  let stationarity = Infinity;

  for (let iter = 1; iter <= options.maxIterations; iter++) {
    iterations = iter;
    const grad = matVec(covariance, y);
    const candidate = new Array<number>(n);
    for (let i = 0; i < n; i++) candidate[i] = y[i] - step * grad[i];
    const wNew = project(candidate, bounds.lower, bounds.upper);

    // Gradientenabbildung an der Stelle y — das Standard-Kriterium für
    // projizierte Gradientenverfahren und kostenlos verfügbar.
    let gap = 0;
    for (let i = 0; i < n; i++) gap = Math.max(gap, Math.abs(y[i] - wNew[i]));
    stationarity = gap / step;

    const objectiveNew = 0.5 * quadForm(covariance, wNew);
    const scale = Math.max(1, Math.abs(objectiveNew));
    if (gap <= options.tolerance && Math.abs(objectiveNew - objective) <= options.tolerance * scale) {
      wPrev = wNew;
      objective = objectiveNew;
      converged = true;
      break;
    }

    if (objectiveNew > objective) {
      // Funktionswert-Restart: Momentum verwerfen, sonst oszilliert FISTA.
      y = wNew;
      t = 1;
    } else {
      const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
      const momentum = (t - 1) / tNext;
      for (let i = 0; i < n; i++) y[i] = wNew[i] + momentum * (wNew[i] - wPrev[i]);
      t = tNext;
    }
    wPrev = wNew;
    objective = objectiveNew;
  }

  const polished = polishActiveSet(covariance, wPrev, bounds, options.tolerance);
  if (polished) {
    wPrev = polished.weights;
    objective = 0.5 * quadForm(covariance, wPrev);
  }
  return {
    weights: wPrev,
    converged,
    iterations,
    objective,
    stationarity,
    polished: polished !== null,
  };
}

/**
 * Active-Set-Polish für das box-beschränkte Min-Variance-QP.
 *
 * KKT-Bedingungen auf der freien Menge `F`:
 * `Σ_FF·w_F + b = ν·1` mit `b = Σ_F,A·w_A` und `1'w_F = 1 − Σ_A w_A`
 * ⇒ `ν = (c + 1'Σ_FF⁻¹b) / (1'Σ_FF⁻¹1)`, `w_F = Σ_FF⁻¹(ν·1 − b)`.
 *
 * Verletzt die exakte Lösung eine Schranke, wird die am stärksten verletzende
 * Komponente an ihre Grenze gesetzt und neu gelöst (max. `n` Runden).
 * Liefert `null`, wenn keine Verbesserung möglich ist.
 */
function polishActiveSet(
  covariance: Matrix,
  start: readonly number[],
  bounds: ResolvedBounds,
  tolerance: number
): { weights: number[] } | null {
  const n = covariance.n;
  const eps = Math.max(tolerance, 1e-12);
  const w = Float64Array.from(start);
  for (let round = 0; round <= n; round++) {
    const free: number[] = [];
    for (let i = 0; i < n; i++) {
      if (w[i] > bounds.lower[i] + eps && w[i] < bounds.upper[i] - eps) free.push(i);
    }
    let fixedSum = 0;
    for (let i = 0; i < n; i++) {
      if (w[i] <= bounds.lower[i] + eps) w[i] = bounds.lower[i];
      else if (w[i] >= bounds.upper[i] - eps) w[i] = bounds.upper[i];
      else continue;
      fixedSum += w[i];
    }
    if (free.length === 0) break;
    const c = 1 - fixedSum;
    const sub = submatrix(covariance, free);
    const k = free.length;
    // b = Σ_{F,A} · w_A  (A = Menge der an ihrer Grenze fixierten Assets)
    const isFree = new Uint8Array(n);
    for (const i of free) isFree[i] = 1;
    const b = new Float64Array(k);
    for (let a = 0; a < k; a++) {
      let acc = 0;
      const rowBase = free[a] * n;
      for (let i = 0; i < n; i++) {
        if (isFree[i] === 1) continue;
        acc += covariance.data[rowBase + i] * w[i];
      }
      b[a] = acc;
    }
    let L: Float64Array;
    try {
      L = cholesky(sub, "covariance[freie Menge]");
    } catch {
      return null;
    }
    const ones = new Float64Array(k).fill(1);
    const invOnes = choleskySolve(L, k, ones);
    const invB = choleskySolve(L, k, b);
    let onesInvOnes = 0;
    let onesInvB = 0;
    for (let i = 0; i < k; i++) {
      onesInvOnes += invOnes[i];
      onesInvB += invB[i];
    }
    if (!(onesInvOnes > 0)) return null;
    const nu = (c + onesInvB) / onesInvOnes;
    let violation = 0;
    let violator = -1;
    for (let a = 0; a < k; a++) {
      const value = nu * invOnes[a] - invB[a];
      w[free[a]] = value;
      const lo = bounds.lower[free[a]];
      const hi = bounds.upper[free[a]];
      const v = Math.max(lo - value, value - hi, 0);
      if (v > violation) {
        violation = v;
        violator = free[a];
      }
    }
    if (violation <= eps) break;
    // Am stärksten verletzende Komponente an ihre Grenze setzen und neu lösen.
    const lo = bounds.lower[violator];
    const hi = bounds.upper[violator];
    w[violator] = w[violator] < lo ? lo : hi;
  }

  // Restresiduum der Summenbedingung deterministisch auf freie Komponenten.
  let sum = 0;
  for (let i = 0; i < n; i++) sum += w[i];
  const residual = 1 - sum;
  if (Math.abs(residual) > 1e-9) {
    const free: number[] = [];
    for (let i = 0; i < n; i++) {
      if (w[i] > bounds.lower[i] + 1e-15 && w[i] < bounds.upper[i] - 1e-15) free.push(i);
    }
    if (free.length === 0) return null;
    const delta = residual / free.length;
    for (const i of free) w[i] += delta;
  }
  for (let i = 0; i < n; i++) {
    w[i] = Math.min(bounds.upper[i], Math.max(bounds.lower[i], w[i]));
  }
  return { weights: Array.from(w) };
}

/**
 * `max_sharpe`: monotones projiziertes Aufstiegsverfahren mit Multi-Start.
 *
 * Zielfunktion `S(w) = (e'w)/√(w'Σw)` mit `e = μ − rf` (wegen `Σw = 1` gilt
 * `μ'w − rf = e'w`). Gradient:
 * `∇S = e/√q − (e'w)·Σw / q^{3/2}`, `q = w'Σw`.
 *
 * Jeder Start wird bis zur Stationarität geführt; das beste Ergebnis gewinnt.
 * Die Startpunkte sind fest (kein Zufall): gleichgewichtet, Min-Variance und
 * der Vertex des höchsten Excess-Return.
 */
function solveMaxSharpe(
  covariance: Matrix,
  excess: readonly number[],
  bounds: ResolvedBounds,
  options: { tolerance: number; maxIterations: number }
): SolverOutput {
  const n = covariance.n;
  const lambdaMax = Math.max(1e-300, estimateMaxEigenvalue(covariance));

  const sharpeOf = (w: readonly number[]): number => {
    const q = quadForm(covariance, w);
    if (!(q > 0)) return 0;
    let num = 0;
    for (let i = 0; i < n; i++) num += excess[i] * w[i];
    return num / Math.sqrt(q);
  };
  const gradientOf = (w: readonly number[], out: Float64Array): number => {
    const sw = matVec(covariance, w);
    const q = quadForm(covariance, w);
    if (!(q > 0)) {
      out.fill(0);
      return 0;
    }
    const sqrtQ = Math.sqrt(q);
    let num = 0;
    for (let i = 0; i < n; i++) num += excess[i] * w[i];
    const factor = num / (q * sqrtQ);
    for (let i = 0; i < n; i++) out[i] = excess[i] / sqrtQ - factor * sw[i];
    let norm = 0;
    for (let i = 0; i < n; i++) norm = Math.max(norm, Math.abs(out[i]));
    return norm;
  };

  const ascend = (start: readonly number[]): { weights: number[]; iterations: number; converged: boolean; gap: number } => {
    let w = project(Array.from(start), bounds.lower, bounds.upper);
    let best = sharpeOf(w);
    let step = 1 / lambdaMax;
    let iterations = 0;
    let converged = false;
    let gap = Infinity;
    const grad = new Float64Array(n);
    for (let iter = 1; iter <= options.maxIterations; iter++) {
      iterations = iter;
      const gradNorm = gradientOf(w, grad);
      const candidate = new Array<number>(n);
      for (let i = 0; i < n; i++) candidate[i] = w[i] + step * grad[i];
      const projected = project(candidate, bounds.lower, bounds.upper);
      let localGap = 0;
      for (let i = 0; i < n; i++) localGap = Math.max(localGap, Math.abs(projected[i] - w[i]));
      gap = localGap;
      if (localGap <= options.tolerance) {
        converged = true;
        break;
      }
      // Monotone Schrittweitensteuerung: akzeptiere nur echte Verbesserungen.
      let accepted: number[] | null = null;
      let value = best;
      let t = step;
      for (let attempt = 0; attempt < 40; attempt++) {
        const trial = new Array<number>(n);
        for (let i = 0; i < n; i++) trial[i] = w[i] + t * grad[i];
        const p = project(trial, bounds.lower, bounds.upper);
        const v = sharpeOf(p);
        if (v > value + 1e-18) {
          accepted = p;
          value = v;
          break;
        }
        t /= 2;
      }
      if (!accepted) {
        // Keine Verbesserung mehr möglich ⇒ stationär.
        converged = gradNorm <= options.tolerance * Math.max(1, Math.abs(best));
        break;
      }
      step = Math.min(t * 1.5, 1 / lambdaMax);
      w = accepted;
      best = value;
    }
    return { weights: Array.from(w), iterations, converged, gap };
  };

  // Start 1: gleichgewichtet (projiziert auf die Bounds).
  const equal = project(new Array<number>(n).fill(0), bounds.lower, bounds.upper);
  // Start 2: Min-Variance-Lösung.
  const minVar = solveMinVariance(covariance, bounds, {
    tolerance: options.tolerance,
    maxIterations: options.maxIterations,
  });
  // Start 3: Vertex des höchsten Excess-Return (deterministisch bei Gleichstand).
  let bestAsset = 0;
  for (let i = 1; i < n; i++) if (excess[i] > excess[bestAsset]) bestAsset = i;
  const vertex = new Array<number>(n).fill(0);
  vertex[bestAsset] = 1;

  const candidates: { weights: number[]; iterations: number; converged: boolean; gap: number }[] = [];
  for (const start of [Array.from(equal), minVar.weights, vertex]) {
    candidates.push(ascend(start));
  }
  let chosen = candidates[0];
  let chosenValue = sharpeOf(chosen.weights);
  let totalIterations = 0;
  for (const c of candidates) {
    totalIterations += c.iterations;
    const value = sharpeOf(c.weights);
    if (value > chosenValue) {
      chosen = c;
      chosenValue = value;
    }
  }
  return {
    weights: chosen.weights,
    converged: chosen.converged,
    iterations: totalIterations,
    objective: chosenValue,
    stationarity: chosen.gap,
    polished: null,
  };
}

/**
 * `risk_parity`: Newton-Verfahren auf der Spinu-Funktion.
 *
 * `F(w) = ½·w'Σw − (1/n)·Σ ln wᵢ`,  `∇F = Σw − (1/n)·w⁻²`,
 * `H = Σ + (1/n)·diag(w⁻³·w) = Σ + (1/n)·diag(1/wᵢ²)`.
 *
 * Am Optimum gilt `wᵢ·(Σw)ᵢ = 1/n` für alle `i` ⇒ identische Risk
 * Contributions. Die Iteration startet bei `w = 1/n` und nutzt eine
 * gedämpfte Liniensuche (Halbierung), die `w > 0` garantiert.
 */
function solveRiskParity(
  covariance: Matrix,
  options: { tolerance: number; maxIterations: number }
): SolverOutput {
  const n = covariance.n;
  let w: number[] = new Array<number>(n).fill(1 / n);
  const objectiveOf = (x: readonly number[]): number => {
    let value = 0.5 * quadForm(covariance, x);
    for (let i = 0; i < n; i++) value -= Math.log(x[i]) / n;
    return value;
  };
  /**
   * ∞-Norm des Gradienten `∇F = Σw − (1/n)·w⁻²`, relativ zur Skala von `Σw`.
   * Das ist das eigentliche Stationaritätsmaß: am Optimum ist `∇F = 0` und
   * damit `wᵢ(Σw)ᵢ = 1/n` für alle `i`.
   */
  const gradientNormOf = (x: readonly number[]): { norm: number; scale: number; sw: Float64Array } => {
    const sw = matVec(covariance, x);
    let norm = 0;
    let scale = 0;
    for (let i = 0; i < n; i++) {
      norm = Math.max(norm, Math.abs(sw[i] - 1 / (n * x[i])));
      scale = Math.max(scale, Math.abs(sw[i]));
    }
    return { norm, scale, sw };
  };
  /** Spread der Risk Contributions — die Zielgröße der Eigenschaftstests. */
  const spreadOf = (x: readonly number[], sw: Float64Array): number => {
    const total = quadForm(covariance, x);
    if (!(total > 0)) return Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const rc = (x[i] * sw[i]) / total;
      lo = Math.min(lo, rc);
      hi = Math.max(hi, rc);
    }
    return hi - lo;
  };

  let objective = objectiveOf(w);
  let iterations = 0;
  let converged = false;
  let spread = Infinity;

  for (let iter = 1; iter <= options.maxIterations; iter++) {
    iterations = iter;
    const { norm, scale, sw } = gradientNormOf(w);
    spread = spreadOf(w, sw);
    if (norm <= options.tolerance * Math.max(1, scale)) {
      converged = true;
      break;
    }

    const hess = { n, data: Float64Array.from(covariance.data) };
    const negGrad = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      negGrad[i] = -(sw[i] - 1 / (n * w[i]));
      hess.data[i * n + i] += 1 / (n * w[i] * w[i]);
    }
    let L: Float64Array;
    try {
      L = cholesky(hess, "hesse[risk-parity]");
    } catch {
      break;
    }
    const direction = choleskySolve(L, n, negGrad);
    let stepNorm = 0;
    for (let i = 0; i < n; i++) stepNorm = Math.max(stepNorm, Math.abs(direction[i]));

    let t = 1;
    let accepted: number[] | null = null;
    let acceptedValue = objective;
    for (let attempt = 0; attempt < 60; attempt++) {
      const trial = new Array<number>(n);
      let valid = true;
      for (let i = 0; i < n; i++) {
        const v = w[i] + t * direction[i];
        if (!(v > 0)) {
          valid = false;
          break;
        }
        trial[i] = v;
      }
      if (valid) {
        const value = objectiveOf(trial);
        if (value < objective - 1e-18) {
          accepted = trial;
          acceptedValue = value;
          break;
        }
      }
      t /= 2;
    }
    if (!accepted) {
      // Die Liniensuche findet keine Verbesserung mehr ⇒ numerisch stationär.
      // Ob das „konvergiert" heißt, entscheidet das Stationaritätsmaß, nicht
      // die Schrittweite (Gleitkommagenauigkeit begrenzt den Fortschritt).
      const rest = gradientNormOf(w);
      converged = rest.norm <= options.tolerance * Math.max(1, rest.scale);
      spread = spreadOf(w, rest.sw);
      break;
    }
    w = accepted;
    objective = acceptedValue;
    if (stepNorm <= options.tolerance) {
      const rest = gradientNormOf(w);
      spread = spreadOf(w, rest.sw);
      converged = rest.norm <= options.tolerance * Math.max(1, rest.scale);
      break;
    }
  }

  const sum = w.reduce((a, b) => a + b, 0);
  const normalized = w.map((v) => v / sum);
  return {
    weights: normalized,
    converged,
    iterations,
    objective,
    stationarity: spread,
    polished: null,
  };
}

/**
 * Führt eine Portfolio-Optimierung aus.
 *
 * Das Ergebnis ist ein {@link RawOptimizationResult} — **ungeprüft** und damit
 * ausdrücklich nicht handelbar. Es muss durch die Risk-Guard-Kette
 * (`applyRiskGuard` / `optimizeWithGuard`), bevor es verwendet wird.
 *
 * @throws PortfolioError `INVALID_INPUT`, `SINGULAR_MATRIX` (Policy `error`),
 *         `INFEASIBLE_CONSTRAINTS`, `LIMIT_EXCEEDED`.
 */
export function optimizePortfolio(request: OptimizationRequest): RawOptimizationResult {
  const { symbols, covariance, mode } = request;
  const n = covariance.n;
  if (symbols.length !== n) {
    throw new PortfolioError("LENGTH_MISMATCH", `${symbols.length} Symbole für eine ${n}×${n}-Matrix`, {
      field: "symbols",
    });
  }
  if (n === 0) throw new PortfolioError("INVALID_INPUT", "leeres Universum", { field: "symbols" });
  const annualization = validateAnnualization(request.annualization ?? 252);
  const solver = resolveSolverOptions(request.solver ?? {});
  const bounds = resolveBounds(n, request.bounds ?? {}, request.longOnly ?? true);
  const riskFreeRatePerPeriod = request.riskFreeRate === undefined ? 0 : requireFinite(request.riskFreeRate, "riskFreeRate");

  const regularized = regularizeCovariance(covariance, request.solver?.singularMatrixPolicy ?? "error", {
    ridgeFactor: solver.ridgeFactor,
    rcond: solver.rcond,
  });
  const cov = regularized.matrix;

  let output: SolverOutput;
  switch (mode) {
    case "min_variance":
      output = solveMinVariance(cov, bounds, solver);
      break;
    case "max_sharpe": {
      if (!request.expectedReturns || request.expectedReturns.length !== n) {
        throw new PortfolioError("INVALID_INPUT", "max_sharpe benötigt expectedReturns je Asset", {
          field: "expectedReturns",
        });
      }
      const excess = request.expectedReturns.map((mu) => requireFinite(mu, "expectedReturns") - riskFreeRatePerPeriod);
      output = solveMaxSharpe(cov, excess, bounds, solver);
      break;
    }
    case "risk_parity":
      output = solveRiskParity(cov, solver);
      break;
    default:
      throw new PortfolioError("INVALID_INPUT", `unbekannter Modus ${String(mode)}`, { field: "mode" });
  }

  const notes: string[] = [];
  if (!output.converged) {
    notes.push(`NOT_CONVERGED:iterations=${output.iterations}`);
  }
  if (regularized.applied !== "none") {
    notes.push(`COVARIANCE_REGULARIZED:${regularized.applied}`);
  }

  // Bounds-Durchsetzung. Für `min_variance`/`max_sharpe` ist das ein
  // Sicherheitsnetz (der Solver projiziert ohnehin); für `risk_parity` ist es
  // notwendig, weil gleiche Risk Contributions und harte Gewichtsgrenzen
  // mathematisch nicht gleichzeitig erfüllbar sein müssen. Nichts wird still
  // verletzt — die Projektion wird als Note protokolliert.
  let solved = output.weights;
  let violations = 0;
  for (let i = 0; i < n; i++) {
    if (solved[i] < bounds.lower[i] - 1e-9 || solved[i] > bounds.upper[i] + 1e-9) violations++;
  }
  if (violations > 0) {
    solved = Array.from(projectOntoBoxSimplex(solved, bounds.lower, bounds.upper, 1));
    notes.push(`BOUNDS_PROJECTED:violations=${violations}`);
  }

  const weights = roundVector(solved, OUTPUT_DECIMALS);
  // Rundung kann die Summenbedingung verletzen ⇒ Residuum auf die größte
  // freie Komponente (deterministisch, ändert kein Gewicht sichtbar).
  closeRoundingGap(weights, 1, (i) => weights[i] >= bounds.upper[i] - 1e-13);

  const variance = quadForm(cov, weights);
  const volatility = Math.sqrt(Math.max(variance, 0));
  const rc = riskContributions(weights, cov);
  let expectedReturn: number | null = null;
  let sharpe: number | null = null;
  if (request.expectedReturns && request.expectedReturns.length === n) {
    expectedReturn = roundTo(expectedPortfolioReturn(weights, request.expectedReturns), OUTPUT_DECIMALS);
    sharpe = volatility > 0 ? roundTo((expectedReturn - riskFreeRatePerPeriod) / volatility, OUTPUT_DECIMALS) : null;
  }

  const diagnostics: OptimizationDiagnostics = {
    mode,
    converged: output.converged,
    iterations: output.iterations,
    objective: roundTo(output.objective, OUTPUT_DECIMALS),
    stationarity: roundTo(output.stationarity, OUTPUT_DECIMALS),
    variance: roundTo(variance, OUTPUT_DECIMALS),
    volatility: roundTo(volatility, OUTPUT_DECIMALS),
    annualizedVolatility: roundTo(volatility * Math.sqrt(annualization), OUTPUT_DECIMALS),
    expectedReturn,
    sharpe,
    riskContributions: roundVector(rc, OUTPUT_DECIMALS),
    regularization: { applied: regularized.applied, ridge: regularized.ridge },
    polished: output.polished,
    notes,
  };

  return {
    authority: OPTIMIZER_AUTHORITY,
    symbols: symbols.slice(),
    weights,
    mode,
    diagnostics,
    bounds: { lower: bounds.lower.slice(), upper: bounds.upper.slice() },
  };
}

/** Standard-Toleranz des Solvers (Doku/Tests). */
export const SOLVER_DEFAULT_TOLERANCE = DEFAULT_SOLVER_TOLERANCE;
/** Standard-Iterationslimit des Solvers (Doku/Tests). */
export const SOLVER_DEFAULT_MAX_ITERATIONS = DEFAULT_MAX_ITERATIONS;

/**
 * Nicht-Konvergenz als strukturierte Diagnose (für Guard/Audit/API).
 *
 * Die Optimierung wird bei Nicht-Konvergenz **nicht** verworfen — die Risk
 * Guard entscheidet. Aber der Zustand muss sichtbar sein (Architektur-Regel 3).
 */
export function convergenceWarning(result: RawOptimizationResult): string | null {
  if (result.diagnostics.converged) return null;
  return `NOT_CONVERGED: ${result.mode} erreichte nach ${result.diagnostics.iterations} Iterationen die Toleranz nicht (Stationarität ${result.diagnostics.stationarity})`;
}
