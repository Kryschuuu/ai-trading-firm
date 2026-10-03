/**
 * Bitunix-Leader-Adapter (STX-07-03 · Phase 7 · Paket 07-03).
 *
 * **Rolle:** die erste Komponente dieses Repos, die Daten eines *fremden*
 * Kontos liest. Deshalb ist jeder Schritt fail-closed und jeder Zustand ohne
 * belastbare Evidenz endet im Nichts-Tun — nie in einem Copy mit geratenen
 * Werten.
 *
 * ## Was dieser Adapter ist
 *
 * Ein Leader-Adapter liefert **normalisierte Handlungsabsichten**
 * ({@link NormalizedLeaderTrade}), keine rohen Venue-Orders. Er reagiert
 * ausschließlich auf **Order-/Fill-Ereignisse** des privaten Bitunix-Kanals —
 * nicht auf Positions-Polling. Bei einem Positions-Polling ist nicht
 * unterscheidbar, ob eine Position eröffnet, erhöht oder verkleinert wurde;
 * ohne `OPEN/INCREASE/DECREASE/CLOSE` ist das Kopieren nicht deterministisch.
 *
 * ## Was er *nicht* ist
 *
 * - **Kein zweiter WebSocket-Client.** Transport, Reconnect, Backoff,
 *   Resubscribe, SSRF-Host-Allowlist und der `ws`-Versions-Guard kommen aus
 *   `src/brokers/bitunix/ws.ts` ({@link BitunixPublicWs} +
 *   {@link openHardenedWs}). `src/brokers/bitunix/**` wird nur gelesen.
 * - **Kein Polling.** STX-08: Polling ist kein Ersatz für die WS-Quelle.
 * - **Kein Live-Pfad.** Dieser Adapter *liest* ein Leader-Konto; er schreibt
 *   nie. Ausgeführt wird im `SIMULATE_ONLY`-Follower
 *   (`src/copy/follower/simulated.ts`).
 *
 * ## Reihenfolge (sicherheitsrelevant)
 *
 *   1. `connect()` nimmt ZUERST einen **Baseline-Snapshot**
 *      (`getPositions` + Account-Equity) — „so war es vorher".
 *   2. erst danach wird der Frame-Strom scharf geschaltet.
 *
 * Ohne Baseline gibt es **kein** Kopieren: der Adapter bleibt in einem
 * Nicht-LIVE-Zustand, emittiert nichts, und der Engine-Gate-Code lautet
 * `NO_BASELINE` (`src/copy/policy.ts`). Ein No-Op mit Seiteneffekt („ich
 * kopiere trotzdem den aktuellen Stand") ist ausgeschlossen — ohne Baseline
 * würde der erste Reconnect alles kopieren, was in der Zwischenzeit passiert
 * ist.
 *
 * ## Lücken-Erkennung
 *
 * Der private Kanal pusht nur bei echten Orders — Stille ist der Normalfall.
 * Deshalb hält ein Ping-Loop die Verbindung warm und **jeder** eingehende
 * Frame (auch `pong`) erneuert den Heartbeat. Bleibt der Heartbeat für
 * `heartbeatTimeoutMs` aus, ist die Verbindung tot: der Leader **pausiert**
 * (`PAUSED_NO_HEARTBEAT`). Copy mit veralteten Daten ist gefährlicher als kein
 * Copy. Ein Resume nimmt einen frischen Baseline-Snapshot.
 *
 * ## Secrets
 *
 * API-Key/Secret werden ausschließlich über `secrets.ts` geladen und über
 * `redactor.ts` maskiert. Der WS-Login-Body (enthält `apiKey` **und** `sign`)
 * wird nie geloggt, nie auditiert und nie in einer Fehlermeldung
 * durchgereicht — nur `safeErrorMessage()` verlässt dieses Modul.
 */
import { createHash } from "node:crypto";

import type { BitunixRuntimeConfig } from "@/brokers/bitunix/config";
import {
  createBitunixLogger,
  safeErrorMessage,
  type BitunixLogger,
} from "@/brokers/bitunix/redactor";
import type { BitunixCredentials } from "@/brokers/bitunix/secrets";
import { signBitunixRequest } from "@/brokers/bitunix/signing";
import {
  BitunixPublicWs,
  openHardenedWs,
  type WsLike,
} from "@/brokers/bitunix/ws";
import type { BrokerPosition } from "@/contracts/broker";
import type {
  NormalizedLeaderTrade,
  PositionSide,
  TradeAction,
} from "@/copy/types";
import { writeAuditRecord, type AuditRecord } from "@/lib/auditSink";
import { metricLabel, telemetry } from "@/lib/telemetry";

// ─────────────────────────────────────────────────────────────────────────────
// Verträge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Der Leader-Vertrag (07-03). Bewusst genau diese drei Methoden: die Engine
 * braucht eine Quelle, die sich verbindet, Ereignisse zustellt und trennt.
 * `getStatus()` ist **optional** — die Engine fragt es für die Baseline- und
 * Heartbeat-Tore ab, aber kein Leader muss es implementieren.
 */
export interface LeaderAdapter {
  connect(): Promise<void>;
  onEvent(handler: (event: NormalizedLeaderTrade) => void): void;
  disconnect(): Promise<void>;
  /** Optionale Beobachtbarkeit (07-03): niemals Pflicht des Vertrags. */
  getStatus?(): LeaderStatus;
}

/**
 * Leader-Zustand. `LIVE` ist der **einzige** Zustand, in dem kopiert werden
 * darf: nur hier existiert ein aktueller Baseline-Snapshot **und** ein frischer
 * Heartbeat.
 */
export type LeaderState =
  | "IDLE"
  | "CONNECTING"
  | "BASELINE"
  | "LIVE"
  | "PAUSED_NO_HEARTBEAT"
  | "STOPPED";

export interface LeaderStatus {
  readonly state: LeaderState;
  /** Zeitpunkt des Baseline-Snapshots; `null` = es gibt keinen. */
  readonly baselineAt: number | null;
  readonly lastFrameAt: number | null;
  readonly lastEventAt: number | null;
  /** Benannter Pausengrund (Heartbeat-Lücke), sonst `null`. */
  readonly pauseReason: string | null;
  readonly frames: number;
  readonly events: number;
  readonly dropped: number;
}

/** Eine Baseline-Position des Leaders („so war es vorher"). */
export interface LeaderBaselinePosition {
  /** Native Venue-Schreibweise (z. B. `BTCUSDT`) — Mapping ist Engine-Sache. */
  readonly symbol: string;
  readonly side: PositionSide;
  readonly qty: number;
  readonly entryPrice: number | null;
}

/** Der Connect-Snapshot: Positionsstand + Leader-Equity (EQUITY_RATIO). */
export interface LeaderSnapshot {
  readonly at: number;
  readonly positions: readonly LeaderBaselinePosition[];
  readonly equity: number | null;
}

/**
 * Port für den Baseline-Snapshot. Produktionsimplementierung:
 * {@link BitunixPrivateSnapshotReader} über `BitunixPrivateClient`
 * (`getPositions` + `getAccount`) — beides **lesend**.
 */
export interface LeaderSnapshotReader {
  read(): Promise<LeaderSnapshot>;
}

/**
 * Port für den privaten Frame-Strom. Produktionsimplementierung:
 * {@link BitunixOrderFrameSource} über `BitunixPublicWs` (ein Socket, keine
 * zweite Client-Klasse).
 */
export interface LeaderFrameSource {
  start(onFrame: (raw: unknown) => void): Promise<LeaderFrameSocket>;
}

export interface LeaderFrameSocket {
  close(): void;
  /** Spielt einen Roh-Frame ein (Tests/Offline-Rehearsal, kein Netz). */
  ingest(raw: unknown): void;
}

export type LeaderAdapterErrorCode =
  | "BASELINE_UNAVAILABLE"
  | "FRAME_SOURCE_UNAVAILABLE";

/** Lauter, benannter Fehler — niemals ein stiller Weiterlauf ohne Baseline. */
export class LeaderAdapterError extends Error {
  readonly code: LeaderAdapterErrorCode;
  constructor(code: LeaderAdapterErrorCode, message: string) {
    super(message);
    this.name = "LeaderAdapterError";
    this.code = code;
  }
}

export type LeaderAuditWriter = (record: AuditRecord) => Promise<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Venue-Frame-Decoder (rein, kein IO)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dokumentierter privater Kanal: `wss://fapi.bitunix.com/private/`,
 * `ch: "order"`. Felder laut Venue-Doku: `event`, `orderId`, `symbol`,
 * `side` (BUY/SELL), `qty`, `price`, `ctime`/`mtime` (ISO-8601 mit
 * Nanosekunden), `orderStatus`, `averagePrice`, `dealAmount`, `leverage`,
 * `clientId`, `slPrice`, `tpPrice`, `positionMode` (ONE_WAY/HEDGE).
 */
export const BITUNIX_LEADER_CHANNEL = "order";
export const BITUNIX_PRIVATE_WS_PATH = "/private/";

/** Default-Heartbeat: 15 s Ping, 45 s Timeout. Beide injizierbar. */
export const DEFAULT_LEADER_PING_INTERVAL_MS = 15_000;
export const DEFAULT_LEADER_HEARTBEAT_TIMEOUT_MS = 45_000;

/** Order-Status, die einen echten Fill bedeuten (nur sie lösen Copy aus). */
const FILL_STATUSES: ReadonlySet<string> = new Set(["FILLED", "PART_FILLED"]);

export interface LeaderOrderObservation {
  readonly orderId: string;
  readonly clientId: string | null;
  /** Native Venue-Schreibweise, z. B. `BTCUSDT`. */
  readonly symbol: string;
  readonly side: "BUY" | "SELL";
  readonly positionMode: "ONE_WAY" | "HEDGE" | null;
  readonly orderType: "LIMIT" | "MARKET" | null;
  /** Ordermenge (Basiseinheiten). */
  readonly qty: number;
  /** Gefüllte Menge (`dealAmount`). */
  readonly filledQty: number;
  readonly price: number | null;
  readonly averagePrice: number | null;
  readonly orderStatus: string;
  readonly event: string;
  readonly leverage: number | null;
  readonly feeQuote: number | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  /** Eventzeit des Leaders in ms (`mtime`, sonst `ctime`, sonst `ts`). */
  readonly occurredAt: number;
  /** Stabiler Dedupe-Schlüssel: gleiche Zustellung ⇒ gleicher Schlüssel. */
  readonly eventKey: string;
}

const SAFE_KEY = /^[A-Za-z0-9_.:/-]{1,128}$/;
const NUMERIC = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Numerisches Venue-Feld: Strings werden streng geparst, Müll → `null`. */
export function parseVenueNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || !NUMERIC.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ISO-8601-Nanosekunden der Venue → ms. Unlesbar ⇒ `null`. */
export function parseVenueTimestamp(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  const nano = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (nano) {
    const fraction = (nano[2] ?? "").padEnd(3, "0").slice(0, 3);
    const parsed = Date.parse(`${nano[1]}.${fraction}Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Stabiler Event-Schlüssel. Bevorzugt eine venue-eigene ID; sonst
 * deterministisch aus den unveränderlichen Fachfeldern abgeleitet.
 * **Wichtig:** dieselbe doppelt zugestellte Nachricht MUSS denselben Schlüssel
 * ergeben — davon lebt die persistente Dedupe in `copy_order_links`.
 */
function eventKeyOf(data: Record<string, unknown>, occurredAt: number): string {
  for (const field of ["eventId", "id"]) {
    const value = data[field];
    if (typeof value === "string" && SAFE_KEY.test(value.trim())) {
      return value.trim();
    }
  }
  const seed = [
    String(data.orderId ?? ""),
    String(data.clientId ?? ""),
    String(data.symbol ?? "").toUpperCase(),
    String(data.side ?? "").toUpperCase(),
    String(data.orderStatus ?? "").toUpperCase(),
    String(data.dealAmount ?? ""),
    String(occurredAt),
  ].join("|");
  return `bxo-${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Dekodiert einen Roh-Frame des privaten Kanals.
 *
 * Rein und fail-closed: alles, was nicht **eindeutig** ein gefüllter Order-Frame
 * ist, ergibt `null`. Geraten wird nie — ein falsch kopierter Fill ist
 * schlimmer als ein ausgelassener.
 */
export function parseLeaderFrame(raw: unknown): LeaderOrderObservation | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const frame = raw as Record<string, unknown>;
  const channel = String(frame.ch ?? frame.channel ?? "").trim().toLowerCase();
  if (channel !== BITUNIX_LEADER_CHANNEL) return null;

  const data = frame.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;

  const orderId = typeof row.orderId === "string" ? row.orderId.trim() : "";
  if (orderId.length === 0 || !SAFE_KEY.test(orderId)) return null;

  const symbol = typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
  if (symbol.length === 0 || symbol.length > 32) return null;

  const sideRaw = String(row.side ?? "").trim().toUpperCase();
  if (sideRaw !== "BUY" && sideRaw !== "SELL") return null;

  const qty = parseVenueNumber(row.qty);
  if (qty === null || qty <= 0) return null;
  const filledQty = parseVenueNumber(row.dealAmount) ?? 0;
  if (filledQty < 0 || filledQty > qty * (1 + 1e-9)) return null;

  const occurredAt =
    parseVenueTimestamp(row.mtime) ??
    parseVenueTimestamp(row.ctime) ??
    parseVenueTimestamp(frame.ts);
  if (occurredAt === null) return null;

  const positionModeRaw = String(row.positionMode ?? "").trim().toUpperCase();
  const positionMode =
    positionModeRaw === "ONE_WAY" || positionModeRaw === "HEDGE" ? positionModeRaw : null;
  const orderTypeRaw = String(row.type ?? "").trim().toUpperCase();
  const orderType =
    orderTypeRaw === "LIMIT" || orderTypeRaw === "MARKET" ? orderTypeRaw : null;

  const leverage = parseVenueNumber(row.leverage);
  const clientId =
    typeof row.clientId === "string" && row.clientId.trim().length > 0
      ? row.clientId.trim().slice(0, 64)
      : null;

  return {
    orderId,
    clientId,
    symbol,
    side: sideRaw,
    positionMode,
    orderType,
    qty,
    filledQty,
    price: parseVenueNumber(row.price),
    averagePrice: parseVenueNumber(row.averagePrice),
    orderStatus: String(row.orderStatus ?? "").trim().toUpperCase(),
    event: String(row.event ?? "").trim().toUpperCase(),
    leverage: leverage !== null && leverage > 0 ? leverage : null,
    feeQuote: parseVenueNumber(row.fee),
    stopLoss: parseVenueNumber(row.slPrice),
    takeProfit: parseVenueNumber(row.tpPrice),
    occurredAt,
    eventKey: eventKeyOf(row, occurredAt),
  };
}

/** true, wenn der Frame einen echten Fill meldet (Copy darf auslösen). */
export function isFillObservation(observation: LeaderOrderObservation): boolean {
  return FILL_STATUSES.has(observation.orderStatus);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ableitung der Handlungsabsicht (rein)
// ─────────────────────────────────────────────────────────────────────────────

/** Laufender Positionsstand des Leaders — startet beim Baseline-Snapshot. */
export interface LeaderPositionState {
  qty: number;
  entryPrice: number | null;
  leverage: number | null;
}

export type ActionDerivation =
  | {
      ok: true;
      action: TradeAction;
      positionSide: PositionSide;
      /** Resultierender Stand nach diesem Fill (0 = geschlossen). */
      resultingQty: number;
    }
  | { ok: false; reason: string };

function qtyOf(state: LeaderPositionState | undefined): number {
  return state && Number.isFinite(state.qty) && state.qty > 0 ? state.qty : 0;
}

function deriveForSide(
  observation: LeaderOrderObservation,
  target: PositionSide,
  previousQty: number,
): ActionDerivation {
  const opensTarget = (target === "LONG") === (observation.side === "BUY");
  if (opensTarget) {
    return {
      ok: true,
      action: previousQty > 0 ? "INCREASE" : "OPEN",
      positionSide: target,
      resultingQty: previousQty + observation.filledQty,
    };
  }
  if (previousQty <= 0) {
    // Defensive Invariante: über die dokumentierten Regeln oben nicht
    // erreichbar (ohne Position wird in Ordersrichtung eröffnet). Sie bleibt
    // als Absicherung gegen venue-seitige Semantikänderungen.
    return {
      ok: false,
      reason: `UNATTRIBUTABLE_${observation.side}_WITHOUT_${target}_POSITION`,
    };
  }
  return {
    ok: true,
    action: observation.filledQty >= previousQty - 1e-12 ? "CLOSE" : "DECREASE",
    positionSide: target,
    resultingQty: Math.max(0, previousQty - observation.filledQty),
  };
}

/**
 * Leitet `OPEN | INCREASE | DECREASE | CLOSE` deterministisch ab.
 *
 * Venue-Semantik, kein Raten:
 * - `HEDGE`: BUY wirkt auf die LONG-, SELL auf die SHORT-Seite (jede Seite ist
 *   eine eigene Position).
 * - `ONE_WAY`/unbekannt (Net-Mode): es gibt genau EINE Netto-Position je
 *   Symbol. Ein BUY gegen eine offene SHORT-Position **verkleinert** sie; ein
 *   SELL gegen eine offene LONG-Position **verkleinert** sie. Steht keine
 *   Position, eröffnet die Order in ihrer eigenen Richtung.
 * - Gegenrichtung ohne offene Position ⇒ **nicht** attribuierbar
 *   (`ok:false`): ohne Baseline-Wissen ist nicht unterscheidbar, ob hier
 *   geschlossen oder ein Gegeneinstieg eröffnet wird.
 * - Beide Seiten gleichzeitig offen im Net-Mode ⇒ nicht attribuierbar.
 */
export function deriveLeaderAction(
  observation: LeaderOrderObservation,
  longPosition: LeaderPositionState | undefined,
  shortPosition: LeaderPositionState | undefined,
): ActionDerivation {
  if (observation.positionMode === "HEDGE") {
    return deriveForSide(
      observation,
      observation.side === "BUY" ? "LONG" : "SHORT",
      qtyOf(observation.side === "BUY" ? longPosition : shortPosition),
    );
  }

  const longQty = qtyOf(longPosition);
  const shortQty = qtyOf(shortPosition);
  if (longQty > 0 && shortQty > 0) {
    return { ok: false, reason: "AMBIGUOUS_NET_POSITION" };
  }
  if (observation.side === "BUY") {
    return deriveForSide(observation, shortQty > 0 ? "SHORT" : "LONG", shortQty > 0 ? shortQty : longQty);
  }
  return deriveForSide(observation, longQty > 0 ? "LONG" : "SHORT", longQty > 0 ? longQty : shortQty);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisierung: Observation → NormalizedLeaderTrade
// ─────────────────────────────────────────────────────────────────────────────

export interface LeaderTradeContext {
  readonly leaderAccount: string;
  readonly now: number;
}

/**
 * Baut die normalisierte Handlungsabsicht. `symbol` bleibt die **native**
 * Venue-Schreibweise — die venue-übergreifende Zuordnung ist SSoT-Aufgabe der
 * Engine (`mapLeaderSymbol`, 07-01). Kein `String.replace` auf das Rohsymbol.
 */
export function toNormalizedLeaderTrade(
  observation: LeaderOrderObservation,
  derivation: Extract<ActionDerivation, { ok: true }>,
  context: LeaderTradeContext,
): NormalizedLeaderTrade {
  const fillPrice = observation.averagePrice ?? observation.price;
  const notional =
    fillPrice !== null && fillPrice > 0 ? observation.filledQty * fillPrice : 0;
  const fillRatio =
    observation.qty > 0
      ? Math.min(1, Math.max(0, observation.filledQty / observation.qty))
      : 0;
  return {
    eventId: observation.eventKey,
    leaderVenue: "BITUNIX",
    leaderAccount: context.leaderAccount,
    symbol: observation.symbol,
    side: derivation.positionSide,
    action: derivation.action,
    quantity: observation.filledQty,
    notional,
    entryPrice: fillPrice !== null && fillPrice > 0 ? fillPrice : null,
    leverage: observation.leverage,
    stopLoss: observation.stopLoss,
    takeProfit: observation.takeProfit,
    occurredAt: observation.occurredAt,
    fillRatio,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frame-Quelle über den bestehenden WS-Client
// ─────────────────────────────────────────────────────────────────────────────

export interface BitunixOrderFrameSourceOptions {
  readonly config: BitunixRuntimeConfig;
  readonly credentials: BitunixCredentials;
  readonly logger?: BitunixLogger;
  readonly now?: () => number;
  readonly backoff?: (attempt: number) => number;
  readonly nonce?: () => string;
  /** 0 deaktiviert den Ping-Loop (Tests). */
  readonly pingIntervalMs?: number;
  readonly channels?: readonly string[];
  readonly onReconnect?: (attempt: number) => void;
  readonly onError?: (error: Error) => void;
}

/**
 * Leitet die dokumentierte Private-Kanal-URL aus der Runtime-Config ab.
 *
 * Gleiches Schema und derselbe Host wie die konfigurierte WS-URL — die
 * SSRF-Host-Allowlist von `assertWsUrl` (im bestehenden Client) greift
 * deshalb unverändert. Nur der Pfad wird auf den privaten Kanal gesetzt.
 */
export function bitunixPrivateWsUrl(config: BitunixRuntimeConfig): string {
  const url = new URL(config.wsUrl);
  url.pathname = BITUNIX_PRIVATE_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * WS-Login-Body laut Venue-Doku:
 * `sign = SHA256(SHA256(nonce + timestamp + apiKey) + secretKey)` — ohne
 * Query-Params und ohne Body. Exakt die Formel aus `signing.ts`
 * (`signBitunixRequest` mit leerem `queryParams`/`body`), also **keine**
 * zweite Signaturimplementierung.
 *
 * Der Rückgabewert enthält `apiKey` UND `sign`: nie loggen, nie auditieren.
 */
export function bitunixWsLoginBody(
  credentials: BitunixCredentials,
  nonce: string,
  timestamp: number,
): Record<string, unknown> {
  const { sign } = signBitunixRequest({
    nonce,
    timestamp: String(timestamp),
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
  });
  return {
    op: "login",
    args: [{ apiKey: credentials.apiKey, timestamp, nonce, sign }],
  };
}

/** Subscribe-Body für den dokumentierten Order-Kanal. */
export function bitunixWsSubscribeBody(channels: readonly string[]): Record<string, unknown> {
  return { op: "subscribe", args: channels.map((ch) => ({ ch })) };
}

/** Ping-Body (Venue erlaubt max. 5 Nachrichten/s — 15 s ist weit darunter). */
export function bitunixWsPingBody(unixSeconds: number): Record<string, unknown> {
  return { op: "ping", ping: unixSeconds };
}

function isControlFrame(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const op = String((raw as Record<string, unknown>).op ?? "").trim().toLowerCase();
  return op === "ping" || op === "pong" || op === "login";
}

/**
 * Privater Order-Kanal über den **bestehenden** WS-Client.
 *
 * Ein Socket, geöffnet über `openHardenedWs` (Versions-Guard + gehärtete
 * Optionen) und getragen von `BitunixPublicWs` (Reconnect/Backoff). Der
 * private Kanal wird von diesem Client nicht dekodiert — deshalb hängt dieses
 * Modul einen eigenen Frame-Tap **an denselben** Socket. Es entsteht keine
 * zweite Verbindung und keine zweite Client-Klasse.
 *
 * `BitunixPublicWs` subscribed nur Ticker/Klines; Login und Kanal-Abo werden
 * hier beim Socket-Open gesendet (und bei jedem Reconnect erneut).
 */
export class BitunixOrderFrameSource implements LeaderFrameSource {
  private readonly logger: BitunixLogger;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly pingIntervalMs: number;
  private readonly channels: readonly string[];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSocket: WsLike | null = null;

  constructor(private readonly opts: BitunixOrderFrameSourceOptions) {
    this.logger =
      opts.logger ??
      createBitunixLogger(() => [opts.credentials.apiKey, opts.credentials.apiSecret]);
    this.now = opts.now ?? (() => Date.now());
    this.nonce =
      opts.nonce ??
      (() =>
        createHash("sha256").update(String(this.now()), "utf8").digest("hex").slice(0, 32));
    this.pingIntervalMs = opts.pingIntervalMs ?? DEFAULT_LEADER_PING_INTERVAL_MS;
    this.channels = opts.channels ?? [BITUNIX_LEADER_CHANNEL];
  }

  async start(onFrame: (raw: unknown) => void): Promise<LeaderFrameSocket> {
    const url = bitunixPrivateWsUrl(this.opts.config);
    const credentials = this.opts.credentials;
    const channels = this.channels;

    const client = new BitunixPublicWs({
      config: { ...this.opts.config, wsUrl: url },
      logger: this.logger,
      now: this.now,
      backoff: this.opts.backoff,
      handlers: {
        onReconnect: this.opts.onReconnect,
        onError: this.opts.onError,
      },
      open: (openUrl: string): WsLike => {
        const socket = openHardenedWs(openUrl);
        this.attachSocketIo(socket, credentials, channels);
        attachFrameTap(socket, onFrame);
        return socket;
      },
    });

    await client.start();
    this.startPingLoop();
    return {
      close: (): void => {
        this.stopPingLoop();
        client.stop();
      },
      ingest: (raw: unknown): void => {
        if (!isControlFrame(raw)) onFrame(raw);
      },
    };
  }

  private startPingLoop(): void {
    if (this.pingIntervalMs <= 0 || this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => {
      this.sendControl(bitunixWsPingBody(Math.floor(this.now() / 1000)));
    }, this.pingIntervalMs);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendControl(body: Record<string, unknown>): void {
    const socket = this.lastSocket;
    if (!socket) return;
    try {
      socket.send(JSON.stringify(body));
    } catch (error) {
      // Nie den Body loggen — er kann apiKey/sign tragen.
      this.logger.warn(`Leader-WS-Steuernachricht fehlgeschlagen: ${safeErrorMessage(error)}`);
    }
  }

  private attachSocketIo(
    socket: WsLike,
    credentials: BitunixCredentials,
    channels: readonly string[],
  ): void {
    this.lastSocket = socket;
    const onOpen = (): void => {
      try {
        socket.send(JSON.stringify(bitunixWsLoginBody(credentials, this.nonce(), this.now())));
        socket.send(JSON.stringify(bitunixWsSubscribeBody(channels)));
      } catch (error) {
        // Nie den Body loggen — er kann apiKey/sign tragen.
        this.logger.warn(`Leader-WS-Login fehlgeschlagen: ${safeErrorMessage(error)}`);
      }
    };
    addSocketListener(socket, "open", onOpen);
    // Manche Laufzeiten melden „open" bereits vor dem Registrieren.
    if (socket.readyState === 1) onOpen();
  }
}

/** Hängt einen Frame-Tap an einen bestehenden Socket — ohne zweite Verbindung. */
export function attachFrameTap(socket: WsLike, onFrame: (raw: unknown) => void): void {
  const handler = (payload: unknown): void => {
    if (typeof payload === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return;
      }
      onFrame(parsed);
      return;
    }
    if (payload && typeof payload === "object") {
      onFrame(Buffer.isBuffer(payload) ? bufferToObject(payload) : payload);
    }
  };
  addSocketListener(socket, "message", handler);
}

function bufferToObject(payload: Buffer): unknown {
  try {
    return JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
}

/** Einheitlicher Listener-Anschluss (`addEventListener` oder `on`). */
function addSocketListener(
  socket: WsLike,
  type: "open" | "message",
  listener: (payload: unknown) => void,
): void {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(type, (event: { data?: unknown }) => listener(event?.data));
    return;
  }
  socket.on?.(type, (payload: unknown) => listener(payload));
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline-Snapshot über den bestehenden privaten Client
// ─────────────────────────────────────────────────────────────────────────────

/** Der minimale Leseteil von `BitunixPrivateClient`, den wir brauchen. */
export interface BitunixLeaderReader {
  getPositions(): Promise<BrokerPosition[]>;
  getAccount(): Promise<{ equity: number }>;
}

/**
 * Baseline über den **bestehenden** privaten REST-Client. Nur Lesezugriffe:
 * `getPositions` (offene Positionen) und `getAccount` (Equity für
 * EQUITY_RATIO-Sizing). Kein Order-Pfad, kein Write.
 */
export class BitunixPrivateSnapshotReader implements LeaderSnapshotReader {
  constructor(
    private readonly reader: BitunixLeaderReader,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async read(): Promise<LeaderSnapshot> {
    const positions = await this.reader.getPositions();
    let equity: number | null = null;
    try {
      const account = await this.reader.getAccount();
      equity = Number.isFinite(account.equity) ? account.equity : null;
    } catch {
      // Equity wird nur für EQUITY_RATIO gebraucht. Fehlt sie, scheitert
      // genau dieser Sizing-Modus fail-closed — nicht der Baseline-Snapshot.
      equity = null;
    }
    const baseline: LeaderBaselinePosition[] = [];
    for (const position of positions) {
      const symbol = String(position.symbol ?? "").trim().toUpperCase();
      if (symbol.length === 0) continue;
      if (position.side !== "LONG" && position.side !== "SHORT") continue;
      const qty = Number(position.qty);
      if (!Number.isFinite(qty) || qty <= 0) continue;
      const entry = Number(position.entryPrice);
      baseline.push({
        symbol,
        side: position.side,
        qty,
        entryPrice: Number.isFinite(entry) && entry > 0 ? entry : null,
      });
    }
    return { at: this.now(), positions: baseline, equity };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Der Adapter
// ─────────────────────────────────────────────────────────────────────────────

export interface BitunixLeaderAdapterOptions {
  readonly config: BitunixRuntimeConfig;
  readonly snapshot: LeaderSnapshotReader;
  readonly frameSource: LeaderFrameSource;
  /** Konto-/Subaccount-Kennung des Leaders (Audit-Label, kein Secret). */
  readonly leaderAccount: string;
  /** Optionale Native-Symbol-Allowlist (z. B. `["BTCUSDT"]`). */
  readonly symbols?: readonly string[];
  readonly heartbeatTimeoutMs?: number;
  /** false in Tests: der Heartbeat-Check wird manuell ausgelöst. */
  readonly watchdogEnabled?: boolean;
  readonly now?: () => number;
  readonly logger?: BitunixLogger;
  readonly auditWriter?: LeaderAuditWriter;
}

export class BitunixLeaderAdapter implements LeaderAdapter {
  private readonly now: () => number;
  private readonly logger: BitunixLogger;
  private readonly auditWriter: LeaderAuditWriter;
  private readonly heartbeatTimeoutMs: number;
  private readonly watchdogEnabled: boolean;
  private readonly symbolAllowlist: ReadonlySet<string> | null;

  private handlers: Array<(event: NormalizedLeaderTrade) => void> = [];
  /** Laufender Leader-Positionsstand, je `symbol:side`. */
  private positions = new Map<string, LeaderPositionState>();
  private baselineAt: number | null = null;
  private baselineEquity: number | null = null;
  private socket: LeaderFrameSocket | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  private state: LeaderState = "IDLE";
  /** Letzter empfangener Frame (Push) — Beweis für Lebendigkeit. */
  private lastFrameAt: number | null = null;
  /** Letzter empfangener Frame beliebigen Typs (inkl. `pong`). */
  private lastBeatAt: number | null = null;
  private lastEventAt: number | null = null;
  private pauseReason: string | null = null;
  private frames = 0;
  private events = 0;
  private dropped = 0;

  constructor(private readonly opts: BitunixLeaderAdapterOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger ?? createBitunixLogger();
    this.auditWriter = opts.auditWriter ?? writeAuditRecord;
    this.heartbeatTimeoutMs =
      opts.heartbeatTimeoutMs ?? DEFAULT_LEADER_HEARTBEAT_TIMEOUT_MS;
    this.watchdogEnabled = opts.watchdogEnabled ?? true;
    this.symbolAllowlist =
      opts.symbols && opts.symbols.length > 0
        ? new Set(
            opts.symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0),
          )
        : null;
  }

  getStatus(): LeaderStatus {
    return {
      state: this.state,
      baselineAt: this.baselineAt,
      lastFrameAt: this.lastFrameAt,
      lastEventAt: this.lastEventAt,
      pauseReason: this.pauseReason,
      frames: this.frames,
      events: this.events,
      dropped: this.dropped,
    };
  }

  /** Leader-Equity aus dem Baseline-Snapshot (EQUITY_RATIO), sonst `null`. */
  get leaderEquity(): number | null {
    return this.baselineEquity;
  }

  onEvent(handler: (event: NormalizedLeaderTrade) => void): void {
    this.handlers.push(handler);
  }

  /**
   * Verbindet den Leader. Reihenfolge: **erst** Baseline, **dann** Frame-Strom.
   *
   * Wirft {@link LeaderAdapterError} (`BASELINE_UNAVAILABLE`), wenn der
   * Snapshot nicht gelingt. Der Adapter bleibt dann in einem Nicht-LIVE-Zustand
   * und emittiert nichts — ohne Baseline kein Kopieren.
   */
  async connect(): Promise<void> {
    if (this.state === "LIVE") return;
    this.state = "CONNECTING";

    let snapshot: LeaderSnapshot;
    try {
      snapshot = await this.opts.snapshot.read();
    } catch (error) {
      this.state = "IDLE";
      this.pauseReason = "BASELINE_UNAVAILABLE";
      await this.audit({
        event: "COPY_LEADER_BASELINE",
        level: "CRITICAL",
        detail: {
          outcome: "unavailable",
          leaderAccount: this.opts.leaderAccount,
          reason: safeErrorMessage(error),
        },
      });
      telemetry.copy.leader.inc({ result: "baseline_unavailable" });
      throw new LeaderAdapterError(
        "BASELINE_UNAVAILABLE",
        `Leader-Baseline nicht verfügbar: ${safeErrorMessage(error)}`,
      );
    }

    this.baselineAt = snapshot.at;
    this.baselineEquity = snapshot.equity;
    this.positions = new Map(
      snapshot.positions.map((position) => [
        `${position.symbol}:${position.side}`,
        {
          qty: position.qty,
          entryPrice: position.entryPrice,
          leverage: null,
        } satisfies LeaderPositionState,
      ]),
    );
    this.state = "BASELINE";

    // Erst hier darf der Adapter Frames annehmen: die Baseline steht, der
    // Strom wird aufgebaut. Der Zustand wird VOR `start()` gesetzt, weil eine
    // Quelle (Rehearsal/Replay) ihre Frames bereits während `start()`
    // ausliefern kann — ein Frame, der vor `LIVE` verworfen würde, wäre ein
    // verschwiegener Drop.
    this.state = "LIVE";
    try {
      this.socket = await this.opts.frameSource.start((raw) => this.handleFrame(raw));
    } catch (error) {
      this.pause("FRAME_SOURCE_UNAVAILABLE", this.now());
      this.pauseReason = "FRAME_SOURCE_UNAVAILABLE";
      await this.audit({
        event: "COPY_LEADER_BASELINE",
        level: "CRITICAL",
        detail: {
          outcome: "frame_source_unavailable",
          leaderAccount: this.opts.leaderAccount,
          reason: safeErrorMessage(error),
        },
      });
      telemetry.copy.leader.inc({ result: "frame_source_unavailable" });
      throw new LeaderAdapterError(
        "FRAME_SOURCE_UNAVAILABLE",
        `Leader-Frame-Quelle nicht verfügbar: ${safeErrorMessage(error)}`,
      );
    }

    this.lastFrameAt = this.now();
    this.lastBeatAt = this.now();
    this.pauseReason = null;
    this.startWatchdog();
    await this.audit({
      event: "COPY_LEADER_BASELINE",
      level: "INFO",
      detail: {
        outcome: "baseline_ready",
        leaderAccount: this.opts.leaderAccount,
        positions: String(this.positions.size),
      },
    });
    telemetry.copy.leader.inc({ result: "connected" });
  }

  async disconnect(): Promise<void> {
    this.stopWatchdog();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch (error) {
      this.logger.warn(`Leader-WS-Trennen fehlgeschlagen: ${safeErrorMessage(error)}`);
    }
    if (this.state !== "IDLE") this.state = "STOPPED";
    this.handlers = [];
  }

  /**
   * Heartbeat-Prüfung. Bleibt der Heartbeat aus, **pausiert** der Leader: der
   * Socket wird getrennt, der Zustand ist `PAUSED_NO_HEARTBEAT`, es wird
   * nichts mehr emittiert. Copy mit veralteten Daten ist gefährlicher als kein
   * Copy. Ein `connect()` danach nimmt einen frischen Baseline-Snapshot.
   */
  checkHeartbeat(now: number = this.now()): LeaderStatus {
    if (this.state !== "LIVE") return this.getStatus();
    const last = Math.max(this.lastFrameAt ?? 0, this.lastBeatAt ?? 0);
    if (last === 0 || now - last <= this.heartbeatTimeoutMs) return this.getStatus();
    this.pause("HEARTBEAT_LOST", now);
    return this.getStatus();
  }

  /** Manuelles Resume nach einer Pause (frischer Baseline-Snapshot). */
  async resume(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  private pause(reason: string, now: number): void {
    this.stopWatchdog();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* ignorieren — der Zustand zählt, nicht die Fehlermeldung */
    }
    this.state = "PAUSED_NO_HEARTBEAT";
    this.pauseReason = reason;
    void this.audit({
      event: "COPY_LEADER_HEARTBEAT",
      level: "CRITICAL",
      detail: {
        outcome: "paused",
        reason,
        leaderAccount: this.opts.leaderAccount,
        lastFrameAgeMs: String(now - (this.lastFrameAt ?? now)),
      },
    });
    telemetry.copy.leader.inc({ result: "heartbeat_lost" });
    this.logger.warn(`Leader pausiert (${reason}) — kein Copy mit veralteten Daten.`);
  }

  private startWatchdog(): void {
    if (!this.watchdogEnabled || this.watchdog !== null) return;
    const interval = Math.max(250, Math.floor(this.heartbeatTimeoutMs / 3));
    this.watchdog = setInterval(() => {
      this.checkHeartbeat();
    }, interval);
    (this.watchdog as { unref?: () => void }).unref?.();
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private handleFrame(raw: unknown): void {
    // Defensiv: ein pausierter Leader verarbeitet nichts mehr. Der Socket ist
    // in `pause()` geschlossen — dieser Guard deckt den Fall ab, dass eine
    // injizierte Quelle (Tests/Rehearsal) trotzdem weiterliefert.
    if (this.state !== "LIVE") return;
    const receivedAt = this.now();
    this.lastFrameAt = receivedAt;
    this.lastBeatAt = receivedAt;
    this.frames += 1;

    const observation = parseLeaderFrame(raw);
    if (!observation) {
      this.dropped += 1;
      telemetry.copy.leader.inc({ result: "frame_ignored" });
      return;
    }
    if (!isFillObservation(observation)) {
      // INIT/NEW/CANCELED/PART_FILLED_CANCELED: kein Fill ⇒ kein Copy.
      this.dropped += 1;
      telemetry.copy.leader.inc({
        result: `status_${metricLabel(observation.orderStatus, "UNKNOWN")}`,
      });
      return;
    }
    if (this.symbolAllowlist && !this.symbolAllowlist.has(observation.symbol)) {
      this.dropped += 1;
      telemetry.copy.leader.inc({ result: "symbol_filtered" });
      return;
    }

    const longPosition = this.positions.get(`${observation.symbol}:LONG`);
    const shortPosition = this.positions.get(`${observation.symbol}:SHORT`);
    const derivation = deriveLeaderAction(observation, longPosition, shortPosition);
    if (!derivation.ok) {
      this.dropped += 1;
      telemetry.copy.leader.inc({ result: "unattributable" });
      void this.audit({
        event: "COPY_LEADER_EVENT",
        level: "WARN",
        detail: {
          outcome: "dropped",
          reason: derivation.reason,
          leaderAccount: this.opts.leaderAccount,
        },
      });
      return;
    }

    const key = `${observation.symbol}:${derivation.positionSide}`;
    if (derivation.resultingQty > 0) {
      const previous =
        derivation.positionSide === "LONG" ? longPosition : shortPosition;
      this.positions.set(key, {
        qty: derivation.resultingQty,
        entryPrice: previous?.entryPrice ?? null,
        leverage: observation.leverage ?? previous?.leverage ?? null,
      });
    } else {
      this.positions.delete(key);
    }

    const trade = toNormalizedLeaderTrade(observation, derivation, {
      leaderAccount: this.opts.leaderAccount,
      now: receivedAt,
    });
    this.events += 1;
    this.lastEventAt = receivedAt;
    telemetry.copy.leader.inc({ result: "event" });
    for (const handler of this.handlers) {
      try {
        handler(trade);
      } catch (error) {
        // Ein brechender Handler darf den Leader nicht mitreißen.
        this.logger.warn(`Leader-Handler fehlgeschlagen: ${safeErrorMessage(error)}`);
      }
    }
  }

  private async audit(record: Omit<AuditRecord, "auditClass">): Promise<void> {
    try {
      await this.auditWriter({ ...record, auditClass: "security" });
    } catch {
      /* Audit-Fehler dürfen den Leader nicht mitreißen — Zähler bleibt sichtbar. */
    }
  }
}

/** Diagnosehilfe für Tests: erzeugt einen Roh-Order-Frame. */
export function buildLeaderOrderFrame(
  data: Record<string, unknown>,
  ts: number,
): Record<string, unknown> {
  return { ch: BITUNIX_LEADER_CHANNEL, ts, data };
}
