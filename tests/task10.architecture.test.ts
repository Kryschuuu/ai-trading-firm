/**
 * Architektur-Regression Task 10: Drifts dürfen nicht zurückkehren.
 *
 * Zusätzlich zur Historie (Agenten-Runtime, Bitunix-Secrets, HANDBUCH) sichert
 * dieser Test den Kernbefund der Task-10-Nachprüfung: das Operations Center
 * darf sich nicht wieder als Platzhalter („Hülle“/„Phase 1“/Stub) beschreiben
 * und muss alle zehn Sektionen wirklich aggregieren.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OPS_SECTION_IDS } from "../src/ops/types";

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/** Dateien, die das Operations Center tragen. */
const OPS_FILES = [
  "src/auth/ops.ts",
  "src/auth/index.ts",
  "src/ops/types.ts",
  "src/ops/collect.ts",
  "src/ops/index.ts",
  "src/app/api/ops/route.ts",
  "src/components/ops/OperationsCenterPanel.tsx",
];

const FORBIDDEN = ["Hülle", "hülle", "stub", "Stub", "Phase 1", "Phase-1", "Phase 3"];

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
  const src = read("docs/archive/task-plans/task-10-IMPLEMENTATION_PLAN.md");
  assert.ok(src.includes("Phase 1"));
  assert.ok(src.includes("live.gate"));
});

// ── Operations Center: kein Platzhalter mehr ─────────────────────────────────

test("Operations Center: keine Platzhalter-Terminologie im Code", () => {
  for (const file of OPS_FILES) {
    const src = read(file);
    for (const token of FORBIDDEN) {
      assert.equal(src.includes(token), false, `${file} enthält noch „${token}“`);
    }
  }
});

test("Operations Center: zehn Sektionen im Katalog und im Kollektor", () => {
  const catalog = read("src/auth/ops.ts");
  for (const id of [
    "market-universe",
    "scanner",
    "portfolio-analytics",
    "research-operations",
    "broker-operations",
    "llm-operations",
    "agent-operations",
    "risk",
    "audit",
    "help",
  ]) {
    assert.ok(catalog.includes(`id: "${id}"`), `Katalog ohne Sektion ${id}`);
  }
  const collect = read("src/ops/collect.ts");
  for (const id of OPS_SECTION_IDS) {
    // `help` ist ein gültiger Bezeichner und steht ohne Anführungszeichen.
    const quoted = /-/.test(id) ? `"${id}":` : `${id}:`;
    assert.ok(collect.includes(quoted), `Kollektortabelle ohne ${id}`);
  }
});

test("Operations Center: Panel ist erreichbar und rendert die Sektionen", () => {
  const dashboard = read("src/components/FirmDashboard.tsx");
  // Der Tab braucht einen Reiter — ohne Button ist das Cockpit nicht erreichbar.
  assert.ok(/id: "ops"/.test(dashboard), "Dashboard ohne Reiter für den Ops-Tab");
  assert.ok(dashboard.includes("onOpenTab"), "Dashboard ohne Tab-Weiterschaltung");
  const panel = read("src/components/ops/OperationsCenterPanel.tsx");
  assert.ok(panel.includes("\"/api/ops\""));
  assert.ok(panel.includes("OperationsCenterView"));
  assert.ok(panel.includes("sections"));
});

test("Operations Center: Broker-Status bleibt getrennt (Peer-Review-Kriterium)", () => {
  const collect = read("src/ops/collect.ts");
  // 1) Das Cockpit erzeugt NIE einen Live-Adapter — Health-Checks laufen in
  //    Papier-Ausführung, damit kein Order-Pfad entsteht.
  assert.ok(collect.includes('createAdapter(id, "paper")'), "Health-Check nicht im Papier-Modus");
  assert.equal(/"live"/.test(collect), false, 'Kollektor enthält das Literal "live" (Live-Adapter?)');
  // 2) Credential-/Verbindungszustand gehört in den Broker-Tab (Control Plane).
  //    Der reine In-Memory-Zustand würde nach einem Neustart „nicht verbunden“
  //    zeigen und wäre damit irreführend.
  assert.equal(
    collect.includes("readVenueControlStatePublic"),
    false,
    "Cockpit liest Control-Plane-Zustand — das gehört in den Broker-Tab"
  );
  // 3) Live-Capability ist eine Adapter-Eigenschaft, keine Freigabe.
  assert.ok(collect.includes("Live-Capability"), "Live-Capability wird nicht ausgewiesen");
  assert.ok(collect.includes("keine Freigabe"), "Live-Capability ohne Freigabe-Hinweis");
});

test("Operations Center: keine parallele Fachlogik — nur Aggregation", () => {
  const collect = read("src/ops/collect.ts");
  // Aggregation liest bestehende Fassaden; sie schreibt nichts und nutzt kein LLM.
  for (const token of ["insert(", "update(", "delete(", "placeOrder", "ollamaChat", "createBroker("]) {
    assert.equal(collect.includes(token), false, `Kollektor enthält Schreib-/Order-Pfad: ${token}`);
  }
  for (const source of [
    "@/universe",
    "@/scanner/service",
    "@/cycle/service",
    "@/brokers",
    "@/routing",
    "@/lib/riskGuard",
    "@/live-gate",
  ]) {
    assert.ok(collect.includes(source), `Kollektor nutzt ${source} nicht`);
  }
});

test("Handbuch beschreibt das Operations Center als vollständig", () => {
  const src = read("docs/HANDBUCH.md");
  assert.equal(src.includes("Phase-1-Hülle"), false);
  assert.ok(src.includes("Operations Center"));
  assert.ok(src.includes("Audit"), "Handbuch ohne Audit-Sektion des Cockpits");
});

test("Hilfe-Datei ops.help.json ist auf dem Stand der Integration", () => {
  const src = read("docs/help/ops.help.json");
  assert.equal(src.includes("Phase 1"), false);
  for (const key of ["section.marketUniverse", "section.scanner", "section.portfolio", "section.audit"]) {
    assert.ok(src.includes(key), `ops.help.json ohne ${key}`);
  }
});
