/**
 * Ausschluss-Policy des Instrument-Universums.
 *
 * Die eingebaute Default-Policy (`DEFAULT_POLICY`) ist die Quelle der Wahrheit
 * und in `src/universe/policy.default.json` als lesbare Vorlage gespiegelt.
 * Über `UNIVERSE_POLICY_FILE=/pfad/zur/policy.json` lässt sich sie ersetzen —
 * die Datei wird beim Laden **validiert** (Anzahl, Länge, erlaubte Felder),
 * damit eine kaputte Konfiguration die Registry nicht sprengt.
 *
 * Sicherheitsnotiz: Regex-Muster stammen aus einer Betreiber-Konfigurationsdatei,
 * nie aus HTTP-Eingaben. Länge und Anzahl sind trotzdem begrenzt (ReDoS-Budget),
 * und die Muster laufen nur gegen bereits validierte, kurze Symbole (≤ 32 Zeichen).
 */

import { readFileSync } from "node:fs";
import type { MarketInstrument } from "./types";

/** Ein einzelnes Ausschlusskriterium. */
export interface PolicyRule {
  /** Stabile Regel-ID, erscheint im Ablehnungsgrund und im Audit-Log. */
  id: string;
  /** Fachliche Begründung (für Doku und Operations Center). */
  reason: string;
  /** Feld, gegen das das Muster läuft. */
  field: "symbol" | "id" | "venue" | "quote" | "base" | "status";
  /** Regulärer Ausdruck (JavaScript-Syntax, ohne Flags). */
  pattern: string;
}

/** Vollständige Policy-Konfiguration. */
export interface UniversePolicy {
  /** Schema-Version der Policy-Datei. */
  version: number;
  /** Freitext-Beschreibung. */
  description: string;
  /** Harte Symbol-Längengrenze (zusätzlich zur Validierung). */
  maxSymbolLength: number;
  /** Ausschlussregeln in Auswertungsreihenfolge. */
  rules: PolicyRule[];
  /** Komplett gesperrte Venues. */
  excludeVenues: string[];
  /** Komplett gesperrte Quote-Währungen. */
  excludeQuotes: string[];
}

/** Maximal erlaubte Anzahl Regeln in einer Policy-Datei. */
export const MAX_POLICY_RULES = 50;
/** Maximal erlaubte Länge eines einzelnen Musters. */
export const MAX_PATTERN_LENGTH = 120;

/** Eingebaute Default-Policy (deckungsgleich mit `policy.default.json`). */
export const DEFAULT_POLICY: UniversePolicy = {
  version: 1,
  description:
    "Ausschlussregeln des Instrument-Universums. Rein deterministisch, ohne Netzwerk. " +
    "Reihenfolge = Auswertungsreihenfolge; die erste greifende Regel entscheidet.",
  maxSymbolLength: 32,
  rules: [
    {
      id: "leveraged-token",
      reason:
        "Gehebelte Token (3L/3S/5L/5S/UP/DOWN/BULL/BEAR) bilden ihren Basiswert wegen " +
        "täglichem Rebalancing nicht linear ab.",
      field: "symbol",
      pattern: "^[A-Z]{2,10}(?:3L|3S|5L|5S|UP|DOWN|BULL|BEAR)(?:USDT|USDC|USD|BUSD)?$",
    },
    {
      id: "test-symbol",
      reason: "Test- und Sandbox-Symbole der Venues gehören nicht ins Handelsuniversum.",
      field: "symbol",
      pattern: "^(?:TEST|DEMO|SANDBOX)[A-Z0-9/._=-]*$",
    },
  ],
  excludeVenues: [],
  excludeQuotes: [],
};

/** Ergebnis einer Policy-Prüfung. */
export interface PolicyDecision {
  /** true, wenn das Instrument NICHT ins Universum darf. */
  excluded: boolean;
  /** ID der greifenden Regel, sonst `null`. */
  ruleId: string | null;
  /** Begründung, sonst `null`. */
  reason: string | null;
}

const ALLOWED_FIELDS = new Set<PolicyRule["field"]>(["symbol", "id", "venue", "quote", "base", "status"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Policy ungültig: ${message}`);
}

/**
 * Validiert eine (fremde) Policy-Struktur und liefert eine bereinigte Kopie.
 *
 * @throws {Error} bei Strukturfehlern, zu vielen/zu langen Mustern oder
 *   nicht kompilierbaren regulären Ausdrücken.
 */
export function validatePolicy(raw: unknown): UniversePolicy {
  assert(typeof raw === "object" && raw !== null && !Array.isArray(raw), "erwartet Objekt");
  const o = raw as Record<string, unknown>;
  const rules = Array.isArray(o.rules) ? o.rules : [];
  assert(rules.length <= MAX_POLICY_RULES, `max. ${MAX_POLICY_RULES} Regeln`);

  const clean: PolicyRule[] = rules.map((r, i) => {
    assert(typeof r === "object" && r !== null, `Regel #${i} ist kein Objekt`);
    const rr = r as Record<string, unknown>;
    assert(typeof rr.id === "string" && rr.id.length > 0 && rr.id.length <= 64, `Regel #${i}: id`);
    assert(typeof rr.pattern === "string" && rr.pattern.length <= MAX_PATTERN_LENGTH, `Regel #${i}: pattern`);
    assert(ALLOWED_FIELDS.has(rr.field as PolicyRule["field"]), `Regel #${i}: field`);
    try {
      new RegExp(rr.pattern as string);
    } catch {
      throw new Error(`Policy ungültig: Regel #${i} enthält kein gültiges Muster`);
    }
    return {
      id: rr.id as string,
      reason: typeof rr.reason === "string" ? rr.reason.slice(0, 400) : "",
      field: rr.field as PolicyRule["field"],
      pattern: rr.pattern as string,
    };
  });

  const maxSymbolLength = Number(o.maxSymbolLength);
  return {
    version: Number.isFinite(Number(o.version)) ? Number(o.version) : 1,
    description: typeof o.description === "string" ? o.description.slice(0, 1000) : "",
    maxSymbolLength: Number.isFinite(maxSymbolLength) ? Math.min(Math.max(maxSymbolLength, 1), 64) : 32,
    rules: clean,
    excludeVenues: toUpperList(o.excludeVenues),
    excludeQuotes: toUpperList(o.excludeQuotes),
  };
}

function toUpperList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string")
    .slice(0, 100)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Lädt die Policy: Datei aus `UNIVERSE_POLICY_FILE`, sonst die eingebaute
 * Default-Policy. Eine unlesbare Datei ist ein harter Fehler — stilles
 * Zurückfallen auf schwächere Regeln wäre eine Sicherheitsfalle.
 */
export function loadPolicy(file = process.env.UNIVERSE_POLICY_FILE): UniversePolicy {
  if (!file) return DEFAULT_POLICY;
  const text = readFileSync(file, "utf8");
  return validatePolicy(JSON.parse(text));
}

/** Kompilierte Policy — Muster werden einmal übersetzt, nicht pro Instrument. */
export class CompiledPolicy {
  private readonly compiled: { rule: PolicyRule; re: RegExp }[];
  /** Die zugrunde liegende Konfiguration (read-only Nutzung). */
  readonly policy: UniversePolicy;

  constructor(policy: UniversePolicy = DEFAULT_POLICY) {
    this.policy = policy;
    this.compiled = policy.rules.map((rule) => ({ rule, re: new RegExp(rule.pattern) }));
  }

  /** Prüft ein normalisiertes Instrument gegen alle Regeln. */
  evaluate(instrument: MarketInstrument): PolicyDecision {
    if (instrument.symbol.length > this.policy.maxSymbolLength) {
      return { excluded: true, ruleId: "max-symbol-length", reason: "Symbol überschreitet die konfigurierte Maximallänge." };
    }
    if (this.policy.excludeVenues.includes(instrument.venue)) {
      return { excluded: true, ruleId: "excluded-venue", reason: "Venue ist per Policy gesperrt." };
    }
    if (this.policy.excludeQuotes.includes(instrument.quote)) {
      return { excluded: true, ruleId: "excluded-quote", reason: "Quote-Währung ist per Policy gesperrt." };
    }
    for (const { rule, re } of this.compiled) {
      const value = instrument[rule.field];
      if (typeof value === "string" && re.test(value)) {
        return { excluded: true, ruleId: rule.id, reason: rule.reason };
      }
    }
    return { excluded: false, ruleId: null, reason: null };
  }
}
