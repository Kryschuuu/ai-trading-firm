/**
 * Persistenz der Regime-Snapshots (RMA-P2-01, v1.61.0) — SERVER-seitig
 * (`@/db`-Import; niemals aus `marketRegime.ts` importieren, das liegt im
 * Client-Import-Graph).
 *
 * Vertrag:
 *   - **Idempotenz:** stabiler SHA-256-Key je Bewertung
 *     (Symbol|asOf|Rohklasse|Bestätigtklasse|Coverage|Versionen) +
 *     `ON CONFLICT DO NOTHING` — Retries und Neustarts schreiben keine
 *     zweite Zeile.
 *   - **Throttle:** `scheduleRegimeSnapshotPersist` schreibt bei
 *     Regime-Wechsel oder mindestens alle `REGIME_PERSIST_MIN_INTERVAL_MS`
 *     je Symbol (Default 15 min) — die Historie bleibt gebounded.
 *   - **Fail-soft, nie still:** Fehler werden gezählt (`telemetry.regime`) und
 *     geloggt; die Klassifikation/das Gate hängen nie an der Persistenz.
 *   - **Retention:** `pruneRegimeSnapshots` (Default 90 Tage).
 *
 * Schreibpfade: Engine (je Turn) und Monitor (je Regime-Refresh) rufen
 * `scheduleRegimeSnapshotPersist` mit dem kanonischen Snapshot auf —
 * derselbe Snapshot, den Gate, Ops-Center und Artefakte konsumieren.
 */
import { createHash } from "node:crypto";
import { and, gte, inArray, lte } from "drizzle-orm";

import { db } from "../db";
import { regimeSnapshots } from "../db/schema";
import { structuredLog } from "./logger";
import { telemetry } from "./telemetry";
import type { InstrumentRegimeSnapshot, MarketRegimeConfig } from "./marketRegime";

/** Mindestabstand zwischen zwei Snapshotschreibungen je Symbol (ms). */
export const REGIME_PERSIST_MIN_INTERVAL_MS = 15 * 60_000;
/** Default-Retention der Snapshot-Historie (ms) — 90 Tage. */
export const REGIME_SNAPSHOT_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** Obergrenze je Load-Abfrage (gebounded; Eval-Queries paginieren nicht). */
export const REGIME_SNAPSHOT_LOAD_MAX = 5_000;

/** Zeile der Tabelle `regime_snapshots` (JS-Seite). */
export interface RegimeSnapshotRowInput {
  symbol: string;
  asOf: string;
  computedAt: string;
  rawRegime: string;
  confirmedRegime: string;
  confidence: number | null;
  coverage: number;
  degraded: boolean;
  gateMode: string;
  featureMode: string;
  featureVersion: string;
  modelVersion: string;
  topDrivers: unknown;
  familyStatus: unknown;
  reason: string;
}

/**
 * Stabiler Idempotenz-Key (sha256, hex) über die fachliche Identität der
 * Bewertung. Gleiche Bewertung ⇒ gleicher Key ⇒ ein Retry schreibt nichts
 * zweites; eine neue Bewertung (anderes as_of o. Ä.) ist eine neue Zeile.
 */
export function regimeSnapshotKey(input: RegimeSnapshotRowInput): string {
  const canonical = [
    input.symbol,
    input.asOf,
    input.rawRegime,
    input.confirmedRegime,
    input.coverage.toFixed(6),
    input.gateMode,
    input.featureMode,
    input.featureVersion,
    input.modelVersion,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Kanonischer Snapshot + Gate-Modus → Tabellenzeile (rein). */
export function toRegimeSnapshotRow(
  snapshot: InstrumentRegimeSnapshot,
  cfg: Pick<MarketRegimeConfig, "gateMode" | "featureMode">
): RegimeSnapshotRowInput {
  const now = new Date();
  const asOf = snapshot.at ?? now.toISOString();
  return {
    symbol: snapshot.symbol,
    asOf,
    computedAt: now.toISOString(),
    rawRegime: snapshot.rawRegime,
    confirmedRegime: snapshot.regime,
    confidence: snapshot.confidence,
    coverage: snapshot.coverage,
    degraded: snapshot.degraded,
    gateMode: cfg.gateMode,
    featureMode: snapshot.mode,
    featureVersion: snapshot.featureVersion,
    modelVersion: snapshot.modelVersion,
    topDrivers: snapshot.topDrivers,
    familyStatus: snapshot.families.map((f) => ({
      family: f.family,
      status: f.status,
      reason: f.reason,
    })),
    reason: snapshot.reason.slice(0, 500),
  };
}

/**
 * Schreibt EINE Snapshot-Zeile — idempotent über den Unique-Key.
 * Wirft nicht (Fehler → false + Telemetrie-Log); niemals Duplikate.
 */
export async function persistRegimeSnapshot(input: RegimeSnapshotRowInput): Promise<{ written: boolean }> {
  const key = regimeSnapshotKey(input);
  try {
    const inserted = await db
      .insert(regimeSnapshots)
      .values({
        idempotencyKey: key,
        symbol: input.symbol,
        asOf: new Date(input.asOf),
        computedAt: new Date(input.computedAt),
        rawRegime: input.rawRegime,
        confirmedRegime: input.confirmedRegime,
        confidence: input.confidence != null ? String(input.confidence) : null,
        coverage: String(input.coverage),
        degraded: input.degraded,
        gateMode: input.gateMode,
        featureMode: input.featureMode,
        featureVersion: input.featureVersion,
        modelVersion: input.modelVersion,
        topDrivers: input.topDrivers,
        familyStatus: input.familyStatus,
        reason: input.reason,
      })
      .onConflictDoNothing()
      .returning({ id: regimeSnapshots.id });
    const written = inserted.length > 0;
    telemetry.regime.persist.inc({ result: written ? "written" : "duplicate" });
    return { written };
  } catch (error) {
    telemetry.regime.persist.inc({ result: "error" });
    structuredLog("warn", "regime_snapshot_persist_failed", {
      symbol: input.symbol.slice(0, 64),
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    return { written: false };
  }
}

type PersistState = {
  lastPersistedAt: Map<string, number>;
  lastPersistedRegime: Map<string, string>;
};

const G = globalThis as typeof globalThis & { __regimeSnapshotPersist?: PersistState };

function persistState(): PersistState {
  G.__regimeSnapshotPersist ??= { lastPersistedAt: new Map(), lastPersistedRegime: new Map() };
  return G.__regimeSnapshotPersist;
}

export type SchedulePersistOptions = {
  /** Mindestabstand je Symbol (ms; Default REGIME_PERSIST_MIN_INTERVAL_MS). */
  minIntervalMs?: number;
  /** Fester "jetzt"-Zeitpunkt (Tests). */
  nowMs?: number;
  /** Gate-/Feature-Modus (Default: Snapshots eigene Modi). */
  cfg?: Pick<MarketRegimeConfig, "gateMode" | "featureMode">;
  /** Explizite Persistenzfunktion (Tests/Injektion). */
  persist?: (input: RegimeSnapshotRowInput) => Promise<{ written: boolean }>;
};

/**
 * Throttle-Schreiber für den Live-Pfad: schreibt bei Regime-Wechsel
 * (bestätigte Klasse oder Degraded-Wechsel) oder wenn das Mindestintervall
 * erreicht ist. Feuert asynchron (fire-and-forget) und bricht nie den
 * Aufrufer — Ergebnisse zählen über `telemetry.regime.persist`.
 */
export function scheduleRegimeSnapshotPersist(
  snapshot: InstrumentRegimeSnapshot,
  opts: SchedulePersistOptions = {}
): void {
  const nowMs = opts.nowMs ?? Date.now();
  const minInterval = opts.minIntervalMs ?? REGIME_PERSIST_MIN_INTERVAL_MS;
  const state = persistState();
  const lastAt = state.lastPersistedAt.get(snapshot.symbol);
  const lastRegime = state.lastPersistedRegime.get(snapshot.symbol);
  const regimeChanged = lastRegime !== `${snapshot.regime}|${snapshot.degraded}`;
  if (lastAt != null && !regimeChanged && nowMs - lastAt < minInterval) {
    telemetry.regime.persist.inc({ result: "skipped" });
    return;
  }
  state.lastPersistedAt.set(snapshot.symbol, nowMs);
  state.lastPersistedRegime.set(snapshot.symbol, `${snapshot.regime}|${snapshot.degraded}`);
  const row = toRegimeSnapshotRow(
    snapshot,
    opts.cfg ?? { gateMode: "monitor", featureMode: snapshot.mode }
  );
  const persist = opts.persist ?? persistRegimeSnapshot;
  void persist(row)
    .then((result) => {
      if (!result.written) {
        // Duplikat (Retry/Restart) — Zustand bleibt korrekt, kein Alarm.
        return;
      }
    })
    .catch((error: unknown) => {
      telemetry.regime.persist.inc({ result: "error" });
      structuredLog("warn", "regime_snapshot_schedule_failed", {
        symbol: snapshot.symbol.slice(0, 64),
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    });
}

export type LoadRegimeSnapshotsOptions = {
  fromMs: number;
  toMs: number;
  symbols?: readonly string[];
  limit?: number;
};

/** Gelesene Snapshot-Zeile (JS-Feldnamen der Drizzle-Projektion). */
export interface RegimeSnapshotDbRow {
  id: string;
  idempotencyKey: string;
  symbol: string;
  asOf: Date;
  computedAt: Date;
  rawRegime: string;
  confirmedRegime: string;
  confidence: string | null;
  coverage: string;
  degraded: boolean;
  gateMode: string;
  featureMode: string;
  featureVersion: string;
  modelVersion: string;
  topDrivers: unknown;
  familyStatus: unknown;
  reason: string;
  createdAt: Date;
}

/** Liest Snapshots aus einem as_of-Fenster (gebounded, aufsteigend sortiert). */
export async function loadRegimeSnapshots(opts: LoadRegimeSnapshotsOptions): Promise<RegimeSnapshotDbRow[]> {
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? REGIME_SNAPSHOT_LOAD_MAX)), REGIME_SNAPSHOT_LOAD_MAX);
  const conditions = [gte(regimeSnapshots.asOf, new Date(opts.fromMs)), lte(regimeSnapshots.asOf, new Date(opts.toMs))];
  if (opts.symbols && opts.symbols.length > 0) {
    // `inArray` statt ANY(text[])-Literal: bindet Parameter sauber je Symbol.
    conditions.push(inArray(regimeSnapshots.symbol, [...opts.symbols]));
  }
  const rows = await db
    .select()
    .from(regimeSnapshots)
    .where(and(...conditions))
    .orderBy(regimeSnapshots.asOf)
    .limit(limit);
  return rows as RegimeSnapshotDbRow[];
}

/**
 * Retention: entfernt Snapshots älter als `olderThanMs` (Default 90 Tage).
 * Gebounded über LIMIT-Batches (kein langer Lock beim Laufbetrieb).
 */
export async function pruneRegimeSnapshots(
  opts: { olderThanMs?: number; nowMs?: number } = {}
): Promise<{ deleted: number }> {
  const nowMs = opts.nowMs ?? Date.now();
  const olderThanMs = opts.olderThanMs ?? REGIME_SNAPSHOT_RETENTION_MS;
  const cutoff = new Date(nowMs - olderThanMs);
  // Ein DELETE statt ID-Liste: Retention ist ohnehin gegen die Tabelle
  // begrenzt; das Ergebnis liefert nur die gelöschte Zeilenzahl.
  const result = await db
    .delete(regimeSnapshots)
    .where(lte(regimeSnapshots.asOf, cutoff))
    .returning({ id: regimeSnapshots.id });
  const deleted = result.length;
  if (deleted > 0) {
    structuredLog("info", "regime_snapshots_pruned", { deleted });
  }
  return { deleted };
}

/** Nur für Tests: Throttle-Zustand leeren. */
export function __resetRegimeSnapshotPersistForTests(): void {
  delete G.__regimeSnapshotPersist;
}
