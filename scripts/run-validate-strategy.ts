#!/usr/bin/env node
/**
 * Validierungs-CLI (STX-06-04) — der einzige Pfad, der ein Validierungsergebnis
 * **aufschreibt**.
 *
 *   npm run validate:strategy -- --strategy-version-id=<uuid> --from=2026-01-01 --to=2026-09-01
 *   npm run validate:strategy -- --create --template=rsi-mean-reversion \
 *     --symbol=BITUNIX:BTCUSDT --timeframe=1h --from=… --to=… --params='{"rsiPeriod":14}'
 *   npm run validate:strategy -- … --params='[{...},{...}]'   # Nachbarschafts-Scan
 *
 * ── Was die CLI tut ────────────────────────────────────────────────────────
 * 1. Strategie-Version auflösen (`--strategy-version-id`) **oder** anlegen
 *    (`--create`, idempotent über den Fingerprint).
 * 2. Kerzen aus dem `HistoricalStore` laden, einen Walk-Forward-Lauf fahren
 *    (`runWalkForward`), die 06-02-Auswertung (Plateau, Lücke,
 *    Multiple Testing, Holdout-Integrität) und den 06-03-Stress-Sweep
 *    anwenden und die Regime-Aggregation (06-04, point-in-time) bilden.
 * 3. Den Annahmen-Audit (06-01) aus den Lauf-Fakten speisen, den
 *    `StrategyValidationReport` bauen und ausgeben (`--out`).
 * 4. Die Evidenz über den Lifecycle schreiben — außer `--no-write`.
 *
 * ── Was die CLI NICHT tut ──────────────────────────────────────────────────
 * - **Keine Promotion:** kein `requestTransition`, keine Zustandsänderung.
 * - **Kein LLM** (das ist 06-05).
 * - **Keine erfundenen Fakten:** Spread/Buchtiefe aus dem Lauf werden nicht
 *   rekonstruiert; ohne sie bleibt der Audit ehrlich `UNKNOWN` ⇒
 *   `INCONCLUSIVE`. Ein Lauf, der PASS braucht, braucht echte
 *   Orderbuch-Fakten (programmatischer Aufruf).
 *
 * Exit-Codes: 0 = PASS, 1 = FAIL/INCONCLUSIVE oder Laufzeitfehler,
 * 2 = Bedienfehler.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { and, eq, gte, lte } from "drizzle-orm";

import { db } from "../src/db";
import { regimeSnapshots, strategyDefinitions } from "../src/db/schema";
import {
  runWalkForward,
  loadWalkForwardConfig,
} from "../src/backtest/walkforward";
import type {
  WalkForwardCandidate,
  WalkForwardReport,
} from "../src/backtest/walkforward";
import type { BacktestStrategyItem } from "../src/backtest";
import { DEFAULT_BACKTEST_CONFIG } from "../src/backtest/engine";
import { APP_VERSION } from "../src/lib/version";
import { toConsoleAscii } from "../src/lib/consoleFormat";
import {
  HistoricalStore,
  isSupportedTimeframe,
  SUPPORTED_TIMEFRAME_MS,
} from "../src/lib/marketdata/historicalStore";
import type { SupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import type { CandleLike, RuleSpec } from "../src/lib/ruleEngine";
import { getTemplate, isStrategyTemplateId, STRATEGY_TEMPLATES } from "../src/strategies/catalog";
import { compileTemplate } from "../src/strategies/compiler";
import {
  createVersion,
  ensureDefinition,
  resolveStrategyKey,
  strategyKeyFor,
} from "../src/strategies/service";
import {
  auditAssumptions,
} from "../src/strategies/validator/assumptions";
import {
  holdoutIntegrity,
  multipleTestingWarning,
  plateauMetrics,
  trainOosGap,
} from "../src/strategies/validator/overfit";
import {
  DEFAULT_MAX_STRESS_RUNS,
  MAX_STRESS_CANDIDATES,
  MAX_STRESS_SCENARIOS,
  MAX_STRESS_WINDOWS,
  parseMaxRunsFlag,
  runInEngineStress,
} from "../src/strategies/validator/stress";
import {
  buildValidationReport,
  type RegimeSnapshotFact,
  type RegimeTradeFact,
  type StrategyValidationReport,
} from "../src/strategies/validator/report";
import { writeValidationEvidenceDetailed } from "../src/strategies/validator/persist";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Argument-Parsing (rein, ohne Side-Effects)
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidateCliOptions {
  readonly template: string | null;
  /** 1..n Parametersätze; der erste ist die Referenz der Version. */
  readonly params: readonly Readonly<Record<string, number>>[];
  readonly timeframe: SupportedTimeframe | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly symbol: string | null;
  readonly strategyVersionId: string | null;
  readonly create: boolean;
  readonly maxRuns: number;
  readonly out: string | null;
  readonly noWrite: boolean;
  readonly holdoutDays: number;
  readonly embargoHours: number;
  readonly help: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `Validierungs-CLI (STX-06-04) — Report + Evidenz, deterministisch.

Aufruf:
  npm run validate:strategy -- --strategy-version-id=<uuid> --from=<ISO|ms> --to=<ISO|ms> [Optionen]
  npm run validate:strategy -- --create --template=<id> --symbol=<id> --timeframe=<tf> \\
      --from=<ISO|ms> --to=<ISO|ms> [--params=<json>] [Optionen]

Genau eine Quelle:
  --strategy-version-id  Bestehende \`strategy_versions\`-Zeile prüfen.
  --create               Neue Version anlegen (idempotent über den Fingerprint;
                         braucht --template/--symbol/--timeframe).

Daten & Auswertung:
  --params=<json>        Objekt ODER Array von Objekten (Nachbarschafts-Scan).
                         Der erste Satz ist die Referenz-/Versions-Parametrierung.
  --symbol=<id>          Instrument (z. B. BITUNIX:BTCUSDT); bei
                         --strategy-version-id aus der Regel abgeleitet.
  --timeframe=<tf>       Kerzentakt; bei --strategy-version-id aus der Version.
  --from/--to=<ISO|ms>   Auswertungsfenster (Pflicht).
  --max-runs=N           Hartes Laufzeit-Budget des Stress-Sweeps (Default ${DEFAULT_MAX_STRESS_RUNS});
                         Obergrenze: ${MAX_STRESS_SCENARIOS} Szenarien x ${MAX_STRESS_WINDOWS} Fenster x ${MAX_STRESS_CANDIDATES} Kandidaten.
  --holdout-days=N       Unberührter Holdout in Tagen (Default 0 = keiner).
                         PASS braucht einen Holdout; ohne ihn ist die Integrität UNKNOWN.
  --embargo-hours=N      Embargo zwischen IS und OOS (Default 0).

Ausgabe & Persistenz:
  --out=<pfad>           Report als JSON schreiben.
  --no-write             Nur Report ausgeben, KEINE Evidenz schreiben.
  --help, -h             Diese Hilfe.

Exit-Codes: 0 = PASS, 1 = FAIL/INCONCLUSIVE oder Fehler, 2 = Bedienfehler.
Doku: docs/STRATEGY_VALIDATION.md (Teil 4).`;

function fail(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

function parseTimestamp(raw: string): number | null {
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseParams(raw: string): { ok: true; params: Readonly<Record<string, number>>[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "--params ist kein gültiges JSON." };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) return { ok: false, error: "--params: mindestens ein Parametersatz erwartet." };
  const params: Record<string, number>[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "--params: jeder Parametersatz muss ein Objekt sein." };
    }
    const record: Record<string, number> = {};
    for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `--params: „${key}" muss eine endliche Zahl sein.` };
      }
      record[key] = value;
    }
    params.push(Object.freeze(record));
  }
  return { ok: true, params };
}

/** Reines Parsing — jeder Bedienfehler wird vor IO abgelehnt. */
export function parseValidateArgs(
  argv: readonly string[],
): { ok: true; parsed: ValidateCliOptions } | { ok: false; error: string } {
  let template: string | null = null;
  let params: Readonly<Record<string, number>>[] = [];
  let timeframe: SupportedTimeframe | null = null;
  let from: string | null = null;
  let to: string | null = null;
  let symbol: string | null = null;
  let strategyVersionId: string | null = null;
  let create = false;
  let out: string | null = null;
  let noWrite = false;
  let holdoutDays = 0;
  let embargoHours = 0;
  let maxRuns: number = DEFAULT_MAX_STRESS_RUNS;
  let help = false;

  const maxRunsResult = parseMaxRunsFlag(argv, DEFAULT_MAX_STRESS_RUNS);
  if (!maxRunsResult.ok) return fail(maxRunsResult.errors[0] ?? "stress:invalid-max-runs");
  maxRuns = maxRunsResult.maxRuns;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--create") {
      create = true;
      continue;
    }
    if (arg === "--no-write") {
      noWrite = true;
      continue;
    }
    // `--max-runs` (beide Formen) ist bereits über `parseMaxRunsFlag` gelesen.
    if (arg === "--max-runs") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--max-runs=")) continue;
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) {
      return fail(`unbekanntes Argument "${arg.slice(0, 60)}" (erwartet --flag=wert).`);
    }
    const [, name, raw] = match;
    switch (name) {
      case "template": {
        if (!isStrategyTemplateId(raw)) {
          return fail(
            `--template: unbekannte Template-ID "${raw.slice(0, 40)}". Erlaubt: ${STRATEGY_TEMPLATES.map((t) => t.id).join(", ")}`,
          );
        }
        template = raw;
        break;
      }
      case "timeframe": {
        if (!isSupportedTimeframe(raw)) return fail(`--timeframe: unbekannter Takt "${raw.slice(0, 20)}".`);
        timeframe = raw;
        break;
      }
      case "from":
        from = raw;
        break;
      case "to":
        to = raw;
        break;
      case "symbol":
        symbol = raw.trim() === "" ? null : raw.trim();
        break;
      case "strategy-version-id": {
        if (!UUID_RE.test(raw)) return fail(`--strategy-version-id: "${raw.slice(0, 40)}" ist keine UUID.`);
        strategyVersionId = raw;
        break;
      }
      case "out":
        out = raw.trim() === "" ? null : raw.trim();
        break;
      case "holdout-days":
      case "embargo-hours": {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0) {
          return fail(`--${name}: ganze Zahl ≥ 0 erwartet (ist "${raw.slice(0, 20)}").`);
        }
        if (name === "holdout-days") holdoutDays = value;
        else embargoHours = value;
        break;
      }
      case "params": {
        const parsedParams = parseParams(raw);
        if (!parsedParams.ok) return fail(parsedParams.error);
        params = parsedParams.params;
        break;
      }
      default:
        return fail(`unbekanntes Argument "--${name}" (erwartet --flag=wert).`);
    }
  }
  if (help) {
    return {
      ok: true,
      parsed: {
        template, params, timeframe, from, to, symbol, strategyVersionId, create,
        maxRuns, out, noWrite, holdoutDays, embargoHours, help,
      },
    };
  }

  if (create === (strategyVersionId !== null)) {
    return fail("genau eine Quelle wählen: --strategy-version-id=<uuid> ODER --create.");
  }
  if (create && noWrite) {
    return fail("--create legt eine Version an und ist mit --no-write nicht kombinierbar.");
  }
  if (from === null || to === null) return fail("--from und --to sind Pflicht.");
  const fromMs = parseTimestamp(from);
  const toMs = parseTimestamp(to);
  if (fromMs === null || toMs === null) return fail("--from/--to müssen ISO-8601 oder Epoch-ms sein.");
  if (toMs <= fromMs) return fail("--to muss nach --from liegen.");
  if (create && (template === null || symbol === null || timeframe === null)) {
    return fail("--create braucht --template, --symbol und --timeframe.");
  }
  if (params.length > MAX_STRESS_CANDIDATES) {
    return fail(
      `--params: ${params.length} Kandidaten > ${MAX_STRESS_CANDIDATES} (Stress-Bound ${MAX_STRESS_SCENARIOS}×${MAX_STRESS_WINDOWS}×${MAX_STRESS_CANDIDATES} = ${DEFAULT_MAX_STRESS_RUNS}).`,
    );
  }

  return {
    ok: true,
    parsed: {
      template, params, timeframe, from, to, symbol, strategyVersionId, create,
      maxRuns, out, noWrite, holdoutDays, embargoHours, help: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Fachliche Hilfen
// ─────────────────────────────────────────────────────────────────────────────

function say(line: string): void {
  console.log(toConsoleAscii(line));
}

function sayError(line: string): void {
  console.error(toConsoleAscii(line));
}

function isRuleSpecLike(value: unknown): value is RuleSpec {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as RuleSpec).symbol === "string" &&
    !!(value as RuleSpec).condition
  );
}

/** Datenqualitäts-Score der Kerzenreihe: Abdeckung [0,1] über den Zeitraum. */
function seriesCoverage(candles: readonly CandleLike[], fromMs: number, toMs: number, timeframe: SupportedTimeframe): number {
  const step = SUPPORTED_TIMEFRAME_MS[timeframe];
  if (!Number.isFinite(step) || step <= 0) return 0;
  const expected = Math.max(1, Math.floor((toMs - fromMs) / step));
  return Number(Math.min(1, candles.length / expected).toFixed(4));
}

/** Expectancy je Trade aus dem OOS-Aggregat (`netPnl / trades`), sonst null. */
function expectancyOf(netPnl: number, trades: number): number | null {
  if (!Number.isFinite(netPnl) || !Number.isInteger(trades) || trades <= 0) return null;
  return Number((netPnl / trades).toFixed(4));
}

function lastOf<T>(values: readonly T[] | undefined | null): T | null {
  if (!values || values.length === 0) return null;
  return values[values.length - 1] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) CLI-Lauf
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidateCliOutcome {
  readonly exitCode: 0 | 1 | 2;
  readonly report: StrategyValidationReport | null;
  readonly errors: readonly string[];
}

export async function runValidateStrategyCli(argv: readonly string[]): Promise<ValidateCliOutcome> {
  const parsed = parseValidateArgs(argv);
  if (!parsed.ok) {
    sayError(`[validate] FEHLER: ${parsed.error}`);
    sayError("[validate] Nutzung: npm run validate:strategy -- --help");
    return { exitCode: 2, report: null, errors: [parsed.error] };
  }
  const options = parsed.parsed;
  if (options.help) {
    say(USAGE);
    return { exitCode: 0, report: null, errors: [] };
  }

  const fromMs = parseTimestamp(options.from!)!;
  const toMs = parseTimestamp(options.to!)!;
  const codeVersion = APP_VERSION;
  const errors: string[] = [];

  // 1) Strategie-Version auflösen oder anlegen.
  let versionId: string;
  let strategyKey: string;
  let strategyVersionNumber: number;
  let templateId: string;
  let templateVersion: number;
  let timeframe: SupportedTimeframe;
  let symbol: string;
  let referenceSpec: RuleSpec;
  let referenceParams: Readonly<Record<string, number>>;

  if (options.strategyVersionId) {
    const resolved = await resolveStrategyKey(options.strategyVersionId);
    if (!resolved) {
      sayError(`[validate] Version ${options.strategyVersionId} nicht gefunden.`);
      return { exitCode: 1, report: null, errors: ["version:not-found"] };
    }
    const definitionRows = await db
      .select({ templateId: strategyDefinitions.templateId })
      .from(strategyDefinitions)
      .where(eq(strategyDefinitions.id, resolved.versionRow.definitionId))
      .limit(1);
    const foundTemplateId = definitionRows[0]?.templateId ?? null;
    if (!foundTemplateId || !isStrategyTemplateId(foundTemplateId)) {
      sayError("[validate] template_id der Version ist unbekannt/nicht im Katalog.");
      return { exitCode: 1, report: null, errors: ["version:unknown-template"] };
    }
    if (options.template !== null && options.template !== foundTemplateId) {
      sayError(`[validate] --template=${options.template} passt nicht zur Version (${foundTemplateId}).`);
      return { exitCode: 2, report: null, errors: ["template:mismatch"] };
    }
    templateId = foundTemplateId;
    strategyKey = resolved.strategyKey;
    strategyVersionNumber = resolved.strategyVersion;
    versionId = options.strategyVersionId;
    timeframe = resolved.versionRow.timeframe as SupportedTimeframe;
    symbol =
      options.symbol ??
      (isRuleSpecLike(resolved.versionRow.ruleSpecJson) ? resolved.versionRow.ruleSpecJson.symbol : null) ??
      "";
    referenceSpec = resolved.versionRow.ruleSpecJson as unknown as RuleSpec;
    referenceParams =
      resolved.versionRow.paramsJson && typeof resolved.versionRow.paramsJson === "object"
        ? (resolved.versionRow.paramsJson as Record<string, number>)
        : {};
    if (!isRuleSpecLike(referenceSpec)) {
      sayError("[validate] rule_spec_json der Version ist unbrauchbar.");
      return { exitCode: 1, report: null, errors: ["version:invalid-spec"] };
    }
    if (!isSupportedTimeframe(timeframe)) {
      sayError(`[validate] Timeframe der Version ist ungültig (${String(timeframe)}).`);
      return { exitCode: 1, report: null, errors: ["version:invalid-timeframe"] };
    }
    if (symbol === "") {
      sayError("[validate] Symbol nicht ableitbar — bitte --symbol setzen.");
      return { exitCode: 2, report: null, errors: ["symbol:missing"] };
    }
  } else {
    const template = getTemplate(options.template as never);
    if (!template) {
      sayError(`[validate] Template ${options.template} nicht gefunden.`);
      return { exitCode: 2, report: null, errors: ["template:not-found"] };
    }
    templateId = template.id;
    templateVersion = template.version;
    timeframe = options.timeframe!;
    symbol = options.symbol!;
    referenceParams = options.params[0] ?? {};
    const compiled = compileTemplate({
      templateId: template.id,
      symbol,
      timeframe,
      params: referenceParams,
      codeVersion,
    });
    if (!compiled.ok) {
      for (const error of compiled.errors) sayError(`[validate] Kompilierung: ${error}`);
      return { exitCode: 1, report: null, errors: compiled.errors };
    }
    referenceSpec = compiled.spec;
    const definition = await ensureDefinition({
      templateId: template.id,
      strategyClass: template.class,
      name: template.name,
      description: template.description,
    });
    const created = await createVersion({
      definitionId: definition.id,
      templateId: template.id,
      symbol,
      timeframe,
      params: referenceParams,
      codeVersion,
    });
    versionId = created.versionId;
    strategyVersionNumber = created.version;
    strategyKey = strategyKeyFor({ templateId: template.id, version: created.version });
    say(
      `[validate] Version ${created.created ? "angelegt" : "bestehend"}: ${strategyKey} (${versionId})`,
    );
  }

  const template = getTemplate(templateId as never);
  if (!template) {
    sayError(`[validate] Template ${templateId} nicht im Katalog.`);
    return { exitCode: 1, report: null, errors: ["template:not-found"] };
  }
  templateVersion = template.version;

  // 2) Kerzen laden.
  const store = new HistoricalStore();
  const history = store.query({ instrumentId: symbol, timeframe, from: fromMs, to: toMs });
  if (history.length < 2) {
    sayError(
      `[validate] data:no-candles — ${history.length} Kerzen für ${symbol} ${timeframe} im Zeitraum (mind. 2 nötig).`,
    );
    return { exitCode: 1, report: null, errors: ["data:no-candles"] };
  }
  const candles: CandleLike[] = history.map((entry) => ({
    time: entry.ts,
    open: entry.open,
    high: entry.high,
    low: entry.low,
    close: entry.close,
    volume: entry.volume,
  }));

  // 3) Walk-Forward (Referenz + optionaler Nachbarschafts-Scan).
  const engineConfig = { ...DEFAULT_BACKTEST_CONFIG, timeframe };
  const candidateParamSets = options.params.length > 1 ? options.params : [];
  let candidates: WalkForwardCandidate[] | undefined;
  if (candidateParamSets.length > 0) {
    const built: WalkForwardCandidate[] = [];
    for (let index = 0; index < candidateParamSets.length; index += 1) {
      const params = candidateParamSets[index];
      const compiled = compileTemplate({ templateId, symbol, timeframe, params, codeVersion });
      if (!compiled.ok) {
        for (const error of compiled.errors) sayError(`[validate] Kandidat ${index + 1}: ${error}`);
        return { exitCode: 1, report: null, errors: compiled.errors };
      }
      built.push({
        id: `cand-${index + 1}`,
        name: `cand-${index + 1}`,
        config: { ...params },
        strategies: [{ type: "rule", spec: compiled.spec, id: `RULE-${compiled.spec.symbol}` }],
      });
    }
    candidates = built;
  }

  const walkForwardInput = {
    instrumentId: symbol,
    timeframe,
    candles,
    ...(candidates
      ? { candidates, selector: { targetMetric: "sharpeRatio" as const } }
      : { strategies: [{ type: "rule", spec: referenceSpec, id: `RULE-${referenceSpec.symbol}` }] as BacktestStrategyItem[] }),
    ...(options.holdoutDays > 0 ? { holdout: { holdoutDays: options.holdoutDays } } : {}),
    embargoHours: options.embargoHours,
    ruleRef: {
      ruleId: null,
      ruleKey: null,
      name: referenceSpec.name,
      signature: `${templateId}@v${strategyVersionNumber}`,
      ruleSymbol: referenceSpec.symbol,
    },
    engineConfig,
    nowMs: Date.now(),
  };

  let report: WalkForwardReport;
  try {
    report = runWalkForward(walkForwardInput);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    sayError(`[validate] Walk-Forward fehlgeschlagen: ${message}`);
    return { exitCode: 1, report: null, errors: [message] };
  }

  const oos = report.aggregateOos;
  const is = report.aggregateIs;
  const lastFreeze = lastOf(report.freezeArtifacts);
  const selectionCount = report.selection?.candidatesCount ?? (candidates ? candidates.length : 1);

  // 3a) 06-02-Auswertung.
  const gap = trainOosGap({ is, oos });
  const plateau = plateauMetrics(
    (report.freezeArtifacts ?? []).map((freeze) => freeze.scoreTable),
    { selectedCandidateId: lastFreeze?.selectedCandidateId ?? null },
  );
  const integrity = holdoutIntegrity(report.holdout ?? null, lastFreeze ?? null);
  const multipleTesting = multipleTestingWarning(selectionCount);

  // 3b) 06-03-Stress-Sweep (Budget hart; Scheitern ⇒ null ⇒ INCONCLUSIVE).
  let stress: Awaited<ReturnType<typeof runInEngineStress>> | null = null;
  try {
    const sweep = await runInEngineStress({
      engineConfig,
      walkForward: walkForwardInput,
      maxRuns: options.maxRuns,
    });
    if (sweep.ok) {
      stress = sweep;
    } else {
      for (const error of sweep.errors) errors.push(error);
      sayError(`[validate] Stress-Sweep nicht auswertbar: ${sweep.errors.join("; ")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    errors.push(message);
    sayError(`[validate] Stress-Sweep fehlgeschlagen: ${message}`);
  }

  // 3c) 06-01-Audit aus den Lauf-Fakten (Orderbuch-Fakten sind bewusst UNKNOWN).
  const audit = auditAssumptions({
    template,
    version: referenceSpec,
    run: {
      trades: oos.trades,
      equityPoints: null,
      feesPaid: oos.fees,
      slippagePaid: oos.slippage,
      fundingPaid: oos.funding,
      outOfSample: report.windows.length > 0,
      walkForwardWindows: report.windows.length,
      embargoMs: lastFreeze?.cutoffs.embargoMs ?? null,
      purgeMs: lastFreeze?.cutoffs.purgeMs ?? null,
    },
    candles: {
      bars: candles.length,
      requiredWarmupCandles: engineConfig.warmupBars,
      snapshots: null,
    },
    config: {
      executionModel: engineConfig.executionModel,
      timeframe,
      slippageModel: engineConfig.slippageModel,
      fixedSlippageBps: engineConfig.fixedSlippageBps,
      spreadSlippageFactor: engineConfig.spreadSlippageFactor,
      feeModel: engineConfig.feeModel,
      initialCapital: engineConfig.initialCapital,
    },
  });

  // 3d) Regime-Aggregation (point-in-time; DB-Ausfall ⇒ alle Trades unattributed).
  const regimeFacts = await loadRegimeFacts(symbol, fromMs, toMs).catch((error: unknown) => {
    const message = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
    errors.push(`regime:db-unavailable — ${message}`);
    return [] as RegimeSnapshotFact[];
  });
  const trades: RegimeTradeFact[] = report.trades
    .filter((record) => record.segment === "OOS")
    .map((record) => ({
      symbol: record.trade.symbol,
      entryTime: record.trade.entryTime,
      pnl: record.trade.pnl,
      pnlPct: record.trade.pnlPct,
      notional: record.trade.notional,
    }));

  // 4) Report bauen.
  const nowMs = Date.now();
  const validationReport = buildValidationReport({
    strategyKey,
    strategyVersion: strategyVersionNumber,
    strategyVersionId: versionId,
    templateId,
    templateVersion,
    strategyClass: template.class,
    symbol,
    timeframe,
    metrics: {
      sharpe: oos.sharpeRatio,
      sortino: oos.sortinoRatio,
      maxDrawdownPct: oos.maxDrawdownPct,
      winRate: oos.winRate / 100,
      profitFactor: oos.profitFactor,
      expectancy: expectancyOf(oos.netPnl, oos.trades),
      tradeCount: oos.trades,
      netPnl: oos.netPnl,
    },
    oosWindows: report.windows.length,
    windowStart: candles[0].time,
    windowEnd: candles[candles.length - 1].time,
    dataQualityScore: seriesCoverage(candles, fromMs, toMs, timeframe),
    assumptions: audit,
    integrity,
    gap,
    plateau,
    multipleTesting,
    stress: stress?.ok ? stress.summary : null,
    trades,
    regimeSnapshots: regimeFacts,
    eventTime: candles[candles.length - 1].time,
    availableAt: nowMs,
    computedAt: nowMs,
    backtestRunId: null,
    codeVersion,
    dataVersion: null,
    notes: [
      `CLI-Lauf über ${candles.length} Kerzen (${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}).`,
      "Spread/Buchtiefe sind im CLI-Lauf nicht belegbar ⇒ Annahmen-Audit meldet sie als UNKNOWN.",
      ...(errors.length > 0 ? [`Nicht auswertbare Stufen: ${errors.join(" | ")}`] : []),
    ],
  });

  // 5) Ausgabe + Evidenz.
  say("");
  say(
    `[validate] ${validationReport.result} · ${validationReport.summary}`,
  );
  for (const gate of validationReport.gates) {
    say(`[validate]   ${gate.step}. ${gate.id}: ${gate.status} — ${gate.evidence}`);
  }
  say(`[validate] Regime: ${validationReport.regimeEvidence.summary}`);
  say(
    `[validate] evidenceHash ${validationReport.evidenceHash} · idempotencyKey ${validationReport.idempotencyKey}`,
  );

  if (options.out) {
    const target = path.resolve(process.cwd(), options.out);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(validationReport, null, 2)}\n`, "utf8");
    say(`[validate] Report geschrieben: ${target}`);
  }

  if (!options.noWrite) {
    const written = await writeValidationEvidenceDetailed(validationReport);
    say(
      `[validate] Evidenz ${written.created ? "geschrieben" : "bestand bereits (idempotent)"}: ${written.evidence.id}`,
    );
  } else {
    say("[validate] --no-write: keine Evidenz geschrieben.");
  }

  return {
    exitCode: validationReport.result === "PASS" ? 0 : 1,
    report: validationReport,
    errors,
  };
}

/** Liest die bestätigten Regime-Snapshots des Symbols im Fenster (point-in-time). */
async function loadRegimeFacts(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<RegimeSnapshotFact[]> {
  const rows = await db
    .select({
      symbol: regimeSnapshots.symbol,
      asOf: regimeSnapshots.asOf,
      confirmedRegime: regimeSnapshots.confirmedRegime,
      featureVersion: regimeSnapshots.featureVersion,
      modelVersion: regimeSnapshots.modelVersion,
    })
    .from(regimeSnapshots)
    .where(
      and(
        eq(regimeSnapshots.symbol, symbol),
        gte(regimeSnapshots.asOf, new Date(fromMs)),
        lte(regimeSnapshots.asOf, new Date(toMs)),
      ),
    );
  return rows.map((row) => ({
    symbol: row.symbol,
    asOf: row.asOf.getTime(),
    confirmedRegime: row.confirmedRegime,
    featureVersion: row.featureVersion,
    modelVersion: row.modelVersion,
  }));
}

/** Direktstart (`npm run validate:strategy`) — Import bleibt side-effect-frei. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const outcome = await runValidateStrategyCli(argv);
  return outcome.exitCode;
}

if (typeof process !== "undefined" && /(^|\/)run-validate-strategy\.[cm]?[jt]s$/.test(process.argv?.[1] ?? "")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      sayError(
        `[validate] Fehlgeschlagen: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
      );
      process.exit(1);
    });
}
