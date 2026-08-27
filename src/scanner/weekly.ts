/**
 * Weekly Universe Review — **deterministischer Teil** (Task 04).
 *
 * Aus einem Scan-Ergebnis plus dem Stand der Vorwoche entsteht je Instrument
 * eine Klassifikation:
 *
 * | Klasse | Bedeutung | Bedingung (Defaults) |
 * | --- | --- | --- |
 * | `CORE` | Dauerhaftes Kernuniversum | Score ≥ 70, Volumen ≥ 50 Mio., bereits letzte Woche im Universum, Regime ≠ EXTREME, keine harte Verschlechterung |
 * | `ROTATION` | Regelmäßig gehandelt, aber nicht gesetzt | Score ≥ 55 |
 * | `DISCOVERY` | Beobachtung: neu, jung oder noch zu schwach | Neulisting bzw. Score ≥ 40 |
 * | `EXCLUDED` | Nicht handelbar / durchgefallen | Eignungsfilter gerissen, Delisting, Broker weg, Score < 40 |
 *
 * Eingehende Änderungssignale: neue Listings, Delistings, Liquiditätsrückgang,
 * Gebührenerhöhung, Broker-Verfügbarkeit, Regimewechsel sowie
 * Korrelations-/Volatilitätscluster. Jede Klassifikation trägt ihre Gründe.
 *
 * **Nicht Teil dieses Tasks:** die LLM-Synthese der Weekly-Reviews. Hier
 * entsteht ausschließlich validiertes JSON.
 */

import type { ScannerConfig } from "./config";
import type { FilterRejection } from "./filters";
import type { ScanResult } from "./pipeline";
import { roundTo } from "./math";
import type { InstrumentScore, VolatilityRegime } from "./types";
import type { MarketInstrument } from "@/universe/types";

/** Die vier Universe-Klassen. */
export type UniverseClass = "CORE" | "ROTATION" | "DISCOVERY" | "EXCLUDED";

/** Alle Klassen in kanonischer Reihenfolge. */
export const UNIVERSE_CLASSES: readonly UniverseClass[] = ["CORE", "ROTATION", "DISCOVERY", "EXCLUDED"];

/** Maximale Anzahl Gründe je Eintrag (Payload-Grenze). */
export const MAX_REASONS = 20;
/** Maximale Länge eines einzelnen Grundes. */
export const MAX_REASON_LENGTH = 200;

/** Ein klassifiziertes Instrument — exakt der geforderte JSON-Contract. */
export interface WeeklyClassificationEntry {
  /** Kanonische Instrument-ID. */
  instrumentId: string;
  /** Zugewiesene Klasse. */
  class: UniverseClass;
  /** Nachvollziehbare Begründungen (deterministisch, ohne Secrets). */
  reasons: string[];
  /** Market Score zum Reviewzeitpunkt. */
  score: number;
  /** Reviewzeitpunkt als ISO-8601-UTC. */
  asOf: string;
}

/** Zustandsdaten, die den Vergleich mit der Vorwoche ermöglichen. */
export interface WeeklyReviewContext {
  /** Regime je Instrument. */
  regimeByInstrument: Record<string, VolatilityRegime>;
  /** 24h-Volumen je Instrument (`null` = unbekannt). */
  volume24hByInstrument: Record<string, number | null>;
  /** Taker-Gebühr je Instrument. */
  takerFeeByInstrument: Record<string, number>;
  /** Paper-Verfügbarkeit je Instrument. */
  paperAvailableByInstrument: Record<string, boolean>;
  /** Wie viele Reviews in Folge das Instrument im Universum war (nicht EXCLUDED). */
  persistence: Record<string, number>;
}

/** Erkannte Änderungen gegenüber der Vorwoche. */
export interface WeeklyChanges {
  /** Erstmals gesehene Instrumente. */
  newListings: string[];
  /** Aus dem Scan verschwundene oder delistete Instrumente. */
  delistings: string[];
  /** Liquiditätsrückgang über der Schwelle. */
  liquidityDrops: string[];
  /** Gebührenerhöhung über der Schwelle. */
  feeIncreases: string[];
  /** Broker-Verfügbarkeit verloren. */
  brokerUnavailable: string[];
  /** Regimewechsel gegenüber der Vorwoche. */
  regimeShifts: string[];
  /** Instrumente in einem Korrelations-/Volatilitätscluster. */
  correlationClusters: string[];
}

/** Vollständiger Weekly Review (Artefakt-Contract). */
export interface WeeklyReview {
  /** Schema-Version des Artefakts. */
  schemaVersion: number;
  /** Version der verwendeten Scanner-Konfiguration. */
  configVersion: number;
  /** Reviewzeitpunkt als ISO-8601-UTC. */
  asOf: string;
  /** Klassifikation je Instrument, stabil nach `instrumentId` sortiert. */
  entries: WeeklyClassificationEntry[];
  /** Anzahl je Klasse. */
  summary: Record<UniverseClass, number>;
  /** Erkannte Änderungen. */
  changes: WeeklyChanges;
  /** Zustandsdaten für den nächsten Review. */
  context: WeeklyReviewContext;
}

/** Eingabe des Weekly Reviews. */
export interface WeeklyReviewInput {
  /** Ergebnis des Tagesscans. */
  scan: ScanResult;
  /** Review der Vorwoche (für Persistenz und Änderungserkennung). */
  previous?: WeeklyReview | null;
  /** Instrumentenstand der Vorwoche (Liquidität, Gebühren, Verfügbarkeit). */
  previousInstruments?: readonly MarketInstrument[] | null;
  /** Instrumente des aktuellen Laufs (Default: aus dem Scan abgeleitet). */
  instruments: readonly MarketInstrument[];
  /** Konfiguration; Default: die des Scans. */
  config?: ScannerConfig;
}

function clip(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
}

function rejectionIndex(rejections: readonly FilterRejection[]): Map<string, FilterRejection> {
  const map = new Map<string, FilterRejection>();
  for (const r of rejections) if (!map.has(r.instrumentId)) map.set(r.instrumentId, r);
  return map;
}

/**
 * Führt die deterministische Weekly-Klassifikation aus.
 *
 * Reihenfolge der Entscheidungen (fix und getestet):
 * 1. harte Ausschlüsse (Delisting/Status, Broker weg, Eignungsfilter),
 * 2. CORE (hoher Score + Liquidität + Persistenz + kein Verfall),
 * 3. DISCOVERY für Neulistings mit Mindestscore,
 * 4. ROTATION ab `rotationMinScore`,
 * 5. DISCOVERY ab `discoveryMinScore`, sonst EXCLUDED.
 */
export function classifyWeekly(input: WeeklyReviewInput): WeeklyReview {
  const config = input.config ?? input.scan.config;
  const wk = config.weekly;
  const asOf = input.scan.asOf;
  const rejections = rejectionIndex(input.scan.rejections);
  const eligibleIds = new Set(input.scan.funnel.eligible.map((s) => s.instrumentId));

  const previousEntries = new Map<string, WeeklyClassificationEntry>();
  for (const e of input.previous?.entries ?? []) previousEntries.set(e.instrumentId, e);
  const previousContext = input.previous?.context ?? null;
  const previousInstruments = new Map<string, MarketInstrument>();
  for (const i of input.previousInstruments ?? []) previousInstruments.set(i.id, i);

  const changes: WeeklyChanges = {
    newListings: [],
    delistings: [],
    liquidityDrops: [],
    feeIncreases: [],
    brokerUnavailable: [],
    regimeShifts: [],
    correlationClusters: [],
  };

  const context: WeeklyReviewContext = {
    regimeByInstrument: {},
    volume24hByInstrument: {},
    takerFeeByInstrument: {},
    paperAvailableByInstrument: {},
    persistence: {},
  };

  const entries: WeeklyClassificationEntry[] = [];
  const seen = new Set<string>();

  for (const instrument of [...input.instruments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const id = instrument.id;
    seen.add(id);
    const score: InstrumentScore | undefined = input.scan.byId.get(id);
    const scoreValue = score ? score.score : 0;
    const regime = score?.regime ?? "NORMAL";
    const reasons: string[] = [];

    context.regimeByInstrument[id] = regime;
    context.volume24hByInstrument[id] = instrument.volume24h;
    context.takerFeeByInstrument[id] = instrument.takerFee;
    context.paperAvailableByInstrument[id] = instrument.paperAvailable;

    // ── Änderungssignale ────────────────────────────────────────────────────
    const wasKnown = previousEntries.has(id) || previousInstruments.has(id);
    if (!wasKnown) {
      changes.newListings.push(id);
      reasons.push("neues Listing (in der Vorwoche unbekannt)");
    }

    const prevInstrument = previousInstruments.get(id) ?? null;
    const prevVolume = prevInstrument?.volume24h ?? previousContext?.volume24hByInstrument?.[id] ?? null;
    let liquidityDrop = false;
    if (prevVolume !== null && Number.isFinite(prevVolume) && prevVolume > 0 && instrument.volume24h !== null) {
      const drop = (prevVolume - instrument.volume24h) / prevVolume;
      if (drop >= wk.liquidityDropPct) {
        liquidityDrop = true;
        changes.liquidityDrops.push(id);
        reasons.push(clip(`Liquiditätsrückgang ${(drop * 100).toFixed(1)} % gegenüber Vorwoche`));
      }
    }

    const prevFee = prevInstrument?.takerFee ?? previousContext?.takerFeeByInstrument?.[id] ?? null;
    let feeIncrease = false;
    if (prevFee !== null && Number.isFinite(prevFee) && prevFee > 0) {
      const rise = (instrument.takerFee - prevFee) / prevFee;
      if (rise >= wk.feeIncreasePct) {
        feeIncrease = true;
        changes.feeIncreases.push(id);
        reasons.push(clip(`Gebührenerhöhung ${(rise * 100).toFixed(1)} % (Taker ${prevFee} → ${instrument.takerFee})`));
      }
    }

    const prevPaper = prevInstrument?.paperAvailable ?? previousContext?.paperAvailableByInstrument?.[id] ?? null;
    const brokerLost = prevPaper === true && instrument.paperAvailable === false;
    if (brokerLost) {
      changes.brokerUnavailable.push(id);
      reasons.push("Broker-Verfügbarkeit verloren (paperAvailable false)");
    }

    const prevRegime = previousContext?.regimeByInstrument?.[id] ?? null;
    if (prevRegime && prevRegime !== regime) {
      changes.regimeShifts.push(id);
      reasons.push(`Regimewechsel ${prevRegime} → ${regime}`);
    }

    const correlation = score?.factors.correlation;
    if (correlation?.available && correlation.raw !== null && Math.abs(correlation.raw) >= wk.clusterCorrelation) {
      changes.correlationClusters.push(id);
      reasons.push(clip(`Korrelationscluster (|r| ${Math.abs(correlation.raw).toFixed(2)} ≥ ${wk.clusterCorrelation})`));
    }

    reasons.push(`Score ${scoreValue.toFixed(2)}`);
    reasons.push(`Regime ${regime}`);

    // ── Klassifikation ─────────────────────────────────────────────────────
    let klass: UniverseClass;
    const rejection = rejections.get(id);
    const delisted = instrument.status === "delisted";

    if (delisted) {
      klass = "EXCLUDED";
      changes.delistings.push(id);
      reasons.unshift("Delisting (Status delisted)");
    } else if (brokerLost) {
      klass = "EXCLUDED";
    } else if (rejection || !eligibleIds.has(id)) {
      klass = "EXCLUDED";
      reasons.unshift(
        clip(rejection ? `Eignungsfilter ${rejection.ruleId}: ${rejection.message}` : "nicht in der Eignungsebene enthalten")
      );
    } else {
      const persistence = previousContext?.persistence?.[id] ?? 0;
      const wasInUniverse =
        persistence >= wk.coreMinPersistence ||
        ["CORE", "ROTATION"].includes(previousEntries.get(id)?.class ?? "");
      const volume = instrument.volume24h ?? 0;
      if (
        scoreValue >= wk.coreMinScore &&
        volume >= wk.coreMinVolume24h &&
        wasInUniverse &&
        regime !== "EXTREME" &&
        !liquidityDrop &&
        !feeIncrease
      ) {
        klass = "CORE";
        reasons.unshift(`CORE: Score ≥ ${wk.coreMinScore}, Volumen ≥ ${wk.coreMinVolume24h}, im Universum etabliert`);
      } else if (!wasKnown && scoreValue >= wk.discoveryMinScore) {
        klass = "DISCOVERY";
        reasons.unshift(`DISCOVERY: Neuzugang mit Score ≥ ${wk.discoveryMinScore}`);
      } else if (scoreValue >= wk.rotationMinScore) {
        klass = "ROTATION";
        reasons.unshift(`ROTATION: Score ≥ ${wk.rotationMinScore}`);
      } else if (scoreValue >= wk.discoveryMinScore) {
        klass = "DISCOVERY";
        reasons.unshift(`DISCOVERY: Score ≥ ${wk.discoveryMinScore}, unter Rotationsschwelle`);
      } else {
        klass = "EXCLUDED";
        reasons.unshift(`Score ${scoreValue.toFixed(2)} < Discovery-Schwelle ${wk.discoveryMinScore}`);
      }
    }

    // Persistenz zählt, wie viele Reviews in Folge das Instrument im Universum
    // war (CORE, ROTATION oder DISCOVERY); ein Ausschluss setzt sie zurück.
    context.persistence[id] = klass === "EXCLUDED" ? 0 : (previousContext?.persistence?.[id] ?? 0) + 1;

    entries.push({
      instrumentId: id,
      class: klass,
      reasons: reasons.slice(0, MAX_REASONS).map(clip),
      score: roundTo(scoreValue),
      asOf,
    });
  }

  // Instrumente, die letzte Woche existierten und jetzt fehlen ⇒ Delisting.
  const goneIds = [...previousEntries.keys()].filter((id) => !seen.has(id)).sort();
  for (const id of goneIds) {
    changes.delistings.push(id);
    entries.push({
      instrumentId: id,
      class: "EXCLUDED",
      reasons: ["im aktuellen Scan nicht mehr vorhanden (Delisting oder Broker-Rückzug)"],
      score: 0,
      asOf,
    });
    context.persistence[id] = 0;
  }

  entries.sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0));
  for (const key of Object.keys(changes) as (keyof WeeklyChanges)[]) changes[key].sort();

  const summary: Record<UniverseClass, number> = { CORE: 0, ROTATION: 0, DISCOVERY: 0, EXCLUDED: 0 };
  for (const e of entries) summary[e.class] += 1;

  return {
    schemaVersion: 1,
    configVersion: config.version,
    asOf,
    entries,
    summary,
    changes,
    context,
  };
}

/** Fehler einer ungültigen Weekly-Struktur. */
export class WeeklyValidationError extends Error {
  /** Maschinenlesbarer Code für den API-Fehler-Contract. */
  readonly code = "WEEKLY_VALIDATION_ERROR";
  constructor(message: string) {
    super(`Weekly-Review ungültig: ${message}`);
    this.name = "WeeklyValidationError";
  }
}

const INSTRUMENT_ID_RE = /^[A-Z][A-Z0-9_]{1,15}:[A-Z0-9]{1,20}(?:[/.\-_=][A-Z0-9]{1,10}){0,2}$/;

/**
 * Validiert einen einzelnen Klassifikationseintrag
 * (`{ instrumentId, class, reasons[], score, asOf }`).
 *
 * @throws {WeeklyValidationError} bei jedem Verstoß — es wird nichts repariert.
 */
export function validateWeeklyEntry(raw: unknown): WeeklyClassificationEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WeeklyValidationError("Eintrag ist kein Objekt");
  }
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["instrumentId", "class", "reasons", "score", "asOf"]);
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) throw new WeeklyValidationError(`unbekanntes Feld "${key.slice(0, 32)}"`);
  }
  const instrumentId = o.instrumentId;
  if (typeof instrumentId !== "string" || !INSTRUMENT_ID_RE.test(instrumentId)) {
    throw new WeeklyValidationError("instrumentId: ungültiges Format");
  }
  if (typeof o.class !== "string" || !UNIVERSE_CLASSES.includes(o.class as UniverseClass)) {
    throw new WeeklyValidationError(`class: erwartet ${UNIVERSE_CLASSES.join(" | ")}`);
  }
  if (!Array.isArray(o.reasons) || o.reasons.length === 0 || o.reasons.length > MAX_REASONS) {
    throw new WeeklyValidationError(`reasons: 1…${MAX_REASONS} Einträge erwartet`);
  }
  const reasons = o.reasons.map((r, i) => {
    if (typeof r !== "string" || !r.trim() || r.length > MAX_REASON_LENGTH) {
      throw new WeeklyValidationError(`reasons[${i}]: nicht-leerer String ≤ ${MAX_REASON_LENGTH} Zeichen erwartet`);
    }
    return r;
  });
  const score = typeof o.score === "number" ? o.score : Number(o.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new WeeklyValidationError("score: erwartet Zahl in [0, 100]");
  }
  if (typeof o.asOf !== "string" || !Number.isFinite(Date.parse(o.asOf))) {
    throw new WeeklyValidationError("asOf: erwartet ISO-8601-Zeitstempel");
  }
  return { instrumentId, class: o.class as UniverseClass, reasons, score, asOf: o.asOf };
}

/** Validiert einen vollständigen Weekly Review inklusive aller Einträge. */
export function validateWeeklyReview(raw: unknown): WeeklyReview {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WeeklyValidationError("erwartet Objekt");
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.entries)) throw new WeeklyValidationError("entries: erwartet Liste");
  const entries = o.entries.map(validateWeeklyEntry);
  const summary: Record<UniverseClass, number> = { CORE: 0, ROTATION: 0, DISCOVERY: 0, EXCLUDED: 0 };
  for (const e of entries) summary[e.class] += 1;
  const changes = (o.changes ?? {}) as Partial<WeeklyChanges>;
  const context = (o.context ?? {}) as Partial<WeeklyReviewContext>;
  return {
    schemaVersion: Number(o.schemaVersion) || 1,
    configVersion: Number(o.configVersion) || 1,
    asOf: typeof o.asOf === "string" ? o.asOf : (entries[0]?.asOf ?? new Date(0).toISOString()),
    entries,
    summary,
    changes: {
      newListings: changes.newListings ?? [],
      delistings: changes.delistings ?? [],
      liquidityDrops: changes.liquidityDrops ?? [],
      feeIncreases: changes.feeIncreases ?? [],
      brokerUnavailable: changes.brokerUnavailable ?? [],
      regimeShifts: changes.regimeShifts ?? [],
      correlationClusters: changes.correlationClusters ?? [],
    },
    context: {
      regimeByInstrument: context.regimeByInstrument ?? {},
      volume24hByInstrument: context.volume24hByInstrument ?? {},
      takerFeeByInstrument: context.takerFeeByInstrument ?? {},
      paperAvailableByInstrument: context.paperAvailableByInstrument ?? {},
      persistence: context.persistence ?? {},
    },
  };
}
