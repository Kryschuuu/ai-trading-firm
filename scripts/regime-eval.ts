#!/usr/bin/env node
/**
 * CLI der Regime-Snapshot-Auswertung (RMA-P2-01, v1.61.0) — lokal,
 * deterministisch, gebounded. Kein Netzwerk, kein LLM.
 *
 * ```text
 * npm run regime:eval                        # letzte 30 Tage, Horizont 8×15m
 * npm run regime:eval -- --days=90 --horizon=16
 * npm run regime:eval -- --symbols=BTC,ETH --limit=500
 * npm run regime:eval -- --out=artifacts/regime-eval.json
 * npm run regime:eval -- --prune             # zusätzlich Retention (90 Tage)
 * ```
 *
 * Quellen:
 *   1. `regime_snapshots` (Postgres, as-of-Fenster, LIMIT gebbounded)
 *   2. Historical Store (`data/history`) je Symbol — Forward-Returns über
 *      `--horizon` abgeschlossene 15m-Bars nach dem Snapshot.
 *
 * Fail-closed OOS: Snapshot ohne erreichbaren Horizont (kein Anker-Bars
 * ≤ as_of oder zu wenig Folgebars) wird AUSSCHLOSSEN (`excluded`), nie mit
 * 0 % gewertet. DB-/Store-Fehler beenden den Lauf mit Exit 1 (kein
 * stiller Leerreport als „Erfolg“).
 *
 * Ausgabe: geboundedes JSON-Report (Stabilität + Transitions + Coverage +
 * OOS je Regime) nach `--out` (Default `data/regime-eval/report.json`,
 * gitignored) und eine kompakte Konsolen-Zusammenfassung.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "../src/lib/appPaths";
import { buildRegimeEvalReport, type RegimeEvalRow } from "../src/lib/regimeEvaluation";
import { historyDir } from "../src/lib/marketdata/config";
import {
  HistoricalStore,
  SUPPORTED_TIMEFRAME_MS,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import {
  REGIME_SNAPSHOT_RETENTION_MS,
  loadRegimeSnapshots,
  pruneRegimeSnapshots,
} from "../src/lib/regimeSnapshotStore";

const USAGE = `Regime-Snapshot-Auswertung (RMA-P2-01) — Stabilität, Transitions, Coverage, OOS.

Aufruf:
  node --import tsx scripts/regime-eval.ts [Optionen]

Optionen:
  --days=<n>         As-of-Fenster rückwärts (Default 30, Bounds 1..3650)
  --horizon=<n>      Forward-Horizont in 15m-Bars (Default 8, Bounds 1..96)
  --limit=<n>        Max. Snapshots (Default 2000, Max 5000)
  --symbols=<a,b>    Nur diese Symbole (Default: alle)
  --timeframe=<tf>   Kerzen-Timeframe für Forward-Returns (Default 15m)
  --out=<pfad>       Report-Ziel (Default data/regime-eval/report.json)
  --prune            Retention laufen lassen (90 Tage, konfigurierbar via
                     REGIME_SNAPSHOT_RETENTION_DAYS)
  --help             Diese Hilfe
`;

type Args = {
  days: number;
  horizon: number;
  limit: number;
  symbols: string[] | undefined;
  timeframe: SupportedTimeframe;
  out: string;
  prune: boolean;
  help: boolean;
};

function fail(message: string): never {
  process.stderr.write(`regime:eval: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    days: 30,
    horizon: 8,
    limit: 2000,
    symbols: undefined,
    timeframe: "15m",
    out: path.join("data", "regime-eval", "report.json"),
    prune: false,
    help: false,
  };
  for (const raw of argv) {
    if (raw === "--help" || raw === "-h") args.help = true;
    else if (raw === "--prune") args.prune = true;
    else if (raw.startsWith("--days=")) args.days = Number(raw.slice("--days=".length));
    else if (raw.startsWith("--horizon=")) args.horizon = Number(raw.slice("--horizon=".length));
    else if (raw.startsWith("--limit=")) args.limit = Number(raw.slice("--limit=".length));
    else if (raw.startsWith("--symbols="))
      args.symbols = raw
        .slice("--symbols=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    else if (raw.startsWith("--timeframe=")) args.timeframe = raw.slice("--timeframe=".length) as SupportedTimeframe;
    else if (raw.startsWith("--out=")) args.out = raw.slice("--out=".length);
    else fail(`unbekanntes Argument: ${raw} (siehe --help)`);
  }
  if (!Number.isFinite(args.days) || args.days < 1 || args.days > 3650) fail("--days muss 1..3650 sein");
  if (!Number.isFinite(args.horizon) || args.horizon < 1 || args.horizon > 96) fail("--horizon muss 1..96 sein");
  if (!Number.isFinite(args.limit) || args.limit < 1 || args.limit > 5000) fail("--limit muss 1..5000 sein");
  const tfAllowed = Object.keys(SUPPORTED_TIMEFRAME_MS) as SupportedTimeframe[];
  if (!tfAllowed.includes(args.timeframe)) fail(`--timeframe ungültig: ${args.timeframe}`);
  return args;
}

/** Kandidaten-Instrument-IDs je Snapshot-Symbol (Reihenfolge = Präferenz). */
function instrumentCandidates(symbol: string): string[] {
  const upper = symbol.trim().toUpperCase();
  const out = new Set<string>();
  if (upper.includes(":")) {
    out.add(upper);
    out.add(upper.slice(upper.lastIndexOf(":") + 1));
    out.add(`PAPER:${upper.slice(upper.lastIndexOf(":") + 1)}`);
  } else {
    out.add(upper);
    out.add(`PAPER:${upper}`);
  }
  return [...out].filter(Boolean);
}

type Series = { ts: number; close: number }[];

/**
 * Forward-Return in % ab dem letzten Bar ≤ asOfMs über `horizon` Bars.
 * `null` = Anker oder Horizont nicht erreichbar (fail-closed Ausschluss).
 */
function forwardReturnPct(series: Series, asOfMs: number, horizon: number): number | null {
  if (series.length === 0) return null;
  let anchor = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i].ts <= asOfMs) anchor = i;
    else break;
  }
  if (anchor < 0) return null;
  const target = anchor + horizon;
  if (target >= series.length) return null;
  const entry = series[anchor].close;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const exit = series[target].close;
  if (!Number.isFinite(exit) || exit <= 0) return null;
  return ((exit - entry) / entry) * 100;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const now = Date.now();
  const fromMs = now - args.days * 24 * 60 * 60_000;

  let rawRows: Awaited<ReturnType<typeof loadRegimeSnapshots>>;
  try {
    rawRows = await loadRegimeSnapshots({
      fromMs,
      toMs: now,
      ...(args.symbols ? { symbols: args.symbols } : {}),
      limit: args.limit,
    });
  } catch (error) {
    fail(
      `Snapshot-Query fehlgeschlagen (DATABASE_URL gesetzt? Migration gelaufen?): ${
        error instanceof Error ? error.message.slice(0, 300) : "unbekannt"
      }`
    );
  }

  if (args.prune) {
    try {
      const retentionDays = Number(process.env.REGIME_SNAPSHOT_RETENTION_DAYS);
      const olderThanMs =
        Number.isFinite(retentionDays) && retentionDays > 0
          ? retentionDays * 24 * 60 * 60_000
          : REGIME_SNAPSHOT_RETENTION_MS;
      const pruned = await pruneRegimeSnapshots({ olderThanMs, nowMs: now });
      process.stdout.write(`retention: ${pruned.deleted} Snapshots entfernt\n`);
    } catch (error) {
      fail(`Retention fehlgeschlagen: ${error instanceof Error ? error.message.slice(0, 200) : "unbekannt"}`);
    }
  }

  // Kerzenreihen je Symbol ( Historical Store, kein Netzwerk ).
  const store = new HistoricalStore(historyDir());
  const seriesCache = new Map<string, Series>();
  const seriesFor = (symbol: string): Series => {
    const cached = seriesCache.get(symbol);
    if (cached) return cached;
    for (const candidate of instrumentCandidates(symbol)) {
      try {
        const entries = store.query({ instrumentId: candidate, timeframe: args.timeframe });
        if (entries.length > 0) {
          const series: Series = entries
            .map((e) => ({ ts: e.ts, close: e.close }))
            .sort((a, b) => a.ts - b.ts);
          seriesCache.set(symbol, series);
          return series;
        }
      } catch {
        // Nächster Kandidat; ohne Treffer bleibt die Reihe leer.
      }
    }
    seriesCache.set(symbol, []);
    return [];
  };

  const rows: RegimeEvalRow[] = [];
  let excludedNoSeries = 0;
  for (const raw of rawRows) {
    const symbol = String(raw.symbol ?? "");
    const asOfMs = raw.asOf instanceof Date ? raw.asOf.getTime() : Number(raw.asOf);
    if (!symbol || !Number.isFinite(asOfMs)) continue;
    const confidenceRaw = raw.confidence == null ? null : Number(raw.confidence);
    const coverage = Number(raw.coverage);
    const series = seriesFor(symbol);
    const fwd = series.length > 0 ? forwardReturnPct(series, asOfMs, args.horizon) : null;
    if (series.length === 0 || fwd === null) excludedNoSeries += 1;
    rows.push({
      symbol,
      asOfMs,
      rawRegime: String(raw.rawRegime ?? "UNKNOWN"),
      confirmedRegime: String(raw.confirmedRegime ?? "UNKNOWN"),
      confidence: confidenceRaw != null && Number.isFinite(confidenceRaw) ? confidenceRaw : null,
      coverage: Number.isFinite(coverage) ? Math.min(Math.max(coverage, 0), 1) : 0,
      degraded: raw.degraded === true,
      forwardReturnPct: fwd,
    });
  }

  const report = buildRegimeEvalReport(rows);
  const outPath = resolveRuntimePath(args.out);
  mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o755 });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  if (!existsSync(outPath)) fail(`Report nicht schreibbar: ${outPath}`);

  const s = report.stability;
  process.stdout.write(
    [
      `regime:eval — ${s.snapshots} Snapshots / ${s.symbols} Symbole (${new Date(s.window.fromMs ?? 0).toISOString().slice(0, 10)} … ${new Date(s.window.toMs ?? 0).toISOString().slice(0, 10)})`,
      `Stabilität: ${s.transitions} Transitions (Flip-Rate ${s.flipRate}), Coverage Ø ${(s.coverage.mean * 100).toFixed(1)} % (min ${(s.coverage.min * 100).toFixed(1)} %, degraded-Anteil ${(s.coverage.degradedShare * 100).toFixed(1)} %)`,
      `Confidence: ${s.confidence.mean != null ? `Ø ${s.confidence.mean.toFixed(3)} (min ${s.confidence.min})` : "n/v"} · ohne Horizont ausgeschlossen: ${excludedNoSeries}`,
      ...report.oos.map(
        (o) =>
          `OOS ${o.regime}: n=${o.samples}/${o.snapshots} (excl. ${o.excluded}) · Ø ${o.meanForwardReturnPct != null ? `${o.meanForwardReturnPct.toFixed(3)} %` : "n/v"} · positiv ${o.positiveShare != null ? `${(o.positiveShare * 100).toFixed(1)} %` : "n/v"}`
      ),
      `Report: ${outPath}`,
      "",
    ].join("\n")
  );
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "unbekannter Fehler");
});
