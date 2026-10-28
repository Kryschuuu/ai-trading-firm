/** ASA-08: Fetch requests must prove proxy origin, not merely claim an IP. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { resolveClientIp, peerIpFromRequest, describeClientIpPolicy } from "../src/lib/clientIp";
import { checkRateLimit } from "../src/lib/apiAuth";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";
import { POST as login } from "../src/app/api/auth/login/route";

const secret = randomBytes(32).toString("hex");
const trust = { TRUSTED_PROXY_IPS: "10.0.0.0/8" };
const authenticated = { ...trust, TRUSTED_PROXY_SECRET: secret };
const keys = ["TRUSTED_PROXY_IPS", "TRUSTED_PROXY_SECRET", "FIRM_RATE_LIMIT",
  "FIRM_API_TOKEN", "FIRM_ADMIN_TOKEN", "FIRM_VIEWER_TOKEN", "AUTH_MODE"];
const saved = new Map(keys.map((key) => [key, process.env[key]]));

function request(ip = "198.51.100.42", proxySecret?: string): Request {
  return new Request("https://example.test/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-verified-ip": ip,
      "x-forwarded-for": `${ip}, 10.0.0.1`,
      "x-real-ip": ip,
      ...(proxySecret === undefined ? {} : { "x-proxy-secret": proxySecret }),
    },
    body: JSON.stringify({ token: "dummy" }),
  });
}

beforeEach(() => {
  __resetAllSingletonsForTests();
  for (const key of keys) delete process.env[key];
});
afterEach(() => {
  __resetAllSingletonsForTests();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("ASA-08: CIDRs alone never authenticate a Fetch Request (including loopback/HOSTNAME)", () => {
  assert.equal(peerIpFromRequest(request()), null);
  for (const cidrs of ["10.0.0.0/8", "127.0.0.1/32", "loopback", "::1/128"]) {
    const result = resolveClientIp(request(), {
      env: { TRUSTED_PROXY_IPS: cidrs, HOSTNAME: "127.0.0.1" },
    });
    assert.equal(result.key, "local");
    assert.equal(result.source, "local-fallback");
    assert.equal(result.peerTrusted, null);
    assert.deepEqual(result.ignoredHeaders, ["x-verified-ip", "x-forwarded-for", "x-real-ip"]);
  }
});

test("ASA-08: only the correct proxy secret accepts a verified IP; XFF remains socket-only", () => {
  const result = resolveClientIp(request(undefined, secret), { env: authenticated });
  assert.equal(result.key, "198.51.100.42");
  assert.equal(result.source, "verified-header");
  assert.equal(result.peerTrusted, null, "secret proof does not invent a socket peer");
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!describeClientIpPolicy(authenticated).includes(secret));
  for (const supplied of [undefined, "", "dummy", secret.slice(1), secret + "0",
    secret.slice(0, -1) + (secret.endsWith("0") ? "1" : "0"), `${secret}, ${secret}`]) {
    assert.equal(resolveClientIp(request(undefined, supplied), { env: authenticated }).key, "local");
  }
  const duplicated = request(undefined, secret);
  duplicated.headers.append("x-proxy-secret", secret);
  assert.equal(resolveClientIp(duplicated, { env: authenticated }).key, "local");
  const xffOnly = request(undefined, secret);
  xffOnly.headers.delete("x-verified-ip");
  assert.equal(resolveClientIp(xffOnly, { env: authenticated }).key, "local");
  for (const ip of ["garbage", "198.51.100.42, 203.0.113.1"]) {
    assert.equal(resolveClientIp(request(ip, secret), { env: authenticated }).key, "local");
  }
});

test("ASA-08: empty/invalid secrets and missing/invalid CIDRs fail closed even without boot guard", () => {
  for (const invalid of ["", " ".repeat(32), "dummy", "x".repeat(257), "x".repeat(31) + ","]) {
    assert.equal(resolveClientIp(request(undefined, invalid), {
      env: { ...trust, TRUSTED_PROXY_SECRET: invalid },
    }).key, "local");
  }
  for (const cidrs of ["", "garbage"]) {
    const env = { TRUSTED_PROXY_IPS: cidrs, TRUSTED_PROXY_SECRET: secret };
    assert.equal(resolveClientIp(request(undefined, secret), { env }).key, "local");
  }
  assert.equal(resolveClientIp(request(), {
    env: { TRUSTED_PROXY_IPS: "garbage" }, peerIp: "127.0.0.1",
  }).key, "127.0.0.1", "invalid configured CIDRs must not enable implicit loopback trust");
});

test("ASA-08: real socket CIDR check wins over even a correct secret", () => {
  for (const peer of ["203.0.113.7", "127.0.0.1", "::ffff:203.0.113.7"]) {
    const req = Object.assign(request(undefined, secret), { socket: { remoteAddress: peer } });
    const result = resolveClientIp(req, { env: authenticated });
    assert.equal(result.key, peer === "127.0.0.1" ? peer : "203.0.113.7");
    assert.equal(result.peerTrusted, false);
    assert.equal(result.source, "peer");
  }
  const trusted = Object.assign(request(), { socket: { remoteAddress: "10.0.0.7" } });
  assert.equal(resolveClientIp(trusted, { env: trust }).key, "198.51.100.42");
  trusted.headers.delete("x-verified-ip");
  assert.equal(resolveClientIp(trusted, { env: trust }).source, "trusted-forwarded-for");
  assert.equal(resolveClientIp(trusted, { env: trust }).key, "198.51.100.42");
});

test("ASA-08: rotating verified/XFF/real-IP headers cannot bypass the actual API limiter", () => {
  for (const configured of [false, true]) {
    __resetAllSingletonsForTests();
    Object.assign(process.env, trust);
    if (configured) process.env.TRUSTED_PROXY_SECRET = secret;
    const opts = { max: 2, windowMs: 60_000, now: 1_000 };
    for (let i = 1; i <= 4; i++) {
      const result = checkRateLimit(request(`198.51.100.${i}`, i % 2 ? undefined : "dummy"), opts);
      assert.equal(result?.status ?? null, i <= 2 ? null : 429);
      if (result) assert.ok(Number(result.headers.get("Retry-After")) > 0);
    }
  }
});

test("ASA-08: real POST /api/auth/login remains locked after 20 rotated spoofed identities", async () => {
  Object.assign(process.env, authenticated, { FIRM_API_TOKEN: randomBytes(32).toString("hex") });
  // This checkout has no checkLoginAllowed: login invokes checkRateLimit(max: 20).
  for (let i = 1; i <= 22; i++) {
    const result = await login(request(`198.51.100.${i}`, i % 2 ? undefined : "dummy"));
    assert.equal(result.status, i <= 20 ? 401 : 429);
    assert.equal(result.headers.get("Set-Cookie"), null);
  }
});

test("ASA-08: authenticated proxy clients retain distinct rate-limit buckets", () => {
  Object.assign(process.env, authenticated);
  const opts = { max: 1, windowMs: 60_000, now: 1_000 };
  assert.equal(checkRateLimit(request("198.51.100.1", secret), opts), null);
  assert.equal(checkRateLimit(request("198.51.100.2", secret), opts), null);
  assert.equal(checkRateLimit(request("198.51.100.1", secret), opts)?.status, 429);
});
