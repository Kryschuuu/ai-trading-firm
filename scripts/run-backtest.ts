#!/usr/bin/env node
/**
 * CLI für Walk-Forward-Backtests (GAP-01, D3, v1.51.0; Trade-Ledger
 * RMA-P1-04, v1.52.0).
 *
 * Replayt EINE Mikro-Zyklus-Regel gegen den HistoricalStore in rollierenden
 * IS/OOS-Fenstern (Paper-Ausführung = DERSELBE Fill-Simulator wie der
 * PaperBroker) und persistiert den Run vergleichbar:
 *   - Datenbank: Run-Zeile in `backtest_runs` + ALLE Trades in
 *     `backtest_trades`, atomar in EINER Transaktion und idempotent
 *     (`persistBacktestRun`): Key = Inhalts-Fingerprint des Laufs
 *     (`--idempotency-key` überschreibt); ein Retry desselben Laufs liefert
 *     den bestehenden Run statt eines Duplikats.
 *   - Artefakte: `data/backtest/<runId>.json` (Report inkl. Trade-Liste) +
 *     `<runId>.md` (Zusammenfassung) via `resolveRuntimePath()` — unter der
 *     UUID des (ggf. bereits bestehenden) persistierten Runs.
 *
 * Aufruf:
 *   node --import tsx scripts/run-backtest.ts \
 *     --instrument=BITUNIX:BTCUSDT --timeframe=1h \
 *     --from=2024-01-01 --to=2026-01-01 \
 *     --rule-id=<uuid> | --rule-file=./regel.json \
 *     [--is-days=90] [--oos-days=30] [--idempotency-key=<key>] [--skip-db]
 *
 * Fail-closed: fehlende/ungültige Flags, leere Kerzenreihen, ungültige
 * Regeln und zu kurze Zeiträume brechen mit Exit 1 ab (kein Run, kein
 * Artefakt, keine DB-Zeile). Schlägt die Persistenz fehl oder wird sie
 * abgelehnt (Ledger ≠ Aggregate), entsteht KEINE DB-Zeile; die Artefakte
 * werden trotzdem geschrieben und der Exit-Code ist 1 (laut, nie still) —
 * ein Lauf gilt erst mit RECONCILED-Ledger als persistiert.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  backtestRunIdempotencyKey,
  BacktestPersistenceError,
  EventReplayError,
  perpFundingRowsToReplayEvents,
  persistBacktestRun,
  runWalkForward,
  TradeLedgerError,
  WalkForwardError,
} from "../src/backtest";
import type {
  BacktestStrategyItem,
  ReplayInputEvent,
  WalkForwardReport,
} from "../src/backtest";
import {
  HistoricalStore,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import {
  ruleSignature,
  sanitizeRuleSpec,
  type CandleLike,
  type RuleSpec,
} from "../src/lib/ruleEngine";
import { getRule, rowToSpec } from "../src/lib/ruleService";
import { getRegistry } from "../src/universe";
import type { MarketInstrument } from "../src/universe/types";
import { resolveRuntimePath } from "../src/lib/appPaths";
import { calibrateSimulatorConfig, loadSimulatorConfig } from "../src/lib/marketdata/config";
import { loadFundingConfig } from "../src/lib/funding";
import {
  createPerpFundingRateProvider,
  getPerpDataService,
  loadPerpConfig,
  perpDataEnabled,
} from "../src/perpdata/index";
import { loadWalkForwardConfig, WF_BOUNDS } from "../src/backtest/walkforward";

const USAGE = `Walk-Forward-Backtest (GAP-01) — genau EIN Regel-Replay je Aufruf.

Aufruf:
  node --import tsx scripts/run-backtest.ts --instrument=<ID> --timeframe=<tf>
    --from=<ISO|ms> --to=<ISO|ms> (--rule-id=<uuid> | --rule-file=<pfad>)
    [--is-days=N] [--oos-days=N] [--idempotency-key=<key>] [--skip-db]

Pflicht:
  --instrument   Instrument-ID wie im HistoricalStore (z. B. BITUNIX:BTCUSDT)
  --timeframe    Kerzen-Periodizität (${"1h"} u. a. — Allowlist des Stores)
  --from/--to    Zeitraum (ISO-8601 oder Epoch-ms; muss mind. 1 IS+OOS tragen)
  --rule-id      Regel-UUID aus trade_rules (genau eine Regelquelle!)
  --rule-file    Pfad zu einer RuleSpec-JSON (wird sanitized + geklemmt)

Optional:
  --is-days      IS-Fenster in Tagen (Bounds [${WF_BOUNDS.isDays.min}, ${WF_BOUNDS.isDays.max}], Default Env/90)
  --oos-days     OOS-Fenster in Tagen (Bounds [${WF_BOUNDS.oosDays.min}, ${WF_BOUNDS.oosDays.max}], Default Env/30)
  --idempotency-key  eigener Lauf-Schlüssel (8..128 Zeichen [A-Za-z0-9:_.-]);
                 Default: Inhalts-Fingerprint (Retry ⇒ derselbe Run)
  --skip-db      keine Persistenz (nur Artefakte; Offline-Betrieb)
  --execution-model  paper (Default) | event_replay (RMA-P1-01: Order-
                 Lifecycle mit Partial Fills, Latenz, Depth-Impact und
                 punktgenauen Funding-Ereignissen aus der Perp-Historie)
  --replay-latency-ms  Submit→Arrival-Latenz in ms (nur event_replay, ≥ 0,
                 Default 0 = Fill auf der Entscheidungskerze)
  --replay-seed  Seed des Replay-Laufs (nur event_replay, Default 1)

Ausgabe: data/backtest/<runId>.json + <runId>.md; DB: backtest_runs-Zeile +
backtest_trades (atomar, idempotent, Ledger RECONCILED).
Doku: docs/BACKTESTING.md (CLI-Referenz), CONFIGURATION.md (WF_*-Flags).`;

function fail(message: string): never {
  console.error(`[run-backtest] FEHLER: ${message}`);
  console.error(`[run-backtest] Nutzung: scripts/run-backtest.ts --help`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--skip-db") {
      out["skip-db"] = true;
      continue;
    }
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m) fail(`unbekanntes Argument "${arg.slice(0, 60)}" (erwartet --flag=wert).`);
    out[m[1]] = m[2];
  }
  return out;
}

/** ISO-8601 oder Epoch-ms → ms (fail-closed bei ungültiger Zeit). */
function parseTime(raw: string, flag: string): number {
  const t = raw.trim();
  if (/^-?\d+$/.test(t)) {
    const ms = Number(t);
    if (Number.isFinite(ms) && ms > 0) return ms;
  } else {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  fail(`${flag}="${raw.slice(0, 40)}" ist keine gültige Zeit (ISO-8601 oder Epoch-ms erwartet).`);
}

function clampDays(raw: string, flag: "--is-days" | "--oos-days", min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${flag}="${raw.slice(0, 20)}" ist keine Zahl.`);
  const days = Math.floor(n);
  if (days < min || days > max) {
    fail(`${flag}=${days} außerhalb der Bounds [${min}, ${max}].`);
  }
  return days;
}

function readRuleFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    fail(`--rule-file="${file.slice(0, 80)}" nicht lesbar.`);
  }
}

async function loadRule(args: Record<string, string | boolean>): Promise<{ spec: RuleSpec; ruleId: string | null }> {
  const ruleId = args["rule-id"];
  const ruleFile = args["rule-file"];
  if ((ruleId === undefined) === (ruleFile === undefined)) {
    fail("genau EINE Regelquelle angeben: --rule-id=<uuid> ODER --rule-file=<pfad>.");
  }
  if (typeof ruleId === "string") {
    const id = ruleId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      fail(`--rule-id="${id.slice(0, 40)}" ist keine UUID.`);
    }
    let row: Awaited<ReturnType<typeof getRule>>;
    try {
      row = await getRule(id);
    } catch (e) {
      fail(`Regel ${id} nicht ladbar (DB-Fehler: ${e instanceof Error ? e.message : String(e)}).`);
    }
    if (!row) fail(`Regel ${id} existiert nicht (trade_rules).`);
    return { spec: rowToSpec(row), ruleId: id };
  }
  const file = String(ruleFile);
  const raw = readRuleFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`--rule-file="${file.slice(0, 80)}" ist kein gültiges JSON.`);
  }
  const checked = sanitizeRuleSpec(parsed as Record<string, unknown>, "MANUAL");
  if (!checked.ok) {
    fail(`Regel-Spezifikation ungültig: ${checked.errors.join("; ").slice(0, 300)}`);
  }
  return { spec: checked.spec, ruleId: null };
}

function renderMarkdown(runId: string, report: WalkForwardReport): string {
  const d = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const lines: string[] = [
    `# Walk-Forward-Run ${runId}`,
    ``,
    `- Instrument: \`${report.instrumentId}\` (${report.timeframe}), Zeitraum ${d(report.from)} … ${d(report.to)}`,
    `- Regel: ${report.ruleRef.name} (Signatur \`${report.ruleRef.signature}\`, Regel-Symbol \`${report.ruleRef.ruleSymbol}\`)`,
    `- Fenster: ${report.walkforward.windowCount} × IS ${report.walkforward.isDays}d / OOS ${report.walkforward.oosDays}d${report.walkforward.truncated ? ` (Zeitraum am ${report.walkforward.maxSpanDays}d-Deckel gekappt)` : ""}`,
    `- Kosten: ${report.costProfile.executionModel === "event_replay" ? `Event-Replay (Friktionsmodell ${report.costProfile.frictionModelVersion ?? "er1"}: Order-Lifecycle, Latenz, Depth-Impact, FUNDING_DUE-Ereignisse)` : "Paper-Ausführung (Fill-Simulator wie PaperBroker)"}, Maker ${(report.costProfile.makerFee * 100).toFixed(3)} %, Taker ${(report.costProfile.takerFee * 100).toFixed(3)} %, Funding ${report.costProfile.fundingRatePctPer8h} %/8h, Seed ${report.costProfile.simulatorSeed}`,
    `- Code-Version: \`${report.codeVersion}\`, erstellt ${report.createdAt}`,
    ``,
    `## Aggregate`,
    ``,
    `| Aggregat | Fenster | Trades | Win-Rate | PnL (Equity) | Netto-PnL (Ledger) | Profit-Factor | MaxDD | Sharpe | Sortino | Gebühren | Slippage | Funding |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const [label, a] of [["OOS", report.aggregateOos], ["IS", report.aggregateIs]] as const) {
    lines.push(
      `| ${label} | ${a.windows} | ${a.trades} | ${a.winRate} % | ${a.pnl} | ${a.netPnl} | ${a.profitFactor ?? "—"} | ${a.maxDrawdownPct} % | ${a.sharpeRatio} | ${a.sortinoRatio} | ${a.fees} | ${a.slippage} | ${a.funding} |`
    );
  }
  lines.push(
    ``,
    `## Fenster`,
    ``,
    `| # | IS | OOS | IS-Trades | IS-PnL | OOS-Trades | OOS-PnL | OOS-Netto (Ledger) | OOS-Win-Rate | OOS-MaxDD | Trade-Hash (OOS) |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`
  );
  for (const w of report.windows) {
    lines.push(
      `| ${w.index} | ${d(w.is.from)}…${d(w.is.to)} | ${d(w.oos.from)}…${d(w.oos.to)} | ${w.is.trades} | ${w.is.pnl} | ${w.oos.trades} | ${w.oos.pnl} | ${w.oos.netPnl} | ${w.oos.winRate} % | ${w.oos.maxDrawdownPct} % | \`${w.oos.tradeHash.slice(0, 12)}…\` |`
    );
  }
  if (report.replayEvidence) {
    const ev = report.replayEvidence;
    lines.push(
      ``,
      `## Replay-Evidenz (Event-Replay)`,
      ``,
      `- Friktionsmodell \`${ev.config.frictionModelVersion}\`, Seed ${ev.config.seed}, Latenz ${ev.config.latency.decisionToSubmitMs}+${ev.config.latency.submitToArrivalMs} ms, Impact ${ev.config.impactBpsPerParticipation} bp/Partizipation, Order-TTL ${ev.config.orderTtlBars} Kerzen`,
      `- Datenmanifest: Kerzen \`${ev.manifest.candlesHash.slice(0, 12)}…\` (${ev.manifest.candleCount}), Events \`${ev.manifest.eventsHash.slice(0, 12)}…\` (Quotes ${ev.manifest.eventCounts.quotes}, Depth ${ev.manifest.eventCounts.depth}, Funding ${ev.manifest.eventCounts.funding})`,
      `- Coverage: ${ev.coverage.bars} Kerzen, Orders ${ev.coverage.ordersSubmitted} submitted / ${ev.coverage.ordersFilled} filled / ${ev.coverage.ordersPartiallyFilled} partial / ${ev.coverage.ordersCancelled} cancelled; Fills aus Depth ${ev.coverage.fillsFromDepth}, aus Volumen-Fallback ${ev.coverage.fillsFromBarVolumeFallback}; Funding gebucht ${ev.coverage.fundingApplied} / übersprungen ${ev.coverage.fundingSkipped}`,
      `- Degradierte Annahmen: ${ev.degradedReasons.length > 0 ? ev.degradedReasons.map((r) => `\`${r}\``).join(", ") : "keine"}`
    );
  }
  lines.push(
    ``,
    `## Trade-Ledger`,
    ``,
    `- ${report.trades.length} Trade-Zeilen (IS + OOS, Fenster ↑, IS vor OOS) — vollständig im JSON-Artefakt (\`trades\`) und in \`backtest_trades\` (seq 1…${report.trades.length}).`,
    `- PnL (Equity) stammt aus der Equity-Kurve des Fensters; Netto-PnL (Ledger) ist Σ der Trade-PnL. Die Differenz entsteht durch die END_OF_DATA-Glattstellung nach dem letzten Equity-Snapshot (Fill-Kosten des Schlussfills) — beide Werte stehen im Report, keiner wird umgebogen (\`reconciliation.equityLedgerGap\`).`,
    ``,
    `> Anti-Overfitting-Hinweis: IS/OOS trennt EVALUATIONS-Fenster — die Regel`,
    `> ist statisch, es findet keine Parameter-Optimierung statt. OOS trägt die`,
    `> Wahrheit, IS nur den Vergleich. Siehe docs/BACKTESTING.md.`
  );
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const instrument = args["instrument"];
  if (typeof instrument !== "string" || instrument.trim() === "") {
    fail("--instrument=<ID> ist Pflicht (z. B. --instrument=BITUNIX:BTCUSDT).");
  }
  const instrumentId = instrument.trim().toUpperCase();

  const timeframeRaw = typeof args["timeframe"] === "string" ? (args["timeframe"] as string).trim() : "1h";
  if (!isSupportedTimeframe(timeframeRaw)) {
    fail(`--timeframe="${timeframeRaw.slice(0, 20)}" ist kein unterstützter Timeframe.`);
  }
  const timeframe: SupportedTimeframe = timeframeRaw;

  if (typeof args["from"] !== "string" || typeof args["to"] !== "string") {
    fail("--from=<ISO|ms> und --to=<ISO|ms> sind Pflicht.");
  }
  const from = parseTime(args["from"] as string, "--from");
  const to = parseTime(args["to"] as string, "--to");
  if (to <= from) fail("--to muss nach --from liegen.");

  const wfBase = loadWalkForwardConfig();
  const isDays =
    typeof args["is-days"] === "string"
      ? clampDays(args["is-days"], "--is-days", WF_BOUNDS.isDays.min, WF_BOUNDS.isDays.max)
      : wfBase.isDays;
  const oosDays =
    typeof args["oos-days"] === "string"
      ? clampDays(args["oos-days"], "--oos-days", WF_BOUNDS.oosDays.min, WF_BOUNDS.oosDays.max)
      : wfBase.oosDays;

  // RMA-P1-01: Ausführungspfad — Default bleibt "paper" (kein stiller Wechsel).
  const executionModelRaw =
    typeof args["execution-model"] === "string" ? (args["execution-model"] as string).trim() : "paper";
  if (executionModelRaw !== "paper" && executionModelRaw !== "event_replay") {
    fail(`--execution-model="${executionModelRaw.slice(0, 30)}" ist ungültig (paper | event_replay).`);
  }
  const executionModel: "paper" | "event_replay" = executionModelRaw;
  const replayLatencyMs =
    typeof args["replay-latency-ms"] === "string" ? Number(args["replay-latency-ms"]) : 0;
  if (!Number.isFinite(replayLatencyMs) || replayLatencyMs < 0) {
    fail(`--replay-latency-ms="${String(args["replay-latency-ms"]).slice(0, 20)}" muss ≥ 0 sein.`);
  }
  const replaySeed = typeof args["replay-seed"] === "string" ? Number(args["replay-seed"]) : 1;
  if (!Number.isInteger(replaySeed) || replaySeed < 0) {
    fail(`--replay-seed="${String(args["replay-seed"]).slice(0, 20)}" muss eine Ganzzahl ≥ 0 sein.`);
  }

  const { spec, ruleId } = await loadRule(args);

  // Regel-Logik (Bedingung/Action/Fenster — venue-agnostisch, sanitized +
  // geklemmt) wird gegen --instrument replayt: Das Regel-Symbol
  // (PAPER-kanonisch, z. B. „BTC/USDT“) adressiert nie Store-Reihen
  // (z. B. „BITUNIX:BTCUSDT“). Beide IDs stehen im Report (ruleSymbol vs.
  // instrumentId) — kein stiller Tausch, siehe docs/BACKTESTING.md.
  const replaySpec: RuleSpec = { ...spec, symbol: instrumentId };
  if (spec.symbol !== instrumentId) {
    console.log(`[run-backtest] Regel-Symbol ${spec.symbol} ⇒ Replay gegen ${instrumentId} (siehe ruleSymbol im Report).`);
  }

  const store = new HistoricalStore();
  const history = store.query({ instrumentId, timeframe, from, to });
  if (history.length < 2) {
    fail(`data:no-candles — ${history.length} Kerzen für ${instrumentId} ${timeframe} im Zeitraum (mind. 2 nötig).`);
  }
  const candles: CandleLike[] = history.map((h) => ({
    time: h.ts,
    open: h.open,
    high: h.high,
    low: h.low,
    close: h.close,
    volume: h.volume,
  }));

  // Instrument aus der Registry (Fees/Spread/Perpetual-Erkennung); fehlt es,
  // baut die Engine ein neutrales Spot-Default (fail-safe: kein Funding).
  let registryFeeNote = "Registry: kein Eintrag (Default-Gebühren, Spot, kein Funding)";
  const instruments: Record<string, MarketInstrument> = {};
  try {
    const found = getRegistry().get(instrumentId);
    if (found) {
      instruments[instrumentId] = found;
      registryFeeNote =
        `Registry: ${found.id} (Maker ${(found.makerFee * 100).toFixed(3)} %, ` +
        `Taker ${(found.takerFee * 100).toFixed(3)} %, ${found.marketType})`;
    }
  } catch (e) {
    console.warn(`[run-backtest] Registry nicht lesbar (${e instanceof Error ? e.message : String(e)}) — Default-Instrument.`);
  }

  // DIESELBEN Quellen wie der Paper-Betrieb: kalibrierter Simulator + Funding.
  const simulator = calibrateSimulatorConfig(loadSimulatorConfig());
  const funding = loadFundingConfig();
  const strategies: BacktestStrategyItem[] = [{ type: "rule", spec: replaySpec, id: `RULE-${spec.symbol}` }];

  // RMA-P2-02: Funding-Satz aus der kanonischen Perp-Historie statt des
  // statischen Umgebungs-Satzes — as-of dem Bar-Zeitstempel
  // (`available_at <= asOfMs`), damit kein Backtest-Satz aus der Zukunft
  // gebucht wird. Nur bei `PERP_DATA_ENABLED=true`; sonst bleibt der Lauf
  // bit-identisch zu v1.53.0 (statischer Default). Liefert die Ablage für ein
  // Symbol nichts, fällt die Engine pro Bar auf den dokumentierten
  // Umgebungs-Satz zurück und sagt es einmal laut.
  let perpFunding: ReturnType<typeof createPerpFundingRateProvider> | null = null;
  if (perpDataEnabled() && executionModel === "paper") {
    try {
      const perpConfig = loadPerpConfig();
      const venue = instrumentId.includes(":") ? instrumentId.slice(0, instrumentId.indexOf(":")) : null;
      const registry = getRegistry();
      perpFunding = createPerpFundingRateProvider({
        source: getPerpDataService().store,
        config: perpConfig,
        instrumentOf: (symbol) => {
          const key = String(symbol).toUpperCase();
          return (
            instruments[key] ??
            registry.get(key) ??
            (venue === null ? null : registry.get(`${venue}:${key}`)) ??
            null
          );
        },
        warn: (line) => console.warn(`[run-backtest] ${line}`),
      });
      await perpFunding.load({
        // Engine-Symbol ist je nach Lauf der Instrument-Key oder das
        // Regel-Symbol — beide Adressen füllen denselben Cache-Eintrag.
        symbols: [instrumentId, spec.symbol],
        fromMs: candles[0].time,
        toMs: candles[candles.length - 1].time,
      });
      const loaded = perpFunding.stats();
      console.log(
        `[run-backtest] Funding: kanonische Perp-Historie (${loaded.symbols} Symbol(e) mit Reihen, ` +
          `Fenster ${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length - 1].time).toISOString()})` +
          (loaded.symbols === 0 ? ` — Ablage leer, Engine nutzt den Umgebungs-Default ${funding.ratePctPer8h} %/8h.` : ".")
      );
    } catch (error) {
      perpFunding = null;
      console.warn(
        `[run-backtest] Funding-Historie nicht lesbar (${
          error instanceof Error ? error.message.slice(0, 160) : "unbekannter Fehler"
        }) — Backtest läuft mit dem statischen Satz (${funding.ratePctPer8h} %/8h).`
      );
    }
  }

  // RMA-P1-01: Event-Replay lädt punktgenaue FUNDING_DUE-Ereignisse aus der
  // kanonischen Perp-Historie (as-of über `available_at` der Zeilen — der
  // Replayer bucht ein Ereignis erst, wenn es bekannt sein durfte). Ohne
  // PERP_DATA_ENABLED bleibt die Ereignisliste leer: Funding fehlt dann
  // SICHTBAR (Coverage `fundingEvents: 0`), es wird nie ein statischer Satz
  // still untergeschoben.
  const replayEvents: ReplayInputEvent[] = [];
  if (executionModel === "event_replay" && perpDataEnabled()) {
    try {
      const perpConfig = loadPerpConfig();
      const registryInstrument = instruments[instrumentId] ?? null;
      if (registryInstrument && registryInstrument.marketType === "perpetual") {
        const { queryPerpSeries, PERP_LIMITS, perpRowIsAttestable } = await import("../src/perpdata/index");
        const response = await queryPerpSeries(
          getPerpDataService().store,
          {
            instruments: [registryInstrument.id],
            kinds: ["funding"],
            fromMs: candles[0].time,
            toMs: candles[candles.length - 1].time,
            asOfMs: candles[candles.length - 1].time,
            limit: PERP_LIMITS.queryRowsPerSeries,
          },
          { config: perpConfig, nowMs: Date.now() }
        );
        const venue = instrumentId.includes(":") ? instrumentId.slice(0, instrumentId.indexOf(":")) : "PAPER";
        for (const serie of response.series) {
          const rows = (serie.rows as import("../src/perpdata/index").PerpFundingRow[]).filter(perpRowIsAttestable);
          const converted = perpFundingRowsToReplayEvents({
            engineSymbol: instrumentId,
            venue,
            rows,
            defaultIntervalHours: perpConfig.fundingIntervalHours,
          });
          replayEvents.push(...converted.events);
          if (converted.skipped > 0) {
            console.warn(`[run-backtest] Replay-Funding: ${converted.skipped} Zeile(n) ohne belegbare Rate übersprungen (fail-closed).`);
          }
        }
        console.log(`[run-backtest] Replay-Funding: ${replayEvents.length} FUNDING_DUE-Ereignis(se) aus der Perp-Historie.`);
      } else {
        console.log(`[run-backtest] Replay-Funding: ${instrumentId} ist kein Registry-Perpetual — keine Funding-Ereignisse (Spot-Semantik).`);
      }
    } catch (error) {
      console.warn(
        `[run-backtest] Replay-Funding-Historie nicht lesbar (${
          error instanceof Error ? error.message.slice(0, 160) : "unbekannter Fehler"
        }) — Lauf ohne FUNDING_DUE-Ereignisse (sichtbar in coverage.fundingEvents).`
      );
    }
  } else if (executionModel === "event_replay") {
    console.log("[run-backtest] Replay-Funding: PERP_DATA_ENABLED=false — keine Funding-Ereignisse (coverage.fundingEvents = 0).");
  }

  let report: WalkForwardReport;
  try {
    report = runWalkForward({
      instrumentId,
      timeframe,
      candles,
      strategies,
      ruleRef: {
        ruleId,
        ruleKey: null,
        name: spec.name,
        signature: ruleSignature(spec),
        ruleSymbol: spec.symbol,
      },
      engineConfig:
        executionModel === "event_replay"
          ? {
              timeframe,
              executionModel: "event_replay",
              replay: {
                seed: replaySeed,
                latency: { decisionToSubmitMs: 0, submitToArrivalMs: replayLatencyMs },
                instruments,
                events: replayEvents,
              },
            }
          : {
              timeframe,
              executionModel: "paper",
              paper: {
                simulator,
                instruments,
                fundingRatePctPer8h: funding.ratePctPer8h,
                fundingIntervalHours: funding.intervalHours,
                ...(perpFunding ? { fundingRateProvider: perpFunding } : {}),
              },
            },
      walkforward: { isDays, oosDays, maxSpanDays: wfBase.maxSpanDays },
      nowMs: Date.now(),
    });
  } catch (e) {
    if (e instanceof WalkForwardError) fail(`${e.code} — ${e.message}`);
    if (e instanceof EventReplayError) fail(`${e.code} — ${e.message}`);
    throw e;
  }
  if (report.replayEvidence) {
    const ev = report.replayEvidence;
    console.log(
      `[run-backtest] Replay-Evidenz: Modell ${ev.config.frictionModelVersion}, Seed ${ev.config.seed}, ` +
        `Coverage bars=${ev.coverage.bars} funding=${ev.coverage.fundingApplied}/${ev.coverage.fundingEvents} ` +
        `fills(depth=${ev.coverage.fillsFromDepth}, fallback=${ev.coverage.fillsFromBarVolumeFallback}); ` +
        `degradiert: ${ev.degradedReasons.length > 0 ? ev.degradedReasons.join(", ") : "keine"}`
    );
  }

  console.log(`[run-backtest] ${registryFeeNote}`);
  if (perpFunding !== null) {
    const stats = perpFunding.stats();
    console.log(
      `[run-backtest] Funding-Treffer: ${stats.hits} genutzt, ${stats.misses} ohne historischen Satz ` +
        `(Engine-Default ${funding.ratePctPer8h} %/8h) — Details: docs/PERPETUAL_DATA.md`
    );
  }
  console.log(
    `[run-backtest] ${report.walkforward.windowCount} Fenster, OOS: ${report.aggregateOos.trades} Trades, PnL ${report.aggregateOos.pnl} (Ledger netto ${report.aggregateOos.netPnl}), Win-Rate ${report.aggregateOos.winRate} %, ${report.trades.length} Trade-Zeilen gesamt`
  );

  const idempotencyKey =
    typeof args["idempotency-key"] === "string" ? (args["idempotency-key"] as string).trim() : backtestRunIdempotencyKey(report);
  console.log(`[run-backtest] Idempotency-Key: ${idempotencyKey}`);

  const writeArtifacts = (runId: string): { jsonPath: string; mdPath: string } => {
    const dir = resolveRuntimePath("data/backtest");
    mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, `${runId}.json`);
    const mdPath = path.join(dir, `${runId}.md`);
    writeFileSync(jsonPath, JSON.stringify({ runId, idempotencyKey, ...report }, null, 2), "utf8");
    writeFileSync(mdPath, renderMarkdown(runId, report), "utf8");
    return { jsonPath, mdPath };
  };

  const candidateRunId = randomUUID();
  if (args["skip-db"] === true) {
    const { jsonPath, mdPath } = writeArtifacts(candidateRunId);
    console.log(`[run-backtest] Artefakte: ${jsonPath}, ${mdPath}`);
    console.log("[run-backtest] --skip-db: keine Persistenz (kein backtest_runs-/backtest_trades-Write).");
    return;
  }

  try {
    const persisted = await persistBacktestRun({ report, spec: replaySpec, runId: candidateRunId, idempotencyKey });
    const { jsonPath, mdPath } = writeArtifacts(persisted.id);
    console.log(`[run-backtest] Artefakte: ${jsonPath}, ${mdPath}`);
    if (persisted.created) {
      console.log(
        `[run-backtest] backtest_runs-Zeile ${persisted.id} + ${persisted.tradeCount} backtest_trades (atomar, Ledger ${persisted.reconciliation.status}).`
      );
    } else {
      console.log(
        `[run-backtest] Idempotent: Lauf war bereits als Run ${persisted.id} persistiert (${persisted.tradeCount} Trades) — kein zweiter Write.`
      );
    }
  } catch (e) {
    // Keine DB-Zeile entstanden (Transaktion zurückgerollt). Die Artefakte
    // werden trotzdem geschrieben (durable Evidenz) — der Fehler bleibt laut.
    const { jsonPath, mdPath } = writeArtifacts(candidateRunId);
    const code = e instanceof TradeLedgerError || e instanceof BacktestPersistenceError ? `${e.code} — ` : "";
    console.error(
      `[run-backtest] FEHLER: Persistenz abgelehnt/fehlgeschlagen (${code}${e instanceof Error ? e.message : String(e)}). Kein Run, keine Trade-Zeile geschrieben; Artefakte: ${jsonPath}, ${mdPath}.`
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[run-backtest] FEHLER: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
