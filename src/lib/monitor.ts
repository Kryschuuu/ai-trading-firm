/**
 * Positions- und Marktdaten-Monitor.
 *
 * Der `tick()` wird vom Scheduler (instrumentation.ts) alle 60 s aufgerufen
 * (oder manuell via POST /api/firm/tick):
 *
 *   1. Kurse der Watchlist + aller offenen Positionen aktualisieren
 *   2. Stop-Loss / Take-Profit jeder offenen Position prüfen → ggf. schließen
 *   3. currentPrice/realizedPnl in der DB nachführen
 *   4. Tagesverlust-Limit prüfen → Auto-Kill für den Rest des Tages
 *   5. Periodisch einen Multi-Market-Scan ins Gedächtnis schreiben
 *
 * Wichtig: Der Monitor läuft AUCH bei gezogenem Kill-Switch weiter — das
 * Schließen von Positionen darf nie blockiert werden.
 */
import { db } from "@/db";
import { agentMessages, positions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getBroker, logAudit } from "./engine";
import { getLimits, killSwitch } from "./riskGuard";
import { DEFAULT_WATCHLIST, getQuote, refreshQuotes, getCandles } from "./marketData";
import { snapshot, snapshotLine } from "./indicators";
import { refreshRuntimeLimits } from "./riskConfigService";
import { realizedPnlToday, writeEquitySnapshot, pruneEquitySnapshots } from "./equity";

const GLOBAL = globalThis as typeof globalThis & {
  __lastTickAt?: number;
  __tickCount?: number;
  __scanCount?: number;
  /** Single-Flight-Schutz: verhindert überlappende Monitor-Zyklen. */
  __tickLock?: Promise<TickResult> | null;
};

const SCAN_EVERY_TICKS = 15; // alle 15 Minuten ein Marktbericht
const PRUNE_EVERY_TICKS = 240; // Retention ~alle 4 Stunden prüfen

export type TickResult = {
  at: string;
  quotesRefreshed: number;
  stopsTriggered: { symbol: string; reason: string; pnl: number }[];
  dailyLossKill: boolean;
  marketScan: boolean;
  errors: string[];
};

/**
 * Ein voller Monitor-Zyklus. Idempotent und gegen Doppelstart geschützt.
 *
 * KORRIGIERT (v1.1.0): Single-Flight-Schutz. Läuft ein Zyklus (Scheduler +
 * manueller POST /tick überlappen z. B.), bekommt der zweite Aufrufer das
 * Ergebnis des laufenden Zyklus, statt einen zweiten parallel zu starten
 * (doppelte Snapshots, konkurrierende DB-Updates).
 */
export function tick(forceScan = false): Promise<TickResult> {
  if (GLOBAL.__tickLock) return GLOBAL.__tickLock;
  const run = doTick(forceScan).finally(() => {
    GLOBAL.__tickLock = null;
  });
  GLOBAL.__tickLock = run;
  return run;
}

async function doTick(forceScan: boolean): Promise<TickResult> {
  await refreshRuntimeLimits();
  const limits = getLimits();
  const broker = await getBroker();
  const errors: string[] = [];
  const stopsTriggered: TickResult["stopsTriggered"] = [];

  // --- 1) Kurse: offene Positionen zuerst, dann Watchlist ---
  const openRows = await db.select().from(positions).where(eq(positions.status, "OPEN"));
  const symbols = [
    ...openRows.map((p) => p.symbol),
    ...DEFAULT_WATCHLIST,
  ];
  const quotes = await refreshQuotes(symbols);
  const priceOf = new Map(quotes.map((q) => [q.symbol, q.price]));

  // --- 2) SL/TP je Position prüfen ---
  for (const row of openRows) {
    const price = priceOf.get(row.symbol.toUpperCase()) ?? Number(row.currentPrice ?? row.entryPrice);
    if (!Number.isFinite(price)) continue;

    const entry = Number(row.entryPrice);
    const long = row.side === "LONG";
    const sl = row.stopLoss != null ? Number(row.stopLoss) : null;
    const tp = row.takeProfit != null ? Number(row.takeProfit) : null;

    const slHit = sl != null && ((long && price <= sl) || (!long && price >= sl));
    const tpHit = tp != null && ((long && price >= tp) || (!long && price <= tp));

    // currentPrice immer fortschreiben
    await db
      .update(positions)
      .set({ currentPrice: String(price), updatedAt: new Date() })
      .where(eq(positions.id, row.id));

    if (!slHit && !tpHit) continue;
    if (slHit && tpHit) {
      // Beide berührt im selben Intervall → konservativ: Stop gilt zuerst.
      errors.push(`${row.symbol}: SL+TP gleichzeitig berührt — Stop hat Vorrang`);
    }

    const reason = slHit ? "STOP_LOSS" : "TAKE_PROFIT";
    const fill = broker.close(row.symbol, reason);
    if (fill) {
      await db
        .update(positions)
        .set({
          status: "CLOSED",
          exitPrice: String(fill.fillPrice),
          realizedPnl: String(fill.realizedPnl),
          exitReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(positions.id, row.id));
      stopsTriggered.push({ symbol: row.symbol, reason, pnl: fill.realizedPnl });
      await logAudit(
        reason === "STOP_LOSS" ? "STOP_LOSS_HIT" : "TAKE_PROFIT_HIT",
        "INFO",
        {
          symbol: row.symbol,
          entry,
          exit: fill.fillPrice,
          qty: row.qty,
          side: row.side,
          realizedPnl: fill.realizedPnl,
          triggerPrice: price,
        },
        row.missionId ?? undefined
      );
      try {
        await writeEquitySnapshot(broker.accountEquity, broker.freeCash, broker.openPositions, "CLOSE");
      } catch {
        /* Kurvenpunkt optional */
      }
    }
  }

  // --- 3) Tagesverlust-Limit: Basis ist der PERSISTENTE Tages-P&L aus der DB ---
  const equity = broker.accountEquity;
  const dayPnlNow = await realizedPnlToday();
  let dailyLossKill = false;
  if (broker.startingEquity > 0) {
    const dayPnlPct = dayPnlNow / broker.startingEquity;
    if (dayPnlPct <= -limits.dailyLossLimitPct && !killSwitch.isArmed()) {
      killSwitch.pull(
        `TAGESVERLUSS ${dayPnlNow.toFixed(2)} (${(dayPnlPct * 100).toFixed(2)}%) ≤ Limit -${(limits.dailyLossLimitPct * 100).toFixed(1)}%`
      );
      dailyLossKill = true;
      await logAudit("KILL_SWITCH", "CRITICAL", {
        reason: "DAILY_LOSS_LIMIT",
        realizedToday: dayPnlNow,
        equity,
        dailyLossLimitPct: limits.dailyLossLimitPct,
      });
    }
  }

  // Snapshot für die Equity-Kurve — bei jedem Tick.
  try {
    await writeEquitySnapshot(equity, broker.freeCash, broker.openPositions, "TICK");
  } catch (e) {
    errors.push(`Snapshot fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
  }

  // --- 4) Multi-Market-Scan ins institutionelle Gedächtnis ---
  GLOBAL.__tickCount = (GLOBAL.__tickCount ?? 0) + 1;
  if (GLOBAL.__tickCount % PRUNE_EVERY_TICKS === 0) {
    try {
      const removed = await pruneEquitySnapshots(90);
      if (removed > 0) console.log(`[monitor] Retention: ${removed} alte Equity-Snapshots gelöscht`);
    } catch (e) {
      errors.push(`Retention fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    }
  }
  const doScan = forceScan || GLOBAL.__tickCount % SCAN_EVERY_TICKS === 1;
  let marketScan = false;
  if (doScan) {
    try {
      const lines: string[] = [];
      for (const s of DEFAULT_WATCHLIST) {
        const candles = await getCandles(s, isCryptoLike(s) ? "15m" : "15m", 120);
        const snap = snapshot(s, candles);
        lines.push(snap ? snapshotLine(snap) : `${s}: keine Daten`);
      }
      await db.insert(agentMessages).values({
        type: "MARKET_SCAN",
        content: `[MARKTSCAN ${new Date().toISOString()}]\n${lines.join("\n")}`,
        meta: { source: "monitor", watchlist: DEFAULT_WATCHLIST },
      });
      marketScan = true;
      GLOBAL.__scanCount = (GLOBAL.__scanCount ?? 0) + 1;
    } catch (e) {
      errors.push(`Marktscan fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    }
  }

  GLOBAL.__lastTickAt = Date.now();
  return {
    at: new Date().toISOString(),
    quotesRefreshed: quotes.length,
    stopsTriggered,
    dailyLossKill,
    marketScan,
    errors,
  };
}

function isCryptoLike(symbol: string): boolean {
  return /^(BTC|ETH|SOL|XRP|BNB|ADA|DOGE|AVAX|LINK|DOT)$/i.test(symbol);
}

/** Letzter Tick-Zeitpunkt fürs Dashboard/Healthcheck. */
export function lastTickAt(): string | null {
  return GLOBAL.__lastTickAt ? new Date(GLOBAL.__lastTickAt).toISOString() : null;
}

/** Einmaliger Kursabgleich für ein Symbol (z. B. vor Orderberechnung). */
export async function ensureQuote(symbol: string): Promise<number | null> {
  try {
    return (await getQuote(symbol)).price;
  } catch {
    return null;
  }
}
