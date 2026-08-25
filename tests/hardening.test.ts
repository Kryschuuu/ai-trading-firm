import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, publicErrorMessage } from "../src/lib/secrets";
import { envInt } from "../src/lib/env";
import {
  checkApiToken,
  checkRateLimit,
  guardWrite,
  resetRateLimiterForTests,
  tokenEquals,
} from "../src/lib/apiAuth";
import { extractJsonObject, parseDecision } from "../src/lib/engine";
import { PaperBroker } from "../src/lib/broker";
import { killSwitch, resetRuntimeLimits } from "../src/lib/riskGuard";
import { sanitizeInterval, sanitizeSymbol, isValidSymbol } from "../src/lib/marketData";
import { finvizFeed } from "../src/lib/news";

beforeEach(() => {
  resetRateLimiterForTests();
  resetRuntimeLimits();
  killSwitch.disarm();
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_RATE_LIMIT;
});

// ── Secrets ──────────────────────────────────────────────────────────────────

test("redactSecrets: Connection-Strings, Bearer, Gemini/OpenAI/Anthropic-Keys", () => {
  assert.match(
    redactSecrets("fail postgresql://trader:super-secret@127.0.0.1:5432/db boom"),
    /\[REDACTED\]/
  );
  assert.equal(redactSecrets("Authorization: Bearer sk-live-abcdef123456"), "Authorization: [REDACTED]");
  assert.match(redactSecrets("key=AIzaSyDummyKeyValueHere"), /\[REDACTED\]/);
  assert.match(redactSecrets("https://x/models?key=AIza-secret"), /\[REDACTED\]/);
  assert.equal(redactSecrets("alles sauber"), "alles sauber");
});

test("publicErrorMessage kürzt und redaktiert", () => {
  const long = publicErrorMessage(new Error("x".repeat(400)));
  assert.ok(long.length <= 241);
  assert.ok(!publicErrorMessage(new Error("postgresql://a:b@h/db")).includes("postgresql://a:b"));
});

// ── Env-Zahlen ───────────────────────────────────────────────────────────────

test("envInt: NaN/Müll → Fallback, Clamp auf [min,max]", () => {
  assert.equal(envInt("TICK_INTERVAL_MS", 60_000, 15_000, 600_000, {}), 60_000);
  assert.equal(envInt("TICK_INTERVAL_MS", 60_000, 15_000, 600_000, { TICK_INTERVAL_MS: "abc" }), 60_000);
  assert.equal(envInt("TICK_INTERVAL_MS", 60_000, 15_000, 600_000, { TICK_INTERVAL_MS: "1000" }), 15_000);
  assert.equal(envInt("ANALYST_INTERVAL_MIN", 30, 10, 1440, { ANALYST_INTERVAL_MIN: "30.9" }), 30);
});

// ── Token + Rate-Limit ───────────────────────────────────────────────────────

test("tokenEquals: gleiche Tokens ja, abweichende Länge/Inhalt nein, kein Throw", () => {
  assert.equal(tokenEquals("abc", "abc"), true);
  assert.equal(tokenEquals("abc", "abd"), false);
  assert.equal(tokenEquals("abc", "ab"), false);
  assert.equal(tokenEquals("", "secret"), false);
  assert.equal(tokenEquals("secret", ""), false);
});

test("checkApiToken: ohne Env offen, mit Env 401 bei fehlendem Header", () => {
  const req = new Request("http://127.0.0.1/api/firm/run", { method: "POST" });
  assert.equal(checkApiToken(req), null);
  process.env.FIRM_API_TOKEN = "s3cret-token";
  const denied = checkApiToken(req);
  assert.ok(denied);
  assert.equal(denied.status, 401);
  const ok = checkApiToken(
    new Request("http://127.0.0.1/api/firm/run", {
      method: "POST",
      headers: { "x-firm-token": "s3cret-token" },
    })
  );
  assert.equal(ok, null);
});

test("checkRateLimit: nach max Hits → 429, darunter durch", () => {
  const mk = () => new Request("http://127.0.0.1/api/firm/tick", { method: "POST" });
  assert.equal(checkRateLimit(mk(), { max: 3, windowMs: 60_000, now: 1000 }), null);
  assert.equal(checkRateLimit(mk(), { max: 3, windowMs: 60_000, now: 1001 }), null);
  assert.equal(checkRateLimit(mk(), { max: 3, windowMs: 60_000, now: 1002 }), null);
  const limited = checkRateLimit(mk(), { max: 3, windowMs: 60_000, now: 1003 });
  assert.ok(limited);
  assert.equal(limited.status, 429);
  // Fenster abgelaufen → wieder frei
  assert.equal(checkRateLimit(mk(), { max: 3, windowMs: 60_000, now: 70_000 }), null);
});

test("guardWrite: 0 deaktiviert Rate-Limit; Token hat Vorrang vor 429", () => {
  process.env.FIRM_API_TOKEN = "tok";
  process.env.FIRM_RATE_LIMIT = "0";
  const unauth = guardWrite(new Request("http://127.0.0.1/x", { method: "POST" }));
  assert.equal(unauth?.status, 401);
  const authed = guardWrite(
    new Request("http://127.0.0.1/x", { method: "POST", headers: { "x-firm-token": "tok" } })
  );
  assert.equal(authed, null);
});

// ── parseDecision / extractJsonObject ────────────────────────────────────────

test("extractJsonObject: Extra-Felder bleiben, gefährliche Keys nicht", () => {
  const obj = extractJsonObject(
    '{"view":"BULLISH","thesis":"ok","__proto__":{"polluted":true},"constructor":{"prototype":{}}}'
  );
  assert.ok(obj);
  assert.equal(obj.view, "BULLISH");
  assert.equal(obj.thesis, "ok");
  assert.equal(Object.prototype.hasOwnProperty.call(obj, "__proto__"), false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("parseDecision: nur Allowlist-Felder, Extra-Keys werden verworfen", () => {
  const d = parseDecision(
    '{"type":"TRADE","symbol":"BTC","side":"LONG","reason":"x","nested":{"a":1},"qty":999}'
  );
  assert.equal(d.type, "TRADE");
  assert.equal(d.symbol, "BTC");
  assert.equal((d as unknown as Record<string, unknown>).nested, undefined);
  assert.equal((d as unknown as Record<string, unknown>).qty, undefined);
});

// ── Broker-Härte ─────────────────────────────────────────────────────────────

test("Broker.reject wirft nicht bei nicht-string Symbol", () => {
  const b = new PaperBroker(10000);
  const fill = b.submit({
    symbol: 123 as unknown as string,
    side: "LONG",
    qty: 0.1,
    riskNotional: 1000,
    stopLoss: 1,
  });
  assert.equal(fill.status, "REJECTED");
  assert.match(fill.reason ?? "", /INVALID_SYMBOL/);
});

test("Broker.hydrate ignoriert Injections-Symbole", () => {
  const b = new PaperBroker(10000);
  b.hydrate(
    [
      { symbol: "BTC&x=1", side: "LONG", qty: 1, entryPrice: 100 },
      { symbol: "ETH", side: "LONG", qty: 1, entryPrice: 100 },
    ],
    { cashHint: 9000 }
  );
  assert.equal(b.openPositions, 1);
  assert.equal(b.getPosition("ETH")?.qty, 1);
  assert.equal(b.getPosition("BTC"), null);
});

// ── Marktdaten-Whitelist ─────────────────────────────────────────────────────

test("sanitizeInterval: nur bekannte Intervalle", () => {
  assert.equal(sanitizeInterval("15m"), "15m");
  assert.equal(sanitizeInterval("1h"), "1h");
  assert.equal(sanitizeInterval("1d"), "1d");
  assert.equal(sanitizeInterval("15m;curl evil"), "15m");
  assert.equal(sanitizeInterval("../etc/passwd"), "15m");
  assert.equal(sanitizeInterval(null), "15m");
});

test("finvizFeed: ungültige Symbole werden nicht zur URL", () => {
  assert.equal(finvizFeed("AAPL")?.url, "https://finviz.com/rss.ashx?t=AAPL");
  assert.equal(finvizFeed("BTC"), null);
  assert.equal(finvizFeed("AAPL&foo=bar"), null);
  assert.equal(isValidSymbol("SPY"), true);
  assert.equal(sanitizeSymbol("aapl"), "AAPL");
});
