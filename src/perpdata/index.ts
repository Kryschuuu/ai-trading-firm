/**
 * Perpetual-Daten (RMA-P2-02, v1.54.0) — Modulfassade.
 *
 * ```text
 *   Adapter (Bitunix public, Fixture)      src/perpdata/adapters/*
 *        │  PerpFetchResult (AVAILABLE | UNSUPPORTED | UNAVAILABLE)
 *        ▼
 *   normalize  ──►  quality  ──►  store (append-only, as-of)
 *        │             │              │
 *        ▼             ▼              ▼
 *   Sync-Cursor   quality-report  perp_* -Tabellen
 *        └──────────────┬──────────────┘
 *                       ▼
 *        query.ts (as-of) ──► consumers.ts (Scanner, Funding-Replay, Analyst)
 *                       ▲
 *              service.ts (Gates, Status, CLI/API)
 * ```
 *
 * Außenstellen (CLI, API-Routen, Zyklus) importieren **nur** aus dieser Datei:
 * `getPerpDataService()`, `perpDataEnabled`, `PerpQueryError`. Fachtypen und
 * Prüffunktionen werden mit exportiert, weil Tests und API-Layer sie für
 * Vertragstypen brauchen — nicht, damit sie eigene Wege bauen.
 */

// ── Vertrag und Grenzen ─────────────────────────────────────────────────────
export {
  PERP_SCHEMA_VERSION,
  PERP_SERIES_KINDS,
  PERP_MISSING_REASONS,
  PERP_AVAILABILITY_POLICIES,
  PERP_SYNC_MODES,
  PERP_SYNC_STATUSES,
  PERP_LIMITS,
  PERP_VENUE_PATTERN,
  PERP_INSTRUMENT_ID_PATTERN,
  PERP_HASH_PATTERN,
  PERP_UNATTESTABLE_QUALITY,
  perpRowIsAttestable,
  PERP_RUN_KEY_PATTERN,
  isPerpVenueKey,
  isPerpInstrumentId,
} from "./types";
export type {
  PerpSeriesKind,
  PerpQualityStatus,
  PerpMissingReason,
  PerpAvailabilityPolicy,
  PerpSyncMode,
  PerpSyncStatus,
  PerpProvenance,
  PerpFundingRow,
  PerpOpenInterestRow,
  PerpLiquidationRow,
  PerpRow,
  PerpRowByKind,
  PerpOpenInterestBasis,
  PerpLiquidationSide,
  PerpSeriesRequest,
  PerpRawSeries,
  PerpFetchResult,
  PerpUnsupportedReason,
  PerpUnavailableReason,
  PerpVenueCapabilities,
  PerpKindCapability,
  PerpSeriesQuery,
  PerpSeriesResult,
  PerpKindSyncStats,
  PerpSyncFailure,
  PerpSyncResult,
} from "./types";

// ── Konfiguration und Gates ─────────────────────────────────────────────────
export {
  PERP_ENV,
  PERP_BOUNDS,
  PERP_DEFAULTS,
  PERP_QUALITY_MODES,
  loadPerpConfig,
  perpDataEnabled,
  perpDataSyncEnabled,
  perpDataVenueAllowlist,
} from "./config";
export type { PerpConfig, PerpQualityMode, PerpEnvLike } from "./config";
export { perpCapabilitiesFor, PERP_VENUE_SUPPORT } from "./capabilities";

// ── Fehler ───────────────────────────────────────────────────────────────────
export {
  PerpDataError,
  PerpUnsupportedCapabilityError,
  PerpStoreUnavailableError,
  PerpQueryError,
  PerpValidationError,
} from "./errors";

// ── Normalisierung, Qualität, Ablage ─────────────────────────────────────────
export {
  PERP_DECIMALS,
  PERP_TIME_BOUNDS,
  toFiniteNumber,
  toEpochMs,
  roundTo,
  computeAvailableAt,
  perpContentHash,
  deriveSourceEventId,
  sanitizeEventId,
  normalizeFundingRow,
  normalizeOpenInterestRow,
  normalizeLiquidationRow,
  normalizeBatch,
  clampBatch,
  perpRowKey,
} from "./normalize";
export type { PerpNormalizeContext, PerpRejectedRow, PerpNormalizeResult, PerpKeyParts } from "./normalize";
export {
  PERP_QUALITY_CLASSES,
  PERP_QUALITY_REPORT_FILE,
  PERP_ROW_QUALITY,
  PERP_STRICT_BLOCKING_CLASSES,
  isPerpQualityClass,
  perpExpectedIntervalMs,
  validatePerpSeries,
  crossCheckFunding,
  buildPerpQualityReport,
  perpQualityBounds,
  savePerpQualityReport,
  loadPerpQualityReport,
  recordPerpQualityFindings,
  perpStrictBlockedSeries,
  perpStrictSeriesKey,
} from "./quality";
export type {
  PerpQualityClass,
  PerpQualityFinding,
  PerpQualityReport,
  PerpQualitySeriesReport,
} from "./quality";
export {
  PerpStore,
  PerpPersistenceError,
  getPerpStore,
  resetPerpStoreForTests,
  perpRunIdempotencyKey,
  fundingToInsert,
  openInterestToInsert,
  liquidationToInsert,
  mergeCursor,
} from "./store";
export { InMemoryPerpStore, perpAgeHours } from "./memoryStore";
export type { PerpDb, PerpStoreDeps, PerpAuditSink } from "./store";
export type {
  PerpStorePort,
  PerpSeriesSource,
  PerpCommit,
  PerpCommitResult,
  PerpRunRecord,
  PerpCursor,
  PerpCoverage,
  PerpWriteBatch,
} from "./ports";

// ── Ports und Adapter ────────────────────────────────────────────────────────
export { perpFetchMethod, supportsFundingIntervals } from "./port";
export type { PerpDataAdapter, PerpRateLimiter, PerpSyncLogger, PerpFundingIntervalInfo, PerpFundingIntervalSource } from "./port";
export { BitunixPerpAdapter, createBitunixPerpAdapter } from "./adapters/bitunix";
export { FixturePerpAdapter, createFixturePerpAdapter } from "./adapters/fixture";
export type { FixturePerpProfile } from "./adapters/fixture";
export {
  KNOWN_PERP_VENUES,
  BITUNIX_PERP_VENUE,
  SIM_PERP_VENUE,
  registerPerpAdapters,
  createPerpAdapters,
  perpGateMessage,
} from "./registry";
export type { RegisterPerpAdaptersOptions, RegisterPerpAdaptersResult, SkippedPerpAdapter, SkippedPerpAdapterReason } from "./registry";

// ── Sync, Abfrage, Konsumenten ───────────────────────────────────────────────
export { syncPerpVenue, aggregatePerpSyncResults, selectPerpInstruments, planPerpWindow, perpOverlapMs } from "./sync";
export type { PerpSyncOptions, PerpSleep } from "./sync";
export {
  validateAsOfRequest,
  queryPerpSeries,
  filterRowsAsOf,
  latestPerpRows,
  PERP_QUERY_DEFAULTS,
  PERP_QUERY_REASONS,
} from "./query";
export type { PerpAsOfRequest, PerpAsOfResponse } from "./query";
export {
  computeReplayAccruals,
  replayPositionFunding,
  fundingRateTo8h,
} from "./replay";
export type { PerpReplayPosition, PerpReplayResult, PerpReplayEntry } from "./replay";
export {
  buildPerpDerivativeSnapshots,
  perpDerivativeProvider,
  perpSnapshotToDerivativeContext,
  perpAnalystSnapshotLines,
  createPerpFundingRateProvider,
  recordPerpSnapshotAvailability,
} from "./consumers";
export type { PerpDerivativeSnapshot, PerpSnapshotAvailability } from "./consumers";
export { perpAnalystSnapshotLinesFromCache } from "./consumers";
export {
  PERP_DERIVATIVE_CACHE_FILE,
  buildPerpDerivativeCache,
  savePerpDerivativeCache,
  loadPerpDerivativeCache,
  perpDerivativeContextsFromCache,
} from "./derivativeCache";
export type {
  PerpDerivativeCache,
  PerpDerivativeCacheEntry,
  LoadPerpDerivativeCacheResult,
} from "./derivativeCache";

// ── Service ──────────────────────────────────────────────────────────────────
export { PerpDataService, getPerpDataService, resetPerpDataServiceForTests } from "./service";
export type { PerpStatusReport, PerpSyncServiceRequest, PerpVenueSyncReport } from "./service";
