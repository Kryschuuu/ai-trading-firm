/**
 * TWAP-API (RMA-P4-03, v1.71.0).
 *
 *   GET  ?key=etp1:… | ?id=…     Status, Slices, letzte Evaluation (firm.read)
 *   POST { action: "start" }     Parent anlegen (firm.write, Flag)
 *   POST { action: "tick" }      ein Slice-Schritt (firm.write, Flag)
 *   POST { action: "cancel" }    offene Kinder canceln (firm.write, Flag)
 *   POST { action: "resume" }    Pause aufheben (firm.write, Flag)
 *   POST { action: "recover" }   offene Parents ticken (firm.write, Flag)
 *
 * Schreibende Aktionen verlangen `TWAP_EXECUTION_ENABLED=true` (fail-closed
 * 503 sonst). Antworten sind bounded und ohne Lease-Token.
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { BROKER_VENUE_IDS, EXECUTION_MODES, type BrokerVenueId, type ExecutionMode } from "@/contracts/broker";
import { TwapError } from "@/execution/twap/errors";
import { marketPredicates, twapExecutionEnabled, type TwapServiceDeps } from "@/execution/twap/service";
import type { TwapParentRecord, TwapSliceRecord } from "@/execution/twap/store";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function badRequest(error: string, hint?: string): Response {
  return NextResponse.json({ ok: false, error, ...(hint ? { hint } : {}) }, { status: 400, headers: NO_STORE });
}

function isVenue(value: unknown): value is BrokerVenueId {
  return typeof value === "string" && (BROKER_VENUE_IDS as readonly string[]).includes(value);
}

function isMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);
}

function sanitizeParent(parent: TwapParentRecord): Record<string, unknown> {
  return {
    id: parent.id,
    parentKey: parent.parentKey,
    venue: parent.venue,
    mode: parent.mode,
    symbol: parent.symbol,
    side: parent.side,
    targetQty: parent.targetQty,
    filledQty: parent.filledQty,
    unscheduledQty: parent.unscheduledQty,
    startAt: parent.startAt,
    deadlineAt: parent.deadlineAt,
    sliceIntervalMs: parent.sliceIntervalMs,
    policyVersion: parent.policyVersion,
    status: parent.status,
    reason: parent.reason,
    cursorIndex: parent.cursorIndex,
    planVersion: parent.planVersion,
    leaseOwner: parent.leaseOwner,
    leaseUntil: parent.leaseUntil,
    version: parent.version,
    limitPrice: parent.limitPrice,
    arrivalMid: parent.arrivalMid,
    hasStopLoss: parent.hasStopLoss,
    quantityStep: parent.quantityStep,
    priceStep: parent.priceStep,
    minQuantity: parent.minQuantity,
    createdAt: parent.createdAt,
    updatedAt: parent.updatedAt,
  };
}

function sanitizeSlice(slice: TwapSliceRecord): Record<string, unknown> {
  return {
    id: slice.id,
    sliceIndex: slice.sliceIndex,
    childKey: slice.childKey,
    planVersion: slice.planVersion,
    targetQty: slice.targetQty,
    filledQty: slice.filledQty,
    scheduledAt: slice.scheduledAt,
    status: slice.status,
    qtyFrozen: slice.qtyFrozen,
    workflowId: slice.workflowId,
    limitPrice: slice.limitPrice,
    skipReason: slice.skipReason,
    depthQty: slice.depthQty,
    impactBps: slice.impactBps,
    participationCap: slice.participationCap,
    submittedAt: slice.submittedAt,
    completedAt: slice.completedAt,
  };
}

async function reader() {
  const { PostgresTwapStore } = await import("@/execution/twap/store");
  const { pool } = await import("@/db");
  return new PostgresTwapStore(pool);
}

export async function GET(req: Request): Promise<Response> {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const key = params.get("key");
  const id = params.get("id");
  if (!key && !id) return badRequest("MISSING_PARENT_REF", "key=etp1:… oder id=… angeben");
  if (key && !/^etp1:[0-9a-f]{64}$/.test(key)) return badRequest("INVALID_PARENT_KEY");
  if (id && (id.length === 0 || id.length > 128)) return badRequest("INVALID_PARENT_ID");
  try {
    const store = await reader();
    const parent = key ? await store.loadParentByKey(key) : await store.loadParent(id ?? "");
    if (!parent) return NextResponse.json({ ok: false, error: "PARENT_NOT_FOUND" }, { status: 404, headers: NO_STORE });
    const [slices, events, evaluation] = await Promise.all([
      store.listSlices(parent.id),
      store.listEvents(parent.id, 200),
      store.latestEvaluation(parent.id),
    ]);
    return NextResponse.json(
      {
        ok: true,
        parent: sanitizeParent(parent),
        slices: slices.slice(0, 500).map(sanitizeSlice),
        events: events.slice(0, 200),
        evaluation,
        truncated: slices.length > 500 || events.length > 200,
      },
      { headers: NO_STORE },
    );
  } catch {
    return NextResponse.json({ ok: false, error: "TWAP_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(req: Request): Promise<Response> {
  const denied = requirePermission(req, "firm.write");
  if (denied) return denied;
  let flag = false;
  try {
    flag = twapExecutionEnabled();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_TWAP_FLAG" }, { status: 503, headers: NO_STORE });
  }
  if (!flag) {
    return NextResponse.json(
      { ok: false, error: "TWAP_EXECUTION_DISABLED", hint: "TWAP_EXECUTION_ENABLED=true schaltet die schreibenden Pfade frei" },
      { status: 503, headers: NO_STORE },
    );
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return badRequest("INVALID_BODY");
  try {
    if (body.action === "start") return startParent(body);
    if (body.action === "tick") return tickParent(body);
    if (body.action === "cancel") return cancelParent(body);
    if (body.action === "resume") return resumeParent(body);
    if (body.action === "recover") return recoverParents(body);
    return badRequest("INVALID_ACTION", "action muss start | tick | cancel | resume | recover sein");
  } catch (e) {
    if (e instanceof TwapError) {
      const status = e.code === "PARENT_NOT_FOUND" ? 404 : e.code === "POLICY_MISMATCH" || e.code.startsWith("INVALID") || e.code === "NOT_STEP_ALIGNED" ? 400 : 503;
      return NextResponse.json({ ok: false, error: e.code }, { status, headers: NO_STORE });
    }
    return NextResponse.json({ ok: false, error: "TWAP_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
  }
}

function workerOf(body: Record<string, unknown>): string {
  const worker = body.workerId;
  if (worker === undefined) return "api";
  if (typeof worker !== "string" || !/^[A-Za-z0-9_.:-]{1,40}$/.test(worker)) {
    throw new TwapError("INVALID_WORKER", "workerId ungültig");
  }
  return worker;
}

async function schedulerFor(venue: BrokerVenueId, extra: Partial<TwapServiceDeps> = {}) {
  const { createTwapScheduler } = await import("@/execution/twap/service");
  const predicates = marketPredicates(venue);
  return createTwapScheduler({ ...predicates, ...extra });
}

async function startParent(body: Record<string, unknown>): Promise<Response> {
  if (!isVenue(body.venue)) return badRequest("INVALID_VENUE");
  if (!isMode(body.mode)) return badRequest("INVALID_MODE");
  if (typeof body.symbol !== "string" || body.symbol.length === 0 || body.symbol.length > 32) return badRequest("INVALID_SYMBOL");
  if (body.side !== "LONG" && body.side !== "SHORT") return badRequest("INVALID_SIDE");
  if (typeof body.targetQty !== "number" || !(body.targetQty > 0)) return badRequest("INVALID_TARGET_QTY");
  if (typeof body.startAt !== "number" || typeof body.deadlineAt !== "number") return badRequest("INVALID_WINDOW");
  if (typeof body.seed !== "string" || body.seed.length === 0 || body.seed.length > 128) return badRequest("INVALID_SEED");
  if (typeof body.quantityStep !== "number" || typeof body.priceStep !== "number" || typeof body.minQuantity !== "number") {
    return badRequest("INVALID_INSTRUMENT");
  }
  const scheduler = await schedulerFor(body.venue);
  const parent = await scheduler.start({
    venue: body.venue,
    mode: body.mode,
    symbol: body.symbol,
    side: body.side,
    targetQty: body.targetQty,
    startAt: body.startAt,
    deadlineAt: body.deadlineAt,
    seed: body.seed,
    policy: body.policy,
    limitPrice: typeof body.limitPrice === "number" ? body.limitPrice : null,
    hasStopLoss: body.hasStopLoss === true,
    quantityStep: body.quantityStep,
    priceStep: body.priceStep,
    minQuantity: body.minQuantity,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    quoteCurrency: typeof body.quoteCurrency === "string" ? body.quoteCurrency : undefined,
  });
  return NextResponse.json({ ok: true, parent: sanitizeParent(parent) }, { headers: NO_STORE });
}

async function tickParent(body: Record<string, unknown>): Promise<Response> {
  if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 128) return badRequest("INVALID_PARENT_ID");
  const venue: BrokerVenueId = isVenue(body.venue) ? body.venue : "PAPER";
  const scheduler = await schedulerFor(venue);
  const result = await scheduler.tick(body.id, workerOf(body));
  return NextResponse.json(
    { ok: true, submitted: result.submitted, reason: result.reason, parent: sanitizeParent(result.parent) },
    { headers: NO_STORE },
  );
}

async function cancelParent(body: Record<string, unknown>): Promise<Response> {
  if (typeof body.id !== "string" || body.id.length === 0) return badRequest("INVALID_PARENT_ID");
  const venue: BrokerVenueId = isVenue(body.venue) ? body.venue : "PAPER";
  const scheduler = await schedulerFor(venue);
  const parent = await scheduler.cancel(body.id, workerOf(body));
  return NextResponse.json({ ok: true, parent: sanitizeParent(parent) }, { headers: NO_STORE });
}

async function resumeParent(body: Record<string, unknown>): Promise<Response> {
  if (typeof body.id !== "string" || body.id.length === 0) return badRequest("INVALID_PARENT_ID");
  const venue: BrokerVenueId = isVenue(body.venue) ? body.venue : "PAPER";
  const scheduler = await schedulerFor(venue);
  const parent = await scheduler.resume(body.id, workerOf(body));
  return NextResponse.json({ ok: true, parent: sanitizeParent(parent) }, { headers: NO_STORE });
}

async function recoverParents(body: Record<string, unknown>): Promise<Response> {
  const venue: BrokerVenueId = isVenue(body.venue) ? body.venue : "PAPER";
  const scheduler = await schedulerFor(venue);
  const result = await scheduler.recover(workerOf(body));
  return NextResponse.json(
    {
      ok: true,
      results: result.results.map((r) => ({ submitted: r.submitted, reason: r.reason, parent: sanitizeParent(r.parent) })),
      errors: result.errors,
    },
    { headers: NO_STORE },
  );
}
