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
  // H2 (v1.36.19): submitAtomic() replaces submit() at the DB-backed call
  // sites (order_intents reservation + pg_advisory_xact_lock) — the
  // non-executor role guard still gates the broker boundary unchanged.
  assert.match(source, /agent\.role !== "EXECUTOR"[\s\S]*ROLE_NOT_ALLOWED_TO_TRADE[\s\S]*broker\.submitAtomic\(order/);
});

// H6 (CRITICAL): Approval-Chain — Executed fill must come from proposal.proposedDetail only.
test("H6: executeApprovedProposal uses proposedDetail verbatim", () => {
  assert.match(source, /broker\.submitAtomic\(\{ \.\.\.detail/);
  assert.doesNotMatch(source, /broker\.submitAtomic\(\{ \.\.\.order/); // must not rebuild order
});

test("H6: executor ignores hostile model output (BUY BTC proposal vs SELL ETH output)", () => {
  // The EXECUTOR branch returns early via executeApprovedProposal before any
  // model-output-based order construction reaches broker.submit.
  assert.match(source, /if \(agent\.role === "EXECUTOR" && !options\.proposalOnly\)/);
  assert.match(source, /executeApprovedProposal\(approved\.id, agent\.id\)/);
  // Audit links fill to proposalId
  assert.match(source, /proposalId, order: proposal\.proposedDetail, fill/);
});

test("H6: PENDING proposal is rejected fail-closed", () => {
  assert.match(source, /proposal\.status !== "APPROVED"/);
  assert.match(source, /PROPOSAL_NOT_APPROVED/);
});
