/**
 * Deklarative Venue-Symbol-Profile + paarweiser Symbol-Parser (SYM-007) —
 * Single Source of Truth dafür, wie eine Venue Symbole schreibt und wie sie
 * kanonisiert werden.
 *
 * Drei Notationen werden strikt unterschiedlich behandelt:
 *
 *  | Form          | Beispiel               | Bedeutung                                |
 *  | ------------- | ---------------------- | ---------------------------------------- |
 *  | **kanonisch** | `BTC/USD`              | venue-unabhängig, Paare stets mit `/`    |
 *  | **nativ**     | `XBTUSD` (Kraken-API)  | das, was die Venue-API erwartet          |
 *  | **Registry**  | `IBKR:EUR.USD`         | Speicher-Schreibweise der Registry       |
 *
 * **Eingabe liberal, Ausgabe strikt** (Ticket §3.2): Jedes Profil liest alle
 * historischen Schreibweisen (`BTC/USD`, `BTC-USD`, `BTC_USD`, `EUR.USD`,
 * `BTCUSDT`, `EURUSD=X`); die Ausgabe ist immer das kanonische Format bzw. —
 * über `toVenueNative` — die venue-native Form. Die eigentliche
 * Venue-Strenge liegt im Order-Pfad (`isValidVenueNativeSymbol` verlangt dort
 * die venue-native Form byte-genau).
 *
 * Die Profile besitzen Funktionen — sie werden aber ausschließlich aus
 * deklarativen Daten ({@link VenueProfileSpec}) gebaut, damit ein neuer Broker
 * ohne neuen Code registrierbar ist.
 *
 * Sicherheit: alle Zeichen-Prüfungen laufen über NEGIERTE Zeichenklassen
 * (`/[^A-Z0-9/.]/`), linear und ohne Backtracking — ReDoS-sicher per Konstruktion.
 */

import type { SymbolRejectReason } from "./errors";

/** Anlageklasse des kanonischen Symbols (Ticket-Contract SYM-007). */
export type SymbolAssetClass = "CRYPTO" | "EQUITY" | "ETF" | "FX" | "UNKNOWN";

/**
 * Öffentlicher Contract eines Venue-Profils (Ticket-Vorgabe SYM-007, §3.1):
 *
 * - `allowedChars`: NEGIERTE Zeichenklasse für die venue-NATIVE Form.
 *   `test(s) === true` bedeutet „s enthält ein für diese Venue verbotenes
 *   Zeichen“. Unankert, linear — kein Backtracking.
 * - `maxLength`: harte Obergrenze des bereinigten Symbols (bereinigt = NFKC,
 *   uppercase, ohne Zero-Width-Zeichen).
 * - `canonicalSeparator`: Trenner, mit dem dieses Profil Paare kanonisiert
 *   (alle eingebauten Profile nutzen `/` — das Feld erlaubt venue-spezifische
 *   Ausnahmen ohne Codeänderung).
 * - `aliases`: native Schreibweise → kanonische Schreibweise (z. B. Kraken
 *   `XBT` → `BTC`). Wird in BEIDE Richtungen bijektiv angewendet.
 */
export interface VenueSymbolProfile {
  venue: string;
  /** NEGIERTE Zeichenklasse der nativen Form: true ⟺ verbotenes Zeichen enthalten. */
  allowedChars: RegExp;
  maxLength: number;
  canonicalSeparator: "/" | "" | ".";
  /** Kanonisches Symbol → das, was die Venue-API erwartet. */
  toVenueNative(canonical: string): string;
  /** Venue-native oder historische Schreibweise → kanonisches Symbol. */
  toCanonical(native: string): string;
  aliases?: Record<string, string>;
  /** Mindestlänge des bereinigten Symbols (Default 1; Bitunix verlangt 2). */
  minLength: number;
  /** Trenner der venue-nativen Paar-Schreibweise ("" = konkateniert). */
  nativeSeparator: "/" | "" | "." | "-" | "_";
  /** Quote-Kandidaten für konkatenierte Eingaben, absteigend nach Länge. */
  knownQuotes: readonly string[];
  /** Trenner, die dieses Profil in der Eingabe als Paar-Trenner liest. */
  pairSeparators: readonly string[];
  /** Asset-Class-Fallback für einfache Ticker dieser Venue. */
  singleTickerAssetClass: SymbolAssetClass;
}

/** Deklarative Beschreibung, aus der ein Profil gebaut wird. */
export interface VenueProfileSpec {
  venue: string;
  maxLength: number;
  minLength?: number;
  aliases?: Record<string, string>;
  knownQuotes?: readonly string[];
  /** Trenner der venue-nativen Paar-Schreibweise ("" = konkateniert). */
  nativeSeparator?: "/" | "" | "." | "-" | "_";
  /** Trenner, die in der Eingabe als Paar-Trenner gelesen werden (Default: alle). */
  pairSeparators?: readonly string[];
  /** Zeichen oberhalb von A–Z0–9 in der venue-nativen Form (z. B. `` für Binance). */
  extraAllowedChars?: string;
  /** Asset-Class-Fallback für einfache Ticker (z. B. ALPACA → EQUITY). */
  singleTickerAssetClass?: SymbolAssetClass;
}

/** Maximale Länge eines Symbols im Abfragepfad (Ticket-Vorgabe: z. B. 24). */
export const DEFAULT_MAX_SYMBOL_LENGTH = 24;

/** Erlaubtes Venue-Format (zentral — ersetzt das frühere universe-lokale Muster). */
export const VENUE_RE = /^[A-Z][A-Z0-9_]{1,15}$/;

/** Maximale Länge eines Venue-Namens. */
export const MAX_VENUE_LENGTH = 16;

/**
 * Bekannte Quote-Währungen, absteigend nach Länge (`USDT` vor `USD`), damit
 * `BTCUSDT` eindeutig als BTC/USDT gelöst wird. Deckungsgleich mit der
 * bisherigen Universe-Liste.
 */
export const KNOWN_QUOTES = [
  "USDT",
  "USDC",
  "TUSD",
  "FDUSD",
  "BUSD",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "BTC",
  "ETH",
] as const;

/** Fiat-Codes für die FX-Erkennung (EUR/USD ist FX, BTC/USD ist Krypto). */
export const FIAT_CODES: ReadonlySet<string> = new Set([
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "AUD",
  "CAD",
  "NZD",
  "SEK",
  "NOK",
]);

/** Bekannte Krypto-Basen (Routing/Heuristik — deckungsgleich mit marketData). */
export const CRYPTO_BASES: ReadonlySet<string> = new Set([
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "ADA",
  "DOGE",
  "AVAX",
  "LINK",
  "DOT",
]);

/** Bekannte ETF-Ticker (Heuristik; klein und dokumentiert gehalten). */
export const KNOWN_ETFS: ReadonlySet<string> = new Set(["SPY", "QQQ", "DIA", "IWM", "VTI"]);

/** Yahoo-FX-Suffix (`EURUSD=X`). */
export const FX_SUFFIX = "=X";

/** Quote-Alias für Perpetual-Notationen (`BTC-PERP`/`BTC-SWAP` → Quote USD). */
export const PERP_MARKERS: ReadonlySet<string> = new Set(["PERP", "SWAP"]);

/**
 * Scan-Reihenfolge der Paar-Trenner (legacy-kompatibel): `/` vor `-` vor `_`
 * vor `.`. Profiles können diese Liste einschränken; die eingebauten Profile
 * lesen alle vier (Eingabe liberal, Ausgabe strikt).
 */
const SEPARATOR_SCAN_ORDER = ["/", "-", "_", "."] as const;

/** Ergebnis des Paar-Parsers. */
export type ParsedSymbol =
  | { kind: "pair"; base: string; quote: string; perp: boolean; fxSuffix: boolean }
  | { kind: "single"; ticker: string; classCode: string | null; fxSuffix: boolean };

/** Parse-Fehler mit maschinenlesbarem Grund; wirft nie. */
export type ParseResult =
  | { ok: true; parsed: ParsedSymbol }
  | { ok: false; reason: SymbolRejectReason };

/** Ticker-Prüfung einzelner Segmente (linear, eine Klasse). */
const TICKER_RE = /^[A-Z0-9]{1,12}$/;

/** Alle Trenn-/Suffixzeichen, die NICHT mitten in einem Segment stehen dürfen. */
const RESERVED_CHARS_RE = /[/.\-_=]/;

/** Parser-Eingabeparameter (das Minimum, das der Parser vom Profil braucht). */
export interface ParsePolicy {
  pairSeparators: readonly string[];
  knownQuotes: readonly string[];
  aliases: Record<string, string>;
}

/**
 * Zerlegt ein bereinigtes Symbol (NFKC, uppercase, ohne Zero-Width; Längen-
 * und Zeichensatz-Prüfung hat der Aufrufer bereits gemacht) in seine Teile.
 *
 * Reihenfolge (deckungsgleich mit der bisherigen Universe-Normalisierung):
 *   FX-Suffix (`EURUSD=X`) → expliziter Trenner (`BTC/USD`) → Alias-Präfix
 *   (`XBTUSD`, Kraken) → bekanntes Quote-Suffix (`BTCUSDT`) → einfacher
 *   Ticker (`AAPL`, `BRK.B`).
 *
 * Rote Linie: **nichts wird geraten** — mehrdeutige Eingaben werden mit
 * Grund abgelehnt, niemals repariert.
 */
export function parseSymbolWithPolicy(policy: ParsePolicy, s: string): ParseResult {
  // ── 1) Yahoo-FX-Suffix ─────────────────────────────────────────────────
  if (s.endsWith(FX_SUFFIX)) {
    const core = s.slice(0, -FX_SUFFIX.length);
    if (core.length === 0) return { ok: false, reason: "MALFORMED_FX_SUFFIX" };
    if (!TICKER_RE.test(core)) {
      // Kern mit Trenner (`EUR/USD=X`) oder Sonderzeichen → kein FX-Suffix-Format.
      return { ok: false, reason: "MALFORMED_FX_SUFFIX" };
    }
    if (core.length === 6 && FIAT_CODES.has(core.slice(0, 3)) && FIAT_CODES.has(core.slice(3))) {
      // Fiat/Fiat 3+3 ist die kanonische Yahoo-Form (`EURUSD=X`).
      return {
        ok: true,
        parsed: { kind: "pair", base: core.slice(0, 3), quote: core.slice(3), perp: false, fxSuffix: true },
      };
    }
    // `JPY=X` & Co. / nicht-Fiat-Paare: mehrdeutig — opaker Single-Ticker,
    // unverändert weitergereicht (die Venue entscheidet, nicht wir).
    return { ok: true, parsed: { kind: "single", ticker: core, classCode: null, fxSuffix: true } };
  }

  if (s.includes("=")) return { ok: false, reason: "MALFORMED_FX_SUFFIX" };

  // ── 2) Expliziter Trenner ──────────────────────────────────────────────
  for (const sep of SEPARATOR_SCAN_ORDER) {
    if (!policy.pairSeparators.includes(sep)) continue;
    const idx = s.indexOf(sep);
    if (idx < 0) continue;
    if (idx === 0 || idx === s.length - 1) return { ok: false, reason: "MALFORMED_SYMBOL" };
    const base = s.slice(0, idx);
    const quote = s.slice(idx + 1);
    if (RESERVED_CHARS_RE.test(base) || RESERVED_CHARS_RE.test(quote)) {
      // `BTC/US-D`, `BTC//USD`, `BTC_USD/EUR` — nie raten.
      return { ok: false, reason: "REDUNDANT_SEPARATOR" };
    }
    if (quote.length === 1) {
      // `BRK.B` ist eine Aktienklasse, kein Paar — aber nur mit Punkt.
      if (sep === ".") {
        if (!TICKER_RE.test(base)) return { ok: false, reason: "INVALID_CHARACTERS" };
        return { ok: true, parsed: { kind: "single", ticker: base, classCode: quote, fxSuffix: false } };
      }
      // Yahoo-Aktienklasse mit Dash (`BRK-B`) — absichtlich kein Raten.
      return { ok: false, reason: "MALFORMED_SYMBOL" };
    }
    if (!TICKER_RE.test(base) || !TICKER_RE.test(quote)) {
      return { ok: false, reason: "INVALID_CHARACTERS" };
    }
    if (PERP_MARKERS.has(quote)) {
      // `BTC-PERP`/`BTC-SWAP`: Perp-Marker ist Venue-Metadatum, Quote ist USD.
      return { ok: true, parsed: { kind: "pair", base, quote: "USD", perp: true, fxSuffix: false } };
    }
    return { ok: true, parsed: { kind: "pair", base, quote, perp: false, fxSuffix: false } };
  }

  // ── 3a) Alias-Präfix in konkatenierter Form (Kraken `XBTUSD`) ─────────
  // Alias-Schlüssel sind native Basen; ihr Rest muss eine bekannte Quote sein.
  // Längster Schlüssel zuerst, damit `XBT` vor Teilgreifen Greifen gewinnt.
  const aliasKeys = Object.keys(policy.aliases).sort((a, b) => b.length - a.length);
  for (const key of aliasKeys) {
    if (key.length >= 2 && s.length > key.length + 1 && s.startsWith(key)) {
      const quote = s.slice(key.length);
      if ((policy.knownQuotes.includes(quote) || FIAT_CODES.has(quote)) && TICKER_RE.test(quote)) {
        return { ok: true, parsed: { kind: "pair", base: key, quote, perp: false, fxSuffix: false } };
      }
    }
  }

  // ── 3b) Konkateniert mit bekanntem Quote-Suffix (`BTCUSDT`) ───────────
  for (const q of policy.knownQuotes) {
    // Legacy-Bedingung der Universe-Normalisierung: Basis mindestens 2 Zeichen.
    if (s.length > q.length + 1 && s.endsWith(q)) {
      const base = s.slice(0, -q.length);
      if (!TICKER_RE.test(base)) continue; // nächster Kandidat / einfacher Ticker
      return { ok: true, parsed: { kind: "pair", base, quote: q, perp: false, fxSuffix: false } };
    }
  }

  // ── 4) Einfacher Ticker (`AAPL`, `BTC`) ───────────────────────────────
  if (!TICKER_RE.test(s)) return { ok: false, reason: "INVALID_CHARACTERS" };
  return { ok: true, parsed: { kind: "single", ticker: s, classCode: null, fxSuffix: false } };
}

/** Zerlegt ein Symbol im Venue-Kontext (Komfort-Wrapper über das Profil). */
export function parseVenueSymbol(profile: VenueSymbolProfile, s: string): ParseResult {
  return parseSymbolWithPolicy(
    { pairSeparators: profile.pairSeparators, knownQuotes: profile.knownQuotes, aliases: profile.aliases ?? {} },
    s
  );
}

/** Kanonische Parse-Policy: Paare mit `/`, Punkt-Klassen, FX-Suffix, volle Quotes. */
const CANONICAL_POLICY: ParsePolicy = {
  pairSeparators: ["/", "."],
  knownQuotes: KNOWN_QUOTES,
  aliases: {},
};

/**
 * Zerlegt ein bereits kanonisches Symbol (`BTC/USD`, `BRK.B`, `JPY=X`). Der
 * Kanon-Parser kennt bewusst nur `/` und `.` — kanonische Formen enthalten
 * niemals `-` oder `_`.
 */
export function parseCanonicalSymbol(s: string): ParseResult {
  return parseSymbolWithPolicy(CANONICAL_POLICY, s);
}

/**
 * Rendert ein kanonisch geparstes Symbol zurück in die String-Form
 * (`/`-Paare, Punkt-Klassen, FX-Suffix). Grundlage der Byte-Stabilitäts-
 * Invariante in `normalize.ts`.
 */
export function renderCanonicalParsed(parsed: ParsedSymbol): string {
  return renderParsed(parsed, "/");
}

/** Wendet ein Alias-Wörterbuch an (Basis, Quote, Ganzes) — nie mitten im Token. */
function applyAliases(parsed: ParsedSymbol, map: Record<string, string>): ParsedSymbol {
  const lift = (t: string): string => map[t] ?? t;
  if (parsed.kind === "single") {
    return { ...parsed, ticker: lift(parsed.ticker) };
  }
  return { ...parsed, base: lift(parsed.base), quote: lift(parsed.quote) };
}

/** Baut aus einem geparsten Symbol die String-Form mit dem gewünschten Trenner. */
function renderParsed(parsed: ParsedSymbol, sep: string): string {
  if (parsed.kind === "pair") {
    return `${parsed.base}${sep}${parsed.quote}`;
  }
  const cls = parsed.classCode !== null ? `.${parsed.classCode}` : "";
  const fx = parsed.fxSuffix ? FX_SUFFIX : "";
  return `${parsed.ticker}${cls}${fx}`;
}

/**
 * Baut ein Profil aus deklarativen Daten.
 *
 * - `toCanonical` liest mit der Venue-Policy (liberal) und rendert kanonisch.
 * - `toVenueNative` liest mit der KANONISCHEN Policy (die Eingabe ist per
 *   Contract bereits kanonisch) und rendert venue-nativ.
 * Unparseerbare Eingaben werden unverändert durchgereicht — Aufrufer mit
 * Fehlerbehandlungsbedarf nutzen `normalizeVenueSymbol()` in `normalize.ts`.
 */
export function makeVenueProfile(spec: VenueProfileSpec): VenueSymbolProfile {
  const aliases = spec.aliases ?? {};
  const inverse: Record<string, string> = {};
  for (const [nativeForm, canonicalForm] of Object.entries(aliases)) {
    if (inverse[canonicalForm] !== undefined) {
      throw new Error(`Venue-Aliase für ${spec.venue} müssen bijektiv sein (${canonicalForm} doppelt zugeordnet)`);
    }
    inverse[canonicalForm] = nativeForm;
  }

  const policy: ParsePolicy = {
    pairSeparators: spec.pairSeparators ?? [...SEPARATOR_SCAN_ORDER],
    knownQuotes: spec.knownQuotes ?? KNOWN_QUOTES,
    aliases,
  };

  return {
    venue: spec.venue,
    // NEGIERTE Klasse — linear, ein Durchlauf: verbotenes Zeichen gefunden?
    allowedChars: new RegExp(`[^A-Z0-9${spec.extraAllowedChars ?? ""}]`),
    maxLength: spec.maxLength,
    minLength: spec.minLength ?? 1,
    canonicalSeparator: "/",
    aliases,
    nativeSeparator: spec.nativeSeparator ?? "/",
    knownQuotes: policy.knownQuotes,
    pairSeparators: policy.pairSeparators,
    singleTickerAssetClass: spec.singleTickerAssetClass ?? "UNKNOWN",
    toVenueNative(canonical: string): string {
      const parsed = parseCanonicalSymbol(canonical);
      if (!parsed.ok) return canonical;
      const nativeSep = spec.nativeSeparator ?? "/";
      if (parsed.parsed.kind === "pair" && nativeSep === "") {
        // Konkatenierte native Form (`BTCUSDT`) ist nur VERLUSTFREI darstellbar,
        // wenn die Quote aus der bekannten Menge stammt — sonst ginge die
        // Paar-Grenze verloren (Korruption an der Order-Grenze). Dann bleibt
        // der Trenner stehen; die Venue lehnt notfalls, statt dass wir raten.
        if (!policy.knownQuotes.includes(parsed.parsed.quote) && !FIAT_CODES.has(parsed.parsed.quote)) {
          return canonical;
        }
      }
      return renderParsed(applyAliases(parsed.parsed, inverse), nativeSep);
    },
    toCanonical(native: string): string {
      const parsed = parseSymbolWithPolicy(policy, native);
      if (!parsed.ok) return native;
      return renderParsed(applyAliases(parsed.parsed, aliases), "/");
    },
  };
}

// ── Eingebaute Profile ──────────────────────────────────────────────────────

/**
 * Striktes Default-Profil für Abfragen ohne Venue-Kontext (legacy MarketData-,
 * RuleEngine- und Paper-Pfad) und für unbekannte Venues.
 *
 * Ticket-konform liberal an der Eingabekante (SYM-007 §3.2): alle
 * historischen Schreibweisen werden gelesen (`BTC/USD`, `BTC-USD`, `BTC_USD`,
 * `EUR.USD`, `BTCUSDT`, `EURUSD=X`). `-` als Paar-Trenner ist doppeldeutig-
 * frei, weil Yahoo-Aktienklassen (`BRK-B`) einen 1-Zeichen-Suffix tragen und
 * damit ohnehin als „kein Paar“ erkannt werden — mehrdeutige Reste werden
 * weiterhin abgelehnt, nie geraten.
 */
export const DEFAULT_PROFILE: VenueSymbolProfile = makeVenueProfile({
  venue: "DEFAULT",
  maxLength: DEFAULT_MAX_SYMBOL_LENGTH,
  extraAllowedChars: "/.-_=",
  nativeSeparator: "/",
  singleTickerAssetClass: "UNKNOWN",
});

const profileSpecs: readonly VenueProfileSpec[] = [
  {
    venue: "PAPER",
    maxLength: DEFAULT_MAX_SYMBOL_LENGTH,
    extraAllowedChars: "/.-_=",
    nativeSeparator: "/",
    singleTickerAssetClass: "UNKNOWN",
  },
  {
    venue: "BINANCE",
    maxLength: 24,
    extraAllowedChars: "",
    nativeSeparator: "",
    knownQuotes: KNOWN_QUOTES,
    singleTickerAssetClass: "CRYPTO",
  },
  {
    venue: "KRAKEN",
    maxLength: 24,
    extraAllowedChars: "/.-_=",
    nativeSeparator: "",
    aliases: { XBT: "BTC" },
    knownQuotes: KNOWN_QUOTES,
    singleTickerAssetClass: "CRYPTO",
  },
  {
    venue: "BITUNIX",
    maxLength: 20,
    minLength: 2,
    extraAllowedChars: "",
    nativeSeparator: "",
    knownQuotes: KNOWN_QUOTES,
    singleTickerAssetClass: "CRYPTO",
  },
  {
    venue: "DYDX",
    maxLength: 24,
    extraAllowedChars: "-/",
    nativeSeparator: "-",
    knownQuotes: KNOWN_QUOTES,
    singleTickerAssetClass: "CRYPTO",
  },
  {
    venue: "ALPACA",
    maxLength: 24,
    extraAllowedChars: "/.",
    nativeSeparator: "/",
    knownQuotes: KNOWN_QUOTES,
    singleTickerAssetClass: "EQUITY",
  },
  {
    venue: "IBKR",
    maxLength: 24,
    extraAllowedChars: "/.",
    nativeSeparator: ".",
    knownQuotes: KNOWN_QUOTES,
    singleTickerAssetClass: "EQUITY",
  },
];

const PROFILE_MAP: ReadonlyMap<string, VenueSymbolProfile> = new Map(
  profileSpecs.map((spec) => [spec.venue, makeVenueProfile(spec)])
);

/** Alle eingebauten Venue-Profile (für Docs/Tests, kein Setzen von außen). */
export const VENUE_PROFILES: readonly VenueSymbolProfile[] = [...PROFILE_MAP.values()];

/**
 * Liefert das Profil einer Venue oder `null`, wenn kein spezifisches Profil
 * registriert ist. Wirft nie — der Aufrufer entscheidet (Warnung + Default im
 * Abfragepfad, Fehler im Sync-Pfad).
 */
export function getVenueProfile(venue: string): VenueSymbolProfile | null {
  return PROFILE_MAP.get(venue.trim().toUpperCase()) ?? null;
}

/**
 * Auflösung mit Rückfall: unbekannte Venue → striktes Default-Profil plus
 * Kennzeichnung `usedDefaultProfile: true` (der Aufrufer loggt eine
 * `UnknownVenueProfileWarning`). Venue-Formatfehler → `null`.
 */
export function resolveVenueProfile(
  venue: string
): { profile: VenueSymbolProfile; usedDefaultProfile: boolean; venue: string } | null {
  const v = venue.trim().toUpperCase();
  if (!VENUE_RE.test(v) || v.length > MAX_VENUE_LENGTH) return null;
  const known = PROFILE_MAP.get(v);
  return known
    ? { profile: known, usedDefaultProfile: false, venue: v }
    : { profile: DEFAULT_PROFILE, usedDefaultProfile: true, venue: v };
}

/**
 * Zeichensatz der liberalen Eingabekante (NFKC/uppercase-bereinigt): alles,
 * was historisch irgendeine Venue geschrieben hat. Venue-Strenge liegt im
 * Order-Pfad, nicht hier. NEGIERTE Klasse — linear, ReDoS-sicher.
 */
export const INPUT_DISALLOWED_RE = /[^A-Z0-9/.\-_=]/;

/** true ⟺ das bereinigte Symbol ein an der Eingabekante verbotenes Zeichen enthält. */
export function hasDisallowedInputChar(s: string): boolean {
  return INPUT_DISALLOWED_RE.test(s);
}

/** true ⟺ das bereinigte Symbol ein für die venue-native Form verbotenes Zeichen enthält. */
export function hasDisallowedChar(profile: VenueSymbolProfile, s: string): boolean {
  return profile.allowedChars.test(s);
}
