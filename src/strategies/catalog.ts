/**
 * STX-03-02 — Template-Katalog + Registry-Validierung (Phase 3, Paket 03-01).
 *
 * Ein Katalog, der Templates **beim Import prüft**, nicht erst beim Backtest.
 * Der gesamte Sicherheitswert des Projekts hängt daran, dass eine kaputte
 * Strategie **früher** stirbt als eine kaputte Order — deshalb wirft dieses
 * Modul beim Laden, wenn ein Template den Vertrag verletzt
 * (`assertTemplatesValid()` am Dateiende).
 *
 * ── Warum dieser Katalog existiert ─────────────────────────────────────────
 * `src/lib/missionTemplates.ts` zeigt die Repo-Konvention: *„Reine Daten, keine
 * Nebenwirkungen … Kein Drift zwischen Formular, Seed und Doku."* Dieser Katalog
 * ist die **einzige** SSoT der Strategie-Templates: Workshop-UI, CLI und Tests
 * (03-03 … 03-10) lesen ausschließlich hier. Es darf nur **eine** Liste geben —
 * eine zweite würde zwei Wahrheiten darüber erzeugen, welche Strategie existiert.
 *
 * ── Was der Katalog tut und NICHT tut ──────────────────────────────────────
 * Er **validiert**. Er **sanitized nicht** und er **kompiliert nicht**:
 * `buildRule()` liefert bewusst die ROHFORM (`RuleSpecInput`, STX-05); die
 * einzige legale Transformation bleibt `sanitizeRuleSpec()`
 * (`src/lib/ruleEngine.ts`), und ihr einziger Aufrufer ist der Compiler
 * (03-09). Der Katalog prüft deshalb nur, dass ein Builder **innerhalb** der
 * Guardrails bleibt — ein Wert außerhalb `RULE_CEILINGS`, ein `action.side`
 * außerhalb `LONG` oder ein Feld außerhalb `RULE_FIELDS` ist hier bereits ein
 * **Fehler**, nicht etwas, das der Sanitizer später reparieren dürfte. Ohne
 * diese Prüfung wäre ein Template ein stiller Weg um die Klemmung herum.
 *
 * ── Gelesene Vokabulare, keine eigenen (ADR-008 / ADR-009 / STX-01) ─────────
 * | Was | Quelle |
 * |---|---|
 * | Strategieklasse | `STRATEGY_CLASS_KEYS` (`src/lib/signalDecay.ts`) |
 * | Regime | `MarketRegime` (`src/lib/marketRegime.ts`), fünf Werte |
 * | Timeframes | `SUPPORTED_TIMEFRAMES` (`src/lib/marketdata/timeframes.ts`) |
 * | Regel-Felder | `RULE_FIELDS` (`src/lib/ruleFieldCatalog.ts`) |
 * | Risiko-Deckel | `RULE_CEILINGS` (`src/lib/ruleEngine.ts`) — nur gelesen |
 * | Template-Vertrag | `StrategyTemplate` (`src/strategies/types.ts`) |
 *
 * Keine dieser Listen wird hier kopiert, ergänert oder verschmälert — ein
 * zweites Vokabular an dieser Stelle wäre exakt der Drift, den ADR-008 und
 * ADR-009 verbieten (Wächter: `tests/adrVocabulary.test.ts`).
 *
 * ── Fail-closed statt fail-open ────────────────────────────────────────────
 * `validateTemplate()` liefert eine Liste von Fehlern; **leer = gültig**. Jede
 * Prüfung meldet, statt zu reparieren: Es gibt keinen Default, der eine
 * beanstandete Template heimlich geradebiegt. Zwei Canaries am Dateiende
 * halten den Validator selbst ehrlich — er muss den eingebauten Negativfall
 * beanstanden (`__fixtures`) und die gültige Fixture durchlassen. Ein
 * Validator, der alles ablehnt, wäre genauso wertlos wie einer, der alles
 * durchlässt.
 *
 * ── Die Registry, nicht die Templates ──────────────────────────────────────
 * `STRATEGY_TEMPLATES` führt **eine Zeile pro Template-Datei** aus
 * `src/strategies/templates/` — keine Template-Logik in dieser Datei. Seit
 * 03-03 steht dort `ema-adx-trend`, seit 03-04 `macd-momentum`, seit 03-05
 * `rsi-mean-reversion`, seit 03-06 `bollinger-squeeze`; die übrigen zwei
 * folgen in 03-07/03-08. Die IDs
 * stehen seit 03-02 als geschlossene Union fest —
 * `getTemplate()` nimmt ausschließlich sie an, damit ein Tippfehler nicht auf
 * einen stillen Default läuft. Welche Datei eingetragen ist, prüft
 * `tests/strategies.catalog.test.ts` gegen das Verzeichnis: eine fehlende oder
 * eine doppelte Registrierung ist ein Testfehler, keine mündliche Absprache.
 *
 * ── Hinweis für spätere Client-Bundles ─────────────────────────────────────
 * Der Katalog liest `RULE_CEILINGS` aus `src/lib/ruleEngine.ts` — der einzigen
 * Quelle dafür — und zieht damit deren Import-Graph in jeden Konsumenten. Wer
 * die Template-Liste später im Browser braucht (Workshop-UI), projiziert sie
 * serverseitig als DTO (Vorbild: `missionTemplateDto()` in
 * `src/lib/missionTemplates.ts`) statt dieses Modul zu importieren. Ein
 * zweiter, client-tauglicher Deckel-Satz im Template-Modul wäre ein zweites
 * Risiko-Vokabular — und damit ausgeschlossen.
 */

import { RULE_ALLOWED_SIDE, RULE_CEILINGS } from "@/lib/ruleEngine";
import type { RuleField, RuleSpecInput } from "@/lib/ruleEngine";
import { RULE_FIELDS } from "@/lib/ruleFieldCatalog";
import type { MarketRegime } from "@/lib/marketRegime";
import { MARKET_REGIME_SEVERITY } from "@/lib/marketRegime";
import { STRATEGY_CLASS_KEYS } from "@/lib/signalDecay";
import { SUPPORTED_TIMEFRAMES } from "@/lib/marketdata/timeframes";

import { buildEmaAdxTrend } from "./templates/ema-adx-trend";
import { buildMacdMomentum } from "./templates/macd-momentum";
import { buildRsiMeanReversion } from "./templates/rsi-mean-reversion";
import { buildBollingerSqueeze } from "./templates/bollinger-squeeze";

import type { StrategyTemplate } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// 1) IDs — geschlossene Union der geplanten Templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Die sechs geplanten Template-IDs (ADR-008-Tabelle, Phase 3).
 *
 * Reihenfolge = Roadmap-Reihenfolge (03-03 … 03-08). Die Union ist
 * **geschlossen**: Ein siebter Eintrag ist ein neuer Prompt, keine stille
 * Ergänzung dieser Datei. Seit 03-03 sind die ersten IDs nicht mehr nur
 * geplant, sondern eingetragen — `STRATEGY_TEMPLATES` führt sie, validiert
 * beim Import.
 */
export const STRATEGY_TEMPLATE_IDS = [
  "ema-adx-trend",
  "macd-momentum",
  "rsi-mean-reversion",
  "bollinger-squeeze",
  "vwap-pullback",
  "donchian-breakout",
] as const;

/** ID-Typ eines bekannten Templates — Basis von `getTemplate()`. */
export type StrategyTemplateId = (typeof STRATEGY_TEMPLATE_IDS)[number];

/** Schema der Template-IDs (klein, Bindestriche, 3–64 Zeichen). */
export const STRATEGY_TEMPLATE_ID_RE = /^[a-z0-9-]{3,64}$/;

/** true, wenn `value` eine geplante Template-ID ist (Parse-Hilfe für CLI/API). */
export function isStrategyTemplateId(value: unknown): value is StrategyTemplateId {
  return typeof value === "string" && (STRATEGY_TEMPLATE_IDS as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Gelesene Vokabulare als Lookup-Mengen (kein zweites Vokabular)
// ─────────────────────────────────────────────────────────────────────────────

const RULE_FIELD_SET: ReadonlySet<string> = new Set<string>(Object.keys(RULE_FIELDS));
const TIMEFRAME_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_TIMEFRAMES);
const CLASS_KEY_SET: ReadonlySet<string> = new Set<string>(STRATEGY_CLASS_KEYS);

/**
 * Die fünf `MarketRegime`-Werte (ADR-009).
 *
 * Abgeleitet aus `MARKET_REGIME_SEVERITY` — der einzigen typisierten
 * `Record<MarketRegime, …>` des Bestands. Damit steht hier keine zweite
 * Regime-Liste; `UNKNOWN` ist gar nicht erst enthalten, weil es als
 * `MarketRegimeLabel`-Zustand („kein belastbares Datum“) kein Regime ist, in
 * dem man Edge unterstellt.
 */
const MARKET_REGIMES: readonly MarketRegime[] = Object.keys(MARKET_REGIME_SEVERITY) as MarketRegime[];
const REGIME_SET: ReadonlySet<string> = new Set<string>(MARKET_REGIMES);

/** Ein Zahlen-Fenster aus `RULE_CEILINGS` — Tupel `[min, max]` oder Maximalwert. */
interface CeilingBounds {
  min: number;
  max: number;
}

/**
 * Lies eine `RULE_CEILINGS`-Grenze als Fenster.
 *
 * Der Katalog **erweitert** die Deckel nicht, er liest sie: Tupel
 * (`stopLossPct`, `cooldownMinutes`, …) werden als `[min, max]` gelesen, ein
 * skalarer Deckel (`maxConditions`) als `[0, max]`. Ein unbekannter Schlüssel
 * liefert `null` — dann gibt es keine Grenze, also auch keinen Verstoß.
 */
function ceilingOf(key: string): CeilingBounds | null {
  const raw: unknown = (RULE_CEILINGS as Readonly<Record<string, unknown>>)[key];
  if (typeof raw === "number") return Number.isFinite(raw) ? { min: 0, max: raw } : null;
  if (Array.isArray(raw) && raw.length === 2) {
    const [min, max] = raw as [unknown, unknown];
    if (typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max)) {
      return { min, max };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Kleine deterministische Helfer
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Kompakte Typ-Angabe für Fehlermeldungen (nie Rohwerte des Templates). */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  return typeof value;
}

/**
 * Kanonische Serialisierung mit sortierten Schlüsseln.
 *
 * Determinismus-Vergleich für `buildRule`: Zwei Aufrufe müssen **tiefengleich**
 * sein. `JSON.stringify` allein würde die Einfügereihenfolge der Keys als
 * Unterschied melden — ein gleichwertiges, aber anders aufgebautes Objekt wäre
 * dann ein Fehlalarm. Sortierte Keys vergleichen den Inhalt.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

/**
 * Die Default-Werte eines Templates als `Record<string, number>` — exakt die
 * Eingabe, mit der `buildRule()` im Katalog aufgerufen wird (03-09 erlaubt
 * später Abweichungen innerhalb der Parametergrenzen).
 *
 * Gebildet aus den RECORD-Keys (nicht aus `ParamSpec.key`): Ein kaputter Key
 * soll den Aufruf nicht zusätzlich sprengen, sondern über die Param-Prüfung
 * gemeldet werden.
 */
function defaultsOf(template: StrategyTemplate): Record<string, number> {
  const params = isRecord(template.params) ? template.params : {};
  const defaults: Record<string, number> = {};
  for (const [key, spec] of Object.entries(params)) {
    if (isRecord(spec) && typeof spec.default === "number") defaults[key] = spec.default;
  }
  return defaults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) validateTemplate — fail-closed, leere Liste = gültig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prüft ein Template gegen den Vertrag und liefert **alle** Fehler.
 *
 * `[]` bedeutet gültig. Jeder Eintrag nennt das beanstandete Feld; nichts wird
 * repariert, gerundet oder auf einen Default zurückgesetzt.
 *
 * Geprüft wird (Auftrag STX-03-02, Tabelle):
 * ID-Format · Version · Klasse (≠ `unclassified`) · Timeframes (Allowlist,
 * eindeutig) · `requiredFields` (Whitelist) · Params (`min ≤ default ≤ max`,
 * `step > 0`, eindeutiger `key`) · `mapsTo` · Builder (deterministisch,
 * Objekt, Feld-Whitelist, `side`, `RULE_CEILINGS`) · Assumptions (eindeutige
 * ID, nicht leerer `statement`) · `expectedRegimes` (fünf `MarketRegime`).
 *
 * Dazu ergänzende Strukturwächter, die verhindern, dass ein halb gefülltes
 * Template überhaupt bis zu den Fachregeln kommt: fehlende Arrays/Objekte,
 * nicht-endliche Param-Zahlen, ein Builder, der wirft, ein `action`, das kein
 * Objekt ist, sowie eine Bedingungszahl über `RULE_CEILINGS.maxConditions`
 * (der Sanitizer würde sie sonst **still** kappen).
 */
export function validateTemplate(t: StrategyTemplate): string[] {
  if (!isRecord(t)) return ["Template ist kein Objekt."];

  const errors: string[] = [];

  // ── Identität und Version ────────────────────────────────────────────────
  if (typeof t.id !== "string" || !STRATEGY_TEMPLATE_ID_RE.test(t.id)) {
    errors.push(
      `id „${String(t.id).slice(0, 40)}“ verstößt gegen das ID-Format ${STRATEGY_TEMPLATE_ID_RE.source}.`,
    );
  }
  if (typeof t.version !== "number" || !Number.isInteger(t.version) || t.version < 1) {
    errors.push(`version muss eine Ganzzahl ≥ 1 sein (ist ${String(t.version)}).`);
  }

  // ── Klasse (ADR-008): bekannt und ausdrücklich kein „unclassified“ ────────
  if (typeof t.class !== "string" || !CLASS_KEY_SET.has(t.class)) {
    errors.push(
      `class „${String(t.class).slice(0, 40)}“ ist kein Schlüssel aus STRATEGY_CLASS_KEYS (ADR-008).`,
    );
  } else if (t.class === "unclassified") {
    errors.push(
      "class „unclassified“ ist für ein versioniertes Template ein Fehler (ADR-008): " +
        "die Klasse ist eine Fachaussage, kein Voreinstellung — ohne sie verliert das Template " +
        "im Regime-Gate und in der Decay-Policy still seine Schutzlogik.",
    );
  }

  // ── Timeframes (STX-01): Allowlist, nicht leer, eindeutig ────────────────
  const timeframes: unknown = t.supportedTimeframes;
  if (!Array.isArray(timeframes) || timeframes.length === 0) {
    errors.push("supportedTimeframes darf nicht leer sein.");
  } else {
    const seen = new Set<string>();
    for (const tf of timeframes) {
      if (typeof tf !== "string" || !TIMEFRAME_SET.has(tf)) {
        errors.push(`supportedTimeframes enthält „${String(tf)}“ — kein Wert aus SUPPORTED_TIMEFRAMES.`);
        continue;
      }
      if (seen.has(tf)) errors.push(`supportedTimeframes enthält „${tf}“ doppelt.`);
      seen.add(tf);
    }
  }

  // ── requiredFields: jedes Feld in der Whitelist ──────────────────────────
  const requiredFields: unknown = t.requiredFields;
  if (!Array.isArray(requiredFields)) {
    errors.push("requiredFields muss ein Array sein.");
  } else {
    for (const field of requiredFields) {
      if (typeof field !== "string" || !RULE_FIELD_SET.has(field)) {
        errors.push(`requiredFields enthält „${String(field).slice(0, 40)}“ — kein Feld aus RULE_FIELDS.`);
      }
    }
  }

  // ── Params: Grenzen, Schritt, Eindeutigkeit, mapsTo ──────────────────────
  const params: unknown = t.params;
  if (!isRecord(params)) {
    errors.push("params muss ein Objekt aus ParamSpec sein.");
  } else {
    const seenKeys = new Set<string>();
    for (const [recordKey, spec] of Object.entries(params)) {
      const label = `params.${recordKey}`;
      if (!isRecord(spec)) {
        errors.push(`${label} ist kein ParamSpec-Objekt (ist ${describeValue(spec)}).`);
        continue;
      }
      if (typeof spec.key !== "string" || spec.key.length === 0) {
        errors.push(`${label}: key fehlt oder ist leer.`);
      } else {
        if (seenKeys.has(spec.key)) errors.push(`${label}: key „${spec.key}“ ist nicht eindeutig.`);
        seenKeys.add(spec.key);
      }
      const min: unknown = spec.min;
      const max: unknown = spec.max;
      const dflt: unknown = spec.default;
      const step: unknown = spec.step;
      for (const [name, value] of [
        ["min", min],
        ["max", max],
        ["default", dflt],
        ["step", step],
      ] as const) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors.push(`${label}: ${name} muss eine endliche Zahl sein (ist ${String(value)}).`);
        }
      }
      if (typeof min === "number" && Number.isFinite(min) && typeof dflt === "number" && Number.isFinite(dflt) && min > dflt) {
        errors.push(`${label}: min (${min}) muss ≤ default (${dflt}) sein.`);
      }
      if (typeof dflt === "number" && Number.isFinite(dflt) && typeof max === "number" && Number.isFinite(max) && dflt > max) {
        errors.push(`${label}: default (${dflt}) muss ≤ max (${max}) sein.`);
      }
      if (typeof step === "number" && Number.isFinite(step) && step <= 0) {
        errors.push(`${label}: step muss > 0 sein (ist ${step}).`);
      }
      if (typeof spec.mapsTo !== "string" || !RULE_FIELD_SET.has(spec.mapsTo)) {
        errors.push(
          `${label}: mapsTo „${String(spec.mapsTo).slice(0, 40)}“ ist kein Feld aus RULE_FIELDS.`,
        );
      }
    }
  }

  // ── Builder: reine Funktion der Parameter, innerhalb der Guardrails ──────
  validateBuilder(t, defaultsOf(t), errors);

  // ── Assumptions: eindeutige ID, nicht leerer Statement ───────────────────
  const assumptions: unknown = t.assumptions;
  if (!Array.isArray(assumptions)) {
    errors.push("assumptions muss ein Array sein.");
  } else {
    const seen = new Set<string>();
    for (const assumption of assumptions) {
      if (!isRecord(assumption)) {
        errors.push(`assumptions enthält einen Eintrag, der kein Objekt ist (ist ${describeValue(assumption)}).`);
        continue;
      }
      const id = typeof assumption.id === "string" ? assumption.id : "";
      if (seen.has(id)) errors.push(`assumptions: id „${id}“ ist nicht eindeutig.`);
      seen.add(id);
      if (typeof assumption.statement !== "string" || assumption.statement.trim().length === 0) {
        errors.push(`assumptions: statement der Annahme „${id}“ ist leer.`);
      }
    }
  }

  // ── expectedRegimes: genau die fünf MarketRegime-Werte (ADR-009) ─────────
  const regimes: unknown = t.expectedRegimes;
  if (!Array.isArray(regimes)) {
    errors.push("expectedRegimes muss ein Array sein.");
  } else {
    for (const regime of regimes) {
      if (typeof regime !== "string" || !REGIME_SET.has(regime)) {
        errors.push(
          `expectedRegimes enthält „${String(regime).slice(0, 40)}“ — kein MarketRegime ` +
            `(ADR-009: genau ${MARKET_REGIMES.join(", ")}, ohne UNKNOWN).`,
        );
      }
    }
  }

  return errors;
}

/**
 * Prüft den Template-Builder.
 *
 * Der Builder ist eine **reine Funktion der Parameter** (STX-05): kein `ctx`,
 * kein Marktdatenzugriff, kein Zufall. Der Katalog ruft ihn deshalb mit den
 * Defaults auf und verlangt (a) zweimal dasselbe Ergebnis, (b) ein Objekt,
 * (c) nur Felder aus `RULE_FIELDS`, (d) `action.side` ausschließlich `LONG`
 * und (e) keinen Zahlenwert außerhalb `RULE_CEILINGS`. Ein Verstoß ist ein
 * Bug im Template — nicht etwas, das `sanitizeRuleSpec()` später verdecken
 * dürfte (03-09 bleibt trotzdem Pflicht: der Katalog sanitized nichts).
 */
function validateBuilder(template: StrategyTemplate, defaults: Record<string, number>, errors: string[]): void {
  if (typeof template.buildRule !== "function") {
    errors.push("buildRule ist keine Funktion.");
    return;
  }

  let first: unknown;
  let second: unknown;
  try {
    first = template.buildRule(defaults);
    second = template.buildRule(defaults);
  } catch (err) {
    errors.push(`buildRule(defaults) wirft: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!isRecord(first)) {
    errors.push(`buildRule(defaults) liefert kein Objekt (ist ${describeValue(first)}).`);
    return;
  }
  if (stableStringify(first) !== stableStringify(second)) {
    errors.push(
      "buildRule ist nicht deterministisch: zwei Aufrufe mit denselben Defaults liefern verschiedene Regeln.",
    );
  }

  // ── Bedingungen: jedes Feld gegen die Whitelist ──────────────────────────
  const condition = isRecord(first.condition) ? first.condition : null;
  const items: unknown = condition ? condition.conditions : undefined;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push("buildRule(defaults) erzeugt keine Bedingung — sanitizeRuleSpec würde die Regel verwerfen.");
  } else {
    items.forEach((item: unknown, index: number) => {
      if (!isRecord(item)) {
        errors.push(`condition.conditions[${index}] ist kein Objekt (ist ${describeValue(item)}).`);
        return;
      }
      const field = typeof item.field === "string" ? item.field : "";
      if (!RULE_FIELD_SET.has(field)) {
        errors.push(
          `condition.conditions[${index}] nutzt „${String(item.field).slice(0, 40)}“ — kein Feld aus RULE_FIELDS.`,
        );
      }
    });
    // Der Sanitizer kappt ab maxConditions **still** — ein Template, das mehr
    // liefert, hätte eine Regel, die nicht das tut, was im Code steht.
    if (items.length > RULE_CEILINGS.maxConditions) {
      errors.push(
        `buildRule(defaults) erzeugt ${items.length} Bedingungen — mehr als RULE_CEILINGS.maxConditions (${RULE_CEILINGS.maxConditions}); der Sanitizer würde den Rest still verwerfen.`,
      );
    }
  }

  // ── Action: nur LONG, und action selbst ein Objekt ───────────────────────
  const action: unknown = first.action;
  if (action !== undefined && !isRecord(action)) {
    errors.push(`action ist kein Objekt (ist ${describeValue(action)}).`);
  } else if (isRecord(action) && "side" in action && action.side !== RULE_ALLOWED_SIDE) {
    errors.push(
      `action.side „${String(action.side).slice(0, 20)}“ ist nicht erlaubt — nur ${RULE_ALLOWED_SIDE} ` +
        "(Shorts sind im Code global gesperrt; ein Template darf das nicht ändern).",
    );
  }

  // ── Zahlenwerte gegen RULE_CEILINGS (nur gelesen, nie erweitert) ─────────
  const violations: string[] = [];
  collectCeilingViolations(first, "", violations);
  errors.push(...violations);
}

/**
 * Sammelt jeden Zahlenwert, dessen Schlüssel eine `RULE_CEILINGS`-Grenze hat
 * und außerhalb davon liegt (`action.stopLossPct = 999`, `window.
 * cooldownMinutes = 9999`, …). Rekursiv über die gesamte Builder-Rückgabe,
 * damit auch künftig verschachtelte Stellen geprüft werden.
 */
function collectCeilingViolations(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectCeilingViolations(entry, `${path}[${index}].`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "number") {
      const bounds = ceilingOf(key);
      if (!bounds) continue;
      if (!Number.isFinite(child)) {
        out.push(`${path}${key} ist kein endlicher Zahlenwert (${String(child)}).`);
        continue;
      }
      if (child < bounds.min || child > bounds.max) {
        out.push(
          `${path}${key} = ${child} liegt außerhalb von RULE_CEILINGS [${bounds.min}, ${bounds.max}] — ` +
            "der Wert wäre nur über die Klemmung des Sanitizers „sicher“, nie über den Template-Code.",
        );
      }
      continue;
    }
    collectCeilingViolations(child, `${path}${key}.`, out);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Der Katalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Der Katalog: **eine Zeile pro Template-Datei** unter
 * `src/strategies/templates/`. Bewusst leer in 03-02, seit 03-03 mit dem
 * ersten Eintrag (`ema-adx-trend`), seit 03-04 mit dem zweiten
 * (`macd-momentum`) und seit 03-05 mit dem dritten (`rsi-mean-reversion` —
 * die erste Klasse `mean-reversion`, also das erste Artefakt, das im
 * Regime-Gate tatsächlich gedämpft wird). Seit 03-06 folgt der vierte Eintrag
 * (`bollinger-squeeze`, Klasse `breakout`, erstes Template mit `bbZScore` aus
 * 02-02); die übrigen zwei Templates folgen in 03-07/03-08 und tragen dort
 * ihre Klasse aus der ADR-008-Tabelle.
 *
 * Die Einträge sind hier **Konstruktionen, keine Literale**: Jede Datei liefert
 * ein `build<Name>()`, das das Artefakt frisch zusammensetzt. Ein Export des
 * fertigen Objekts statt einer Factory würde einen modulweiten, mutierbaren
 * Zustand teilen — dieser Katalog wird validiert, verglichen und später
 * gehasht (04-01), und eine versehentliche Mutation durch einen Konsumenten
 * wäre ein Drift, den keine Prüfung mehr sieht.
 *
 * Jeder Eintrag durchläuft beim Import `validateTemplate()`; ein ungültiger
 * Eintrag lässt den Prozess nicht starten (`assertTemplatesValid()`).
 */
export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  buildEmaAdxTrend(),
  buildMacdMomentum(),
  buildRsiMeanReversion(),
  buildBollingerSqueeze(),
];

/** ID → Template. Unbekannte IDs liefern `null` — nie einen stillen Default. */
const TEMPLATE_MAP: ReadonlyMap<string, StrategyTemplate> = new Map(
  STRATEGY_TEMPLATES.map((t) => [t.id, t]),
);

// ─────────────────────────────────────────────────────────────────────────────
// 6) Lese-Helfer (Workshop-UI, CLI, Tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liefert ein Template oder `null` — unbekannte IDs werden nie erfunden und
 * geplante, aber noch nicht gebaute (03-07/03-08) ebenso wenig: `null` ist
 * hier „gibt es noch nicht“, niemals ein Default.
 */
export function getTemplate(id: StrategyTemplateId): StrategyTemplate | null {
  return TEMPLATE_MAP.get(id) ?? null;
}

/** Alle Templates in Katalog-Reihenfolge. */
export function listTemplates(): readonly StrategyTemplate[] {
  return STRATEGY_TEMPLATES;
}

/**
 * Alle Templates, die ein Regel-Feld auswerten — beantwortet später die Frage
 * „welche Templates nutzen `bbwPct`?“ (Screening, Doku, Workshop-Filter).
 */
export function templateByField(field: RuleField): readonly StrategyTemplate[] {
  return STRATEGY_TEMPLATES.filter((t) => t.requiredFields.includes(field));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7) Import-Zeit-Prüfung
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wirft, wenn ein Template den Vertrag verletzt.
 *
 * Wird beim Modul-Import aufgerufen (Dateiende) — das ist der Punkt: Ein
 * kaputtes Template darf den Prozess **nicht** starten. Die optionale
 * Parameter-Liste erlaubt derselben Prüfung für einen *Kandidaten*, bevor er
 * in den Katalog aufgenommen wird (Tests, CLI-Vorschau); ohne Argument gilt
 * sie für `STRATEGY_TEMPLATES`.
 *
 * Geprüft wird zusätzlich die Eindeutigkeit der IDs: Der Katalog ist eine
 * Registry, zwei Einträge mit derselben ID wären zwei Wahrheiten über eine
 * Strategie.
 */
export function assertTemplatesValid(templates: readonly StrategyTemplate[] = STRATEGY_TEMPLATES): void {
  const problems: string[] = [];
  const seenIds = new Set<string>();

  templates.forEach((template, index) => {
    const id = isRecord(template) && typeof template.id === "string" ? template.id : `#${index}`;
    for (const error of validateTemplate(template)) problems.push(`${id}: ${error}`);
    if (seenIds.has(id)) problems.push(`${id}: Template-ID ist im Katalog nicht eindeutig.`);
    seenIds.add(id);
  });

  if (problems.length > 0) {
    throw new Error(
      `Strategie-Templates ungültig (${problems.length} ${problems.length === 1 ? "Fehler" : "Fehler"}): ` +
        problems.join(" | "),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8) Fixtures — Negativfall für den Validator (nicht exportiert)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eingebaute Testfixtures. **Nicht exportiert:** Sie gehören zum
 * Selbsttest des Katalogs, nicht zu seinem Vertrag. `brokenTemplate()` ist der
 * absichtlich kaputte Fall, an dem `validateTemplate()` im Test etwas zu
 * beanstanden hat — und an dem die Import-Zeit-Canary misst, ob der Validator
 * überhaupt noch beanstandet.
 */
const __fixtures = {
  /**
   * Minimal gültiges Template. Dient als Canary-Gegenpol: Lehnt
   * `validateTemplate()` DIESES ab, ist der Validator überstreng und würde
   * später jedes echte Template blockieren.
   */
  validTemplate(): StrategyTemplate {
    return {
      id: "fixture-valid",
      name: "Fixture: gültiges Template",
      description:
        "Canary-Basis des Katalogs — kein handelbares Template, sondern der Nachweis, " +
        "dass validateTemplate() einen vertragstreuen Entwurf durchlässt.",
      version: 1,
      class: "trend",
      scope: "SINGLE_SYMBOL",
      supportedTimeframes: ["1h", "4h"],
      requiredFields: ["ema9", "ema21"],
      params: {
        fast: {
          key: "fast",
          kind: "period",
          label: "schnelle EMA",
          unit: "Bars",
          default: 9,
          min: 3,
          max: 30,
          step: 1,
          mapsTo: "ema9",
        },
        slow: {
          key: "slow",
          kind: "period",
          label: "langsame EMA",
          unit: "Bars",
          default: 21,
          min: 10,
          max: 60,
          step: 1,
          mapsTo: "ema21",
        },
      },
      buildRule: (params): RuleSpecInput => ({
        name: "fixture-trend",
        symbol: "BTC",
        rationale: "Canary-Fixture: reine Funktion der Parameter.",
        condition: {
          logic: "all",
          conditions: [
            { field: "ema9", op: "gt", value: params.fast },
            { field: "ema21", op: "lt", value: params.slow },
          ],
        },
        action: {
          side: "LONG",
          stopLossPct: 5,
          takeProfitRR: 1.5,
          riskBudgetPct: 0.01,
          maxPositionPct: 0.2,
          positionSizeMode: "risk",
        },
        window: {
          timeframe: "1h",
          validFrom: null,
          validUntil: null,
          maxExecutionsPerDay: 3,
          cooldownMinutes: 60,
          volumeWindow: 20,
        },
      }),
      assumptions: [
        {
          id: "fixture-trend-haelt",
          statement: "Trendphasen sind häufiger als Seitwärtsphasen.",
          category: "MARKET",
          critical: true,
        },
      ],
      expectedRegimes: ["TREND_UP", "TREND_DOWN"],
    };
  },

  /**
   * Absichtlich kaputt — jeder Verstoß entspricht einer Zeile der
   * Prüftabelle aus STX-03-02. Die Canary verlangt mindestens einen Treffer;
   * geliefert werden hier sieben.
   */
  brokenTemplate(): StrategyTemplate {
    // Rohobjekt mit Cast: Die Fixture verstößt ABSICHTLICH gegen die
    // Typ-Ebene (Timeframe-Allowlist, RULE_FIELDS, MarketRegime, Seite) — genau
    // diese Verstöße soll der Laufzeit-Validator finden. Ein typkorrektes
    // Objekt könnte sie gar nicht ausdrücken; der Cast ist hier das Feature.
    return {
      ...__fixtures.validTemplate(),
      id: "Fixture_kaputt", // ID-Format
      version: 0, // Ganzzahl ≥ 1
      class: "unclassified", // ADR-008
      supportedTimeframes: ["1h", "7d"], // Allowlist
      requiredFields: ["ema9", "nichtImKatalog"], // Whitelist
      params: {
        fast: {
          ...__fixtures.validTemplate().params.fast,
          default: 99, // > max
          mapsTo: "gibtEsNicht", // mapsTo
        },
      },
      buildRule: (): RuleSpecInput => ({
        name: "fixture-broken",
        symbol: "BTC",
        condition: {
          logic: "all",
          conditions: [{ field: "erfundenesFeld", op: "gt", value: 1 }],
        },
        action: {
          side: "SHORT", // nur LONG
          stopLossPct: 999, // RULE_CEILINGS
          takeProfitRR: 1.5,
          riskBudgetPct: 0.01,
          maxPositionPct: 0.2,
          positionSizeMode: "risk",
        },
        window: {
          timeframe: "1h",
          validFrom: null,
          validUntil: null,
          maxExecutionsPerDay: 3,
          cooldownMinutes: 60,
          volumeWindow: 20,
        },
      }),
      assumptions: [
        { id: "doppelt", statement: "erste Annahme", category: "MARKET", critical: false },
        { id: "doppelt", statement: "  ", category: "MARKET", critical: false },
      ],
      expectedRegimes: ["UNKNOWN", "BULL"], // ADR-009
    } as unknown as StrategyTemplate;
  },
};

/**
 * Import-Zeit-Canary: Der Validator muss beide Fixtures richtig einordnen.
 *
 * Ohne diese Prüfung könnte `validateTemplate()` unbemerkt fail-open werden
 * (z. B. durch einen Tippfehler in einer Bedingung) — und ein kaputtes Template
 * würde weiterhin als „gültig“ dastehen. Canary 1 verlangt, dass der
 * Negativfall beanstandet wird; Canary 2, dass die gültige Fixture
 * durchkommt. Beide würfen beim Import, nicht erst im Test.
 */
function assertValidatorCalibrated(): void {
  const broken = validateTemplate(__fixtures.brokenTemplate());
  if (broken.length === 0) {
    throw new Error(
      "Strategie-Katalog: validateTemplate() beanstandet den eingebauten Negativfall nicht — " +
        "der Validator ist fail-open und würde jedes künftige Template durchlassen.",
    );
  }
  const valid = validateTemplate(__fixtures.validTemplate());
  if (valid.length > 0) {
    throw new Error(
      `Strategie-Katalog: validateTemplate() lehnt die gültige Fixture ab (${valid.join(" | ")}) — ` +
        "der Validator ist überstreng.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9) Import-Zeit-Aufruf — ein kaputtes Template startet den Prozess nicht
// ─────────────────────────────────────────────────────────────────────────────

assertValidatorCalibrated();
assertTemplatesValid();
