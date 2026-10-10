/**
 * DC-09 — Vertrag der generierten Mengen-Inventare und des Header-Bumps.
 *
 * Prüft die Akzeptanzkriterien maschinell, damit sie nicht nur einmal bei der
 * Einführung gelten:
 *   - die committed Inventare in docs/generated/ sind aktuell (Drift = rot),
 *   - die Generierung ist deterministisch und das Stand-Datum nur optional,
 *   - schreibende Routen ohne Guard sind gesichtet (kein stiller Rückfall zu DC-01),
 *   - der Bump erfasst genau die Code-Version-Header und nie Dokument-Version,
 *   - der Env-Read-Analyzer erkennt Flags über computed-key-Maps (BINANCE_ENABLED).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { envReadsFromCode } from "../scripts/docs-validate-checks";
import {
  REVIEWED_UNGUARDED_WRITES,
  checkInventories,
  renderAllInventories,
  renderRouteInventory,
  reviewedWriteProblems,
  type RouteRow,
} from "../scripts/gen-docs-inventories";
import { planBump, readPackageVersion } from "../scripts/bump-docs-version";

const route = (urlPath: string, method: RouteRow["methods"][number]["method"], guard: string): RouteRow => ({
  urlPath,
  source: `src/app/api${urlPath.replace("/api", "")}/route.ts`,
  methods: [{ method, guard, guarded: guard !== "keiner" }],
});

describe("DC-09 · generierte Inventare", () => {
  test("committed docs/generated/ entspricht der Neu-Erzeugung (Drift-Gate)", () => {
    const res = checkInventories();
    assert.equal(res.ok, true, res.problems.join(" | "));
  });

  test("Erzeugung ist deterministisch: zweimal rendern ⇒ identische Bytes", () => {
    const first = renderAllInventories("").map((d) => d.content);
    const second = renderAllInventories("").map((d) => d.content);
    assert.deepEqual(second, first);
  });

  test("Stand-Datum ist optional und ändert nur die Stand-Zeile", () => {
    const plain = renderAllInventories("");
    const dated = renderAllInventories("2026-10-10");
    for (let i = 0; i < plain.length; i++) {
      assert.ok(dated[i].content.includes("**Stand:** 2026-10-10"), `${plain[i].name}: Stand fehlt`);
      assert.equal(
        dated[i].content.replace(/^\*\*Stand:\*\*[^\n]*\n/m, ""),
        plain[i].content.replace(/^\*\*Stand:\*\*[^\n]*\n/m, ""),
        `${plain[i].name}: Stand verändert mehr als die Stand-Zeile`,
      );
    }
  });

  test("jedes Inventar trägt die Kopfzeile „GENERIERT — nicht editieren“ und LF-Zeilenenden", () => {
    for (const doc of renderAllInventories("")) {
      assert.ok(doc.content.includes("GENERIERT — nicht editieren (`npm run docs:inventories`)"), doc.name);
      assert.equal(doc.content.includes("\r"), false, `${doc.name}: CR im Ausgabetext`);
    }
  });

  test("Routen: schreibende Methode ohne Guard erscheint als Warnzeile am Tabellenkopf", () => {
    const md = renderRouteInventory([route("/api/x/write", "POST", "keiner")], "");
    const warning = md.indexOf("WARNUNG");
    const table = md.indexOf("| Route | Methode");
    assert.ok(warning > 0, "Warnzeile fehlt");
    assert.ok(warning < table, "Warnzeile steht nicht vor der Tabelle");
    assert.match(md, /`POST \/api\/x\/write`/);
  });

  test("Routen: GET ohne Guard löst keine Warnzeile aus", () => {
    const md = renderRouteInventory([route("/api/x/read", "GET", "keiner")], "");
    assert.equal(md.includes("WARNUNG"), false);
  });

  test("Gate: ungesichtete schreibende Route ohne Guard ist ein Problem", () => {
    const problems = reviewedWriteProblems([route("/api/neu/write", "PUT", "keiner")]);
    assert.ok(problems.some((p) => p.startsWith("PUT /api/neu/write")), problems.join(" | "));
  });

  test("Gate: veralteter Eintrag in der Sichtungsliste ist ein Problem", () => {
    const problems = reviewedWriteProblems([]);
    assert.equal(problems.length, REVIEWED_UNGUARDED_WRITES.size, "jeder Sichtungs-Eintrag muss als veraltet gemeldet werden");
  });

  test("Gate: jede Sichtung hat eine Begründung", () => {
    for (const [key, reason] of REVIEWED_UNGUARDED_WRITES) {
      assert.ok(reason.trim().length > 20, `${key}: Begründung zu kurz`);
    }
  });

  test("Env-Analyzer: Flags über computed-key-Maps werden als Read erkannt", () => {
    const reads = envReadsFromCode([
      {
        filePath: "src/y.ts",
        content: [
          'const VENUE_A = "BINANCE";',
          'const FLAGS: Record<string, string> = { [VENUE_A]: "BINANCE_ENABLED" };',
          "export function on(env: Record<string, string | undefined>, venue: string) {",
          "  const flag = FLAGS[venue];",
          '  return env[flag] === "true";',
          "}",
        ].join("\n"),
      },
    ]);
    assert.ok(reads.has("BINANCE_ENABLED"), `BINANCE_ENABLED nicht erkannt: ${[...reads].join(",")}`);
  });
});

describe("DC-09 · Header-Bump (bump-docs-version)", () => {
  test("package.json-Version ist SemVer", () => {
    assert.match(readPackageVersion(), /^\d+\.\d+\.\d+/);
  });

  test("Bump erfasst genau die Code-Version-Header, nie Dokument-Version, nie archive/audits/generated", () => {
    const plan = planBump("9.9.9");
    assert.ok(plan.changes.length > 0, "Bump plant keine Änderungen");
    const files = plan.changes.map((c) => c.file);
    for (const file of files) {
      assert.equal(/\/(archive|audits|peer-reviews|generated)\//.test(file), false, `${file} hätte nicht erfasst werden dürfen`);
      assert.equal(file.startsWith("docs/"), true, `${file} liegt außerhalb docs/`);
      const body = plan.contents.get(file) ?? "";
      assert.ok(body.includes("9.9.9"), `${file}: neue Version fehlt im Ergebnis`);
    }
    // Reine Dokument-Version-Dateien bleiben unberührt.
    for (const file of ["docs/PORTFOLIO_ANALYTICS.md", "docs/MIGRATION_TIMEFRAME_FIELD.md"]) {
      assert.equal(files.includes(file), false, `${file} (nur Dokument-Version) darf nicht geplant werden`);
    }
    // Mischzeile (Code-Version + Dokument-Version): nur die Code-Version wandert, Schema bleibt.
    const mixed = plan.contents.get("docs/DEVILS_ADVOCATE.md") ?? "";
    assert.ok(mixed.includes("**Dokument-Version:** Schema `da1`"), "Dokument-Version-Angabe wurde verändert");
    assert.ok(mixed.includes("**Code-Version:** v9.9.9"), "Code-Version wurde nicht auf 9.9.9 gesetzt");
  });

  test("Bump-Plan ist bei aktueller Version leer (idempotent nach --write)", () => {
    const plan = planBump(readPackageVersion());
    assert.equal(plan.changes.length, 0);
  });
});
