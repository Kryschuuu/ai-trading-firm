/**
 * Firmenzustand für die Metrik-Exposition (GAP-10, D1, v1.45.0) — **server-only**.
 *
 * ── Warum eine eigene Datei? ────────────────────────────────────────────────
 * `src/lib/telemetry.ts` liegt im Import-Graph von **Client-Komponenten**
 * (`marketData.ts` → `workshop.ts` → `HitRatePanel.tsx` → `FirmDashboard.tsx`).
 * Zugriffe auf `@/db` (pg) von dort brechen den Produktions-Build mit
 * „Module not found: Can't resolve 'tls'“ — der Browser hat keine
 * Node-Builtins. Deshalb gilt: `telemetry.ts` bleibt DB-frei, und der
 * DB-/Ledger-Zugriff lebt hier, in einem Modul, das ausschließlich
 * Server-Code importiert.
 *
 * ── Was hier passiert ───────────────────────────────────────────────────────
 * `collectFirmMetricState()` liest den Zustand aus BESTEHENDEN Stores:
 *
 *   1. Paper-Ledger (`state.paperBrokerLedger`) — dieselbe Quelle, die der
 *      Monitor-Tick für Equity/Drawdown nutzt (keine zweite Rechnung).
 *   2. Fallback: jüngster `equity_snapshots`-Eintrag (DB), wenn der Ledger in
 *      diesem Prozess noch nicht existiert (z. B. reiner CLI-Prozess).
 *
 * Es wird KEINE neue Messlogik erfunden und nichts geschrieben. Wirft die
 * Funktion, degradiert `prometheusMetrics()` (Metrik weglassen + HELP-Grund),
 * statt den Aufrufer zu treffen.
 *
 * Der Import dieses Moduls registriert sich selbst als Leser
 * (`setFirmMetricStateReader`) — dadurch liefert ein `prometheusMetrics()`
 * ohne Argument in jedem Prozess, der dieses Server-Modul kennt, die
 * vollständigen Firmen-Metriken; ohne es nutzt die Exposition den
 * prozesslokalen Ledger und degradiert sonst sauber.
 */
import { desc } from "drizzle-orm";

import { db } from "@/db";
import { equitySnapshots } from "@/db/schema";
import { realizedPnlToday as readRealizedToday } from "./equity";
import { state } from "./stateRegistry";
import { setFirmMetricStateReader, type FirmMetricState } from "./telemetry";

/**
 * Liest den Firmenzustand aus bestehenden Stores (Ledger → DB-Snapshot).
 *
 * `realizedPnlToday` ist optional: ein Fehler dort lässt die übrigen Werte
 * bestehen (die Metrik wird dann einzeln als `degraded` markiert). Fehlen
 * BEIDE Quellen, wirft die Funktion — der Aufrufer degradiert.
 */
export async function collectFirmMetricState(): Promise<FirmMetricState> {
  let realizedPnlToday: number | null = null;
  try {
    const value = await readRealizedToday();
    realizedPnlToday = Number.isFinite(value) ? value : null;
  } catch {
    realizedPnlToday = null; // optional — restliche Metriken bleiben lesbar.
  }

  const broker = state.paperBrokerLedger.get();
  if (broker) {
    return {
      equity: broker.accountEquity,
      startingEquity: broker.startingEquity,
      drawdownPct: broker.drawdownPct,
      openPositions: broker.openPositions,
      realizedPnlToday,
      source: "paper-broker",
    };
  }

  // Fallback: persistierter Snapshot. Der Ledger wird von `createBroker()`
  // erzeugt; Prozesse ohne Broker (reine CLI/Skripte) haben keinen.
  const rows = await db
    .select({
      equity: equitySnapshots.equity,
      openPositions: equitySnapshots.openPositions,
    })
    .from(equitySnapshots)
    .orderBy(desc(equitySnapshots.ts))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error("kein Firmenzustand lesbar (kein Ledger, kein Snapshot)");
  const equity = Number(row.equity);
  if (!Number.isFinite(equity)) throw new Error("Equity-Snapshot ungültig");
  const startingEquity = readStartingEquity();
  return {
    equity,
    startingEquity,
    drawdownPct:
      startingEquity > 0 ? Math.max(0, (startingEquity - equity) / startingEquity) : 0,
    openPositions: Number(row.openPositions ?? 0),
    realizedPnlToday,
    source: "db-snapshot",
  };
}

/** Startkapital wie im Paper-Ledger-Default (`STARTING_EQUITY`, Default 10000). */
function readStartingEquity(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.STARTING_EQUITY);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/** Registriert den Leser bei `telemetry.ts` (idempotent, nur Server-Code). */
export function registerFirmMetricState(): void {
  setFirmMetricStateReader(collectFirmMetricState);
}

registerFirmMetricState();
