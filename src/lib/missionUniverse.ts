/**
 * Missions-Universum: Segment → Kandidatenliste (v1.35.0).
 *
 * ── Aufgabe ─────────────────────────────────────────────────────────────────
 * Eine `SCAN_UNIVERSE`-Mission trägt kein Symbol, sondern ein **Segment**
 * (`src/lib/missionTemplates.ts`). Dieses Modul beantwortet zur Laufzeit drei
 * Fragen:
 *
 *   1. **Welche Märkte** gehören zu dem Segment?   → `resolveSegmentSymbols()`
 *   2. **Woran** soll der Agent sich orientieren?  → `focusSymbol` (Indikatoren)
 *   3. **Darf** ein gewünschtes Symbol gehandelt werden? → `isSymbolInMissionScope()`
 *
 * Quelle ist immer die Instrument-Registry (`src/universe/`), niemals eine
 * hardcoded Liste: Neue Märkte kommen mit `npm run universe:seed:markets` bzw.
 * `npm run market:sync` dazu und sind damit automatisch Teil der Segmente.
 *
 * ── Fehlersemantik ───────────────────────────────────────────────────────────
 * * Registry nicht lesbar (Datei kaputt, Berechtigungen) → `warning`, leere
 *   Kandidatenliste, Fokus-Symbol fällt auf den Fallback zurück. Der Lauf bricht
 *   nicht ab — die Engine handelt dann einfach nicht (siehe unten).
 * * Leere Kandidatenliste bei `SCAN_UNIVERSE` gilt als **nicht handelbar**
 *   (fail-closed): Das Mandat lautet „nur dieses Segment“, und wenn kein
 *   einziges Instrument dazu gehört, darf kein anderes gehandelt werden.
 *   Die Engine blockt mit `MISSION_SCOPE_EMPTY` und schreibt es ins Audit-Log.
 * * `SINGLE_SYMBOL`-Missionen verhalten sich exakt wie vor v1.35.0
 *   (`mission.symbol ?? Fallback`) — kein Verhaltenswechsel für Alt-Mandate.
 */
import { getRegistry } from "@/universe";
import type { MarketInstrument } from "@/universe/types";
import { sanitizeSymbol } from "./marketData";
import {
  MISSION_SCOPE_LABELS,
  MISSION_SEGMENTS,
  findMissionSegment,
  normalizeMissionScope,
  type MissionSegment,
  type MissionScope,
} from "./missionTemplates";

/** Fallback-Fokus, wenn eine Mission weder Symbol noch Kandidaten hat. */
export const DEFAULT_FOCUS_SYMBOL = "SPY";

/** Minimale Missions-Form für dieses Modul (DB-Zeile oder DTO). */
export interface MissionScopeInput {
  /** Einzel-Symbol (Pflicht bei `SINGLE_SYMBOL`). */
  symbol?: string | null;
  /** Missions-Typ; fehlend/leer → `SINGLE_SYMBOL` (Altbestand). */
  scope?: string | null;
  /** Segment-ID bei `SCAN_UNIVERSE`. */
  segment?: string | null;
}

/** Ergebnis der Segment-Auflösung — Grundlage für Prompt und Scope-Prüfung. */
export interface MissionUniverseContext {
  /** Missions-Typ (normalisiert). */
  scope: MissionScope;
  /** Segment-ID oder `null`. */
  segmentId: string | null;
  /** Klartext des Segments, z. B. „Indizes & ETFs“. */
  segmentLabel: string;
  /** Klartext des Missions-Typs. */
  scopeLabel: string;
  /** Menschenlesbare Filterregel des Segments (steht auch im Prompt). */
  rule: string | null;
  /** Kandidaten in kanonischer Schreibweise, sortiert und gekürzt. */
  candidates: string[];
  /** Trefferzahl vor der Kürzung auf `maxCandidates`. */
  total: number;
  /** Symbol, für das Indikatoren gerechnet werden. */
  focusSymbol: string;
  /**
   * Darf die Engine Trades außerhalb von `candidates` blocken?
   *
   * `true` für jede `SCAN_UNIVERSE`-Mission und für `SINGLE_SYMBOL`-Missionen
   * mit gültigem Symbol. `false` nur für Alt-Missionen ohne Symbol
   * (Legacy-Toleranz: Verhalten wie vor v1.35.0 — Fokus `SPY`, keine
   * Mandatsprüfung), damit bestehende Installationen nicht plötzlich blocken.
   */
  enforceScope: boolean;
  /** Diagnose-Hinweis (leere Liste, Registry-Fehler) oder `null`. */
  warning: string | null;
  /** Zusatzhinweis des Segments (z. B. Penny-Preisgrenze zur Laufzeit). */
  runtimeFilterNote: string | null;
  /** Fertige Prompt-Zeilen (leer bei `SINGLE_SYMBOL`). */
  promptLines: string[];
}

/**
 * Verdichtet Instrumente auf eine handelbare Kandidatenliste.
 *
 * Regeln (deterministisch, damit Tests und Prompt stabil bleiben):
 *   1. Kanonisierung über `sanitizeSymbol()` — dieselbe Form, die die Engine
 *      später mit `decision.symbol` vergleicht.
 *   2. Duplikate über Venues hinweg zusammenfassen: Der **PAPER**-Spiegel
 *      gewinnt (Paper-Trading ist der Auslieferungszustand), sonst das
 *      Instrument mit dem höheren 24h-Volumen.
 *   3. Sortierung nach 24h-Volumen absteigend (`null` = unbekannt → zuletzt),
 *      bei Gleichstand alphabetisch — „wichtigste Märkte zuerst“.
 *   4. Kürzung auf `limit` (= `segment.maxCandidates`).
 */
export function rankCandidateSymbols(
  instruments: readonly MarketInstrument[],
  limit: number
): { symbols: string[]; total: number } {
  const best = new Map<string, MarketInstrument>();
  for (const instrument of instruments) {
    const canonical = sanitizeSymbol(instrument.symbol);
    if (!canonical) continue; // nicht paper-normalisierbar → kein Kandidat
    const current = best.get(canonical);
    if (!current) {
      best.set(canonical, instrument);
      continue;
    }
    const volumeOf = (i: MarketInstrument) => (typeof i.volume24h === "number" ? i.volume24h : -1);
    const currentIsPaper = current.venue === "PAPER";
    const candidateIsPaper = instrument.venue === "PAPER";
    if (candidateIsPaper !== currentIsPaper) {
      if (candidateIsPaper) best.set(canonical, instrument);
      continue;
    }
    if (volumeOf(instrument) > volumeOf(current)) best.set(canonical, instrument);
  }

  const volumeOf = (i: MarketInstrument) => (typeof i.volume24h === "number" ? i.volume24h : -1);
  const entries = [...best.entries()].sort((a, b) => {
    const byVolume = volumeOf(b[1]) - volumeOf(a[1]);
    if (byVolume !== 0) return byVolume;
    return a[0].localeCompare(b[0]);
  });

  return {
    symbols: entries.slice(0, Math.max(0, limit)).map(([symbol]) => symbol),
    total: entries.length,
  };
}

/**
 * Bestimmt die Instrumente eines Segments aus einer Registry-Instanz.
 *
 * Bewusst als Funktion mit Registry-Parameter (statt `getRegistry()` innen):
 * Tests können eine Registry mit eigenem Datenverzeichnis übergeben — kein
 * Singleton, keine Seiteneffekte.
 */
export function resolveSegmentInstruments(
  registry: { query: (q: MarketInstrumentQueryLike) => { items: MarketInstrument[]; total: number } },
  segment: MissionSegment
): MarketInstrument[] {
  const result = registry.query({
    ...segment.universeQuery,
    // Segment-Mitgliedschaft setzt Handelbarkeit voraus: nur aktive,
    // paper-verfügbare Instrumente können Teil eines Auftrags sein.
    status: "active",
    paperAvailable: true,
  });
  const items = result.items ?? [];
  return segment.filter ? items.filter(segment.filter) : items;
}

/** Strukturkompatibler Query-Typ (verhindert harte Kopplung im Test). */
export interface MarketInstrumentQueryLike {
  [key: string]: unknown;
}

/** Fokus-Symbol: erster Kandidat, sonst der Fallback. */
export function focusSymbolFor(candidates: readonly string[], fallback: string): string {
  const first = candidates[0];
  if (typeof first === "string" && first.trim()) return first;
  return fallback;
}

/**
 * Prüft, ob ein Symbol vom Mandat der Mission gedeckt ist.
 *
 * * `enforceScope === false` (Alt-Mission ohne Symbol) → `true` (kein Mandat
 *   definiert, Verhalten wie vor v1.35.0).
 * * `SINGLE_SYMBOL` → exakt das Missionssymbol (kanonisch verglichen).
 * * `SCAN_UNIVERSE` → Mitgliedschaft in der Kandidatenliste; eine leere Liste
 *   bedeutet „Segment nicht auflösbar“ → `false` (fail-closed).
 */
export function isSymbolInMissionScope(
  context: MissionUniverseContext,
  symbol: string | null | undefined
): boolean {
  if (!context.enforceScope) return true;
  const candidate = typeof symbol === "string" ? sanitizeSymbol(symbol) : null;
  if (!candidate) return false;
  return context.candidates.some((c) => c.toUpperCase() === candidate.toUpperCase());
}

/**
 * Löst eine Mission in ihren Universums-Kontext auf.
 *
 * @param mission  DB-Zeile oder DTO (nur `symbol`/`scope`/`segment` werden gelesen)
 * @param options.fallbackSymbol  Fokus-Fallback (Default `SPY`, wie vor v1.35.0)
 */
export async function missionUniverseContext(
  mission: MissionScopeInput,
  options: { fallbackSymbol?: string } = {}
): Promise<MissionUniverseContext> {
  const fallbackSymbol = options.fallbackSymbol ?? DEFAULT_FOCUS_SYMBOL;
  const scope: MissionScope = normalizeMissionScope(mission.scope) ?? "SINGLE_SYMBOL";

  // ── Einzel-Symbol: Verhalten unverändert ──────────────────────────────────
  if (scope === "SINGLE_SYMBOL") {
    const raw = typeof mission.symbol === "string" && mission.symbol.trim() ? mission.symbol.trim() : null;
    const canonical = raw ? sanitizeSymbol(raw) : null;
    return {
      scope,
      segmentId: null,
      segmentLabel: MISSION_SCOPE_LABELS.SINGLE_SYMBOL,
      scopeLabel: MISSION_SCOPE_LABELS.SINGLE_SYMBOL,
      rule: null,
      candidates: canonical ? [canonical] : [],
      total: canonical ? 1 : 0,
      // Kanonische Form — identisch zu `sanitizeSymbol(mission.symbol ?? "SPY")`
      // vor v1.35.0, damit sich für bestehende Mandate nichts ändert.
      focusSymbol: canonical ?? fallbackSymbol,
      // Alt-Missionen ohne Symbol behalten ihr Verhalten (kein Mandat, keine
      // Blockade) — nur mit Diagnose-Hinweis.
      enforceScope: Boolean(canonical),
      warning: canonical
        ? null
        : `Kein gültiges Symbol — Fokus fällt auf ${fallbackSymbol} zurück, Mandatsprüfung bleibt aus (Legacy-Verhalten).`,
      runtimeFilterNote: null,
      promptLines: [],
    };
  }

  // ── Markt-Scan: Segment auflösen ──────────────────────────────────────────
  const segment = findMissionSegment(mission.segment);
  if (!segment) {
    return {
      scope,
      segmentId: null,
      segmentLabel: "unbekanntes Segment",
      scopeLabel: MISSION_SCOPE_LABELS.SCAN_UNIVERSE,
      rule: null,
      candidates: [],
      total: 0,
      focusSymbol: fallbackSymbol,
      enforceScope: true,
      warning:
        "Segment fehlt oder ist unbekannt — Scan-Missionen brauchen eine Segment-ID " +
        "(z. B. ALL, INDICES, PENNY). Trades werden blockiert, bis das Segment gesetzt ist.",
      runtimeFilterNote: null,
      promptLines: [
        `UNIVERSUM: kein gültiges Segment gesetzt — antworte HOLD.`,
      ],
    };
  }

  let instruments: MarketInstrument[] = [];
  let warning: string | null = null;
  try {
    instruments = resolveSegmentInstruments(getRegistry(), segment);
  } catch (e) {
    warning = `Instrument-Registry nicht lesbar (${e instanceof Error ? e.message : String(e)}) — keine Kandidaten.`;
  }

  const ranked = rankCandidateSymbols(instruments, segment.maxCandidates);
  if (ranked.symbols.length === 0 && !warning) {
    warning =
      `Segment „${segment.label}“ hat aktuell 0 Kandidaten in der Registry. ` +
      "Abhilfe: `npm run universe:seed:markets` (Presets) und `npm run market:sync` (Metriken).";
  }

  const focusSymbol = focusSymbolFor(ranked.symbols, fallbackSymbol);
  const promptLines: string[] = [
    `UNIVERSUM: ${segment.label} — ${ranked.total} Instrumente${
      ranked.total > ranked.symbols.length ? `, Top ${ranked.symbols.length} nach 24h-Volumen` : ""
    }.`,
    `SEGMENT-REGEL: ${segment.rule}`,
    ranked.symbols.length > 0
      ? `KANDIDATEN: ${ranked.symbols.join(", ")}`
      : `KANDIDATEN: keine — antworte HOLD (Segment ist leer, siehe Operations Center).`,
    `Ein TRADE ist nur auf ein Symbol aus KANDIDATEN erlaubt; jedes andere Symbol wird von der Engine blockiert.`,
  ];
  if (segment.runtimeFilterNote) promptLines.push(`HINWEIS: ${segment.runtimeFilterNote}`);

  return {
    scope,
    segmentId: segment.id,
    segmentLabel: segment.label,
    scopeLabel: MISSION_SCOPE_LABELS.SCAN_UNIVERSE,
    rule: segment.rule,
    candidates: ranked.symbols,
    total: ranked.total,
    focusSymbol,
    enforceScope: true,
    warning,
    runtimeFilterNote: segment.runtimeFilterNote ?? null,
    promptLines,
  };
}

/**
 * Kurzform für Aufrufer, die nur das Fokus-Symbol brauchen
 * (z. B. Makro-Zyklus: Regelwerk wird für EIN Symbol erzeugt).
 */
export async function missionFocusSymbol(
  mission: MissionScopeInput,
  fallback = DEFAULT_FOCUS_SYMBOL
): Promise<string> {
  const context = await missionUniverseContext(mission, { fallbackSymbol: fallback });
  return context.focusSymbol;
}

/**
 * Kandidatenübersicht für die API (`GET /api/firm/missions`): wie viele
 * Instrumente jedes Segment aktuell liefert — damit die UI eine leere Liste
 * als Datenproblem erkennt, bevor jemand eine Mission darauf anlegt.
 *
 * Gezählt werden **eindeutige Symbole**, nicht Registry-Zeilen: Dasselbe Asset
 * liegt üblicherweise auf mehreren Venues (z. B. SPY auf ALPACA, IBKR und
 * PAPER) und erscheint im Mandat trotzdem nur einmal. Die angezeigte Zahl ist
 * damit exakt das, was die Mission später als Kandidatenliste sieht
 * (`UNIVERSUM: … — N Instrumente` im Prompt) — keine höhere Scheinzahl aus
 * Venue-Spiegeln.
 *
 * Fehlt die Registry ganz, gibt die Funktion ein leeres Objekt zurück; die UI
 * zeigt dann `0` und den Hinweis auf `npm run universe:seed:markets`.
 */
export function segmentCandidateCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  let registry: ReturnType<typeof getRegistry> | null = null;
  try {
    registry = getRegistry();
  } catch {
    return counts; // Registry unlesbar → leere Zählung (UI zeigt 0)
  }
  for (const segment of MISSION_SEGMENTS) {
    try {
      counts[segment.id] = rankCandidateSymbols(
        resolveSegmentInstruments(registry, segment),
        segment.maxCandidates
      ).total;
    } catch {
      counts[segment.id] = 0;
    }
  }
  return counts;
}
