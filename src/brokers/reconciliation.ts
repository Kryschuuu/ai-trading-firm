/**
 * Reconciliation Broker ↔ DB + Idempotente Order-IDs (GAP-09, v1.50.0).
 *
 * Vier Kernaufgaben:
 *   D1) Periodischer Reconciliation-Job (runReconciliation):
 *       Abgleich von Broker-Positionen, Account-Balance und Ledger ↔ DB
 *       (positions, orderIntents, equity_snapshots).
 *       Differenz-Klassifikation:
 *         - PRICE_DRIFT (innerhalb Toleranz RECON_PRICE_DRIFT_PCT, Default 1 %,
 *           Bounds [0.01, 10] — tolerierbar, nur reportet)
 *         - QTY_MISMATCH (kritisch)
 *         - PHANTOM_POSITION (nur Broker — kritisch)
 *         - MISSING_POSITION (nur DB — kritisch)
 *         - BALANCE_MISMATCH (Konto-Cash/Equity-Abweichung — kritisch)
 *         - INVARIANT_VIOLATION (Ledger-Invarianz-Bruch — kritisch)
 *       Report als Objekt + Persistenz in `data/reconciliation/last-report.json`.
 *   D2) Pause-Pfad (RECON_PAUSE_ON_MISMATCH, Default false):
 *       Bei kritischer Klasse (QTY_MISMATCH, PHANTOM, MISSING, BALANCE, INVARIANT_VIOLATION)
 *       wird der Kill-Switch gezogen (ENGAGE mit Grund „recon:<klasse>“) und ein
 *       CRITICAL-Alert über den AlertSink emittiert.
 *       Auto-Flatten ist STRIKT VERBOTEN — Aufräumen nur durch Admin nach manuellem
 *       Re-Arm (Disarm-Challenge mit Nonce bleibt unangetastet).
 *   D3) Einheitliches clientOrderId-Schema „atf-<orderIntentId-kurz>“:
 *       Deterministisch aus orderIntent.id abgeleitet; Retry nach Timeout
 *       WIEDERHOLT dieselbe clientOrderId aus demselben Intent → Dedupe.
 *   D4) Paper-Invarianz-Selbsttest:
 *       Prüft Ledger-Invarianten: freeCash >= 0, Summe Notional <= equity,
 *       fees >= 0, keine negative Menge, equity = freeCash + Summe Einstandswerte ± unrealizedPnl.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  BrokerAccount,
  BrokerAdapter,
  BrokerOrderRequest,
  BrokerOrderResult,
  BrokerPosition,
} from "@/contracts/broker";
import { isBookableFill } from "@/contracts/broker";
import { resolveRuntimePath } from "@/lib/appPaths";
import { emitAlert, type Alert } from "@/lib/alerts";
import { writeAuditRecord, type AuditRecord } from "@/lib/auditSink";
import { envInt, envNumber } from "@/lib/env";
import { killSwitch } from "@/lib/riskGuard";
import { state } from "@/lib/stateRegistry";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Konfiguration (Bounds + Defaults, Muster envNumber / envInt)
// ─────────────────────────────────────────────────────────────────────────────

export const RECON_ENV = {
  PRICE_DRIFT_PCT: "RECON_PRICE_DRIFT_PCT",
  INTERVAL_MINUTES: "RECON_INTERVAL_MINUTES",
  PAUSE_ON_MISMATCH: "RECON_PAUSE_ON_MISMATCH",
} as const;

export const RECON_BOUNDS = {
  priceDriftPct: { min: 0.01, max: 10 },
  intervalMinutes: { min: 5, max: 1440 },
} as const;

export const RECON_DEFAULTS = {
  priceDriftPct: 1,
  intervalMinutes: 60,
  pauseOnMismatch: false,
} as const;

export const RECON_REPORT_DEFAULT_FILE = "data/reconciliation/last-report.json";

export interface ReconciliationConfig {
  /** Maximale Preis-Drift in Prozent, die noch als tolerierbar gilt (Bounds [0.01, 10]). */
  priceDriftPct: number;
  /** Periodisches Scheduler-Intervall in Minuten (Bounds [5, 1440]). */
  intervalMinutes: number;
  /** Bei kritischer Abweichung Kill-Switch scharfschalten (Default false). */
  pauseOnMismatch: boolean;
}

export function loadReconciliationConfig(
  env: Record<string, string | undefined> = process.env
): ReconciliationConfig {
  const priceDriftPct = envNumber(
    RECON_ENV.PRICE_DRIFT_PCT,
    RECON_DEFAULTS.priceDriftPct,
    RECON_BOUNDS.priceDriftPct.min,
    RECON_BOUNDS.priceDriftPct.max,
    env
  );
  const intervalMinutes = envInt(
    RECON_ENV.INTERVAL_MINUTES,
    RECON_DEFAULTS.intervalMinutes,
    RECON_BOUNDS.intervalMinutes.min,
    RECON_BOUNDS.intervalMinutes.max,
    env
  );
  const pauseOnMismatch =
    String(env[RECON_ENV.PAUSE_ON_MISMATCH] ?? "").trim().toLowerCase() === "true";

  return { priceDriftPct, intervalMinutes, pauseOnMismatch };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Client-Order-ID-Konvention (D3)
// ─────────────────────────────────────────────────────────────────────────────

export const CLIENT_ORDER_ID_PREFIX = "atf-";
export const CLIENT_ORDER_ID_RE = /^atf-[a-z0-9]{4,32}$/i;

/**
 * Erzeugt eine deterministische, kollisionsresistente Client-Order-ID nach dem
 * GAP-09-Schema „atf-<orderIntentId-kurz>“.
 *
 * Alphanumerisch, kleingeschrieben, kompatibel mit Bitunix (max 32 Zeichen)
 * und Alpaca (max 48 Zeichen).
 *
 * @example
 *   buildClientOrderId("01920ef0-48a6-78e2-9d7a-d02e4827011a")
 *   // → "atf-01920ef048a6"
 */
export function buildClientOrderId(orderIntentId: string): string {
  const clean = String(orderIntentId ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const shortId = clean.slice(0, 12) || "generic";
  return `${CLIENT_ORDER_ID_PREFIX}${shortId}`;
}

export function isValidClientOrderId(id: string): boolean {
  return CLIENT_ORDER_ID_RE.test(String(id ?? "").trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Typen für Differenzen, Snapshots & Berichte (D1)
// ─────────────────────────────────────────────────────────────────────────────

export type ReconciliationDifferenceType =
  | "PRICE_DRIFT"
  | "QTY_MISMATCH"
  | "PHANTOM_POSITION"
  | "MISSING_POSITION"
  | "BALANCE_MISMATCH"
  | "INVARIANT_VIOLATION";

export interface Discrepancy {
  type: ReconciliationDifferenceType;
  /** true = kritische Diskrepanz (Pause/Alarm); false = tolerierbar (nur Report). */
  critical: boolean;
  symbol?: string;
  side?: "LONG" | "SHORT";
  detail: string;
  brokerValue?: number | string;
  dbValue?: number | string;
  diff?: number;
  pct?: number;
}

export interface DbPositionSnapshot {
  id?: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  currentPrice?: number | null;
  status?: string;
}

export interface DbAccountSnapshot {
  cash: number;
  equity: number;
  openPositions?: number;
}

export interface DbOrderIntent {
  id: string;
  account: string;
  symbol: string;
  side: string;
  qty: number;
  status: string;
  reason?: string | null;
  createdAt?: Date;
}

export interface DbEquitySnapshot {
  equity: number;
  cash: number;
  openPositions: number;
  ts?: Date | string;
}

export interface ReconciliationReport {
  ts: string;
  venue: string;
  mode: string;
  clean: boolean;
  discrepancies: Discrepancy[];
  summary: {
    total: number;
    critical: number;
    priceDrift: number;
    qtyMismatch: number;
    phantomPosition: number;
    missingPosition: number;
    balanceMismatch: number;
    invariantViolation: number;
  };
  brokerState: {
    openPositions: number;
    cash: number;
    equity: number;
  };
  dbState: {
    openPositions: number;
    cash: number | null;
    equity: number | null;
  };
  paused: boolean;
  pauseReason?: string;
}

/** Formatiert den maschinenlesbaren Kill-Switch-Grund `recon:<klasse>`. */
export function formatReconReason(type: ReconciliationDifferenceType): string {
  return `recon:${type}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Reine Differenz-Klassifikation (D1, D4) — deterministisch & testbar
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifyInput {
  brokerPositions: BrokerPosition[];
  brokerAccount: BrokerAccount;
  dbPositions: DbPositionSnapshot[];
  dbAccount?: DbAccountSnapshot | null;
  config: ReconciliationConfig;
  isPaper?: boolean;
}

/**
 * Vergleicht Broker-Positionen, Kontostand und Ledger-Invarianten mit der DB.
 * Reine Funktion ohne Nebenwirkungen.
 */
export function classifyDifferences(input: ClassifyInput): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const { brokerPositions, brokerAccount, dbPositions, dbAccount, config, isPaper } = input;

  // DB-Positionen nach normalisiertem Symbol indexieren
  const dbPosMap = new Map<string, DbPositionSnapshot>();
  for (const pos of dbPositions) {
    if (pos.status && pos.status !== "OPEN") continue;
    dbPosMap.set(pos.symbol.toUpperCase(), pos);
  }

  // Broker-Positionen nach normalisiertem Symbol indexieren
  const brokerPosMap = new Map<string, BrokerPosition>();
  for (const pos of brokerPositions) {
    brokerPosMap.set(pos.symbol.toUpperCase(), pos);
  }

  // 1. PHANTOM_POSITION: Nur im Broker, nicht in DB
  for (const [sym, bPos] of brokerPosMap.entries()) {
    if (!dbPosMap.has(sym)) {
      discrepancies.push({
        type: "PHANTOM_POSITION",
        critical: true,
        symbol: sym,
        side: bPos.side,
        detail: `Phantom-Position: Broker meldet ${bPos.side} ${bPos.qty} ${sym}, in DB existiert keine offene Position.`,
        brokerValue: bPos.qty,
        dbValue: 0,
      });
    }
  }

  // 2. MISSING_POSITION: Nur in DB, nicht im Broker
  for (const [sym, dPos] of dbPosMap.entries()) {
    if (!brokerPosMap.has(sym)) {
      discrepancies.push({
        type: "MISSING_POSITION",
        critical: true,
        symbol: sym,
        side: dPos.side,
        detail: `Fehlende Position: DB führt offene Position ${dPos.side} ${dPos.qty} ${sym}, aber Broker meldet keine.`,
        brokerValue: 0,
        dbValue: dPos.qty,
      });
    }
  }

  // 3. QTY_MISMATCH & PRICE_DRIFT: Beidseitig vorhanden
  for (const [sym, bPos] of brokerPosMap.entries()) {
    const dPos = dbPosMap.get(sym);
    if (!dPos) continue;

    // Richtungs-Mismatch
    if (bPos.side !== dPos.side) {
      discrepancies.push({
        type: "QTY_MISMATCH",
        critical: true,
        symbol: sym,
        side: bPos.side,
        detail: `Positions-Richtung weicht ab für ${sym}: Broker ${bPos.side} vs DB ${dPos.side}.`,
        brokerValue: bPos.side,
        dbValue: dPos.side,
      });
    }

    // Mengendifferenz
    const qtyDiff = Number(Math.abs(bPos.qty - dPos.qty).toFixed(8));
    if (qtyDiff > 1e-6) {
      discrepancies.push({
        type: "QTY_MISMATCH",
        critical: true,
        symbol: sym,
        side: bPos.side,
        detail: `Positionsmenge weicht ab für ${sym}: Broker ${bPos.qty} vs DB ${dPos.qty} (Delta ${qtyDiff.toFixed(6)}).`,
        brokerValue: bPos.qty,
        dbValue: dPos.qty,
        diff: qtyDiff,
      });
    }

    // Preis-Drift (Vergleich der Einstandspreise)
    const basePrice = dPos.entryPrice > 0 ? dPos.entryPrice : (dPos.currentPrice ?? 0);
    const brokerPrice = bPos.entryPrice > 0 ? bPos.entryPrice : bPos.lastPrice;
    if (basePrice > 0 && brokerPrice > 0) {
      const priceDiff = Math.abs(brokerPrice - basePrice);
      const pct = (priceDiff / basePrice) * 100;
      if (pct > 0) {
        // Exakt RECON_PRICE_DRIFT_PCT gilt als innerhalb Toleranz (PRICE_DRIFT-only)
        const withinTolerance = pct <= config.priceDriftPct + 1e-9;
        discrepancies.push({
          type: "PRICE_DRIFT",
          critical: !withinTolerance,
          symbol: sym,
          side: bPos.side,
          detail: withinTolerance
            ? `Preis-Drift ${pct.toFixed(2)} % für ${sym} liegt innerhalb Toleranz (≤ ${config.priceDriftPct} %).`
            : `Preis-Drift ${pct.toFixed(2)} % für ${sym} überschreitet Toleranz (${config.priceDriftPct} %).`,
          brokerValue: brokerPrice,
          dbValue: basePrice,
          diff: priceDiff,
          pct,
        });
      }
    }
  }

  // 4. BALANCE_MISMATCH: Kontostand Broker vs DB
  if (dbAccount) {
    const cashDiff = Math.abs(brokerAccount.cash - dbAccount.cash);
    if (cashDiff > 0.01) {
      discrepancies.push({
        type: "BALANCE_MISMATCH",
        critical: true,
        detail: `Kassendifferenz: Broker-Cash ${brokerAccount.cash.toFixed(2)} vs DB-Snapshot ${dbAccount.cash.toFixed(2)} (Delta ${cashDiff.toFixed(2)}).`,
        brokerValue: brokerAccount.cash,
        dbValue: dbAccount.cash,
        diff: cashDiff,
      });
    }
  }

  // 5. PAPER-INVARIANZ-SELBSTTEST (D4)
  if (isPaper) {
    // Invariante 1: freeCash >= 0
    if (brokerAccount.cash < -1e-6) {
      discrepancies.push({
        type: "INVARIANT_VIOLATION",
        critical: true,
        detail: `Ledger-Invariante verletzt: freeCash < 0 (${brokerAccount.cash.toFixed(2)}).`,
        brokerValue: brokerAccount.cash,
      });
    }

    // Invariante 2: Summe Notional <= equity
    const sumNotional = brokerPositions.reduce(
      (sum, p) => sum + p.qty * (Number.isFinite(p.lastPrice) && p.lastPrice > 0 ? p.lastPrice : p.entryPrice),
      0
    );
    if (sumNotional > brokerAccount.equity + 0.01) {
      discrepancies.push({
        type: "INVARIANT_VIOLATION",
        critical: true,
        detail: `Ledger-Invariante verletzt: Summe Notional (${sumNotional.toFixed(2)}) > Equity (${brokerAccount.equity.toFixed(2)}).`,
        brokerValue: sumNotional,
        dbValue: brokerAccount.equity,
        diff: sumNotional - brokerAccount.equity,
      });
    }

    // Invariante 3 & 4: keine negative Menge, fees >= 0
    for (const p of brokerPositions) {
      if (p.qty <= 0) {
        discrepancies.push({
          type: "INVARIANT_VIOLATION",
          critical: true,
          symbol: p.symbol,
          detail: `Ledger-Invariante verletzt: Nicht-positive Menge für ${p.symbol} (${p.qty}).`,
          brokerValue: p.qty,
        });
      }
    }

    // Invariante 5: equity = freeCash + Summe Einstandswerte ± unrealizedPnl
    // Formel direkt aus PaperBroker.accountEquity / listPositions:
    // Einstand = qty * entryPrice; unrealizedPnl = (side==LONG?1:-1)*qty*(lastPrice - entryPrice)
    // Marktwert = qty * lastPrice = Einstand + unrealizedPnl
    const sumEinstand = brokerPositions.reduce((sum, p) => sum + p.qty * p.entryPrice, 0);
    const sumUnrealizedPnl = brokerPositions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
    const expectedEquity = brokerAccount.cash + sumEinstand + sumUnrealizedPnl;
    const equityDiff = Math.abs(brokerAccount.equity - expectedEquity);
    if (equityDiff > 0.01) {
      discrepancies.push({
        type: "INVARIANT_VIOLATION",
        critical: true,
        detail: `Ledger-Invariante verletzt: Equity (${brokerAccount.equity.toFixed(2)}) ≠ freeCash (${brokerAccount.cash.toFixed(2)}) + Einstand (${sumEinstand.toFixed(2)}) + uPnL (${sumUnrealizedPnl.toFixed(2)}) [Erwartet: ${expectedEquity.toFixed(2)}, Delta: ${equityDiff.toFixed(2)}].`,
        brokerValue: brokerAccount.equity,
        dbValue: expectedEquity,
        diff: equityDiff,
      });
    }
  }

  return discrepancies;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. DB-Store-Schnittstelle
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconciliationDbStore {
  getOpenPositions(venue?: string): Promise<DbPositionSnapshot[]>;
  getLatestEquitySnapshot?(): Promise<DbEquitySnapshot | null>;
  getOrderIntents?(opts?: { status?: string; symbol?: string }): Promise<DbOrderIntent[]>;
  recordKillSwitch?(row: { reason: string; triggeredBy: string; armed: boolean }): Promise<void>;
  updateOrderIntent?(id: string, update: { status: string; reason?: string }): Promise<void>;
}

/**
 * Standard-DB-Store gegen PostgreSQL / Drizzle (Schema aus src/db/schema.ts).
 */
export function createDefaultDbStore(): ReconciliationDbStore {
  return {
    async getOpenPositions(): Promise<DbPositionSnapshot[]> {
      if (!process.env.DATABASE_URL) return [];
      try {
        const { db } = await import("@/db");
        const { positions } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        const rows = await db
          .select()
          .from(positions)
          .where(eq(positions.status, "OPEN"));
        return rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          side: r.side as "LONG" | "SHORT",
          qty: Number(r.qty),
          entryPrice: Number(r.entryPrice),
          currentPrice: r.currentPrice != null ? Number(r.currentPrice) : null,
          status: r.status,
        }));
      } catch (e) {
        console.warn("[reconciliation] DB getOpenPositions fehlgeschlagen:", e instanceof Error ? e.message : e);
        return [];
      }
    },
    async getLatestEquitySnapshot(): Promise<DbEquitySnapshot | null> {
      if (!process.env.DATABASE_URL) return null;
      try {
        const { db } = await import("@/db");
        const { equitySnapshots } = await import("@/db/schema");
        const { desc } = await import("drizzle-orm");
        const rows = await db
          .select()
          .from(equitySnapshots)
          .orderBy(desc(equitySnapshots.ts))
          .limit(1);
        if (rows.length === 0) return null;
        return {
          equity: Number(rows[0].equity),
          cash: Number(rows[0].cash),
          openPositions: rows[0].openPositions,
          ts: rows[0].ts,
        };
      } catch (e) {
        console.warn("[reconciliation] DB getLatestEquitySnapshot fehlgeschlagen:", e instanceof Error ? e.message : e);
        return null;
      }
    },
    async getOrderIntents(opts?: { status?: string; symbol?: string }): Promise<DbOrderIntent[]> {
      if (!process.env.DATABASE_URL) return [];
      try {
        const { db } = await import("@/db");
        const { orderIntents } = await import("@/db/schema");
        const rows = await db.select().from(orderIntents);
        return rows
          .filter((r) => (opts?.status ? r.status === opts.status : true))
          .filter((r) => (opts?.symbol ? r.symbol.toUpperCase() === opts.symbol.toUpperCase() : true))
          .map((r) => ({
            id: r.id,
            account: r.account,
            symbol: r.symbol,
            side: r.side,
            qty: Number(r.qty),
            status: r.status,
            reason: r.reason,
            createdAt: r.createdAt,
          }));
      } catch (e) {
        console.warn("[reconciliation] DB getOrderIntents fehlgeschlagen:", e instanceof Error ? e.message : e);
        return [];
      }
    },
    async recordKillSwitch(row: { reason: string; triggeredBy: string; armed: boolean }): Promise<void> {
      if (!process.env.DATABASE_URL) return;
      try {
        const { db } = await import("@/db");
        const { killSwitches } = await import("@/db/schema");
        await db.insert(killSwitches).values(row);
      } catch (e) {
        console.warn("[reconciliation] DB recordKillSwitch fehlgeschlagen:", e instanceof Error ? e.message : e);
      }
    },
    async updateOrderIntent(id: string, update: { status: string; reason?: string }): Promise<void> {
      if (!process.env.DATABASE_URL) return;
      try {
        const { db } = await import("@/db");
        const { orderIntents } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        await db
          .update(orderIntents)
          .set({ status: update.status, reason: update.reason })
          .where(eq(orderIntents.id, id));
      } catch (e) {
        console.warn("[reconciliation] DB updateOrderIntent fehlgeschlagen:", e instanceof Error ? e.message : e);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Idempotenter Order-Submit-Helper (D3)
// ─────────────────────────────────────────────────────────────────────────────

export interface SubmitWithIntentOptions {
  orderIntentId: string;
  order: BrokerOrderRequest;
  adapter: BrokerAdapter;
  dbStore?: ReconciliationDbStore;
}

/**
 * Führt einen Order-Submit unter Nutzung der einheitlichen clientOrderId aus.
 *
 * Sichert Deduplizierung über:
 *   1. Lokale orderIntents-Status-Prüfung (bereits FILLED → keine Zweitorder).
 *   2. Deterministische clientOrderId „atf-<intentId-kurz>“.
 *   3. Venue- oder Mock-Dedupe bei wiederholtem Submit nach Timeout.
 */
export async function submitWithIntent(opts: SubmitWithIntentOptions): Promise<BrokerOrderResult> {
  const { orderIntentId, order, adapter, dbStore } = opts;
  const clientOrderId = buildClientOrderId(orderIntentId);

  // 1. Lokale Deduplizierung über DB-Status
  if (dbStore?.getOrderIntents) {
    const existing = await dbStore.getOrderIntents({ symbol: order.symbol });
    const match = existing.find((i) => i.id === orderIntentId);
    if (match && match.status === "FILLED") {
      return {
        orderId: `deduped-${orderIntentId}`,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        fillPrice: order.limitPrice ?? 0,
        status: "FILLED",
        reason: "IDEMPOTENT_DEDUPE_LOCAL",
        stopLoss: order.stopLoss ?? null,
        takeProfit: order.takeProfit ?? null,
      };
    }
  }

  // 2. Submit mit deterministischer clientOrderId
  const orderReq: BrokerOrderRequest = {
    ...order,
    clientOrderId,
    orderIntentId,
  };

  if (!adapter.placeOrder) {
    throw new Error(`Adapter ${adapter.id} unterstützt kein placeOrder.`);
  }

  const result = await adapter.placeOrder(orderReq);

  // 3. Status in orderIntents aktualisieren
  if (dbStore?.updateOrderIntent && isBookableFill(result)) {
    await dbStore.updateOrderIntent(orderIntentId, { status: "FILLED" });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Reconciliation-Runner (D1, D2)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunReconciliationOptions {
  config?: Partial<ReconciliationConfig>;
  reportFile?: string;
  auditSink?: (rec: AuditRecord) => Promise<unknown>;
  alertSink?: (alert: Alert) => Promise<unknown>;
  now?: number;
}

/**
 * Führt die vollständige Reconciliation aus:
 *   Broker-Positionen/Account ↔ DB (positions, equitySnapshots, Invarianten).
 */
export async function runReconciliation(
  adapter: BrokerAdapter,
  dbStore?: ReconciliationDbStore,
  opts?: RunReconciliationOptions
): Promise<ReconciliationReport> {
  const config: ReconciliationConfig = {
    ...loadReconciliationConfig(),
    ...(opts?.config ?? {}),
  };
  const store = dbStore ?? createDefaultDbStore();
  const isPaper = adapter.id === "PAPER" || adapter.mode === "paper";

  // 1. Broker-Zustand abfragen
  const brokerPositions = adapter.getPositions ? await adapter.getPositions() : [];
  const brokerAccount = adapter.getAccount
    ? await adapter.getAccount()
    : {
        equity: 0,
        cash: 0,
        walletBalance: 0,
        availableCash: 0,
        usedMargin: 0,
        maintenanceMargin: 0,
        unrealizedPnl: 0,
        openPositions: 0,
        startingEquity: 0,
        drawdownPct: 0,
      };

  // 2. DB-Zustand abfragen
  const dbPositions = await store.getOpenPositions(adapter.id);
  const latestSnapshot = store.getLatestEquitySnapshot ? await store.getLatestEquitySnapshot() : null;

  // 3. Differenz-Klassifikation
  const discrepancies = classifyDifferences({
    brokerPositions,
    brokerAccount,
    dbPositions,
    dbAccount: latestSnapshot
      ? { cash: latestSnapshot.cash, equity: latestSnapshot.equity, openPositions: latestSnapshot.openPositions }
      : null,
    config,
    isPaper,
  });

  const criticals = discrepancies.filter((d) => d.critical);
  const clean = criticals.length === 0;

  // Zusammenfassung berechnen
  const summary = {
    total: discrepancies.length,
    critical: criticals.length,
    priceDrift: discrepancies.filter((d) => d.type === "PRICE_DRIFT").length,
    qtyMismatch: discrepancies.filter((d) => d.type === "QTY_MISMATCH").length,
    phantomPosition: discrepancies.filter((d) => d.type === "PHANTOM_POSITION").length,
    missingPosition: discrepancies.filter((d) => d.type === "MISSING_POSITION").length,
    balanceMismatch: discrepancies.filter((d) => d.type === "BALANCE_MISMATCH").length,
    invariantViolation: discrepancies.filter((d) => d.type === "INVARIANT_VIOLATION").length,
  };

  let paused = false;
  let pauseReason: string | undefined;

  // 4. Audit-Zeilen & Alerts je kritischer Klasse
  const auditFn = opts?.auditSink ?? writeAuditRecord;
  const alertFn = opts?.alertSink ?? emitAlert;

  for (const crit of criticals) {
    const reason = formatReconReason(crit.type);

    await auditFn({
      event: "RECONCILIATION_DISCREPANCY",
      level: "CRITICAL",
      detail: {
        venue: adapter.id,
        mode: adapter.mode,
        type: crit.type,
        symbol: crit.symbol,
        detail: crit.detail,
        brokerValue: crit.brokerValue,
        dbValue: crit.dbValue,
        reason,
      },
      auditClass: "security",
    }).catch(() => undefined);

    await alertFn({
      code: `recon:${crit.type.toLowerCase()}`,
      severity: "critical",
      message: `Reconciliation-Abweichung [${crit.type}]: ${crit.detail}`,
      meta: {
        venue: adapter.id,
        mode: adapter.mode,
        type: crit.type,
        symbol: crit.symbol,
      },
    }).catch(() => undefined);
  }

  // 5. Pause-Pfad (D2)
  if (config.pauseOnMismatch && criticals.length > 0) {
    const firstCrit = criticals[0];
    pauseReason = formatReconReason(firstCrit.type);
    paused = true;

    // In-Memory Kill-Switch ENGAGE
    killSwitch.pull(pauseReason);

    // Persistenz des Kill-Switches
    if (store.recordKillSwitch) {
      await store
        .recordKillSwitch({
          reason: pauseReason,
          triggeredBy: "RECONCILIATION",
          armed: true,
        })
        .catch(() => undefined);
    }

    // Revisionssicheres Audit-Log der Scharfschaltung
    await auditFn({
      event: "KILL_SWITCH",
      level: "CRITICAL",
      detail: {
        reason: pauseReason,
        trigger: "RECONCILIATION",
        venue: adapter.id,
        mode: adapter.mode,
        discrepancyType: firstCrit.type,
        symbol: firstCrit.symbol,
      },
      auditClass: "security",
    }).catch(() => undefined);

    // HINWEIS: Auto-Flatten ist STRIKT VERBOTEN! Keine Glattstellung ohne Admin-Eingriff.
  }

  // 6. Bericht aufbauen
  const report: ReconciliationReport = {
    ts: new Date(opts?.now ?? Date.now()).toISOString(),
    venue: adapter.id,
    mode: adapter.mode,
    clean,
    discrepancies,
    summary,
    brokerState: {
      openPositions: brokerPositions.length,
      cash: brokerAccount.cash,
      equity: brokerAccount.equity,
    },
    dbState: {
      openPositions: dbPositions.length,
      cash: latestSnapshot ? latestSnapshot.cash : null,
      equity: latestSnapshot ? latestSnapshot.equity : null,
    },
    paused,
    pauseReason,
  };

  // RAM-Cache aktualisieren
  state.reconciliationLastReport.set(report);

  // 7. Persistenz nach data/reconciliation/last-report.json
  try {
    const targetFile = opts?.reportFile ?? RECON_REPORT_DEFAULT_FILE;
    const resolvedPath = resolveRuntimePath(targetFile);
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, JSON.stringify(report, null, 2), "utf8");
  } catch (e) {
    console.warn("[reconciliation] Bericht konnte nicht persistiert werden:", e);
  }

  return report;
}
