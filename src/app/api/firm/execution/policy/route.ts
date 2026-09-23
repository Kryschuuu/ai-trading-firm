/**
 * Execution-Policy-API (RMA-P4-02, v1.70.0).
 *
 *   GET  ?key=eow1:… | ?id=…   Workflow-Status (firm.read, immer lesbar)
 *   POST { action: "start", … } Maker-Versuch starten (firm.write, Flag-pflichtig)
 *   POST { action: "poll", id }  einen Poll-Schritt ausführen (firm.write, Flag-pflichtig)
 *   POST { action: "recover" }  Neustart-Rekonstruktion (firm.write, Flag-pflichtig)
 *
 * Schreibende Aktionen verlangen `EXECUTION_POLICY_ENABLED=true` (fail-closed
 * 503 sonst). Alle Antworten sind bounded (Events/Fills limitiert, keine
 * Roh-Payloads, keine Secrets). Fehler sind klassifizierte Codes, kein
 * Freitext-Leak.
 */
import { NextResponse } from "next/server";
import { requirePermission } from "@/auth";
import { BROKER_VENUE_IDS, EXECUTION_MODES, type BrokerVenueId, type ExecutionMode } from "@/contracts/broker";
import { ExecutionControllerError } from "@/execution/controller";
import { DEFAULT_EXECUTION_POLICY, parseExecutionPolicy } from "@/execution/policy";
import {
  buildLiveVenueDeps,
  createExecutionController,
  defaultPaperAccount,
  defaultPaperQuote,
  executionPolicyEnabled,
} from "@/execution/service";
import { PaperVenuePort } from "@/execution/ports";
import type { VenueExecutionPort } from "@/execution/ports";

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

function sanitizeWorkflow(w: Record<string, unknown>): Record<string, unknown> {
  return {
    id: w.id,
    workflowKey: w.workflowKey,
    venue: w.venue,
    mode: w.mode,
    symbol: w.symbol,
    side: w.side,
    targetQty: w.targetQty,
    filledQty: w.filledQty,
    feeQuoteTotal: w.feeQuoteTotal,
    state: w.state,
    version: w.version,
    policyVersion: w.policyVersion,
    attempt: w.attempt,
    repricesUsed: w.repricesUsed,
    cancelAttempts: w.cancelAttempts,
    activeOrderId: w.activeOrderId,
    activeClientOrderId: w.activeClientOrderId,
    fallbackOrderId: w.fallbackOrderId,
    fallbackClientOrderId: w.fallbackClientOrderId,
    limitPrice: w.limitPrice,
    submittedAt: w.submittedAt,
    ackAt: w.ackAt,
    cancelRequestedAt: w.cancelRequestedAt,
    cancelConfirmedAt: w.cancelConfirmedAt,
    errorCode: w.errorCode,
    reason: w.reason,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export async function GET(req: Request): Promise<Response> {
  const denied = requirePermission(req, "firm.read");
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const key = params.get("key");
  const id = params.get("id");
  if (!key && !id) return badRequest("MISSING_WORKFLOW_REF", "key=eow1:… oder id=… angeben");
  if (key && !/^eow1:[0-9a-f]{64}$/.test(key)) return badRequest("INVALID_WORKFLOW_KEY");
  if (id && (id.length === 0 || id.length > 128)) return badRequest("INVALID_WORKFLOW_ID");
  try {
    // Status liest direkt über den Postgres-Store (kein Trading-Seiteneffekt).
    const { PostgresExecutionStore } = await import("@/execution/store");
    const { pool } = await import("@/db");
    const reader = new PostgresExecutionStore(pool);
    const workflow = key ? await reader.loadByKey(key) : await reader.loadById(id ?? "");
    if (!workflow) {
      return NextResponse.json({ ok: false, error: "WORKFLOW_NOT_FOUND" }, { status: 404, headers: NO_STORE });
    }
    const [events, fills] = await Promise.all([reader.listEvents(workflow.id), reader.listFills(workflow.id)]);
    return NextResponse.json(
      {
        ok: true,
        workflow: sanitizeWorkflow(workflow as unknown as Record<string, unknown>),
        // Bounded: maximal 200 Events / 500 Fills (älteste zuerst).
        events: events.slice(0, 200),
        fills: fills.slice(0, 500),
        truncated: events.length > 200 || fills.length > 500,
      },
      { headers: NO_STORE }
    );
  } catch (e) {
    const code = e instanceof ExecutionControllerError ? e.code : "EXECUTION_POLICY_UNAVAILABLE";
    return NextResponse.json({ ok: false, error: code }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(req: Request): Promise<Response> {
  const denied = requirePermission(req, "firm.write");
  if (denied) return denied;
  let flag = false;
  try {
    flag = executionPolicyEnabled();
  } catch {
    return NextResponse.json({ ok: false, error: "INVALID_EXECUTION_POLICY_FLAG" }, { status: 503, headers: NO_STORE });
  }
  if (!flag) {
    return NextResponse.json(
      { ok: false, error: "EXECUTION_POLICY_DISABLED", hint: "EXECUTION_POLICY_ENABLED=true schaltet die schreibenden Pfade frei" },
      { status: 503, headers: NO_STORE }
    );
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return badRequest("INVALID_BODY");
  const action = body.action;

  try {
    if (action === "start") return startWorkflow(body);
    if (action === "poll") return pollWorkflow(body);
    if (action === "recover") return recoverWorkflows();
    return badRequest("INVALID_ACTION", "action muss start | poll | recover sein");
  } catch (e) {
    if (e instanceof ExecutionControllerError) {
      const status = e.code === "POLICY_MISMATCH" || e.code === "INVALID_INPUT" || e.code === "INSTRUMENT_UNKNOWN" ? 400 : 503;
      return NextResponse.json({ ok: false, error: e.code }, { status, headers: NO_STORE });
    }
    const { ExecutionPolicyError } = await import("@/execution/policy");
    if (e instanceof ExecutionPolicyError) {
      return NextResponse.json({ ok: false, error: e.code, field: e.field }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json({ ok: false, error: "EXECUTION_POLICY_UNAVAILABLE" }, { status: 503, headers: NO_STORE });
  }
}

async function controllerFor(venue: BrokerVenueId, mode: ExecutionMode) {
  if (venue === "PAPER") return createExecutionController();
  if (venue !== "BITUNIX" && venue !== "ALPACA") {
    throw new ExecutionControllerError("PORT_UNKNOWN", `kein Venue-Port für ${venue}`);
  }
  const live = await buildLiveVenueDeps(venue, mode);
  const extraPorts = new Map<BrokerVenueId, VenueExecutionPort>([[venue, live.port]]);
  return createExecutionController({
    extraPorts,
    getQuote: async (v, symbol) => {
      if (v === venue) return live.getQuote(symbol);
      // PAPER-Default für gemischte Dep-Maps (sollte nicht vorkommen).
      return null;
    },
    getAccount: async (v) => {
      if (v === venue) return live.getAccount();
      return null;
    },
  });
}

async function startWorkflow(body: Record<string, unknown>): Promise<Response> {
  const { venue, mode, symbol, side, targetQty, seed } = body;
  if (!isVenue(venue)) return badRequest("INVALID_VENUE");
  if (!isMode(mode)) return badRequest("INVALID_MODE");
  if (typeof symbol !== "string" || symbol.length === 0 || symbol.length > 32) return badRequest("INVALID_SYMBOL");
  if (side !== "LONG" && side !== "SHORT") return badRequest("INVALID_SIDE");
  if (typeof targetQty !== "number" || !Number.isFinite(targetQty) || targetQty <= 0) return badRequest("INVALID_TARGET_QTY");
  if (typeof seed !== "string" || seed.length === 0 || seed.length > 128) return badRequest("INVALID_SEED");
  const limitPrice = body.limitPrice;
  if (limitPrice !== undefined && (typeof limitPrice !== "number" || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
    return badRequest("INVALID_LIMIT_PRICE");
  }
  const hasStopLoss = body.hasStopLoss;
  if (hasStopLoss !== undefined && typeof hasStopLoss !== "boolean") return badRequest("INVALID_HAS_STOP_LOSS");
  // RMA-P1-05: optionale Strategieversion (enforce-Modus: Pflicht für live).
  const strategyKey = body.strategyKey;
  if (strategyKey !== undefined && strategyKey !== null && typeof strategyKey !== "string") {
    return badRequest("INVALID_STRATEGY_KEY");
  }
  const strategyVersion = body.strategyVersion;
  if (
    strategyVersion !== undefined &&
    strategyVersion !== null &&
    (typeof strategyVersion !== "number" || !Number.isInteger(strategyVersion) || strategyVersion < 1)
  ) {
    return badRequest("INVALID_STRATEGY_VERSION");
  }
  const policy = body.policy === undefined ? DEFAULT_EXECUTION_POLICY : parseExecutionPolicy(body.policy);
  const controller = await controllerFor(venue, mode);
  const workflow = await controller.start({
    venue,
    mode,
    symbol,
    side,
    targetQty,
    policy,
    seed,
    ...(typeof limitPrice === "number" ? { limitPrice } : {}),
    ...(typeof hasStopLoss === "boolean" ? { hasStopLoss } : {}),
    ...(typeof strategyKey === "string" ? { strategyKey } : {}),
    ...(typeof strategyVersion === "number" ? { strategyVersion } : {}),
  });
  return NextResponse.json({ ok: true, workflow: sanitizeWorkflow(workflow as unknown as Record<string, unknown>) }, { headers: NO_STORE });
}

async function pollWorkflow(body: Record<string, unknown>): Promise<Response> {
  const { id, venue, mode } = body;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) return badRequest("INVALID_WORKFLOW_ID");
  // Venue/Modus für die Port-Auflösung: Default PAPER/paper (reine Statusfrage
  // ohne externe Aktion, wenn der Workflow live ist und Ports fehlen → PORT_UNKNOWN).
  const v: BrokerVenueId = isVenue(venue) ? venue : "PAPER";
  const m: ExecutionMode = isMode(mode) ? mode : "paper";
  const controller = await controllerFor(v, m);
  const workflow = await controller.poll(id);
  return NextResponse.json({ ok: true, workflow: sanitizeWorkflow(workflow as unknown as Record<string, unknown>) }, { headers: NO_STORE });
}

async function recoverWorkflows(): Promise<Response> {
  // Recovery läuft Venue-übergreifend: PAPER-Ports sind immer da; Live-Ports
  // werden best-effort ergänzt (fehlende Credentials ⇒ die Live-Workflows
  // melden PORT_UNKNOWN im errors-Array, PAPER läuft trotzdem).
  const extraPorts = new Map<BrokerVenueId, VenueExecutionPort>();
  const quoteOverrides = new Map<BrokerVenueId, (symbol: string) => Promise<import("@/execution/controller").QuoteSnapshot | null>>();
  const accountOverrides = new Map<BrokerVenueId, () => Promise<import("@/execution/controller").AccountSnapshot | null>>();
  for (const venue of ["BITUNIX", "ALPACA"] as const) {
    try {
      const live = await buildLiveVenueDeps(venue, "paper");
      extraPorts.set(venue, live.port);
      quoteOverrides.set(venue, live.getQuote);
      accountOverrides.set(venue, live.getAccount);
    } catch {
      // Kein Live-Zugang — die betroffenen Workflows melden PORT_UNKNOWN.
    }
  }
  const paperPort = new PaperVenuePort({ venue: "PAPER" });
  const controller = createExecutionController({
    paperPort,
    ...(extraPorts.size > 0 ? { extraPorts } : {}),
    getQuote: async (v, symbol) => {
      const override = quoteOverrides.get(v);
      if (override) return override(symbol);
      if (v === "PAPER") return defaultPaperQuote(paperPort, symbol);
      return null;
    },
    getAccount: async (v, mode) => {
      const override = accountOverrides.get(v);
      if (override) return override();
      if (v === "PAPER" && (mode === "paper" || mode === "backtest")) return defaultPaperAccount();
      return null;
    },
  });
  const result = await controller.recover();
  return NextResponse.json(
    {
      ok: true,
      recovered: result.recovered.map((w) => sanitizeWorkflow(w as unknown as Record<string, unknown>)),
      errors: result.errors,
    },
    { headers: NO_STORE }
  );
}
