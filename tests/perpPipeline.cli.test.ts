/**
 * CLI- und Routenvertrag der Perp-Daten (RMA-P2-02).
 *
 * Der Sync-Kern ist in `perpPipeline.sync.test.ts` geprüft; hier geht es um die
 * beiden Ränder, an denen Absicht verloren gehen kann:
 *   1. `scripts/perp-sync.ts` — Flags müssen *ankommen* (ein still
 *      ignoriertes `--kinds=funding` wäre ein Lauf gegen die falsche Absicht),
 *      und Wert-Flags brauchen ihren Wert.
 *   2. Die as-of-Route — Ablehnung muss als klassifizierter 400/503-Körper
 *      enden, nie als 200 mit leerem Bestand, und sie ist ausschließlich lesend.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { parseArgs, envFromArgs, UsageError } from "../scripts/perp-sync";
import { PERP_ENV } from "../src/perpdata/config";
import { GET as seriesGET } from "../src/app/api/marketdata/perpetual/series/route";
import { GET as statusGET } from "../src/app/api/marketdata/perpetual/status/route";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "scripts", "perp-sync.ts");

function parse(argv: readonly string[]): ReturnType<typeof parseArgs> {
  return parseArgs(argv);
}

function parseFails(argv: readonly string[], fragment: string): void {
  assert.throws(
    () => parseArgs(argv),
    (error: unknown) => error instanceof UsageError && String((error as Error).message).includes(fragment),
    `erwartet UsageError mit „${fragment}“`
  );
}

describe("perp-sync CLI: Argument-Parser (Off-by-intent wird hart abgelehnt)", () => {
  it("Defaults: inkrementell, nichts gesetzt, keine trockene Schreibmode", () => {
    const args = parse([]);
    assert.equal(args.mode, "INCREMENTAL");
    assert.equal(args.venues, null);
    assert.equal(args.days, null);
    assert.equal(args.fromMs, null);
    assert.equal(args.toMs, null);
    assert.equal(args.kinds, null);
    assert.equal(args.availability, null);
    assert.equal(args.quality, null);
    assert.equal(args.dryRun, false);
    assert.equal(args.fixture, false);
    assert.equal(args.status, false);
    assert.equal(args.refreshCache, false);
    assert.equal(args.json, false);
    assert.equal(args.help, false);
  });

  it("Schalter ohne Wert setzen boolean", () => {
    const args = parse(["--dry-run", "--fixture", "--json", "--status"]);
    assert.deepEqual([args.dryRun, args.fixture, args.json, args.status], [true, true, true, true]);
  });

  it("Wert-Flags werden erkannt — nicht still ignoriert", () => {
    const args = parse(["--venue=bitunix,BITUNIX ", "--mode=Backfill", "--days=14", "--kinds=funding,LIQUIDATIONS"]);
    assert.deepEqual(args.venues, ["BITUNIX", "BITUNIX"], "Großschreibung/Trim ja, Dedomplung ist Sache des Services");
    assert.equal(args.mode, "BACKFILL");
    assert.equal(args.days, 14);
    assert.deepEqual(args.kinds, ["funding", "liquidations"]);
  });

  it("--help/-h, Venue-Format und Reihenarten", () => {
    assert.equal(parse(["--help"]).help, true);
    assert.equal(parse(["-h"]).help, true);
    parseFails(["--venue=BIT/UNIX"], "verletzt das Format");
    parseFails(["--venue="], "mindestens eine Venue");
    parseFails(["--kinds=trades"], "ist nicht erlaubt");
    parseFails(["--kinds="], "mindestens ein Wert");
    parseFails(["--mode=live"], "erwartet incremental|backfill");
  });

  it("Wert ohne `=` ist ein Fehlgebrauch, keine Stille", () => {
    parseFails(["--venue"], "braucht einen Wert");
    parseFails(["--days"], "braucht einen Wert");
    parseFails(["--nope=1"], "unbekannte Option");
  });

  it("Zahlen bleiben in den konfigurierten Grenzen", () => {
    assert.equal(parse(["--days=1"]).days, 1);
    assert.equal(parse(["--days=2.9"]).days, 2, "ganze Tage, abgeschnitten");
    parseFails(["--days=0"], "außerhalb des Bereichs");
    parseFails(["--days=99999"], "außerhalb des Bereichs");
    parseFails(["--days=abc"], "außerhalb des Bereichs");
    assert.equal(parse(["--concurrency=8"]).concurrency, 8);
    parseFails(["--concurrency=99"], "außerhalb des Bereichs");
    assert.equal(parse(["--max-instruments=1"]).maxInstruments, 1);
    parseFails(["--max-instruments=0"], "außerhalb des Bereichs");
    assert.equal(parse(["--prune-runs=5"]).pruneRuns, 5);
    parseFails(["--prune-runs=0"], "außerhalb des Bereichs");
    parseFails(["--prune-runs=1001"], "außerhalb des Bereichs");
  });

  it("Zeitfenster: ISO oder Epoch-ms, nie Geraten", () => {
    const iso = Date.parse("2026-01-01T00:00:00.000Z");
    assert.equal(parse([`--from=2026-01-01T00:00:00.000Z`]).fromMs, iso);
    assert.equal(parse([`--from=${iso}`]).fromMs, iso, "Epoch-ms werden akzeptiert");
    assert.equal(parse([`--to=2026-01-02`]).toMs, Date.parse("2026-01-02T00:00:00.000Z"));
    parseFails(["--from=gestern"], "ist kein ISO-8601-/ms-Zeitpunkt");
    parseFails(["--to=2026-13-45"], "ist kein ISO-8601-/ms-Zeitpunkt");
  });

  it("Verfügbarkeits- und Qualitätsolitik nur als Enum", () => {
    assert.equal(parse(["--availability=settlement"]).availability, "settlement");
    assert.equal(parse(["--quality=strict"]).quality, "strict");
    parseFails(["--availability=now"], "erwartet");
    parseFails(["--quality=off"], "erwartet log|strict");
  });

  it("envFromArgs übersetzt in Env — ohne process.env anzufassen", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "/bin",
      NODE_ENV: "test",
      [PERP_ENV.ENABLED]: "false",
      [PERP_ENV.MAX_ABS_FUNDING_RATE]: "0.01",
    };
    const snapshot = JSON.stringify(process.env);

    const fixture = envFromArgs(parse(["--fixture", "--dry-run", "--days=3", "--quality=strict", "--safety-lag=1500"]), base);
    assert.equal(fixture[PERP_ENV.ENABLED], "true", "--fixture öffnet das Daten-Gate");
    assert.equal(fixture[PERP_ENV.SYNC_ENABLED], "true");
    assert.equal(fixture[PERP_ENV.VENUES], "SIM");
    assert.equal(fixture[PERP_ENV.QUALITY_MODE], "strict");
    assert.equal(fixture[PERP_ENV.BACKFILL_DAYS], "3");
    assert.equal(fixture[PERP_ENV.SAFETY_LAG_MS], "1500");
    assert.equal(fixture[PERP_ENV.MAX_ABS_FUNDING_RATE], "0.01", "unbekannte Flags bleiben unangetastet");
    assert.equal(fixture[PERP_ENV.CONCURRENCY], undefined, "nicht gesetzte Flags werden nicht erfunden");

    const real = envFromArgs(parse(["--venue=bitunix,bybit", "--availability=settlement", "--concurrency=4"]), base);
    assert.equal(real[PERP_ENV.VENUES], "BITUNIX,BYBIT");
    assert.equal(real[PERP_ENV.ENABLED], "false", "ohne --fixture gilt die Umgebung — kein Selbstfreischalten");
    assert.equal(real[PERP_ENV.AVAILABILITY], "settlement");
    assert.equal(real[PERP_ENV.CONCURRENCY], "4");

    // --fixture ist hart: eine Venue-Angabe ändert die Test-Venue nicht.
    const mixed = envFromArgs(parse(["--fixture", "--venue=bitunix"]), base);
    assert.equal(mixed[PERP_ENV.VENUES], "SIM");
    assert.equal(JSON.stringify(process.env), snapshot, "process.env wird nicht mutiert");
  });
});

describe("Perp-Routen: read-only, klassifizierte Ablehnung", () => {
  const url = (query: string): Request => new Request(`https://example.test/api/marketdata/perpetual/series${query}`);

  it("fehlende Instrumente ⇒ 400 mit Fehlerkörper und Hinweis", async () => {
    const response = await seriesGET(url(""));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
    assert.equal(body.error, "query:instruments_required");
    assert.equal(typeof body.message, "string");
    assert.match(String(body.hint), /instruments=/);
  });

  it("unbekannte Reihenart / Zeit / Limit ⇒ 400, nie 200 mit leerer Liste", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["?instruments=BITUNIX:BTCUSDT&kinds=trades", "query:kind_invalid"],
      ["?instruments=BITUNIX:BTCUSDT&asOf=gestern", "query:time_invalid"],
      ["?instruments=BITUNIX:BTCUSDT&limit=0", "query:limit_invalid"],
      ["?instruments=", "query:instruments_required"],
    ];
    for (const [query, code] of cases) {
      const response = await seriesGET(url(query));
      assert.equal(response.status, 400, `${query} muss abgelehnt werden`);
      const body = (await response.json()) as Record<string, unknown>;
      assert.equal(body.error, code, `${query} ⇒ ${code}`);
      assert.equal(body.ok, false);
    }
  });

  it("beide Routen exportieren ausschließlich GET (kein Sync-Trigger, kein Schreibpfad)", async () => {
    const routeModule = await import("../src/app/api/marketdata/perpetual/series/route");
    const exported = Object.keys(routeModule).sort();
    assert.deepEqual(exported, ["GET", "dynamic"], "nur GET + Rendering-Hinweis");
    assert.equal(routeModule.dynamic, "force-dynamic");
    assert.equal(typeof seriesGET, "function");
    assert.equal(typeof statusGET, "function");
  });
});

describe("perp-sync CLI: End-to-End gegen das Offline-Fixture-Bett", () => {
  const run = (args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        // Die Gates stehen bewusst auf AUS: `--fixture` muss sie öffnen, ohne
        // dass die Umgebung des Aufrufers freischaltet.
        [PERP_ENV.ENABLED]: "false",
        [PERP_ENV.SYNC_ENABLED]: "false",
        [PERP_ENV.VENUES]: "BITUNIX",
      },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

  it("--help listet jeden Flag, den der Parser kennt", () => {
    const { status, stdout } = run(["--help"]);
    assert.equal(status, 0);
    for (const flag of [
      "--venue", "--mode", "--days", "--from", "--to", "--kinds", "--availability", "--quality",
      "--max-instruments", "--concurrency", "--safety-lag", "--dry-run", "--fixture", "--status",
      "--refresh-cache", "--prune-runs", "--json", "--help",
    ]) {
      assert.ok(stdout.includes(flag), `USAGE zeigt ${flag} nicht`);
    }
  });

  it("--fixture --dry-run läuft komplett offline und respektiert --kinds", () => {
    const { status, stdout } = run(["--fixture", "--dry-run", "--mode=backfill", "--days=3", "--kinds=funding", "--json"]);
    assert.equal(status, 0, `CLI scheiterte: ${stdout.slice(0, 400)}`);
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      totals: { fetched: number; written: number; failures: number; runs: number; qualityFindings: Record<string, number> };
      venues: { venue: string; aggregate: { status: string; stats: Record<string, { fetched: number; written: number }> } | null }[];
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.totals.runs, 1);
    assert.equal(payload.totals.failures, 0);
    assert.equal(payload.totals.written, 0, "Dry-Run schreibt nichts in die Ablage");
    assert.ok(payload.totals.fetched > 0, "Funding wurde gelesen");
    const stats = payload.venues[0]?.aggregate?.stats;
    assert.ok((stats?.funding?.fetched ?? 0) > 0, "Funding-Reihe lief");
    assert.equal(stats?.openInterest?.fetched, 0, "--kinds=funding darf keine OI-Reihe anfragen");
    assert.equal(stats?.liquidations?.fetched, 0, "--kinds=funding darf keine Liquidationen anfragen");
  });

  it("verschlossene Gates ohne --fixture ⇒ Exit 1 mit Hinweis, nicht Exit 0", () => {
    const { status, stdout, stderr } = run([]);
    assert.equal(status, 1, `erwartet 1, stdout=${stdout.slice(0, 200)}`);
    assert.match(stdout + stderr, /Freigaben fehlen|Kein Sync gelaufen|Gates/);
    assert.doesNotMatch(stdout + stderr, /written/i, "kein Lauf, also keine Schreibmeldung");
  });
});
