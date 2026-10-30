/** ASA-13/14/15: Registry, Polling, Deployment und Alert-Senken. */
import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

import { factoryAuditRing } from "../src/brokers/audit";
import { checkCredentialRateLimit } from "../src/brokers/control-plane/guard";
import { getPool } from "../src/db";
import { AlertDispatcher, FileAlertSink, WebhookAlertSink, getAlertDispatcher, setAlertDispatcherForTests, type Alert } from "../src/lib/alerts";
import { consumeDisarmNonce, issueDisarmNonce } from "../src/lib/disarmChallenge";
import { consumeKillNonce, issueKillNonce } from "../src/lib/killSwitchNonce";
import { getQuoteSync, setQuoteCacheForTests } from "../src/lib/marketData";
import { HistoricalStore } from "../src/lib/marketdata/historicalStore";
import { getOrCreateRegisteredState, resetAllRegisteredState, state } from "../src/lib/stateRegistry";
import { compileTemplate } from "../src/strategies/compiler";
import { getLiveGateRuntime } from "../src/live-gate/runtime";
import { setModelRouterForTests, type ModelRouter } from "../src/routing/router";
import { startFirmPolling, type FirmPollingEnvironment } from "../src/components/firm/useFirmPolling";

const root = process.cwd();
const sampleAlert: Alert = { code: "test:alert", severity: "warning", message: "Ausfall" };
const publicLookup = async () => [{ address: "1.1.1.1", family: 4 }];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

/** Nur Leszugriffe auf die echten Plattform-APIs, keine beliebigen Aliase. */
function forbiddenGlobalUses(source: string, filename: string): string[] {
  const sf = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true,
    filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const errors: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "globalThis") {
      const parent = node.parent;
      const safeProperty = ts.isPropertyAccessExpression(parent) && parent.expression === node &&
        ["fetch", "WebSocket"].includes(parent.name.text);
      const use = parent.parent;
      const mutation = ts.isBinaryExpression(use) && use.left === parent &&
        use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && use.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
      if (!safeProperty || mutation || ts.isDeleteExpression(use) || ts.isPrefixUnaryExpression(use) || ts.isPostfixUnaryExpression(use)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        errors.push(`${filename}:${line}`);
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(sf);
  return errors;
}

test("ASA-13: keine nicht registrierten globalThis-Felder oder globale Aliase in src", () => {
  // PostgreSQL-Pool und Drizzle-Fassade sind langlebige Infrastruktur. Tests
  // injizieren sie über diese beiden alten Felder; App-State-Resets dürfen den
  // Pool weder schließen noch austauschen. Keine weitere Ausnahme ist erlaubt.
  const infraFile = "src/db/index.ts";
  const expectedInfraFields = new Set(["__arenaNextJsPostgresqlPool", "__arenaNextJsPostgresqlDb"]);
  const errors: string[] = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "src/lib/stateRegistry.ts") continue;
    const source = readFileSync(file, "utf8");
    if (rel === infraFile) {
      const fields = new Set(source.match(/__[A-Za-z0-9_]+/g) ?? []);
      assert.deepEqual(fields, expectedInfraFields, "DB-Allowlist darf keine weiteren globalen Felder enthalten");
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      let declarations = 0;
      const inspect = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === "globalThis" && !ts.isTypeQueryNode(node.parent)) {
          const declaration = node.parent.parent;
          assert.ok(ts.isVariableDeclaration(declaration) && declaration.name.getText(sf) === "globalForDb");
          declarations++;
        }
        if (ts.isIdentifier(node) && node.text === "globalForDb" && !ts.isVariableDeclaration(node.parent)) {
          assert.ok(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node &&
            expectedInfraFields.has(node.parent.name.text), "DB-Ausnahme nur für die beiden Pool-Felder");
        }
        ts.forEachChild(node, inspect);
      };
      inspect(sf);
      assert.equal(declarations, 1);
      continue;
    }
    errors.push(...forbiddenGlobalUses(source, rel));
  }
  assert.deepEqual(errors, []);
  for (const code of [
    "globalThis.__newSingleton = {};",
    "globalThis['__newSingleton'] = {};",
    "const alias = globalThis; alias.__newSingleton = {};",
    "const alias = globalThis as typeof globalThis & { __newSingleton?: object };",
    "globalThis.fetch = fake;",
  ]) assert.notEqual(forbiddenGlobalUses(code, "example.ts").length, 0, `Wächter übersieht ${code}`);
});

test("ASA-13: ein Reset erfasst Nonces, Rate-Limits, Caches, Live-Gate und Alert-Dispatcher, nicht den PG-Pool", async () => {
  const oldDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
  const dir = await mkdtemp(path.join(tmpdir(), "asa13-gate-"));
  try {
    resetAllRegisteredState();
    const pool = getPool();
    const ring = factoryAuditRing;
    ring.push({ venue: "PAPER", mode: "paper", outcome: "OK", at: "test" } as never);
    setQuoteCacheForTests("ASA13-TEST", 321);
    assert.equal(getQuoteSync("ASA13-TEST"), 321);
    const disarm = issueDisarmNonce().nonce;
    const kill = issueKillNonce().nonce;
    state.rateLimiterHits.get().set("test", [1]);
    state.revokedSessions.get().set("test-session", Date.now() + 60_000);
    const request = new Request("https://example.test");
    assert.equal(checkCredentialRateLimit(request, { max: 1, now: 100 }), null);
    assert.equal(checkCredentialRateLimit(request, { max: 1, now: 100 })?.status, 429);
    const runtime = getLiveGateRuntime({ LIVE_GATE_DATA_DIR: dir });
    runtime.killedMemory.add("*");
    const injected = new AlertDispatcher([]);
    setAlertDispatcherForTests(injected);
    assert.equal(getAlertDispatcher(), injected);
    let stopped = 0;
    setModelRouterForTests({ stopHealthPoller: () => { stopped++; } } as unknown as ModelRouter);

    resetAllRegisteredState();

    assert.equal(getPool(), pool, "langlebiger PostgreSQL-Pool bleibt bestehen");
    assert.equal(factoryAuditRing, ring, "exportierte Ring-Referenzen bleiben stabil");
    assert.equal(ring.length, 0);
    assert.equal(getQuoteSync("ASA13-TEST"), null);
    assert.equal(consumeDisarmNonce(disarm), "missing");
    assert.equal(consumeKillNonce(kill), "missing");
    assert.equal(state.rateLimiterHits.get().size, 0);
    assert.equal(state.revokedSessions.get().size, 0);
    assert.equal(checkCredentialRateLimit(request, { max: 1, now: 100 }), null);
    assert.notEqual(getLiveGateRuntime({ LIVE_GATE_DATA_DIR: dir }), runtime);
    assert.notEqual(getAlertDispatcher(), injected);
    assert.equal(stopped, 1, "Router-Poller wird beim Reset beendet");
    resetAllRegisteredState();
  } finally {
    if (oldDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDbUrl;
    await rm(dir, { recursive: true, force: true });
  }
});

test("ASA-13: registrierte Records behalten Map-/Array-Referenzen, infra bleibt unverändert", () => {
  let cleaned = 0;
  const data = getOrCreateRegisteredState("tests/asa13/app", () => ({
    entries: new Map<string, number>(), ring: [] as string[], count: 0,
  }), () => { cleaned++; });
  const infra = getOrCreateRegisteredState("tests/asa13/infra", () => ({ value: 1 }), undefined, "infra");
  const map = data.entries;
  const ring = data.ring;
  map.set("a", 1); ring.push("a"); data.count = 10; infra.value = 9;
  assert.equal(getOrCreateRegisteredState("tests/asa13/app", () => ({ entries: new Map<string, number>(), ring: [] as string[], count: 0 }), () => { cleaned++; }), data);
  resetAllRegisteredState();
  assert.equal(data.entries, map);
  assert.equal(data.ring, ring);
  assert.equal(map.size, 0);
  assert.deepEqual(ring, []);
  assert.equal(data.count, 0);
  assert.equal(cleaned, 1);
  assert.equal(infra.value, 9);
  assert.throws(() => getOrCreateRegisteredState("tests/asa13/infra", () => ({})), /scope mismatch/);
});

test("ASA-13: Strategie-Cache und historische Warnungs-Deduplizierung werden zurückgesetzt", async () => {
  const compiler = getOrCreateRegisteredState<{ documentaryFieldsCache: ReadonlySet<string> | null }>(
    "src/strategies/compiler.ts", () => ({ documentaryFieldsCache: null }),
  );
  const currentCache = () => compiler.documentaryFieldsCache;
  const dir = await mkdtemp(path.join(tmpdir(), "asa13-history-"));
  const originalWarn = console.warn;
  const warnings: string[] = [];
  try {
    resetAllRegisteredState();
    assert.equal(currentCache(), null);
    assert.equal(compileTemplate({ templateId: "ema-adx-trend", symbol: "BTC/USDT", timeframe: "1h" }).ok, true);
    assert.ok(currentCache() instanceof Set);

    const store = new HistoricalStore(dir);
    const warnOnce = () => (store as unknown as { warnLegacyOnce(): void }).warnLegacyOnce();
    console.warn = (message) => { warnings.push(String(message)); };
    warnOnce();
    warnOnce();
    assert.equal(warnings.filter((message) => message.includes("Legacy-Schema")).length, 1);

    resetAllRegisteredState();
    assert.equal(currentCache(), null);
    warnOnce();
    assert.equal(warnings.filter((message) => message.includes("Legacy-Schema")).length, 2);
  } finally {
    console.warn = originalWarn;
    resetAllRegisteredState();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ASA-13: Polling ist stabil, pausiert versteckt und lädt beim Sichtbarwerden sofort", () => {
  let visible = true;
  let listener: (() => void) | undefined;
  const triggerVisibility = () => listener?.();
  let sequence = 0;
  let loads = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const env: FirmPollingEnvironment = {
    isVisible: () => visible,
    onVisibilityChange: (fn) => { listener = fn; return () => { listener = undefined; }; },
    setInterval: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearInterval: (id) => { timers.delete(id); },
  };
  const load = async () => { loads++; };
  let cleanup = startFirmPolling(load, false, env);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 15_000);
  [...timers.values()][0].callback();
  [...timers.values()][0].callback();
  assert.equal(loads, 2);
  assert.equal(sequence, 1, "neue Snapshot-Objekte starten keinen neuen Timer");
  visible = false; triggerVisibility();
  assert.equal(timers.size, 0);
  visible = true; triggerVisibility();
  assert.equal(loads, 3, "Rückkehr lädt sofort");
  assert.equal(timers.size, 1);
  cleanup();
  assert.equal(timers.size, 0);
  assert.equal(listener, undefined);
  visible = false;
  cleanup = startFirmPolling(load, true, env);
  assert.equal(timers.size, 0, "versteckt gestarteter Tab pollt nicht");
  visible = true; triggerVisibility();
  assert.equal(loads, 4);
  assert.equal([...timers.values()][0].delay, 8_000);
  cleanup();
  const dashboard = readFileSync(path.join(root, "src/components/FirmDashboard.tsx"), "utf8");
  const hook = readFileSync(path.join(root, "src/components/firm/useFirmPolling.ts"), "utf8");
  assert.match(dashboard, /useMemo\(\(\) => data\.missions\.some\([\s\S]*?\[data\.missions\]\)/);
  assert.match(hook, /\[load, hasActiveMission\]/);
  assert.doesNotMatch(hook, /\[load, data\.missions\]/);
});

test("ASA-14: beide Units haben dieselbe Identität, Pfade und systemd-Sandbox", () => {
  const main = readFileSync(path.join(root, "deploy/ai-trading-firm.service"), "utf8");
  const micro = readFileSync(path.join(root, "deploy/micro-executor.service"), "utf8");
  for (const source of [main, micro]) {
    for (const directive of [
      "User=atf", "Group=atf", "WorkingDirectory=/opt/ai-trading-firm",
      "EnvironmentFile=/opt/ai-trading-firm/.env", "NoNewPrivileges=true",
      "PrivateTmp=true", "ProtectSystem=strict", "ProtectHome=true",
      "RestrictSUIDSGID=true", "LockPersonality=true",
      "ReadWritePaths=/opt/ai-trading-firm/data /opt/ai-trading-firm/.runtime",
    ]) assert.ok(source.split("\n").includes(directive), `fehlende Unit-Direktive: ${directive}`);
    assert.doesNotMatch(source, /\/path\/to\/|RuntimeMaxSec=0|DEIN_USER|User=trader/);
  }
});

test("ASA-15: FileAlertSink schreibt parallele Alerts asynchron, geordnet und mit 0600", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "asa15-file-"));
  try {
    const file = path.join(dir, "new", "alerts.ndjson");
    const sink = new FileAlertSink(file);
    const writes = Array.from({ length: 30 }, (_, i) => sink.send({
      code: `alert:${i}`, severity: "warning", message: "Token sk-live-SECRET-MARKER", meta: { index: i },
    }));
    assert.ok(writes.every((write) => write instanceof Promise));
    await Promise.all(writes);
    const text = await readFile(file, "utf8");
    const rows = text.trim().split("\n").map((line) => JSON.parse(line) as { code: string; index: number });
    assert.deepEqual(rows.map((row) => row.index), Array.from({ length: 30 }, (_, i) => i));
    assert.equal(rows[29].code, "alert:29");
    assert.doesNotMatch(text, /SECRET-MARKER/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const source = readFileSync(path.join(root, "src/lib/alerts.ts"), "utf8");
    assert.doesNotMatch(source, /\b(?:appendFileSync|mkdirSync|chmodSync)\b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ASA-15: Webhook verweigert HTTP, lokale, private und kodierte IP-Ziele ohne Netzwerk", async () => {
  const blocked = [
    "http://example.com/hook", "https://localhost/hook", "https://foo.local/hook",
    "https://127.0.0.1/hook", "https://127.99.2.3/hook", "https://2130706433/hook",
    "https://169.254.169.254/hook", "https://10.2.3.4", "https://172.16.0.1",
    "https://192.168.0.1", "https://0.2.3.4", "https://[::1]/hook",
    "https://[fc00::1]/hook", "https://[fe80::1]/hook", "https://[::ffff:127.0.0.1]/hook",
    "https://user:pass@example.com/secret",
  ];
  for (const url of blocked) {
    let called = false;
    const sink = new WebhookAlertSink({ resolveUrl: async () => url, lookupFn: publicLookup,
      fetchFn: (async () => { called = true; return new Response(); }) as typeof fetch });
    await assert.rejects(sink.send(sampleAlert), /webhook:/, url);
    assert.equal(called, false, `blockiertes Ziel wurde kontaktiert: ${url}`);
  }
  for (const url of ["http://example.com", "http://192.168.0.1", "https://10.0.0.1"]) {
    const sink = new WebhookAlertSink({ resolveUrl: async () => url, allowInsecureLocal: true, lookupFn: publicLookup });
    await assert.rejects(sink.send(sampleAlert), /webhook:/, "Test-Flag ist keine Freigabe privater Netze");
  }
});

test("ASA-15: alle DNS-Antworten werden geprüft, öffentliche HTTPS-Ziele sind erlaubt", async () => {
  let calls = 0;
  let seenInit: RequestInit | undefined;
  const sink = new WebhookAlertSink({
    resolveUrl: async () => "https://hooks.example.test/secret-token",
    lookupFn: async (host, opts) => {
      assert.equal(host, "hooks.example.test");
      assert.deepEqual(opts, { all: true });
      calls++;
      return calls === 1
        ? [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]
        : [{ address: "1.1.1.1", family: 4 }, { address: "169.254.169.254", family: 4 }];
    },
    fetchFn: (async (_url, init) => { seenInit = init; return new Response("ok"); }) as typeof fetch,
  });
  await sink.send(sampleAlert);
  assert.equal(seenInit?.redirect, "error");
  assert.ok((seenInit as RequestInit & { dispatcher?: unknown }).dispatcher, "verifizierter DNS-Connector fehlt");
  seenInit = undefined;
  await assert.rejects(sink.send(sampleAlert), (error: Error) => !error.message.includes("secret-token"));
  assert.equal(seenInit, undefined, "gemischte DNS-Antwort darf nicht versendet werden");
  assert.equal(calls, 2, "jede Sendung löst erneut auf");
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("ASA-15: Loopback nur explizit, Connector pinnt DNS und folgt keinem Redirect", async () => {
  let internalCalls = 0;
  let validCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/internal" });
      res.end();
    } else if (req.url === "/internal") {
      internalCalls++;
      res.end("internal");
    } else {
      validCalls++;
      res.end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const base = `http://localhost:${addr.port}`;
  const originalLookup = dns.lookup;
  let uncheckedLookups = 0;
  try {
    // Eine zweite Systemauflösung würde das Ziel ändern (simuliertes Rebinding).
    dns.lookup = ((..._args: unknown[]) => { uncheckedLookups++; throw new Error("unchecked DNS lookup"); }) as unknown as typeof dns.lookup;
    const lookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
    const denied = new WebhookAlertSink({ resolveUrl: async () => `${base}/ok`, lookupFn });
    await assert.rejects(denied.send(sampleAlert), /webhook:/);
    const allowed = new WebhookAlertSink({ resolveUrl: async () => `${base}/ok`, lookupFn, allowInsecureLocal: true });
    await allowed.send(sampleAlert);
    assert.equal(validCalls, 1);
    const redirect = new WebhookAlertSink({ resolveUrl: async () => `${base}/redirect`, lookupFn, allowInsecureLocal: true });
    await assert.rejects(redirect.send(sampleAlert), /webhook:/);
    assert.equal(internalCalls, 0, "Redirect-Ziel wurde nicht kontaktiert");
    assert.equal(uncheckedLookups, 0, "Verbindung darf keine zweite DNS-Auflösung nutzen");
  } finally {
    dns.lookup = originalLookup;
    await closeServer(server);
  }
});

test("ASA-15: DNS-Fehler und Timeouts geben keine Webhook-Secrets preis", async () => {
  const sink = new WebhookAlertSink({
    resolveUrl: async () => "https://secret.example.test/private-token",
    lookupFn: async () => { throw new Error("private-token"); },
  });
  await assert.rejects(sink.send(sampleAlert), (error: Error) =>
    /DNS/.test(error.message) && !error.message.includes("private-token") && !error.message.includes("secret.example"));
  const hanging = new WebhookAlertSink({
    resolveUrl: async () => "https://example.test/private-token",
    lookupFn: () => new Promise(() => {}), timeoutMs: 20,
  });
  await assert.rejects(hanging.send(sampleAlert), /Zeitlimit/);
});
