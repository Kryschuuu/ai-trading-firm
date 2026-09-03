import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/lib/engine.ts", import.meta.url), "utf8");

test("H5: non-executor pipeline phases are proposal-only", () => {
  assert.match(source, /runAgentTurn\(agent\.id, missionId, \{ proposalOnly: true \}\)/);
  assert.match(source, /if \(!maySubmit\)[\s\S]*status: "PROPOSED"/);
  assert.match(source, /agent\.role === "EXECUTOR" && !options\.proposalOnly/);
});

test("H5: executor uses only the latest approved proposal", () => {
  assert.match(source, /eq\(proposals\.status, "APPROVED"\)/);
  assert.match(source, /executeApprovedProposal\(approved\.id, executor\.id\)/);
  assert.doesNotMatch(source, /result\.status === "EXECUTED" \|\| result\.status === "KILLED"/);
});

test("H5: broker boundary retains a non-executor audit guard", () => {
  assert.match(source, /agent\.role !== "EXECUTOR"[\s\S]*ROLE_NOT_ALLOWED_TO_TRADE[\s\S]*broker\.submit\(order\)/);
});
