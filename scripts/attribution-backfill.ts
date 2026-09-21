#!/usr/bin/env node
/**
 * CLI-Backfill der deterministischen Trade-PnL-Attribution (RMA-P1-06,
 * v1.57.0).
 *
 * ```text
 * npm run attribution:backfill                       # Methodenversion aus Env (Default 1)
 * npm run attribution:backfill -- --dry-run          # klassifizieren, nichts schreiben
 * npm run attribution:backfill -- --batch=200        # Batch-Obergrenze (max 1000)
 * npm run attribution:backfill -- --from=2026-01-01 --to=2026-09-01
 * ```
 *
 * Verhalten:
 *   - Findet geschlossene Journal-Zeilen OHNE Attribution der Methodenversion
 *     und attribuiert sie nach — idempotent (Unique-Key journal_id +
 *     method_version): wiederholte Läufe erzeugen keine zweiten Zeilen.
 *   - Historische Zeilen ohne ausreichenden Snapshot (v1-Snapshots,
 *     UNKNOWN-Attribution) werden als UNATTRIBUTABLE persistiert — sichtbare
 *     Lücke, NIEMALS mit geschätzten Quellen gefüllt.
 *   - Kein Netzwerk, kein LLM; nur Journal-/Positions-/Attributionstabellen.
 *   - Zeitfilter wirken auf die Ereigniszeit (closed_at).
 *
 * Exit-Codes: 0 = ok, 1 = Fehler, 2 = Aufruffehler.
 */
import { auditWrite } from "../src/lib/auditSink";
import { telemetry } from "../src/lib/telemetry";
import {
  ATTRIBUTION_LIMITS,
  backfillTradeAttributions,
  loadAttributionConfig,
} from "../src/attribution";

const USAGE = `Trade-Attribution-Backfill (RMA-P1-06) — idempotent, fail-closed.

Aufruf:
  node --import tsx scripts/attribution-backfill.ts [Optionen]

Optionen:
  --method-version=<n>   Methodenversion (Default: TRADE_ATTRIBUTION_METHOD_VERSION bzw. 1)
  --batch=<n>            Zeilen je Lauf (Default ${ATTRIBUTION_LIMITS.defaultBackfillBatch}, max ${ATTRIBUTION_LIMITS.maxBackfillBatch})
  --from=<ISO>           Untergrenze Ereigniszeit closed_at
  --to=<ISO>             Obergrenze Ereigniszeit closed_at
  --dry-run              Nur klassifizieren, nichts schreiben
  --help                 Diese Hilfe

Exit-Codes: 0 = ok, 1 = Fehler, 2 = Aufruffehler.
`;

interface Args {
  methodVersion: number;
  batch: number;
  from: Date | null;
  to: Date | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args | null {
  const cfg = loadAttributionConfig();
  const args: Args = {
    methodVersion: cfg.methodVersion,
    batch: ATTRIBUTION_LIMITS.defaultBackfillBatch,
    from: null,
    to: null,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") return null;
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) {
      console.error(`Unbekannte Option: ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
    const [, key, value] = match;
    switch (key) {
      case "method-version": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          console.error(`--method-version muss eine Ganzzahl ≥ 1 sein (war "${value}").\n\n${USAGE}`);
          process.exit(2);
        }
        args.methodVersion = n;
        break;
      }
      case "batch": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          console.error(`--batch muss eine Ganzzahl ≥ 1 sein (war "${value}").\n\n${USAGE}`);
          process.exit(2);
        }
        args.batch = Math.min(n, ATTRIBUTION_LIMITS.maxBackfillBatch);
        break;
      }
      case "from":
      case "to": {
        const ms = Date.parse(value);
        if (!Number.isFinite(ms)) {
          console.error(`--${key} ist kein gültiges ISO-8601-Datum (war "${value}").\n\n${USAGE}`);
          process.exit(2);
        }
        args[key] = new Date(ms);
        break;
      }
      default:
        console.error(`Unbekannte Option: --${key}\n\n${USAGE}`);
        process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const args = parseArgs(argv);
  if (args === null) return 0;

  if (!args.dryRun) {
    const cfg = loadAttributionConfig();
    if (!cfg.enabled) {
      console.error(
        "TRADE_ATTRIBUTION_ENABLED=false — Backfill bewusst abgelehnt (fail-closed). Zum Nachziehen aktivieren und erneut ausführen."
      );
      return 1;
    }
  }

  console.log(
    `[attribution-backfill] Start: Methode ${args.methodVersion}, Batch ≤ ${args.batch}` +
      `${args.from ? `, ab ${args.from.toISOString()}` : ""}${args.to ? `, bis ${args.to.toISOString()}` : ""}` +
      `${args.dryRun ? " (Dry-Run)" : ""}`
  );

  try {
    const counts = await backfillTradeAttributions({
      methodVersion: args.methodVersion,
      batchLimit: args.batch,
      dryRun: args.dryRun,
      from: args.from ?? undefined,
      to: args.to ?? undefined,
    });
    telemetry.attribution.backfills.inc({
      result: counts.failed > 0 ? "failed" : "ok",
    });
    console.log(
      `[attribution-backfill] Fertig: ${counts.considered} geprüft, ${counts.attributed} attribuiert, ` +
        `${counts.unattributable} UNATTRIBUTABLE (sichtbare Lücke), ${counts.duplicates} Duplikate, ` +
        `${counts.failed} Fehler${counts.dryRun ? " (Dry-Run, nichts geschrieben)" : ""}`
    );
    await auditWrite(
      "ATTRIBUTION_BACKFILL_RUN",
      "INFO",
      {
        methodVersion: counts.methodVersion,
        considered: counts.considered,
        attributed: counts.attributed,
        unattributable: counts.unattributable,
        duplicates: counts.duplicates,
        failed: counts.failed,
        dryRun: counts.dryRun,
        via: "attribution-backfill",
      },
      { auditClass: "security" }
    ).catch(() => {
      /* Audit-Fehler beendet den Lauf nicht — Counts stehen im Log. */
    });
    return counts.failed > 0 ? 1 : 0;
  } catch (e) {
    telemetry.attribution.backfills.inc({ result: "failed" });
    console.error(
      `[attribution-backfill] Fehler: ${e instanceof Error ? e.message : String(e)}`
    );
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[attribution-backfill] Unerwarteter Fehler: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
