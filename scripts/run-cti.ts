#!/usr/bin/env node
/**
 * CLI für den Claude Trading Indicator (CTI).
 *
 * Liest Kerzen aus dem HistoricalStore, lässt denselben Automaten laufen,
 * den auch Backtest und Trading-Engine benutzen (`src/signals/cti`), und
 * gibt wahlweise aus:
 *   - `--mode=signals` (Default): Dashboard des letzten Bars + Signalliste.
 *   - `--mode=backtest`: zusätzlich einen Backtest über dieselbe Reihe
 *     (`runCtiBacktest`) mit Kennzahlen und Trades.
 *
 * Das Skript schreibt NICHT in die Datenbank und löst keine Order aus — es
 * ist ein Lesewerkzeug. Artefakte landen nur mit `--out=<datei>` auf der
 * Platte (JSON, über `resolveRuntimePath()` geprüft).
 *
 * Aufruf:
 *   node --import tsx scripts/run-cti.ts --instrument=BITUNIX:BTCUSDT \
 *     --timeframe=1h [--from=2024-01-01] [--to=2025-01-01] [--limit=5000] \
 *     [--mode=signals|backtest] [--persist-bars=2] [--min-bars-between=10] \
 *     [--atr-length=14] [--atr-mult=3] [--no-trend] [--no-momentum] \
 *     [--no-volatility] [--no-volume] [--long-only] [--capital=10000] \
 *     [--execution=legacy|paper] [--out=data/cti/report.json]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { resolveRuntimePath } from "../src/lib/appPaths";
import {
  HistoricalStore,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import { runCtiBacktest } from "../src/signals/cti/backtest";
import { renderCtiDashboard } from "../src/signals/cti/dashboard";
import { ctiWarmupBars, resolveCtiParams, type CtiParams } from "../src/signals/cti/params";
import { computeCtiSeries, ctiSignals } from "../src/signals/cti/runtime";
import type { CtiBar, CtiCandle } from "../src/signals/cti/types";

const USAGE = `Claude Trading Indicator (CTI).

Aufruf:
  node --import tsx scripts/run-cti.ts --instrument=<ID> --timeframe=<tf>
    [--from=<ISO|ms>] [--to=<ISO|ms>] [--limit=<n>]
    [--mode=signals|backtest]
    [--atr-length=<n>] [--atr-mult=<x>] [--persist-bars=<n>] [--min-bars-between=<n>]
    [--no-trend] [--no-momentum] [--no-volatility] [--no-volume]
    [--long-only] [--capital=<betrag>] [--execution=legacy|paper]
    [--out=<datei.json>]

Hinweise:
  - Signale entstehen ausschließlich auf Bar-Schluss (kein Repainting).
  - Der Indikator braucht mit Default-Parametern ${ctiWarmupBars()} Kerzen,
    bevor das erste Signal überhaupt entstehen kann (EMA 200).
  - Das Skript handelt nicht; es liest nur.`;

const FLAGS = new Set([
  "no-trend",
  "no-momentum",
  "no-volatility",
  "no-volume",
  "long-only",
  "json",
]);

function fail(message: string): never {
  console.error(`[run-cti] FEHLER: ${message}`);
  console.error(`[run-cti] Nutzung: scripts/run-cti.ts --help`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const flag = /^--([a-z-]+)$/.exec(arg);
    if (flag) {
      if (!FLAGS.has(flag[1])) fail(`unbekanntes Argument "${arg.slice(0, 60)}".`);
      out[flag[1]] = true;
      continue;
    }
    const pair = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!pair) fail(`unbekanntes Argument "${arg.slice(0, 60)}" (erwartet --flag=wert).`);
    out[pair[1]] = pair[2];
  }
  return out;
}

function parseTime(raw: string, flag: string): number {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  } else {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  fail(`${flag}="${raw.slice(0, 40)}" ist keine gültige Zeit (ISO-8601 oder Epoch-ms erwartet).`);
}

function parseNumber(raw: string | boolean | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") fail(`${flag} braucht einen Wert.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${flag}="${raw.slice(0, 20)}" ist keine Zahl.`);
  return value;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function signalLine(bar: CtiBar): string {
  const stop = bar.signal === "BUY" ? bar.activeLongStop : bar.activeShortStop;
  return (
    `${iso(bar.time)}  ${bar.signal === "BUY" ? "BUY " : "SELL"}  ` +
    `Kurs ${bar.close.toFixed(6)}  Stop ${stop === null ? "—" : stop.toFixed(6)}  ` +
    `Bar ${bar.index}`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const instrumentId = typeof args.instrument === "string" ? args.instrument.trim() : "";
  if (!instrumentId) fail("--instrument=<ID> fehlt (z. B. BITUNIX:BTCUSDT).");

  const timeframeRaw = typeof args.timeframe === "string" ? args.timeframe.trim() : "1h";
  if (!isSupportedTimeframe(timeframeRaw)) fail(`--timeframe="${timeframeRaw}" ist nicht unterstützt.`);
  const timeframe: SupportedTimeframe = timeframeRaw;

  const from = typeof args.from === "string" ? parseTime(args.from, "--from") : undefined;
  const to = typeof args.to === "string" ? parseTime(args.to, "--to") : undefined;
  const limit = parseNumber(args.limit, "--limit");
  const mode = typeof args.mode === "string" ? args.mode : "signals";
  if (mode !== "signals" && mode !== "backtest") fail(`--mode="${mode}" (erwartet signals|backtest).`);

  // Parameter: nur das, was auch im Skript einstellbar ist.
  const requested: Partial<CtiParams> = {
    ...(args["no-trend"] ? { useTrend: false } : {}),
    ...(args["no-momentum"] ? { useMomentum: false } : {}),
    ...(args["no-volatility"] ? { useVolatility: false } : {}),
    ...(args["no-volume"] ? { useVolume: false } : {}),
  };
  const atrLength = parseNumber(args["atr-length"], "--atr-length");
  if (atrLength !== undefined) requested.atrLength = atrLength;
  const atrMultiplier = parseNumber(args["atr-mult"], "--atr-mult");
  if (atrMultiplier !== undefined) requested.atrMultiplier = atrMultiplier;
  const persistBars = parseNumber(args["persist-bars"], "--persist-bars");
  if (persistBars !== undefined) requested.persistBars = persistBars;
  const minBarsBetween = parseNumber(args["min-bars-between"], "--min-bars-between");
  if (minBarsBetween !== undefined) requested.minBarsBetween = minBarsBetween;

  const resolved = resolveCtiParams(requested);
  if (resolved.clamped.length > 0) {
    console.warn(`[run-cti] Parameter geklemmt: ${resolved.clamped.join(", ")} (siehe Bounds).`);
  }

  const store = new HistoricalStore();
  const history = store.query({ instrumentId, timeframe, from, to, limit });
  const warmup = ctiWarmupBars(resolved.params);
  if (history.length === 0) {
    fail(`data:no-candles — keine Kerzen für ${instrumentId} ${timeframe} im Zeitraum.`);
  }
  if (history.length < warmup) {
    console.warn(
      `[run-cti] Nur ${history.length} Kerzen, der Indikator braucht ${warmup} — es kann kein Signal entstehen.`,
    );
  }

  const candles: CtiCandle[] = history.map((row) => ({
    time: row.ts,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));

  const bars = computeCtiSeries(candles, resolved.params);
  const signals = ctiSignals(bars);
  const last = bars[bars.length - 1];

  console.log(
    `[run-cti] ${instrumentId} ${timeframe}: ${bars.length} Kerzen ` +
      `(${iso(bars[0].time)} → ${iso(last.time)}), Warmup ${warmup}.`,
  );
  console.log(renderCtiDashboard(last, resolved.params));
  console.log(
    `[run-cti] Signale: ${signals.length} ` +
      `(${signals.filter((bar) => bar.signal === "BUY").length} BUY / ` +
      `${signals.filter((bar) => bar.signal === "SELL").length} SELL)`,
  );
  for (const bar of signals.slice(-20)) console.log(`  ${signalLine(bar)}`);
  if (signals.length > 20) console.log(`  … ${signals.length - 20} ältere Signale ausgelassen.`);

  let report: Record<string, unknown> = {
    instrumentId,
    timeframe,
    bars: bars.length,
    from: bars[0].time,
    to: last.time,
    params: resolved.params,
    clamped: resolved.clamped,
    warmupBars: warmup,
    signals: signals.map((bar) => ({
      time: bar.time,
      index: bar.index,
      signal: bar.signal,
      close: bar.close,
      stop: bar.signal === "BUY" ? bar.activeLongStop : bar.activeShortStop,
    })),
    lastBar: last,
  };

  if (mode === "backtest") {
    const capital = parseNumber(args.capital, "--capital") ?? 10_000;
    const execution = typeof args.execution === "string" ? args.execution : "paper";
    if (execution !== "paper" && execution !== "legacy") {
      fail(`--execution="${execution}" (erwartet paper|legacy).`);
    }
    const outcome = runCtiBacktest({
      candlesBySymbol: {
        [instrumentId]: candles.map((candle, index) => ({
          time: candle.time,
          open: index === 0 ? candle.close : candles[index - 1].close,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
        })),
      },
      options: { params: resolved.params, tradeShorts: args["long-only"] !== true },
      config: { initialCapital: capital, timeframe, executionModel: execution },
    });
    const metrics = outcome.result.metrics;
    // Die Kennzahlen der Engine sind bereits Prozentwerte (siehe
    // `src/backtest/metrics.ts`) — hier wird nicht noch einmal skaliert.
    console.log(
      `[run-cti] Backtest (${execution}): ${metrics.totalTrades} Trades, ` +
        `Endkapital ${metrics.endingEquity.toFixed(2)} (${metrics.totalReturnPct.toFixed(2)} %), ` +
        `Trefferquote ${metrics.winRate.toFixed(1)} %, ` +
        `MaxDD ${metrics.maxDrawdownPct.toFixed(2)} %, ` +
        `Gebühren ${metrics.totalFeesPaid.toFixed(2)}, Slippage ${metrics.totalSlippagePaid.toFixed(2)}.`,
    );
    for (const trade of outcome.result.trades.slice(-10)) {
      console.log(
        `  ${iso(trade.entryTime)} ${trade.side.padEnd(5)} → ${iso(trade.exitTime)} ` +
          `${trade.exitReason.padEnd(11)} PnL ${trade.pnl.toFixed(2)}`,
      );
    }
    report = {
      ...report,
      backtest: {
        executionModel: execution,
        initialCapital: capital,
        metrics,
        trades: outcome.result.trades,
        signalStats: outcome.signals,
      },
    };
  }

  if (typeof args.out === "string" && args.out.trim().length > 0) {
    const target = resolveRuntimePath(args.out.trim());
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[run-cti] Report geschrieben: ${target}`);
  }
}

main().catch((error: unknown) => {
  console.error(`[run-cti] Abbruch: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
