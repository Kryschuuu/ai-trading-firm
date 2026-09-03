/**
 * Privater REST-Client (signiert) für Account/Positions/Place-Order.
 *
 * Wird vom Live-Pfad des Adapters über die `BrokerExecutionEngine`
 * (src/brokers/bitunix/execution.ts) aufgerufen — und zwar NUR nach bestandener
 * Live-Gate-Prüfung (Task 11). Ohne Freigabe wirft `placeOrder` am Adapter
 * weiterhin `LiveTradingGateError`, sodass dieser Client dann nie erreicht wird.
 * Paper/backtest stellen nie einen signierten Request (PaperExecutionEngine).
 */
import type { BrokerAccount, BrokerPosition } from "../../contracts/broker";
import { BITUNIX_PATHS } from "./config";
import { BitunixApiError, classifyBitunixFailure } from "./errors";
import { BitunixHttp, TokenBucket, type BitunixHttpOptions } from "./http";
import {
  encodeQueryParams,
  signBitunixRequest,
  type MonotonicTimestamp,
  type NonceFactory,
  defaultNonceFactory,
  defaultTimestamp,
} from "./signing";
import {
  recordBitunixPrivateCall,
  recordBitunixPositionAnomaly,
} from "./audit";
import { createBitunixLogger, type BitunixLogger } from "./redactor";
import type { BitunixCredentials } from "./secrets";
import type {
  BitunixAccountRaw,
  BitunixEnvelope,
  BitunixFill,
  BitunixOrderRaw,
  BitunixPlaceOrderBody,
  BitunixPositionRaw,
  BitunixTradeRaw,
} from "./types";

/**
 * Normalisiertes Order-Detail (H3). Venue-Status bleibt venue-nah
 * ("NEW" | "PART_FILLED" | "FILLED" | "CANCELED" | "INIT" | string) und wird
 * erst in der Execution-Engine auf den BrokerOrderStatus-Contract gemappt.
 * `avgPrice` ist 0, solange das Venue keinen Füllpreis meldet — die Engine
 * berechnet den echten avgPrice dann aus getExecutions (Trades).
 */
export interface BitunixOrderDetail {
  orderId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  filledQty: number;
  avgPrice: number;
  status: string;
}

/** Normalisiert einen Venue-Status-String robust (case-insensitive). */
function normStatus(s: unknown): string {
  return String(s ?? "").trim().toUpperCase();
}

/** Side-Rohwert (BUY/SELL) → broker-unabhängige LONG/SHORT-Richtung. */
function sideOf(raw: unknown): "LONG" | "SHORT" {
  return normStatus(raw) === "SELL" ? "SHORT" : "LONG";
}

/**
 * Mappt einen Venue-Order-Status auf den BrokerOrderStatus-Contract.
 * Bitunix-Doku: INIT (prepare), NEW (pending), PART_FILLED (partiell),
 * CANCELED, FILLED. Unbekannte Werte → UNKNOWN (fail-safe, kein Fill).
 */
export function mapBitunixOrderStatus(venueStatus: string): import("../../contracts/broker").BrokerOrderStatus {
  switch (normStatus(venueStatus)) {
    case "NEW":
    case "INIT":
      return "NEW";
    case "PART_FILLED":
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "FILLED":
      return "FILLED";
    case "CANCELED":
    case "CANCELLED":
    case "EXPIRED":
    case "PART_FILLED_CANCELED":
      return "CANCELED";
    default:
      return "UNKNOWN";
  }
}

/**
 * B2: Side-Rohwert einer **Positionszeile** → Richtung oder `null`.
 *
 * Das Venue dokumentiert für `position/get_pending_positions` exakt `LONG`
 * und `SHORT`. Alles andere (leer, `null`, `SELL`, abgeschnittener Müll, aber
 * auch Order-seitige Rohwerte wie `BUY`/`SELL`, die hier nicht hingehören)
 * liefert `null` — der Aufrufer verwirft die Zeile, statt sie zu raten.
 *
 * Bewusst KEIN `!== "SHORT" → LONG`: ein stiller LONG-Fallback maskiert eine
 * korrumpierte Antwort und lässt eine Short-Position als Long erscheinen
 * (uPnL-Vorzeichen, Risk-Geometrie, Seitenlogik). Case/Whitespace-tolerant ist
 * die Normalisierung dagegen wohlwollend, weil die Venue Felder je nach
 * Antwortversion gemischt liefert.
 */
export function parseBitunixPositionSide(raw: unknown): "LONG" | "SHORT" | null {
  const norm = String(raw ?? "").trim().toUpperCase();
  if (norm === "LONG" || norm === "SHORT") return norm;
  return null;
}

/** Rohwert einer Seitenangabe für Audit/Log (gekürzt, nie die ganze Zeile). */
function sideSnippet(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

function envelopeData<T>(json: unknown): T {
  if (!json || typeof json !== "object") {
    throw new BitunixApiError("unknown", "Bitunix: leere Antwort.");
  }
  const env = json as BitunixEnvelope<T>;
  if (typeof env.code === "number" && env.code !== 0) {
    const c = classifyBitunixFailure({ venueCode: env.code, venueMsg: env.msg });
    throw new BitunixApiError(c.kind, c.message, { venueCode: env.code });
  }
  return env.data;
}

export interface BitunixPrivateClientOptions extends BitunixHttpOptions {
  credentials: BitunixCredentials;
  nonceFactory?: NonceFactory;
  timestamp?: MonotonicTimestamp;
}

/**
 * Liest ein numerisches Feld der Venue-Account-Zeile robust. Liefert NaN, wenn
 * das Feld GENUIN fehlt (undefined/null/leer) oder nicht numerisch ist —
 * Aufrufer entscheiden dann über den dokumentierten Fallback (H8).
 */
function accountRowNumber(row: BitunixAccountRaw | undefined, field: keyof BitunixAccountRaw): number {
  if (!row || typeof row !== "object") return NaN;
  const raw = row[field];
  if (raw === undefined || raw === null || raw === "") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/** NaN (Feld fehlt) → Fallback; endliche Werte unverändert. */
function finiteOr(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback;
}

export class BitunixPrivateClient {
  private readonly http: BitunixHttp;
  private readonly creds: BitunixCredentials;
  private readonly nonces: NonceFactory;
  private readonly clock: MonotonicTimestamp;
  /**
   * Redaktierter Logger für Betriebsmeldungen aus der Mapping-Schicht (B2).
   * Ohne Zufuhr aus dem Adapter wird ein eigener, Secret-maskierender Logger
   * erzeugt — Ausgaben gehen nie unredigiert nach außen.
   */
  private readonly logger: BitunixLogger;

  constructor(opts: BitunixPrivateClientOptions) {
    this.http = new BitunixHttp({
      ...opts,
      bucket: opts.bucket ?? new TokenBucket(opts.config.privateRatePerSec, opts.config.privateRatePerSec),
      secrets: () => [opts.credentials.apiKey, opts.credentials.apiSecret],
    });
    this.creds = opts.credentials;
    this.nonces = opts.nonceFactory ?? defaultNonceFactory;
    this.clock = opts.timestamp ?? defaultTimestamp;
    this.logger =
      opts.logger ?? createBitunixLogger(() => [this.creds.apiKey, this.creds.apiSecret]);
  }

  private async signed(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    body: string,
    opts?: { idempotent?: boolean }
  ) {
    const nonce = this.nonces.next();
    const timestamp = this.clock.next();
    const queryParams = encodeQueryParams(query ?? {});
    const { sign } = signBitunixRequest({
      nonce,
      timestamp,
      apiKey: this.creds.apiKey,
      secret: this.creds.apiSecret,
      queryParams,
      body,
    });
    const headers = {
      "api-key": this.creds.apiKey,
      nonce,
      timestamp,
      sign,
      language: "en-US",
    };
    try {
      const res = await this.http.request({
        method,
        path,
        query,
        body: method === "POST" ? body : undefined,
        headers,
        signed: true,
        idempotent: opts?.idempotent,
      });
      await recordBitunixPrivateCall({ method, path, outcome: "OK", errorCode: null });
      return res;
    } catch (e) {
      const code = e instanceof BitunixApiError ? e.code : "BITUNIX_UNKNOWN";
      await recordBitunixPrivateCall({
        method,
        path,
        outcome: e instanceof BitunixApiError && e.kind === "auth" ? "DENIED" : "ERROR",
        errorCode: code,
      });
      throw e;
    }
  }

  async getAccount(marginCoin = "USDT"): Promise<BrokerAccount> {
    const res = await this.signed("GET", BITUNIX_PATHS.account, { marginCoin }, "");
    const data = envelopeData<BitunixAccountRaw[] | BitunixAccountRaw>(res.json);
    const row = Array.isArray(data) ? data[0] : data;

    // H8: KANONISCHE Kontozerlegung statt „equity = available + uPnL“.
    // `available` ist die FREIE MARGIN (freies Cash), nicht die Equity: Bei
    // offenen Positionen bindet das Venue Margin (`margin`, ggf. `usedMargin`)
    // und Order-Margin (`frozen`) — beides gehört weiter zum Gesamtkapital.
    // Equity ist der Risiko-Denominator (maxPositionPct, Sizing, Drawdown) und
    // muss die gebundene Margin einschließen.
    const available = finiteOr(accountRowNumber(row, "available"), 0); // freie Margin
    const frozen = finiteOr(accountRowNumber(row, "frozen"), 0); // Order-Margin
    const margin = finiteOr(accountRowNumber(row, "margin"), 0); // Positions-Margin
    const unrealizedPnl =
      finiteOr(accountRowNumber(row, "crossUnrealizedPNL"), 0) +
      finiteOr(accountRowNumber(row, "isolationUnrealizedPNL"), 0);

    // Wallet-Balance: Bitunix liefert `walletBalance` nicht in jeder
    // Antwortversion. Fehlt das Feld (genuin absent), wird es aus den
    // venue-eigenen Komponenten zerlegt — available + Order-Margin +
    // Positions-Margin. Equity wird NIE aus `available` allein synthetisiert.
    const walletBalanceRow = accountRowNumber(row, "walletBalance");
    const walletBalance = Number.isFinite(walletBalanceRow)
      ? walletBalanceRow
      : available + frozen + margin;

    // Realisiertes PnL: Bitunix settled es laufend ins Wallet — die
    // Account-Antwort führt es regulär nicht; nur falls die API es doch
    // liefert, wird es addiert (Fallback 0).
    const realizedRow = accountRowNumber(row, "realizedPnl");
    const realizedPnl = Number.isFinite(realizedRow) ? realizedRow : 0;

    const usedMarginRow = accountRowNumber(row, "usedMargin");
    const usedMargin = Number.isFinite(usedMarginRow) ? usedMarginRow : margin;
    const maintenanceMarginRow = accountRowNumber(row, "maintenanceMargin");
    const maintenanceMargin = Number.isFinite(maintenanceMarginRow) ? maintenanceMarginRow : 0;

    const equity = walletBalance + realizedPnl + unrealizedPnl;
    return {
      equity,
      cash: available,
      walletBalance,
      availableCash: available,
      usedMargin,
      maintenanceMargin,
      unrealizedPnl,
      openPositions: 0, // wird von der Execution-Engine aus getPositions gesetzt
      startingEquity: equity,
      drawdownPct: 0,
    };
  }

  /**
   * Offene Venue-Positionen (`GET position/get_pending_positions`).
   *
   * Zwei-Gate-Filterung, Reihenfolge ist Absicht (B2):
   *
   *   1. `qty` muss endlich und > 0 sein. Das Venue liefert für
   *      geschlossene/Null-Mengen-Zeilen regulär **keine** `side` — sie sind
   *      keine offenen Positionen und scheiden hier aus, bevor die Seite
   *      überhaupt geprüft wird (sonst würden sie als Anomalien zählen).
   *   2. `side` muss `LONG` oder `SHORT` sein. Sonst wird die Zeile
   *      verworfen und als Anomalie gezählt (`readBitunixPositionAnomalies`),
   *      **niemals** als LONG interpretiert — raten wäre gefährlicher als
   *      wegwerfen: eine falsch klassifizierte Short-Position würde im lokalen
   *      View mit dem falschen uPnL-Vorzeichen und der falschen
   *      SL/TP-Geometrie erscheinen.
   *
   * Eine verworfene Zeile ist ein Betriebsereignis (Venue-Antwort unplausibel)
   * und wird deshalb pro Call einmal zusammengefasst geloggt.
   */
  async getPositions(symbol?: string): Promise<BrokerPosition[]> {
    const res = await this.signed(
      "GET",
      BITUNIX_PATHS.positions,
      symbol ? { symbol } : undefined,
      ""
    );
    const data = envelopeData<BitunixPositionRaw[]>(res.json);
    const rows = Array.isArray(data) ? data : [];
    const positions: BrokerPosition[] = [];
    const anomalies: string[] = [];
    for (const r of rows) {
      const qty = Number(r.qty);
      const entry = Number(r.avgOpenPrice);
      // 1) geschlossene / 0-Mengen-Zeilen — vor der Seitenprüfung (B2, DO 2).
      if (!Number.isFinite(qty) || qty <= 0) continue;
      // 2) Richtung validieren, nicht raten (B2, DO 1).
      const side = parseBitunixPositionSide(r.side);
      if (side === null) {
        const sym = String(r.symbol ?? "").trim().toUpperCase();
        const snippet = sideSnippet(r.side);
        recordBitunixPositionAnomaly({ symbol: sym, rawSide: snippet, reason: "UNKNOWN_SIDE" });
        anomalies.push(sym ? `${sym} (side="${snippet}")` : `(side="${snippet}")`);
        continue;
      }
      positions.push({
        symbol: String(r.symbol ?? "").toUpperCase(),
        side,
        qty,
        entryPrice: Number.isFinite(entry) ? entry : 0,
        lastPrice: Number.isFinite(entry) ? entry : 0,
        unrealizedPnl: Number(r.unrealizedPNL ?? 0) || 0,
        stopLoss: null,
        takeProfit: null,
      });
    }
    if (anomalies.length > 0) {
      this.logger.warn(
        `getPositions: ${anomalies.length} Positionszeile(n) ohne verwertbare side verworfen ` +
          `(kein LONG-Fallback, B2): ${anomalies.slice(0, 5).join(", ")}`
      );
    }
    return positions;
  }

  /**
   * Sendet eine bereits serialisierte Order an die Venue — mit echter
   * Idempotenz (H4).
   *
   *   - Der `clientOrderId` (aus `opts.clientOrderId` oder `body.clientId`)
   *     ist der stabile Idempotenz-Key dieses Order-Intents.
   *   - Der Transport (http.ts) wiederholt einen nicht-idempotenten
   *     place_order-POST bei 429/Timeout/Netz/5xx NIE automatisch, sondern
   *     reicht einen `BitunixAmbiguousError` nach oben.
   *   - BEZIEHUNG hier: vor jedem erneuten Senden wird per `getOrderByClientId`
   *     der echte Status abgefragt:
   *        Order gefunden → bestehende Order zurück (kein Duplikat).
   *        Order nicht gefunden → genau EIN kontrollierter Retry mit
   *          demselben `clientOrderId` (derselbe Body).
   *
   * Wird vom Adapter-Live-Pfad über `BrokerExecutionEngine.submit` aufgerufen,
   * ausschließlich nach bestandener Live-Gate-Prüfung.
   */
  async placeSerializedOrder(
    body: BitunixPlaceOrderBody,
    opts?: { clientOrderId?: string }
  ): Promise<{ orderId: string; clientOrderId?: string }> {
    const clientOrderId = opts?.clientOrderId ?? body.clientId;
    const json = JSON.stringify(body);
    try {
      const res = await this.signed("POST", BITUNIX_PATHS.placeOrder, undefined, json, { idempotent: false });
      const data = envelopeData<{ orderId?: string; clientId?: string }>(res.json);
      const orderId = String(data?.orderId ?? "");
      // Venue hat kein orderId geliefert (z. B. edge case) — per clientOrderId
      // nachfragen, statt einen Platzhalter zurückzugeben.
      if (!orderId && clientOrderId) {
        const found = await this.getOrderByClientId(clientOrderId).catch(() => null);
        if (found) return { orderId: found.orderId, clientOrderId };
      }
      return { orderId, clientOrderId: data?.clientId ?? clientOrderId };
    } catch (e) {
      if (!(e instanceof BitunixApiError)) throw e;
      // Nur der Transport-typisierte "ambiguous"-Fehler (HTTP 429 / Timeout /
      // Netz / 5xx) erfordert VOR einem erneuten Senden ein Status-Query per
      // clientOrderId. Venue-Business-Fehler (Envelope-`code != 0`, kind
      // auth/permission/rate-limit/maintenance/unknown) sind DEFINITIVE
      // Ablehnungen — kein Status-Query, kein Retry.
      if (e.kind !== "ambiguous") throw e;
      // Ohne Idempotenz-Key kein sicheres Wiederholen (fail-closed: laut
      // abbrechen statt Doppelorder).
      if (!clientOrderId) throw e;
      const found = await this.getOrderByClientId(clientOrderId).catch(() => null);
      if (found) {
        // Order existiert bereits → KEIN Duplikat senden (H4).
        return { orderId: found.orderId, clientOrderId };
      }
      // Order nicht auffindbar → genau EIN kontrollierter Retry mit demselben
      // clientOrderId (derselbe JSON-Body, keine Neu-Serialisierung).
      const res = await this.signed("POST", BITUNIX_PATHS.placeOrder, undefined, json, { idempotent: false });
      const data = envelopeData<{ orderId?: string; clientId?: string }>(res.json);
      const orderId = String(data?.orderId ?? "");
      if (!orderId && clientOrderId) {
        const after = await this.getOrderByClientId(clientOrderId).catch(() => null);
        if (after) return { orderId: after.orderId, clientOrderId };
      }
      return { orderId, clientOrderId: data?.clientId ?? clientOrderId };
    }
  }

  /**
   * H4: Query-by-clientOrderId. Fragt die Venue-Order per `clientId` ab
   * (GET get_order_detail?clientId=... — das Venue akzeptiert orderId ODER
   * clientId, Letzteres gewinnt nicht, wir senden nur clientId). Liefert
   * `{ orderId, status }` oder `null`, wenn die Order nicht auffindbar ist
   * (z. B. nach Timeout — dann ist vor einem erneuten Senden zu prüfen, ob
   * die Order doch schon angekommen ist).
   */
  async getOrderByClientId(
    clientOrderId: string
  ): Promise<{ orderId: string; status: string } | null> {
    if (!clientOrderId) return null;
    const res = await this.signed(
      "GET",
      BITUNIX_PATHS.orderDetail,
      { clientId: clientOrderId },
      ""
    );
    const data = envelopeData<BitunixOrderRaw | BitunixOrderRaw[] | null>(res.json);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object" || String(row.orderId ?? "").length === 0) {
      return null;
    }
    return { orderId: String(row.orderId), status: normStatus(row.status) };
  }

  /**
   * H3: Order-Detail abfragen (read-only, idempotent).
   * Liefert `null`, wenn das Venue die Order nicht kennt (z. B. nach
   * Timeout — Status dann UNKNOWN statt erraten).
   */
  async getOrder(orderId: string): Promise<BitunixOrderDetail | null> {
    const res = await this.signed("GET", BITUNIX_PATHS.orderDetail, { orderId }, "");
    const data = envelopeData<BitunixOrderRaw | BitunixOrderRaw[] | null>(res.json);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== "object" || String(row.orderId ?? "").length === 0) {
      return null;
    }
    const qty = Number(row.qty);
    const filledQty = Number(row.tradeQty);
    return {
      orderId: String(row.orderId),
      symbol: String(row.symbol ?? "").toUpperCase(),
      side: sideOf(row.side),
      qty: Number.isFinite(qty) ? qty : 0,
      filledQty: Number.isFinite(filledQty) ? filledQty : 0,
      // Das Venue-Detail kennt keinen avgPrice — der kommt aus getExecutions.
      avgPrice: 0,
      status: normStatus(row.status),
    };
  }

  /**
   * H3: Ausführungen (Trades) abfragen — die ECHTE Fill-Quelle.
   * Optionaler Filter nach Symbol bzw. orderId (über die Venue-Query).
   * Sortiert aufsteigend nach Zeit (für den avgPrice egal, für Caller lesbar).
   */
  async getExecutions(symbol?: string, orderId?: string): Promise<BitunixFill[]> {
    const query: Record<string, string> = {};
    if (symbol) query.symbol = symbol;
    if (orderId) query.orderId = orderId;
    const res = await this.signed(
      "GET",
      BITUNIX_PATHS.historyTrades,
      Object.keys(query).length > 0 ? query : undefined,
      ""
    );
    const data = envelopeData<{ tradeList?: BitunixTradeRaw[] } | BitunixTradeRaw[] | null>(res.json);
    const rows = Array.isArray(data) ? data : data?.tradeList ?? [];
    return rows
      .map((t): BitunixFill | null => {
        const qty = Number(t.qty);
        const price = Number(t.price);
        if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) return null;
        return {
          tradeId: String(t.tradeId ?? ""),
          orderId: String(t.orderId ?? ""),
          symbol: String(t.symbol ?? "").toUpperCase(),
          side: sideOf(t.side),
          qty,
          price,
          fee: Number(t.fee) || 0,
          ts: Number(t.ctime) || 0,
        };
      })
      .filter((f): f is BitunixFill => f !== null)
      .sort((a, b) => a.ts - b.ts);
  }
}
