/**
 * Idempotenz-Schlüssel des TWAP-Schedulers (RMA-P4-03).
 *
 *   etp1:<sha256>  Parent (Venue, Modus, Symbol, Seite, Ziel, Fenster, Seed, Policy)
 *   etc1:<sha256>  Kind (Parent-Key + Slice-Index) — unabhängig von der Menge
 *   ete1:<sha256>  Event
 *   etv1:<sha256>  Evaluation
 *
 * Dieselbe Eltern-Identität erzeugt denselben Parent-Key. Ein Retry von
 * `start` legt keinen zweiten Parent an. Der Kind-Key hängt nicht von der
 * (noch änderbaren) Pending-Menge ab, damit ein Replan vor dem Submit die
 * Identität nicht verdoppelt. Nach dem Submit ist die Menge eingefroren;
 * der P4.2-Workflow-Key enthält diese eingefrorene Menge.
 */
import { createHash } from "node:crypto";

function sha256(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildParentKey(parts: {
  venue: string;
  mode: string;
  symbol: string;
  side: string;
  targetQty: string;
  startAt: number;
  deadlineAt: number;
  seed: string;
  policyVersion: string;
}): string {
  return `etp1:${sha256(["twap-parent", parts.venue, parts.mode, parts.symbol, parts.side, parts.targetQty, parts.startAt, parts.deadlineAt, parts.seed, parts.policyVersion])}`;
}

/** Stabil über Replans derselben Slice-Position. Enthält keine Menge. */
export function buildChildKey(parentKey: string, sliceIndex: number): string {
  return `etc1:${sha256(["twap-child", parentKey, sliceIndex])}`;
}

/** Seed für den P4.2-Workflow. Stabil, ≤ 128 Zeichen. */
export function childWorkflowSeed(parentKey: string, sliceIndex: number): string {
  return `${parentKey}:${sliceIndex}`;
}

export function buildEventId(parentKey: string, nonce: string | number, kind: string, reason: string): string {
  return `ete1:${sha256(["twap-event", parentKey, nonce, kind, reason])}`;
}

export function buildEvalKey(parentKey: string, asOf: number, filledQty: string, status: string): string {
  return `etv1:${sha256(["twap-eval", parentKey, asOf, filledQty, status])}`;
}

/** Deterministischer Jitter in [-1, 1] aus dem persistierten Seed. Kein Math.random. */
export function unitSigned(seed: string, salt: string, index: number): number {
  const hex = createHash("sha256").update(`${seed}|${salt}|${index}`).digest("hex");
  const n = parseInt(hex.slice(0, 8), 16);
  return (n / 0xffffffff) * 2 - 1;
}
