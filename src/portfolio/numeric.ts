/**
 * Numerische Primitives des Portfolio-Moduls (Task 05).
 *
 * Alles ist **rein und deterministisch**: keine Zufallszahlen, keine Uhr, kein
 * I/O. Matrizen liegen als row-major `Float64Array` vor — bei 500 Assets ist
 * das ~2 MB und deutlich cache-freundlicher als verschachtelte Arrays.
 *
 * Robustheitsregeln (Architektur-Regel 3):
 *   - Cholesky bricht bei nicht positiv definiten Matrizen mit einem klaren
 *     `SINGULAR_MATRIX`-Fehler ab — nie mit einem still falschen Ergebnis.
 *   - Die Pseudo-Inverse entsteht über eine zykliche Jacobi-Eigenzerlegung
 *     (deterministisch, ohne Zufallsstart) mit Rangschwelle `rcond`.
 *   - Alle Verfahren melden Konvergenz bzw. Nicht-Konvergenz explizit.
 */

import { DEFAULT_RCOND, DEFAULT_RIDGE_FACTOR } from "./config";
import { PortfolioError, describe } from "./errors";
import type { SingularMatrixPolicy } from "./types";

/** Symmetrische quadratische Matrix in row-major-Darstellung. */
export interface Matrix {
  /** Dimension (Anzahl Zeilen = Anzahl Spalten). */
  readonly n: number;
  /** `n × n` Einträge, row-major. */
  readonly data: Float64Array;
}

/** Vektor als `Float64Array` oder gewöhnliches Zahlenarray. */
export type VectorLike = readonly number[] | Float64Array;

/**
 * Arithmetisches Mittel.
 *
 * Formel: `x̄ = (1/n) · Σᵢ xᵢ`.
 *
 * @throws PortfolioError `INSUFFICIENT_DATA` bei leerer Liste,
 *         `INVALID_INPUT` bei NaN/±∞.
 */
export function mean(values: VectorLike): number {
  const n = values.length;
  if (n === 0) throw new PortfolioError("INSUFFICIENT_DATA", "Mittelwert einer leeren Serie ist undefiniert");
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      throw new PortfolioError("INVALID_INPUT", `Wert ${i} ist keine endliche Zahl`, {
        field: "values",
        details: { index: i },
      });
    }
    sum += v;
  }
  return sum / n;
}

/**
 * Varianz mit einstellbaren Freiheitsgraden.
 *
 * Formel: `s² = Σᵢ (xᵢ − x̄)² / (n − ddof)` — `ddof = 1` ist die erwartungs-
 * treue Stichprobenvarianz, `ddof = 0` die Populationsvarianz.
 *
 * @throws PortfolioError `INSUFFICIENT_DATA` wenn `n − ddof ≤ 0`.
 */
export function variance(values: VectorLike, ddof = 1): number {
  const n = values.length;
  if (n - ddof <= 0) {
    throw new PortfolioError("INSUFFICIENT_DATA", `Varianz benötigt mehr als ${ddof} Werte, gefunden ${n}`, {
      field: "values",
    });
  }
  const m = mean(values);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - m;
    acc += d * d;
  }
  const v = acc / (n - ddof);
  if (!Number.isFinite(v)) {
    throw new PortfolioError("NUMERIC_FAILURE", "Varianz ist nicht endlich (Eingabe zu groß?)", { field: "values" });
  }
  return v;
}

/**
 * Standardabweichung `s = √Varianz` (siehe {@link variance}).
 */
export function stdDev(values: VectorLike, ddof = 1): number {
  return Math.sqrt(variance(values, ddof));
}

/**
 * Ränge einer Serie mit **Durchschnittsrang** bei Gleichstand (1-basiert).
 *
 * Formel: `rank(xᵢ) = 1 + #{j : xⱼ < xᵢ} + (#{j : xⱼ = xᵢ} − 1)/2`.
 * Die Sortierung ist stabil über den Index, damit gleiche Eingaben immer
 * dieselbe Rangfolge ergeben.
 */
export function ranks(values: VectorLike): number[] {
  const n = values.length;
  const order = new Array<number>(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => values[a] - values[b] || a - b);
  const out = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]] = averageRank;
    i = j + 1;
  }
  return out;
}

/** Erzeugt eine `n × n`-Nullmatrix. */
export function zerosMatrix(n: number): Matrix {
  if (!Number.isInteger(n) || n <= 0) {
    throw new PortfolioError("INVALID_INPUT", `Dimension muss ganzzahlig > 0 sein, gefunden ${n}`, { field: "n" });
  }
  return { n, data: new Float64Array(n * n) };
}

/**
 * Baut eine symmetrische Matrix aus Zeilen.
 *
 * Asymmetrien werden durch Mittelung beseitigt (`(a + aᵀ)/2`), weil
 * Kovarianzmatrizen mathematisch symmetrisch sind und Gleitkomma-Rauschen
 * sonst die Eigenzerlegung stören würde.
 */
export function fromRows(rows: readonly (readonly number[])[], field = "matrix"): Matrix {
  const n = rows.length;
  if (n === 0) throw new PortfolioError("INVALID_INPUT", "leere Matrix", { field });
  const data = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (row.length !== n) {
      throw new PortfolioError("LENGTH_MISMATCH", `Zeile ${i} hat Länge ${row.length}, erwartet ${n}`, {
        field,
        details: { row: i },
      });
    }
    for (let j = 0; j < n; j++) {
      const v = row[j];
      if (!Number.isFinite(v)) {
        throw new PortfolioError("INVALID_INPUT", `Eintrag [${i}][${j}] ist keine endliche Zahl`, {
          field,
          details: { i, j },
        });
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) data[i * n + j] = (rows[i][j] + rows[j][i]) / 2;
  }
  return { n, data };
}

/** Wandelt eine Matrix in ein gewöhnliches Zeilenarray (für JSON-Ausgaben). */
export function toRows(m: Matrix): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < m.n; i++) {
    const row = new Array<number>(m.n);
    for (let j = 0; j < m.n; j++) row[j] = m.data[i * m.n + j];
    out.push(row);
  }
  return out;
}

/**
 * Matrix-Vektor-Produkt `y = A·x`.
 *
 * Formel: `yᵢ = Σⱼ Aᵢⱼ · xⱼ`.
 */
export function matVec(m: Matrix, x: VectorLike): Float64Array {
  if (x.length !== m.n) {
    throw new PortfolioError("LENGTH_MISMATCH", `Vektorlänge ${x.length} ≠ Matrixdimension ${m.n}`, {
      field: "x",
    });
  }
  const y = new Float64Array(m.n);
  const { data, n } = m;
  for (let i = 0; i < n; i++) {
    const base = i * n;
    let acc = 0;
    for (let j = 0; j < n; j++) acc += data[base + j] * x[j];
    y[i] = acc;
  }
  return y;
}

/**
 * Quadratische Form `x'·A·x` (Portfoliovarianz für `A = Σ`).
 *
 * Formel: `q = Σᵢ Σⱼ xᵢ Aᵢⱼ xⱼ`.
 */
export function quadForm(m: Matrix, x: VectorLike): number {
  const ax = matVec(m, x);
  let q = 0;
  for (let i = 0; i < m.n; i++) q += x[i] * ax[i];
  return q;
}

/** Spur einer Matrix `tr(A) = Σᵢ Aᵢᵢ`. */
export function trace(m: Matrix): number {
  let t = 0;
  for (let i = 0; i < m.n; i++) t += m.data[i * m.n + i];
  return t;
}

/**
 * Maximaler Betrag eines Matrixeintrags `‖A‖_max = max_ij |A_ij|`.
 *
 * Dient als Skalenreferenz für relative Toleranzen (Cholesky-Pivot, Regularisierung).
 */
export function maxAbsEntry(m: Matrix): number {
  let best = 0;
  for (let i = 0; i < m.data.length; i++) best = Math.max(best, Math.abs(m.data[i]));
  return best;
}

/** Prüft Symmetrie bis auf `tol`. */
export function isSymmetric(m: Matrix, tol = 1e-10): boolean {
  const { n, data } = m;
  const scale = Math.max(1, maxAbsEntry(m));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(data[i * n + j] - data[j * n + i]) > tol * scale) return false;
    }
  }
  return true;
}

/** Extrahiert die durch `indices` ausgewählte Untermatrix (für den Active-Set-Polish). */
export function submatrix(m: Matrix, indices: readonly number[]): Matrix {
  const k = indices.length;
  const out = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    const i = indices[a];
    for (let b = 0; b < k; b++) out[a * k + b] = m.data[i * m.n + indices[b]];
  }
  return { n: k, data: out };
}

/**
 * Relative Pivot-Schwelle der Cholesky-Zerlegung.
 *
 * Eine Kovarianzmatrix zweier perfekt korrelierter Assets hat Determinante 0,
 * liefert in Gleitkomma aber oft ein Pivot von ~1e-19 statt exakt 0 — die
 * Zerlegung „gelingt" und produziert danach Unsinn. Deshalb gilt ein Pivot
 * unterhalb `1e-12 · max(Aᵢᵢ)` als singulär.
 */
export const MIN_RELATIVE_PIVOT = 1e-12;

/**
 * Cholesky-Zerlegung `A = L·Lᵀ` einer symmetrisch positiv definiten Matrix.
 *
 * Formel:
 * `Lⱼⱼ = √(Aⱼⱼ − Σ_{k<j} Lⱼₖ²)`,
 * `Lᵢⱼ = (Aᵢⱼ − Σ_{k<j} Lᵢₖ·Lⱼₖ) / Lⱼⱼ` für `i > j`.
 *
 * @returns Untere Dreiecksmatrix `L` (row-major, `n × n`).
 * @throws PortfolioError `SINGULAR_MATRIX` wenn ein Pivot ≤ 0 wird **oder**
 *         unter die relative Schwelle {@link MIN_RELATIVE_PIVOT} fällt — das
 *         ist der definierte Fehlerfall für singuläre Kovarianzmatrizen
 *         (niemals ein still falsches Ergebnis).
 */
export function cholesky(
  m: Matrix,
  field = "covariance",
  options?: { minRelativePivot?: number }
): Float64Array {
  const { n, data } = m;
  const minRelativePivot = options?.minRelativePivot ?? MIN_RELATIVE_PIVOT;
  let maxDiagonal = 0;
  for (let i = 0; i < n; i++) maxDiagonal = Math.max(maxDiagonal, Math.abs(data[i * n + i]));
  const minPivot = minRelativePivot * (maxDiagonal > 0 ? maxDiagonal : 1);
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    let sum = data[j * n + j];
    for (let k = 0; k < j; k++) {
      const l = L[j * n + k];
      sum -= l * l;
    }
    if (!(sum > minPivot)) {
      throw new PortfolioError(
        "SINGULAR_MATRIX",
        `Cholesky fehlgeschlagen bei Index ${j} (Diagonalelement ${sum}) — Matrix ist singulär oder nicht positiv definit`,
        { field, details: { index: j, pivot: Number.isFinite(sum) ? sum : 0 } }
      );
    }
    const ljj = Math.sqrt(sum);
    L[j * n + j] = ljj;
    for (let i = j + 1; i < n; i++) {
      let s = data[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = s / ljj;
    }
  }
  return L;
}

/**
 * Löst `A·x = b` über eine vorhandene Cholesky-Zerlegung (Vorwärts-/Rückwärts-
 * substitution, `O(n²)`).
 */
export function choleskySolve(L: Float64Array, n: number, b: VectorLike): Float64Array {
  if (b.length !== n) {
    throw new PortfolioError("LENGTH_MISMATCH", `Vektorlänge ${b.length} ≠ ${n}`, { field: "b" });
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/**
 * Inverse einer symmetrisch positiv definiten Matrix über Cholesky:
 * `A⁻¹` mit `A = L·Lᵀ` (Rückwärtseinsetzen für jede Einheitsspalte).
 *
 * @throws PortfolioError `SINGULAR_MATRIX` wenn die Matrix nicht invertierbar ist.
 */
export function inverse(m: Matrix): Matrix {
  const L = cholesky(m);
  const { n } = m;
  const out = new Float64Array(n * n);
  const e = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    e.fill(0);
    e[j] = 1;
    const col = choleskySolve(L, n, e);
    for (let i = 0; i < n; i++) out[i * n + j] = col[i];
  }
  return { n, data: out };
}

/** Ergebnis einer Eigenzerlegung (symmetrische Matrix). */
export interface EigenDecomposition {
  /** Eigenwerte, aufsteigend sortiert. */
  values: Float64Array;
  /** Spaltenweise Eigenvektoren (row-major `n × n`, Spalte `k` = Vektor `k`). */
  vectors: Matrix;
  /** Durchlaufene Jacobi-Sweeps. */
  sweeps: number;
  /** true, wenn die Off-Diagonal-Norm unter die Toleranz fiel. */
  converged: boolean;
}

/**
 * Zykliche Jacobi-Eigenzerlegung einer symmetrischen Matrix.
 *
 * Verfahren: wiederhole über alle Paare `(p, q)`, `p < q`, eine Givens-Rotation
 * mit `tan(2θ) = 2Aₚq / (A_qq − A_pp)`, bis die Off-Diagonal-Frobeniusnorm
 * `‖off(A)‖_F ≤ tol · ‖A‖_F` ist. Vollständig deterministisch (feste Paar-
 * reihenfolge, kein Zufallsstart).
 *
 * @throws PortfolioError `NOT_CONVERGED` wenn `maxSweeps` nicht ausreichen.
 */
export function jacobiEigen(m: Matrix, options?: { tolerance?: number; maxSweeps?: number }): EigenDecomposition {
  const tolerance = options?.tolerance ?? 1e-12;
  const maxSweeps = options?.maxSweeps ?? 100;
  const { n } = m;
  const a = Float64Array.from(m.data);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  let frobenius = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) frobenius += a[i * n + j] ** 2;
  frobenius = Math.sqrt(frobenius) || 1;

  let sweeps = 0;
  let converged = false;
  for (; sweeps < maxSweeps; sweeps++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    }
    off = Math.sqrt(2 * off);
    if (off <= tolerance * frobenius) {
      converged = true;
      break;
    }
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) <= 1e-300) continue;
        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(1 + theta * theta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        for (let i = 0; i < n; i++) {
          const aip = a[i * n + p];
          const aiq = a[i * n + q];
          a[i * n + p] = c * aip - s * aiq;
          a[i * n + q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p * n + i];
          const aqi = a[q * n + i];
          a[p * n + i] = c * api - s * aqi;
          a[q * n + i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = v[i * n + p];
          const viq = v[i * n + q];
          v[i * n + p] = c * vip - s * viq;
          v[i * n + q] = s * vip + c * viq;
        }
      }
    }
  }

  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) values[i] = a[i * n + i];
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => values[x] - values[y]);
  const sortedValues = new Float64Array(n);
  const sortedVectors = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const src = order[k];
    sortedValues[k] = values[src];
    for (let i = 0; i < n; i++) sortedVectors[i * n + k] = v[i * n + src];
  }
  if (!converged) {
    throw new PortfolioError("NOT_CONVERGED", `Jacobi-Eigenzerlegung nach ${maxSweeps} Sweeps nicht konvergiert`, {
      field: "matrix",
      details: { sweeps: maxSweeps, n },
    });
  }
  return { values: sortedValues, vectors: { n, data: sortedVectors }, sweeps, converged };
}

/**
 * Moore-Penrose-Pseudo-Inverse einer symmetrischen Matrix.
 *
 * Formel: `A⁺ = V · diag(1/λᵢ für λᵢ > rcond·λ_max, sonst 0) · Vᵀ`
 * aus der Eigenzerlegung `A = V·diag(λ)·Vᵀ`. Eigenwerte unterhalb der
 * Rangschwelle werden **nicht** invertiert — deshalb liefert die
 * Pseudo-Inverse auch bei singulären Kovarianzmatrizen ein definiertes,
 * reproduzierbares Ergebnis (Konfiguration `singularMatrixPolicy`).
 */
export function pseudoInverse(m: Matrix, rcond = DEFAULT_RCOND): Matrix {
  const { values, vectors } = jacobiEigen(m);
  const n = m.n;
  const lambdaMax = Math.max(1e-300, Math.abs(values[n - 1]));
  const cutoff = rcond * lambdaMax;
  const inv = new Float64Array(n);
  for (let i = 0; i < n; i++) inv[i] = Math.abs(values[i]) > cutoff ? 1 / values[i] : 0;
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) {
        if (inv[k] === 0) continue;
        acc += vectors.data[i * n + k] * inv[k] * vectors.data[j * n + k];
      }
      out[i * n + j] = acc;
    }
  }
  return { n, data: out };
}

/** Ergebnis einer Regularisierungs-Entscheidung. */
export interface RegularizationResult {
  /** Verwendbare (positiv definite) Matrix. */
  matrix: Matrix;
  /** Angewendete Maßnahme. */
  applied: "none" | "ridge" | "pseudo-inverse";
  /** Wirksamer Ridge-Wert (0 bei `none`). */
  ridge: number;
  /** Kleinster Eigenwert der ursprünglichen Matrix (Schätzung, null wenn unbekannt). */
  minEigenvalue: number | null;
}

/**
 * Macht eine Kovarianzmatrix für den Solver verwendbar.
 *
 * Strategie (konfigurierbar, nie still):
 *   - `error` (Default): Cholesky-Probe; schlägt sie fehl ⇒ `SINGULAR_MATRIX`.
 *   - `ridge`: addiert `max(ridgeFactor · tr(Σ)/n, ridgeFactor)` auf die
 *     Diagonale, bis Cholesky gelingt (max. 8 Versuche, jeweils verdoppelt).
 *   - `pseudo-inverse`: wie `ridge`, zusätzlich wird die Pseudo-Inverse über
 *     die Eigenzerlegung berechnet und als Ridge-Äquivalent zurückgegeben.
 */
export function regularizeCovariance(
  m: Matrix,
  policy: SingularMatrixPolicy = "error",
  options?: { ridgeFactor?: number; rcond?: number }
): RegularizationResult {
  const ridgeFactor = options?.ridgeFactor ?? DEFAULT_RIDGE_FACTOR;
  const rcond = options?.rcond ?? DEFAULT_RCOND;
  // Eine negative Varianz ist keine Kovarianzmatrix: eigener Fehlercode, damit
  // ein Datenaustausch-Fehler nicht als „singulär" missverstanden wird.
  for (let i = 0; i < m.n; i++) {
    const diagonal = m.data[i * m.n + i];
    if (diagonal < 0) {
      throw new PortfolioError(
        "NOT_POSITIVE_DEFINITE",
        `Diagonalelement [${i}][${i}] ist negativ (${describe(diagonal)}) — keine gültige Kovarianzmatrix`,
        { field: "covariance", details: { index: i } }
      );
    }
  }
  try {
    cholesky(m);
    return { matrix: m, applied: "none", ridge: 0, minEigenvalue: null };
  } catch (e) {
    if (!(e instanceof PortfolioError) || e.code !== "SINGULAR_MATRIX") throw e;
    if (policy === "error") throw e;
  }

  const n = m.n;
  const scale = Math.max(1e-300, Math.abs(trace(m)) / n);
  let ridge = Math.max(ridgeFactor * scale, Number.EPSILON * scale);
  let candidate = addDiagonal(m, ridge);
  let attempts = 0;
  while (attempts < 8) {
    try {
      cholesky(candidate);
      if (policy === "pseudo-inverse") pseudoInverse(m, rcond);
      return {
        matrix: candidate,
        applied: policy === "pseudo-inverse" ? "pseudo-inverse" : "ridge",
        ridge,
        minEigenvalue: null,
      };
    } catch {
      ridge *= 10;
      candidate = addDiagonal(m, ridge);
      attempts++;
    }
  }
  throw new PortfolioError(
    "NUMERIC_FAILURE",
    `Kovarianzmatrix konnte auch mit Ridge ${ridge} nicht positiv definit gemacht werden`,
    { field: "covariance", details: { ridge } }
  );
}

/** Addiert einen Skalar auf die Diagonale: `A + τ·I` (Ridge-Regularisierung). */
export function addDiagonal(m: Matrix, value: number): Matrix {
  const data = Float64Array.from(m.data);
  for (let i = 0; i < m.n; i++) data[i * m.n + i] += value;
  return { n: m.n, data };
}

/**
 * Schätzt den größten Eigenwert via Power-Iteration.
 *
 * Formel: `x_{k+1} = A·x_k / ‖A·x_k‖₂`, `λ_max ≈ x'·A·x`.
 * Der Startvektor ist **deterministisch** (`xᵢ = 1/(i+1)`, normiert) — kein
 * Zufall (Architektur-Regel 1).
 */
export function estimateMaxEigenvalue(m: Matrix, iterations = 60): number {
  const n = m.n;
  const x = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    x[i] = 1 / (i + 1);
    norm += x[i] * x[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) x[i] /= norm;
  let lambda = 0;
  for (let k = 0; k < iterations; k++) {
    const y = matVec(m, x);
    let yn = 0;
    for (let i = 0; i < n; i++) yn += y[i] * y[i];
    yn = Math.sqrt(yn);
    if (!(yn > 0)) return 0;
    for (let i = 0; i < n; i++) x[i] = y[i] / yn;
    lambda = yn;
  }
  return quadForm(m, x);
}

/**
 * Kleinster Eigenwert `λ_min ≈ 1/‖A⁻¹v‖` über inverse Power-Iteration mit
 * Cholesky (nur für
 * kleine Matrizen; dient der Konditions-Diagnose).
 *
 * @throws PortfolioError `SINGULAR_MATRIX` wenn die Matrix nicht invertierbar ist.
 */
export function estimateMinEigenvalue(m: Matrix, iterations = 60): number {
  const L = cholesky(m);
  const n = m.n;
  const x = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    x[i] = 1 / (i + 1);
    norm += x[i] * x[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < n; i++) x[i] /= norm;
  let mu = 0;
  for (let k = 0; k < iterations; k++) {
    const y = choleskySolve(L, n, x);
    let yn = 0;
    for (let i = 0; i < n; i++) yn += y[i] * y[i];
    yn = Math.sqrt(yn);
    if (!(yn > 0)) break;
    for (let i = 0; i < n; i++) x[i] = y[i] / yn;
    mu = yn;
  }
  return mu > 0 ? 1 / mu : 0;
}

/**
 * Projiziert einen Vektor exakt auf die Menge `{Σw = 1, l ≤ w ≤ u}`.
 *
 * Verfahren: der duale Multiplikator `λ` löst
 * `g(λ) = Σᵢ clamp(wᵢ − λ, lᵢ, uᵢ) = 1`. `g` ist monoton fallend und
 * stückweise linear, das Intervall `[minᵢ(xᵢ − uᵢ), maxᵢ(xᵢ − lᵢ)]`
 * klammert die Lösung ein (`g(lo) = Σu ≥ 1`, `g(hi) = Σl ≤ 1`). Bisektion
 * (100 Schritte) plus Newton-Korrektur über die Anzahl freier Komponenten.
 *
 * @throws PortfolioError `INFEASIBLE_CONSTRAINTS` wenn `Σl > 1` oder `Σu < 1`.
 */
export function projectOntoBoxSimplex(
  x: VectorLike,
  lower: VectorLike,
  upper: VectorLike,
  target = 1
): Float64Array {
  const n = x.length;
  if (lower.length !== n || upper.length !== n) {
    throw new PortfolioError("LENGTH_MISMATCH", "Bounds müssen dieselbe Länge wie der Vektor haben", {
      field: "bounds",
    });
  }
  let sumLower = 0;
  let sumUpper = 0;
  for (let i = 0; i < n; i++) {
    if (lower[i] > upper[i]) {
      throw new PortfolioError("INFEASIBLE_CONSTRAINTS", `Untergrenze ${lower[i]} > Obergrenze ${upper[i]} bei ${i}`, {
        field: "bounds",
        details: { index: i },
      });
    }
    sumLower += lower[i];
    sumUpper += upper[i];
  }
  if (sumLower - target > 1e-12 || sumUpper - target < -1e-12) {
    throw new PortfolioError(
      "INFEASIBLE_CONSTRAINTS",
      `Bounds unerfüllbar: Σ Untergrenzen = ${sumLower}, Σ Obergrenzen = ${sumUpper}, Ziel = ${target}`,
      { field: "bounds", details: { sumLower, sumUpper, target } }
    );
  }

  const clampAt = (lambda: number, out: Float64Array): { sum: number; free: number } => {
    let sum = 0;
    let free = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i] - lambda;
      if (v <= lower[i]) {
        out[i] = lower[i];
      } else if (v >= upper[i]) {
        out[i] = upper[i];
      } else {
        out[i] = v;
        free++;
      }
      sum += out[i];
    }
    return { sum, free };
  };

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, x[i] - upper[i]);
    hi = Math.max(hi, x[i] - lower[i]);
  }
  const out = new Float64Array(n);
  let lambda = (lo + hi) / 2;
  let result = clampAt(lambda, out);
  for (let iter = 0; iter < 100; iter++) {
    if (Math.abs(result.sum - target) <= 1e-14) break;
    if (result.sum > target) lo = lambda;
    else hi = lambda;
    lambda = (lo + hi) / 2;
    result = clampAt(lambda, out);
  }
  // Newton-Korrektur: nur die freien Komponenten reagieren auf λ.
  for (let iter = 0; iter < 5 && Math.abs(result.sum - target) > 1e-14; iter++) {
    if (result.free === 0) break;
    lambda += (result.sum - target) / result.free;
    result = clampAt(lambda, out);
  }
  // Restresiduum deterministisch auf die freien Komponenten verteilen.
  if (Math.abs(result.sum - target) > 1e-12) {
    const free = new Array<number>();
    for (let i = 0; i < n; i++) if (out[i] > lower[i] + 1e-15 && out[i] < upper[i] - 1e-15) free.push(i);
    if (free.length === 0) {
      throw new PortfolioError("NUMERIC_FAILURE", "Projektion konnte die Summenbedingung nicht exakt erfüllen", {
        field: "weights",
        details: { sum: result.sum, target },
      });
    }
    const delta = (target - result.sum) / free.length;
    for (const i of free) out[i] += delta;
  }
  return out;
}
