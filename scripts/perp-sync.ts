#!/usr/bin/env node
/**
 * CLI der historischen Perpetual-Daten (RMA-P2-02, v1.54.0).
 *
 * ```text
 * npm run perp:sync                                          # inkrementell, alle freigegebenen Venues
 * npm run perp:sync -- --mode=backfill --days=30             # Erstbefüllung
 * npm run perp:sync -- --venue=BITUNIX --kinds=funding       # eine Venue, eine Reihe
 * npm run perp:sync -- --dry-run                             # rechnen + klassifizieren, nichts schreiben
 * npm run perp:sync -- --fixture --dry-run                   # Offline-Validierung am Fixture-Adapter (SIM)
 * npm run perp:sync -- --status                              # Gates, Abdeckung, Wasserstände, Quality
 * npm run perp:sync -- --prune-runs=50                       # Manifest-Retention (Datenzeilen bleiben)
 * ```
 *
 * **Ohne Freigabe geht kein Request ab**: `PERP_DATA_SYNC_ENABLED=true` plus
 * `BITUNIX_ENABLED=true` (und keine Kill-Switch) sind Voraussetzung; fehlt
 * etwas, endet der Lauf mit Exit 1 und dem Behebungshinweis der Gate-Kette —
 * nicht mit „0 Instrumente, alles gut“.
 *
 * Der `--fixture`-Pfad (Venue `SIM`) erzeugt deterministische Reihen ohne
 * Netzwerk und ist damit der End-zu-Ende-Nachweis für Sync, Idempotenz und
 * as-of-Lesen in Umgebungen ohne Venue-Zugang. Er ignoriert die Env-Gates
 * **nicht** still: `--fixture` schaltet sie explizit aus und ist als
 * Validierungspfad markiert.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InstrumentRegistry } from "../src/universe/registry";
import { PERP_BOUNDS, PERP_DEFAULTS, PERP_ENV, loadPerpConfig } from "../src/perpdata/config";
import { PERP_AVAILABILITY_POLICIES } from "../src/perpdata/types";
import { PERP_LIMITS, PERP_SERIES_KINDS, type PerpSeriesKind, type PerpSyncMode } from "../src/perpdata/types";
import type { PerpAvailabilityPolicy } from "../src/perpdata/types";
import { createFixturePerpAdapter } from "../src/perpdata/adapters/fixture";
import { InMemoryPerpStore } from "../src/perpdata/memoryStore";
import { PerpDataService } from "../src/perpdata/service";
import type { PerpSyncLogger } from "../src/perpdata/port";

const USAGE = `Perpetual-Daten-Sync (RMA-P2-02) — Funding, Open Interest, Liquidationen.

Aufruf:
  node --import tsx scripts/perp-sync.ts [Optionen]

Optionen:
  --venue=<V>[,<V>]        Venues (Default: PERP_DATA_VENUES bzw. alle bekannten)
  --mode=incremental|backfill
                           Lauf-Modus (Default incremental; backfill = Fenster --days)
  --days=<n>               Backfill-Tage (Default ${PERP_DEFAULTS.backfillDays}, Bereich ${PERP_BOUNDS.backfillDays.min}–${PERP_BOUNDS.backfillDays.max})
  --from=<ISO|ms>          Untere Fenstergrenze der Ereigniszeit
  --to=<ISO|ms>            Obere Fenstergrenze der Ereigniszeit
  --kinds=<r>[,<r>]        funding,openInterest,liquidations (Default: alle)
  --availability=ingested|settlement
                           Verfügbarkeitspolitik (Default ${PERP_DEFAULTS.availability})
  --quality=log|strict     Qualitätsmodus (Default ${PERP_DEFAULTS.qualityMode}; strict = belastete Reihen bleiben ungeschrieben)
  --max-instruments=<n>    Instrumentdeckel je Lauf (Default ${PERP_LIMITS.syncInstruments})
  --concurrency=<n>        parallele Reihen (Default ${PERP_DEFAULTS.concurrency}, max ${PERP_BOUNDS.concurrency.max})
  --safety-lag=<ms>        Nachlauf des Fensters (Default ${PERP_DEFAULTS.safetyLagMs})
  --dry-run                alles rechnen, nichts schreiben (Ablage wird nicht angefasst)
  --fixture                Offline-Probe an der SIM-Venue (Fixture-Adapter, keine Env-Gates)
  --status                 Read-only-Status: Gates, Abdeckung, Wasserstände, Quality-Report
  --refresh-cache          nur das Derivat-Artefakt für Scanner/Analyst aus der
                           Ablage neu bauen (kein Sync, kein Netzwerk)
  --prune-runs=<n>         Manifeste je Venue behalten (Datenzeilen bleiben immer erhalten)
  --json                   Maschinenlesbare Ausgabe (Status wie Sync)
  --help, -h               diese Übersicht

Exit-Codes: 0 = erfolgreich (auch Teilerfolg mit dokumentiertem Fehlbefund),
1 = Gate blockiert, Ablage unerreichbar oder Lauf fehlgeschlagen,
2 = unusueller Aufruf (Flag/Form).`;

class UsageError extends Error {}

interface Args {
  venues: string[] | null;
  mode: PerpSyncMode;
  days: number | null;
  fromMs: number | null;
  toMs: number | null;
  kinds: PerpSeriesKind[] | null;
  availability: PerpAvailabilityPolicy | null;
  quality: "log" | "strict" | null;
  maxInstruments: number | null;
  concurrency: number | null;
  safetyLagMs: number | null;
  dryRun: boolean;
  fixture: boolean;
  status: boolean;
  pruneRuns: number | null;
  /** Derivat-Artefakt für Scanner/Analyst neu bauen (ohne Sync). */
  refreshCache: boolean;
  json: boolean;
  help: boolean;
}

function parseTs(raw: string, flag: string): number {
  const value = raw.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new UsageError(`${flag}: "${raw.slice(0, 40)}" ist kein ISO-8601-/ms-Zeitpunkt.`);
  return ms;
}

function parseCsvEnum<T extends string>(raw: string, flag: string, allowed: readonly T[]): T[] {
  const parts = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) throw new UsageError(`${flag}: mindestens ein Wert erwartet.`);
  const out: T[] = [];
  for (const part of parts) {
    const hit = allowed.find((entry) => entry.toLowerCase() === part);
    if (!hit) throw new UsageError(`${flag}: "${part}" ist nicht erlaubt (erlaubt: ${allowed.join(", ")}).`);
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    venues: null,
    mode: "INCREMENTAL",
    days: null,
    fromMs: null,
    toMs: null,
    kinds: null,
    availability: null,
    quality: null,
    maxInstruments: null,
    concurrency: null,
    safetyLagMs: null,
    dryRun: false,
    fixture: false,
    status: false,
    pruneRuns: null,
    refreshCache: false,
    json: false,
    help: false,
  };
  const readValue = (flag: string): string => {
    const hit = argv.find((entry) => entry.startsWith(`${flag}=`));
    if (!hit) throw new UsageError(`${flag} braucht einen Wert (${flag}=…).`);
    return hit.slice(flag.length + 1);
  };
  const readNumber = (flag: string, min: number, max: number): number => {
    const raw = readValue(flag);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new UsageError(`${flag}: "${raw.slice(0, 24)}" außerhalb des Bereichs ${min}–${max}.`);
    }
    return Math.trunc(value);
  };
  // Flags kommen als `--flag=wert` (siehe USAGE). Ein reines `includes` würde
  // jeden Wert-Flag still übersehen und die Vorgabe des Aufrufers ignorieren —
  // das ist ein Fail-open auf Nutzerintention, also erkennt `has` beide Formen
  // und `readValue` wirft, wenn `--flag` ohne `=wert` steht.
  const has = (flag: string): boolean => argv.some((entry) => entry === flag || entry.startsWith(`${flag}=`));

  if (has("--help") || has("-h")) args.help = true;
  if (has("--dry-run")) args.dryRun = true;
  if (has("--fixture")) args.fixture = true;
  if (has("--status")) args.status = true;
  if (has("--refresh-cache")) args.refreshCache = true;
  if (has("--json")) args.json = true;
  if (has("--venue")) {
    args.venues = readValue("--venue")
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter(Boolean);
    if (args.venues.length === 0) throw new UsageError("--venue: mindestens eine Venue erwartet.");
    for (const venue of args.venues) {
      if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(venue)) {
        throw new UsageError(`--venue: "${venue.slice(0, 32)}" verletzt das Format [A-Z0-9][A-Z0-9_-]{0,31}.`);
      }
    }
  }
  if (has("--mode")) {
    const mode = readValue("--mode").toLowerCase();
    if (mode !== "incremental" && mode !== "backfill") throw new UsageError("--mode: erwartet incremental|backfill.");
    args.mode = mode === "backfill" ? "BACKFILL" : "INCREMENTAL";
  }
  if (has("--days")) args.days = readNumber("--days", PERP_BOUNDS.backfillDays.min, PERP_BOUNDS.backfillDays.max);
  if (has("--from")) args.fromMs = parseTs(readValue("--from"), "--from");
  if (has("--to")) args.toMs = parseTs(readValue("--to"), "--to");
  if (has("--kinds")) args.kinds = parseCsvEnum(readValue("--kinds"), "--kinds", PERP_SERIES_KINDS);
  if (has("--availability")) {
    const policy = readValue("--availability");
    if (!(PERP_AVAILABILITY_POLICIES as readonly string[]).includes(policy)) {
      throw new UsageError(`--availability: erwartet ${PERP_AVAILABILITY_POLICIES.join("|")}.`);
    }
    args.availability = policy as PerpAvailabilityPolicy;
  }
  if (has("--quality")) {
    const mode = readValue("--quality");
    if (mode !== "log" && mode !== "strict") throw new UsageError("--quality: erwartet log|strict.");
    args.quality = mode;
  }
  if (has("--max-instruments")) {
    args.maxInstruments = readNumber("--max-instruments", 1, PERP_LIMITS.syncInstruments);
  }
  if (has("--concurrency")) args.concurrency = readNumber("--concurrency", PERP_BOUNDS.concurrency.min, PERP_BOUNDS.concurrency.max);
  if (has("--safety-lag")) args.safetyLagMs = readNumber("--safety-lag", PERP_BOUNDS.safetyLagMs.min, PERP_BOUNDS.safetyLagMs.max);
  if (has("--prune-runs")) args.pruneRuns = readNumber("--prune-runs", 1, 1_000);
  const unknown = argv.filter((entry) => entry.startsWith("--") && !entry.startsWith("--venue") && !entry.startsWith("--mode") &&
    !entry.startsWith("--days") && !entry.startsWith("--from") && !entry.startsWith("--to") && !entry.startsWith("--kinds") &&
    !entry.startsWith("--availability") && !entry.startsWith("--quality") && !entry.startsWith("--max-instruments") &&
    !entry.startsWith("--concurrency") && !entry.startsWith("--safety-lag") && !entry.startsWith("--prune-runs") &&
    !["--dry-run", "--fixture", "--status", "--refresh-cache", "--json", "--help"].includes(entry));
  if (unknown.length > 0) throw new UsageError(`unbekannte Option(en): ${unknown.join(", ")} — --help zeigt die zulässigen.`);
  return args;
}

/**
 * Temporäre Fixture-Universe (nur `--fixture`): zwei SIM-Perpetuals, damit der
 * Offline-Pfad denselben Registry-Filter durchläuft wie der Produktivpfad
 * (`marketType === \"perpetual\"`). Nie für echte Venues verwendet.
 */
function fixtureRegistry(): InstrumentRegistry {
  const registry = new InstrumentRegistry({ dir: mkdtempSync(path.join(tmpdir(), "perp-fixture-")), autoSave: false });
  registry.load();
  registry.upsertMany(
    ["BTCUSDT", "ETHUSDT"].map((symbol) => ({
      venue: "SIM",
      symbol,
      base: symbol.replace(/USDT$/, ""),
      quote: "USDT",
      assetClass: "crypto" as const,
      marketType: "perpetual" as const,
      status: "active" as const,
    })),
    "fixture:perp-sync",
    "SEED"
  );
  return registry;
}

const logger: PerpSyncLogger = (level, line) => {
  const prefix = level === "error" ? "[perp:error] " : level === "warn" ? "[perp:warn]  " : "[perp]       ";
  const stream = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  stream(`${prefix}${line}`);
};

/**
 * Übersetzt CLI-Flags in eine Env-Map (reine Funktion — `process.env` wird
 * nicht mutiert). Der Service liest ausschließlich Env, das hält die Gates an
 * einer Stelle.
 */
export function envFromArgs(args: Args, base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  const overrides: Record<string, string> = {};
  if (args.fixture) {
    // Offline-Validierungspfad: Gates offen, Venue SIM, kein Netz-Adapter.
    overrides[PERP_ENV.ENABLED] = "true";
    overrides[PERP_ENV.SYNC_ENABLED] = "true";
    overrides[PERP_ENV.VENUES] = "SIM";
  }
  if (args.venues && !args.fixture) overrides[PERP_ENV.VENUES] = args.venues.join(",");
  if (args.availability) overrides[PERP_ENV.AVAILABILITY] = args.availability;
  if (args.quality) overrides[PERP_ENV.QUALITY_MODE] = args.quality;
  if (args.days !== null) overrides[PERP_ENV.BACKFILL_DAYS] = String(args.days);
  if (args.safetyLagMs !== null) overrides[PERP_ENV.SAFETY_LAG_MS] = String(args.safetyLagMs);
  if (args.concurrency !== null) overrides[PERP_ENV.CONCURRENCY] = String(args.concurrency);
  return { ...env, ...overrides };
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`[perp] ${error.message}`);
      console.error(USAGE);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const env = envFromArgs(args, process.env);
  const config = loadPerpConfig(env);
  // `--dry-run` schreibt in eine Speicher-Ablage statt in die echte: die ganze
  // Kette (Wasserstand → Adapter → Normalisierung → Qualität → Ansetzen) läuft
  // durch, die Postgres-Ablage bleibt unberührt — und der Pfad ist damit ohne
  // Datenbank prüfbar. Ein Dry-Run, der nur bis zum Adapter ginge, wäre keine
  // Validierung der Idempotenzkette.
  const service = new PerpDataService({
    env,
    config,
    logger,
    ...(args.dryRun ? { store: new InMemoryPerpStore() } : {}),
    // Der Fixture-Pfad bekommt Adapter **und** Universe in einer temporären
    // Registry (Venue `SIM`, zwei Perpetuals): identischer Sync-Pfad, nur ohne
    // Netz. Die Ablage bleibt die echte, damit dieselbe Idempotenzkette läuft
    // (bei `--dry-run` wird sie gar nicht angefasst).
    ...(args.fixture
      ? {
          adapters: new Map([["SIM", createFixturePerpAdapter({})]]),
          registry: fixtureRegistry(),
        }
      : {}),
  });

  if (args.status) {
    const status = await service.status(args.venues?.[0] ?? null);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, status }, null, 2));
      return status.store.status === "ready" ? 0 : 1;
    }
    printStatus(status);
    return status.store.status === "ready" ? 0 : 1;
  }

  // Artefakt-Pfad ohne Sync: Konsumenten (Scanner/Analyst) lesen ein as-of
  // gebautes Derivat-Artefakt; nach einem Restore oder bei verwerflichem Alter
  // wird es hier neu gebaut — ohne Netzwerk, ohne Adapter-Freigabe.
  if (args.refreshCache) {
    try {
      const refreshed = await service.refreshDerivativeCache();
      const line =
        `[perp] Derivat-Artefakt ${refreshed.written ? "geschrieben" : "nicht geschrieben"}: ` +
        `${refreshed.available} von ${refreshed.entries} Instrument(en) mit Wert → ${refreshed.file}` +
        `${refreshed.reason === "OK" ? "" : ` (${refreshed.reason})`}`;
      if (args.json) {
        console.log(JSON.stringify({ ok: refreshed.written && !refreshed.storeUnavailable, ...refreshed }, null, 2));
      } else {
        console.log(line);
        if (refreshed.storeUnavailable) {
          console.error("[perp:warn]  Ablage nicht erreichbar — alle Einträge stehen auf UNAVAILABLE (kein Scan mit Alt-Werten).");
        }
      }
      if (refreshed.storeUnavailable) return 1;
      return refreshed.written || refreshed.reason === "DISABLED" ? 0 : 1;
    } catch (error) {
      console.error(`[perp] Artefakt-Aufbau fehlgeschlagen: ${(error as Error).message}`);
      return 1;
    }
  }

  if (args.pruneRuns !== null) {
    try {
      const pruned = await service.store.pruneRuns(args.pruneRuns);
      console.log(`[perp] Manifest-Retention: ${pruned} Lauf-Manifest(e) entfernt (Datenzeilen unverändert).`);
      return 0;
    } catch (error) {
      console.error(`[perp] Retention fehlgeschlagen: ${(error as Error).message}`);
      return 1;
    }
  }

  const runVenues = args.fixture ? ["SIM"] : (args.venues ?? [...new Set([...config.venues ?? []])]);
  const result = await service.sync({
    ...(runVenues.length > 0 ? { venues: runVenues } : {}),
    mode: args.mode,
    from: args.fromMs,
    to: args.toMs,
    ...(args.days !== null ? { days: args.days } : {}),
    ...(args.kinds ? { kinds: args.kinds } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
    ...(args.maxInstruments !== null ? { maxInstruments: args.maxInstruments } : {}),
    ...(args.concurrency !== null ? { concurrency: args.concurrency } : {}),
    ...(args.fixture ? { ignoreEnvGates: true } : {}),
  });

  if (args.json) {
    console.log(JSON.stringify({ ok: result.totals.failures === 0, ...result }, null, 2));
  } else {
    for (const venue of result.venues) {
      const line = `[perp] ${venue.message}`;
      if (venue.skipped !== null || (venue.aggregate && venue.aggregate.status === "FAILED")) console.error(line);
      else console.log(line);
      for (const entry of venue.results) {
        for (const failure of entry.failures.slice(0, 8)) {
          console.warn(`[perp:warn]  ${entry.venue} ${failure.kind}${failure.instrumentId ? ` ${failure.instrumentId}` : ""}: ${failure.reason} — ${failure.message}`);
        }
        if (entry.failures.length > 8) {
          console.warn(`[perp:warn]  … ${entry.failures.length - 8} weitere Fehlbefunde (vollständig: --json bzw. data/perpdata/quality-report.json).`);
        }
      }
    }
    if (result.venues.length === 0) {
      console.error("[perp] Keine Venue im Scope — Gate-Kette: " + `${PERP_ENV.SYNC_ENABLED}=true, <VENUE>_ENABLED=true, Allowlist ${PERP_ENV.VENUES}.`);
    }
  }

  // Nach einem echten Lauf das Konsumenten-Artefakt nachziehen (as-of gelesen).
  // Dry-Runs schreiben es bewusst nicht — sonst würde ein Testlauf den Scan
  // mit Daten versorgen, die nie die Ablage erreicht haben.
  if (!args.dryRun && config.enabled && result.totals.written > 0) {
    try {
      const refreshed = await service.refreshDerivativeCache();
      if (!args.json) {
        console.log(
          `[perp]       Derivat-Artefakt: ` +
            (refreshed.written
              ? `${refreshed.available}/${refreshed.entries} Instrument(e) mit Wert → ${refreshed.file}`
              : `nicht aktualisiert (${refreshed.reason})`)
        );
      }
    } catch (error) {
      console.error(
        `[perp:warn]  Derivat-Artefakt nicht geschrieben: ${error instanceof Error ? error.message.slice(0, 160) : "unbekannt"}`
      );
    }
  }

  const blocked = result.venues.length === 0 || result.venues.every((venue) => venue.skipped !== null);
  const failed = result.venues.some((venue) => venue.aggregate?.status === "FAILED");
  if (blocked && !args.dryRun) {
    if (!args.json) {
      console.error(
        `[perp] Kein Sync gelaufen — Freigaben fehlen. ${PERP_ENV.ENABLED}=${String(config.enabled)}, ` +
          `${PERP_ENV.SYNC_ENABLED}=${String(config.syncEnabled)}. Offline-Validierung: --fixture --dry-run.`
      );
    }
    return 1;
  }
  if (failed && !args.json) return 1;
  return failed ? 1 : 0;
}

function printStatus(status: Awaited<ReturnType<PerpDataService["status"]>>): void {
  console.log(`Perpetual-Daten (RMA-P2-02) — Stand ${status.generatedAt}`);
  console.log(`  Gates       : ${status.enabled ? "Konsumenten AN" : "Konsumenten AUS"} / Sync ${status.syncEnabled ? "AN" : "AUS"}`);
  console.log(`  Politik      : available_at = ${status.availabilityPolicy}; Qualität ${status.qualityMode}`);
  console.log(
    `  Grenzen      : Backfill ${status.limits.backfillDays} d, Funding-Raster ${status.limits.fundingIntervalHours} h, ` +
      `OI-Raster ${status.limits.oiIntervalMinutes} min, Staleness F=${Math.round(status.limits.maxStaleMs.funding / 3_600_000)} h / ` +
      `OI=${Math.round(status.limits.maxStaleMs.openInterest / 3_600_000)} h, |Rate| ≤ ${status.limits.maxAbsFundingRate}`
  );
  for (const entry of status.venues) {
    const caps = (["funding", "openInterest", "liquidations"] as const)
      .map((kind) => {
        const capability = entry.capabilities[kind];
        return `${kind}=${capability.supported ? "ok" : `unsupported:${capability.reason}`}`;
      })
      .join(", ");
    console.log(
      `  Venue ${entry.venue.padEnd(9)}: adapter=${entry.adapterReady ? "ready" : "nein"}` +
        `${entry.skippedReason ? ` (${entry.skippedReason})` : ""}; ${caps}`
    );
  }
  console.log(`  Ablage       : ${status.store.status}${status.store.message ? ` — ${status.store.message}` : ""}`);
  if (status.coverage.length === 0) {
    console.log("  Abdeckung    : keine Zeilen (As-of-Bestand leer)");
  }
  for (const entry of status.coverage) {
    console.log(
      `    ${entry.venue} ${entry.kind.padEnd(13)} ${String(entry.rows).padStart(7)} Zeilen, ${entry.instruments} Instrument(e), ` +
        `${entry.nullRows} ohne Wert, ${entry.invalidRows} invalid; letzte ${entry.lastEventTime ?? "—"} (Alter ${entry.ageMs === null ? "—" : `${Math.round(entry.ageMs / 60_000)} min`})`
    );
  }
  if (status.cursors.length > 0) {
    console.log(`  Wasserstände  : ${status.cursors.length}${status.cursorsTruncated ? "+ (gekürzt)" : ""}`);
    for (const cursor of status.cursors.slice(0, 10)) {
      console.log(
        `    ${cursor.instrumentId} ${cursor.kind.padEnd(13)} ${cursor.watermarkEventTime.toISOString()} status=${cursor.lastStatus}` +
          `${cursor.consecutiveFailures > 0 ? ` failures=${cursor.consecutiveFailures}` : ""}${cursor.unsupportedReason ? ` unsupported=${cursor.unsupportedReason}` : ""}`
      );
    }
  }
  if (status.runs.length > 0) {
    console.log("  Letzte Läufe  :");
    for (const run of status.runs.slice(0, 5)) {
      console.log(
        `    ${run.startedAt.toISOString()} ${run.venue} ${run.mode} ${run.status} Instrumente=${run.instrumentIds.length}` +
          `${run.errorCode ? ` error=${run.errorCode}` : ""}`
      );
    }
  }
  console.log(
    `  Derivat-Artefakt: ${status.derivativeCache.entries} Instrument(e)` +
      (status.derivativeCache.writtenAt ? `, geschrieben ${status.derivativeCache.writtenAt}` : "") +
      (status.derivativeCache.ageMs !== null ? `, Alter ${Math.round(status.derivativeCache.ageMs / 60_000)} min` : "") +
      (status.derivativeCache.reason ? `, Grund ${status.derivativeCache.reason}` : "") +
      ` (${status.derivativeCache.file})`
  );
  console.log(
    `  Quality-Report: ${status.quality.writtenAt ?? "kein Report"} (${status.quality.file})` +
      (status.quality.totals ? ` — ${JSON.stringify(status.quality.totals.byClass)}` : "")
  );
}

/**
 * Selbstaufruf nur, wenn diese Datei **ausgeführt** wird — nicht, wenn ein Test
 * die reinen Helfer (`parseArgs`, `envFromArgs`) importiert. Ohne diese Grenze
 * würde ein Import den CLI-Lauf starten und `process.exitCode` des Testprozesses
 * verändern (Exit-Code 1 durch geschlossene Gates = rote Suite ohne Defekt).
 */
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`[perp] Lauf fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}

/** Exportiert für Tests (Parser/Env-Übersetzung ohne IO). */
export { parseArgs, UsageError };
