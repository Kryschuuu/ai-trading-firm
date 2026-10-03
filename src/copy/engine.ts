/**
 * Copy-Engine (STX-07-03 · Phase 7 · Paket 07-03) — die Orchestrierung.
 *
 * Der erste lauffähige Copy-Loop:
 *
 * ```
 * Leader-Event
 *   → dedupe (leader_event_id, PERSISTENT über copy_order_links)
 *   → mapLeaderSymbol           (07-01, SSoT)
 *   → computeFollowerNotional   (07-01)
 *   → evaluatePolicy            (07-02, fail-closed)
 *   → createIntent              (07-02, UNIQUE ⇒ Idempotenz)
 *   → Follower simulieren       (SIMULATE_ONLY, PaperBroker)
 *   → markSent / markPartial / markFilled
 * ```
 *
 * ## Fail-closed, auf jeder Stufe
 *
 * Jeder Schritt kann den Lauf beenden. Ein Fehler ergibt **keinen** Intent,
 * aber immer einen Audit-Eintrag und einen Telemetrie-Zähler. Es gibt keinen
 * optimistischen Weiterlauf: `evaluatePolicy` ist fail-closed, die Symbol-Auflösung
 * hat keinen Fallback, das Sizing hat keinen stillen Moduswechsel, und der
 * Follower kennt keine echte Venue.
 *
 * ## Idempotenz über einen Neustart hinweg
 *
 * Die Dedupe ist **nicht** im Speicher: `copy_order_links` hat
 * `UNIQUE (leader_event_id, follower_intent_id)` und `UNIQUE (follower_intent_id)`.
 * Der `follower_intent_id` wird deterministisch aus dem `leader_event_id`
 * abgeleitet, deshalb erzeugt eine Doppelzustellung — auch nach einem
 * Prozessneustart — keine zweite Follower-Order. Der Test
 * (`tests/copy.engine.test.ts`) spielt exactly das nach.
 *
 * ## Latenz
 *
 * `occurredAt` des Leaders ⇒ `createdAt` des Followers wird protokolliert. Ein
 * Schwellwert ist ein **Finding** (Audit WARN + Telemetrie), kein Abbruch —
 * ein langsamer Copy ist ein Messwert, keine Sicherheitsverletzung.
 */
import type { NormalizedLeaderTrade, SizingMode, LeveragePolicy, TradeAction } from "@/copy/types";
import { mapLeaderSymbol } from "@/copy/mapping";
import { applyLeveragePolicy, computeFollowerNotional } from "@/copy/sizing";
import {
  evaluatePolicy,
  type CopyPolicy,
  type CopyPolicyContext,
  type PolicyCode,
} from "@/copy/policy";
import {
  CopyStoreError,
  type CopyAuditWriter,
  type CopyOrderLink,
  type CopyOrderLinkState,
  type CreateCopyIntentInput,
} from "@/copy/store";
import type { FollowerExecutor, FollowerSimulationResult } from "@/copy/follower/simulated";
import type { FollowerOrderIntent } from "@/copy/types";
import type { LeaderAdapter } from "@/copy/leader/bitunix";
import { writeAuditRecord, type AuditRecord } from "@/lib/auditSink";
import { metricLabel, telemetry } from "@/lib/telemetry";

// ─────────────────────────────────────────────────────────────────────────────
// Gate-Codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Engine-Gate-Codes. `PolicyCode` (07-02) deckt die Pre-Submit-Policy ab; die
 * übrigen Codes beschreiben Transport-, Validierungs-, Sizing- und
 * Follower-Fehler **vor oder neben** der Policy.
 *
 * Nur die `PolicyCode`-Werte dürfen als `copy_order_links.policy_code`
 * persistiert werden — die DB-CHECK-Constraint enumeriert genau diese Menge.
 * `NO_BASELINE` ist genau genommen ein Leader-Zustands-Gate; es schreibt
 * **keine** Zeile (siehe {@link CopyEngine.handleLeaderEvent}).
 */
export type CopyGateCode =
  | PolicyCode
  | "NO_BASELINE"
  | "INVALID_EVENT"
  | "SIZING_REJECTED"
  | "FOLLOWER_REJECTED"
  | "STORE_ERROR";

const TRADE_ACTIONS: readonly TradeAction[] = ["OPEN", "INCREASE", "DECREASE", "CLOSE"];
const SAFE_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;

// ─────────────────────────────────────────────────────────────────────────────
// Verträge
// ─────────────────────────────────────────────────────────────────────────────

/** Der minimale Store-Port, den die Engine braucht. `CopyStore` erfüllt ihn. */
export interface CopyLinkStore {
  createIntent(input: CreateCopyIntentInput): Promise<CopyOrderLink>;
  loadByFollowerIntentId(followerIntentId: string): Promise<CopyOrderLink | null>;
  markSent(followerIntentId: string): Promise<CopyOrderLink>;
  markPartial(followerIntentId: string): Promise<CopyOrderLink>;
  markFilled(
    followerIntentId: string,
    observedDeviationBps?: number | null,
  ): Promise<CopyOrderLink>;
  markFailed(
    followerIntentId: string,
    policyCode?: PolicyCode | null,
  ): Promise<CopyOrderLink>;
  markDiverged(followerIntentId: string): Promise<CopyOrderLink>;
  /**
   * Kumuliertes Follower-Notional seit Tagesbeginn (07-03). Optional: der
   * In-Memory-Store (dry-run) liefert ihn nicht, `CopyStore` liest ihn aus
   * `copy_order_links`. Fehlt er, gilt 0 — ein Tageslimit, das ein Restart
   * zurücksetzt, wäre keins; `--write` nutzt deshalb immer `CopyStore`.
   */
  dayNotional?(): Promise<number> | number;
}

/** Sizing-/Hebel-Konfiguration eines Copy-Laufs (stammt aus der Subscription). */
export interface CopySizingSettings {
  readonly mode: SizingMode;
  readonly fixedAmount: number;
  readonly ratio: number;
  readonly multiplier: number;
  readonly leveragePolicy: LeveragePolicy;
  readonly leverageCap: number | null;
}

/** Equity-Stände beider Seiten. `leaderEquity` kommt aus dem Baseline-Snapshot. */
export interface CopyEquitySettings {
  readonly leaderEquity: number | null;
  readonly followerEquity: number | null;
}

/**
 * Die Umgebung eines einzelnen Events: Referenzpreis (für `qty = notional / price`)
 * plus alle Fakten, die `evaluatePolicy` braucht. Der Engine-Aufrufer (CLI)
 * liefert sie — die Engine liest keine Venue direkt.
 */
export interface CopyEventEnvironment {
  readonly referencePrice: number | null;
  readonly dayNotional: number;
  readonly openPositions: number;
  readonly equityAtDayStart: number;
  readonly currentEquity: number;
  readonly ruleSnapshot?: { readonly spreadPct: number | null } | null;
  readonly scannerSpread?: number | null;
}

export type CopyEnvironmentProvider = (input: {
  readonly leaderEventId: string;
  readonly followerInstrumentId: string;
  readonly action: TradeAction;
}) => Promise<CopyEventEnvironment> | CopyEventEnvironment;

export interface CopyEngineOptions {
  readonly store: CopyLinkStore;
  readonly leader: LeaderAdapter;
  /** Follower-Konto (Audit-Label + Execution-Quality-Scope, kein Secret). */
  readonly followerAccount: string;
  readonly follower: FollowerExecutor;
  readonly policy: CopyPolicy;
  readonly policyVersion?: string;
  readonly sizing: CopySizingSettings;
  readonly equity: CopyEquitySettings;
  readonly environment: CopyEnvironmentProvider;
  readonly auditWriter?: CopyAuditWriter;
  readonly now?: () => number;
  /** Ab hier wird die Leader→Follower-Latenz zum Finding (Default 2 000 ms). */
  readonly latencyThresholdMs?: number;
}

export type CopyEventOutcome =
  | {
      status: "COPIED";
      readonly leaderEventId: string;
      readonly followerIntentId: string;
      readonly intent: FollowerOrderIntent;
      readonly link: CopyOrderLink;
      readonly fill: FollowerSimulationResult;
      readonly latencyMs: number;
    }
  | {
      status: "DUPLICATE";
      readonly leaderEventId: string;
      readonly followerIntentId: string;
      readonly link: CopyOrderLink;
    }
  | {
      status: "BLOCKED";
      readonly leaderEventId: string;
      readonly followerIntentId: string | null;
      readonly code: CopyGateCode;
      readonly detail: string;
      readonly link: CopyOrderLink | null;
      readonly latencyMs: number | null;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

export class CopyEngine {
  private readonly now: () => number;
  private readonly auditWriter: CopyAuditWriter;
  private readonly latencyThresholdMs: number;
  private processed = 0;
  /** Serielle Verarbeitungskette: Events werden der Reihe nach abgearbeitet. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: CopyEngineOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.auditWriter = opts.auditWriter ?? writeAuditRecord;
    this.latencyThresholdMs = opts.latencyThresholdMs ?? 2_000;
  }

  /** Anzahl verarbeiteter Leader-Events (CLI: `--max-events`). */
  get processedEvents(): number {
    return this.processed;
  }

  /** Verdrahtet die Engine mit dem Leader. Ohne Baseline keine Ereignisse. */
  async start(): Promise<void> {
    this.opts.leader.onEvent((event) => {
      // Der Leader ruft synchron; die Engine reiht das Event in eine serielle
      // Kette ein und fängt jeden Fehler selbst — ein Handler-Fehler darf den
      // Leader nicht töten. Seriell statt fire-and-forget, damit die
      // Positions-/Tages-Stände nicht zwischen zwei Events kippen.
      this.queue = this.queue
        .then(() => this.handleLeaderEvent(event))
        .then(() => undefined)
        .catch(() => undefined);
    });
    await this.opts.leader.connect();
  }

  async stop(): Promise<void> {
    await this.opts.leader.disconnect();
  }

  /** Wartet, bis alle eingereihten Leader-Events verarbeitet sind. */
  async drain(): Promise<void> {
    await this.queue;
  }

  /**
   * Verarbeitet EIN Leader-Ereignis. Nie werfend: jeder Fehlpfad endet in einem
   * `BLOCKED`-Outcome mit Audit und Telemetrie.
   */
  async handleLeaderEvent(event: NormalizedLeaderTrade): Promise<CopyEventOutcome> {
    const receivedAt = this.now();
    this.processed += 1;

    // 0) Leader-Tor: ohne aktuellen Baseline-Snapshot KEIN Copy.
    const status = this.opts.leader.getStatus?.();
    if (!status || status.state !== "LIVE" || status.baselineAt === null) {
      return this.blocked(
        event?.eventId ?? "",
        null,
        "NO_BASELINE",
        "LEADER_STATE_NOT_LIVE",
        { leaderState: metricLabel(status?.state ?? "UNKNOWN", "UNKNOWN") },
      );
    }

    // 1) Event-Validierung (fail-closed, kein Raten).
    const invalid = validateLeaderEvent(event);
    if (invalid) {
      return this.blocked(event.eventId, null, "INVALID_EVENT", invalid, {});
    }

    // 2) Persistente Dedupe: derselbe leader_event_id ⇒ kein zweiter Copy.
    const followerIntentId = followerIntentIdFor(event.eventId);
    const prior = await this.loadLink(followerIntentId);
    if (prior) {
      return {
        status: "DUPLICATE",
        leaderEventId: event.eventId,
        followerIntentId,
        link: prior,
      };
    }

    // 3) Symbol-Mapping über die SSoT (kein String-Replace, kein Fallback).
    const mapped = mapLeaderSymbol(event.leaderVenue, event.symbol);
    if (!mapped.ok) {
      return this.failLink(
        event,
        followerIntentId,
        "NO_MAPPING",
        mapped.reason,
        "NO_MAPPING",
      );
    }

    // 4) Umgebung des Events (Preis + Policy-Fakten).
    let environment: CopyEventEnvironment;
    try {
      environment = await this.opts.environment({
        leaderEventId: event.eventId,
        followerInstrumentId: mapped.instrumentId,
        action: event.action,
      });
    } catch (error) {
      return this.failLink(
        event,
        followerIntentId,
        "INVALID_EVENT",
        `ENVIRONMENT_UNAVAILABLE: ${errorMessage(error)}`,
        null,
      );
    }

    if (environment.referencePrice === null || environment.referencePrice <= 0) {
      // Ohne handelbaren Referenzpreis gibt es keine Follower-Menge.
      return this.failLink(
        event,
        followerIntentId,
        "SIZING_REJECTED",
        "NO_FOLLOWER_PRICE",
        null,
      );
    }

    // 5) Sizing (07-01) — kein stiller Moduswechsel.
    const sizing = computeFollowerNotional({
      mode: this.opts.sizing.mode,
      action: event.action,
      leaderNotional: event.notional,
      leaderEquity: this.opts.equity.leaderEquity,
      followerEquity: this.opts.equity.followerEquity,
      fixedAmount: this.opts.sizing.fixedAmount,
      ratio: this.opts.sizing.ratio,
      multiplier: this.opts.sizing.multiplier,
    });
    if (!sizing.ok) {
      return this.failLink(event, followerIntentId, "SIZING_REJECTED", sizing.reason, null);
    }

    const leverage = applyLeveragePolicy(
      this.opts.sizing.leveragePolicy,
      event.leverage,
      this.opts.sizing.leverageCap,
    );
    const effectiveLeverage = leverage.leverage ?? 1;

    const referencePrice = environment.referencePrice;
    const quantity =
      sizing.notional > 0 && referencePrice !== null && referencePrice > 0
        ? sizing.notional / referencePrice
        : 0;

    const intent: FollowerOrderIntent = {
      sourceEventId: event.eventId,
      symbol: mapped.instrumentId,
      side: event.side,
      action: event.action,
      quantity,
      notional: sizing.notional,
      sizing: {
        mode: sizing.mode,
        leaderNotional: sizing.leaderNotional,
        leaderEquity: sizing.leaderEquity,
        followerEquity: sizing.followerEquity,
        multiplier: sizing.multiplier,
        leverageApplied: leverage.leverage,
      },
      createdAt: receivedAt,
    };

    // 6) Policy (07-02) — fail-closed. `halted` blockiert immer.
    const decision = evaluatePolicy(intent, this.opts.policy, {
      followerInstrumentId: mapped.instrumentId,
      dayNotional: environment.dayNotional,
      openPositions: environment.openPositions,
      equityAtDayStart: environment.equityAtDayStart,
      currentEquity: environment.currentEquity,
      effectiveLeverage,
      ruleSnapshot: environment.ruleSnapshot,
      scannerSpread: environment.scannerSpread,
    });
    if (!decision.allowed) {
      return this.failLink(event, followerIntentId, decision.code, decision.detail, decision.code);
    }

    // 7) Idempotenter Claim: erzeugt den PENDING-Link oder erkennt die Doppelzustellung.
    const claimed = await this.claim(event, followerIntentId);
    if (claimed.status === "DUPLICATE") return claimed.outcome;
    if (claimed.status === "ERROR") {
      return this.blocked(event.eventId, followerIntentId, "STORE_ERROR", claimed.detail, {
        leaderEventId: event.eventId,
      });
    }

    // 8) Latenz-Finding (Messwert, kein Abbruch).
    const latencyMs = Math.max(0, receivedAt - event.occurredAt);
    if (latencyMs > this.latencyThresholdMs) {
      telemetry.copy.latency.inc({ bucket: latencyBucket(latencyMs, this.latencyThresholdMs) });
      await this.audit({
        event: "COPY_LEADER_LATENCY",
        level: "WARN",
        detail: {
          outcome: "slow",
          leaderEventId: event.eventId,
          latencyMs: String(latencyMs),
          thresholdMs: String(this.latencyThresholdMs),
        },
      });
    } else {
      telemetry.copy.latency.inc({ bucket: "within_threshold" });
    }

    // 9) Simulierte Ausführung (SIMULATE_ONLY — keine echte Venue).
    let fill: FollowerSimulationResult;
    try {
      fill = await this.opts.follower.simulate({
        mode: "SIMULATE_ONLY",
        followerAccount: this.opts.followerAccount,
        followerIntentId,
        intent,
        leaderTrade: event,
        now: receivedAt,
      });
    } catch (error) {
      return this.failLink(
        event,
        followerIntentId,
        "FOLLOWER_REJECTED",
        `FOLLOWER_ERROR: ${errorMessage(error)}`,
        null,
      );
    }

    if (fill.status === "REJECTED") {
      return this.failLink(event, followerIntentId, "FOLLOWER_REJECTED", fill.detail, null);
    }

    // 10) Status vorwärts schreiben: SENT → (PARTIAL) → FILLED.
    let link = await this.storeCall(() => this.opts.store.markSent(followerIntentId));
    if (link === null) {
      return this.blocked(
        event.eventId,
        followerIntentId,
        "STORE_ERROR",
        "MARK_SENT_FAILED",
        { leaderEventId: event.eventId },
      );
    }
    if (fill.status === "PARTIALLY_FILLED") {
      link = (await this.storeCall(() => this.opts.store.markPartial(followerIntentId))) ?? link;
    }
    link =
      (await this.storeCall(() =>
        this.opts.store.markFilled(followerIntentId, fill.observedDeviationBps),
      )) ?? link;

    telemetry.copy.events.inc({ result: "copied" });
    await this.audit({
      event: "COPY_ORDER_LINK",
      level: "INFO",
      detail: {
        outcome: "copied",
        leaderEventId: event.eventId,
        followerIntentId,
        action: metricLabel(event.action, "UNKNOWN"),
        instrumentId: metricLabel(mapped.instrumentId, "UNKNOWN"),
        executionQualityIntentId: fill.executionQualityIntentId,
        observedDeviationBps:
          fill.observedDeviationBps === null ? null : String(fill.observedDeviationBps),
        policyVersion: this.opts.policyVersion ?? null,
      },
    });

    return {
      status: "COPIED",
      leaderEventId: event.eventId,
      followerIntentId,
      intent,
      link,
      fill,
      latencyMs,
    };
  }

  // ── Helfer ─────────────────────────────────────────────────────────────────

  private async loadLink(followerIntentId: string): Promise<CopyOrderLink | null> {
    try {
      return await this.opts.store.loadByFollowerIntentId(followerIntentId);
    } catch (error) {
      // Ein Store-Fehler ist kein Copy: fail-closed, aber mit Finding.
      await this.audit({
        event: "COPY_ORDER_LINK",
        level: "CRITICAL",
        detail: {
          outcome: "store_error",
          followerIntentId,
          reason: errorMessage(error),
        },
      });
      throw error;
    }
  }

  /**
   * Idempotenter Claim. Zwei Leseversuche (vor und nach dem Insert) machen den
   * Pfad race-sicher: nur wer den Link im Zustand `PENDING` **selbst** erzeugt
   * hat, darf ausführen.
   */
  private async claim(
    event: NormalizedLeaderTrade,
    followerIntentId: string,
  ): Promise<
    | { status: "OK" }
    | { status: "DUPLICATE"; outcome: CopyEventOutcome }
    | { status: "ERROR"; detail: string }
  > {
    try {
      await this.opts.store.createIntent({
        leaderEventId: event.eventId,
        followerIntentId,
      });
    } catch (error) {
      const detail = error instanceof CopyStoreError ? error.code : errorMessage(error);
      return { status: "ERROR", detail };
    }
    const after = await this.opts.store.loadByFollowerIntentId(followerIntentId);
    if (!after) {
      return { status: "ERROR", detail: "LINK_MISSING_AFTER_CLAIM" };
    }
    if (after.state !== "PENDING") {
      return {
        status: "DUPLICATE",
        outcome: {
          status: "DUPLICATE",
          leaderEventId: event.eventId,
          followerIntentId,
          link: after,
        },
      };
    }
    return { status: "OK" };
  }

  private async failLink(
    event: NormalizedLeaderTrade,
    followerIntentId: string,
    code: CopyGateCode,
    detail: string,
    policyCode: PolicyCode | null,
  ): Promise<CopyEventOutcome> {
    let link: CopyOrderLink | null = null;
    try {
      const claimed = await this.claim(event, followerIntentId);
      if (claimed.status === "DUPLICATE") return claimed.outcome;
      if (claimed.status === "OK") {
        link = await this.opts.store.markFailed(followerIntentId, policyCode);
      }
    } catch {
      link = null;
    }
    telemetry.copy.events.inc({ result: "blocked" });
    await this.audit({
      event: "COPY_ORDER_LINK",
      level: code === "HALTED" ? "CRITICAL" : "WARN",
      detail: {
        outcome: "blocked",
        code: metricLabel(code, "UNKNOWN"),
        leaderEventId: event.eventId,
        followerIntentId,
        detail,
        policyVersion: this.opts.policyVersion ?? null,
      },
    });
    return {
      status: "BLOCKED",
      leaderEventId: event.eventId,
      followerIntentId,
      code,
      detail,
      link,
      latencyMs: null,
    };
  }

  private async blocked(
    leaderEventId: string,
    followerIntentId: string | null,
    code: CopyGateCode,
    detail: string,
    extra: Record<string, unknown>,
  ): Promise<CopyEventOutcome> {
    telemetry.copy.events.inc({ result: "blocked" });
    await this.audit({
      event: "COPY_ORDER_LINK",
      level: code === "NO_BASELINE" ? "CRITICAL" : "WARN",
      detail: {
        outcome: "blocked",
        code: metricLabel(code, "UNKNOWN"),
        leaderEventId,
        followerIntentId,
        detail,
        ...extra,
      },
    });
    return {
      status: "BLOCKED",
      leaderEventId,
      followerIntentId,
      code,
      detail,
      link: null,
      latencyMs: null,
    };
  }

  private async storeCall<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      await this.audit({
        event: "COPY_ORDER_LINK",
        level: "CRITICAL",
        detail: { outcome: "store_error", reason: errorMessage(error) },
      });
      return null;
    }
  }

  private async audit(record: Omit<AuditRecord, "auditClass">): Promise<void> {
    try {
      await this.auditWriter({ ...record, auditClass: "security" });
    } catch {
      /* Audit-Fehler dürfen die Engine nicht mitreißen. */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reine Helfer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministische Follower-Intent-ID. Aus dem Leader-Event abgeleitet — nicht
 * zufällig, nicht zeitbasiert. Genau das macht die Dedupe über einen Neustart
 * hinweg stabil: derselbe Leader-Event ⇒ dieselbe ID ⇒ `UNIQUE` greift.
 */
export function followerIntentIdFor(leaderEventId: string): string {
  return `copy-${leaderEventId}`;
}

function validateLeaderEvent(event: NormalizedLeaderTrade): string | null {
  if (!event || typeof event !== "object") return "EVENT_MISSING";
  if (typeof event.eventId !== "string" || !SAFE_ID.test(event.eventId.trim())) {
    return "INVALID_EVENT_ID";
  }
  if (typeof event.symbol !== "string" || event.symbol.trim().length === 0) {
    return "INVALID_SYMBOL";
  }
  if (event.side !== "LONG" && event.side !== "SHORT") return "INVALID_SIDE";
  if (!TRADE_ACTIONS.includes(event.action)) return "INVALID_ACTION";
  if (!Number.isFinite(event.quantity) || event.quantity < 0) return "INVALID_QUANTITY";
  if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt <= 0) {
    return "INVALID_OCCURRED_AT";
  }
  if (typeof event.leaderAccount !== "string" || event.leaderAccount.length > 128) {
    return "INVALID_LEADER_ACCOUNT";
  }
  return null;
}

function latencyBucket(latencyMs: number, thresholdMs: number): string {
  if (latencyMs <= thresholdMs) return "within_threshold";
  if (latencyMs <= thresholdMs * 3) return "slow";
  return "stale";
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean || "unknown";
}

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory-Store (Tests + `--dry-run`)
// ─────────────────────────────────────────────────────────────────────────────

const IN_MEMORY_TRANSITIONS: Readonly<
  Record<CopyOrderLinkState, readonly CopyOrderLinkState[]>
> = {
  PENDING: ["SENT", "FAILED", "DIVERGED"],
  SENT: ["PARTIAL", "FILLED", "FAILED", "DIVERGED"],
  PARTIAL: ["FILLED", "FAILED", "DIVERGED"],
  FILLED: [],
  FAILED: [],
  DIVERGED: [],
};

/**
 * Speicherreservierter Store für Tests und `--dry-run`.
 *
 * Er lebt **außerhalb** der Engine-Instanz: ein neuer Engine-Objekt mit
 * demselben Store simuliert einen Prozessneustart und beweist, dass die
 * Idempotenz nicht am Prozess hängt. (Die persistente Garantie liefert
 * `CopyStore` + die beiden UNIQUE-Constraints — nachgewiesen in
 * `tests/copy.engine.db.test.ts`.)
 */
export function createInMemoryCopyLinkStore(): CopyLinkStore & {
  links(): CopyOrderLink[];
} {
  const rows = new Map<string, CopyOrderLink & { sequence: number }>();
  let sequence = 0;

  const find = (followerIntentId: string): (CopyOrderLink & { sequence: number }) | null =>
    rows.get(followerIntentId) ?? null;

  return {
    links(): CopyOrderLink[] {
      return [...rows.values()].map(({ sequence: _sequence, ...link }) => link);
    },
    async createIntent(input: CreateCopyIntentInput): Promise<CopyOrderLink> {
      const existing = find(input.followerIntentId);
      if (existing) {
        if (existing.leaderEventId !== input.leaderEventId) {
          throw new CopyStoreError("LINK_IDENTITY_CONFLICT");
        }
        return existing;
      }
      sequence += 1;
      const now = new Date();
      const link: CopyOrderLink & { sequence: number } = {
        id: `mem-${sequence}`,
        leaderEventId: input.leaderEventId,
        followerIntentId: input.followerIntentId,
        executionQualityIntentId: input.executionQualityIntentId ?? null,
        state: "PENDING",
        policyCode: null,
        observedDeviationBps: null,
        followerNotional: null,
        createdAt: now,
        updatedAt: now,
        sequence,
      };
      rows.set(input.followerIntentId, link);
      return link;
    },
    async loadByFollowerIntentId(followerIntentId: string): Promise<CopyOrderLink | null> {
      return find(followerIntentId);
    },
    async markSent(followerIntentId: string): Promise<CopyOrderLink> {
      return transition(rows, followerIntentId, "SENT");
    },
    async markPartial(followerIntentId: string): Promise<CopyOrderLink> {
      return transition(rows, followerIntentId, "PARTIAL");
    },
    async markFilled(
      followerIntentId: string,
      observedDeviationBps?: number | null,
    ): Promise<CopyOrderLink> {
      return transition(rows, followerIntentId, "FILLED", {
        observedDeviationBps: observedDeviationBps ?? null,
      });
    },
    async markFailed(
      followerIntentId: string,
      policyCode: PolicyCode | null = null,
    ): Promise<CopyOrderLink> {
      return transition(rows, followerIntentId, "FAILED", { policyCode });
    },
    async markDiverged(followerIntentId: string): Promise<CopyOrderLink> {
      return transition(rows, followerIntentId, "DIVERGED");
    },
  };
}

function transition(
  rows: Map<string, CopyOrderLink & { sequence: number }>,
  followerIntentId: string,
  target: CopyOrderLinkState,
  patch: { policyCode?: PolicyCode | null; observedDeviationBps?: number | null } = {},
): CopyOrderLink {
  const current = rows.get(followerIntentId);
  if (!current) throw new CopyStoreError("LINK_NOT_FOUND");
  if (current.state === target || (target === "SENT" && current.state === "PARTIAL")) {
    return current;
  }
  if (!IN_MEMORY_TRANSITIONS[current.state].includes(target)) {
    throw new CopyStoreError("ILLEGAL_TRANSITION", `${current.state} → ${target}`);
  }
  const next: CopyOrderLink & { sequence: number } = {
    ...current,
    state: target,
    policyCode: target === "FAILED" ? (patch.policyCode ?? null) : current.policyCode,
    observedDeviationBps:
      target === "FILLED" && patch.observedDeviationBps !== undefined
        ? patch.observedDeviationBps
        : current.observedDeviationBps,
    updatedAt: new Date(),
  };
  rows.set(followerIntentId, next);
  return next;
}
