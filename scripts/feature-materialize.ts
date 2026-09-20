#!/usr/bin/env node
/**
 * CLI des Point-in-Time Feature Store (RMA-P6-01, v1.53.0).
 *
 * ```text
 * npm run features:materialize                     # inkrementell, alle Entities/Features
 * npm run features:materialize -- --dry-run        # rechnen + klassifizieren, nichts schreiben
 * npm run features:materialize -- --mode=backfill --from=2024-01-01 --to=2026-01-01
 * npm run features:materialize -- --feature=scanner.rsi --entities=BITUNIX:BTCUSDT
 * npm run features:materialize -- --availability=bar_close    # Forschungsannahme
 * npm run features:status                          # Definitionen, Abdeckung, Läufe (read-only)
 * npm run features:parity                          # Offline/Online-Vergleich (Exit 1 bei Divergenz)
 * npm run features:materialize -- --prune-runs=50   # Retention der Betriebsmetadaten
 * ```
 *
 * Datenquelle ist der Historical Store (`PAPER_HISTORY_DIR`, Default
 * `data/history`) — **kein Netzwerk**, kein LLM. Die Materialisierung ist
 * deterministisch und idempotent: derselbe Lauf erzeugt keine doppelten Werte,
 * ein Abbruch setzt am Cursor ohne Lücke fort.
 *
 * Fail-closed: fehlende/leere Kerzenreihen, unbekannte Features, ungültige
 * Flags und Divergenzen im Paritätsjob beenden den Lauf mit Exit 1. Ohne
 * geschriebene Werte gibt es **keine** Null-Ersatzwerte (unavailable ≠ 0).
 */
import { createHash } from "node:crypto";

import { loadQualityReport } from "../src/marketdata/quality";
import {
  FEATURE_LIMITS,
  FEATURE_QUALITY_SEVERITY,
  type FeatureBarInput,
  type FeatureRef,
  type FeatureQualityStatus,
  getSliceRegistry,
  materializeSlice,
  expectedBarsInRange,
  parityCheck,
  featureStoreStatus,
} from "../src/features";
import { getFeatureStore } from "../src/features/store";
import { findingsForSeries, qualityStatusForWindow } from "../src/features/sourceQuality";
import {
  DEFAULT_ANALYSIS_TIMEFRAME,
  HistoricalStore,
  SUPPORTED_TIMEFRAME_MS,
  isSupportedTimeframe,
  type SupportedTimeframe,
} from "../src/lib/marketdata/historicalStore";
import { historyDir } from "../src/lib/marketdata/config";

const USAGE = `Feature-Store-Materialisierung (RMA-P6-01) — lokal, deterministisch, idempotent.

Aufruf:
  node --import tsx scripts/feature-materialize.ts [Optionen]

Optionen:
  --feature=<id>[,<id>]    Features (Default: gesamter Slice der Registry; Abhängigkeiten folgen)
  --entities=<id>[,<id>]   Instrumente (Default: alle Reihen des Timeframes im Historical Store)
  --timeframe=<tf>         Timeframe der Reihe (Default ${DEFAULT_ANALYSIS_TIMEFRAME})
  --from=<ISO|ms>          Untere Manifest-Grenze (nur Dokumentation/Filter der Ausgabe)
  --to=<ISO|ms>            Materialisierungs-Horizont (Default: jetzt)
  --mode=incremental|backfill   Lauf-Modus (Default incremental)
  --availability=ingested|bar_close
                           Verfügbarkeitspolitik (Default ingested = fail-closed)
  --batch-rows=<n>         Werte je Batch (Default ${FEATURE_LIMITS.batchRows}, max ${FEATURE_LIMITS.batchRows})
  --max-batches=<n>        Laufzeitdeckel (Default ${FEATURE_LIMITS.maxBatches})
  --dry-run                Nur rechnen/klassifizieren, nichts schreiben
  --parity                 Offline/Online-Vergleich statt Materialisierung (Exit 1 bei Divergenz)
  --status                 Read-only-Status: Definitionen, Abdeckung, Läufe, Revisionen
  --prune-runs=<n>         Alte wertfreie Manifeste behalten (Retention; Werte bleiben)
  --help                   Diese Hilfe

Exit-Codes: 0 = ok, 1 = Fehler/Divergenz, 2 = Aufruf-/Validierungsfehler.
`;

interface Args {
  features: string[] | null;
  entities: string[] | null;
  timeframe: SupportedTimeframe;
  fromTs: number | null;
  toTs: number | null;
  mode: "INCREMENTAL" | "BACKFILL";
  availability: "bar_close" | "ingested";
  batchRows: number;
  maxBatches: number;
  dryRun: boolean;
  parity: boolean;
  status: boolean;
  pruneRuns: number | null;
  help: boolean;
}

class UsageError extends Error {}

function parseTs(raw: string, flag: string): number {
  const value = raw.trim();
  const asNumber = Number(value);
  if (value !== "" && Number.isFinite(asNumber) && /^\d+$/.test(value)) return asNumber;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new UsageError(`${flag}: "${raw.slice(0, 40)}" ist kein ISO-8601-/ms-Zeitpunkt.`);
  return ms;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    features: null,
    entities: null,
    timeframe: DEFAULT_ANALYSIS_TIMEFRAME,
    fromTs: null,
    toTs: null,
    mode: "INCREMENTAL",
    availability: "ingested",
    batchRows: FEATURE_LIMITS.batchRows,
    maxBatches: FEATURE_LIMITS.maxBatches,
    dryRun: false,
    parity: false,
    status: false,
    pruneRuns: null,
    help: false,
  };
  const readValue = (flag: string): string => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    if (!hit) throw new UsageError(`${flag} braucht einen Wert (${flag}=…).`);
    return hit.slice(flag.length + 1);
  };
  const has = (flag: string): boolean => argv.includes(flag);
  if (has("--help") || has("-h")) args.help = true;
  if (has("--dry-run")) args.dryRun = true;
  if (has("--parity")) args.parity = true;
  if (has("--status")) args.status = true;
  if (has("--feature")) args.features = readValue("--feature").split(",").map((v) => v.trim()).filter(Boolean);
  if (has("--entities")) args.entities = readValue("--entities").split(",").map((v) => v.trim()).filter(Boolean);
  if (has("--timeframe")) {
    const tf = readValue("--timeframe");
    if (!isSupportedTimeframe(tf)) {
      throw new UsageError(`--timeframe: "${tf.slice(0, 20)}" ist nicht in der Allowlist.`);
    }
    args.timeframe = tf;
  }
  if (has("--from")) args.fromTs = parseTs(readValue("--from"), "--from");
  if (has("--to")) args.toTs = parseTs(readValue("--to"), "--to");
  if (has("--mode")) {
    const mode = readValue("--mode").toLowerCase();
    if (mode !== "incremental" && mode !== "backfill") throw new UsageError("--mode: erwartet incremental|backfill.");
    args.mode = mode === "backfill" ? "BACKFILL" : "INCREMENTAL";
  }
  if (has("--availability")) {
    const policy = readValue("--availability");
    if (policy !== "ingested" && policy !== "bar_close") {
      throw new UsageError("--availability: erwartet ingested|bar_close.");
    }
    args.availability = policy;
  }
  if (has("--batch-rows")) {
    const n = Number(readValue("--batch-rows"));
    if (!Number.isInteger(n) || n < 1 || n > FEATURE_LIMITS.batchRows) {
      throw new UsageError(`--batch-rows: erwartet 1..${FEATURE_LIMITS.batchRows}.`);
    }
    args.batchRows = n;
  }
  if (has("--max-batches")) {
    const n = Number(readValue("--max-batches"));
    if (!Number.isInteger(n) || n < 1 || n > FEATURE_LIMITS.maxBatches) {
      throw new UsageError(`--max-batches: erwartet 1..${FEATURE_LIMITS.maxBatches}.`);
    }
    args.maxBatches = n;
  }
  if (has("--prune-runs")) {
    const n = Number(readValue("--prune-runs"));
    if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new UsageError("--prune-runs: erwartet 1..10000.");
    args.pruneRuns = n;
  }
  return args;
}

function refsFromArgs(features: readonly string[] | null): FeatureRef[] {
  const registry = getSliceRegistry();
  if (features === null) {
    return registry.definitions().map((def) => ({ featureId: def.featureId, version: def.version }));
  }
  return features.map((entry) => {
    const [featureId, versionRaw] = entry.split(":");
    if (versionRaw === undefined) {
      const latest = registry.latest(featureId);
      if (!latest) throw new UsageError(`Unbekanntes Feature "${featureId.slice(0, 64)}".`);
      return { featureId: latest.featureId, version: latest.version };
    }
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) throw new UsageError(`Feature "${featureId}" hat keine gültige Version.`);
    if (!registry.get({ featureId, version })) throw new UsageError(`Feature ${featureId}@${version} ist nicht registriert.`);
    return { featureId, version };
  });
}

/** Entities aus dem Historical Store (nur Reihen des Timeframes). */
function entitiesFromHistory(store: HistoricalStore, timeframe: SupportedTimeframe): string[] {
  const seen = new Map<string, number>();
  for (const entry of store.readAll()) {
    if (entry.timeframe !== timeframe) continue;
    seen.set(entry.instrumentId, (seen.get(entry.instrumentId) ?? 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, FEATURE_LIMITS.materializeEntities)
    .map(([id]) => id)
    .sort();
}

function barsOf(store: HistoricalStore, entityId: string, timeframe: SupportedTimeframe): FeatureBarInput[] {
  return store.query({ instrumentId: entityId, timeframe }).map((entry) => ({
    time: entry.ts,
    open: entry.open,
    high: entry.high,
    low: entry.low,
    close: entry.close,
    volume: entry.volume,
    fetchedAt: entry.fetchedAt,
  }));
}

/**
 * Source-Quality-Status je Bar aus dem persistierten Report.
 *
 * Regeln (siehe `src/features/sourceQuality.ts`): Befunde mit Zeitstempel
 * zählen für das Lookback-Fenster des Bars, Befunde ohne Zeitstempel für die
 * ganze Reihe; ohne Report ist der Status `UNKNOWN` (nicht `OK`).
 */
function makeQualityLookup(
  report: ReturnType<typeof loadQualityReport>,
  entityId: string,
  timeframe: SupportedTimeframe,
  lookbackMs: number
): (eventTimeMs: number) => FeatureQualityStatus {
  const findings = findingsForSeries(report, entityId, timeframe);
  return (eventTimeMs: number) =>
    qualityStatusForWindow(findings, eventTimeMs - lookbackMs, eventTimeMs, (status) => FEATURE_QUALITY_SEVERITY[status]);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[features] ${e instanceof Error ? e.message : String(e)}`);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const registry = getSliceRegistry();
  const store = new HistoricalStore(historyDir());
  const dbStore = getFeatureStore();

  if (args.status) {
    const status = await featureStoreStatus({ store: dbStore, registry, timeframe: args.timeframe });
    console.log(
      JSON.stringify(
        {
          codeVersion: status.codeVersion,
          generatedAt: status.generatedAt,
          timeframe: status.timeframe,
          definitions: status.definitions.map((def) => ({
            feature: `${def.featureId}@${def.version}`,
            dtype: def.dtype,
            unit: def.unit,
            lookbackBars: def.lookbackBars,
            dependencies: def.dependencies,
            definitionHash: def.definitionHash,
          })),
          series: status.series,
          runs: status.runs,
          revisions: status.revisions,
        },
        null,
        2
      )
    );
    return 0;
  }

  if (args.pruneRuns !== null) {
    const removed = await dbStore.pruneRuns(args.pruneRuns);
    console.log(`[features] Retention: ${removed} wertfreie Manifeste entfernt (behalten: ${args.pruneRuns}).`);
    return 0;
  }

  let refs: FeatureRef[];
  try {
    refs = refsFromArgs(args.features);
  } catch (e) {
    console.error(`[features] ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const ordered = registry.topoOrder(refs);
  const lookbackMs =
    Math.max(...ordered.map((def) => def.lookbackBars)) * SUPPORTED_TIMEFRAME_MS[args.timeframe];

  const entities = (args.entities ?? entitiesFromHistory(store, args.timeframe)).slice(
    0,
    FEATURE_LIMITS.materializeEntities
  );
  if (entities.length === 0) {
    console.error(
      `[features] Keine Kerzenreihen für Timeframe "${args.timeframe}" im Historical Store ` +
        `(${historyDir()}) — zuerst \`npm run market:sync\` ausführen. Es wurde nichts geschrieben.`
    );
    return 1;
  }

  const asOf = args.toTs !== null ? new Date(args.toTs) : new Date();
  if (!Number.isFinite(asOf.getTime())) {
    console.error("[features] --to ist kein gültiger Zeitpunkt.");
    return 2;
  }

  if (args.parity) {
    const report = loadQualityReport();
    let divergent = 0;
    let checked = 0;
    for (const entityId of entities) {
      const bars = barsOf(store, entityId, args.timeframe);
      if (bars.length === 0) continue;
      const outcome = await parityCheck(
        {
          refs,
          entityId,
          timeframe: args.timeframe,
          bars,
          asOf,
          fromTs: args.fromTs !== null ? new Date(args.fromTs) : new Date(bars[0].time),
          toTs: asOf,
          availabilityPolicy: "bar_close",
          maxRows: args.batchRows,
        },
        { store: dbStore, registry }
      );
      divergent += outcome.report.divergent;
      checked += outcome.report.checked;
      displayParity(entityId, outcome.report, report, args.timeframe);
    }
    console.log(
      `[features] Paritätsjob: ${checked} Werte geprüft, ${divergent} Abweichungen ` +
        `(Zeitpunkt ${asOf.toISOString()}).`
    );
    return divergent > 0 ? 1 : 0;
  }

  const qualityReport = loadQualityReport();
  const result = await materializeSlice(
    {
      refs,
      entities,
      timeframe: args.timeframe,
      barsFor: (entityId) => barsOf(store, entityId, args.timeframe),
      asOf,
      availabilityPolicy: args.availability,
      mode: args.mode,
      fromTs: args.fromTs !== null ? new Date(args.fromTs) : null,
      toTs: args.toTs !== null ? new Date(args.toTs) : null,
      batchRows: args.batchRows,
      maxBatches: args.maxBatches,
      dryRun: args.dryRun,
      qualityForBar: (entityId, eventTimeMs) =>
        makeQualityLookup(qualityReport, entityId, args.timeframe, lookbackMs)(eventTimeMs),
    },
    { store: dbStore, registry }
  );

  const barsExpected = expectedBarsInRange(args.fromTs ?? asOf.getTime() - 24 * 3600_000, asOf.getTime(), args.timeframe);
  console.log(
    JSON.stringify(
      {
        mode: args.mode,
        dryRun: result.dryRun,
        timeframe: args.timeframe,
        availabilityPolicy: args.availability,
        entities: entities.length,
        features: ordered.map((def) => `${def.featureId}@${def.version}`),
        asOf: asOf.toISOString(),
        counts: {
          batches: result.batches,
          runsCreated: result.runsCreated,
          runsReplayed: result.runsReplayed,
          valuesWritten: result.valuesWritten,
          nullValues: result.nullValues,
          duplicates: result.duplicates,
          revisions: result.revisions,
          skippedBeforeCursor: result.skippedBeforeCursor,
          gapBars: result.gapBars,
        },
        truncated: result.truncated,
        definitionDrift: result.definitionDrift,
        expectedBarsHint: barsExpected,
        cursors: result.cursors,
        contentHash: createHash("sha256")
          .update(JSON.stringify(result.cursors))
          .digest("hex")
          .slice(0, 16),
      },
      null,
      2
    )
  );
  if (result.definitionDrift.length > 0) {
    console.error(
      "[features] Definitionsdrift erkannt: " +
        result.definitionDrift.join(", ") +
        " — neue Semantik braucht eine neue Version (historische Werte bleiben unverändert)."
    );
    return 1;
  }
  if (result.truncated) {
    console.error(
      "[features] Laufzeitlimit erreicht — erneut aufrufen, der Cursor setzt ohne Lücke/Doppel fort."
    );
    return 1;
  }
  return 0;
}

function displayParity(
  entityId: string,
  report: { checked: number; matched: number; divergent: number; missingStored: number; divergences: readonly { featureId: string; eventTime: string; reason: string }[]; truncated: boolean },
  qualityReport: ReturnType<typeof loadQualityReport>,
  timeframe: SupportedTimeframe
): void {
  const qualityFindings = findingsForSeries(qualityReport, entityId, timeframe).length;
  const head = `[features] parity ${entityId}: ${report.checked} geprüft, ${report.matched} identisch, ` +
    `${report.divergent} abweichend, ${report.missingStored} fehlend` +
    (qualityFindings > 0 ? ` (${qualityFindings} Quality-Befunde in der Quelle)` : "");
  if (report.divergent === 0) {
    console.log(head);
    return;
  }
  console.error(head);
  for (const divergence of report.divergences.slice(0, 10)) {
    console.error(`  - ${divergence.featureId} @ ${divergence.eventTime}: ${divergence.reason}`);
  }
  if (report.truncated) console.error("  … weitere Abweichungen unterdrückt (Detailgrenze).");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(`[features] Lauf fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

/** Exportiert für Tests (Argument-Parser ohne IO). */
export { parseArgs, UsageError, entitiesFromHistory };
