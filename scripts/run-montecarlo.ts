#!/usr/bin/env node
/**
 * CLI für reproduzierbare Monte-Carlo-/Trade-Resampling-Analysen
 * (RMA-P6-02, v1.72.0).
 *
 * Simuliert aus dem persistenten Trade-Ledger eines Walk-Forward-Runs
 * (`backtest_runs` + `backtest_trades`, RMA-P1-04) IID- und blockweise
 * Resamples sowie explizite Kostenstressszenarien und berichtet robuste
 * Quantile (p05/p50/p95) für Drawdown, Ruin, Sharpe, End-Equity und Losing
 * Streak — deterministisch aus Seed + Config + unveränderlicher Quelle.
 *
 *   - Quelle: NUR Runs mit RECONCILED-Ledger (Alt-Runs vor v1.52.0 werden
 *     fail-closed abgelehnt); Segment-Filter IS/OOS/ALL (Default OOS).
 *   - Persistenz: EINE Zeile `backtest_monte_carlo_runs`, idempotent über den
 *     abgeleiteten Key `mcs1:<sha256>` (NICHT überschreibbar) — Retry liefert
 *     die bestehende Analyse, keine Dublette. Gespeichert wird NUR die
 *     bounded Summary; Rohpfade bleiben im Speicher.
 *   - Artefakte: `data/montecarlo/<analysisId>.json` (vollständiges Result
 *     inkl. Config — Grundlage für Replay) + `<analysisId>.md` via
 *     `resolveRuntimePath()`.
 *
 * Aufruf:
 *   node --import tsx scripts/run-montecarlo.ts --run=<uuid> \
 *     [--method=iid|moving_block|stationary_block] [--seed=1] [--runs=1000] \
 *     [--block-length=10] [--segment=OOS] [--initial-equity=10000] \
 *     [--ruin-threshold-pct=50] [--stress-fee-mult=2] [--stress-slip-mult=3] \
 *     [--skip-db] [--json]
 *
 * Doku: docs/MONTE_CARLO.md (Modell, Formeln, Grenzen, Rollback).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  loadMonteCarloSample,
  MonteCarloStoreError,
  runMonteCarloAnalysis,
} from "../src/backtest/monteCarloStore";
import {
  MC_MIN_SAMPLE_TRADES,
  MC_RUNS_BOUNDS,
  MC_STRESS_MULTIPLIER_BOUNDS,
  MonteCarloError,
  runMonteCarloSimulation,
  type MonteCarloConfig,
  type MonteCarloMetricSummary,
  type MonteCarloMethod,
  type MonteCarloResult,
  type MonteCarloSegmentFilter,
} from "../src/backtest/montecarlo";
import { resolveRuntimePath } from "../src/lib/appPaths";

const USAGE = `Monte-Carlo-/Trade-Resampling (RMA-P6-02).

Aufruf:
  node --import tsx scripts/run-montecarlo.ts --run=<uuid>
    [--method=iid|moving_block|stationary_block] [--seed=<int>] [--runs=<int>]
    [--block-length=<int>] [--segment=OOS|IS|ALL]
    [--initial-equity=<float>] [--ruin-threshold-pct=<float>]
    [--stress-fee-mult=<float>] [--stress-slip-mult=<float>]
    [--skip-db] [--json]

Pflicht:
  --run                  UUID des Quell-Walk-Forward-Runs (backtest_runs; muss
                         ein RECONCILED-Trade-Ledger haben, mindestens
                         ${MC_MIN_SAMPLE_TRADES} Trades im gewählten Segment)

Optional:
  --method               Resampling-Methode (Default: iid)
  --seed                 uint32-Seed (Default 1) — deterministische Basis
  --runs                 Anzahl Pfade [${MC_RUNS_BOUNDS.min}, ${MC_RUNS_BOUNDS.max}] (Default ${MC_RUNS_BOUNDS.default})
  --block-length         Blocklänge für moving_block/stationary_block
                         (Pflicht dort; 2..Stichprobengröße)
  --segment              Segment-Filter der Quelle (Default OOS — empfohlene
                         Basis; IS/ALL möglich)
  --initial-equity       Startkapital der Pfade (Default 10000)
  --ruin-threshold-pct   Ruin-Schwelle in % des Startkapitals (Default 50)
  --stress-fee-mult      Kostenstress: Gebühren-Multiplikator
                         [${MC_STRESS_MULTIPLIER_BOUNDS.min}, ${MC_STRESS_MULTIPLIER_BOUNDS.max}]
  --stress-slip-mult     Kostenstress: Slippage-Multiplikator (analog)
                         (mindestens einer der beiden > 1, sonst Basisszenario)
  --skip-db              Analysenzeile NICHT persistieren (Quelle wird trotzdem
                         aus der DB gelesen; Artefakte werden geschrieben)
  --json                 maschinenlesbare Ausgabe des vollständigen Results
                         (inkl. Config — Replay-Grundlage)

Ausgabe: data/montecarlo/<analysisId>.json + <analysisId>.md; DB:
backtest_monte_carlo_runs (bounded Summary, idempotent).
API: GET /api/firm/montecarlo?run=<uuid> und /api/firm/montecarlo/<id>.
Doku: docs/MONTE_CARLO.md.`;

function fail(message: string): never {
  console.error(`[run-montecarlo] FEHLER: ${message}`);
  console.error(`[run-montecarlo] Nutzung: scripts/run-montecarlo.ts --help`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (arg.startsWith("--")) {
      out[arg.slice(2)] = true;
    } else {
      fail(`Unbekanntes Argument: ${arg}`);
    }
  }
  return out;
}

function numberArg(args: Record<string, string | boolean>, name: string): number | undefined {
  const raw = args[name];
  if (raw === undefined || raw === true) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name}: keine endliche Zahl (${raw}).`);
  return n;
}

function renderMarkdown(analysisId: string, runId: string, persisted: boolean, result: MonteCarloResult): string {
  const s = result.summary;
  const q = (m: MonteCarloMetricSummary) => `${m.p05} | ${m.p50} | ${m.p95} | ${m.mean}`;
  const lines = [
    `# Monte-Carlo-Analyse ${analysisId}`,
    "",
    `- Quell-Run: \`${runId}\``,
    `- Methode: \`${s.stats.method}\`${s.stats.blockLength !== null ? ` (Blocklänge ${s.stats.blockLength})` : ""}`,
    `- Szenario: **${s.stats.scenario}**${s.stats.stress !== null ? ` (fee×${s.stats.stress.feeMultiplier}, slippage×${s.stats.stress.slippageMultiplier})` : ""}`,
    `- Seed: ${s.stats.seed} (PRNG \`${s.stats.prngAlgorithm}\`, Algorithmus \`${s.stats.algorithmVersion}\`)`,
    `- Stichprobe: ${s.stats.sampleTrades} Trades (Segment ${result.config.segment}), Horizont ${s.stats.horizonTrades}, Pfade: ${s.stats.runs}, Blöcke gesamt: ${s.stats.blocksDrawn}`,
    `- Annualisierung: ${s.stats.annualizationTradesPerYear} Trades/Jahr`,
    `- Persistenz: ${persisted ? "idempotent geschrieben" : "--skip-db (nur Artefakte)"}`,
    `- Idempotency-Key: \`${result.idempotencyKey}\``,
    `- Eingabe-Hash: \`${result.inputTradesHash}\``,
    "",
    "## Empirische Beobachtung (Original-Sequenz, keine Resamples)",
    "",
    `| Kennzahl | Wert |`,
    `|---|---|`,
    `| End-Equity | ${s.observed.endEquity} |`,
    `| MaxDD | ${s.observed.maxDrawdownPct} % |`,
    `| Losing Streak | ${s.observed.losingStreak} |`,
    `| Sharpe (annualisiert) | ${s.observed.sharpeRatio} |`,
    `| Ruiniert (< ${result.config.ruinThresholdPct} % des Startkapitals) | ${s.observed.ruined ? "JA" : "nein"} |`,
  ];
  if (s.observedStressed !== null) {
    lines.push(
      "",
      "## Beobachtung unter Kostenstress (Original-Sequenz, kein Resampling)",
      "",
      `| Kennzahl | Wert |`,
      `|---|---|`,
      `| End-Equity | ${s.observedStressed.endEquity} |`,
      `| MaxDD | ${s.observedStressed.maxDrawdownPct} % |`,
      `| Losing Streak | ${s.observedStressed.losingStreak} |`,
      `| Ruiniert | ${s.observedStressed.ruined ? "JA" : "nein"} |`
    );
  }
  lines.push(
    "",
    "## Resampling-Verteilung (Szenario)",
    "",
    `| Metrik | p05 | p50 | p95 | mean |`,
    `|---|---|---|---|---|`,
    `| End-Equity | ${q(s.resampled.endEquity)} |`,
    `| MaxDD (%) | ${q(s.resampled.maxDrawdownPct)} |`,
    `| Sharpe | ${q(s.resampled.sharpeRatio)} |`,
    `| Losing Streak | ${q(s.resampled.losingStreak)} |`,
    "",
    "## Exceedance-Wahrscheinlichkeiten",
    "",
    `| Ereignis | Wahrscheinlichkeit | MCSE |`,
    `|---|---|---|`,
    `| Ruin (< ${result.config.ruinThresholdPct} % Startkapital) | ${s.resampled.exceedance.ruinProbability} | ${s.resampled.mcse.ruinProbability} |`,
    `| End-Equity < Startkapital | ${s.resampled.exceedance.endBelowStartProbability} | ${s.resampled.mcse.endBelowStartProbability} |`,
    ...s.resampled.exceedance.maxDrawdownGtePct.map(
      (x) => `| MaxDD ≥ ${x.thresholdPct} % | ${x.probability} | — |`
    ),
    "",
    "## Grenzen",
    "",
    ...s.caveats.map((c) => `- ${c}`),
    "",
    "Quantile sind Nearest-Rank-Schätzer über die Resampling-Verteilung —",
    "conditional auf Stichprobe, Methode und Annahmen. Sie sind KEINE Garantie",
    "und KEINE Grundlage für eine Live-Risikofreigabe (RMA-P6-02-Grenze).",
    ""
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const runIdRaw = args["run"];
  if (
    typeof runIdRaw !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runIdRaw.trim().toLowerCase())
  ) {
    fail("--run=<uuid> ist Pflicht (UUID des Quell-Walk-Forward-Runs).");
  }
  const runId = runIdRaw.trim().toLowerCase();

  const methodRaw = typeof args["method"] === "string" ? (args["method"] as string) : "iid";
  if (methodRaw !== "iid" && methodRaw !== "moving_block" && methodRaw !== "stationary_block") {
    fail(`--method: unbekannte Methode '${methodRaw}' (iid | moving_block | stationary_block).`);
  }
  const method = methodRaw as MonteCarloMethod;

  const segmentRaw = typeof args["segment"] === "string" ? (args["segment"] as string).toUpperCase() : "OOS";
  if (segmentRaw !== "OOS" && segmentRaw !== "IS" && segmentRaw !== "ALL") {
    fail(`--segment: unbekanntes Segment '${segmentRaw}' (OOS | IS | ALL).`);
  }
  const segment = segmentRaw as MonteCarloSegmentFilter;

  const seed = numberArg(args, "seed");
  const runs = numberArg(args, "runs");
  const blockLength = numberArg(args, "block-length");
  const initialEquity = numberArg(args, "initial-equity");
  const ruinThresholdPct = numberArg(args, "ruin-threshold-pct");
  const stressFeeMult = numberArg(args, "stress-fee-mult");
  const stressSlipMult = numberArg(args, "stress-slip-mult");

  let stress: MonteCarloConfig["stress"] = null;
  if (stressFeeMult !== undefined || stressSlipMult !== undefined) {
    stress = {
      feeMultiplier: stressFeeMult ?? 1,
      slippageMultiplier: stressSlipMult ?? 1,
    };
  }

  const config: MonteCarloConfig = {
    method,
    ...(seed !== undefined ? { seed } : {}),
    ...(runs !== undefined ? { runs } : {}),
    ...(blockLength !== undefined ? { blockLength } : {}),
    segment,
    ...(initialEquity !== undefined ? { initialEquity } : {}),
    ...(ruinThresholdPct !== undefined ? { ruinThresholdPct } : {}),
    stress,
  };

  const writeArtifacts = (analysisId: string, persisted: boolean, result: MonteCarloResult): { jsonPath: string; mdPath: string } => {
    const dir = resolveRuntimePath("data/montecarlo");
    mkdirSync(dir, { recursive: true });
    const jsonPath = path.join(dir, `${analysisId}.json`);
    const mdPath = path.join(dir, `${analysisId}.md`);
    writeFileSync(jsonPath, JSON.stringify({ analysisId, ...result }, null, 2), "utf8");
    writeFileSync(mdPath, renderMarkdown(analysisId, runId, persisted, result), "utf8");
    return { jsonPath, mdPath };
  };

  const candidateId = randomUUID();

  if (args["json"] === true) {
    // Maschinenlesbarer Modus: vollständiges Result (inkl. Config für Replay).
    const analysis = await runMonteCarloAnalysis({ runId, config, analysisId: candidateId });
    const { jsonPath, mdPath } = writeArtifacts(analysis.id, analysis.created, analysis.result);
    process.stdout.write(
      JSON.stringify(
        { ok: true, analysisId: analysis.id, created: analysis.created, artifact: jsonPath, artifactMd: mdPath, ...analysis.result },
        null,
        2
      )
    );
    process.stdout.write("\n");
    return;
  }

  console.log(
    `[run-montecarlo] Quelle: Run ${runId} (Segment ${segment}), Methode ${method}${blockLength !== undefined ? ` (Blocklänge ${blockLength})` : ""}.`
  );
  if (stress !== null) {
    console.log(
      `[run-montecarlo] Kostenstress-Szenario: Gebühren ×${stress.feeMultiplier}, Slippage ×${stress.slippageMultiplier} (First-Order auf fester Sequenz und Exposurebasis).`
    );
  }

  try {
    if (args["skip-db"] === true) {
      const sample = await loadMonteCarloSample(runId, config.segment ?? "OOS");
      const result = runMonteCarloSimulation({ sourceRunId: runId, trades: sample.trades, config });
      const { jsonPath, mdPath } = writeArtifacts(candidateId, false, result);
      console.log(`[run-montecarlo] Artefakte: ${jsonPath}, ${mdPath}`);
      console.log("[run-montecarlo] --skip-db: keine Persistenz (kein backtest_monte_carlo_runs-Write).");
      console.log(
        `[run-montecarlo] Stichprobe ${result.summary.stats.sampleTrades} Trades | Pfade ${result.summary.stats.runs} | Szenario ${result.summary.stats.scenario} | Seed ${result.summary.stats.seed}`
      );
      return;
    }

    const analysis = await runMonteCarloAnalysis({ runId, config, analysisId: candidateId });
    const { jsonPath, mdPath } = writeArtifacts(analysis.id, analysis.created, analysis.result);
    console.log(`[run-montecarlo] Artefakte: ${jsonPath}, ${mdPath}`);
    if (analysis.created) {
      console.log(
        `[run-montecarlo] backtest_monte_carlo_runs-Zeile ${analysis.id} geschrieben (Idempotency-Key ${analysis.idempotencyKey}).`
      );
    } else {
      console.log(`[run-montecarlo] Idempotent: Analyse existierte bereits als ${analysis.id} — kein zweiter Write.`);
    }
    const s = analysis.result.summary;
    console.log(
      `[run-montecarlo] Stichprobe ${s.stats.sampleTrades} Trades | Pfade ${s.stats.runs} | Szenario ${s.stats.scenario} | Seed ${s.stats.seed} (${s.stats.prngAlgorithm})`
    );
    console.log(
      `[run-montecarlo] End-Equity p05/p50/p95: ${s.resampled.endEquity.p05} / ${s.resampled.endEquity.p50} / ${s.resampled.endEquity.p95}` +
        ` | MaxDD p95: ${s.resampled.maxDrawdownPct.p95} % | Ruin: ${s.resampled.exceedance.ruinProbability} (MCSE ${s.resampled.mcse.ruinProbability})` +
        ` | Losing Streak p95: ${s.resampled.losingStreak.p95}`
    );
    console.log(`[run-montecarlo] Grenzen: ${s.caveats.join("; ")}`);
  } catch (e) {
    const code = e instanceof MonteCarloError || e instanceof MonteCarloStoreError ? `${e.code} — ` : "";
    console.error(`[run-montecarlo] FEHLER: ${code}${e instanceof Error ? e.message : String(e)}`);
    console.error("[run-montecarlo] Keine Analysenzeile geschrieben.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[run-montecarlo] FEHLER: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
