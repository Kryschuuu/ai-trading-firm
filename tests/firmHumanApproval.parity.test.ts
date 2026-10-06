/**
 * DC-02 (2026-10-06, Docs↔Code-Audit `docs/DOCS_CODE_AUDIT_2026-10-06.md`):
 * `REQUIRE_HUMAN_APPROVAL` hatte zwei Semantiken im selben Repo.
 *
 *   - Enforcement (live-gate + ALPACA + BITUNIX): `!== "false"` — Default
 *     fail-closed, nur das exakte `"false"` hebt die Freigabe auf.
 *   - Anzeige `GET /api/firm`: `=== "true"` — meldete bei ungesetzter Variable
 *     `requireHumanApproval: false`, obwohl die Gates die Freigabe verlangten.
 *
 * Der Test erzwingt EINE Semantik über alle vier Aufrufer (Parität) und hält
 * den Quell-Drift der Anzeige fest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { humanApprovalRequired as liveGate } from "../src/live-gate/config";
import { humanApprovalRequired as alpaca } from "../src/brokers/alpaca/config";
import { humanApprovalRequired as bitunix } from "../src/brokers/bitunix/config";

const CASES: Array<[string | undefined, boolean]> = [
  [undefined, true],
  ["", true],
  ["true", true],
  ["TRUE", true],
  ["yes", true],
  ["0", true],
  ["false", false],
  ["FALSE", true],
  [" false", true],
];

test("DC-02: REQUIRE_HUMAN_APPROVAL ist fail-closed und nur exakt 'false' hebt die Freigabe auf", () => {
  for (const [value, expected] of CASES) {
    const env = value === undefined ? {} : { REQUIRE_HUMAN_APPROVAL: value };
    assert.equal(liveGate(env), expected, `live-gate: ${String(value)}`);
    assert.equal(alpaca(env), expected, `alpaca: ${String(value)}`);
    assert.equal(bitunix(env), expected, `bitunix: ${String(value)}`);
  }
});

test("DC-02: die Firm-Anzeige nutzt dieselbe zentrale Funktion (keine zweite Semantik)", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/app/api/firm/route.ts"),
    "utf8",
  );
  assert.match(
    source,
    /import\s*\{\s*humanApprovalRequired\s*\}\s*from\s*["']@\/live-gate\/config["']/,
    "die Firm-Route muss die zentrale Funktion aus dem Live-Gate importieren",
  );
  assert.match(
    source,
    /requireHumanApproval:\s*humanApprovalRequired\(process\.env\)/,
    "die Anzeige muss humanApprovalRequired(process.env) verwenden",
  );
  assert.doesNotMatch(
    source,
    /process\.env\.REQUIRE_HUMAN_APPROVAL\s*===\s*["']true["']/,
    "die alte Anzeige-Semantik darf nicht zurückkommen",
  );
});
