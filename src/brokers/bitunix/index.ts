/**
 * Bitunix-Adapter (Task 07) — öffentlicher Einstieg.
 *
 * Venue-Details bleiben in diesem Ordner. Der Kern spricht nur
 * `BrokerAdapter`.
 */
export { BitunixBrokerAdapter, type BitunixAdapterDeps } from "./adapter";
export {
  signBitunixRequest,
  encodeQueryParams,
  sha256Hex,
  verifyBitunixSign,
  compactJson,
  NonceFactory,
  MonotonicTimestamp,
} from "./signing";
export { mapTradingPair, mapTradingPairs } from "./mapping";
export { serializePlaceOrder, serializePlaceOrderJson, clientOrderIdFor, CLIENT_ORDER_ID_PREFIX, OrderSerializationError } from "./orders";
export { snapshotLiveGate, assertLiveOrderAllowed, assertBitunixEnabled } from "./gates";
export { loadBitunixConfig, BITUNIX_PATHS, BITUNIX_REST_HOST } from "./config";
export {
  EnvSecretStore,
  createDefaultBitunixSecretStore,
  loadBitunixCredentials,
  type SecretStore,
} from "./secrets";
export { redactBitunix, createBitunixLogger, safeErrorMessage } from "./redactor";
export { BitunixApiError, BitunixAmbiguousError, BitunixDisabledError, classifyBitunixFailure, safeSnippet } from "./errors";
export { BitunixPublicWs, klineChannel, backoffMs } from "./ws";
export { BitunixPublicClient, mapTicker, mapInterval } from "./publicClient";
export { BitunixPrivateClient } from "./privateClient";
export { BitunixPaperLedger } from "./paper";
export { PaperExecutionEngine, BrokerExecutionEngine } from "./execution";
export type { ExecutionPort, MarkPriceFn } from "./execution";
export { BitunixHttp, TokenBucket, assertUrlAllowed } from "./http";
export {
  recordBitunixPrivateCall,
  readBitunixPrivateAudit,
  clearBitunixPrivateAuditForTests,
  recordBitunixPositionAnomaly,
  readBitunixPositionAnomalies,
  readBitunixPositionAnomalyCount,
  clearBitunixPositionAnomaliesForTests,
  type BitunixPositionAnomalyEntry,
} from "./audit";
