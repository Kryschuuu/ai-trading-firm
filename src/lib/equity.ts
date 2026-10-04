/**
 * Equity-Snapshots: Schreiben, Lesen, Verdichten und Aufbewahrung der Kurve.
 * Eigenständiges kleines Modul, damit Engine UND Monitor es nutzen können,
 * ohne zirkuläre Imports zu erzeugen.
 *
 * Kurvenhistorie in zwei Stufen (v0.13.0, „lange Zeiträume ohne
 * Datenmüll“):
 *
 *   1. **Rohdaten** — ein Snapshot pro Monitor-Tick (60 s) und pro Trade,
 *      aufbewahrt für `EQUITY_RAW_RETENTION_DAYS` (Default 90 Tage).
 *   2. **Tagesverdichtung** — ältere Rohdaten werden nicht gelöscht, sondern
 *      auf **zwei** Punkte pro Berliner Kalendertag eingedampft: Tiefststand
 *      (`min(equity)`) und Tagesschluss (letzter Snapshot). Damit bleiben
 *      Drawdown-Extrema ehrlich und die Kurve über Monate/Jahre lesbar —
 *      bis `EQUITY_RETENTION_DAYS` (Default 730 Tage).
 *
 * Lesen für lange Fenster passiert in **SQL-Buckets** (`row_number()` je
 * Bucket) statt „alle Zeilen laden und jeden n-ten nehmen“: nur so bleiben
 * Tiefs und Hochs innerhalb eines Buckets erhalten (siehe
 * `./equityAnalytics`). Die Zeitstempel kommen als Epoch-Millisekunden aus SQL
 * und werden explizit auf das Chart-Format gemappt — `db.execute` liefert
 * snake_case-Aliase, und `timestamptz` als Text ist je nach Laufzeit nicht
 * sicher mit `new Date()` lesbar.
 */
import { db } from "@/db";
import { equitySnapshots, positions } from "@/db/schema";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { startOfBerlinDay } from "./time";
import { envInt } from "./env";
import {
  bucketsToPoints,
  computeEquityStats,
  downsamplePreservingExtremes,
  finalizeMonthlyReturns,
  selectBucketSeconds,
  withDrawdown,
  type EquityCurvePoint,
  type EquityStats,
  type MonthlyReturn,
} from "./equityAnalytics";

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

// ───────────────────────── Aufbewahrung (Retention) ─────────────────────────

export const EQUITY_RAW_RETENTION_ENV = "EQUITY_RAW_RETENTION_DAYS";
export const EQUITY_RETENTION_ENV = "EQUITY_RETENTION_DAYS";
/** Untergrenze der Rohdaten-Aufbewahrung: mindestens ein Quartal Rohdaten. */
export const EQUITY_RAW_RETENTION_MIN_DAYS = 7;
export const EQUITY_RAW_RETENTION_MAX_DAYS = 3650;
export const EQUITY_RETENTION_MIN_DAYS = 30;
export const EQUITY_RETENTION_MAX_DAYS = 3650;
export const EQUITY_RAW_RETENTION_DEFAULT_DAYS = 90;
export const EQUITY_RETENTION_DEFAULT_DAYS = 730;

export type EquityRetentionConfig = {
  /** Tage mit unverdichteten 60-s-Snapshots. */
  rawDays: number;
  /** Gesamtfenster der Kurve (Rohdaten + Tagesverdichtung). */
  retentionDays: number;
};

/**
 * Liest die Aufbewahrungs-Fenster aus der Umgebung (Bounds-Clamp wie überall:
 * `envInt` → nie NaN/0 im SQL, „unbekannt ≠ löschen“). `retentionDays` wird
 * nie kleiner als `rawDays` — sonst würde die Verdichtung Daten wegwerfen,
 * die als Rohdaten noch gebraucht werden.
 */
export function loadEquityRetentionConfig(
  env: Record<string, string | undefined> = process.env
): EquityRetentionConfig {
  const rawDays = envInt(
    EQUITY_RAW_RETENTION_ENV,
    EQUITY_RAW_RETENTION_DEFAULT_DAYS,
    EQUITY_RAW_RETENTION_MIN_DAYS,
    EQUITY_RAW_RETENTION_MAX_DAYS,
    env
  );
  const retentionDays = Math.max(
    rawDays,
    envInt(
      EQUITY_RETENTION_ENV,
      Math.max(rawDays, EQUITY_RETENTION_DEFAULT_DAYS),
      EQUITY_RETENTION_MIN_DAYS,
      EQUITY_RETENTION_MAX_DAYS,
      env
    )
  );
  return { rawDays, retentionDays };
}

// ─────────────────────────────── Lesen ─────────────────────────────────────

export type EquityWindowMeta = {
  /** Höchster Snapshot-Wert VOR dem Fenster (Referenz-Peak für den Drawdown). */
  priorPeak: number | null;
  /** Letzter Snapshot-Wert vor dem Fenster (für die Lücke am Fensterbeginn). */
  priorEquity: number | null;
  priorTs: string | null;
  /** Frühester überhaupt vorhandener Snapshot (Grenze der Aufbewahrung). */
  earliestTs: string | null;
  /** Gesamtzahl der Snapshot-Zeilen (Diagnose/Anzeige). */
  totalPoints: number;
};

const rawResult = <T>(result: unknown): T[] =>
  ((result as { rows?: T[] }).rows ?? (Array.isArray(result) ? result : [])) as T[];

/**
 * Referenzdaten aus der Zeit VOR dem Fenster plus Aufbewahrungs-Kennzahlen.
 * Eine Query, damit Chart-Requests die DB nicht mehrfach anfassen.
 */
export async function readEquityWindowMeta(since: Date): Promise<EquityWindowMeta> {
  const result = await db.execute<{
    prior_peak: string | null;
    prior_equity: string | null;
    prior_ts: Date | null;
    earliest_ts: Date | null;
    total_points: string | number | null;
  }>(sql`
    SELECT
      (SELECT max(equity) FROM equity_snapshots WHERE ts < ${since})               AS prior_peak,
      (SELECT equity FROM equity_snapshots WHERE ts < ${since} ORDER BY ts DESC LIMIT 1) AS prior_equity,
      (SELECT ts FROM equity_snapshots WHERE ts < ${since} ORDER BY ts DESC LIMIT 1)     AS prior_ts,
      (SELECT min(ts) FROM equity_snapshots)                                       AS earliest_ts,
      (SELECT count(*) FROM equity_snapshots)                                      AS total_points
  `);
  const row = rawResult<{
    prior_peak: string | null;
    prior_equity: string | null;
    prior_ts: Date | string | null;
    earliest_ts: Date | string | null;
    total_points: string | number | null;
  }>(result)[0];

  const num = (value: string | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const iso = (value: Date | string | null | undefined): string | null => {
    if (!value) return null;
    const at = value instanceof Date ? value : new Date(value);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  };

  return {
    priorPeak: num(row?.prior_peak),
    priorEquity: num(row?.prior_equity),
    priorTs: iso(row?.prior_ts),
    earliestTs: iso(row?.earliest_ts),
    totalPoints: Number(row?.total_points ?? 0),
  };
}

export type EquitySeriesResult = {
  points: EquityCurvePoint[];
  stats: EquityStats;
  bucketSeconds: number;
  /** Anzeigename der Auflösung („Rohdaten (60 s)“, „1 Tag“ …). */
  resolution: string;
  /** Anzahl der Buckets, aus denen die Kurve gebaut wurde. */
  buckets: number;
  meta: EquityWindowMeta;
};

/** Menschlicher Name zu einer Bucket-Breite (für Legende/Diagnose). */
export function resolutionLabel(bucketSeconds: number): string {
  if (bucketSeconds <= 60) return "Rohdaten (60-s-Ticks)";
  if (bucketSeconds < 3600) return `${Math.round(bucketSeconds / 60)} Minuten`;
  if (bucketSeconds === 3600) return "1 Stunde";
  if (bucketSeconds <= 43_200) return `${Math.round(bucketSeconds / 3600)} Stunden`;
  if (bucketSeconds === 86_400) return "1 Tag";
  return `${Math.round(bucketSeconds / 86_400)} Tage`;
}

/**
 * Equity-Kurve eines Fensters — inklusive laufendem Höchststand und Drawdown.
 *
 * Die Verdichtung passiert in SQL: je Zeit-Bucket werden erster, tiefster,
 * höchster und letzter Punkt behalten (`row_number()` + `FILTER`), sodass weder das
 * Drawdown-Tief noch ein Ausbruch nach oben durch das Sampling verschwindet.
 * `maxPoints` begrenzt die Antwortgröße für den Chart.
 */
export async function readEquitySeriesWindow(opts: {
  since: Date;
  until?: Date;
  maxPoints?: number;
  startEquity?: number | null;
  /** Feste Bucket-Breite (Sekunden) — sonst aus Zeitraum und Punktdeckel. */
  bucketSeconds?: number;
}): Promise<EquitySeriesResult> {
  const until = opts.until ?? new Date();
  const maxPoints = Math.max(20, Math.min(2000, opts.maxPoints ?? 240));
  const spanSeconds = Math.max(1, Math.floor((until.getTime() - opts.since.getTime()) / 1000));
  // Vier Punkte je Bucket (first/min/max/last) → Bucket-Ziel = maxPoints/4.
  const bucketSeconds = Math.max(
    1,
    Math.trunc(opts.bucketSeconds ?? selectBucketSeconds(spanSeconds, Math.max(5, Math.ceil(maxPoints / 4))))
  );

  const [meta, rowsResult] = await Promise.all([
    readEquityWindowMeta(opts.since),
    db.execute<{
      ts_first_ms: number | string;
      eq_first: number | string;
      ts_min_ms: number | string;
      eq_min: number | string;
      ts_max_ms: number | string;
      eq_max: number | string;
      ts_last_ms: number | string;
      eq_last: number | string;
    }>(sql`
      WITH bucketed AS (
        SELECT
          floor(extract(epoch FROM ts) / ${bucketSeconds}) AS bucket,
          ts,
          equity
        FROM equity_snapshots
        WHERE ts >= ${opts.since} AND ts <= ${until}
      ),
      ranked AS (
        SELECT
          bucket,
          ts,
          equity,
          row_number() OVER (PARTITION BY bucket ORDER BY ts ASC)                     AS rn_first,
          row_number() OVER (PARTITION BY bucket ORDER BY ts DESC)                    AS rn_last,
          -- Tie-Break über ts: bei gleichem Kurs gewinnt der frühere Zeitpunkt
          -- (deterministisch, auch bei identischen Equity-Werten).
          row_number() OVER (PARTITION BY bucket ORDER BY equity ASC, ts ASC)         AS rn_min,
          row_number() OVER (PARTITION BY bucket ORDER BY equity DESC, ts ASC)        AS rn_max
        FROM bucketed
      )
      SELECT
        bucket,
        -- Zeitstempel als Epoch-Millisekunden (float8): node-postgres liefert
        -- timestamptz sonst als Text, den JS-Date je nach Laufzeit nicht
        -- sicher parst. Die Zuordnung der Spalten (früher: stilles undefined,
        -- weil SQL ts_first liefert und JS tsFirst las) passiert in JS.
        (max(extract(epoch FROM ts) * 1000) FILTER (WHERE rn_first = 1))::float8 AS ts_first_ms,
        (max(equity) FILTER (WHERE rn_first = 1))::float8                        AS eq_first,
        (max(extract(epoch FROM ts) * 1000) FILTER (WHERE rn_min = 1))::float8   AS ts_min_ms,
        (max(equity) FILTER (WHERE rn_min = 1))::float8                          AS eq_min,
        (max(extract(epoch FROM ts) * 1000) FILTER (WHERE rn_max = 1))::float8   AS ts_max_ms,
        (max(equity) FILTER (WHERE rn_max = 1))::float8                          AS eq_max,
        (max(extract(epoch FROM ts) * 1000) FILTER (WHERE rn_last = 1))::float8  AS ts_last_ms,
        (max(equity) FILTER (WHERE rn_last = 1))::float8                         AS eq_last
      FROM ranked
      GROUP BY bucket
      ORDER BY bucket ASC
    `),
  ]);

  // SQL-Zeilen (snake_case, Epoch-ms) auf das Chart-Format abbilden — die
  // Zuordnung passiert bewusst hier und nicht über Alias-Namen, damit ein
  // Spaltenname im SQL nicht stillschweigend `undefined` erzeugt.
  const rows = rawResult<{
    ts_first_ms: number | string;
    eq_first: number | string;
    ts_min_ms: number | string;
    eq_min: number | string;
    ts_max_ms: number | string;
    eq_max: number | string;
    ts_last_ms: number | string;
    eq_last: number | string;
  }>(rowsResult).map((row) => ({
    tsFirst: new Date(Number(row.ts_first_ms)).toISOString(),
    eqFirst: Number(row.eq_first),
    tsMin: new Date(Number(row.ts_min_ms)).toISOString(),
    eqMin: Number(row.eq_min),
    tsMax: new Date(Number(row.ts_max_ms)).toISOString(),
    eqMax: Number(row.eq_max),
    tsLast: new Date(Number(row.ts_last_ms)).toISOString(),
    eqLast: Number(row.eq_last),
  }));
  const raw = bucketsToPoints(rows);
  const dense = downsamplePreservingExtremes(raw, maxPoints);
  const points = withDrawdown(dense, meta.priorPeak ?? undefined);
  const stats = computeEquityStats(points, { startEquity: opts.startEquity ?? null });

  return {
    points,
    stats,
    bucketSeconds,
    resolution: resolutionLabel(bucketSeconds),
    buckets: rows.length,
    meta,
  };
}

/**
 * Monatsrenditen direkt aus der Tabelle (SQL-Aggregat je Berliner Kalendermonat).
 *
 * Warum nicht aus der Chart-Kurve: Für „Max“ ist die Kurve auf 14-Tage-Buckets
 * verdichtet — die Monatsrendite käme dann aus zwei Stichproben. Das Aggregat
 * liest stattdessen den ersten und letzten Snapshot jedes Monats aus der
 * Tabelle und ist damit von der Chart-Auflösung unabhängig.
 */
export async function readMonthlyEquity(since: Date, until: Date): Promise<MonthlyReturn[]> {
  const result = await db.execute<{
    ym: string;
    eq_first: number | string;
    eq_last: number | string;
    points: number | string;
  }>(sql`
    WITH monthly AS (
      SELECT
        to_char(ts AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') AS ym,
        ts,
        equity,
        row_number() OVER (
          PARTITION BY to_char(ts AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') ORDER BY ts ASC
        ) AS rn_first,
        row_number() OVER (
          PARTITION BY to_char(ts AT TIME ZONE 'Europe/Berlin', 'YYYY-MM') ORDER BY ts DESC
        ) AS rn_last,
        count(*) OVER (
          PARTITION BY to_char(ts AT TIME ZONE 'Europe/Berlin', 'YYYY-MM')
        ) AS points
      FROM equity_snapshots
      WHERE ts >= ${since} AND ts <= ${until}
    )
    SELECT
      ym,
      (max(equity) FILTER (WHERE rn_first = 1))::float8 AS eq_first,
      (max(equity) FILTER (WHERE rn_last = 1))::float8  AS eq_last,
      max(points)::int                                  AS points
    FROM monthly
    GROUP BY ym
    ORDER BY ym ASC
  `);
  const rows = rawResult<{
    ym: string;
    eq_first: number | string;
    eq_last: number | string;
    points: number | string;
  }>(result).map((row) => ({
    ym: row.ym,
    first: Number(row.eq_first),
    last: Number(row.eq_last),
    points: Number(row.points),
  }));
  return finalizeMonthlyReturns(rows, { since, until });
}

/**
 * Kompatible Kurzform: Kurve ab `since`, auf `maxPoints` verdichtet (ohne
 * Referenz-Peak/Drawdown) — bleibt für bestehende Aufrufer erhalten.
 */
export async function readEquitySeries(since: Date, maxPoints = 240): Promise<EquityPoint[]> {
  const { points } = await readEquitySeriesWindow({ since, maxPoints });
  return points.map((p) => ({ ts: p.ts, equity: p.equity, ...(p.trigger ? { trigger: p.trigger } : {}) }));
}

// ───────────────────────── Aufbewahrung / Verdichtung ───────────────────────

export type PruneResult = {
  /** Gelöschte Rohdaten-Zeilen jenseits der Aufbewahrung. */
  deleted: number;
  /** Rohdaten-Zeilen, die zu einem Tagespunkt verdichtet wurden. */
  downsampled: number;
  rawDays: number;
  retentionDays: number;
};

/**
 * Retention-Lauf (vom Monitor alle ~4 h aufgerufen):
 *
 *   1. Snapshots jenseits `retentionDays` löschen (harte Grenze).
 *   2. Snapshots zwischen `rawDays` und `retentionDays` auf **zwei Punkte je
 *      Berliner Kalendertag** verdichten (Tief + Tagesletzter). Die
 *      Verdichtung passiert in SQL (`row_number()` je Tag), damit auch bei
 *      Hunderttausenden Zeilen kein JS-Array entsteht.
 *
 * `now` ist injizierbar (Determinismus-Test); Default ist die echte Uhr.
 */
export async function pruneEquitySnapshots(
  config: Partial<EquityRetentionConfig> & { now?: Date } = {}
): Promise<PruneResult> {
  const envConfig = loadEquityRetentionConfig();
  const rawDays = config.rawDays ?? envConfig.rawDays;
  const retentionDays = Math.max(rawDays, config.retentionDays ?? envConfig.retentionDays);
  const now = config.now ?? new Date();
  const rawCutoff = new Date(now.getTime() - rawDays * 86_400_000);
  const retentionCutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  const deletedRows = rawResult<{ id: string }>(
    await db.delete(equitySnapshots).where(lt(equitySnapshots.ts, retentionCutoff)).returning({ id: equitySnapshots.id })
  );

  const downsampledRows = rawResult<{ id: string }>(
    await db.execute<{ id: string }>(sql`
      WITH ranked AS (
        SELECT id,
               row_number() OVER (
                 PARTITION BY (ts AT TIME ZONE 'Europe/Berlin')::date
                 ORDER BY equity ASC, ts ASC
               ) AS rn_low,
               row_number() OVER (
                 PARTITION BY (ts AT TIME ZONE 'Europe/Berlin')::date
                 ORDER BY ts DESC
               ) AS rn_last
        FROM equity_snapshots
        WHERE ts < ${rawCutoff} AND ts >= ${retentionCutoff}
      )
      DELETE FROM equity_snapshots
      WHERE id IN (SELECT id FROM ranked WHERE rn_low > 1 AND rn_last > 1)
      RETURNING id
    `)
  );

  return {
    deleted: deletedRows.length,
    downsampled: downsampledRows.length,
    rawDays,
    retentionDays,
  };
}

