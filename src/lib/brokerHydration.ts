/**
 * Broker-Hydration — prozessübergreifender Restore des PAPER-Ledgers aus der
 * Datenbank (ADR-003/ADR-004, v0.17.0).
 *
 * Dieser Pfad ist bewusst ABHÄNGIGKEITSFREI von LLMs, Analysts und Engine:
 *   - `db` + `positions`, `equity_snapshots`, `kill_switches`
 *   - `killSwitch` (In-Memory-Latch)
 *   - `PaperBroker`-Typ
 *   - `state`-Registry (Single-Flight-Flags `firmHydrated`/`firmHydration`/…)
 *
 * Damit kann er sowohl von der Next.js-Web-App (`engine.ts`) als auch vom
 * eigenständigen Mikro-Executor-Prozess (`scripts/micro-executor.ts`)
 * verwendet werden, ohne einen der beiden mit Modell-Code zu kontaminieren.
 *
 * Vor v0.17.0 lebte dieselbe Logik als file-lokale Funktion in `engine.ts`.
 * Der Mikro-Executor hatte sie KOPIERT (mit eigenem `new PaperBroker(…)` und
 * eigenem Advisory-Lock) — eine Verletzung von ADR-003 und die Ursache für
 * H2 (Race Conditions zwischen Next.js-Workern und Mikro-Executor). Beide
 * Prozesse nutzen jetzt:
 *   1. `paperBrokerLedger()` (Singleton-Ledger aus `src/brokers/factory.ts`)
 *   2. `ensurePaperBrokerHydrated(broker)` (dieses Modul, Single-Flight)
 *   3. `broker.submitAtomic()` für JEDE Order (Kontosperre + DB-Wahrheit)
 */

import { db } from "@/db";
import { positions, equitySnapshots, killSwitches } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { killSwitch } from "./riskGuard";
import type { PaperBroker } from "./broker";
import { state } from "./stateRegistry";

/**
 * Backoff-Fenster nach einem fehlgeschlagenen Restore in ms (10 s). Ein
 * fehlgeschlagener Restore-Versuch deckelt nachfolgende Versuche, damit
 * eine kaputte/unerreichbare DB nicht auf jedem HTTP-Request/Tick neu
 * abgefragt wird.
 */
export const FIRM_HYDRATION_RETRY_MS = 10_000;

/**
 * Liest den persistenten Firmenzustand und überträgt ihn auf den Ledger
 * (reine Funktion, kein Single-Flight — wird von `ensurePaperBrokerHydrated`
 * eingepackt). Wirft bei DB-/Schema-Fehlern weiter; die Aufruferseite
 * (`ensurePaperBrokerHydrated`) entscheidet über Wiederholung/Rückmeldung.
 *
 * Hydriert:
 *   - offene Positionen (`positions` mit status='OPEN') inkl. SL/TP, Funding
 *     und Trailing-Stop-Zustand
 *   - Cash aus dem letzten Equity-Snapshot (`equity_snapshots`)
 *   - Kill-Switch-Zustand aus der letzten `kill_switches`-Zeile
 */
export async function restorePaperBrokerState(broker: PaperBroker): Promise<void> {
  const openRows = await db
    .select()
    .from(positions)
    .where(eq(positions.status, "OPEN"));

  // Cash aus dem letzten persistenten Snapshot (realisierte P&L bleibt
  // über Neustarts erhalten); fehlt der Snapshot → Fallback im hydrate().
  let cashHint: number | undefined;
  try {
    const latestSnap = await db
      .select({ cash: equitySnapshots.cash })
      .from(equitySnapshots)
      .orderBy(desc(equitySnapshots.ts))
      .limit(1);
    const cashNum = Number(latestSnap[0]?.cash);
    if (latestSnap[0] && Number.isFinite(cashNum) && cashNum >= 0) cashHint = cashNum;
  } catch {
    /* Tabelle fehlt/leer → Fallback im hydrate() ist konservativ. */
  }

  broker.hydrate(
    openRows.map((r) => ({
      symbol: r.symbol,
      side: r.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const),
      qty: Number(r.qty),
      entryPrice: Number(r.entryPrice),
      stopLoss: r.stopLoss != null && Number.isFinite(Number(r.stopLoss))
        ? Number(r.stopLoss)
        : null,
      takeProfit: r.takeProfit != null && Number.isFinite(Number(r.takeProfit))
        ? Number(r.takeProfit)
        : null,
      fundingPaid: r.fundingPaid != null ? Number(r.fundingPaid) : 0,
      trailingStop: r.trailingStop != null && Number.isFinite(Number(r.trailingStop))
        ? Number(r.trailingStop)
        : null,
      trailingArmed: r.trailingArmed === true,
    })),
    { cashHint }
  );

  const lastKill = await db
    .select()
    .from(killSwitches)
    .orderBy(desc(killSwitches.createdAt))
    .limit(1);
  if (lastKill[0]?.armed) killSwitch.pull(`restored:${lastKill[0].reason}`);
  else killSwitch.disarm();
}

/**
 * Single-Flight-Hydration mit Backoff (RESTORE-01, wie im Engine-Code
 * dokumentiert):
 *   - Parallele Aufrufer hängen sich an dieselbe laufende Wiederherstellung
 *     (keine N konkurrierenden Reads auf Positionen/Equity/Kill-Switch).
 *   - Nach einem Fehlschlag wird `FIRM_HYDRATION_RETRY_MS` lang pausiert.
 *   - Warn-Logs werden einmal pro Fenster gedämpft (kein Log-Amplifier).
 *   - Lehnt bewusst nie ab: ein fehlgeschlagener Restore darf den
 *     auslösenden Request/Tick nicht in einen zweiten Fehler schicken.
 *
 * Idempotent: Ist der Ledger bereits hydriert (`state.firmHydrated`),
 * kehrt die Funktion sofort zurück.
 */
export function ensurePaperBrokerHydrated(broker: PaperBroker): Promise<void> {
  const inFlight = state.firmHydration.get();
  if (inFlight) return inFlight;
  if (state.firmHydrated.get()) return Promise.resolve();

  const now = Date.now();
  const retryAt = state.firmHydrateRetryAt.get();
  if (retryAt !== undefined) {
    // Clock-Skew-Schutz: ein zurückspringender Takt darf das Backoff-Fenster
    // nicht verlängern.
    if (retryAt - now > FIRM_HYDRATION_RETRY_MS) state.firmHydrateRetryAt.reset();
    else if (now < retryAt) return Promise.resolve();
  }

  const attempt: Promise<void> = (async () => {
    try {
      await restorePaperBrokerState(broker);
      state.firmHydrated.set(true);
      state.firmHydrateRetryAt.reset();
      state.firmHydrateWarned.reset();
    } catch (e) {
      state.firmHydrated.set(false);
      state.firmHydrateRetryAt.set(Date.now() + FIRM_HYDRATION_RETRY_MS);
      reportRestoreFailureOnce(e);
    }
  })();

  state.firmHydration.set(attempt);
  void attempt.finally(() => state.firmHydration.reset());
  return attempt;
}

/** Markiert den Ledger als ungültig (z. B. nach einem Close-All oder Kill). */
export function invalidatePaperBrokerHydration(): void {
  state.firmHydrated.set(false);
  state.firmHydrateRetryAt.reset();
  state.firmHydrateWarned.reset();
}

function reportRestoreFailureOnce(e: unknown): void {
  if (state.firmHydrateWarned.get()) return;
  state.firmHydrateWarned.set(true);
  // Einfaches console.warn statt structuredLog, um zirkuläre Importe zu
  // vermeiden (dieses Modul ist bewusst schlank).
  console.warn(
    "[broker-hydration] Restore des PAPER-Ledgers fehlgeschlagen " +
      "(wird in 10 s wiederholt, Broker läuft im Leerzustand weiter):",
    e instanceof Error ? e.message : e
  );
}
