/**
 * Risk-Guard-Kette (Task 05) — die Autorität über jedes Optimizer-Ergebnis.
 *
 * **Feste Reihenfolge (in Code erzwungen):**
 *
 * ```
 * Portfolio Optimizer ─► Risk Guard ─► Position Limits ─► Correlation Limits ─► Ergebnis
 * ```
 *
 * Ein {@link RawOptimizationResult} trägt die Marke `authority:
 * "portfolio-optimizer"`. {@link applyRiskGuard} akzeptiert **nur** diese Marke
 * und gibt die durchlaufene Kette im Ergebnis zurück; {@link assertAuthorityChain}
 * prüft die Reihenfolge und wirft, sobald eine zukünftige Änderung sie bricht.
 *
 * Jede Entscheidung (Kappung, Verwurf, Umverteilung, Cluster-Skalierung) wird
 *   1. strukturiert in `decisions` (mit `code`, `limit`, `before`, `after`),
 *   2. als Menschen/LLM-lesbarer String in `reasons`,
 *   3. als **ein** Audit-Ereignis in `auditEvents` protokolliert.
 *
 * Fail-closed: Sind die Limits mathematisch nicht erfüllbar (z. B. ein einziger
 * Korrelationscluster mit `maxClusterExposure < 1`), wird das Portfolio
 * **verworfen** (`rejected: true`, `weights: []`) — niemals still gekürzt.
 */

import {
  closeRoundingGap,
  DEFAULT_CLUSTER_THRESHOLD,
  DEFAULT_GUARD_EPSILON,
  DEFAULT_MAX_ADJUSTMENT_ROUNDS,
  DEFAULT_MAX_CLUSTER_EXPOSURE,
  DEFAULT_MAX_WEIGHT_PER_INSTRUMENT,
  DEFAULT_MIN_WEIGHT,
  OUTPUT_DECIMALS,
  roundTo,
  roundVector,
} from "./config";
import { PortfolioError, requireFinite, requireFiniteAtLeast } from "./errors";
import { createAuditLogger, type AuditLogger, type PortfolioAuditEvent } from "./audit";
import { correlationClusters } from "./correlation";
import {
  OPTIMIZER_AUTHORITY,
  AUTHORITY_CHAIN,
  type AuthorityStage,
  type ClusterExposure,
  type CorrelationLimits,
  type CorrelationMatrix,
  type GuardDecision,
  type PositionLimits,
  type RawOptimizationResult,
  type RiskGuardConfig,
  type RiskGuardResult,
} from "./types";

/** Wirksam aufgelöste Guard-Konfiguration. */
export interface ResolvedGuardConfig {
  /** Maximales Gewicht je Instrument. */
  maxWeightPerInstrument: number;
  /** Instrumentenspezifische Obergrenzen. */
  perSymbol: Record<string, number>;
  /** Maximale Positionsanzahl (`null` = unbegrenzt). */
  maxPositions: number | null;
  /** Untergrenze für Splittergewichte. */
  minWeight: number;
  /** Cluster-Schwelle. */
  threshold: number;
  /** Maximales Cluster-Exposure. */
  maxClusterExposure: number;
  /** Maximale Korrekturrunden. */
  maxAdjustmentRounds: number;
  /** Numerisches Epsilon. */
  epsilon: number;
  /** true ⇒ nicht platzierbares Restgewicht bleibt Cash (statt Verwurf). */
  allowCashResidual: boolean;
}

/** Eingabe der Risk Guard. */
export interface RiskGuardInput {
  /** Ungeprüftes Optimizer-Ergebnis (Marke wird geprüft). */
  raw: RawOptimizationResult;
  /** Korrelationsmatrix über dieselben Symbole (Pflicht für Cluster-Limits). */
  correlation: CorrelationMatrix;
  /** Konfiguration (Defaults siehe `config.ts`). */
  config?: RiskGuardConfig & { allowCashResidual?: boolean };
  /** Audit-Logger (Default: keine Senke). */
  audit?: AuditLogger;
}

/**
 * Löst die Guard-Konfiguration auf und validiert alle Bereiche.
 *
 * @throws PortfolioError `INVALID_CONFIG`.
 */
export function resolveGuardConfig(config: RiskGuardConfig & { allowCashResidual?: boolean } = {}): ResolvedGuardConfig {
  const position: PositionLimits = config.position ?? {};
  const correlation: CorrelationLimits = config.correlation ?? {};
  const maxWeightPerInstrument =
    position.maxWeightPerInstrument === undefined
      ? DEFAULT_MAX_WEIGHT_PER_INSTRUMENT
      : requireFinite(position.maxWeightPerInstrument, "position.maxWeightPerInstrument");
  if (!(maxWeightPerInstrument > 0) || maxWeightPerInstrument > 1) {
    throw new PortfolioError("INVALID_CONFIG", "maxWeightPerInstrument muss in (0, 1] liegen", {
      field: "position.maxWeightPerInstrument",
    });
  }
  const perSymbol: Record<string, number> = {};
  for (const [symbol, value] of Object.entries(position.perSymbol ?? {})) {
    const v = requireFinite(value, `position.perSymbol.${symbol}`);
    if (!(v > 0) || v > 1) {
      throw new PortfolioError("INVALID_CONFIG", `perSymbol.${symbol} muss in (0, 1] liegen`, {
        field: `position.perSymbol.${symbol}`,
      });
    }
    perSymbol[symbol] = v;
  }
  const maxPositions =
    position.maxPositions === undefined || position.maxPositions === null
      ? null
      : Math.floor(requireFiniteAtLeast(position.maxPositions, 1, "position.maxPositions"));
  const minWeight =
    position.minWeight === undefined ? DEFAULT_MIN_WEIGHT : requireFiniteAtLeast(position.minWeight, 0, "position.minWeight");
  if (minWeight > maxWeightPerInstrument) {
    throw new PortfolioError("INVALID_CONFIG", "minWeight darf maxWeightPerInstrument nicht übersteigen", {
      field: "position.minWeight",
    });
  }
  const threshold =
    correlation.threshold === undefined ? DEFAULT_CLUSTER_THRESHOLD : requireFinite(correlation.threshold, "correlation.threshold");
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new PortfolioError("INVALID_CONFIG", "correlation.threshold muss in [0, 1] liegen", {
      field: "correlation.threshold",
    });
  }
  const maxClusterExposure =
    correlation.maxClusterExposure === undefined
      ? DEFAULT_MAX_CLUSTER_EXPOSURE
      : requireFinite(correlation.maxClusterExposure, "correlation.maxClusterExposure");
  if (!(maxClusterExposure > 0) || maxClusterExposure > 1) {
    throw new PortfolioError("INVALID_CONFIG", "maxClusterExposure muss in (0, 1] liegen", {
      field: "correlation.maxClusterExposure",
    });
  }
  const maxAdjustmentRounds =
    config.maxAdjustmentRounds === undefined
      ? DEFAULT_MAX_ADJUSTMENT_ROUNDS
      : Math.floor(requireFinite(config.maxAdjustmentRounds, "maxAdjustmentRounds"));
  if (!Number.isInteger(maxAdjustmentRounds) || maxAdjustmentRounds < 1 || maxAdjustmentRounds > 10_000) {
    throw new PortfolioError("INVALID_CONFIG", "maxAdjustmentRounds muss ganzzahlig in [1, 10000] sein", {
      field: "maxAdjustmentRounds",
    });
  }
  const epsilon = config.epsilon === undefined ? DEFAULT_GUARD_EPSILON : requireFinite(config.epsilon, "epsilon");
  if (!(epsilon >= 0 && epsilon < 1)) {
    throw new PortfolioError("INVALID_CONFIG", "epsilon muss in [0, 1) liegen", { field: "epsilon" });
  }
  return {
    maxWeightPerInstrument,
    perSymbol,
    maxPositions,
    minWeight,
    threshold,
    maxClusterExposure,
    maxAdjustmentRounds,
    epsilon,
    allowCashResidual: config.allowCashResidual === true,
  };
}

/**
 * Prüft, dass die Autoritätskette in der richtigen Reihenfolge durchlaufen wurde.
 *
 * Invariante: die durchlaufene Kette ist immer ein **Präfix** der festen Kette
 * `portfolio-optimizer → risk-guard → position-limits → correlation-limits`
 * (kein Glied kann übersprungen werden). Mit `complete: true` wird zusätzlich
 * verlangt, dass **alle** Glieder gelaufen sind — das ist die Bedingung dafür,
 * dass überhaupt Gewichte freigegeben werden dürfen.
 *
 * @throws PortfolioError `INVALID_INPUT` sobald ein Glied fehlt, die
 *         Reihenfolge abweicht oder eine Freigabe ohne vollständige Kette
 *         versucht wird.
 */
export function assertAuthorityChain(chain: readonly AuthorityStage[], options?: { complete?: boolean }): void {
  if (chain.length === 0) {
    throw new PortfolioError("INVALID_INPUT", "Autoritätskette ist leer", { field: "chain" });
  }
  if (chain.length > AUTHORITY_CHAIN.length) {
    throw new PortfolioError("INVALID_INPUT", `Autoritätskette zu lang: ${chain.join(" → ")}`, {
      field: "chain",
      details: { length: chain.length, expected: AUTHORITY_CHAIN.length },
    });
  }
  for (let i = 0; i < chain.length; i++) {
    if (chain[i] !== AUTHORITY_CHAIN[i]) {
      throw new PortfolioError("INVALID_INPUT", `Autoritätskette in falscher Reihenfolge: ${chain.join(" → ")}`, {
        field: "chain",
        details: { index: i, found: chain[i], expected: AUTHORITY_CHAIN[i] },
      });
    }
  }
  if (options?.complete && chain.length !== AUTHORITY_CHAIN.length) {
    throw new PortfolioError(
      "INVALID_INPUT",
      `Gewichtsfreigabe ohne vollständige Autoritätskette: ${chain.join(" → ")}`,
      { field: "chain", details: { length: chain.length, expected: AUTHORITY_CHAIN.length } }
    );
  }
}

/** Wirksame Obergrenze eines Symbols. */
export function capFor(symbol: string, config: ResolvedGuardConfig): number {
  const specific = config.perSymbol[symbol];
  return Math.min(config.maxWeightPerInstrument, specific === undefined ? 1 : specific);
}

/** Summe der |Gewichte| einer Symbolmenge. */
function exposureOf(weights: readonly number[], members: readonly number[]): number {
  let sum = 0;
  for (const i of members) sum += Math.abs(weights[i]);
  return sum;
}

/**
 * Verteilt `amount` proportional zum verfügbaren Spielraum (Positions- und
 * Cluster-Obergrenzen) und liefert das nicht platzierbare Restgewicht.
 *
 * Formel: `Δwᵢ = amount · hᵢ / Σⱼ hⱼ` mit
 * `hᵢ = min(capᵢ − wᵢ, max(0, clusterLimit − exposure(clusterᵢ)))`.
 *
 * Eine Runde platziert exakt `min(amount, Σh)`; Überbuchungen eines Clusters
 * werden in der Folgerunde zurückgenommen (max. `rounds` Runden ⇒ Terminierung).
 */
function allocateWeight(
  weights: number[],
  amount: number,
  caps: readonly number[],
  clusterOf: readonly number[],
  clusters: readonly number[][],
  clusterLimit: number,
  epsilon: number,
  rounds: number
): number {
  let remaining = amount;
  for (let round = 0; round < rounds && remaining > epsilon; round++) {
    const clusterExposure = clusters.map((members) => exposureOf(weights, members));
    const headroom = new Array<number>(weights.length).fill(0);
    let total = 0;
    for (let i = 0; i < weights.length; i++) {
      const positionRoom = Math.max(0, caps[i] - weights[i]);
      const clusterRoom = Math.max(0, clusterLimit - clusterExposure[clusterOf[i]]);
      headroom[i] = Math.min(positionRoom, clusterRoom);
      total += headroom[i];
    }
    if (total <= epsilon) break;
    const take = Math.min(remaining, total);
    for (let i = 0; i < weights.length; i++) weights[i] += (take * headroom[i]) / total;
    remaining -= take;

    // Cluster-Überbuchung zurücknehmen (passiert, wenn ein Cluster mehrere
    // Mitglieder mit Spielraum hat).
    for (let c = 0; c < clusters.length; c++) {
      const exposure = exposureOf(weights, clusters[c]);
      if (exposure <= clusterLimit + epsilon) continue;
      const factor = clusterLimit / exposure;
      for (const i of clusters[c]) {
        const next = weights[i] * factor;
        remaining += weights[i] - next;
        weights[i] = next;
      }
    }
  }
  return remaining;
}

/**
 * Führt die Risk-Guard-Kette über ein Optimizer-Ergebnis aus.
 *
 * Stufe 1 (`position-limits`): Positionsanzahl, Kappung je Instrument,
 * Splittergewichte, Wiederanlage des frei gewordenen Gewichts.
 * Stufe 2 (`correlation-limits`): Cluster-Exposure begrenzen, frei werdendes
 * Gewicht auf Cluster mit Spielraum umverteilen.
 *
 * @returns {@link RiskGuardResult} mit `{ rejected, adjusted, reasons[] }`,
 *          allen Einzelentscheidungen und einem Audit-Ereignis je Entscheidung.
 */
export function applyRiskGuard(input: RiskGuardInput): RiskGuardResult {
  const { raw } = input;
  if (!raw || raw.authority !== OPTIMIZER_AUTHORITY) {
    throw new PortfolioError("INVALID_INPUT", "nur ein Optimizer-Ergebnis darf in die Risk-Guard-Kette", {
      field: "raw.authority",
    });
  }
  const config = resolveGuardConfig(input.config ?? {});
  const audit = input.audit ?? createAuditLogger();
  const symbols = raw.symbols;
  const n = symbols.length;
  if (raw.weights.length !== n) {
    throw new PortfolioError("LENGTH_MISMATCH", `${raw.weights.length} Gewichte für ${n} Symbole`, {
      field: "weights",
    });
  }
  const correlation = input.correlation;
  if (correlation.symbols.length !== n) {
    throw new PortfolioError("LENGTH_MISMATCH", `Korrelationsmatrix hat ${correlation.symbols.length} Symbole, erwartet ${n}`, {
      field: "correlation",
    });
  }
  for (let i = 0; i < n; i++) {
    if (correlation.symbols[i] !== symbols[i]) {
      throw new PortfolioError("INVALID_INPUT", `Korrelationsmatrix-Symbol ${correlation.symbols[i]} ≠ ${symbols[i]}`, {
        field: "correlation",
        details: { index: i },
      });
    }
  }

  const inputWeights = raw.weights.slice();
  const weights = raw.weights.slice();
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    if (!Number.isFinite(w)) {
      throw new PortfolioError("INVALID_INPUT", `Gewicht ${i} ist keine endliche Zahl`, {
        field: "weights",
        details: { index: i },
      });
    }
  }

  const decisions: GuardDecision[] = [];
  const reasons: string[] = [];
  const auditEvents: PortfolioAuditEvent[] = [];
  const chain: AuthorityStage[] = ["portfolio-optimizer", "risk-guard"];
  const eps = config.epsilon;

  const record = (decision: GuardDecision) => {
    decisions.push(decision);
    reasons.push(`${decision.stage}/${decision.code}: ${decision.message}`);
    auditEvents.push(
      audit.log({
        event: "RISK_GUARD_DECISION",
        level: decision.action === "reject" ? "ERROR" : "WARN",
        stage: decision.stage,
        action: decision.action,
        code: decision.code,
        symbols: decision.symbol ? [decision.symbol] : [],
        limit: decision.limit,
        before: decision.before,
        after: decision.after,
        reasons: [decision.message],
        mode: raw.mode,
      })
    );
  };

  // Wirksame Obergrenzen. Entfernte Positionen (maxPositions/minWeight)
  // erhalten cap = 0, damit die Umverteilung sie nicht wieder auffüllt.
  const caps = symbols.map((s) => capFor(s, config));

  // ── Stufe 1: Position Limits ────────────────────────────────────────────────
  chain.push("position-limits");

  if (config.maxPositions !== null) {
    const held = weights.map((w, i) => ({ w: Math.abs(w), i })).filter((e) => e.w > eps);
    if (held.length > config.maxPositions) {
      // Deterministische Auswahl: größtes Gewicht, bei Gleichstand kleinstes Symbol.
      held.sort((a, b) => b.w - a.w || (symbols[a.i] < symbols[b.i] ? -1 : symbols[a.i] > symbols[b.i] ? 1 : a.i - b.i));
      const drop = held.slice(config.maxPositions);
      for (const entry of drop) {
        const before = weights[entry.i];
        weights[entry.i] = 0;
        // Cap auf 0 ⇒ die Umverteilung kann die Position nicht wieder auffüllen.
        caps[entry.i] = 0;
        record({
          stage: "position-limits",
          code: "POSITION_COUNT_EXCEEDED",
          symbol: symbols[entry.i],
          action: "drop",
          limit: config.maxPositions,
          before,
          after: 0,
          message: `mehr als ${config.maxPositions} Positionen — ${symbols[entry.i]} entfernt`,
        });
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (weights[i] > caps[i] + eps) {
      const before = weights[i];
      weights[i] = caps[i];
      record({
        stage: "position-limits",
        code: "POSITION_LIMIT_CAPPED",
        symbol: symbols[i],
        action: "cap",
        limit: caps[i],
        before,
        after: caps[i],
        message: `Gewicht ${(before * 100).toFixed(2)} % über dem Limit von ${(caps[i] * 100).toFixed(2)} % — gekappt`,
      });
    }
  }

  if (config.minWeight > 0) {
    for (let i = 0; i < n; i++) {
      if (weights[i] > eps && weights[i] < config.minWeight) {
        const before = weights[i];
        weights[i] = 0;
        caps[i] = 0; // kein Wiederauffüllen durch die Umverteilung
        record({
          stage: "position-limits",
          code: "MIN_WEIGHT_DROPPED",
          symbol: symbols[i],
          action: "drop",
          limit: config.minWeight,
          before,
          after: 0,
          message: `Splittergewicht ${(before * 100).toFixed(4)} % unter ${(config.minWeight * 100).toFixed(4)} % — entfernt`,
        });
      }
    }
  }

  // Cluster-Vorbereitung (für die Umverteilung beider Stufen).
  const clusterList = correlationClusters(correlation, config.threshold);
  const clusterOf = new Array<number>(n).fill(0);
  const clusters: number[][] = clusterList.map((c) => c.symbols.map((s) => symbols.indexOf(s)));
  clusters.forEach((members, id) => {
    for (const i of members) clusterOf[i] = id;
  });

  const sumOf = (w: readonly number[]) => w.reduce((a, b) => a + b, 0);
  let deficit = 1 - sumOf(weights);

  if (deficit > eps) {
    const before = sumOf(weights);
    const unallocated = allocateWeight(
      weights,
      deficit,
      caps,
      clusterOf,
      clusters,
      config.maxClusterExposure,
      eps,
      config.maxAdjustmentRounds
    );
    const after = sumOf(weights);
    if (after - before > eps) {
      record({
        stage: "position-limits",
        code: "WEIGHT_REDISTRIBUTED",
        action: "redistribute",
        limit: 1,
        before,
        after,
        message: `frei gewordenes Gewicht von ${((after - before) * 100).toFixed(2)} % innerhalb der Limits neu verteilt`,
      });
    }
    if (unallocated > eps && !config.allowCashResidual) {
      record({
        stage: "position-limits",
        code: "POSITION_LIMITS_INFEASIBLE",
        action: "reject",
        limit: 1,
        before: sumOf(weights),
        after: sumOf(weights),
        message: `${(unallocated * 100).toFixed(2)} % des Kapitals passen nicht in die Positionslimits — Portfolio verworfen`,
      });
      return finalize({
        rejected: true,
        adjusted: true,
        weights: [],
        inputWeights,
        decisions,
        reasons,
        chain,
        caps,
        clusterList,
        clusters,
        config,
        symbols,
        audit,
        auditEvents,
        raw,
        rejectedAt: "position-limits",
      });
    }
    deficit = unallocated;
  }

  // ── Stufe 2: Correlation Limits ─────────────────────────────────────────────
  chain.push("correlation-limits");

  const exposureBefore = clusters.map((members) => exposureOf(inputWeights, members));
  const exposureViolated = exposureBefore.map((e) => e > config.maxClusterExposure + eps);

  for (let round = 0; round < config.maxAdjustmentRounds; round++) {
    let violator = -1;
    for (let c = 0; c < clusters.length; c++) {
      if (exposureOf(weights, clusters[c]) > config.maxClusterExposure + eps) {
        violator = c;
        break;
      }
    }
    if (violator < 0) break;

    const members = clusters[violator];
    const exposure = exposureOf(weights, members);
    const factor = config.maxClusterExposure / exposure;
    let freed = 0;
    for (const i of members) {
      const before = weights[i];
      const after = before * factor;
      freed += before - after;
      weights[i] = after;
    }
    record({
      stage: "correlation-limits",
      code: "CLUSTER_EXPOSURE_CAPPED",
      cluster: clusterList[violator].id,
      symbol: clusterList[violator].symbols.join(","),
      action: "scale",
      limit: config.maxClusterExposure,
      before: exposure,
      after: config.maxClusterExposure,
      message: `Cluster ${clusterList[violator].id} (${clusterList[violator].symbols.join(", ")}) mit ${(exposure * 100).toFixed(2)} % über dem Limit von ${(config.maxClusterExposure * 100).toFixed(2)} % — skaliert`,
    });

    const unallocated = allocateWeight(
      weights,
      freed,
      caps,
      clusterOf,
      clusters,
      config.maxClusterExposure,
      eps,
      config.maxAdjustmentRounds
    );
    if (unallocated > eps) {
      if (!config.allowCashResidual) {
        record({
          stage: "correlation-limits",
          code: "CORRELATION_LIMITS_INFEASIBLE",
          action: "reject",
          cluster: clusterList[violator].id,
          limit: config.maxClusterExposure,
          before: exposure,
          after: sumOf(weights),
          message: `${(unallocated * 100).toFixed(2)} % des Kapitals finden innerhalb der Korrelationslimits keinen Platz — Portfolio verworfen`,
        });
        return finalize({
          rejected: true,
          adjusted: true,
          weights: [],
          inputWeights,
          decisions,
          reasons,
          chain,
          caps,
          clusterList,
          clusters,
          config,
          symbols,
          audit,
          raw,
          auditEvents,
          rejectedAt: "correlation-limits",
        });
      }
      record({
        stage: "correlation-limits",
        code: "CASH_RESIDUAL",
        action: "redistribute",
        cluster: clusterList[violator].id,
        limit: 1,
        before: sumOf(weights) + unallocated,
        after: sumOf(weights),
        message: `${(unallocated * 100).toFixed(2)} % des Kapitals bleiben als Cash (allowCashResidual)`,
      });
      break;
    }
  }

  // ── Verifikation (fail-closed) ─────────────────────────────────────────────
  const total = sumOf(weights);
  const violations: string[] = [];
  // Mit `allowCashResidual` ist Σw < 1 zulässig (der Rest bleibt Cash) —
  // darüber darf nicht hinaus investiert werden.
  if (config.allowCashResidual) {
    if (total > 1 + 1e-6) violations.push(`Gewichtssumme ${total.toFixed(6)} > 1`);
  } else if (Math.abs(total - 1) > 1e-6) {
    violations.push(`Gewichtssumme ${total.toFixed(6)} ≠ 1`);
  }
  for (let i = 0; i < n; i++) {
    if (weights[i] > caps[i] + 1e-9) violations.push(`${symbols[i]} über der Obergrenze`);
    if (weights[i] < -1e-12) violations.push(`${symbols[i]} negativ`);
  }
  for (let c = 0; c < clusters.length; c++) {
    const exposure = exposureOf(weights, clusters[c]);
    if (exposure > config.maxClusterExposure + 1e-9) {
      violations.push(`Cluster ${clusterList[c].id} mit ${(exposure * 100).toFixed(2)} % über dem Limit`);
    }
  }
  if (violations.length > 0) {
    record({
      stage: "correlation-limits",
      code: "GUARD_VERIFICATION_FAILED",
      action: "reject",
      limit: config.maxClusterExposure,
      before: total,
      after: total,
      message: `Verifikation fehlgeschlagen: ${violations.join("; ")}`,
    });
    return finalize({
      rejected: true,
      adjusted: true,
      weights: [],
      inputWeights,
      decisions,
      reasons,
      chain,
      caps,
      clusterList,
      clusters,
      config,
      symbols,
      audit,
      raw,
      auditEvents,
      rejectedAt: "correlation-limits",
    });
  }

  const clusterExposures: ClusterExposure[] = clusters.map((members, id) => ({
    clusterId: clusterList[id].id,
    symbols: clusterList[id].symbols,
    before: roundTo(exposureBefore[id], OUTPUT_DECIMALS),
    after: roundTo(exposureOf(weights, members), OUTPUT_DECIMALS),
    limit: config.maxClusterExposure,
    violated: exposureViolated[id],
  }));

  const adjusted = decisions.some((d) => d.action !== "reject");
  const finalWeights = roundVector(weights, OUTPUT_DECIMALS);
  if (!config.allowCashResidual) closeRoundingGap(finalWeights, 1);
  return finalize({
    rejected: false,
    adjusted,
    weights: finalWeights,
    inputWeights,
    decisions,
    reasons,
    chain,
    caps,
    clusterList,
    clusters,
    config,
    symbols,
    audit,
    auditEvents,
    raw,
    clusterExposures,
    rejectedAt: null,
  });
}

/** Interne Abschluss-Routine: Summary-Audit, Kettenprüfung, Ergebnisbau. */
function finalize(params: {
  rejected: boolean;
  adjusted: boolean;
  weights: number[];
  inputWeights: number[];
  decisions: GuardDecision[];
  reasons: string[];
  chain: AuthorityStage[];
  caps: number[];
  clusterList: readonly { id: number; symbols: string[] }[];
  clusters: readonly number[][];
  config: ResolvedGuardConfig;
  symbols: readonly string[];
  audit: AuditLogger;
  auditEvents: PortfolioAuditEvent[];
  raw: RawOptimizationResult;
  clusterExposures?: ClusterExposure[];
  rejectedAt: AuthorityStage | null;
}): RiskGuardResult {
  // Freigegebene Gewichte gibt es ausschließlich nach der vollständigen Kette.
  assertAuthorityChain(params.chain, { complete: !params.rejected });
  const clusterExposures =
    params.clusterExposures ??
    params.clusters.map((members, id) => ({
      clusterId: params.clusterList[id].id,
      symbols: params.clusterList[id].symbols,
      before: 0,
      after: 0,
      limit: params.config.maxClusterExposure,
      violated: false,
    }));
  params.auditEvents.push(
    params.audit.log({
      event: "RISK_GUARD_SUMMARY",
      level: params.rejected ? "ERROR" : params.adjusted ? "WARN" : "INFO",
      stage: params.rejectedAt ?? "correlation-limits",
      action: params.rejected ? "reject" : params.adjusted ? "cap" : "pass",
      code: params.rejected ? "RISK_GUARD_REJECTION" : params.adjusted ? "RISK_GUARD_ADJUSTED" : "RISK_GUARD_PASS",
      mode: params.raw.mode,
      symbols: params.symbols.slice(),
      weights: params.weights,
      reasons: params.reasons,
      converged: params.raw.diagnostics.converged,
      iterations: params.raw.diagnostics.iterations,
    })
  );
  return {
    rejected: params.rejected,
    adjusted: params.adjusted,
    weights: params.weights,
    input: params.inputWeights,
    reasons: params.reasons,
    decisions: params.decisions,
    chain: params.chain,
    caps: params.symbols.map((symbol, i) => ({ symbol, cap: roundTo(params.caps[i], OUTPUT_DECIMALS) })),
    clusterExposures,
    auditEvents: params.auditEvents,
  };
}
