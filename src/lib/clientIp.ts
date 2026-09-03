/**
 * Client-Identität für Rate-Limits — Vertrauen aus Konfiguration, nie aus dem
 * Request-Header (Befund C2, v1.36.14).
 *
 * Blatt-Modul: keine Imports aus `src/lib/apiAuth`, `src/auth/*`,
 * `src/brokers/*` und kein `node:*`. Damit teilen sich der Firm-Schreib-Limiter
 * (`src/lib/apiAuth.ts`) und der Credential-Limiter der Control Plane
 * (`src/brokers/control-plane/guard.ts`) **dieselbe** Auflösung
 * (`resolveClientIp`), ohne Import-Zyklus — vorher duplizierten beide dieselbe
 * spoofbare Dreizeiler-Logik.
 *
 * Ausgangslage (vor dem Fix, Befund C2):
 *
 * ```ts
 * const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
 * const real = req.headers.get("x-real-ip")?.trim();
 * return fwd || real || "local";
 * ```
 *
 * Beide Header setzt der **Client**. Ein frisches `X-Forwarded-For: <zufällig>`
 * pro Anfrage erzeugte einen frischen Bucket — das per-IP-Limit war damit nicht
 * umgangen, sondern schlicht abgeschaltet (Credential-Brute-Force ungedrosselt).
 *
 * Modell jetzt:
 *
 *  1. **`TRUSTED_PROXY_IPS`** (CIDR-Liste, z. B. `203.0.113.7,10.0.0.0/8`,
 *     Aliase `loopback`/`private`/`link-local`) ist der einzige
 *     Vertrauensanker. `x-forwarded-for` wird **nur** ausgewertet, wenn der
 *     direkte Verbindungspeer (Socket-Remote-Adresse) bekannt ist und in dieser
 *     Liste liegt. Auswertung dann von **rechts nach links**: alle
 *     vertrauenswürdigen Proxys werden übersprungen, das erste nicht
 *     vertrauenswürdige Element ist der Client. Ein vom Client vorangestelltes
 *     `X-Forwarded-For: 1.2.3.4` bleibt wirkungslos, weil der Proxy die echte
 *     Peer-Adresse anhängt.
 *  2. **`x-verified-ip`** ist der bevorzugte Header (in Next.js der einzig
 *     praktikable): ihn darf NUR der Reverse Proxy setzen
 *     (`proxy_set_header X-Verified-IP $remote_addr;`), und der Proxy muss
 *     einen vom Client mitgebrachten Wert überschreiben. Akzeptiert wird er bei
 *     wirksamem Proxy-Vertrauen (1) — oder ohne `TRUSTED_PROXY_IPS`, wenn die
 *     Anfrage nachweislich von **Loopback** kommt (Single-Host-Setup; der
 *     Dienst bindet lokal 127.0.0.1). Mehrdeutige Werte (mehrfacher Header,
 *     Liste mit Komma, Müll) werden verworfen: fail-closed statt Rate-Roulette.
 *  3. Ohne verwertbare Proxy-Information zählt die **Server-seitige**
 *     Identität: Socket-Remote-Adresse, sonst die Prozess-Konstante `local`
 *     (alle Clients teilen sich dann EINEN Bucket — strenger, nie laxer).
 *  4. **`x-real-ip` wird nie** als Identität benutzt (genauso client-setzbar
 *     wie `x-forwarded-for`); es erscheint höchstens in `ignoredHeaders`.
 *
 * Hinweis zur Laufzeit: Im Next.js-App-Router trägt das Web-`Request`-Objekt
 * keine Socket-Adresse, `peerIpFromRequest()` liefert dort `null`. Wer einen
 * eigenen Node-Server/Adapter fährt, übergibt die Socket-Adresse explizit über
 * `opts.peerIp` — dann greift Regel 1 mit echter Peer-Prüfung. Ohne Peer
 * entscheidet `x-verified-ip` (Regel 2).
 */

type EnvLike = Record<string, string | undefined>;

/** Env-Flag: CIDR-Liste der Reverse Proxys, deren Header vertraut wird. */
export const TRUSTED_PROXY_IPS_FLAG = "TRUSTED_PROXY_IPS";

/** Header, den ausschliesslich der Reverse Proxy setzen darf. */
export const VERIFIED_IP_HEADER = "x-verified-ip";

/** Wird nur bei verifiziertem Trusted-Proxy-Peer ausgewertet (nie blind). */
export const FORWARDED_FOR_HEADER = "x-forwarded-for";

/** Wird nie als Identität benutzt — bleibt aber in der Diagnose sichtbar. */
export const REAL_IP_HEADER = "x-real-ip";

/** Fallback-Schlüssel, wenn serverseitig nichts bestimmbar ist. */
export const LOCAL_CLIENT_KEY = "local";

// ── IP-Parsing (abhängigkeitsfrei, ohne BigInt, Edge- und Node-tauglich) ─────

export type IpFamily = 4 | 6;

/**
 * Geparste IP als Zahlengruppen — IPv4: 4 Gruppen à 8 Bit, IPv6: 8 Gruppen
 * à 16 Bit. Gruppen statt `BigInt`, weil das Projekt auf `ES2017` steht
 * (`tsconfig.json`) und BigInt-Literale dort nicht verfügbar sind.
 */
export type IpAddress = { family: IpFamily; groups: number[] };

/** IP-Netz (CIDR) — `groups` sind bereits auf die Präfixgrenze maskiert. */
export type IpNetwork = {
  family: IpFamily;
  groups: number[];
  prefix: number;
  /** Ursprünglicher Eintrag (für Diagnose/Warnungen). */
  source: string;
};

const groupCount = (family: IpFamily): number => (family === 4 ? 4 : 8);
const groupBits = (family: IpFamily): number => (family === 4 ? 8 : 16);
const maxPrefix = (family: IpFamily): number => (family === 4 ? 32 : 128);

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_RE = /^[0-9a-f]{1,4}$/;

function parseIpv4Groups(text: string): number[] | null {
  const m = IPV4_RE.exec(text);
  if (!m) return null;
  const groups: number[] = [];
  for (let i = 1; i <= 4; i += 1) {
    const part = m[i] as string;
    // Führende Nullen sind mehrdeutig (Oktal-Interpretation je nach Stack) —
    // Parser-Differenzen zwischen Proxy und App wären ein Trust-Loch.
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    groups.push(n);
  }
  return groups;
}

function parseIpv6Groups(text: string): number[] | null {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone); // Zone-ID (fe80::1%eth0) ist hier egal
  if (!s.includes(":")) return null;

  // Eingebettetes IPv4 (::ffff:203.0.113.9) in zwei Hex-Gruppen überführen.
  const embedded = s.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const v4 = parseIpv4Groups(embedded[1] as string);
    if (v4 === null) return null;
    const hi = ((v4[0] as number) << 8) | (v4[1] as number);
    const lo = ((v4[2] as number) << 8) | (v4[3] as number);
    const cut = (embedded.index ?? 0) + 1;
    s = `${s.slice(0, cut)}${hi.toString(16)}:${lo.toString(16)}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const splitGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const raw = part.split(":");
    if (!raw.every((g) => HEX_GROUP_RE.test(g))) return null;
    return raw.map((g) => parseInt(g, 16));
  };

  const left = splitGroups(halves[0] as string);
  if (left === null) return null;

  // Ohne "::" muss die Adresse voll ausgeschrieben sein (genau 8 Gruppen).
  if (halves.length === 1) {
    if (left.length !== groupCount(6)) return null;
    return left;
  }

  const right = splitGroups(halves[1] as string);
  if (right === null) return null;
  const missing = groupCount(6) - left.length - right.length;
  // "::" muss mindestens eine Gruppe ersetzen (RFC 4291).
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/**
 * Parst eine IP (v4, v6, IPv4-mapped v6, Zone-ID). IPv4-mapped
 * (`::ffff:203.0.113.9`) wird als IPv4 behandelt — Node meldet
 * IPv4-Verbindungen auf Dual-Stack-Sockets genau so, und ein Trusted-Proxy
 * `203.0.113.9` müsste sonst doppelt konfiguriert werden.
 */
export function parseIp(input: string | null | undefined): IpAddress | null {
  let text = (input ?? "").trim();
  // Eckige Klammern ([2001:db8::1]) kommen in URL-/Header-Kontexten vor und
  // gehören nicht zur Adresse.
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1).trim();
  if (!text) return null;
  if (text.includes(":")) {
    const groups = parseIpv6Groups(text);
    if (groups === null) return null;
    // IPv4-mapped (::ffff:a.b.c.d ⇒ [0,0,0,0,0,0xffff,a.b,c.d]) als IPv4
    // weiterverarbeiten: Node meldet IPv4-Verbindungen auf Dual-Stack-Sockets
    // in genau dieser Form.
    const mapped =
      groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
    if (mapped) {
      const ab = groups[6] as number;
      const cd = groups[7] as number;
      return {
        family: 4,
        groups: [(ab >> 8) & 0xff, ab & 0xff, (cd >> 8) & 0xff, cd & 0xff],
      };
    }
    return { family: 6, groups };
  }
  const v4 = parseIpv4Groups(text);
  return v4 === null ? null : { family: 4, groups: v4 };
}

/** Kanonische Textform (IPv6 nach RFC 5952 komprimiert). */
export function formatIp(ip: IpAddress): string {
  if (ip.family === 4) return ip.groups.join(".");
  const groups = ip.groups;
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  groups.forEach((g, i) => {
    if (g === 0) {
      if (curStart < 0) {
        curStart = i;
        curLen = 1;
      } else {
        curLen += 1;
      }
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  });
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

/**
 * Normalisiert eine IP-Zeichenkette; `null` = keine gültige IP. Die
 * Normalisierung ist der Grund, warum Bucket-Schlüssel nicht durch
 * Schreibvarianten (`2001:DB8::1` vs `2001:db8:0:0:0:0:0:1`) aufspreizbar sind.
 */
export function normalizeIp(input: string | null | undefined): string | null {
  const parsed = parseIp(input);
  return parsed ? formatIp(parsed) : null;
}

/** Maskiert die Gruppen hinter der Präfixgrenze auf 0. */
function maskGroups(
  family: IpFamily,
  groups: number[],
  prefix: number
): number[] {
  const bits = groupBits(family);
  return groups.map((g, i) => {
    const start = i * bits;
    if (start >= prefix) return 0;
    if (start + bits <= prefix) return g;
    const keep = prefix - start;
    return (g >> (bits - keep)) << (bits - keep);
  });
}

/** Parst einen CIDR-Eintrag (`203.0.113.7`, `10.0.0.0/8`, `::1/128`). */
export function parseIpNetwork(entry: string): IpNetwork | null {
  const text = (entry ?? "").trim();
  if (!text) return null;
  const parts = text.split("/");
  if (parts.length > 2) return null;
  const ip = parseIp(parts[0]);
  if (!ip) return null;
  const max = maxPrefix(ip.family);
  let prefix = max;
  if (parts[1] !== undefined) {
    const rawPrefix = parts[1].trim();
    if (!/^\d{1,3}$/.test(rawPrefix)) return null;
    prefix = Number(rawPrefix);
    if (prefix > max) return null;
  }
  return {
    family: ip.family,
    groups: maskGroups(ip.family, ip.groups, prefix),
    prefix,
    source: text,
  };
}

/** Liegt `ip` in `network`? (Adressfamilien müssen passen.) */
export function networkContains(network: IpNetwork, ip: IpAddress): boolean {
  if (network.family !== ip.family) return false;
  const bits = groupBits(ip.family);
  for (let i = 0; i < ip.groups.length; i += 1) {
    const start = i * bits;
    if (start >= network.prefix) return true; // Rest ist per Maske egal
    const value = ip.groups[i] as number;
    const expected = network.groups[i] as number;
    if (start + bits <= network.prefix) {
      if (value !== expected) return false;
      continue;
    }
    const shift = bits - (network.prefix - start);
    if (value >> shift !== expected >> shift) return false;
  }
  return true;
}

// ── Trusted-Proxy-Konfiguration ──────────────────────────────────────────────

/**
 * Bequemlichkeits-Aliase für typische Single-Host-Setups. Bewusst kein
 * `all`/`any`-Alias: „alles vertrauen“ muss explizit als `0.0.0.0/0,::/0`
 * hingeschrieben werden (und erzeugt eine laute Warnung).
 */
export const TRUSTED_PROXY_ALIASES: Record<string, string[]> = {
  loopback: ["127.0.0.0/8", "::1/128"],
  private: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
  "link-local": ["169.254.0.0/16", "fe80::/10"],
};

export type TrustedProxyConfig = {
  /** Flag war überhaupt gesetzt (auch wenn jeder Eintrag unparsebar war). */
  configured: boolean;
  /** Verwertbare Netze — leer ⇒ kein Proxy-Vertrauen (fail-closed). */
  networks: IpNetwork[];
  /** Verworfene Einträge (Diagnose, nie ein Grund offen zu laufen). */
  invalid: string[];
  /** Aliase, die aufgelöst wurden. */
  aliases: string[];
};

const EMPTY_TRUST: TrustedProxyConfig = {
  configured: false,
  networks: [],
  invalid: [],
  aliases: [],
};

/** Kleine Memo, damit der Requestpfad nicht pro Anfrage CIDRs parst. */
const trustCache = new Map<string, TrustedProxyConfig>();

/** Parst `TRUSTED_PROXY_IPS` (Komma/Semikolon/Whitespace-getrennt). */
export function parseTrustedProxies(
  raw: string | null | undefined
): TrustedProxyConfig {
  const text = (raw ?? "").trim();
  if (!text) return EMPTY_TRUST;
  const cached = trustCache.get(text);
  if (cached) return cached;

  const networks: IpNetwork[] = [];
  const invalid: string[] = [];
  const aliases: string[] = [];
  for (const tokenRaw of text.split(/[,\s;]+/)) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const alias = TRUSTED_PROXY_ALIASES[token.toLowerCase()];
    if (alias) {
      aliases.push(token.toLowerCase());
      for (const entry of alias) {
        const net = parseIpNetwork(entry);
        if (net) networks.push(net);
      }
      continue;
    }
    const net = parseIpNetwork(token);
    if (net) networks.push(net);
    else invalid.push(token);
  }

  const config: TrustedProxyConfig = {
    configured: true,
    networks,
    invalid,
    aliases,
  };
  if (trustCache.size > 64) trustCache.clear(); // Test-Suites setzen Env um
  trustCache.set(text, config);
  return config;
}

/** Liest die Trusted-Proxy-Konfiguration aus `env` (Default `process.env`). */
export function resolveTrustedProxies(
  env: EnvLike = process.env
): TrustedProxyConfig {
  return parseTrustedProxies(env[TRUSTED_PROXY_IPS_FLAG]);
}

/** Ist `ip` Teil eines konfigurierten Trusted-Proxy-Netzes? */
export function isTrustedProxyIp(
  ip: string | null | undefined,
  config: TrustedProxyConfig
): boolean {
  if (config.networks.length === 0) return false;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return config.networks.some((net) => networkContains(net, parsed));
}

/** Loopback-Adresse? (Same-Host-Proxy ohne explizite Konfiguration.) */
export function isLoopbackIp(ip: string | null | undefined): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  if (parsed.family === 4) return parsed.groups[0] === 127;
  return (
    parsed.groups.slice(0, 7).every((g) => g === 0) && parsed.groups[7] === 1
  );
}

/** Vertraut die Konfiguration effektiv jedem Peer? (Warnfall, Befund C2.) */
export function trustsEveryPeer(config: TrustedProxyConfig): boolean {
  return config.networks.some((net) => net.prefix === 0);
}

// ── Peer-Auflösung (Socket, nicht Header) ────────────────────────────────────

/**
 * Best-Effort-Lesen der Verbindungs-Remote-Adresse. Im Next.js-App-Router
 * existiert sie am Web-`Request` nicht (`null`); unter Node
 * (`http.IncomingMessage`, eigener Server, Middleware-Adapter) schon.
 * Bewusst **kein** Header-Fallback: genau das war Befund C2.
 */
export function peerIpFromRequest(req: unknown): string | null {
  if (!req || typeof req !== "object") return null;
  const candidate = req as {
    socket?: { remoteAddress?: unknown } | null;
    connection?: { remoteAddress?: unknown } | null;
    ip?: unknown;
  };
  const values: unknown[] = [
    candidate.socket?.remoteAddress,
    candidate.connection?.remoteAddress,
    candidate.ip,
  ];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeIp(value);
    if (normalized) return normalized;
  }
  return null;
}

// ── Forwarded-Chain (nur hinter verifiziertem Trusted Proxy) ─────────────────

/**
 * Client-IP aus einer `x-forwarded-for`-Kette — **rightmost-untrusted**:
 * von rechts die vertrauenswürdigen Proxys überspringen, erstes fremdes
 * Element = Client. Damit ist eine vom Client vorangestellte Falschangabe
 * wertlos (der Proxy hängt die echte Peer-Adresse an).
 *
 * Nur aufrufen, wenn der direkte Peer nachweislich vertrauenswürdig ist.
 */
export function clientIpFromForwardedChain(
  headerValue: string | null | undefined,
  networks: IpNetwork[]
): string | null {
  const raw = (headerValue ?? "").trim();
  if (!raw) return null;
  const parsed: string[] = [];
  for (const entry of raw.split(",")) {
    const normalized = normalizeIp(entry);
    if (normalized) parsed.push(normalized);
  }
  if (parsed.length === 0) return null;
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const entry = parsed[i] as string;
    const asIp = parseIp(entry);
    const trusted = asIp
      ? networks.some((net) => networkContains(net, asIp))
      : false;
    if (!trusted) return entry;
  }
  return parsed[0] ?? null;
}

// ── Auflösung der Client-Identität ───────────────────────────────────────────

/** Woher die Bucket-Identität stammt (Diagnose, Logs, `/api/auth/me`). */
export type ClientIpSource =
  | "verified-header"
  | "trusted-forwarded-for"
  | "peer"
  | "local-fallback";

export type ClientIpResolution = {
  /** Rate-Limit-Schlüssel — nie leer, nie client-kontrolliert ohne Trust. */
  key: string;
  /** Aufgelöste IP (im Fallback `null`). */
  ip: string | null;
  source: ClientIpSource;
  /** Socket-Remote-Adresse, falls verfügbar (normalisiert). */
  peerIp: string | null;
  /** `null` = nicht bestimmbar (typisch Next.js-App-Router). */
  peerTrusted: boolean | null;
  trustedProxiesConfigured: boolean;
  /** Verworfene Header — sichtbar, damit Fehlkonfiguration auffällt. */
  ignoredHeaders: string[];
};

export type ClientIpOptions = {
  /** Explizite Socket-Adresse (eigener Node-Server/Adapter, Tests). */
  peerIp?: string | null;
  env?: EnvLike;
};

/**
 * Genau ein Header-Wert, eine gültige IP. Mehrdeutigkeit (mehrfacher Header ⇒
 * `, `-Join, oder Liste) wird verworfen: Ein doppelt gesetztes `x-verified-ip`
 * bedeutet „der Proxy überschreibt nicht sauber“ — dann darf kein Wert
 * übernommen werden (fail-closed).
 */
function singleIpValue(req: Request, name: string): string | null {
  const raw = req.headers.get(name);
  if (raw === null) return null;
  const text = raw.trim();
  if (!text || text.includes(",")) return null;
  return normalizeIp(text);
}

function headerPresent(req: Request, name: string): boolean {
  const raw = req.headers.get(name);
  return raw !== null && raw.trim().length > 0;
}

/**
 * SSoT der Rate-Limit-Identität. Wirft nie (Requestpfad) und ist fail-closed:
 * im Zweifel ein **engerer** Bucket (`local`), nie ein client-wählbarer.
 */
export function resolveClientIp(
  req: Request,
  opts: ClientIpOptions = {}
): ClientIpResolution {
  const env = opts.env ?? process.env;
  const trust = resolveTrustedProxies(env);
  const trustConfigured = trust.networks.length > 0;

  const peerIp =
    opts.peerIp === undefined
      ? peerIpFromRequest(req)
      : normalizeIp(opts.peerIp);
  const peerTrusted = peerIp === null ? null : isTrustedProxyIp(peerIp, trust);

  // Vorhandene (client-setzbare) Header — am Ende wird sichtbar, welche davon
  // NICHT als Identität übernommen wurden (Diagnose für Proxy-Fehlkonfiguration).
  const present: [string, boolean][] = [
    [VERIFIED_IP_HEADER, headerPresent(req, VERIFIED_IP_HEADER)],
    [FORWARDED_FOR_HEADER, headerPresent(req, FORWARDED_FOR_HEADER)],
    [REAL_IP_HEADER, headerPresent(req, REAL_IP_HEADER)],
  ];
  const verified = singleIpValue(req, VERIFIED_IP_HEADER);

  // Regel 1/2: Proxy-Header zählen nur bei verifiziertem Vertrauen.
  //  - Trusted-Proxy-Liste gesetzt: Peer unbekannt ⇒ die Konfiguration trägt
  //    das Vertrauen (Next.js-Fall ⇒ `x-verified-ip`); Peer bekannt ⇒ er muss
  //    in der Liste liegen, sonst zählt kein einziger Proxy-Header.
  //  - Liste nicht gesetzt: nur ein Same-Host-Proxy (Loopback-Peer) darf eine
  //    verifizierte IP behaupten.
  const proxyHeadersTrusted = trustConfigured
    ? peerTrusted !== false
    : peerIp !== null && isLoopbackIp(peerIp);

  let ip: string | null = peerIp;
  let source: ClientIpSource = peerIp ? "peer" : "local-fallback";
  let usedHeader: string | null = null;

  if (proxyHeadersTrusted && verified) {
    ip = verified;
    source = "verified-header";
    usedHeader = VERIFIED_IP_HEADER;
  } else if (proxyHeadersTrusted && trustConfigured && peerTrusted === true) {
    // `x-forwarded-for` NUR mit echt verifiziertem Trusted-Proxy-Peer — und
    // dann rightmost-untrusted: vorgeschobene Fälschungen zählen nicht.
    const fromChain = clientIpFromForwardedChain(
      req.headers.get(FORWARDED_FOR_HEADER),
      trust.networks
    );
    if (fromChain) {
      ip = fromChain;
      source = "trusted-forwarded-for";
      usedHeader = FORWARDED_FOR_HEADER;
    }
  }

  const ignoredHeaders = present
    .filter(([name, isPresent]) => isPresent && name !== usedHeader)
    .map(([name]) => name);

  return {
    key: ip ?? LOCAL_CLIENT_KEY,
    ip,
    source,
    peerIp,
    peerTrusted,
    trustedProxiesConfigured: trustConfigured,
    ignoredHeaders,
  };
}

/** Bucket-Schlüssel für Limiter (Kurzform von {@link resolveClientIp}). */
export function clientRateLimitKey(
  req: Request,
  opts: ClientIpOptions = {}
): string {
  return resolveClientIp(req, opts).key;
}

// ── Diagnose (Boot-Log, `/api/auth/me`) — secret-frei ────────────────────────

/** Ein-Zeilen-Zusammenfassung der wirksamen Header-Policy. */
export function describeClientIpPolicy(env: EnvLike = process.env): string {
  const trust = resolveTrustedProxies(env);
  if (trust.networks.length === 0) {
    const invalid =
      trust.invalid.length > 0 ? ` (ungueltig: ${trust.invalid.length})` : "";
    return (
      `client-ip=peer-oder-local trusted-proxies=0${invalid} — ` +
      `${FORWARDED_FOR_HEADER}/${REAL_IP_HEADER} ignoriert`
    );
  }
  return (
    `client-ip=${VERIFIED_IP_HEADER}+${FORWARDED_FOR_HEADER} ` +
    `trusted-proxies=${trust.networks.length}` +
    (trust.aliases.length > 0 ? ` (alias: ${trust.aliases.join(",")})` : "") +
    (trust.invalid.length > 0 ? ` ungueltig=${trust.invalid.length}` : "")
  );
}

/** Betreiber-Warnungen zur Konfiguration (nie Header-/Request-Inhalte). */
export function clientIpPolicyWarnings(env: EnvLike = process.env): string[] {
  const trust = resolveTrustedProxies(env);
  const out: string[] = [];
  if (trust.invalid.length > 0) {
    out.push(
      `[client-ip] ${TRUSTED_PROXY_IPS_FLAG}: ${trust.invalid.length} Eintrag/Eintraege ungueltig und verworfen (${trust.invalid
        .slice(0, 5)
        .join(", ")}) — erlaubt sind CIDR (203.0.113.7, 10.0.0.0/8, ::1/128) und die Aliase ${Object.keys(
        TRUSTED_PROXY_ALIASES
      ).join(", ")}.`
    );
  }
  if (trust.configured && trust.networks.length === 0) {
    out.push(
      `[client-ip] ${TRUSTED_PROXY_IPS_FLAG} ist gesetzt, aber kein Eintrag ist verwertbar — Proxy-Header werden ignoriert (fail-closed), alle Clients teilen sich den Bucket "${LOCAL_CLIENT_KEY}".`
    );
  }
  if (trustsEveryPeer(trust)) {
    out.push(
      `[client-ip] WARNUNG: ${TRUSTED_PROXY_IPS_FLAG} enthaelt 0.0.0.0/0 bzw. ::/0 — damit ist JEDER Peer ein vertrauenswuerdiger Proxy und ${FORWARDED_FOR_HEADER} wieder client-kontrolliert (Befund C2).`
    );
  }
  return out;
}
