/**
 * Failover-Kette (Task 03) — Regel 3: kein stiller Kursquellwechsel.
 *
 * Reihenfolge (konfigurierbar, dokumentiert):
 *   Broker-Feed → unabhängiger Feed → Synthetic (NUR wenn explizit erlaubt).
 *
 * Jeder Feed-Wechsel und jede Kurs-Anomalie erzeugt einen Audit-Eintrag
 * (`FEED_FAILOVER` / `ANOMALOUS_SNAPSHOT`), zusätzlich ein In-Memory-Ring
 * (deterministisch testbar, DB-frei). Ein Failover ist IMMER laut — nie still.
 */
import type { MarketInstrument } from "../../universe/types";
import type { MarketFeed, MarketSnapshot } from "./types";
import { AnomalousSnapshotError } from "./types";

/** Ein Audit-Eintrag eines Kursquellenwechsels / verworfenen Kurses. */
export interface FailoverAuditEntry {
  instrumentId: string;
  /** Feed, der ausfiel (null beim ersten Versuch). */
  fromFeed: string | null;
  /** Feed, an den gewechselt wird. */
  toFeed: string;
  reason: string;
  at: string;
}

const G = globalThis as typeof globalThis & {
  __marketFailoverAudit?: FailoverAuditEntry[];
};
const RING_MAX = 200;

/** In-Memory-Ring des Failover-Audits (prozesslokal, DB-frei). */
export const failoverAuditRing: FailoverAuditEntry[] = (G.__marketFailoverAudit ??= []) as FailoverAuditEntry[];

/** Nur für Tests: Ring leeren. */
export function clearFailoverAuditForTests(): void {
  failoverAuditRing.length = 0;
}

/**
 * Protokolliert einen Failover-/Anomalie-Eintrag. In-Memory immer, Datenbank
 * best-effort (Audit-Ausfall darf den Kursfluss nie abbrechen).
 */
export async function recordFailover(entry: Omit<FailoverAuditEntry, "at">): Promise<FailoverAuditEntry> {
  const full: FailoverAuditEntry = { ...entry, at: new Date().toISOString() };
  failoverAuditRing.push(full);
  if (failoverAuditRing.length > RING_MAX) {
    failoverAuditRing.splice(0, failoverAuditRing.length - RING_MAX);
  }
  const event = entry.reason.startsWith("anomaly") ? "ANOMALOUS_SNAPSHOT" : "FEED_FAILOVER";
  try {
    const [{ db }, { auditLog }] = await Promise.all([import("../../db"), import("../../db/schema")]);
    await db.insert(auditLog).values({
      event,
      level: "WARN",
      detail: {
        instrumentId: entry.instrumentId,
        fromFeed: entry.fromFeed,
        toFeed: entry.toFeed,
        reason: entry.reason,
      },
    });
  } catch {
    /* DB nicht bereit — Ring bleibt die Wahrheit. */
  }
  return full;
}

/** Letzten N Failover-Einträge (neueste zuerst). */
export function readFailoverAudit(limit = 50): FailoverAuditEntry[] {
  return [...failoverAuditRing].slice(-limit).reverse();
}

export interface FailoverResult {
  snapshot: MarketSnapshot;
  /** Feed, der den Snapshot letztlich lieferte. */
  activeFeed: string;
  /** true, wenn ein Wechsel gegenüber dem letzten Versuch stattfand. */
  didFailover: boolean;
}

/**
 * Versucht der Reihe nach, einen Snapshot von den Feeds der Kette zu bekommen.
 * Jeder Fehlversuch (Feed-Fehler oder Anomalie) wird auditiert; beim ersten
 * Erfolg wird gestoppt. Scheitert die ganze Kette → Fehler.
 */
export async function failoverGetTicker(
  chain: MarketFeed[],
  instrument: MarketInstrument,
  opts: {
    /** Validiert einen gelieferten Snapshot; wirft bei Anomalie. */
    validate: (snap: MarketSnapshot) => void;
    /** Ausgelöst, sobald ein Feed erfolgreich liefert (aktive Quelle). */
    onActive?: (feedId: string) => void;
    onFailover?: (from: string | null, to: string, reason: string) => void;
  }
): Promise<FailoverResult> {
  let lastError: unknown = new Error("keine Feed in der Kette");
  let failedBefore = false;
  for (const feed of chain) {
    try {
      const snap = await feed.getTicker(instrument);
      opts.validate(snap);
      opts.onActive?.(feed.id);
      return { snapshot: snap, activeFeed: feed.id, didFailover: failedBefore };
    } catch (e) {
      failedBefore = true;
      const reason = e instanceof AnomalousSnapshotError
        ? `anomaly:${e.message}`
        : `feed-error:${e instanceof Error ? e.message : String(e)}`;
      const fromFeed = feed.id;
      // "toFeed" = nächster Feed in der Kette (oder "—" falls Ende).
      const nextFeed = chain[chain.indexOf(feed) + 1]?.id ?? "—";
      await recordFailover({
        instrumentId: instrument.id,
        fromFeed,
        toFeed: nextFeed,
        reason,
      });
      opts.onFailover?.(fromFeed, nextFeed, reason);
      lastError = e;
    }
  }
  throw lastError;
}
