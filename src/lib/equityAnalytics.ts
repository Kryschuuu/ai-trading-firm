/**
 * Equity-Kurve — Kennzahlen, Downsampling und Achsen-Helfer (reine Funktionen).
 *
 * Zweck: Alles, was das Dashboard über die Equity-Kurve wissen muss, wird hier
 * berechnet — Drawdown-Verlauf (Peak-to-Trough), Rendite, Tagesstatistik,
 * Bucket-Verdichtung für lange Zeiträume und die Achsen-Ticks. Das Modul ist
 * **frei von DB, Uhr und Zufall** (Zeit kommt als Argument herein) und damit
 * direkt testbar (`tests/equityAnalytics.test.ts`); dieselben Funktionen nutzen
 * die API (`/api/firm/equity`, `/api/firm/report`) und das Chart.
 *
 * Definitionen (kanonisch: docs/EQUITY_CURVE.md):
 *
 *   - **Drawdown** = Rückgang vom bisherigen Höchststand (Peak-to-Trough),
 *     bezogen auf diesen Höchststand — *nicht* auf das Startkapital. Ein
 *     Konto, das von 10 000 auf 12 000 steigt und auf 11 000 fällt, hat 8,33 %
 *     Drawdown, obwohl es über dem Startwert liegt.
 *   - **Peak (High-Water-Mark)** = laufendes Maximum der Equity. Der Referenz-
 *     Peak aus der Zeit *vor* dem Fenster wird als `priorPeak` mitgereicht —
 *     sonst begänne ein Fenster, das bereits im Drawdown startet, bei 0 %.
 *   - **Rendite** = (letzter − erster Punkt) / erster Punkt im Fenster.
 *   - **Tagesrendite** = Änderung des letzten Kurses je Berliner Kalendertag
 *     (die Tagesgrenze kommt aus `./time`, damit „Tag“ lokale Mitternacht
 *     bedeutet und nicht UTC-Mitternacht).
 */

import { berlinDayKey, startOfBerlinDay, startOfBerlinMonth, tzOffsetMinutes } from "./time";

/** Ein Punkt der Kurve, wie ihn die API liefert. */
export type EquitySample = {
  ts: string;
  equity: number;
  trigger?: string;
};

/** Punkt inklusive laufendem Höchststand und Drawdown (Chart-Format). */
export type EquityCurvePoint = EquitySample & {
  /** Laufender Höchststand bis einschließlich diesem Punkt (inkl. `priorPeak`). */
  peak: number;
  /** Rückgang vom Höchststand in Prozent (≥ 0; 0 = auf oder über dem Hoch). */
  drawdownPct: number;
  /** Rückgang vom Höchststand absolut (≥ 0). */
  drawdownAbs: number;
};

export type DailyReturn = {
  /** Berliner Kalendertag (YYYY-MM-DD). */
  day: string;
  /** Tagesrendite in Prozent. */
  pct: number;
};

/**
 * Trade-Marker der Kurve (Eröffnung/Ausstieg). Der Chart zeichnet sie als
 * Dreiecke bzw. Punkte auf der Kurve; der Tooltip erklärt Symbol, Seite,
 * Ausstiegsgrund und realisiertes P&L.
 */
export type EquityMarker = {
  id: string;
  kind: "ENTRY" | "EXIT";
  ts: string;
  symbol: string;
  side: string;
  price: number | null;
  pnl?: number;
  exitReason?: string | null;
};

export type EquityStats = {
  points: number;
  firstEquity: number | null;
  lastEquity: number | null;
  firstTs: string | null;
  lastTs: string | null;
  /** Absolute Änderung im Fenster. */
  changeAbs: number | null;
  /** Rendite im Fenster in Prozent. */
  returnPct: number | null;
  /** Referenz-Startkapital (STARTING_EQUITY) — nur informativ, nicht die Drawdown-Basis. */
  startEquity: number | null;
  /** Abstand des letzten Punktes zum Startkapital in Prozent. */
  vsStartPct: number | null;
  /** Höchster Punkt im Fenster (inkl. Referenz-Peak, falls dieser höher liegt). */
  peakEquity: number | null;
  peakAt: string | null;
  /** Tiefster Punkt im Fenster. */
  lowEquity: number | null;
  lowAt: string | null;
  /** Größter Rückgang vom Höchststand im Fenster. */
  maxDrawdownPct: number;
  maxDrawdownAbs: number;
  /** Zeitpunkt des Peaks, von dem aus der maximale Drawdown lief. */
  maxDrawdownFrom: string | null;
  /** Zeitpunkt des Tiefpunkts des maximalen Drawdowns. */
  maxDrawdownTo: string | null;
  /** Erster Punkt nach dem Tief, der den Peak wieder erreicht (null = noch nicht erholt). */
  recoveredAt: string | null;
  /** Dauer der Drawdown-Phase in Millisekunden (Peak → Erholung bzw. Fensterende). */
  maxDrawdownMs: number | null;
  /** Aktueller Rückgang gegenüber dem laufenden Höchststand. */
  currentDrawdownPct: number;
  /** Laufender Höchststand am Fensterende. */
  highWaterMark: number | null;
  /** Abgedeckte Kalendertage (Berliner Tage mit mindestens einem Punkt). */
  days: number;
  daily: DailyReturn[];
  bestDay: DailyReturn | null;
  worstDay: DailyReturn | null;
  positiveDays: number;
  negativeDays: number;
  /** Standardabweichung der Tagesrenditen in Prozentpunkten. */
  volatilityPct: number | null;
  /**
   * Sharpe-ähnliche Kennzahl: Mittelwert/Standardabweichung der Tagesrenditen,
   * annualisiert mit √365 (Paper-Konto, 24/7-Monitor; keine Zinskurve). Kein
   * Nachweis von Können — nur ein Rauschmaß, deshalb erst ab 5 Handelstagen
   * berechnet (`null` sonst, „unbekannt ≠ 0“).
   */
  sharpeLike: number | null;
};

export type EquityBucketRow = {
  tsFirst: string | Date;
  eqFirst: number | string;
  tsLast: string | Date;
  eqLast: number | string;
  tsMin: string | Date;
  eqMin: number | string;
  tsMax: string | Date;
  eqMax: number | string;
};

const round = (value: number, digits = 6): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const toIso = (ts: string | Date): string => (ts instanceof Date ? ts.toISOString() : new Date(ts).toISOString());
const toNumber = (value: number | string): number => (typeof value === "number" ? value : Number(value));

/** Sortiert Punkte aufsteigend nach Zeit (stabile Kopie, keine Mutation des Arguments). */
export function sortSamples<T extends { ts: string }>(points: T[]): T[] {
  return [...points].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/**
 * Ergänzt jeden Punkt um laufenden Höchststand (`peak`) und Drawdown.
 *
 * `priorPeak` ist der Höchststand VOR dem Fenster (z. B. `SELECT max(equity)`
 * für `ts < since`). Ohne ihn startet die Kurve bei Drawdown 0 %, auch wenn
 * das Konto längst unter seinem historischen Hoch liegt — genau der Fehler,
 * der den Drawdown bisher „nicht berechnet“ aussehen ließ.
 */
export function withDrawdown(points: EquitySample[], priorPeak?: number): EquityCurvePoint[] {
  let peak =
    typeof priorPeak === "number" && Number.isFinite(priorPeak) && priorPeak > 0
      ? priorPeak
      : Number.NEGATIVE_INFINITY;
  return sortSamples(points).map((p) => {
    const equity = Number(p.equity);
    peak = Math.max(peak, equity);
    const drawdownAbs = Math.max(0, peak - equity);
    const drawdownPct = peak > 0 ? (drawdownAbs / peak) * 100 : 0;
    return {
      ts: p.ts,
      equity,
      ...(p.trigger ? { trigger: p.trigger } : {}),
      peak: round(peak),
      drawdownPct: round(drawdownPct),
      drawdownAbs: round(drawdownAbs),
    };
  });
}

/**
 * Verdichtet SQL-Buckets zu einer zeitgeordneten Kurve **ohne Extremwert-
 * Verlust**: je Bucket werden erster, tiefster, höchster und letzter Punkt
 * übernommen (Duplikate fallen weg). Die Bucket-Grenzen und die
 * `row_number()`-Fenster liegen in `./equity` (SQL) — hier passiert nur die
 * deterministische Zusammenführung.
 */
export function bucketsToPoints(rows: EquityBucketRow[]): EquitySample[] {
  const collected: EquitySample[] = [];
  for (const row of rows) {
    const candidates: Array<{ ts: string; equity: number }> = [
      { ts: toIso(row.tsFirst), equity: toNumber(row.eqFirst) },
      { ts: toIso(row.tsMin), equity: toNumber(row.eqMin) },
      { ts: toIso(row.tsMax), equity: toNumber(row.eqMax) },
      { ts: toIso(row.tsLast), equity: toNumber(row.eqLast) },
    ];
    for (const c of candidates) {
      if (!Number.isFinite(c.equity) || !Number.isFinite(Date.parse(c.ts))) continue;
      collected.push(c);
    }
  }

  // Die vier Kandidaten eines Buckets stehen NICHT chronologisch (first, min,
  // max, last) — erst sortieren, dann nur exakte Doppelte verwerfen. Ein
  // Filter „nur aufsteigende Zeitstempel durchlassen“ in Einfüge-Reihenfolge
  // hätte das Bucket-Maximum verworfen, sobald das Tief danach lag (genau das
  // ließ den Peak in der Kurve verschwinden).
  const sorted = sortSamples(collected);
  const deduped: EquitySample[] = [];
  for (const point of sorted) {
    const previous = deduped[deduped.length - 1];
    // Gleicher Snapshot (identischer Zeitstempel) → schon drin; streng
    // aufsteigende Zeitstempel halten die Chart-Skala duplikatfrei.
    if (previous && Date.parse(point.ts) <= Date.parse(previous.ts)) continue;
    deduped.push(point);
  }
  return deduped;
}

/**
 * Reduziert die Kurve auf höchstens `maxPoints` Punkte **unter Beibehaltung
 * der Extremwerte** (globales Minimum/Maximum bleiben immer enthalten).
 * Notwendig für Client-Rendering langer Fenster ohne Datenverlust: ein
 * simples „jeder n-te Punkt“ hätte Tiefs übersprungen und den Drawdown zu
 * klein gezeichnet.
 */
export function downsamplePreservingExtremes<T extends { ts: string; equity: number }>(
  points: T[],
  maxPoints = 400
): T[] {
  const sorted = sortSamples(points);
  if (sorted.length <= maxPoints) return sorted;

  const lastIndex = sorted.length - 1;
  const stride = (sorted.length - 1) / (maxPoints - 1);
  const picked = new Map<number, T>();
  for (let i = 0; i < maxPoints; i += 1) {
    // Schlüssel = Position in `sorted`; der Wert muss **von dieser Position**
    // kommen (nicht vom Schleifenzähler) — sonst würde die Kurve nur den
    // Anfang zeigen und der Rest des Fensters fehlte.
    const at = Math.round(i * stride);
    picked.set(at, sorted[at]);
  }

  let minAt = 0;
  let maxAt = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].equity < sorted[minAt].equity) minAt = i;
    if (sorted[i].equity > sorted[maxAt].equity) maxAt = i;
  }
  picked.set(minAt, sorted[minAt]);
  picked.set(maxAt, sorted[maxAt]);
  picked.set(lastIndex, sorted[lastIndex]);
  return [...picked.keys()].sort((a, b) => a - b).map((i) => picked.get(i) as T);
}

/** Tagesrenditen (Berliner Kalendertage) aus der Kurve. */
export function dailyReturns(points: EquitySample[]): DailyReturn[] {
  const sorted = sortSamples(points);
  const lastOfDay = new Map<string, number>();
  for (const p of sorted) lastOfDay.set(berlinDayKey(new Date(p.ts)), Number(p.equity));
  const out: DailyReturn[] = [];
  let previous: number | null = null;
  for (const [day, equity] of [...lastOfDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (previous !== null && previous > 0) out.push({ day, pct: round(((equity - previous) / previous) * 100) });
    previous = equity;
  }
  return out;
}

export function computeEquityStats(
  points: EquityCurvePoint[],
  opts: { startEquity?: number | null } = {}
): EquityStats {
  const empty: EquityStats = {
    points: 0,
    firstEquity: null, lastEquity: null, firstTs: null, lastTs: null,
    changeAbs: null, returnPct: null,
    startEquity: opts.startEquity ?? null, vsStartPct: null,
    peakEquity: null, peakAt: null, lowEquity: null, lowAt: null,
    maxDrawdownPct: 0, maxDrawdownAbs: 0, maxDrawdownFrom: null, maxDrawdownTo: null,
    recoveredAt: null, maxDrawdownMs: null, currentDrawdownPct: 0, highWaterMark: null,
    days: 0, daily: [], bestDay: null, worstDay: null, positiveDays: 0, negativeDays: 0,
    volatilityPct: null, sharpeLike: null,
  };
  if (points.length === 0) return empty;

  const first: EquityCurvePoint = points[0];
  const last: EquityCurvePoint = points[points.length - 1];

  /** Laufender Höchststand — startet mit dem Referenz-Peak des Vorfensters. */
  let peak = Math.max(first.peak, first.equity);
  let peakAt = first.ts;
  let low = first.equity;
  let lowAt = first.ts;
  /** Größter Rückgang (Peak-to-Trough) im Fenster. */
  let maxDrawdownPct = 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownFrom: string | null = null;
  let maxDrawdownTo: string | null = null;
  /** Höchststand, von dem der maximale Drawdown ausging (für die Erholung). */
  let maxDrawdownPeakValue = peak;
  /** Ende der maximalen Drawdown-Phase: Trough bzw. Fensterende. */
  let maxDrawdownEndMs = Date.parse(first.ts);

  for (const p of points) {
    if (p.equity > peak) {
      peak = p.equity;
      peakAt = p.ts;
    }
    if (p.equity < low) {
      low = p.equity;
      lowAt = p.ts;
    }
    if (p.drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = p.drawdownPct;
      maxDrawdownAbs = p.drawdownAbs;
      maxDrawdownFrom = peakAt;
      maxDrawdownTo = p.ts;
      maxDrawdownPeakValue = p.peak;
      maxDrawdownEndMs = Date.parse(p.ts);
    } else if (maxDrawdownPct > 0 && p.drawdownPct === maxDrawdownPct) {
      // Drawdown hält auf dem Niveau an: Phase dauert länger, Trough ist später.
      maxDrawdownEndMs = Date.parse(p.ts);
      maxDrawdownTo = p.ts;
    }
  }

  /**
   * Erholung: erster Punkt **nach** dem Trough, der den Höchststand, von dem
   * der maximale Drawdown ausging, wieder erreicht. Solange die Kurve darunter
   * bleibt, ist der Drawdown offen (null = nicht erholt, nicht 0).
   */
  let recoveredAt: string | null = null;
  if (maxDrawdownPct > 0 && maxDrawdownTo) {
    const troughMs = Date.parse(maxDrawdownTo);
    for (const p of points) {
      if (Date.parse(p.ts) > troughMs && p.equity >= maxDrawdownPeakValue) {
        recoveredAt = p.ts;
        break;
      }
    }
  }

  const daily = dailyReturns(points);
  const bestDay = daily.reduce<DailyReturn | null>((acc, d) => (acc === null || d.pct > acc.pct ? d : acc), null);
  const worstDay = daily.reduce<DailyReturn | null>((acc, d) => (acc === null || d.pct < acc.pct ? d : acc), null);
  const positiveDays = daily.filter((d) => d.pct > 0).length;
  const negativeDays = daily.filter((d) => d.pct < 0).length;

  let volatilityPct: number | null = null;
  let sharpeLike: number | null = null;
  if (daily.length >= 2) {
    const mean = daily.reduce((acc, d) => acc + d.pct, 0) / daily.length;
    const variance = daily.reduce((acc, d) => acc + (d.pct - mean) ** 2, 0) / (daily.length - 1);
    volatilityPct = round(Math.sqrt(variance));
    if (daily.length >= 5 && volatilityPct > 0) sharpeLike = round((mean / volatilityPct) * Math.sqrt(365), 3);
  }

  const changeAbs = round(last.equity - first.equity);
  const returnPct = first.equity > 0 ? round((changeAbs / first.equity) * 100) : null;
  const startEquity = opts.startEquity ?? null;
  const vsStartPct =
    startEquity && startEquity > 0 ? round(((last.equity - startEquity) / startEquity) * 100) : null;

  return {
    points: points.length,
    firstEquity: round(first.equity),
    lastEquity: round(last.equity),
    firstTs: first.ts,
    lastTs: last.ts,
    changeAbs,
    returnPct,
    startEquity,
    vsStartPct,
    peakEquity: round(peak),
    peakAt,
    lowEquity: round(low),
    lowAt,
    maxDrawdownPct: round(maxDrawdownPct),
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownFrom: maxDrawdownPct > 0 ? maxDrawdownFrom : null,
    maxDrawdownTo: maxDrawdownPct > 0 ? maxDrawdownTo : null,
    recoveredAt,
    maxDrawdownMs:
      maxDrawdownPct > 0 && maxDrawdownFrom
        ? (recoveredAt ? Date.parse(recoveredAt) : maxDrawdownEndMs) - Date.parse(maxDrawdownFrom)
        : null,
    currentDrawdownPct: round(last.drawdownPct),
    highWaterMark: round(last.peak),
    days: new Set(points.map((p) => berlinDayKey(new Date(p.ts)))).size,
    daily,
    bestDay,
    worstDay,
    positiveDays,
    negativeDays,
    volatilityPct,
    sharpeLike,
  };
}

// ─────────────────────── Drawdown-Episoden & Monatsrenditen ──────────────────

/**
 * Eine abgeschlossene (oder noch laufende) Drawdown-Phase: vom Höchststand
 * über das Tief bis zur Erholung.
 *
 * Warum eigene Episoden statt nur „max. Drawdown“: Der größte Rückgang sagt,
 * *wie tief* es ging — aber nicht, ob es zwei scharfe Einbrüche oder ein
 * monatelanger Abwärtstrend war. Die Liste zeigt die fünf tiefsten Phasen mit
 * Dauer und Erholungszeit; `open: true` heißt: läuft noch (kein erfundener
 * Endpunkt).
 */
export type DrawdownEpisode = {
  /** Höchststand, von dem der Rückgang ausging (null = liegt vor dem Fenster). */
  peakTs: string | null;
  peakValue: number;
  troughTs: string;
  troughValue: number;
  /** Rückgang in Prozent des Höchststands (positiv). */
  drawdownPct: number;
  /** Rückgang absolut (positiv). */
  drawdownAbs: number;
  /** Erster Punkt auf/über dem Höchststand (null = noch offen). */
  recoveredAt: string | null;
  /** Peak → Tief in Millisekunden. */
  declineMs: number;
  /** Tief → Erholung in Millisekunden (null = offen). */
  recoveryMs: number | null;
  /** Peak → Erholung bzw. Peak → Fensterende (Millisekunden). */
  totalMs: number;
  /** Läuft die Phase am Fensterende noch? */
  open: boolean;
};

/**
 * Zerlegt die Kurve in Drawdown-Episoden (Peak → Tief → Erholung) und liefert
 * die tiefsten `topN` absteigend nach Tiefe.
 *
 * Erwartet Punkte mit laufendem Höchststand/Drawdown (`withDrawdown`), damit
 * der Referenz-Peak aus der Zeit vor dem Fenster („Peak außerhalb“) korrekt
 * als `peakTs: null` erscheint statt als erfundenes Datum innerhalb des
 * Fensters. Episoden mit `pct < minPct` werden verworfen (Default 0: jede
 * Phase unter dem Höchststand zählt, auch wenn sie nur einen Tick dauerte).
 */
export function drawdownEpisodes(
  points: EquityCurvePoint[],
  opts: { topN?: number; minPct?: number } = {}
): DrawdownEpisode[] {
  const topN = Math.max(1, Math.floor(opts.topN ?? 5));
  const minPct = Math.max(0, opts.minPct ?? 0);
  const sorted = sortSamples(points);
  if (sorted.length < 2) return [];

  type Open = {
    peakTs: string | null;
    peakValue: number;
    troughTs: string;
    troughValue: number;
    maxPct: number;
    maxAbs: number;
  };
  const episodes: DrawdownEpisode[] = [];
  let current: Open | null = null;

  /** Letzter Punkt, der den laufenden Höchststand gebildet hat (im Fenster). */
  const peakTsOf = (upTo: number, peakValue: number): string | null => {
    for (let i = upTo; i >= 0; i -= 1) {
      if (Math.abs(sorted[i].equity - peakValue) < 1e-9) return sorted[i].ts;
    }
    return null; // Peak liegt vor dem Fenster (priorPeak)
  };

  const close = (episode: Open, recoveredAt: string | null, endTs: string) => {
    const peakMs = episode.peakTs ? Date.parse(episode.peakTs) : null;
    const troughMs = Date.parse(episode.troughTs);
    const endMs = Date.parse(recoveredAt ?? endTs);
    episodes.push({
      peakTs: episode.peakTs,
      peakValue: round(episode.peakValue),
      troughTs: episode.troughTs,
      troughValue: round(episode.troughValue),
      drawdownPct: round(episode.maxPct),
      drawdownAbs: round(episode.maxAbs),
      recoveredAt,
      declineMs: Math.max(0, troughMs - (peakMs ?? troughMs)),
      recoveryMs: recoveredAt ? Math.max(0, endMs - troughMs) : null,
      // Ohne Peak-Zeitpunkt (Peak vor dem Fenster) bleibt nur die messbare
      // Spanne: Fenster-/Tiefbeginn bis Ende — ehrlicher als eine Schätzung.
      totalMs: Math.max(0, endMs - (peakMs ?? troughMs)),
      open: recoveredAt === null,
    });
  };

  for (let i = 0; i < sorted.length; i += 1) {
    const point = sorted[i];
    if (point.drawdownPct > 0) {
      if (!current) {
        current = {
          peakTs: peakTsOf(i, point.peak),
          peakValue: point.peak,
          troughTs: point.ts,
          troughValue: point.equity,
          maxPct: point.drawdownPct,
          maxAbs: point.drawdownAbs,
        };
      } else if (point.drawdownPct > current.maxPct) {
        current.troughTs = point.ts;
        current.troughValue = point.equity;
        current.maxPct = point.drawdownPct;
        current.maxAbs = point.drawdownAbs;
      }
    } else if (current) {
      close(current, point.ts, point.ts);
      current = null;
    }
  }
  const lastTs = sorted[sorted.length - 1].ts;
  if (current) close(current, null, lastTs);

  return episodes
    .filter((e) => e.drawdownPct >= minPct)
    .sort((a, b) => b.drawdownPct - a.drawdownPct || b.totalMs - a.totalMs)
    .slice(0, topN);
}

/** Monatsrendite eines Berliner Kalendermonats. */
export type MonthlyReturn = {
  /** `YYYY-MM` (Berliner Kalender). */
  ym: string;
  year: number;
  /** 1–12. */
  month: number;
  /** Rendite innerhalb des Monats in Prozent (erster → letzter Punkt). */
  pct: number;
  /** Anzahl Kurvenpunkte im Monat (Datenlage). */
  points: number;
  /** Erster/letzter Monat der Reihe können angeschnitten sein. */
  partial: boolean;
};

/**
 * Monatsrenditen aus der Kurve (Berliner Kalender). Basis ist der erste Punkt
 * des Monats — bei durchgehender Beobachtung ist das der Schluss des
 * Vormonats, sodass die Monatsrenditen aneinander anschließen.
 *
 * Der erste und der letzte Monat des Fensters werden als `partial` markiert:
 * sie sind angeschnitten (das Fenster beginnt/endet mitten im Monat), die
 * Rendite ist also keine volle Monatsrendite — die UI kennzeichnet das, statt
 * eine Zahl zu zeigen, die mehr verspricht als die Daten hergeben.
 */
export function monthlyReturns(points: EquitySample[]): MonthlyReturn[] {
  const sorted = sortSamples(points);
  if (sorted.length === 0) return [];
  type Bucket = { first: number; last: number; count: number };
  const buckets = new Map<string, Bucket>();
  for (const p of sorted) {
    const ym = berlinDayKey(new Date(p.ts)).slice(0, 7);
    const equity = Number(p.equity);
    if (!Number.isFinite(equity)) continue;
    const bucket = buckets.get(ym);
    if (!bucket) buckets.set(ym, { first: equity, last: equity, count: 1 });
    else {
      bucket.last = equity;
      bucket.count += 1;
    }
  }
  const keys = [...buckets.keys()].sort();
  return keys.map((ym, index) => {
    const bucket = buckets.get(ym) as Bucket;
    const [year, month] = ym.split("-").map(Number);
    return {
      ym,
      year,
      month,
      pct: bucket.first > 0 ? round(((bucket.last - bucket.first) / bucket.first) * 100) : 0,
      points: bucket.count,
      partial: index === 0 || index === keys.length - 1,
    };
  });
}

/**
 * Schließt die SQL-Monatsaggregate ab: Rendite je Monat + Kennzeichnung, ob
 * der Monat im Fenster angeschnitten ist (Fenster beginnt/endet mitten im
 * Monat). Getrennt von {@link monthlyReturns} (die aus der Kurve rechnet),
 * damit die Heatmap der langen Historie aus SQL kommt und nicht davon abhängt,
 * wie grob die Kurve für den Chart verdichtet wurde.
 */
export function finalizeMonthlyReturns(
  rows: Array<{ ym: string; first: number; last: number; points: number }>,
  opts: { since: Date; until: Date }
): MonthlyReturn[] {
  return rows
    .filter((row) => Number.isFinite(row.first) && Number.isFinite(row.last) && row.first > 0)
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((row) => {
      const [year, month] = row.ym.split("-").map(Number);
      const monthStart = startOfBerlinMonth(new Date(Date.UTC(year, month - 1, 15, 12)));
      const nextMonthStart = startOfBerlinMonth(new Date(monthStart.getTime() + 32 * 86_400_000));
      // Toleranz von 24 h: Die Fenstergrenzen liegen auf Berliner Mitternacht,
      // die Monatsgrenzen hier in UTC — ein Randmonat gilt nur dann als
      // angeschnitten, wenn wirklich ein Tag oder mehr fehlt.
      const tolerance = 24 * 60 * 60 * 1_000;
      const partial =
        opts.since.getTime() > monthStart.getTime() + tolerance ||
        opts.until.getTime() < nextMonthStart.getTime() - tolerance;
      return {
        ym: row.ym,
        year,
        month,
        pct: round(((row.last - row.first) / row.first) * 100),
        points: row.points,
        partial,
      };
    });
}

/**
 * Querschnitts-Kennzahl: wie viele Monate waren positiv/negativ und wie sieht
 * der beste/schlechteste Monat aus (für den Kopf der Heatmap).
 */
export function monthlySummary(months: MonthlyReturn[]): {
  months: number;
  positive: number;
  negative: number;
  best: MonthlyReturn | null;
  worst: MonthlyReturn | null;
} {
  const full = months;
  const positive = full.filter((m) => m.pct > 0).length;
  const negative = full.filter((m) => m.pct < 0).length;
  const best = full.reduce<MonthlyReturn | null>((acc, m) => (acc === null || m.pct > acc.pct ? m : acc), null);
  const worst = full.reduce<MonthlyReturn | null>((acc, m) => (acc === null || m.pct < acc.pct ? m : acc), null);
  return { months: full.length, positive, negative, best, worst };
}

// ───────────────────────── Zeitgewichtete Rendite (TWR) ──────────────────────

/** Externer Cashflow (Einzahlung positiv, Auszahlung negativ). */
export type CashFlow = {
  ts: string;
  amount: number;
};

export type TimeWeightedReturn = {
  /** Verkettete Tagesrenditen in Prozent (null bei weniger als zwei Tagen). */
  twrPct: number | null;
  /** Einfache Rendite (erster → letzter Punkt) zum Vergleich. */
  simplePct: number | null;
  /** Anzahl verbrauchter Tagesrenditen. */
  days: number;
  /** Lage der Cashflows: Anzahl, Summe und ob sie verrechnet wurden. */
  flows: { count: number; total: number; applied: boolean };
  bestDayPct: number | null;
  worstDayPct: number | null;
};

/**
 * Zeitgewichtete Rendite: die Tagesrenditen werden **verkettet**
 * (Π(1+r) − 1), nicht als Endpunkt-Differenz gerechnet. Damit verzerrt ein
 * zwischenzeitlicher Kapitalzufluss die Kennzahl nicht — vorausgesetzt, er ist
 * bekannt: `flows` werden am jeweiligen Tag vom Ausgangswert abgezogen.
 *
 * Ehrlichkeit zur Datenlage: Das Paper-Konto führt **keine** Cashflow-Spur
 * (siehe docs/EQUITY_CURVE.md §6). Ohne `flows` ist die Kennzahl deshalb die
 * reine Kettenrendite; die UI weist das aus („ohne Cashflow-Bereinigung“) und
 * `flows.applied` bleibt `false`. Sobald eine Spur existiert
 * (`drawdown_scaling_snapshots.cumulative_net_flow` bzw. Broker-Ledger), kann
 * sie hier unverändert eingespeist werden.
 */
export function timeWeightedReturn(
  points: EquitySample[],
  opts: { flows?: CashFlow[] } = {}
): TimeWeightedReturn {
  const sorted = sortSamples(points);
  const daily = new Map<string, number>();
  for (const p of sorted) {
    const equity = Number(p.equity);
    if (!Number.isFinite(equity)) continue;
    daily.set(berlinDayKey(new Date(p.ts)), equity);
  }
  const days = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const flows = Array.isArray(opts.flows) ? opts.flows : [];
  const flowByDay = new Map<string, number>();
  let flowTotal = 0;
  for (const flow of flows) {
    const amount = Number(flow.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const key = berlinDayKey(new Date(flow.ts));
    flowByDay.set(key, (flowByDay.get(key) ?? 0) + amount);
    flowTotal += amount;
  }

  const returns: number[] = [];
  for (let i = 1; i < days.length; i += 1) {
    const [day, equity] = days[i];
    const previous = days[i - 1][1];
    // Cashflow des Tages gilt als zum Tagesbeginn zugeflossen: er erhöht das
    // Kapital, das die Rendite erwirtschaften musste — sonst würde eine
    // Einzahlung als „Gewinn“ erscheinen.
    const base = previous + (flowByDay.get(day) ?? 0);
    if (!Number.isFinite(base) || base <= 0) continue;
    returns.push(equity / base - 1);
  }

  const simplePct =
    days.length >= 2 && days[0][1] > 0
      ? round(((days[days.length - 1][1] - days[0][1]) / days[0][1]) * 100)
      : null;
  const twrPct =
    returns.length >= 1
      ? round((returns.reduce((acc, r) => acc * (1 + r), 1) - 1) * 100)
      : null;

  return {
    twrPct,
    simplePct,
    days: returns.length,
    flows: {
      count: flowByDay.size,
      total: round(flowTotal, 2),
      applied: flowByDay.size > 0,
    },
    bestDayPct: returns.length > 0 ? round(Math.max(...returns) * 100) : null,
    worstDayPct: returns.length > 0 ? round(Math.min(...returns) * 100) : null,
  };
}

// ───────────────────────────── Benchmark (Referenz) ─────────────────────────

/** Ein Punkt einer Referenzreihe (Benchmark), in Kontowährung skaliert. */
export type BenchmarkSeriesPoint = { ts: string; value: number };

/**
 * Skaliert eine Referenz-Kursreihe auf die Equity des Fensterstarts
 * („Buy-and-Hold der Referenz mit dem Startkapital“).
 *
 * Warum überhaupt skalieren: Equity steht in Kontowährung, ein Kurs in
 * Kurswährung. Erst die Skalierung macht beide Linien im Chart vergleichbar —
 * und zwar in beiden Achsenmodi (USD und Index = 100), weil sie denselben
 * Startpunkt teilen.
 *
 * Die Reihe beginnt am ersten Kurs auf/ nach `since` und endet vor/nach
 * `until`; Kerzen außerhalb werden verworfen (kein Fortschreiben).
 */
export function scaleBenchmarkSeries(
  candles: Array<{ ts: number; close: number }>,
  equityAtStart: number,
  opts: { since: number; until: number }
): BenchmarkSeriesPoint[] {
  if (!Number.isFinite(equityAtStart) || equityAtStart <= 0) return [];
  const usable = candles
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.close) && c.close > 0)
    .filter((c) => c.ts >= opts.since && c.ts <= opts.until)
    .sort((a, b) => a.ts - b.ts);
  if (usable.length === 0) return [];
  const factor = equityAtStart / usable[0].close;
  return usable.map((c) => ({ ts: new Date(c.ts).toISOString(), value: round(c.close * factor, 2) }));
}

/** Rendite einer Referenzreihe in Prozent (erster → letzter Punkt). */
export function benchmarkReturnPct(points: BenchmarkSeriesPoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  if (!(first > 0)) return null;
  return round(((last - first) / first) * 100);
}

// ─────────────────────────── Bucket-/Tick-Helfer ────────────────────────────

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** „Schöne“ Bucket-Grenzen (Sekunden) für das SQL-Downsampling. */
export const BUCKET_SECONDS = [
  60, 300, 900, 1_800, 3_600, 7_200, 21_600, 43_200, 86_400, 172_800, 604_800, 1_209_600,
  2_592_000,
] as const;

/** Kleinste Bucket-Breite, die `spanSeconds` in höchstens `maxPoints` Buckets teilt. */
export function selectBucketSeconds(spanSeconds: number, maxPoints: number): number {
  const target = Math.max(1, spanSeconds) / Math.max(1, maxPoints);
  for (const candidate of BUCKET_SECONDS) {
    if (candidate >= target) return candidate;
  }
  return BUCKET_SECONDS[BUCKET_SECONDS.length - 1];
}

/** Achsen-Ticks im „schönen“ 1/2/5-Raster (10er-Potenzen). */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min].filter(Number.isFinite);
  const rawStep = (max - min) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = multiplier * magnitude;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) out.push(round(v, 6));
  return out;
}

/**
 * Achsen-Ticks für die **logarithmische** y-Achse.
 *
 * Logarithmische Achsen sind bei Kontoständen über mehrere Größenordnungen
 * sinnvoll (gleicher *prozentualer* Abstand = gleicher Augenabstand). Die
 * Ticks kommen deshalb aus dem 1/2/5-Raster **im Zehnerpotenz-Raum**; liegen
 * Minimum und Maximum in derselben Dekade, ist eine log-Achse visuell identisch
 * mit der linearen — dann wird auf das normale Raster zurückgefallen.
 */
export function niceLogTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
    return niceTicks(min, max, target);
  }
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  if (hi - lo <= 1) return niceTicks(min, max, target);

  const out: number[] = [];
  for (let decade = lo; decade <= hi; decade += 1) {
    for (const mult of [1, 2, 5]) {
      const value = mult * 10 ** decade;
      if (value >= min * 0.999 && value <= max * 1.001) out.push(round(value, 6));
    }
  }
  // Notnagel: zu viele oder zu wenige Ticks (z. B. 10 000 … 10 500 über zwei
  // Dekaden) → lineares Raster bleibt die sichere Wahl.
  if (out.length < 2 || out.length > 12) return niceTicks(min, max, target);
  return out;
}

/**
 * Zeit-Ticks auf sinnvollen (Berliner) Grenzen: unter einem Tag auf Stunden-,
 * darüber auf Tages-/Wochen-/Monatsgrenzen. Liefert Millisekunden-Zeitstempel.
 */
export function buildTimeTicks(fromMs: number, toMs: number, maxTicks = 7): number[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const span = toMs - fromMs;
  const steps = [15 * MINUTE_MS, 30 * MINUTE_MS, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS];
  const daySteps = [1, 2, 3, 7, 14, 28];
  const target = span / Math.max(1, maxTicks);

  if (target < DAY_MS) {
    const step = steps.find((s) => s >= target) ?? 12 * HOUR_MS;
    const offset = tzOffsetMinutes(new Date(fromMs)) * MINUTE_MS;
    const first = Math.ceil((fromMs + offset) / step) * step - offset;
    const out: number[] = [];
    for (let t = first; t <= toMs; t += step) out.push(t);
    return out;
  }

  const days = target / DAY_MS;
  if (days < 28) {
    const stepDays = daySteps.find((d) => d >= days) ?? 28;
    const out: number[] = [];
    let cursor = startOfBerlinDay(new Date(fromMs));
    let guard = 0;
    while (cursor.getTime() <= toMs && guard < 5000) {
      if (cursor.getTime() >= fromMs) out.push(cursor.getTime());
      for (let i = 0; i < stepDays; i += 1) {
        // +26 h landet sicher im nächsten Berliner Kalendertag (DST-fest).
        cursor = startOfBerlinDay(new Date(cursor.getTime() + 26 * HOUR_MS));
      }
      guard += 1;
    }
    return out;
  }

  const months = days / 30.44;
  const stepMonths = months < 3 ? 1 : months < 7 ? 2 : months < 14 ? 3 : 6;
  const out: number[] = [];
  let cursor = startOfBerlinMonth(new Date(fromMs));
  let guard = 0;
  while (cursor.getTime() <= toMs && guard < 2000) {
    if (cursor.getTime() >= fromMs) out.push(cursor.getTime());
    for (let i = 0; i < stepMonths; i += 1) {
      // +32 Tage landet sicher im Folgemonat (kürzester Monat: 28 Tage).
      cursor = startOfBerlinMonth(new Date(cursor.getTime() + 32 * DAY_MS));
    }
    guard += 1;
  }
  return out;
}

// ─────────────────────────────── Formatierung ───────────────────────────────

const decimal = (value: number, digits: number) =>
  value.toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Achsenwert kompakt: `9.850`, `12,4 Tsd.`, `1,25 Mio.`. */
export function formatAxisValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${decimal(value / 1_000_000, 2)} Mio.`;
  if (abs >= 10_000) return `${decimal(value / 1000, 1)} Tsd.`;
  return decimal(value, 0);
}

/**
 * Achsenwert für die Drawdown-Skala: kleine Prozentwerte brauchen
 * Nachkommastellen. `formatAxisValue` rundet auf ganze Zahlen und hätte aus
 * 0,43 % und 0,86 % zweimal „0 %“ bzw. „1 %“ gemacht — zwei Ticks mit
 * identischer Beschriftung.
 */
export function formatPercentTick(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 10 ? 0 : abs >= 1 ? 1 : 2;
  return `${decimal(abs, digits)} %`;
}

/** Volle Kontowährung mit Vorzeichen (für Tooltip und Kennzahlen). */
export function formatMoney(value: number, currency = "$"): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${currency}${decimal(Math.abs(value), 2)}`;
}

/** Prozent mit Vorzeichen, deutsches Dezimalkomma. */
export function formatPct(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${decimal(Math.abs(value), digits)} %`;
}

/** Achsen-Zeitlabel, abhängig von der Fensterbreite (Berliner Zeit). */
export function formatTimeTick(ts: number, spanMs: number): string {
  const at = new Date(ts);
  if (spanMs < 2 * DAY_MS) {
    return at.toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
  }
  if (spanMs < 120 * DAY_MS) {
    return at.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit" });
  }
  return at.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", month: "short", year: "2-digit" });
}

/** Ausführlicher Zeitstempel für Tooltip/Achse (immer Berliner Zeit). */
export function formatTimestamp(ts: string | number, opts: { withSeconds?: boolean } = {}): string {
  const at = new Date(ts);
  return at.toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    dateStyle: "short",
    timeStyle: opts.withSeconds ? "medium" : "short",
  });
}

/** Trigger-Codes der Snapshots in Klartext (Hover-Erklärung). */
export const TRIGGER_LABELS: Record<string, string> = {
  TICK: "Monitor-Tick (60 s)",
  TRADE: "Nach einem Trade",
  CLOSE: "Nach einem Positionsschluss",
  FLATTEN: "Nach Not-Halt / Glattstellung",
  BOOT: "Systemstart",
};

export function triggerLabel(trigger?: string): string {
  if (!trigger) return "Snapshot";
  return TRIGGER_LABELS[trigger] ?? trigger;
}
