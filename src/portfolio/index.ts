/**
 * Öffentliche API des Portfolio-Moduls (Task 05).
 *
 * **Autoritätskette:** Wer handelbare Gewichte will, ruft
 * {@link optimizeWithGuard}. {@link optimizePortfolio} ist exportiert, damit
 * die numerischen Eigenschaften isoliert getestet werden können — sein
 * Ergebnis ist als {@link RawOptimizationResult} markiert und gilt per
 * Architektur nie als freigegeben.
 *
 * Das Modul hat keine Seiteneffekte beim Import: keine Uhr, kein Zufall, kein
 * Netzwerk, kein LLM, keine Datenbank.
 */

export * from "./types";
export {
  PortfolioError,
  publicPortfolioErrorMessage,
  portfolioErrorCode,
  redactPortfolioMessage,
  type PortfolioErrorCode,
} from "./errors";
export {
  closeRoundingGap,
  DEFAULT_ANNUALIZATION,
  DEFAULT_ANNUALIZATION_FALLBACK,
  DEFAULT_ATR_PERIOD,
  DEFAULT_CLUSTER_THRESHOLD,
  DEFAULT_COVARIANCE_METHOD,
  DEFAULT_DDOF,
  DEFAULT_EWMA_DECAY,
  DEFAULT_GUARD_EPSILON,
  DEFAULT_MAX_ADJUSTMENT_ROUNDS,
  DEFAULT_MAX_CLUSTER_EXPOSURE,
  DEFAULT_MAX_WEIGHT_PER_INSTRUMENT,
  DEFAULT_MIN_WEIGHT,
  DEFAULT_REGIME_THRESHOLDS,
  DEFAULT_RIDGE_FACTOR,
  DEFAULT_RISK_FREE_RATE,
  DEFAULT_RCOND,
  DEFAULT_SINGULAR_MATRIX_POLICY,
  DEFAULT_SOLVER_TOLERANCE,
  OUTPUT_DECIMALS,
  PORTFOLIO_CONFIG_VERSION,
  PORTFOLIO_LIMITS,
  annualizationFor,
  assertWithinLimits,
  describeRegime,
  isCorrelationMethod,
  isOptimizationMode,
  isSingularMatrixPolicy,
  resolveSolverOptions,
  roundTo,
  roundVector,
  validateAnnualization,
  validateRegimeThresholds,
  type RegimeThresholds,
} from "./config";
export {
  addDiagonal,
  cholesky,
  choleskySolve,
  estimateMaxEigenvalue,
  estimateMinEigenvalue,
  fromRows,
  inverse,
  isSymmetric,
  jacobiEigen,
  MIN_RELATIVE_PIVOT,
  matVec,
  maxAbsEntry,
  mean,
  projectOntoBoxSimplex,
  pseudoInverse,
  quadForm,
  ranks,
  regularizeCovariance,
  stdDev,
  submatrix,
  toRows,
  trace,
  variance,
  zerosMatrix,
  type EigenDecomposition,
  type Matrix,
  type RegularizationResult,
  type VectorLike,
} from "./numeric";
export {
  annualizedReturn,
  averageTrueRange,
  classifyVolatilityRegime,
  computeMetrics,
  equityCurveFromLogReturns,
  logReturnsFromPrices,
  logReturnsFromSimpleReturns,
  maxDrawdown,
  profitFactor,
  realizedVolatility,
  resolveLogReturns,
  sharpeRatio,
  sortinoRatio,
  trueRangeSeries,
  validateLogReturns,
  type MetricsOptions,
} from "./metrics";
export {
  annualizeCovariance,
  clusterAnalysis,
  correlationClusters,
  correlationFromCovariance,
  correlationMatrix,
  covarianceAsMatrix,
  covarianceMatrix,
  pearsonCorrelation,
  returnsMatrix,
  spearmanCorrelation,
  type CovarianceOptions,
} from "./correlation";
export {
  SOLVER_DEFAULT_MAX_ITERATIONS,
  SOLVER_DEFAULT_TOLERANCE,
  convergenceWarning,
  expectedPortfolioReturn,
  optimizePortfolio,
  resolveBounds,
  riskContributions,
  type OptimizationRequest,
  type ResolvedBounds,
} from "./optimize";
export {
  applyRiskGuard,
  assertAuthorityChain,
  capFor,
  resolveGuardConfig,
  type ResolvedGuardConfig,
  type RiskGuardInput,
} from "./riskGuard";
export {
  assertNoWeightsOnRejection,
  computeAllMetrics,
  computeCorrelation,
  optimizeWithGuard,
  weightsForJson,
  type PortfolioOptimizationResult,
  type PortfolioRequest,
  type PortfolioRunOptions,
} from "./pipeline";
export {
  getAnalysisContext,
  clustersForPrompt,
  correlationForPrompt,
  summarizeAnalysisContext,
  type AnalysisContext,
  type AnalysisContextOptions,
} from "./context";
export {
  EPOCH_TIMESTAMP,
  clampList,
  compositeAuditSink,
  createAuditLogger,
  memoryAuditSink,
  nullAuditSink,
  type AuditLogger,
  type AuditLoggerOptions,
  type AuditSink,
  type MemoryAuditSink,
  type PortfolioAuditEvent,
  type PortfolioAuditEventType,
  type PortfolioAuditLevel,
} from "./audit";
