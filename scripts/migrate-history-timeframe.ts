/**
 * Migration: Historical Store v1 (ohne `timeframe`) → v2 (mit `timeframe`).
 *
 *   npm run history:migrate -- --file=data/history/candles.ndjson \
 *     --assume-timeframe=15m            # Dry-Run (Default, schreibt nichts)
 *   npm run history:migrate -- --file=data/history/candles.ndjson \
 *     --assume-timeframe=15m --apply    # schreibt, mit Backup
 *
 * DRY-RUN IST DER DEFAULT (seit 1.26.2): Ohne `--apply` wird ausschließlich
 * ein Report ausgegeben — keine Datei wird verändert, kein Backup angelegt,
 * Exit-Code 2 weist darauf hin, dass `--apply` fehlt. Produktionsdaten werden
 * damit nie durch einen versehentlichen Aufruf überschrieben.
 *
 * WARUM --assume-timeframe EXPLIZIT sein muss:
 *   Im alten Schema gibt es kein `timeframe`-Feld. 5m- und 1h-Kerzen desselben
 *   Instruments sind in der Datei ununterscheidbar. Würde das Skript raten
 *   (z.B. "immer 15m"), bekämen echte 5m-Reihen den falschen Schlüssel und
 *   würden jede EMA/Momentum/Volatilität unbemerkt verfälschen. Deshalb wird
 *   der Timeframe für Altbestand bewusst vom Bediener verlangt — abgebrochen
 *   wird, sobald eine Legacy-Zeile ohne das Flag gefunden wird.
 *
 * Ablauf: Backup (candles.ndjson.bak-<ISO>) → parsen → timeframe zuweisen →
 * dedup (jüngstes fetchedAt gewinnt) → sortieren (instrumentId, timeframe, ts)
 * → atomar schreiben. Idempotent: ein zweiter Lauf ändert nichts.
 *
 * Siehe docs/MIGRATION_TIMEFRAME_FIELD.md (Runbook: Backup, Dry-Run, Anwenden,
 * Validierung, Rollback) und docs/HISTORY.md (Schema, Schlüssel, Dedup-Regel).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { isSupportedTimeframe } from "../src/lib/marketdata/historicalStore";
import { formatMigrationReport, migrateHistoryFile } from "../src/history/migration";

const HELP = `history:migrate — Historical Store v1 → v2 (timeframe-Dimension)

Verwendung:
  npm run history:migrate -- --file=<pfad> --assume-timeframe=<tf>           # Dry-Run
  npm run history:migrate -- --file=<pfad> --assume-timeframe=<tf> --apply   # schreiben

Optionen:
  --file=<pfad>            Pfad zur NDJSON-Datei (Default: data/history/candles.ndjson)
  --assume-timeframe=<tf>  Timeframe, der ALTEN Zeilen ohne timeframe zugewiesen
                           wird. Erlaubt: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 5d.
                           PFLICHT, sobald die Datei Legacy-Zeilen enthält.
  --apply                  Schreibt die migrierte Datei (mit Backup). OHNE dieses
                           Flag läuft der Dry-Run — es wird nichts verändert.
  --dry-run                Expliziter Dry-Run (entspricht dem Default).
  --help                   Diese Hilfe.

Warum --assume-timeframe explizit sein muss:
  Alte Zeilen tragen kein timeframe-Feld. 5m- und 1h-Bars sind in der Datei
  ununterscheidbar; ein erratener Wert würde die Reihen dauerhaft falsch
  beschriften. Das Skript rät nie — es bricht mit Erklärung ab, wenn das Flag
  fehlt.

Sicherheit:
  - Dry-Run ist der Default: ohne --apply wird nichts geschrieben.
  - Vor dem Schreiben wird ein Backup candles.ndjson.bak-<ISO> (chmod 600)
    angelegt; schlägt das fehl, wird abgebrochen (Original bleibt unverändert).
  - Die Migration ist idempotent: ein zweiter Lauf ändert nichts.
  - Rollback: das Backup über die Zieldatei zurückspielen.

Exit-Codes:
  0  angewendet (oder nichts zu tun) bzw. Report ohne verworfene Zeilen
  1  Abbruch (ungültige Option, Backup fehlgeschlagen, Invariante verletzt)
     oder Zeilen verworfen
  2  nichts angewendet — --assume-timeframe fehlt/ungültig oder --apply fehlt

Runbook (Backup, Validierung, Rollback): docs/MIGRATION_TIMEFRAME_FIELD.md
Schema, Schlüssel, Dedup-Regel: docs/HISTORY.md
`;

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const fileArg = args.find((a) => a.startsWith("--file="))?.slice("--file=".length);
  const tfArg = args.find((a) => a.startsWith("--assume-timeframe="))?.slice("--assume-timeframe=".length);
  // SICHERHEIT: Dry-Run ist der Default. Geschrieben wird ausschließlich mit
  // dem expliziten Flag --apply (Security-Audit: keine Produktionsdaten ohne
  // bewusste Freigabe verändern).
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  const file = path.resolve(fileArg ?? path.join(process.cwd(), "data", "history", "candles.ndjson"));

  if (!existsSync(file)) {
    console.error(`[history:migrate] Datei nicht gefunden: ${file}`);
    console.error("[history:migrate] Nichts zu migrieren (es wurde keine Datei verändert).");
    process.exit(0);
  }

  if (tfArg !== undefined && !isSupportedTimeframe(tfArg)) {
    console.error(
      `[history:migrate] --assume-timeframe "${tfArg}" ist ungültig. Erlaubt: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d, 5d.`,
    );
    process.exit(2);
  }

  try {
    const report = migrateHistoryFile({
      file,
      assumeTimeframe: tfArg as never,
      dryRun,
    });
    for (const line of formatMigrationReport(report)) console.log(line);
    if (!apply) {
      // Kein --apply: es wurde nichts geschrieben. Explizit melden, damit ein
      // automatisierter Lauf nicht „grün“ durchgeht, obwohl er nur las.
      console.log(
        "[history:migrate] NICHTS ANGEWENDET — Dry-Run ist der Default. Zum Schreiben --apply ergaenzen " +
          "(Backup wird automatisch angelegt). Siehe docs/MIGRATION_TIMEFRAME_FIELD.md",
      );
      process.exitCode = 2;
      return;
    }
    if (report.rejected.length > 0) process.exitCode = 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[history:migrate] abgebrochen: ${msg}`);
    process.exit(1);
  }
}

main();
