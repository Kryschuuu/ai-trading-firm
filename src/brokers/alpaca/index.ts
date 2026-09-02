/**
 * Alpaca-Adapter (Task 12) — öffentlicher Einstieg.
 *
 * Venue-Details bleiben in diesem Ordner. Der Kern spricht nur `BrokerAdapter`.
 */
export { AlpacaBrokerAdapter, type AlpacaAdapterDeps } from "./adapter";
export { mapAsset, mapAssets, mapBar, mapBars, mapOrderResult, mapPosition, mapAccount } from "./mapping";
export {
  clientOrderIdFor,
  makeClientOrderId,
  OrderSerializationError,
  serializePlaceOrder,
  serializePlaceOrderJson,
} from "./orders";
export { snapshotAlpacaLiveGate, assertLiveOrderAllowed, assertAlpacaEnabled } from "./gates";
export {
  ALPACA_ACCOUNT_CURRENCY,
  ALPACA_DATA_HOST,
  ALPACA_DATA_PATHS,
  ALPACA_MAX_RESPONSE_BYTES,
  ALPACA_PAPER_DATA_HOST,
  ALPACA_PAPER_TRADE_HOST,
  ALPACA_PRIVATE_RATE_PER_SEC,
  ALPACA_PUBLIC_RATE_PER_SEC,
  ALPACA_RETRY_BASE_MS,
  ALPACA_RETRY_MAX_DEFAULT,
  ALPACA_TIMEOUT_MS_DEFAULT,
  ALPACA_TRADE_HOST,
  ALPACA_TRADE_PATHS,
  DEFAULT_DATA_BASE,
  DEFAULT_PAPER_DATA_BASE,
  DEFAULT_PAPER_TRADE_BASE,
  DEFAULT_TRADE_BASE,
  alpacaEnabled,
  alpacaLiveEnabled,
  envFlagTrue,
  humanApprovalRequired,
  liveTradingEnabled,
  loadAlpacaPublicConfig,
  loadAlpacaTradeConfig,
  type AlpacaRuntimeConfig,
  type EnvLike,
} from "./config";
export {
  EnvSecretStore,
  createDefaultAlpacaSecretStore,
  loadAlpacaCredentials,
  type SecretStore,
  type AlpacaCredentials,
} from "./secrets";
export { redactAlpaca, createAlpacaLogger, safeAlpacaErrorMessage, type AlpacaLogger } from "./redactor";
export { AlpacaApiError, AlpacaDisabledError, classifyAlpacaFailure, safeSnippet } from "./errors";
export { AlpacaPublicClient } from "./publicClient";
export { AlpacaPrivateClient } from "./privateClient";
export { AlpacaPaperLedger, type AlpacaPaperLedgerDeps } from "./paper";
export { PaperExecutionEngine, BrokerExecutionEngine } from "./execution";
export type { ExecutionPort, MarkPriceFn } from "./execution";
export { AlpacaHttp, TokenBucket, assertUrlAllowed, basicAuthHeader } from "./http";
export {
  recordAlpacaPrivateCall,
  readAlpacaPrivateAudit,
  clearAlpacaPrivateAuditForTests,
  alpacaPrivateAuditRing,
  type AlpacaPrivateAuditEntry,
} from "./audit";
export type {
  AlpacaAccount,
  AlpacaAsset,
  AlpacaBar,
  AlpacaBarsResponse,
  AlpacaCredentialStatus,
  AlpacaOrder,
  AlpacaOrderRequest,
  AlpacaPosition,
  AlpacaSnapshot,
} from "./types";
