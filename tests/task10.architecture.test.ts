/**
 * Architektur-Regression Task 10: Drifts dürfen nicht zurückkehren.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

test("Architecture-Tab empfiehlt keine fremde Agenten-Runtime", () => {
  const src = read("src/components/FirmDashboard.tsx");
  assert.equal(src.includes("LangGraph"), false);
  assert.equal(src.includes("AutoGen"), false);
  assert.equal(src.includes("CrewAI"), false);
  assert.ok(src.includes("OperationsCenterPanel"));
  assert.ok(src.includes("ops"));
});

test("Bitunix-Secrets: kein TODO(task-08), Default-Store existiert", () => {
  const src = read("src/brokers/bitunix/secrets.ts");
  assert.equal(src.includes("TODO(task-08)"), false);
  assert.ok(src.includes("createDefaultBitunixSecretStore"));
  assert.ok(src.includes("createVenueBackedNamedStore"));
});

test("HANDBUCH Kap. 8 beschreibt nicht mehr das statische Kursbuch als Default", () => {
  const src = read("docs/HANDBUCH.md");
  assert.equal(src.includes("Paper-Broker mit statischem Kursbuch"), false);
  assert.ok(src.includes("broker-market-data") || src.includes("Modus B"));
  assert.ok(src.includes("Control Plane") || src.includes("AES-256-GCM"));
});

test("HANDBUCH 19.4 behauptet nicht mehr, Task 09 stehe aus", () => {
  const src = read("docs/HANDBUCH.md");
  assert.equal(src.includes("Bis zum Einbau des Model-Routers (Task 09)"), false);
  assert.ok(src.includes("requestEscalation"));
});

test("Plan-Datei Task 10 liegt unter docs/", () => {
  const src = read("docs/task-10-IMPLEMENTATION_PLAN.md");
  assert.ok(src.includes("Phase 1"));
  assert.ok(src.includes("live.gate"));
});
