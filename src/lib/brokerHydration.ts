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
import { and, desc, eq, inArray } from "drizzle-orm";
import { killSwitch } from "./riskGuard";
import { sanitizeSymbol } from "./marketData";
import {
  withAccountLock,
  type HydratePosition,
  type PaperBroker,
  type Tx,
} from "./broker";
import { isKillSwitchDbConfigured } from "./killSwitchDb";
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
function mapOpenRowToHydratePosition(
  r: typeof positions.$inferSelect
): HydratePosition {
  return {
    symbol: r.symbol,
    side: r.side === "SHORT" ? ("SHORT" as const) : ("LONG" as const),
    qty: Number(r.qty),
    entryPrice: Number(r.entryPrice),
    stopLoss:
      r.stopLoss != null && Number.isFinite(Number(r.stopLoss))
        ? Number(r.stopLoss)
        : null,
    takeProfit:
      r.takeProfit != null && Number.isFinite(Number(r.takeProfit))
        ? Number(r.takeProfit)
        : null,
    fundingPaid: r.fundingPaid != null ? Number(r.fundingPaid) : 0,
    trailingStop:
      r.trailingStop != null && Number.isFinite(Number(r.trailingStop))
        ? Number(r.trailingStop)
        : null,
    trailingArmed: r.trailingArmed === true,
  };
}

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

  broker.hydrate(openRows.map(mapOpenRowToHydratePosition), { cashHint });

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

export interface SyncPaperBrokerOptions {
  account?: string;
  /** Bereits gehaltene `withAccountLock`-Transaktion (vermeidet Re-Locking). */
  tx?: Tx;
}

export interface SyncPaperBrokerResult {
  synced: boolean;
  adopted: string[];
  removed: string[];
  updated: string[];
}

async function runSyncPaperBrokerOnRunner(
  broker: PaperBroker,
  runner: Tx | typeof db
): Promise<SyncPaperBrokerResult> {
  const openRows = await runner
    .select()
    .from(positions)
    .where(eq(positions.status, "OPEN"));

  const hydrateRows = openRows.map(mapOpenRowToHydratePosition);

  if (!broker.isHydrated && broker.openPositions === 0) {
    let cashHint: number | undefined;
    try {
      const latestSnap = await runner
        .select({ cash: equitySnapshots.cash })
        .from(equitySnapshots)
        .orderBy(desc(equitySnapshots.ts))
        .limit(1);
      const cashNum = Number(latestSnap[0]?.cash);
      if (latestSnap[0] && Number.isFinite(cashNum) && cashNum >= 0) {
        cashHint = cashNum;
      }
    } catch {
      /* Snapshot-Tabelle optional / leer. */
    }
    broker.hydrate(hydrateRows, { cashHint });
    state.firmHydrated.set(true);
    return {
      synced: true,
      adopted: hydrateRows
        .map((r) => sanitizeSymbol(r.symbol))
        .filter((s): s is string => s !== null),
      removed: [],
      updated: [],
    };
  }

  const openSymbolSet = new Set(
    hydrateRows
      .map((r) => sanitizeSymbol(r.symbol))
      .filter((s): s is string => s !== null)
  );
  const ramSymbols = broker
    .listPositions()
    .map((p) => sanitizeSymbol(p.symbol) ?? p.symbol.toUpperCase());
  const missingSymbols = ramSymbols.filter((sym) => !openSymbolSet.has(sym));

  const closedBySymbol = new Map<
    string,
    { realizedPnl: number; fundingPaid: number }
  >();
  if (missingSymbols.length > 0) {
    const closedRows = await runner
      .select({
        symbol: positions.symbol,
        realizedPnl: positions.realizedPnl,
        fundingPaid: positions.fundingPaid,
      })
      .from(positions)
      .where(
        and(
          eq(positions.status, "CLOSED"),
          inArray(positions.symbol, missingSymbols)
        )
      )
      .orderBy(desc(positions.updatedAt), desc(positions.createdAt), desc(positions.id));

    for (const row of closedRows) {
      const canonical = sanitizeSymbol(row.symbol) ?? row.symbol.toUpperCase();
      if (closedBySymbol.has(canonical)) continue;
      closedBySymbol.set(canonical, {
        realizedPnl: row.realizedPnl != null ? Number(row.realizedPnl) : 0,
        fundingPaid: row.fundingPaid != null ? Number(row.fundingPaid) : 0,
      });
    }
  }

  const diff = broker.reconcileOpenPositions(hydrateRows, closedBySymbol);
  state.firmHydrated.set(true);
  return {
    synced: true,
    ...diff,
  };
}

/**
 * ASA-01: Wiederholbare Re-Hydration / Reconcile des `PaperBroker` gegen die
 * offenen Positionen in PostgreSQL (`positions` mit `status = 'OPEN'`).
 *
 * Geschützt durch `withAccountLock` (bzw. einen bereits gehaltenen `tx`), damit
 * kein konkurrierendes `submitAtomic` oder fremdes Close zwischen DB-Read und
 * lokalem RAM-Abgleich dazwischenfunkt:
 *   - Fremderöffnete Positionen (z. B. aus `micro-executor`) werden in den
 *     lokalen `PaperBroker` übernommen.
 *   - Extern geschlossene Positionen werden lokal entfernt und Cash/Realized-P&L
 *     konsistent nachgezogen.
 *
 * Im reinen Offline-Unit-Test-Modus ohne konfigurierte Datenbank kehrt die
 * Funktion als expliziter No-Op zurück, damit DB-freie Tests unverändert grün
 * bleiben.
 */
export async function syncPaperBrokerWithDb(
  broker: PaperBroker,
  opts?: SyncPaperBrokerOptions
): Promise<SyncPaperBrokerResult> {
  if (opts?.tx) {
    return runSyncPaperBrokerOnRunner(broker, opts.tx);
  }
  if (!isKillSwitchDbConfigured()) {
    return { synced: false, adopted: [], removed: [], updated: [] };
  }
  const hasTxSupport =
    typeof (db as unknown as { transaction?: unknown }).transaction === "function";
  if (!hasTxSupport) {
    return runSyncPaperBrokerOnRunner(broker, db);
  }
  return withAccountLock(opts?.account ?? "PAPER", (tx) =>
    runSyncPaperBrokerOnRunner(broker, tx)
  );
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
