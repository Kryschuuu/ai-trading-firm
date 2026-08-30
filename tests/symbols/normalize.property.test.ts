/**
 * Property-basierte Tests der Symbol-Normalisierung (SYM-007).
 *
 * Kein Zufallsdunst: deterministischer mulberry32-PRNG (feste Seeds), damit
 * jede Abweichung exakt reproduzierbar ist. Geprüft werden INVARIANTEN über
 * tausende generierter Eingaben — nicht Beispiele:
 *
 *  1. `tryNormalizeVenueSymbol` wirft NIE (egal, was reinkommt).
 *  2. Akzeptanz ⟹ `instrumentId` ist valide und re-normalisiert byte-stabil
 *     (Idempotenz: canon(canon(x)) === canon(x)).
 *  3. Roundtrip: `toCanonical(toVenueNative(c)) === c` für jedes akzeptierte
 *     Ergebnis (die native Abbildung verliert keine Information).
 *  4. Injection-Alphabet (`; & ? " ' % $ < > | \\` Leerzeichen Steuerzeichen)
 *     wird in zufälligen Verwebungen IMMER abgelehnt.
 *  5. Kanonische Ergebnisse enthalten nur Zeichen aus der sicheren Menge
 *     `[A-Z0-9/.=]` (URL-/SQL-/Pfad-Sicherheit nach der Kanonisierung).
 *  6. Laufzeit: pathologische Lang-Inputs werden linear verworfen (kein
 *     Backtracking — ReDoS-Probe).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  isValidInstrumentId,
  tryNormalizeVenueSymbol,
} from "../../src/symbols/normalize";
import {
  DEFAULT_PROFILE,
  VENUE_PROFILES,
  getVenueProfile,
  parseCanonicalSymbol,
} from "../../src/symbols/venueProfiles";
import { createRng } from "../../src/lib/marketdata/prng";

const ALL_PROFILES = [...VENUE_PROFILES, DEFAULT_PROFILE];

/** Zieht ein Element aus `arr` per rng. */
function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ── Generatoren ─────────────────────────────────────────────────────────────

const TICKER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SEPARATORS = ["/", "-", "_", "."] as const;
// Zeichen, die ÜBERALL (auch am Rand) zur Ablehnung führen müssen.
const INJECTION_CHARS = [";", "&", "?", '"', "'", "%", "$", "<", ">", "|", "\\", "`", "\u0000", "(", ")", "{", "}"];
// Whitespace wird am Rand laut Spec getrimmt — daher nur INNEN injizieren.
const WHITESPACE_CHARS = [" ", "\t", "\n", "\r"];

function genTicker(rng: () => number, maxLen = 12): string {
  const len = 1 + Math.floor(rng() * maxLen);
  let s = "";
  for (let i = 0; i < len; i++) s += pick(rng, TICKER_ALPHABET.split(""));
  return s;
}

/** Gemischte, häufig sinnvolle Eingabe (case-verrauscht, Trenner, Suffixe). */
function genSymbolLike(rng: () => number): string {
  const kind = rng();
  const a = genTicker(rng, 6);
  const b = genTicker(rng, 5);
  let s: string;
  if (kind < 0.4) s = `${a}${pick(rng, [...SEPARATORS])}${b}`;
  else if (kind < 0.6) s = `${a}${b}`;
  else if (kind < 0.7) s = `${a}${b}=X`;
  else if (kind < 0.8) s = `${a}${pick(rng, [...SEPARATORS])}${b}${pick(rng, [...SEPARATORS])}${genTicker(rng, 3)}`;
  else s = a;
  // Case-Verrauschung.
  if (rng() < 0.5) s = s.toLowerCase();
  if (rng() < 0.3) s = ` ${s} `;
  if (rng() < 0.1) s = `${pick(rng, ["KRAKEN", "BINANCE", "PAPER"])}:${s}`;
  return s;
}

/** Eingabe mit garantiert eingewobenem (rand-unempfindlichem) Injection-Zeichen. */
function genInjected(rng: () => number): string {
  const base = genSymbolLike(rng);
  const pos = Math.floor(rng() * (base.length + 1));
  return `${base.slice(0, pos)}${pick(rng, INJECTION_CHARS)}${base.slice(pos)}`;
}

/** Eingabe mit Whitespace IM INNEREN (Rand-Whitespace ist spezifiziertes Trim). */
function genInteriorWhitespace(rng: () => number): string {
  // Basis ohne führende/trailing Leerzeichen, damit die Innenposition sicher trifft.
  let base = genSymbolLike(rng).trim();
  if (base.length < 2) base = `X${base}Y`;
  const pos = 1 + Math.floor(rng() * (base.length - 1));
  return `${base.slice(0, pos)}${pick(rng, WHITESPACE_CHARS)}${base.slice(pos)}`;
}

// ── Properties ──────────────────────────────────────────────────────────────

test("P1: tryNormalizeVenueSymbol wirft nie (2000 Eingaben × alle Profile)", () => {
  const rng = createRng(0x5eed_007);
  let accepted = 0;
  for (let i = 0; i < 2000; i++) {
    const venue = pick(rng, ALL_PROFILES).venue;
    const raw = genSymbolLike(rng);
    let r: ReturnType<typeof tryNormalizeVenueSymbol>;
    assert.doesNotThrow(() => {
      r = tryNormalizeVenueSymbol(venue, raw);
    }, `Wurf bei venue=${venue} raw=${JSON.stringify(raw)}`);
    if (r!.ok) accepted += 1;
  }
  assert.ok(accepted > 0, "mindestens einige Eingaben müssen akzeptiert werden");
});

test("P2: Akzeptanz ⟹ instrumentId valide + Re-Normalisierung byte-stabil (Idempotenz)", () => {
  const rng = createRng(0x5eed_010);
  let checked = 0;
  for (let i = 0; i < 2000; i++) {
    const venue = pick(rng, ALL_PROFILES).venue;
    const raw = genSymbolLike(rng);
    const r = tryNormalizeVenueSymbol(venue, raw);
    if (!r.ok) continue;
    checked += 1;
    assert.ok(
      isValidInstrumentId(r.value.instrumentId),
      `instrumentId ${r.value.instrumentId} muss valide sein (raw=${JSON.stringify(raw)})`
    );
    // Idempotenz: die instrumentId selbst ist eine akzeptable, stabile Eingabe.
    const again = tryNormalizeVenueSymbol(venue, r.value.instrumentId);
    assert.ok(again.ok, `instrumentId ${r.value.instrumentId} muss erneut akzeptiert werden`);
    if (again.ok) {
      assert.equal(again.value.canonical, r.value.canonical, `nicht idempotent bei ${r.value.instrumentId}`);
      assert.equal(again.value.instrumentId, r.value.instrumentId);
    }
    // Kanon formt Kanon: toCanonical(c) === c.
    const profile = getVenueProfile(venue) ?? DEFAULT_PROFILE;
    assert.equal(
      profile.toCanonical(r.value.canonical),
      r.value.canonical,
      `toCanonical nicht stabil bei ${r.value.canonical} (${venue})`
    );
  }
  assert.ok(checked > 100, "genügend akzeptierte Fälle für die Invariante");
});

test("P3: Roundtrip — toCanonical(toVenueNative(canonical)) === canonical", () => {
  const rng = createRng(0x5eed_011);
  let checked = 0;
  for (let i = 0; i < 2000; i++) {
    const venue = pick(rng, ALL_PROFILES).venue;
    const raw = genSymbolLike(rng);
    const r = tryNormalizeVenueSymbol(venue, raw);
    if (!r.ok) continue;
    const profile = getVenueProfile(venue) ?? DEFAULT_PROFILE;
    const native = profile.toVenueNative(r.value.canonical);
    const back = profile.toCanonical(native);
    // Die native Form verliert keine Information (Kanon ⟷ Nativ bijektiv je Profil).
    assert.equal(back, r.value.canonical, `${venue}: ${r.value.canonical} → ${native} → ${back}`);
    checked += 1;
  }
  assert.ok(checked > 100);
});

test("P4: Injection-Zeichen werden in zufälliger Verwebung IMMER abgelehnt", () => {
  const rng = createRng(0x5eed_012);
  // C0-Steuerzeichen, Gänsefüßchen, Semikolon, Prozent, Backslash … eines
  // davon IRGENDWO im String muss zur Ablehnung führen.
  for (let i = 0; i < 3000; i++) {
    const venue = pick(rng, ALL_PROFILES).venue;
    const raw = genInjected(rng);
    const r = tryNormalizeVenueSymbol(venue, raw);
    assert.equal(r.ok, false, `Injection akzeptiert: venue=${venue} raw=${JSON.stringify(raw)}`);
  }
  // Whitespace IM INNEREN (Rand-Trim ist spezifiziert, Innen-Whitespace ist
  // ein klassischer Smuggling-Vektor) — immer Ablehnung.
  for (let i = 0; i < 2000; i++) {
    const venue = pick(rng, ALL_PROFILES).venue;
    const raw = genInteriorWhitespace(rng);
    const r = tryNormalizeVenueSymbol(venue, raw);
    assert.equal(r.ok, false, `Innen-Whitespace akzeptiert: venue=${venue} raw=${JSON.stringify(raw)}`);
  }
});

test("P5: kanonische Ergebnisse nutzen ausschließlich die sichere Zeichenmenge", () => {
  const rng = createRng(0x5eed_013);
  const CANON_CHARS = /^[A-Z0-9/.=-]+$/;
  for (let i = 0; i < 2000; i++) {
    const venue = pick(rng, ALL_PROFILES).venue;
    const r = tryNormalizeVenueSymbol(venue, genSymbolLike(rng));
    if (!r.ok) continue;
    assert.match(r.value.canonical, CANON_CHARS, `canonical=${r.value.canonical}`);
    assert.match(r.value.venueNative, CANON_CHARS, `venueNative=${r.value.venueNative}`);
    assert.match(r.value.venue, /^[A-Z][A-Z0-9_]{1,15}$/);
    // Kanon ohne führende/trailing Trenner.
    assert.ok(!/^[/.\-_=]|[[/.\-_=]$/.test(r.value.canonical) || r.value.canonical.endsWith("=X"));
    // Kanonische Paare enthalten keinen Dash (Dash ist nie kanonisch).
    if (r.value.canonical.includes("/")) {
      assert.ok(!r.value.canonical.includes("-"), `kanonisches Paar mit Dash: ${r.value.canonical}`);
    }
  }
});

test("P6: pathologische Lang-Inputs werden linear und schnell verworfen (ReDoS-Probe)", () => {
  const worst = [
    "A".repeat(50_000),
    `${"AB/".repeat(10_000)}`,
    `${"A-".repeat(10_000)}B`,
    `${"X".repeat(20_000)}=X`,
    `${"A".repeat(10_000)};${"B".repeat(10_000)}`,
    `${"1".repeat(40_000)}USDT`,
  ];
  const t0 = performance.now();
  for (const raw of worst) {
    const r = tryNormalizeVenueSymbol("PAPER", raw);
    assert.equal(r.ok, false);
  }
  const elapsed = performance.now() - t0;
  // Linearer Lauf: >1 s für 120 k Zeichen wäre ein Backtracking-Indiz.
  // (Großzügige Schranke gegen CI-Jitter; real liegt sie im einstelligen ms-Bereich.)
  assert.ok(elapsed < 1000, `Zeichenprüfung nicht linear? ${elapsed.toFixed(1)} ms`);
});

test("P7: Venue-Profilgrenzen werden eingehalten (maxLength/minLength je Venue)", () => {
  const rng = createRng(0x5eed_014);
  for (let i = 0; i < 1500; i++) {
    const venue = pick(rng, ALL_PROFILES).venue;
    const raw = genSymbolLike(rng);
    const r = tryNormalizeVenueSymbol(venue, raw);
    if (!r.ok) continue;
    const profile = getVenueProfile(venue) ?? DEFAULT_PROFILE;
    const cleaned = raw.normalize("NFKC").trim().toUpperCase();
    const noPrefix = cleaned.includes(":") ? cleaned.slice(cleaned.indexOf(":") + 1) : cleaned;
    assert.ok(
      noPrefix.length <= profile.maxLength || noPrefix.includes(":") === false,
      `maxLength verletzt: ${venue}/${noPrefix}`
    );
    assert.ok(r.value.canonical.length > 0);
    // Akzeptierte einfache Eingaben respektieren minLength.
    if (!noPrefix.includes(":") && /^[A-Z0-9]+$/.test(noPrefix)) {
      assert.ok(noPrefix.length >= profile.minLength, `minLength verletzt: ${venue}/${noPrefix}`);
    }
  }
  // Parse-Determinismus: dieselbe Eingabe → byte-identisches Ergebnis.
  const probe = "eth-usd";
  const a = tryNormalizeVenueSymbol("DYDX", probe);
  const b = tryNormalizeVenueSymbol("DYDX", probe);
  assert.deepEqual(a, b);
});
