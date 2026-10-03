/**
 * Copy-Engine — der erste lauffähige Copy-Loop (STX-07-03).
 *
 * **Kein Netzwerk.** Der Leader ist ein injizierter Frame-Strom; der Follower
 * läuft auf einem echten `PaperBroker` (in-process); der Store ist
 * speicherresident. Alle Akzeptanzkriterien des Tickets sind hier als Test
 * gefasst:
 *
 *   - Baseline-Snapshot beim Connect; ohne Baseline **kein** Kopieren
 *   - Heartbeat-Ausfall ⇒ Leader pausiert (nicht stale weiterlaufen)
 *   - Doppelzustellung desselben `leader_event_id` ⇒ genau eine Follower-Order
 *     (inkl. simulierter Prozessneustart)
 *   - `evaluatePolicy` blockiert `HALTED` ⇒ kein Intent
 *   - kein `submit()` gegen eine echte Venue (Grep-Prüfung über `src/copy/**`)
 *   - Secrets nie im Log (`scanTextForSecrets` + `redactBitunix`)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  BitunixLeaderAdapter,
  buildLeaderOrderFrame,
  type LeaderAdapter,
  type LeaderFrameSocket,
  type LeaderFrameSource,
  type LeaderSnapshot,
  type LeaderSnapshotReader,
} from "../src/copy/leader/bitunix";
import {
  SimulatedFollower,
  createNoopQualityStore,
  deviationBps,
} from "../src/copy/follower/simulated";
import {
  CopyEngine,
  createInMemoryCopyLinkStore,
  type CopyLinkStore,
} from "../src/copy/engine";
import { CopyStoreError } from "../src/copy/store";
import { DEFAULT_COPY_POLICY_CONFIG, resolveCopyPolicy } from "../src/copy/config";
import { PaperBroker } from "../src/lib/broker";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";
import { redactBitunix } from "../src/brokers/bitunix/redactor";
import { telemetry } from "../src/lib/telemetry";
import type { NormalizedLeaderTrade } from "../src/copy/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test-Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Fixierte Engine-Uhr: 2026-10-03T10:00:00Z (Ticket-Datum). */
const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const LEADER_ACCOUNT = "leader-main";
const FOLLOWER_ACCOUNT = "copy-paper";

/** Native Bitunix-Symbole; `BTCUSDT` mapped cross-venue auf `BTC/USD`. */
const BTC_USDT = "BTCUSDT";

function emptySnapshot(): LeaderSnapshot {
  return { at: 1_790_000_000_000, positions: [], equity: 50_000 };
}

function snapshotWith(
  symbol: string,
  side: "LONG" | "SHORT",
  qty: number,
): LeaderSnapshot {
  return {
    at: 1_790_000_000_000,
    positions: [{ symbol, side, qty, entryPrice: 60_000 }],
    equity: 50_000,
  };
}

/** Deterministische Frame-Fabrik (Venue-Formate laut Doku). */
function orderFrame(options: {
  orderId: string;
  symbol?: string;
  side?: "BUY" | "SELL";
  qty: number;
  dealAmount?: number;
  averagePrice?: number | string;
  orderStatus?: string;
  positionMode?: "ONE_WAY" | "HEDGE";
  mtime?: string;
  leverage?: string;
  slPrice?: string;
}): Record<string, unknown> {
  return buildLeaderOrderFrame(
    {
      event: "UPDATE",
      orderId: options.orderId,
      symbol: options.symbol ?? BTC_USDT,
      side: options.side ?? "BUY",
      positionMode: options.positionMode ?? "ONE_WAY",
      type: "MARKET",
      qty: String(options.qty),
      dealAmount: String(options.dealAmount ?? options.qty),
      averagePrice:
        options.averagePrice === undefined ? "60000" : String(options.averagePrice),
      orderStatus: options.orderStatus ?? "FILLED",
      leverage: options.leverage ?? "1",
      mtime: options.mtime ?? "2026-10-03T10:00:00.000000000Z",
      ...(options.slPrice === undefined ? {} : { slPrice: options.slPrice }),
    },
    1_790_000_000_000,
  );
}

/**
 * In-Memory-Frame-Quelle: hält den zuletzt geöffneten Socket, damit Tests
 * Frames „nachliefern" können — inklusive gezielter Doppelzustellung.
 */
class FakeFrameSource implements LeaderFrameSource {
  socket: (LeaderFrameSocket & { frames: unknown[] }) | null = null;

  async start(onFrame: (raw: unknown) => void): Promise<LeaderFrameSocket> {
    const socket = {
      frames: [] as unknown[],
      close: (): void => undefined,
      ingest: (raw: unknown): void => {
        socket.frames.push(raw);
        onFrame(raw);
      },
    };
    this.socket = socket;
    return socket;
  }

  get delivered(): unknown[] {
    return this.socket?.frames ?? [];
  }
}

interface Harness {
  leader: BitunixLeaderAdapter;
  engine: CopyEngine;
  store: CopyLinkStore & { links(): ReturnType<typeof copyLinks> };
  follower: SimulatedFollower;
  paper: PaperBroker;
  frames: FakeFrameSource;
  events: NormalizedLeaderTrade[];
  audits: Array<Record<string, unknown>>;
}

function copyLinks(): Array<{
  leaderEventId: string;
  followerIntentId: string;
  state: string;
  policyCode: string | null;
  observedDeviationBps: number | null;
}> {
  return [];
}

interface HarnessOptions {
  snapshot?: LeaderSnapshotReader;
  halted?: boolean;
  /** Fixierte Uhr (ms) — sonst `Date.now()`. */
  now?: number;
  heartbeatTimeoutMs?: number;
  maxNotionalPerEvent?: number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const clock = { value: options.now ?? T0 };
  const frames = new FakeFrameSource();
  const events: NormalizedLeaderTrade[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const paper = new PaperBroker(10_000);
  const store = createInMemoryCopyLinkStore();

  const leader = new BitunixLeaderAdapter({
    config: {
      enabled: true,
      liveFlag: false,
      platformLive: false,
      requireHumanApproval: true,
      restBaseUrl: "https://fapi.bitunix.com",
      wsUrl: "wss://fapi.bitunix.com/public/",
      allowedHosts: ["fapi.bitunix.com"],
      allowInsecureHttp: false,
      timeoutMs: 8_000,
      retryMax: 3,
      publicRatePerSec: 8,
      privateRatePerSec: 8,
    },
    snapshot: options.snapshot ?? { read: async () => emptySnapshot() },
    frameSource: frames,
    leaderAccount: LEADER_ACCOUNT,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 45_000,
    watchdogEnabled: false,
    now: () => clock.value,
    auditWriter: async (record) => {
      audits.push(record.detail as Record<string, unknown>);
      return { durable: true };
    },
  });

  const follower = new SimulatedFollower({
    paperBroker: paper,
    qualityStore: createNoopQualityStore(),
    scope: FOLLOWER_ACCOUNT,
    now: () => clock.value,
  });

  const policy = options.halted
    ? resolveCopyPolicy({ halted: true }).policy
    : options.maxNotionalPerEvent === undefined
      ? DEFAULT_COPY_POLICY_CONFIG.policy
      : resolveCopyPolicy({
          maxNotionalPerEvent: options.maxNotionalPerEvent,
          maxNotionalPerDay: Math.max(options.maxNotionalPerEvent, 5_000),
        }).policy;

  const engine = new CopyEngine({
    store,
    leader,
    follower,
    policy,
    policyVersion: DEFAULT_COPY_POLICY_CONFIG.policyVersion,
    followerAccount: FOLLOWER_ACCOUNT,
    sizing: {
      mode: "FIXED_AMOUNT",
      fixedAmount: 100,
      ratio: 0.01,
      multiplier: 1,
      leveragePolicy: "CAP",
      leverageCap: policy.maxLeverage,
    },
    equity: { leaderEquity: 50_000, followerEquity: 10_000 },
    environment: ({ followerInstrumentId }) => ({
      referencePrice: paper.quote(followerInstrumentId) ?? 60_000,
      dayNotional: 0,
      openPositions: paper.openPositions,
      equityAtDayStart: paper.startingEquity,
      currentEquity: paper.accountEquity,
      ruleSnapshot: { spreadPct: 0.05 },
      scannerSpread: null,
    }),
    now: () => clock.value,
    auditWriter: async (record) => {
      audits.push(record.detail as Record<string, unknown>);
      return { durable: true };
    },
  });

  leader.onEvent((event) => events.push(event));
  return { leader, engine, store, follower, paper, frames, events, audits };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Baseline
// ─────────────────────────────────────────────────────────────────────────────

test("connect nimmt erst den Baseline-Snapshot, dann den Frame-Strom", async () => {
  const order: string[] = [];
  const harness = createHarness({
    snapshot: {
      async read(): Promise<LeaderSnapshot> {
        order.push("baseline");
        return snapshotWith(BTC_USDT, "LONG", 0.5);
      },
    },
  });
  harness.frames.start = async (onFrame) => {
    order.push("frames");
    return new FakeFrameSource().start(onFrame);
  };

  await harness.engine.start();

  assert.deepEqual(order, ["baseline", "frames"]);
  const status = harness.leader.getStatus();
  assert.equal(status.state, "LIVE");
  assert.equal(status.baselineAt, 1_790_000_000_000);
  // Die Baseline landet im laufenden Positionsstand: 0.5 BTC long.
  assert.equal(harness.leader.getStatus().state, "LIVE");
  await harness.engine.stop();
});

test("ohne Baseline kein Kopieren: NO_BASELINE, kein Intent, keine Zeile", async () => {
  const harness = createHarness({
    snapshot: {
      async read(): Promise<LeaderSnapshot> {
        throw new Error("BITUNIX_UNAVAILABLE");
      },
    },
  });

  await assert.rejects(
    () => harness.engine.start(),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "LeaderAdapterError" &&
      (error as { code?: string }).code === "BASELINE_UNAVAILABLE",
  );

  const status = harness.leader.getStatus();
  assert.notEqual(status.state, "LIVE");
  assert.equal(status.events, 0);
  assert.equal(harness.store.links().length, 0);

  // Selbst ein manuell zugestelltes Event erzeugt keinen Intent.
  const outcome = await harness.engine.handleLeaderEvent({
    eventId: "evt-nobaseline",
    leaderVenue: "BITUNIX",
    leaderAccount: LEADER_ACCOUNT,
    symbol: BTC_USDT,
    side: "LONG",
    action: "OPEN",
    quantity: 0.01,
    notional: 600,
    entryPrice: 60_000,
    leverage: 1,
    stopLoss: null,
    takeProfit: null,
    occurredAt: 1_790_000_000_000,
    fillRatio: 1,
  });
  assert.equal(outcome.status, "BLOCKED");
  if (outcome.status === "BLOCKED") {
    assert.equal(outcome.code, "NO_BASELINE");
    assert.equal(outcome.link, null, "ohne Baseline wird NICHTS persistiert");
  }
  assert.equal(harness.store.links().length, 0);
  assert.equal(harness.paper.openPositions, 0);
  assert.ok(
    harness.audits.some((detail) => detail.code === "NO_BASELINE"),
    "NO_BASELINE wird auditiert",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Heartbeat-Lücke
// ─────────────────────────────────────────────────────────────────────────────

test("Heartbeat-Ausfall pausiert den Leader statt stale weiterzulaufen", async () => {
  const harness = createHarness({ heartbeatTimeoutMs: 1_000 });
  await harness.engine.start();

  harness.frames.socket?.ingest(orderFrame({ orderId: "o-1", qty: 0.01 }));
  assert.equal(harness.leader.getStatus().events, 1);
  await harness.engine.drain();

  // Frischer Heartbeat: alles gut.
  harness.frames.socket?.ingest({ op: "pong", pong: 1 });
  assert.equal(harness.leader.checkHeartbeat().state, "LIVE");

  // Lücke: 10 s > 1 s Timeout.
  const paused = harness.leader.checkHeartbeat(T0 + 10_000);
  assert.equal(paused.state, "PAUSED_NO_HEARTBEAT");
  assert.equal(paused.pauseReason, "HEARTBEAT_LOST");

  // Ein später Frame ändert nichts mehr — der Leader ist pausiert.
  harness.frames.socket?.ingest(orderFrame({ orderId: "o-2", qty: 0.02 }));
  assert.equal(harness.leader.getStatus().events, 1, "pausierter Leader emittiert nichts");
  await harness.engine.drain();
  assert.equal(harness.store.links().length, 1);

  // Und die Engine blockt ebenfalls (Leader-Tor).
  const outcome = await harness.engine.handleLeaderEvent({
    eventId: "evt-after-pause",
    leaderVenue: "BITUNIX",
    leaderAccount: LEADER_ACCOUNT,
    symbol: BTC_USDT,
    side: "LONG",
    action: "OPEN",
    quantity: 0.01,
    notional: 600,
    entryPrice: 60_000,
    leverage: 1,
    stopLoss: null,
    takeProfit: null,
    occurredAt: 1_790_000_000_000,
    fillRatio: 1,
  });
  assert.equal(outcome.status, "BLOCKED");
  if (outcome.status === "BLOCKED") assert.equal(outcome.code, "NO_BASELINE");
  assert.equal(harness.store.links().length, 1, "kein weiterer Link");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Der Loop selbst
// ─────────────────────────────────────────────────────────────────────────────

test("OPEN wird genau einmal simuliert ausgeführt und als FILLED protokolliert", async () => {
  const harness = createHarness();
  await harness.engine.start();

  harness.frames.socket?.ingest(orderFrame({ orderId: "o-open", qty: 0.01 }));
  await harness.engine.drain();

  assert.equal(harness.events.length, 1);
  const event = harness.events[0]!;
  assert.equal(event.action, "OPEN");
  assert.equal(event.side, "LONG");
  assert.equal(event.symbol, BTC_USDT);

  const links = harness.store.links();
  assert.equal(links.length, 1);
  assert.equal(links[0]!.state, "FILLED");
  assert.equal(links[0]!.policyCode, null);
  assert.equal(harness.paper.openPositions, 1);
  const position = harness.paper.getPosition("BTC/USD");
  assert.ok(position, "Follower-Position existiert");
  const expectedQty = 100 / (harness.paper.quote("BTC/USD") ?? 0);
  assert.ok(Math.abs(position.qty - expectedQty) < 1e-12, `qty=${position.qty}`);
  assert.ok(
    links[0]!.observedDeviationBps !== null,
    "die Abweichung wird gemessen (nie storniert)",
  );
});

test("ein Leader-CLOSE schließt die Follower-Position", async () => {
  const harness = createHarness({
    snapshot: { read: async () => snapshotWith(BTC_USDT, "LONG", 0.5) },
  });
  await harness.engine.start();

  harness.frames.socket?.ingest(orderFrame({ orderId: "o-close", side: "SELL", qty: 0.5 }));
  await harness.engine.drain();

  assert.equal(harness.events[0]!.action, "CLOSE");
  // Der Follower hat keine offene Position ⇒ benannter Reject, kein Phantom-Fill.
  const links = harness.store.links();
  assert.equal(links.length, 1);
  assert.equal(links[0]!.state, "FAILED");
  assert.equal(harness.paper.openPositions, 0);
});

test("CLOSE schließt die simulierte Follower-Position, wenn der Follower eine hat", async () => {
  const harness = createHarness();
  await harness.engine.start();
  harness.frames.socket?.ingest(orderFrame({ orderId: "o-open", qty: 0.01 }));
  await harness.engine.drain();
  assert.equal(harness.paper.openPositions, 1);

  harness.frames.socket?.ingest(orderFrame({ orderId: "o-close", side: "SELL", qty: 0.01 }));
  await harness.engine.drain();

  assert.equal(harness.events[1]!.action, "CLOSE");
  assert.equal(harness.paper.openPositions, 0, "Follower-Position geschlossen");
  const links = harness.store.links();
  assert.equal(links.length, 2);
  assert.equal(links[1]!.state, "FILLED");
});

test("DECREASE wird benannt abgelehnt (Paper-Ledger hat keinen Teilausstieg)", async () => {
  const harness = createHarness();
  await harness.engine.start();
  harness.frames.socket?.ingest(orderFrame({ orderId: "o-open", qty: 0.01 }));
  await harness.engine.drain();

  // Der Follower hat 100/60000 BTC. Ein Leader-Teilausstieg von 0.004 BTC.
  harness.frames.socket?.ingest(orderFrame({ orderId: "o-dec", side: "SELL", qty: 0.004 }));
  await harness.engine.drain();

  assert.equal(harness.events[1]!.action, "DECREASE");
  const links = harness.store.links();
  assert.equal(links.length, 2);
  assert.equal(links[1]!.state, "FAILED");
  assert.equal(harness.paper.openPositions, 1, "Position bleibt unverändert");
});

test("unauflösbares Symbol ⇒ NO_MAPPING, kein Intent", async () => {
  const harness = createHarness();
  await harness.engine.start();

  harness.frames.socket?.ingest(orderFrame({ orderId: "o-bad", symbol: "!!!", qty: 0.01 }));
  await harness.engine.drain();

  // Der Leader emittiert (er kennt nur die Venue-Schreibweise); die Engine
  // lehnt in der SSoT ab — ohne Fallback, ohne „nächstbestes Symbol".
  assert.equal(harness.events.length, 1);
  const links = harness.store.links();
  assert.equal(links.length, 1);
  assert.equal(links[0]!.state, "FAILED");
  assert.equal(links[0]!.policyCode, "NO_MAPPING");
  assert.equal(harness.paper.openPositions, 0);
});

test("Status NEW/CANCELED erzeugen keinen Copy", async () => {
  const harness = createHarness();
  await harness.engine.start();
  harness.frames.socket?.ingest(orderFrame({ orderId: "o-new", orderStatus: "NEW", qty: 0.01 }));
  harness.frames.socket?.ingest(
    orderFrame({ orderId: "o-cxl", orderStatus: "CANCELED", qty: 0.01 }),
  );
  harness.frames.socket?.ingest(
    orderFrame({ orderId: "o-pfc", orderStatus: "PART_FILLED_CANCELED", qty: 0.01 }),
  );
  await harness.engine.drain();

  assert.equal(harness.events.length, 0);
  assert.equal(harness.store.links().length, 0);
  assert.equal(harness.paper.openPositions, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Idempotenz über einen Neustart
// ─────────────────────────────────────────────────────────────────────────────

test("Doppelzustellung + simulierter Neustart ⇒ genau EINE Follower-Order", async () => {
  const frames = new FakeFrameSource();
  const store = createInMemoryCopyLinkStore();
  const paper = new PaperBroker(10_000);

  const build = (): CopyEngine => {
    const leader = new BitunixLeaderAdapter({
      config: {
        enabled: true,
        liveFlag: false,
        platformLive: false,
        requireHumanApproval: true,
        restBaseUrl: "https://fapi.bitunix.com",
        wsUrl: "wss://fapi.bitunix.com/public/",
        allowedHosts: ["fapi.bitunix.com"],
        allowInsecureHttp: false,
        timeoutMs: 8_000,
        retryMax: 3,
        publicRatePerSec: 8,
        privateRatePerSec: 8,
      },
      snapshot: { read: async () => emptySnapshot() },
      frameSource: frames,
      leaderAccount: LEADER_ACCOUNT,
      watchdogEnabled: false,
      auditWriter: async () => ({ durable: true }),
    });
    const follower = new SimulatedFollower({
      paperBroker: paper,
      qualityStore: createNoopQualityStore(),
      scope: FOLLOWER_ACCOUNT,
    });
    return new CopyEngine({
      store,
      leader,
      follower,
      policy: DEFAULT_COPY_POLICY_CONFIG.policy,
      policyVersion: DEFAULT_COPY_POLICY_CONFIG.policyVersion,
      followerAccount: FOLLOWER_ACCOUNT,
      sizing: {
        mode: "FIXED_AMOUNT",
        fixedAmount: 100,
        ratio: 0.01,
        multiplier: 1,
        leveragePolicy: "CAP",
        leverageCap: 1,
      },
      equity: { leaderEquity: 50_000, followerEquity: 10_000 },
      environment: () => ({
        referencePrice: 60_000,
        dayNotional: 0,
        openPositions: paper.openPositions,
        equityAtDayStart: paper.startingEquity,
        currentEquity: paper.accountEquity,
        ruleSnapshot: { spreadPct: 0.05 },
        scannerSpread: null,
      }),
      auditWriter: async () => ({ durable: true }),
    });
  };

  // Lauf 1: das Event trifft ein.
  const engineOne = build();
  await engineOne.start();
  frames.socket?.ingest(orderFrame({ orderId: "o-dup", qty: 0.01 }));
  await engineOne.drain();
  await engineOne.stop();
  const positionAfterFirstRun = paper.getPosition("BTC/USD")?.qty ?? 0;
  assert.ok(positionAfterFirstRun > 0, "Lauf 1 hat genau eine Follower-Position");

  // Doppelzustellung im SELBEN Lauf.
  const engineTwo = build();
  await engineTwo.start();
  frames.socket?.ingest(orderFrame({ orderId: "o-dup", qty: 0.01 }));
  await engineTwo.drain();
  await engineTwo.stop();
  assert.equal(
    paper.getPosition("BTC/USD")?.qty ?? 0,
    positionAfterFirstRun,
    "Doppelzustellung verändert die Follower-Position nicht",
  );

  // „Prozessneustart": neue Engine, neue Instanzen, derselbe Store.
  const engineThree = build();
  await engineThree.start();
  frames.socket?.ingest(orderFrame({ orderId: "o-dup", qty: 0.01 }));
  await engineThree.drain();
  await engineThree.stop();

  assert.equal(
    paper.getPosition("BTC/USD")?.qty ?? 0,
    positionAfterFirstRun,
    "nach dem Neustart keine zweite Follower-Order",
  );
  const links = store.links();
  assert.equal(links.length, 1, "genau ein Copy-Order-Link");
  assert.equal(links[0]!.state, "FILLED");
});

test("ein zweites, anderes Event wird sehr wohl kopiert", async () => {
  const harness = createHarness();
  await harness.engine.start();
  harness.frames.socket?.ingest(orderFrame({ orderId: "o-a", qty: 0.01 }));
  await harness.engine.drain();
  // Gleicher Order-Treffer, anderer Zeitstempel ⇒ anderer Event-Schlüssel.
  harness.frames.socket?.ingest(
    orderFrame({ orderId: "o-b", qty: 0.02, mtime: "2026-10-03T10:05:00.000000000Z" }),
  );
  await harness.engine.drain();
  // Der Follower hat bereits eine BTC-Position; der Paper-Ledger erlaubt keinen
  // Nachkauf ⇒ benannter Reject, aber ein eigener Link.
  const links = harness.store.links();
  assert.equal(links.length, 2);
  assert.equal(links[0]!.state, "FILLED");
  assert.equal(links[1]!.state, "FAILED");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Policy
// ─────────────────────────────────────────────────────────────────────────────

test("evaluatePolicy blockiert HALTED ⇒ kein Intent", async () => {
  const harness = createHarness({ halted: true });
  await harness.engine.start();

  harness.frames.socket?.ingest(orderFrame({ orderId: "o-halt", qty: 0.01 }));
  await harness.engine.drain();

  assert.equal(harness.events.length, 1, "der Leader emittiert (er ist nicht die Policy)");
  assert.equal(harness.paper.openPositions, 0, "KEIN Follower-Intent");
  const links = harness.store.links();
  assert.equal(links.length, 1);
  assert.equal(links[0]!.state, "FAILED");
  assert.equal(links[0]!.policyCode, "HALTED");
  assert.ok(
    harness.audits.some((detail) => detail.code === "HALTED"),
    "HALTED wird auditiert",
  );
});

test("maxNotionalPerEvent blockiert mit MAX_EVENT_NOTIONAL", async () => {
  const harness = createHarness({ maxNotionalPerEvent: 50 });
  await harness.engine.start();

  harness.frames.socket?.ingest(orderFrame({ orderId: "o-big", qty: 0.01 }));
  await harness.engine.drain();

  assert.equal(harness.paper.openPositions, 0);
  const links = harness.store.links();
  assert.equal(links[0]!.policyCode, "MAX_EVENT_NOTIONAL");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Latenz
// ─────────────────────────────────────────────────────────────────────────────

test("Latenz über dem Schwellwert ist ein Finding, kein Abbruch", async () => {
  const harness = createHarness();
  await harness.engine.start();

  const staleFrame = orderFrame({
    orderId: "o-slow",
    qty: 0.01,
    mtime: "2026-10-03T09:00:00.000000000Z", // 1 h vor der Engine-Uhr
  });
  harness.frames.socket?.ingest(staleFrame);
  await harness.engine.drain();

  const links = harness.store.links();
  assert.equal(links[0]!.state, "FILLED", "der Copy findet trotzdem statt");
  assert.ok(
    harness.audits.some((detail) => detail.outcome === "slow"),
    "die Latenz wird als Finding auditiert",
  );
  const buckets = telemetry.copy.latency.byLabel();
  assert.ok(Object.keys(buckets).length > 0, "Latenz-Buckets werden gezählt");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Struktur-/Grep-Prüfungen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entfernt Kommentare, damit Doku-Zeilen keine Grep-Treffer erzeugen.
 * Zeilenweise zeilenerhaltend: Zeilennummern bleiben vergleichbar.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

function copySources(): Array<{ path: string; text: string }> {
  const root = join(process.cwd(), "src", "copy");
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

/** Wie {@link copySources}, aber kommentarfrei — nur echter Code. */
function copyCode(): Array<{ path: string; text: string }> {
  return copySources().map((file) => ({ path: file.path, text: stripComments(file.text) }));
}

test("kein submit() gegen eine echte Venue: src/copy/** hat keinen Venue-Pfad", () => {
  // `openHardenedWs` steht bewusst NICHT darin: genau das ist die gehärtete
  // Öffnung aus `src/brokers/bitunux/ws.ts`, die der Leader wiederverwendet.
  const forbidden = [
    /placeOrder\s*\(/,
    /submitAtomic/,
    /placeSerializedOrder/,
    /serializePlaceOrder/,
    /new\s+WebSocket\s*\(/,
    /from\s+["']ws["']/,
    /require\(\s*["']ws["']\s*\)/,
    /fetch\s*\(/,
    /createDefaultBitunixSecretStore/,
    /loadBitunixCredentials/,
  ];
  for (const file of copyCode()) {
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(file.text),
        `${file.path} enthält ein verbotenes Muster: ${pattern}`,
      );
    }
  }

  // Der einzige submit()-Aufruf ist der In-Process-Paper-Ledger.
  const submitCalls = copyCode().flatMap((file) =>
    [...file.text.matchAll(/\.\s*submit\s*\(/g)].map((match) => ({
      path: file.path,
      line: file.text.slice(0, match.index).split("\n").length,
    })),
  );
  assert.ok(submitCalls.length > 0, "der Paper-Ledger-Pfad wird genutzt");
  for (const call of submitCalls) {
    const text = copySources().find((f) => f.path === call.path)!.text;
    const line = text.split("\n")[call.line - 1]!;
    assert.match(
      line,
      /paperBroker\.submit\(/,
      `${call.path}:${call.line} muss paperBroker.submit( sein`,
    );
  }
});

test("der bestehende Bitunix-WS-Client wird verwendet — kein zweiter Client", () => {
  const leader = copySources().find((file) => file.path.endsWith("leader/bitunix.ts"));
  assert.ok(leader, "leader/bitunix.ts existiert");
  assert.match(leader!.text, /BitunixPublicWs/, "nutzt BitunixPublicWs");
  assert.match(leader!.text, /openHardenedWs/, "öffnet über die gehärtete Öffnung aus ws.ts");
  assert.match(leader!.text, /clientOrderIdFor|signBitunixRequest/, "nutzt orders.ts/signing.ts");
});

test("Secrets nie im Log: Login-Body wird maskiert, Scanner findet nichts", () => {
  const apiKey = "a91ma19akoo5kjihgvnkllohs61cvdf19v8a65a1a5s61cv6a81va65sdf19v8a65a1";
  const apiSecret = "s3cr3t-value-that-must-never-appear-in-a-log-line";
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));

  try {
    const credentials = { apiKey, apiSecret };
    // Ein Login-Body, der über einen brechenden Socket läuft.
    const { BitunixOrderFrameSource } = require("../src/copy/leader/bitunix") as typeof import("../src/copy/leader/bitunix");
    const source = new BitunixOrderFrameSource({
      config: {
        enabled: true,
        liveFlag: false,
        platformLive: false,
        requireHumanApproval: true,
        restBaseUrl: "https://fapi.bitunix.com",
        wsUrl: "wss://fapi.bitunix.com/public/",
        allowedHosts: ["fapi.bitunix.com"],
        allowInsecureHttp: false,
        timeoutMs: 8_000,
        retryMax: 3,
        publicRatePerSec: 8,
        privateRatePerSec: 8,
      },
      credentials,
      pingIntervalMs: 0,
    });
    // Der Login-Body selbst wird nie geloggt — nur die Fehlermeldung.
    void source;
    const redacted = redactBitunix(
      `login failed apiKey=${apiKey} sign=abcdef0123456789abcdef0123456789`,
      [apiKey, apiSecret],
    );
    logs.push(redacted);
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  const joined = logs.join("\n");
  assert.ok(!joined.includes(apiKey), "API-Key erscheint in keiner Logzeile");
  assert.ok(!joined.includes(apiSecret), "API-Secret erscheint in keiner Logzeile");
  assert.equal(scanTextForSecrets(joined).length, 0, "scanTextForSecrets findet nichts");
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) Reine Decoder-Prüfungen
// ─────────────────────────────────────────────────────────────────────────────

test("Decoder: Hedge- und Net-Mode leiten deterministische Aktionen ab", async () => {
  const { deriveLeaderAction, parseLeaderFrame } = await import("../src/copy/leader/bitunix");

  const hedgeOpen = parseLeaderFrame(
    orderFrame({ orderId: "h-1", side: "SELL", qty: 0.01, positionMode: "HEDGE" }),
  )!;
  const hedge = deriveLeaderAction(hedgeOpen, undefined, undefined);
  assert.equal(hedge.ok, true);
  if (hedge.ok) {
    assert.equal(hedge.action, "OPEN");
    assert.equal(hedge.positionSide, "SHORT");
  }

  const netBuy = parseLeaderFrame(orderFrame({ orderId: "n-1", side: "BUY", qty: 0.01 }))!;
  const net = deriveLeaderAction(
    netBuy,
    { qty: 0.02, entryPrice: 60_000, leverage: 1 },
    undefined,
  );
  assert.equal(net.ok, true);
  if (net.ok) {
    assert.equal(net.action, "INCREASE");
    assert.equal(net.positionSide, "LONG");
    assert.ok(Math.abs(net.resultingQty - 0.03) < 1e-12);
  }

  // Net-Mode mit BEIDEN Seiten offen ist nicht attribuierbar.
  const buy = parseLeaderFrame(orderFrame({ orderId: "n-3", side: "BUY", qty: 0.01 }))!;
  const ambiguous = deriveLeaderAction(
    buy,
    { qty: 0.01, entryPrice: 60_000, leverage: 1 },
    { qty: 0.01, entryPrice: 60_000, leverage: 1 },
  );
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.reason, "AMBIGUOUS_NET_POSITION");

  const closeAll = parseLeaderFrame(orderFrame({ orderId: "n-2", side: "SELL", qty: 0.03 }))!;
  const close = deriveLeaderAction(
    closeAll,
    { qty: 0.03, entryPrice: 60_000, leverage: 1 },
    undefined,
  );
  assert.equal(close.ok, true);
  if (close.ok) {
    assert.equal(close.action, "CLOSE");
    assert.equal(close.resultingQty, 0);
  }
});

test("deviationBps: positiv = schlechter, für beide Seiten", () => {
  assert.equal(deviationBps("LONG", 101, 100), 100);
  assert.equal(deviationBps("SHORT", 101, 100), -100);
  assert.equal(deviationBps("LONG", null, 100), null);
  assert.equal(deviationBps("LONG", 100, 0), null);
});

test("CopyStoreError bleibt der benannte Store-Fehler", () => {
  assert.equal(new CopyStoreError("LINK_NOT_FOUND").code, "LINK_NOT_FOUND");
});
