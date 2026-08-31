/**
 * Seed-/Regenerationsskript für das erweiterte Markt-Universum (v1.30.0).
 *
 *   npm run universe:seed:markets
 *   npm run universe:seed:markets -- --dry-run
 *   npm run universe:seed:markets -- --no-paper-mirror
 *   npm run universe:seed:markets -- --json
 *
 * Schreibt die standardisierten Presets (50 Aktien · 50 Indizes · 22 Rohstoffe ·
 * 30 Kryptowährungen, jeweils inklusive `PAPER`-Spiegel) in die
 * Instrument-Registry (`data/universe/instruments.ndjson`).
 *
 * Eigenschaften:
 *   - **Idempotent:** Upsert-Semantik, fester `lastSeen`-Zeitstempel ⇒
 *     wiederholte Läufe erzeugen dieselbe Datei und löschen nichts.
 *   - **Kein Netzwerk, keine Credentials, keine Datenbank.**
 *   - **Fail-loud:** Preset-Vertragsverletzung (Anzahl/Duplikat) oder abgelehnte
 *     Sätze beenden mit Exit-Code ≠ 0 — ein still dünneres Universum wäre ein
 *     unsichtbarer Scanner-Fehler.
 *
 * Exit-Codes: 0 = ok · 1 = Preset-Vertrag/Registry-Fehler · 2 = ungültige CLI-Args.
 */
import { PRESET_INSTRUMENTS, assertPresetContract, presetSummary } from "../src/universe/presets";
import { InstrumentRegistry } from "../src/universe/registry";

type Options = {
  dryRun: boolean;
  withPaperMirror: boolean;
  json: boolean;
  help: boolean;
};

const USAGE = `Verwendung:
  npm run universe:seed:markets [-- --dry-run] [-- --no-paper-mirror] [-- --json]

Optionen:
  --dry-run          nur rechnen und berichten, nichts schreiben
  --no-paper-mirror  keine PAPER-Spiegelinstrumente anlegen
  --json             Ergebnis als JSON auf stdout (maschinenlesbar)
  -h, --help         diese Hilfe

Preset-Umfang: 50 Aktien · 50 Indizes · 22 Rohstoffe · 30 Kryptowährungen.
`;

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { dryRun: false, withPaperMirror: true, json: false, help: false };
  for (const arg of argv) {
    switch (arg) {
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--no-paper-mirror":
        opts.withPaperMirror = false;
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default: {
        process.stderr.write(`Unbekannte Option: ${arg}\n\n${USAGE}`);
        process.exit(2);
      }
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  // 1) Preset-Vertrag prüfen, BEVOR irgendetwas geschrieben wird.
  assertPresetContract();

  // 2) Registry laden (bestehende Instrumente bleiben erhalten).
  const registry = new InstrumentRegistry();
  registry.load();
  const before = registry.size;

  // 3) Presets upserten. Bei --no-paper-mirror werden die PAPER-Zeilen
  //    herausgefiltert, statt eine zweite Preset-Variante zu bauen.
  const inputs = opts.withPaperMirror
    ? [...PRESET_INSTRUMENTS]
    : [...PRESET_INSTRUMENTS].filter((instrument) => instrument.venue !== "PAPER");

  const summary = presetSummary();

  if (opts.dryRun) {
    const byVenue = new Map<string, number>();
    for (const instrument of inputs) {
      byVenue.set(instrument.venue, (byVenue.get(instrument.venue) ?? 0) + 1);
    }
    const result = {
      ok: true,
      dryRun: true,
      presets: {
        equities: summary.equities,
        indices: summary.indices,
        commodities: summary.commodities,
        crypto: summary.crypto,
      },
      wouldUpsert: inputs.length,
      byVenue: Object.fromEntries([...byVenue.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      registrySizeBefore: before,
    };
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(
        `[universe:markets] DRY-RUN — ${inputs.length} Instrumente würden upsertet ` +
          `(Aktien ${summary.equities} · Indizes ${summary.indices} · Rohstoffe ${summary.commodities} · ` +
          `Krypto ${summary.crypto}); Registry aktuell ${before} Instrumente.\n`,
      );
    }
    return;
  }

  const result = registry.upsertMany(inputs, "seed:market-presets", "SEED");
  registry.save();

  const payload = {
    ok: result.rejected.length === 0,
    dryRun: false,
    presets: {
      equities: summary.equities,
      indices: summary.indices,
      commodities: summary.commodities,
      crypto: summary.crypto,
    },
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    rejected: result.rejected.map((r) => ({ ref: r.ref, code: r.code, message: r.message })),
    registrySizeBefore: before,
    registrySizeAfter: registry.size,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      `[universe:markets] Presets geschrieben — neu: ${result.created}, aktualisiert: ${result.updated}, ` +
        `unverändert: ${result.unchanged}, abgelehnt: ${result.rejected.length}, ` +
        `gesamt: ${registry.size} (vorher ${before}).\n`,
    );
    process.stdout.write(
      `[universe:markets] Umfang: ${summary.equities} Aktien · ${summary.indices} Indizes · ` +
        `${summary.commodities} Rohstoffe · ${summary.crypto} Kryptowährungen` +
        `${opts.withPaperMirror ? " (inkl. PAPER-Spiegel)" : " (ohne PAPER-Spiegel)"}.\n`,
    );
    for (const r of result.rejected) {
      process.stderr.write(`  abgelehnt ${r.ref}: ${r.code} — ${r.message}\n`);
    }
  }

  // Fail-loud: abgelehnte Sätze bedeuten ein unvollständiges Universum.
  if (result.rejected.length > 0) {
    process.stderr.write(
      `[universe:markets] FEHLER: ${result.rejected.length} Preset-Sätze wurden abgelehnt. ` +
        `Preset-Definition in src/universe/presets.ts prüfen.\n`,
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[universe:markets] Abbruch: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
