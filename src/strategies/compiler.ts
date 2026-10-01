/**
 * STX-03-09 — Compiler: `Template + Params → RuleSpec` (Phase 3, Finding STX-05).
 *
 * Diese Datei ist der **einzige** Aufrufer von `buildRule()` und damit der
 * sicherheitskritische Übergang: Sie beweist, dass die Kette
 *
 *   `Template → buildRule(params) → sanitizeRuleSpec() → persistierbarer RuleSpec`
 *
 * geschlossen ist. Ein Template-Pfad, der `sanitizeRuleSpec()` umgeht, würde das
 * Sicherheitsmodell aus `src/lib/ruleEngine.ts` („Code entscheidet“) wertlos
 * machen; deshalb hat dieses Modul **keine** Rückfallroute: Jede `RuleSpec`, die
 * hier zurückkommt, ist das Ergebnis von `sanitizeRuleSpec()` — unbekannte
 * Felder, fremde Operatoren, `SHORT` und Werte außerhalb `RULE_CEILINGS` können
 * über den Template-Weg nicht entstehen. Ein Sanitize-Fehler ist `{ok:false}`,
 * niemals die Rohform.
 *
 * ── Die Reihenfolge ist Teil des Vertrags ──────────────────────────────────
 * `compileTemplate()` arbeitet exakt die Schritte 1–10 des Prompts ab und
 * fasst **keinen** zusammen: unbekanntes Template · `unclassified` ablehnen
 * (ADR-008) · Timeframe gegen `supportedTimeframes` · Parametervalidierung
 * (Defaults im Raster, unbekannte Keys, fehlende ⇒ Default) · `buildRule` im
 * `try` · Builder-Ausgabe erneut prüfen (Whitelist, Side, Pflichtfelder) ·
 * Aufrufer-Werte einsetzen (`symbol`, `timeframe`) · **`sanitizeRuleSpec()`** ·
 * `sourceRole` (nie `MANUAL`) · `ruleWithinRuntimeLimits()`.
 *
 * ── Warum `symbol`/`timeframe` vom Aufrufer kommen ─────────────────────────
 * Der Builder ist eine reine Funktion der Parameter und kennt weder Instrument
 * noch Ausführungstakt. `buildRule` liefert deshalb nur seine fachliche
 * Vorlage; das Symbol setzt der Compiler aus der Eingabe ein (nie aus dem
 * Template), den Timeframe aus der ebenfalls geprüften Aufrufer-Wahl. Beides
 * geht anschließend durch denselben Sanitizer — es gibt keinen zweiten Pfad.
 *
 * ── ADR-008: genau eine Klassenquelle ──────────────────────────────────────
 * `strategyClass` ist **immer** `template.class`. Kein Aufrufer-Parameter,
 * kein Namensmuster, kein zweites Vokabular: Die Klasse ist eine Eigenschaft des
 * versionierten Artefakts und wandert von dort in Backtest-/Decay-Kontext und
 * in Screening-/Report-Typen. `unclassified` wird hier — wie im Katalog — zur
 * Laufzeit abgelehnt.
 *
 * ── Klemm-Differenz (`clamped`) ────────────────────────────────────────────
 * `sanitizeRuleSpec()` klemmt still; wer nur den Spec ansieht, erkennt nicht,
 * ob ein Template „lief“ oder nur „geradegebogen“ wurde. Der Compiler vergleicht
 * deshalb die Rohwerte der `RULE_CEILINGS`-behafteten Felder mit dem
 * geklemmten Ergebnis und meldet jede Abweichung als lesbaren Eintrag
 * („Feld, roher Wert, geklemmter Wert“). 03-10 und 06-01 sehen daran, ob ein
 * Template dauerhaft klemmt — ein solches Template ist kaputt, nicht sicher.
 *
 * ── Laufzeit-Limits sind Warnungen, keine Compile-Fehler ──────────────────
 * `ruleWithinRuntimeLimits()` liest die **dynamischen** Limits
 * (`getLimits()` = Basis-Limit × Marktfaktoren, `riskGuard.ts`). Sie dürfen das
 * Ergebnis nicht bestimmen: Derselbe Input müsste sonst je nach Marktlage
 * kompilieren oder nicht — der Fingerprint (Idempotenz 04-02, Cache 05-04)
 * wäre nicht mehr prozessstabil. Die Einhaltung wird deshalb als `warnings`
 * ausgewiesen und im Ausführungspfad erzwungen (`riskGateRule` im Makro-Zyklus,
 * Sizing/`validateOrder` bei der Order). `ok:true` heißt also: sicher geklemmt
 * und statisch zulässig — nicht: „passt gerade in die aktuelle Marktlage“.
 *
 * ── Determinismus und Abhängigkeiten ──────────────────────────────────────
 * Kein `Date.now()`, kein Zufall, keine Objekt-Reihenfolge: der Fingerprint
 * entsteht über `canonicalJson()` (sortierte Keys) aus
 * `{ templateId, version, params, timeframe, symbol, codeVersion }`, exakt nach
 * dem Muster von `strategyLifecycle/evidence.ts`. Dieses Modul schreibt nichts
 * in die DB und macht keine Netzwerk-IO; der Import von `ruleService.ts` ist
 * wegen dessen Lazy-DB (v1.5.2) ohne `DATABASE_URL` unschädlich.
 *
 * ── Test-Naht (`deps`) ─────────────────────────────────────────────────────
 * Der Sicherheitsbeweis braucht zwei Dinge, die ein Produktivpfad nicht
 * anbieten darf: einen Spy auf `sanitizeRuleSpec()` („wurde überhaupt
 * sanitized?“) und Fixture-Templates mit absichtlich kaputten Buildern
 * (`as any`). Beides läuft über den optionalen zweiten Parameter von
 * `compileTemplate()`. Der Produktivpfad nutzt die Defaults (Katalog +
 * `sanitizeRuleSpec`), und `strategyClass` bleibt auch mit Fixtures
 * ausschließlich `template.class`.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "@/strategyLifecycle/evidence";
import {
  RULE_ALLOWED_SIDE,
  RULE_CEILINGS,
  RULE_FIELDS,
  sanitizeRuleSpec,
} from "@/lib/ruleEngine";
import type { RuleField, RuleSpec, RuleSpecInput } from "@/lib/ruleEngine";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { StrategyClassKey } from "@/lib/signalDecay";
import { ruleWithinRuntimeLimits } from "@/lib/ruleService";
import { APP_VERSION } from "@/lib/version";

import { getTemplate, isStrategyTemplateId, listTemplates } from "./catalog";
import type { StrategyTemplate } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Typen
// ─────────────────────────────────────────────────────────────────────────────

/** Eingabe des Compilers: Template-ID, Instrument, Takt und optional Parameter. */
export interface CompileTemplateInput {
  /** ID aus dem Katalog (`STRATEGY_TEMPLATE_IDS`); unbekannt ⇒ `{ok:false}`. */
  templateId: string;
  /** Symbol des Aufrufers — wird NIE aus dem Template übernommen. */
  symbol: string;
  /** Muss in `template.supportedTimeframes` liegen. */
  timeframe: SupportedTimeframe;
  /** Fehlende Keys werden durch `ParamSpec.default` ersetzt; unbekannte Keys sind Fehler. */
  params?: Readonly<Record<string, number>>;
  /**
   * Code-Version im Fingerprint. Default `APP_VERSION` (`src/lib/version.ts`).
   * Injizierbar, damit Tests den „andere Version ⇒ anderer Fingerprint“-Fall
   * prüfen können, ohne das Modul zu patchen.
   */
  codeVersion?: string;
}

/** Nur für Tests/Beweisführung — der Produktivpfad nutzt die Defaults. */
export interface CompileDeps {
  /** Auflösung Template-ID → Artefakt (Default: Katalog, unbekannt ⇒ `null`). */
  resolveTemplate?: (templateId: string) => StrategyTemplate | null;
  /** Spy-Naht für den Pflichtnachweis „sanitizeRuleSpec wurde aufgerufen“. */
  sanitizeRuleSpec?: typeof sanitizeRuleSpec;
}

/**
 * Ergebnis des Compilers. `{ok:false}` liefert **Fehlerstrings**, wirft nie.
 *
 * `clamped` steht auf beiden Zweigen, damit auch ein fehlgeschlagener Lauf
 * sichtbar macht, ob geklemmt wurde. `warnings` gibt es nur zusammen mit einem
 * Spec — es sind die dynamischen Laufzeit-Limits (siehe Modulkopf).
 */
export type CompileResult =
  | {
      ok: true;
      spec: RuleSpec;
      strategyClass: StrategyClassKey;
      fingerprint: string;
      clamped: string[];
      warnings: string[];
    }
  | { ok: false; errors: string[]; clamped: string[] };

/** Ein Eintrag der flachen `exportTemplates()`-Liste (Template × Timeframe). */
export interface ExportedTemplateCompile {
  templateId: string;
  timeframe: SupportedTimeframe;
  result: CompileResult;
}

/** Bestandteile des Fingerprints — exakt die Liste aus STX-03-09. */
export interface StrategyFingerprintParts {
  templateId: string;
  version: number;
  params: Readonly<Record<string, number>>;
  timeframe: string;
  symbol: string;
  codeVersion: string;
}

/**
 * Symbol der Export-/Rollout-Probe. Bewusst konstant und ein neutrales
 * Instrument: Der Helper kompiliert Artefakte, er handelt nicht.
 */
export const EXPORT_PROBE_SYMBOL = "BTC/USDT";

// ─────────────────────────────────────────────────────────────────────────────
// Kleine Helfer
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  return typeof value;
}

function resolveFromCatalog(templateId: string): StrategyTemplate | null {
  // Tippfehler und erfundene IDs laufen nie auf einen stillen Default.
  return isStrategyTemplateId(templateId) ? getTemplate(templateId) : null;
}

/**
 * Die Default-Parameter eines Templates als `Record<string, number>` — die
 * Referenz, mit der die Dokumentationsfelder des Katalogs bestimmt werden.
 */
function defaultParamsOf(template: StrategyTemplate): Record<string, number> {
  const out: Record<string, number> = {};
  const params: unknown = template.params;
  if (!isRecord(params)) return out;
  for (const [key, spec] of Object.entries(params)) {
    if (isRecord(spec) && typeof spec.default === "number" && Number.isFinite(spec.default)) {
      out[key] = spec.default;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter-Validierung (Schritt 4)
// ─────────────────────────────────────────────────────────────────────────────

/** Liegt `value` auf dem durch `min`/`step` definierten Raster? */
function onStepGrid(value: number, min: number, step: number): boolean {
  if (!(step > 0)) return true;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) <= 1e-9;
}

/**
 * Baut das vollständige Parameter-Objekt: fehlende Keys ⇒ `default`,
 * unbekannte Keys ⇒ Fehler, Werte außerhalb `[min,max]` oder neben dem
 * `step`-Raster ⇒ Fehler. Auch die **Defaults selbst** werden gegen ihr Raster
 * geprüft — ein kaputtes Raster ist ein Template-Fehler, kein Compile-Detail.
 */
function resolveParams(
  template: StrategyTemplate,
  provided: unknown,
  errors: string[]
): Record<string, number> {
  const out: Record<string, number> = {};
  const params: unknown = template.params;
  if (!isRecord(params)) {
    errors.push(`${template.id}: params ist kein Objekt aus ParamSpec.`);
    return out;
  }
  if (provided !== undefined && !isRecord(provided)) {
    errors.push(`params muss ein Objekt aus Zahlen sein (ist ${describeValue(provided)}).`);
    return out;
  }
  const given: Record<string, unknown> = isRecord(provided) ? provided : {};

  for (const key of Object.keys(given)) {
    if (!hasOwn(params, key)) {
      errors.push(`unbekannter Parameter „${key}“ — nicht im Raster von ${template.id}.`);
    }
  }

  for (const [key, rawSpec] of Object.entries(params)) {
    if (!isRecord(rawSpec)) {
      errors.push(`params.${key} ist kein ParamSpec-Objekt (ist ${describeValue(rawSpec)}).`);
      continue;
    }
    const min = rawSpec.min;
    const max = rawSpec.max;
    const fallback = rawSpec.default;
    const step = rawSpec.step;
    if (typeof min !== "number" || typeof max !== "number" || typeof fallback !== "number") {
      errors.push(`params.${key}: min/max/default müssen endliche Zahlen sein.`);
      continue;
    }
    if (!(Number.isFinite(min) && Number.isFinite(max) && Number.isFinite(fallback)) || min > max) {
      errors.push(`params.${key}: Raster [${String(min)}, ${String(max)}] ist ungültig.`);
      continue;
    }
    if (fallback < min || fallback > max) {
      errors.push(
        `params.${key}.default ${fallback} liegt außerhalb des Rasters [${min}, ${max}] (Template-Fehler).`
      );
      continue;
    }
    if (typeof step === "number" && !onStepGrid(fallback, min, step)) {
      errors.push(
        `params.${key}.default ${fallback} liegt nicht auf dem step-Raster (min ${min}, step ${step}).`
      );
      continue;
    }

    const value = hasOwn(given, key) ? given[key] : fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`Parameter „${key}“ ist keine endliche Zahl (ist ${describeValue(value)}).`);
      continue;
    }
    if (value < min || value > max) {
      errors.push(`Parameter „${key}“ = ${value} liegt außerhalb des Rasters [${min}, ${max}].`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pflichtfeld-Deckung (Schritt 6) + Dokumentationsfelder des Katalogs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * „Dokumentationsfelder“ des Katalogs: Felder, die in irgendeinem Template unter
 * `requiredFields` stehen, aber von **keinem** Template als Bedingung gefiltert
 * werden. Im Bestand ist das genau `atrPct` (nullable; Stop/Ziel skaliert damit,
 * eine Bedingung darauf würde fail-closed blockieren). Bewusst abgeleitet statt
 * hartcodiert: Sobald ein Template `atrPct` tatsächlich filtert, fällt die
 * Ausnahme weg und die Prüfung wird strenger.
 */
let documentaryFieldsCache: ReadonlySet<string> | null = null;

function catalogDocumentaryFields(): ReadonlySet<string> {
  if (documentaryFieldsCache) return documentaryFieldsCache;
  const declared = new Set<string>();
  const filtered = new Set<string>();
  for (const template of listTemplates()) {
    for (const field of template.requiredFields) declared.add(field);
    let built: unknown;
    try {
      built = template.buildRule(defaultParamsOf(template));
    } catch {
      continue;
    }
    for (const item of conditionItemsOf(built)) {
      if (typeof item.field === "string") filtered.add(item.field);
    }
  }
  documentaryFieldsCache = new Set([...declared].filter((field) => !filtered.has(field)));
  return documentaryFieldsCache;
}

function conditionItemsOf(rule: unknown): Array<Record<string, unknown>> {
  if (!isRecord(rule)) return [];
  const condition: unknown = rule.condition;
  if (!isRecord(condition)) return [];
  const items: unknown = condition.conditions;
  if (!Array.isArray(items)) return [];
  return items.filter(isRecord);
}

/**
 * Pflichtfelder, die die Regel nicht auswertet. `atrPct`-artige
 * Dokumentationsfelder sind ausgenommen (siehe oben) — alle anderen
 * `requiredFields` müssen als Bedingungsfeld vorkommen; sonst hat der Builder
 * ein Feld verloren, das zum Artefakt gehört.
 */
function missingRequiredFields(
  template: StrategyTemplate,
  rule: unknown,
  documentary: ReadonlySet<string>
): RuleField[] {
  const used = new Set<string>();
  for (const item of conditionItemsOf(rule)) {
    if (typeof item.field === "string") used.add(item.field.toLowerCase());
  }
  return template.requiredFields.filter(
    (field) => !used.has(field.toLowerCase()) && !documentary.has(field)
  );
}

/**
 * Schritt 6: prüft die **Builder-Ausgabe** erneut — Feld-Whitelist,
 * `action.side`, Bedingungszahl (`maxConditions`; der Sanitizer würde sonst
 * still kappen) und Pflichtfeld-Deckung.
 *
 * Zahlen werden hier **nicht** gegen `RULE_CEILINGS` abgewiesen: genau dafür
 * ist Schritt 8 da. Ein Wert außerhalb der Deckel muss den Sanitizer sehen und
 * als `clamped` sichtbar werden, statt den Compile-Lauf zu verhindern — sonst
 * gäbe es keinen Nachweis der Klemmung. Operatoren prüft ausschließlich
 * `sanitizeRuleSpec()` (eine Validierungsquelle, kein zweites Vokabular).
 */
function checkBuiltRule(
  template: StrategyTemplate,
  built: unknown,
  documentary: ReadonlySet<string>
): string[] {
  const errors: string[] = [];
  if (!isRecord(built)) {
    return [`buildRule(${template.id}) liefert kein Objekt (ist ${describeValue(built)}).`];
  }

  const items = conditionItemsOf(built);
  if (items.length === 0) {
    errors.push(
      `requiredFields-Prüfung: buildRule(${template.id}) erzeugt keine Bedingung — ` +
        "sanitizeRuleSpec() würde die Regel verwerfen."
    );
  }
  if (items.length > RULE_CEILINGS.maxConditions) {
    errors.push(
      `buildRule(${template.id}) erzeugt ${items.length} Bedingungen — mehr als ` +
        `RULE_CEILINGS.maxConditions (${RULE_CEILINGS.maxConditions}); der Sanitizer würde den Rest still verwerfen.`
    );
  }
  items.forEach((item, index) => {
    const field = item.field;
    if (typeof field !== "string" || !hasOwn(RULE_FIELDS, field)) {
      errors.push(
        `condition.conditions[${index}] nutzt „${String(field).slice(0, 40)}“ — kein Feld aus RULE_FIELDS.`
      );
    }
  });

  const action: unknown = built.action;
  if (action !== undefined && !isRecord(action)) {
    errors.push(`action ist kein Objekt (ist ${describeValue(action)}).`);
  } else if (isRecord(action) && "side" in action && action.side !== RULE_ALLOWED_SIDE) {
    errors.push(
      `action.side „${String(action.side).slice(0, 20)}“ ist nicht erlaubt — nur ${RULE_ALLOWED_SIDE} ` +
        "(Shorts sind im Code global gesperrt)."
    );
  }

  const missing = missingRequiredFields(template, built, documentary);
  if (missing.length > 0) {
    errors.push(
      `requiredFields-Prüfung: ${template.id} muss ${missing.join(", ")} auswerten — ` +
        "die gebaute Regel nutzt diese Pflichtfelder nicht (Builder außerhalb der Template-Bounds)."
    );
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Klemm-Differenz (Punkt 2 des Auftrags)
// ─────────────────────────────────────────────────────────────────────────────

interface ClampTarget {
  path: readonly string[];
  bounds: readonly [number, number];
}

/**
 * Felder, die `sanitizeRuleSpec()` gegen einen Deckel klemmt. `riskScore` hat
 * keinen `RULE_CEILINGS`-Eintrag, wird aber vom Sanitizer auf `[0,1]`
 * begrenzt — dieselbe Sichtbarkeitspflicht.
 */
const CLAMP_TARGETS: readonly ClampTarget[] = [
  { path: ["action", "stopLossPct"], bounds: RULE_CEILINGS.stopLossPct },
  { path: ["action", "takeProfitRR"], bounds: RULE_CEILINGS.takeProfitRR },
  { path: ["action", "riskBudgetPct"], bounds: RULE_CEILINGS.riskBudgetPct },
  { path: ["action", "maxPositionPct"], bounds: RULE_CEILINGS.maxPositionPct },
  { path: ["window", "maxExecutionsPerDay"], bounds: RULE_CEILINGS.maxExecutionsPerDay },
  { path: ["window", "cooldownMinutes"], bounds: RULE_CEILINGS.cooldownMinutes },
  { path: ["window", "volumeWindow"], bounds: RULE_CEILINGS.volumeWindow },
  { path: ["riskScore"], bounds: [0, 1] },
];

function readPath(source: unknown, path: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  return JSON.stringify(value) ?? String(value);
}

/**
 * Vergleicht die Rohform mit dem Sanitize-Ergebnis und meldet jedes Feld, das
 * nur wegen der Klemmung „lief“: `action.stopLossPct: 999 → 20`.
 * Fehlende Nullen/Einheiten werden bewusst nicht gemeldet — gerundet wird
 * immer, geklemmt nur außerhalb der Deckel.
 */
function detectClamps(raw: RuleSpecInput, spec: RuleSpec): string[] {
  const out: string[] = [];
  for (const target of CLAMP_TARGETS) {
    const before = readPath(raw, target.path);
    if (before === undefined) continue; // Default greift — keine Klemmung.
    const isFiniteNumber = typeof before === "number" && Number.isFinite(before);
    if (isFiniteNumber && before >= target.bounds[0] && before <= target.bounds[1]) continue;
    const after = readPath(spec, target.path);
    out.push(`${target.path.join(".")}: ${formatValue(before)} → ${formatValue(after)}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fingerprint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fingerprint `stc1:<sha256>` über die kanonisch serialisierten Bestandteile.
 *
 * Muster ist `strategyLifecycle/evidence.ts` (`canonicalJson`,
 * `evidenceContentHash`): sortierte Keys, stabil über Prozessgrenzen — der
 * Schlüssel für Idempotenz (04-02) und Cache (05-04). Parameter-Reihenfolge in
 * `params` ist egal, Inhalt und `codeVersion` nicht.
 */
export function strategyFingerprint(parts: StrategyFingerprintParts): string {
  const canonical = canonicalJson({
    templateId: parts.templateId,
    version: parts.version,
    params: parts.params,
    timeframe: parts.timeframe,
    symbol: parts.symbol,
    codeVersion: parts.codeVersion,
  });
  return `stc1:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compiler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sourceRole` aus der Builder-Ausgabe: Templates sind **nie** `MANUAL`.
 * Ein ausdrücklich anderes Rollen-Votum (`CEO`) bleibt erhalten, alles andere
 * fällt auf `RESEARCH` — die Rolle wird über `forceSourceRole` gesetzt, ein
 * Rohwert kann sie nicht bestimmen.
 */
function requestedSourceRole(value: unknown): RuleSpec["sourceRole"] {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  return normalized === "CEO" || normalized === "RESEARCH" ? normalized : "RESEARCH";
}

function failure(errors: string[], clamped: string[]): CompileResult {
  return { ok: false, errors, clamped };
}

/**
 * Kompiliert `Template + Params + symbol/timeframe` zu einem normalisierten
 * `RuleSpec`. Die Schritte 1–10 laufen in fester Reihenfolge; Fehler werden
 * gesammelt und als Strings zurückgegeben — diese Funktion wirft nicht.
 */
export function compileTemplate(input: CompileTemplateInput, deps: CompileDeps = {}): CompileResult {
  const resolveTemplate = deps.resolveTemplate ?? resolveFromCatalog;
  const sanitize = deps.sanitizeRuleSpec ?? sanitizeRuleSpec;
  const clamped: string[] = [];
  const errors: string[] = [];

  // 1) Template auflösen — unbekannte IDs sind ein Fehler, kein Default.
  const templateId = typeof input?.templateId === "string" ? input.templateId : "";
  const template = resolveTemplate(templateId);
  if (!template) {
    return failure([`Unbekanntes Template „${templateId.slice(0, 64)}“ — nicht im Katalog.`], clamped);
  }

  // 2) ADR-008: `unclassified` ist eine fehlende Fachaussage, kein Wert.
  if (template.class === "unclassified") {
    return failure(
      [
        `Template ${template.id} ist „unclassified“ — ADR-008 verlangt eine Klasse ` +
          "(mean-reversion | trend | breakout) für jedes versionierte Artefakt.",
      ],
      clamped
    );
  }

  // 3) Timeframe muss zum Artefakt gehören (kein stiller Fallback).
  const timeframe = input?.timeframe;
  if (!template.supportedTimeframes.includes(timeframe)) {
    return failure(
      [
        `Timeframe „${String(timeframe)}“ wird von ${template.id} nicht unterstützt ` +
          `(erlaubt: ${template.supportedTimeframes.join(", ")}).`,
      ],
      clamped
    );
  }

  // 4) Parameter: fehlende ⇒ Default, unbekannte/ungültige ⇒ Fehler.
  const params = resolveParams(template, input?.params, errors);
  if (errors.length > 0) return failure(errors, clamped);

  // 5) buildRule — pure Funktion der Parameter; Fehler werden zu `{ok:false}`.
  let built: unknown;
  try {
    built = template.buildRule(params);
  } catch (err) {
    return failure(
      [`buildRule(${template.id}) wirft: ${err instanceof Error ? err.message : String(err)}`],
      clamped
    );
  }
  if (!isRecord(built)) {
    return failure(
      [`buildRule(${template.id}) liefert kein Objekt (ist ${describeValue(built)}).`],
      clamped
    );
  }

  // 6) Builder-Ausgabe erneut prüfen (Whitelist, Side, Pflichtfelder).
  const documentary = catalogDocumentaryFields();
  errors.push(...checkBuiltRule(template, built, documentary));
  if (errors.length > 0) return failure(errors, clamped);

  // 7) Aufrufer-Werte einsetzen: Symbol und Takt kommen NIE aus dem Template.
  const raw: RuleSpecInput = {
    ...built,
    symbol: input.symbol,
    window: {
      ...(isRecord(built.window) ? built.window : {}),
      timeframe,
    },
  };

  // 8) sanitizeRuleSpec() — der Pflichtschritt. Kein Fallback auf `raw`.
  const sanitized = sanitize(raw, requestedSourceRole(built.sourceRole), { forceSourceRole: true });
  if (!sanitized.ok) return failure(sanitized.errors, clamped);
  const spec: RuleSpec = sanitized.spec;

  // 8b) Deckungsprüfung erneut auf dem SANITIZED Spec: Der Sanitizer darf eine
  //     Bedingung verworfen haben (dann wäre er ohnehin `{ok:false}`) — diese
  //     Invariante hält zusätzlich fest, dass kein Pflichtfeld „verloren“ geht.
  const stillMissing = missingRequiredFields(template, spec, documentary);
  if (stillMissing.length > 0) {
    return failure(
      [
        `requiredFields-Prüfung nach sanitizeRuleSpec(): ${stillMissing.join(", ")} fehlt im ` +
          `normalisierten Spec von ${template.id}.`,
      ],
      clamped
    );
  }

  // 9) sourceRole ist über `forceSourceRole` bereits gesetzt: `RESEARCH`
  //    (oder ein ausdrückliches CEO-Votum des Artefakts) — nie `MANUAL`.
  if (spec.sourceRole === "MANUAL") {
    // Kann durch den erzwungenen Kanal nicht eintreten; fail-closed, falls ein
    // künftiger Sanitizer-Vertrag sich ändert.
    return failure([`sourceRole „MANUAL“ ist für Templates gesperrt (${template.id}).`], clamped);
  }

  clamped.push(...detectClamps(raw, spec));

  // 10) Dynamische Laufzeit-Limits: prüfen und melden, nicht blockieren.
  const warnings = ruleWithinRuntimeLimits(spec);

  const fingerprint = strategyFingerprint({
    templateId: template.id,
    version: template.version,
    params,
    timeframe: spec.window.timeframe,
    symbol: spec.symbol,
    codeVersion: input.codeVersion ?? APP_VERSION,
  });

  return { ok: true, spec, strategyClass: template.class, fingerprint, clamped, warnings };
}

/**
 * Testhelper/Rollout: kompiliert **alle** Katalog-Templates mit Default-Params
 * über **alle** `supportedTimeframes` und liefert die flache Liste
 * (Template × Takt). Bewusst ohne DB, ohne Netz und ohne Mutation — der Helper
 * ist der Nachweis, dass der Katalog vollständig durch den Sicherheitspfad
 * läuft (jedes `result.ok` mit leerem `clamped`).
 */
export function exportTemplates(symbol: string = EXPORT_PROBE_SYMBOL): ExportedTemplateCompile[] {
  const out: ExportedTemplateCompile[] = [];
  for (const template of listTemplates()) {
    for (const timeframe of template.supportedTimeframes) {
      out.push({
        templateId: template.id,
        timeframe,
        result: compileTemplate({ templateId: template.id, symbol, timeframe }),
      });
    }
  }
  return out;
}
