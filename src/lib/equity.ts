/**
 * Equity-Snapshots: Schreiben und Lesen der Kurvenhistorie.
 * Eigenständiges kleines Modul, damit Engine UND Monitor es nutzen können,
 * ohne zirkuläre Imports zu erzeugen.
 */
import { db } from "@/db";
import { equitySnapshots, positions } from "@/db/schema";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { startOfBerlinDay } from "./time";

/** Realisiertes P&L des laufenden Berliner Tages — die persistente Tagesbasis. */
export async function realizedPnlToday(at: Date = new Date()): Promise<number> {
  const rows = await db
    .select({ pnl: positions.realizedPnl })
    .from(positions)
    .where(and(eq(positions.status, "CLOSED"), gte(positions.updatedAt, startOfBerlinDay(at))));
  return Number(rows.reduce((acc, r) => acc + Number(r.pnl ?? 0), 0).toFixed(2));
}

export async function writeEquitySnapshot(
  equity: number,
  cash: number,
  openPositions: number,
  trigger: "TICK" | "TRADE" | "CLOSE" | "FLATTEN" | "BOOT" = "TICK"
): Promise<void> {
  await db.insert(equitySnapshots).values({
    equity: String(equity.toFixed(2)),
    cash: String(cash.toFixed(2)),
    openPositions,
    realizedPnlToday: String(await realizedPnlToday()),
    trigger,
  });
}

export type EquityPoint = { ts: string; equity: number; trigger?: string };

/**
 * Kurvenserie ab `since`, auf maxPoints heruntergesampelt (jeder n-te Punkt),
 * damit der Chart bei Monatsansicht nicht tausende Punkte überträgt.
 */
export async function readEquitySeries(since: Date, maxPoints = 240): Promise<EquityPoint[]> {
  const rows = await db
    .select({
      ts: equitySnapshots.ts,
      equity: equitySnapshots.equity,
      trigger: equitySnapshots.trigger,
    })
    .from(equitySnapshots)
    .where(gte(equitySnapshots.ts, since))
    .orderBy(asc(equitySnapshots.ts));

  if (rows.length <= maxPoints) {
    return rows.map((r) => ({ ts: r.ts.toISOString(), equity: Number(r.equity), trigger: r.trigger }));
  }
  const stride = Math.ceil(rows.length / maxPoints);
  const out: EquityPoint[] = [];
  for (let i = 0; i < rows.length; i += stride) {
    const r = rows[i];
    out.push({ ts: r.ts.toISOString(), equity: Number(r.equity), trigger: r.trigger });
  }
  // Letzten Punkt immer behalten.
  const last = rows[rows.length - 1];
  if (out[out.length - 1].ts !== last.ts.toISOString()) {
    out.push({ ts: last.ts.toISOString(), equity: Number(last.equity), trigger: last.trigger });
  }
  return out;
}

/** Retention: Snapshots älter als `days` Tage löschen (Aufruf aus dem Monitor). */
export async function pruneEquitySnapshots(days = 90): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await db
    .delete(equitySnapshots)
    .where(lt(equitySnapshots.ts, cutoff))
    .returning({ id: equitySnapshots.id });
  return deleted.length;
}
