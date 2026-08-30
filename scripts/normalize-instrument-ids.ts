/**
 * SYM-007 §3.4: Einmalige Normalisierung von Instrument-IDs in Beständen —
 * Registry Seed (`data/universe/instruments.ndjson`) und Historical Store
 * (`data/history/candles.ndjson`).
 *
 *   npm run symbols:normalize --                          # Dry-Run über BEIDE Standarddateien
 *   npm run symbols:normalize -- --apply                  # schreibt, mit Backup
 *   npm run symbols:normalize -- --file=data/history/candles.ndjson --kind=history
 *
 * DRY-RUN IST DER DEFAULT: Ohne `--apply` wird ausschließlich ein Report
 * ausgegeben — keine Datei wird verändert, kein Backup angelegt; Exit-Code 2
 * weist darauf hin, dass `--apply` fehlt.
 *
 * Was das Skript tut (und was nicht) — konservativ, nichts wird geraten:
 *   - UMBENANNT wird nur strukturelle Korruption (Venue-Kleinschreibung,
 *     `id ≠ venue:symbol`, ID-Präfix ≠ venue-Feld). Das Ziel wird aus dem
 *     Symbolfeld abgeleitet und auf die bevorzugte Speicherform gebracht
 *     (venue-nativ; KRAKEN: Slash).
 *   - EMPFOHLEN (keine Änderung) werden legale, aber nicht bevorzugte
 *     Notationen (`PAPER:EURUSD=X`, `KRAKEN:BTC-USD`) — sichtbar im Report.
 *   - ÜBERSPRUNGEN wird alles Unparsebare (kaputtes JSON, ungültige Venue,
 *     unparsebares Symbol) und Zielkollisionen zwischen verschiedenen
 *     Quell-IDs (kein stilles Serien-Merging).
 *   - Byte-identische Dubletten werden unter `--apply` entfernt (Report).
 *
 * Ablauf unter --apply: Backup (`<datei>.bak-<ISO>`, chmod 600) → schreiben
 * (atomar tmp + rename). Schlägt das Backup fehl, bleibt das Original
 * unverändert. Idempotent: ein zweiter Lauf ändert nichts mehr.
 *
 * Exit-Codes:
 *   0  angewendet (oder nichts zu tun) und keine übersprungenen Zeilen
 *   1  übersprungene Zeilen / Zielkollisionen (Operator-Entscheid nötig)
 *   2  nichts angewendet — Dry-Run (Default) oder ungültige Option
 *
 * Hintergrund und Notationsregeln: docs/SYMBOLS.md
 */
import path from "node:path";
import {
  formatNormalizeIdsReport,
  normalizeIdFile,
  type NormalizeIdsReport,
  type StoreKind,
} from "../src/symbols/idMigration";

const HELP = `symbols:normalize — Instrument-ID-Normalisierung (SYM-007 §3.4)

Verwendung:
  npm run symbols:normalize --                                  # Dry-Run, beide Standarddateien
  npm run symbols:normalize -- --apply                          # schreibt (mit Backup)
  npm run symbols:normalize -- --file=<pfad> [--kind=registry|history]

Optionen:
  --file=<pfad>            Nur diese Datei prüfen/normalisieren.
                           Default: data/universe/instruments.ndjson und
                           data/history/candles.ndjson (beide).
  --kind=registry|history  Dateityp erzwingen (Default: aus --file abgeleitet,
                           bzw. beide Standarddateien mit ihrem Typ).
  --apply                  Schreibt Änderungen (mit Backup). OHNE dieses Flag
                           läuft der Dry-Run — es wird nichts verändert.
  --dry-run                Expliziter Dry-Run (entspricht dem Default).
  --help                   Diese Hilfe.

Regeln (konservativ — nichts wird geraten):
  Umbenannt wird nur strukturelle Korruption (Venue-Case, id ≠ venue:symbol).
  Legale Alt-Notationen (z. B. KRAKEN:BTC-USD, PAPER:EURUSD=X) werden als
  HINWEIS gemeldet, nicht verändert. Unparsebare Zeilen und Zielkollisionen
  werden übersprungen und gemeldet.

Exit-Codes:
  0  angewendet (oder nichts zu tun), keine übersprungenen Zeilen
  1  übersprungene Zeilen / Kollisionen — Operator-Entscheid erforderlich
  2  Dry-Run (Default) oder ungültige Option

Doku: docs/SYMBOLS.md
`;

interface Target {
  file: string;
  kind: StoreKind;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const fileArg = args.find((a) => a.startsWith("--file="))?.slice("--file=".length);
  const kindArg = args.find((a) => a.startsWith("--kind="))?.slice("--kind=".length);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run") || !apply;

  if (kindArg !== undefined && kindArg !== "registry" && kindArg !== "history") {
    console.error(`[normalize-ids] --kind "${kindArg}" ist ungültig. Erlaubt: registry | history.`);
    process.exit(2);
  }

  let targets: Target[];
  if (fileArg) {
    const file = path.resolve(fileArg);
    const kind: StoreKind =
      (kindArg as StoreKind | undefined) ??
      (/universe|instruments/.test(fileArg) ? "registry" : "history");
    targets = [{ file, kind }];
  } else {
    targets = [
      { file: path.resolve("data", "universe", "instruments.ndjson"), kind: "registry" },
      { file: path.resolve("data", "history", "candles.ndjson"), kind: "history" },
    ];
  }

  const reports: NormalizeIdsReport[] = [];
  for (const target of targets) {
    let report: NormalizeIdsReport;
    try {
      report = normalizeIdFile({ file: target.file, kind: target.kind, dryRun });
    } catch (err) {
      console.error(
        `[normalize-ids] Abbruch bei ${target.file}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
    reports.push(report);
    for (const line of formatNormalizeIdsReport(report)) console.log(line);
  }

  const anySkipped = reports.some((r) => r.skipped.length > 0 || r.collisions > 0);
  if (!apply) {
    console.log(
      "[normalize-ids] NICHTS ANGEWENDET — Dry-Run ist der Default. Zum Schreiben --apply ergänzen " +
        "(Backup wird automatisch angelegt). Siehe docs/SYMBOLS.md",
    );
    process.exitCode = 2;
    return;
  }
  if (anySkipped) process.exitCode = 1;
}

main();
