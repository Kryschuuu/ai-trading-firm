/** TASK 07: RuleCache <-> PostgreSQL LISTEN/NOTIFY bridge tests (no DB required). */
import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { RuleCache, type RuleCacheSnapshot } from "../src/lib/microExecutor";
import { invalidateRuleCaches } from "../src/lib/ruleCacheRegistry";
import { TRADE_RULES_CHANNEL, TradeRulesNotificationListener } from "../src/lib/tradeRulesNotificationListener";

const EMPTY_SNAPSHOT: RuleCacheSnapshot = { rows: [], missionRows: [], countRows: [] };

class FakeClient extends EventEmitter {
  readonly statements: string[] = [];
  released = 0;

  constructor(private readonly failListen = false) {
    super();
  }

  async query(statement: string): Promise<{ rows: unknown[] }> {
    this.statements.push(statement);
    if (this.failListen && statement.startsWith("LISTEN")) throw new Error("simulated database outage");
    return { rows: [] };
  }

  release(_error?: Error | boolean): void {
    this.released += 1;
  }
}

class FakePool extends EventEmitter {
  connects = 0;
  constructor(readonly clients: FakeClient[]) {
    super();
  }

  async connect(): Promise<PoolClient> {
    const client = this.clients[this.connects];
    this.connects += 1;
    this.emit("connected", this.connects);
    if (!client) throw new Error("no fake client available");
    return client as unknown as PoolClient;
  }
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for listener")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

test("trade_rules NOTIFY invalidiert den gestarteten RAM-RuleCache sofort", async () => {
  const client = new FakeClient();
  const pool = new FakePool([client]);
  let loads = 0;
  const cache = new RuleCache(60_000, async () => {
    loads += 1;
    return EMPTY_SNAPSHOT;
  });
  const listener = new TradeRulesNotificationListener(pool as unknown as Pick<Pool, "connect">, invalidateRuleCaches, {
    initialRetryMs: 5,
    maxRetryMs: 10,
    log: () => undefined,
  });

  try {
    await cache.start();
    assert.equal(loads, 1);
    await listener.start();
    assert.ok(client.statements.includes(`LISTEN ${TRADE_RULES_CHANNEL}`));

    client.emit("notification", { channel: "unrelated_channel" });
    assert.equal(loads, 1, "andere NOTIFY-Kanäle dürfen den Regelcache nicht berühren");

    client.emit("notification", { channel: TRADE_RULES_CHANNEL, payload: "changed" });
    await cache.load();
    assert.equal(loads, 2, "trade_rules invalidiert und lädt sofort neu");
  } finally {
    await listener.stop();
    await cache.stop();
  }
  assert.equal(client.released, 1);
  assert.ok(client.statements.includes(`UNLISTEN ${TRADE_RULES_CHANNEL}`), "healthy pool connections must clear session-scoped LISTEN state before release");
});

test("NOTIFY während eines laufenden Loads verwirft den alten Snapshot und lädt erneut", async () => {
  const client = new FakeClient();
  const pool = new FakePool([client]);
  const listener = new TradeRulesNotificationListener(pool as unknown as Pick<Pool, "connect">, invalidateRuleCaches, {
    log: () => undefined,
  });
  let releaseFirst!: () => void;
  let loads = 0;
  const firstLoad = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const cache = new RuleCache(60_000, async () => {
    loads += 1;
    if (loads === 1) await firstLoad;
    return EMPTY_SNAPSHOT;
  });

  try {
    await listener.start();
    const starting = cache.start();
    assert.equal(loads, 1);
    client.emit("notification", { channel: TRADE_RULES_CHANNEL, payload: "changed" });
    releaseFirst();
    await starting;
    assert.equal(loads, 2, "der vor der NOTIFY gestartete DB-Snapshot wird nicht veröffentlicht");
    assert.ok(cache.status().loadedAt);
  } finally {
    releaseFirst();
    await listener.stop();
    await cache.stop();
  }
});

test("fehlerhafter RuleCache-Load bleibt fail-closed ohne Retry-Sturm und kann später heilen", async () => {
  let fail = true;
  let loads = 0;
  const cache = new RuleCache(60_000, async () => {
    loads += 1;
    if (fail) throw new Error("simulated database outage");
    return EMPTY_SNAPSHOT;
  });

  try {
    await cache.start();
    assert.equal(loads, 1);
    assert.equal(cache.status().loadedAt, null);

    cache.invalidate();
    await cache.load();
    assert.equal(loads, 2, "ein Fehler darf keine unbeschränkte rekursive Retry-Schleife starten");
    assert.equal(cache.status().loadedAt, null, "ein ungültiger Cache bleibt fail-closed");

    fail = false;
    await cache.load();
    assert.equal(loads, 3);
    assert.ok(cache.status().loadedAt, "ein nachfolgender erfolgreicher Poll/Load heilt den Cache");
  } finally {
    await cache.stop();
  }
});

test("LISTEN verbindet nach Fehler mit begrenztem Backoff erneut", async () => {
  const brokenClient = new FakeClient(true);
  const recoveredClient = new FakeClient();
  const pool = new FakePool([brokenClient, recoveredClient]);
  let notifications = 0;
  const listener = new TradeRulesNotificationListener(
    pool as unknown as Pick<Pool, "connect">,
    () => {
      notifications += 1;
    },
    { initialRetryMs: 5, maxRetryMs: 10, log: () => undefined },
  );
  const secondConnection = new Promise<void>((resolve) => {
    pool.on("connected", (attempt: number) => {
      if (attempt === 2) resolve();
    });
  });

  try {
    await listener.start();
    await waitWithTimeout(secondConnection);
    assert.equal(pool.connects, 2);
    assert.equal(brokenClient.released, 1);
    recoveredClient.emit("notification", { channel: TRADE_RULES_CHANNEL });
    assert.equal(notifications, 1);
  } finally {
    await listener.stop();
  }
  assert.equal(recoveredClient.released, 1);
});

test("LISTEN verbindet nach unerwartetem Session-Ende neu", async () => {
  const firstClient = new FakeClient();
  const recoveredClient = new FakeClient();
  const pool = new FakePool([firstClient, recoveredClient]);
  const listener = new TradeRulesNotificationListener(pool as unknown as Pick<Pool, "connect">, () => undefined, {
    initialRetryMs: 5,
    maxRetryMs: 10,
    log: () => undefined,
  });
  const secondConnection = new Promise<void>((resolve) => {
    pool.on("connected", (attempt: number) => {
      if (attempt === 2) resolve();
    });
  });

  try {
    await listener.start();
    firstClient.emit("end");
    await waitWithTimeout(secondConnection);
    assert.equal(pool.connects, 2);
    assert.equal(firstClient.released, 1);
    assert.ok(recoveredClient.statements.includes(`LISTEN ${TRADE_RULES_CHANNEL}`));
  } finally {
    await listener.stop();
  }
  assert.equal(recoveredClient.released, 1);
  assert.ok(recoveredClient.statements.includes(`UNLISTEN ${TRADE_RULES_CHANNEL}`));
});
