/**
 * Befund C2 (v1.36.14) — Rate-Limit-Identität darf nicht aus client-setzbaren
 * Proxy-Headers kommen.
 *
 * Abgedeckt:
 *   1. IP-/CIDR-Parsing (IPv4, IPv6, IPv4-mapped, Zone-ID, Müll) — die Basis
 *      jeder Trusted-Proxy-Entscheidung.
 *   2. **Akzeptanzkriterium:** `X-Forwarded-For: 1.2.3.4` ändert den Bucket
 *      NICHT, solange kein Proxy-Vertrauen konfiguriert ist; dasselbe für
 *      `x-real-ip`. Nachweis über `resolveClientIp` UND über den echten
 *      Firm-Limiter (`checkRateLimit`): rotierende Fake-Header laufen in
 *      denselben Bucket ⇒ 429 statt unbegrenzter Freifahrt.
 *   3. `TRUSTED_PROXY_IPS` + verifizierter Peer ⇒ `x-forwarded-for` zählt,
 *      aber rightmost-untrusted (vorgeschobene Fälschung wird übersprungen).
 *      Nicht vertrauenswürdiger Peer ⇒ Header zählt nicht.
 *   4. `x-verified-ip` (proxy-gesetzt) ist der Next.js-Pfad: akzeptiert bei
 *      wirksamem Vertrauen bzw. Loopback-Peer, verworfen bei Mehrdeutigkeit.
 *   5. Beide Limiter teilen dieselbe Auflösung (`src/lib/clientIp.ts`) —
 *      statischer Drift-Schutz gegen Nachbauten der alten Dreizeiler-Logik.
 */
import { test, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  FORWARDED_FOR_HEADER,
  LOCAL_CLIENT_KEY,
  REAL_IP_HEADER,
  TRUSTED_PROXY_IPS_FLAG,
  VERIFIED_IP_HEADER,
  clientIpFromForwardedChain,
  clientIpPolicyWarnings,
  describeClientIpPolicy,
  isLoopbackIp,
  isTrustedProxyIp,
  networkContains,
  normalizeIp,
  parseIp,
  parseIpNetwork,
  parseTrustedProxies,
  peerIpFromRequest,
  resolveClientIp,
  trustsEveryPeer,
} from "../src/lib/clientIp";
import {
  checkRateLimit,
} from "../src/lib/apiAuth";
import { scanTextForSecrets } from "../src/brokers/control-plane/secretScan";
import { __resetAllSingletonsForTests } from "../src/lib/stateRegistry";

const ROOT = process.cwd();

/** Request mit Headern (Web-`Request` ⇒ keine Socket-Adresse, wie in Next.js). */
function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/firm/tick", {
    method: "POST",
    headers,
  });
}

const NO_ENV = {};

beforeEach(() => {
  __resetAllSingletonsForTests();
  delete process.env[TRUSTED_PROXY_IPS_FLAG];
  delete process.env.FIRM_RATE_LIMIT;
  delete process.env.FIRM_ADMIN_TOKEN;
  delete process.env.FIRM_API_TOKEN;
  delete process.env.FIRM_VIEWER_TOKEN;
});

// ── 1. Parsing ───────────────────────────────────────────────────────────────

describe("IP-/CIDR-Parsing", () => {
  test("normalizeIp: gültige IPv4/IPv6, kanonische Form, Müll → null", () => {
    assert.equal(normalizeIp("203.0.113.9"), "203.0.113.9");
    assert.equal(normalizeIp("  203.0.113.9  "), "203.0.113.9");
    assert.equal(normalizeIp("2001:DB8:0:0:0:0:0:1"), "2001:db8::1");
    assert.equal(normalizeIp("2001:db8::1"), "2001:db8::1");
    assert.equal(normalizeIp("::1"), "::1");
    assert.equal(normalizeIp("::"), "::");
    assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
    assert.equal(normalizeIp("[2001:db8::1]"), "2001:db8::1");
    assert.equal(normalizeIp("[]"), null);
    assert.equal(normalizeIp("1:2:3:4:5:6:7:8"), "1:2:3:4:5:6:7:8");
    // IPv4-mapped ⇒ als IPv4 behandelt (Node meldet das auf Dual-Stack so)
    assert.equal(normalizeIp("::ffff:203.0.113.9"), "203.0.113.9");
    // ungültig
    for (const bad of [
      "",
      "   ",
      "localhost",
      "1.2.3",
      "1.2.3.4.5",
      "203.0.113.256",
      "203.0.113.09", // führende Null ⇒ mehrdeutig (Oktal) ⇒ abgelehnt
      "-1.0.0.0",
      "gggg::1",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7::8",
      "2001:db8::1::2",
      "::ffff:999.1.1.1",
    ]) {
      assert.equal(normalizeIp(bad), null, `${bad} muss abgelehnt werden`);
    }
  });

  test("parseIpNetwork + networkContains: CIDR-Grenzen, Familien-Trennung", () => {
    const net = parseIpNetwork("203.0.113.0/24");
    assert.ok(net);
    assert.equal(networkContains(net, parseIp("203.0.113.77")!), true);
    assert.equal(networkContains(net, parseIp("203.0.114.77")!), false);
    assert.equal(networkContains(net, parseIp("2001:db8::1")!), false);

    const v6 = parseIpNetwork("2001:db8::/32");
    assert.ok(v6);
    assert.equal(networkContains(v6, parseIp("2001:db8:1::9")!), true);
    assert.equal(networkContains(v6, parseIp("2001:db9::9")!), false);

    // Einzeladresse ohne Präfix = /32 bzw. /128
    const single = parseIpNetwork("198.51.100.4");
    assert.ok(single);
    assert.equal(single.prefix, 32);
    assert.equal(networkContains(single, parseIp("198.51.100.4")!), true);
    assert.equal(networkContains(single, parseIp("198.51.100.5")!), false);

    // /0 matcht alles (deshalb laut gewarnt)
    const any = parseIpNetwork("0.0.0.0/0");
    assert.ok(any);
    assert.equal(networkContains(any, parseIp("8.8.8.8")!), true);

    // unparsebar / Präfix zu groß
    assert.equal(parseIpNetwork("quatsch"), null);
    assert.equal(parseIpNetwork("10.0.0.0/33"), null);
    assert.equal(parseIpNetwork("::1/129"), null);
    assert.equal(parseIpNetwork("10.0.0.0/8/8"), null);
    assert.equal(parseIpNetwork(""), null);
  });

  test("parseTrustedProxies: Liste, Aliase, ungültige Einträge (fail-closed)", () => {
    const empty = parseTrustedProxies(undefined);
    assert.equal(empty.configured, false);
    assert.deepEqual(empty.networks, []);

    const list = parseTrustedProxies("203.0.113.7, 198.51.100.0/24 quatsch");
    assert.equal(list.configured, true);
    assert.equal(list.networks.length, 2);
    assert.deepEqual(list.invalid, ["quatsch"]);
    assert.equal(isTrustedProxyIp("203.0.113.7", list), true);
    assert.equal(isTrustedProxyIp("198.51.100.9", list), true);
    assert.equal(isTrustedProxyIp("8.8.8.8", list), false);
    assert.equal(isTrustedProxyIp(null, list), false);

    const alias = parseTrustedProxies("loopback");
    assert.deepEqual(alias.aliases, ["loopback"]);
    assert.equal(isTrustedProxyIp("127.0.0.1", alias), true);
    assert.equal(isTrustedProxyIp("::ffff:127.0.0.1", alias), true);
    assert.equal(isTrustedProxyIp("203.0.113.7", alias), false);

    // gesetzt, aber nichts verwertbar ⇒ kein Vertrauen + Warnung
    const broken = parseTrustedProxies("quatsch");
    assert.equal(broken.configured, true);
    assert.equal(broken.networks.length, 0);
    assert.equal(isTrustedProxyIp("127.0.0.1", broken), false);

    assert.equal(isLoopbackIp("127.9.9.9"), true);
    assert.equal(isLoopbackIp("::1"), true);
    assert.equal(isLoopbackIp("203.0.113.9"), false);
    assert.equal(trustsEveryPeer(parseTrustedProxies("0.0.0.0/0")), true);
    assert.equal(trustsEveryPeer(parseTrustedProxies("203.0.113.7")), false);
  });

  test("clientIpFromForwardedChain: rightmost-untrusted statt leftmost-blind", () => {
    const proxy = [parseIpNetwork("203.0.113.7")!];
    // Spoof-Versuch: Angreifer schickt `X-Forwarded-For: 1.2.3.4`, der Proxy
    // hängt die echte Peer-Adresse an ⇒ die echte gewinnt (nicht die Fake-IP).
    assert.equal(
      clientIpFromForwardedChain("1.2.3.4, 198.51.100.23", proxy),
      "198.51.100.23"
    );

    // Zweistufig: Client → Proxy-Pool (198.51.100.0/24) → Edge-Proxy → App
    const pool = [...proxy, parseIpNetwork("198.51.100.0/24")!];
    assert.equal(
      clientIpFromForwardedChain("1.2.3.4, 203.0.113.50, 198.51.100.5", pool),
      "203.0.113.50",
      "Proxys werden von rechts übersprungen, der Client bleibt stehen"
    );
    // Kette aus lauter Proxys ⇒ leftmost (der vom äußersten Proxy gesehene Client)
    assert.equal(
      clientIpFromForwardedChain("203.0.113.7, 198.51.100.5", pool),
      "203.0.113.7"
    );
    assert.equal(clientIpFromForwardedChain("8.8.8.8", pool), "8.8.8.8");
    assert.equal(clientIpFromForwardedChain("", pool), null);
    assert.equal(clientIpFromForwardedChain("nur-muell", pool), null);
  });

  test("peerIpFromRequest: Socket ja, Header nein (kein C2-Rückfall)", () => {
    assert.equal(peerIpFromRequest(null), null);
    assert.equal(peerIpFromRequest({}), null);
    assert.equal(peerIpFromRequest(req({ "x-forwarded-for": "1.2.3.4" })), null);
    assert.equal(
      peerIpFromRequest({ socket: { remoteAddress: "::ffff:203.0.113.9" } }),
      "203.0.113.9"
    );
    assert.equal(
      peerIpFromRequest({ connection: { remoteAddress: "127.0.0.1" } }),
      "127.0.0.1"
    );
    assert.equal(peerIpFromRequest({ socket: { remoteAddress: "quatsch" } }), null);
  });
});

// ── 2. Akzeptanz: spoofbare Header zählen nicht ──────────────────────────────

describe("C2-Akzeptanz: spoofbare Header ändern den Bucket nicht", () => {
  test("X-Forwarded-For wird ohne Proxy-Trust ignoriert (Bucket bleibt 'local')", () => {
    const a = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), { env: NO_ENV });
    const b = resolveClientIp(req({ "x-forwarded-for": "9.9.9.9" }), { env: NO_ENV });
    assert.equal(a.key, LOCAL_CLIENT_KEY);
    assert.equal(b.key, LOCAL_CLIENT_KEY);
    assert.equal(a.key, b.key, "zwei verschiedene Fake-IPs ⇒ derselbe Bucket");
    assert.equal(a.source, "local-fallback");
    assert.deepEqual(a.ignoredHeaders, [FORWARDED_FOR_HEADER]);
  });

  test("x-real-ip wird nie als Identität benutzt", () => {
    const r = resolveClientIp(req({ "x-real-ip": "1.2.3.4" }), { env: NO_ENV });
    assert.equal(r.key, LOCAL_CLIENT_KEY);
    assert.deepEqual(r.ignoredHeaders, [REAL_IP_HEADER]);

    const withTrust = resolveClientIp(
      req({ "x-real-ip": "1.2.3.4" }),
      { env: { [TRUSTED_PROXY_IPS_FLAG]: "203.0.113.7" }, peerIp: "203.0.113.7" }
    );
    assert.equal(withTrust.key, "203.0.113.7", "Peer schlägt x-real-ip");
    assert.deepEqual(withTrust.ignoredHeaders, [REAL_IP_HEADER]);
  });

  test("Firm-Limiter: rotierende Fake-XFFs laufen in EINEN Bucket ⇒ 429", () => {
    const opts = { max: 2, windowMs: 60_000, now: 1_000 };
    assert.equal(checkRateLimit(req({ "x-forwarded-for": "1.2.3.4" }), opts), null);
    assert.equal(checkRateLimit(req({ "x-forwarded-for": "5.6.7.8" }), opts), null);
    const limited = checkRateLimit(req({ "x-forwarded-for": "9.9.9.9" }), opts);
    assert.ok(limited, "mit spoofbarer Identität wäre das Limit wirkungslos");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
  });

  test("Ohne Header und ohne Socket gilt dieselbe stabile Identität", () => {
    const opts = { max: 1, windowMs: 60_000, now: 5_000 };
    assert.equal(checkRateLimit(req(), opts), null);
    assert.equal(checkRateLimit(req(), opts)?.status, 429);
  });

  test("Socket-Peer (eigener Node-Server) bestimmt den Bucket, Header nicht", () => {
    const env = NO_ENV;
    const a = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), { env, peerIp: "203.0.113.44" });
    const b = resolveClientIp(req({ "x-forwarded-for": "9.9.9.9" }), { env, peerIp: "203.0.113.44" });
    assert.equal(a.key, "203.0.113.44");
    assert.equal(a.source, "peer");
    assert.equal(a.key, b.key);

    // anderer Peer ⇒ anderer Bucket (echte Trennung bleibt erhalten)
    const c = resolveClientIp(req(), { env, peerIp: "203.0.113.45" });
    assert.equal(c.key, "203.0.113.45");
  });
});

// ── 3. TRUSTED_PROXY_IPS ─────────────────────────────────────────────────────

describe("TRUSTED_PROXY_IPS: Vertrauen nur mit verifiziertem Peer", () => {
  const TRUST = { [TRUSTED_PROXY_IPS_FLAG]: "203.0.113.7" };

  test("vertrauenswürdiger Peer ⇒ XFF rightmost-untrusted", () => {
    const r = resolveClientIp(
      req({ "x-forwarded-for": "1.2.3.4, 198.51.100.23" }),
      { env: TRUST, peerIp: "203.0.113.7" }
    );
    assert.equal(r.source, "trusted-forwarded-for");
    assert.equal(r.key, "198.51.100.23", "vorgeschobene Fake-IP darf nicht zählen");
    assert.equal(r.peerTrusted, true);
  });

  test("nicht vertrauenswürdiger Peer ⇒ XFF ignoriert, Peer zählt", () => {
    const r = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), {
      env: TRUST,
      peerIp: "8.8.8.8",
    });
    assert.equal(r.source, "peer");
    assert.equal(r.key, "8.8.8.8");
    assert.equal(r.peerTrusted, false);
    assert.deepEqual(r.ignoredHeaders, [FORWARDED_FOR_HEADER]);
  });

  test("Peer unbekannt (Next.js) ⇒ XFF ignoriert, x-verified-ip zählt", () => {
    const forwarded = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), { env: TRUST });
    assert.equal(forwarded.key, LOCAL_CLIENT_KEY);
    assert.equal(forwarded.source, "local-fallback");
    assert.deepEqual(forwarded.ignoredHeaders, [FORWARDED_FOR_HEADER]);

    const verified = resolveClientIp(req({ "x-verified-ip": "198.51.100.23" }), { env: TRUST });
    assert.equal(verified.key, "198.51.100.23");
    assert.equal(verified.source, "verified-header");
    assert.equal(verified.peerTrusted, null);
  });

  test("x-verified-ip schlägt x-forwarded-for (Proxy setzt beides)", () => {
    const r = resolveClientIp(
      req({ "x-verified-ip": "198.51.100.23", "x-forwarded-for": "1.2.3.4" }),
      { env: TRUST, peerIp: "203.0.113.7" }
    );
    assert.equal(r.key, "198.51.100.23");
    assert.equal(r.source, "verified-header");
    assert.deepEqual(r.ignoredHeaders, [FORWARDED_FOR_HEADER]);
  });

  test("CIDR-Liste: ganzer Proxy-Pool ist vertrauenswürdig", () => {
    const env = { [TRUSTED_PROXY_IPS_FLAG]: "198.51.100.0/24, 2001:db8::/32" };
    const inPool = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), {
      env,
      peerIp: "198.51.100.9",
    });
    assert.equal(inPool.source, "trusted-forwarded-for");
    assert.equal(inPool.key, "1.2.3.4");
    const v6 = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), {
      env,
      peerIp: "2001:db8::5",
    });
    assert.equal(v6.key, "1.2.3.4");
    const outside = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), {
      env,
      peerIp: "198.51.101.9",
    });
    assert.equal(outside.key, "198.51.101.9");
  });

  test("ungültige Konfiguration ⇒ kein Vertrauen + laute Warnung", () => {
    const env = { [TRUSTED_PROXY_IPS_FLAG]: "quatsch" };
    const r = resolveClientIp(req({ "x-forwarded-for": "1.2.3.4" }), {
      env,
      peerIp: "203.0.113.7",
    });
    assert.equal(r.trustedProxiesConfigured, false);
    assert.equal(r.key, "203.0.113.7");
    const warnings = clientIpPolicyWarnings(env);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /ungueltig und verworfen/);
    assert.match(warnings[1], /fail-closed/);
    assert.match(describeClientIpPolicy(env), /trusted-proxies=0/);
    assert.match(describeClientIpPolicy(NO_ENV), /x-forwarded-for\/x-real-ip ignoriert/);
  });

  test("0.0.0.0/0 wird als C2-Rückfall gewarnt", () => {
    const env = { [TRUSTED_PROXY_IPS_FLAG]: "0.0.0.0/0" };
    const warnings = clientIpPolicyWarnings(env);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /WARNUNG/);
    assert.match(warnings[0], /C2/);
  });
});

// ── 4. x-verified-ip ohne TRUSTED_PROXY_IPS ──────────────────────────────────

describe("x-verified-ip: nur Same-Host-Proxy ohne Konfiguration", () => {
  test("Loopback-Peer ⇒ akzeptiert (Reverse Proxy auf demselben Host)", () => {
    const r = resolveClientIp(req({ "x-verified-ip": "198.51.100.23" }), {
      env: NO_ENV,
      peerIp: "127.0.0.1",
    });
    assert.equal(r.key, "198.51.100.23");
    assert.equal(r.source, "verified-header");
  });

  test("fremder Peer ⇒ verworfen (sonst neuer spoofbarer Header)", () => {
    const r = resolveClientIp(req({ "x-verified-ip": "198.51.100.23" }), {
      env: NO_ENV,
      peerIp: "203.0.113.9",
    });
    assert.equal(r.key, "203.0.113.9");
    assert.equal(r.source, "peer");
    assert.deepEqual(r.ignoredHeaders, [VERIFIED_IP_HEADER]);
  });

  test("Peer unbekannt ⇒ verworfen (fail-closed auf 'local')", () => {
    const r = resolveClientIp(req({ "x-verified-ip": "198.51.100.23" }), { env: NO_ENV });
    assert.equal(r.key, LOCAL_CLIENT_KEY);
    assert.deepEqual(r.ignoredHeaders, [VERIFIED_IP_HEADER]);
  });

  test("mehrdeutiger/unparsebarer Wert ⇒ verworfen", () => {
    const doubled = resolveClientIp(req({ "x-verified-ip": "198.51.100.23, 1.2.3.4" }), {
      env: NO_ENV,
      peerIp: "127.0.0.1",
    });
    assert.equal(doubled.key, "127.0.0.1");
    assert.deepEqual(doubled.ignoredHeaders, [VERIFIED_IP_HEADER]);

    const garbage = resolveClientIp(req({ "x-verified-ip": "ich-bin-keine-ip" }), {
      env: NO_ENV,
      peerIp: "127.0.0.1",
    });
    assert.equal(garbage.key, "127.0.0.1");
    assert.deepEqual(garbage.ignoredHeaders, [VERIFIED_IP_HEADER]);
  });

  test("IPv6-Clients bleiben unterscheidbar (keine Bucket-Kollision)", () => {
    const a = resolveClientIp(req({ "x-verified-ip": "2001:db8::1" }), {
      env: NO_ENV,
      peerIp: "::1",
    });
    const b = resolveClientIp(req({ "x-verified-ip": "2001:DB8:0:0:0:0:0:2" }), {
      env: NO_ENV,
      peerIp: "::1",
    });
    assert.equal(a.key, "2001:db8::1");
    assert.equal(b.key, "2001:db8::2");
    assert.notEqual(a.key, b.key);
  });
});

// ── 5. Drift-Schutz: eine Auflösung, zwei Limiter ────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

test("Drift-Schutz: Forwarded-Headers werden nur noch in clientIp.ts gelesen", () => {
  const offenders: string[] = [];
  for (const file of walk(path.join(ROOT, "src"))) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (rel === "src/lib/clientIp.ts") continue;
    const src = readFileSync(file, "utf8");
    // Header-Zugriff per String-Literal (nicht bloße Erwähnung in Kommentaren)
    const reads = [
      ...src.matchAll(/headers\s*(?:\.get\(|\.has\(|\[)\s*["'`]([^"'`]+)["'`]/g),
    ].map((m) => (m[1] ?? "").trim().toLowerCase());
    for (const name of reads) {
      if (name === FORWARDED_FOR_HEADER || name === REAL_IP_HEADER) {
        offenders.push(`${rel}: liest ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Spoofbare Header außerhalb der SSoT: ${offenders.join(", ")}`);
});

test("Drift-Schutz: beide Limiter nutzen die geteilte Auflösung", () => {
  const apiAuth = readFileSync(path.join(ROOT, "src/lib/apiAuth.ts"), "utf8");
  const guard = readFileSync(
    path.join(ROOT, "src/brokers/control-plane/guard.ts"),
    "utf8"
  );
  assert.match(apiAuth, /from "@\/lib\/clientIp"/);
  assert.match(apiAuth, /clientRateLimitKey\(req/);
  assert.match(guard, /from "@\/lib\/clientIp"/);
  assert.match(guard, /clientRateLimitKey\(req/);
  assert.equal(
    apiAuth.includes('return fwd || real || "local"'),
    false,
    "alter spoofbarer clientKey lebt wieder in apiAuth.ts"
  );
  assert.equal(
    guard.includes('return fwd || real || "local"'),
    false,
    "alter spoofbarer credentialClientKey lebt wieder in guard.ts"
  );
});

// ── 6. Diagnose: /api/auth/me macht die Identität sichtbar ───────────────────

test("GET /api/auth/me zeigt, dass spoofbare Header ignoriert wurden", async () => {
  const { GET } = await import("../src/app/api/auth/me/route");
  const res = await GET(
    req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "9.9.9.9" })
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as {
    rateLimitIdentity: {
      key: string;
      ip: string | null;
      source: string;
      peerAvailable: boolean;
      trustedProxiesConfigured: boolean;
      ignoredHeaders: string[];
      policy: string;
    };
  };
  const identity = body.rateLimitIdentity;
  assert.equal(identity.key, LOCAL_CLIENT_KEY);
  assert.equal(identity.ip, null);
  assert.equal(identity.source, "local-fallback");
  assert.equal(identity.peerAvailable, false);
  assert.equal(identity.trustedProxiesConfigured, false);
  assert.deepEqual(identity.ignoredHeaders, [FORWARDED_FOR_HEADER, REAL_IP_HEADER]);
  assert.match(identity.policy, /trusted-proxies=0/);
  // secret-frei wie der Rest der Antwort
  assert.deepEqual(scanTextForSecrets(text), []);
});

test("GET /api/auth/me: mit x-verified-ip und Loopback-Peer wird die IP sichtbar", async () => {
  process.env[TRUSTED_PROXY_IPS_FLAG] = "127.0.0.1";
  const { GET } = await import("../src/app/api/auth/me/route");
  const res = await GET(
    new Request("http://localhost/api/auth/me", {
      headers: { "x-verified-ip": "198.51.100.23" },
    })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    rateLimitIdentity: { key: string; source: string; trustedProxiesConfigured: boolean };
  };
  assert.equal(body.rateLimitIdentity.key, "198.51.100.23");
  assert.equal(body.rateLimitIdentity.source, "verified-header");
  assert.equal(body.rateLimitIdentity.trustedProxiesConfigured, true);
  delete process.env[TRUSTED_PROXY_IPS_FLAG];
});
