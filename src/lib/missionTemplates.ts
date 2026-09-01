/**
 * Missions-Vorlagen, Missions-Typen (Scope) und Marktsegmente (v1.35.0).
 *
 * ── Warum diese Datei existiert ──────────────────────────────────────────────
 * Vor v1.35.0 konnte eine Mission genau EIN Symbol haben (`missions.symbol`).
 * Aufträge wie „scanne alle Märkte“, „nur Penny Stocks“ oder „nur Indizes“
 * ließen sich damit nicht ausdrücken: Die beiden Multi-Asset-Mandate des Seeds
 * standen mit `symbol = NULL` in der Datenbank, die Engine musste raten
 * (`mission.symbol ?? "SPY"`), und die UI bot kein Feld dafür an.
 *
 * Jetzt gibt es zwei klar getrennte Missions-Typen (`MissionScope`):
 *
 *   1. `SINGLE_SYMBOL` — ein Instrument, exakt wie bisher (Symbol Pflicht).
 *   2. `SCAN_UNIVERSE` — die Mission scannt ein **Marktsegment** (z. B. alle
 *      Indizes). Statt eines Symbols trägt sie eine Segment-ID; die Kandidaten
 *      werden zur Laufzeit aus der Instrument-Registry bestimmt
 *      (`src/lib/missionUniverse.ts`) und sind damit nie hardcoded.
 *
 * ── Design-Regeln ────────────────────────────────────────────────────────────
 *   * **Reine Daten, keine Nebenwirkungen.** Diese Datei kennt weder Datenbank
 *     noch Next.js noch Netzwerk — dieselbe Regel wie `src/lib/workshop.ts`.
 *     API-Routen, Seed, UI und Tests teilen sich deshalb exakt denselben
 *     Katalog (kein Drift zwischen Formular, Seed und Doku).
 *   * **Guardrails bleiben im Code.** Vorlagen *schlagen* Risikobudgets vor und
 *     bleiben dabei immer innerhalb der `LIMIT_CEILINGS`
 *     (`src/lib/riskGuard.ts`). Sie können die Deckel nicht verschieben:
 *     `validateMissionInput()` prüft jede Vorlage wie eine manuelle Eingabe.
 *   * **Seed = Vorlagen.** `src/lib/seed.ts` hält keine eigenen Missionstexte
 *     mehr, sondern übernimmt die mit `seeded: true` markierten Vorlagen.
 *     Eine neue Standard-Mission entsteht damit an genau einer Stelle.
 *   * **Tooltip-Pflicht.** Jede Vorlage und jedes Segment trägt die drei
 *     Hilfe-Ebenen `kurzinfo` / `technischeInfo` / `risiko` — dasselbe Schema
 *     wie `docs/help/*.help.json` (3-Ebenen-Systematik).
 */
import type { InstrumentQuery, MarketInstrument } from "@/universe/types";

// ─────────────────────────────────────────────────────────────────────────────
// 1) Missions-Typ (Scope)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Missions-Typ. Bestimmt, welches Feld Pflicht ist:
 *
 * | Scope           | Pflichtfeld | Bedeutung                                               |
 * | --------------- | ----------- | ------------------------------------------------------- |
 * | `SINGLE_SYMBOL` | `symbol`    | Ein Instrument, z. B. `BTC` (Verhalten vor v1.35.0).     |
 * | `SCAN_UNIVERSE` | `segment`   | Ein Marktsegment, z. B. `INDICES` — mehrere Kandidaten.  |
 *
 * Persistiert in `missions.scope` (Default `SINGLE_SYMBOL`, damit
 * Alt-Installationen nach `npx drizzle-kit push` unverändert weiterlaufen).
 */
export const MISSION_SCOPES = ["SINGLE_SYMBOL", "SCAN_UNIVERSE"] as const;
export type MissionScope = (typeof MISSION_SCOPES)[number];

/** Deutsche Klartext-Bezeichnung je Scope (UI, Prompt, Audit). */
export const MISSION_SCOPE_LABELS: Record<MissionScope, string> = {
  SINGLE_SYMBOL: "Einzel-Symbol",
  SCAN_UNIVERSE: "Markt-Scan (Segment)",
};

/** Normalisiert einen Scope-String; Unbekanntes → `null` (nie stiller Default). */
export function normalizeMissionScope(raw: unknown): MissionScope | null {
  if (typeof raw !== "string") return null;
  const up = raw.trim().toUpperCase();
  return (MISSION_SCOPES as readonly string[]).includes(up) ? (up as MissionScope) : null;
}

/** true, wenn `raw` ein gültiger Scope-String ist (Groß-/Kleinschreibung egal). */
export function isMissionScope(raw: unknown): raw is MissionScope {
  return normalizeMissionScope(raw) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Drei-Ebenen-Hilfe (dasselbe Schema wie docs/help/*.help.json)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hilfetext-Trio für Tooltips und Doku.
 *
 * Ebene 1 (`kurzinfo`) ist die Nutzersicht, Ebene 2 (`technischeInfo`) nennt
 * Modul/Formel/Grenze, Ebene 3 (`risiko`) warnt. Mindestens 20 Zeichen je
 * Ebene — dieselbe Regel wie im Help-Schema (`docs/help/help.schema.json`);
 * `tests/missionTemplates.test.ts` prüft sie für jeden Eintrag.
 */
export interface MissionHelp {
  kurzinfo: string;
  technischeInfo: string;
  risiko: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Marktsegmente — „was“ eine Scan-Mission betrachtet
// ─────────────────────────────────────────────────────────────────────────────

/** Alle Segment-IDs (Allowlist für API, DB-Spalte `missions.segment` und UI). */
export const MISSION_SEGMENT_IDS = [
  "ALL",
  "INDICES",
  "CRYPTO",
  "EQUITIES",
  "FX",
  "COMMODITIES",
  "PENNY",
  "VOLATILE",
  "LIQUID",
] as const;
export type MissionSegmentId = (typeof MISSION_SEGMENT_IDS)[number];

/**
 * Ein Marktsegment: benannte Teilmenge des Instrument-Universums.
 *
 * `universeQuery` wird unverändert an `InstrumentRegistry.query()` übergeben
 * (`src/universe/registry.ts`) — die Registry bleibt die einzige Quelle dafür,
 * **was** existiert. `filter` ergänzt nur, was die Query nicht ausdrücken kann
 * (z. B. „Volatilität ≥ 60 %“, weil `InstrumentQuery` lediglich `maxVolatility`
 * und `minVolume24h` kennt).
 */
export interface MissionSegment {
  /** Maschinenlesbare ID, z. B. `INDICES`. */
  id: MissionSegmentId;
  /** Anzeigename, z. B. „Indizes & ETFs“. */
  label: string;
  /** Kurzes Piktogramm für die Auswahlliste (rein dekorativ). */
  emoji: string;
  /** Einzeiler für `<option>` und Listen. */
  short: string;
  /** 2–3 Sätze: was gescannt wird und wofür das Segment taugt. */
  description: string;
  /** Menschenlesbare Filterregel — wandert unverändert in den Agenten-Prompt. */
  rule: string;
  /** Registry-Filter (SSoT bleibt `InstrumentRegistry.query()`). */
  universeQuery: InstrumentQuery;
  /** Zusatzfilter für Bedingungen, die `InstrumentQuery` nicht kennt. */
  filter?: (instrument: MarketInstrument) => boolean;
  /** Höchstzahl Kandidaten im Prompt (kleine Modelle brauchen kurze Listen). */
  maxCandidates: number;
  /** Risikobudget-Vorschlag als Bruchteil (0.01 = 1 %) — Vorschlag, kein Limit. */
  suggestedRiskBudget: number;
  /** Positionsgrößen-Vorschlag als Bruchteil (0.2 = 20 %). */
  suggestedMaxPositionPct: number;
  /**
   * Hinweis, wenn ein Teil der Regel erst zur Laufzeit prüfbar ist
   * (z. B. „Kurs < 5 USD“ beim Penny-Segment — die Registry führt keine Kurse).
   */
  runtimeFilterNote?: string;
  /** Tooltip-Inhalt (3 Ebenen). */
  help: MissionHelp;
}

/**
 * Die Segment-Bibliothek. Reihenfolge = Anzeigereihenfolge in der UI.
 *
 * Die Vorschlagswerte (`suggestedRiskBudget`, `suggestedMaxPositionPct`) liegen
 * immer **innerhalb** der Code-Deckel (`LIMIT_CEILINGS`): Risiko 0,002–0,05,
 * Positionsgröße 0,01–0,5. Je spekulativer das Segment, desto kleiner der
 * Vorschlag — das ist die einzige „Risikosteuerung“ dieser Datei, erzwungen
 * wird sie von `riskGuard` bzw. `validateMissionInput`.
 */
export const MISSION_SEGMENTS: readonly MissionSegment[] = [
  {
    id: "ALL",
    label: "Alle Märkte",
    emoji: "🌐",
    short: "Alle Märkte (komplettes Universum)",
    description:
      "Scannt das komplette freigegebene Universum: Krypto, Aktien, ETFs, Indizes, Devisen und Rohstoffe — alles, was die Instrument-Registry als aktiv und paper-handelbar führt.",
    rule: "Alle Instrumente der Registry mit status=active und paperAvailable=true, über alle Anlageklassen.",
    universeQuery: {
      assetClass: ["crypto", "equity", "etf", "index", "fx", "commodity"],
      pageSize: 500,
    },
    maxCandidates: 12,
    suggestedRiskBudget: 0.01,
    suggestedMaxPositionPct: 0.1,
    help: {
      kurzinfo:
        "Die Firma betrachtet jeden Markt, den die Registry kennt, und sucht über alle Anlageklassen hinweg die besten Setups.",
      technischeInfo:
        "Filter: InstrumentRegistry.query({ assetClass: crypto|equity|etf|index|fx|commodity, status: active, paperAvailable: true }) in src/lib/missionUniverse.ts. Kandidaten werden nach 24h-Volumen absteigend sortiert und auf maxCandidates gekürzt.",
      risiko:
        "Ein breites Universum verleitet zu vielen gleichzeitigen Positionen. Ohne hartes Tageslimit handelt die Firma quer durch alle Regimes — die Positionsanzahl gehört deshalb in die Missionsregeln.",
    },
  },
  {
    id: "INDICES",
    label: "Indizes & ETFs",
    emoji: "📈",
    short: "Nur Indizes und Index-ETFs",
    description:
      "Breite Marktindizes (S&P 500, Nasdaq 100, DAX, Nikkei) und Index-ETFs. Ruhiger als Einzelwerte, gut für Trendfolge und als Referenzmarkt.",
    rule: "assetClass ∈ {index, etf} — Index-CFDs, Index-Futures und Index-ETFs der Registry.",
    universeQuery: { assetClass: ["index", "etf"], pageSize: 500 },
    maxCandidates: 10,
    suggestedRiskBudget: 0.01,
    suggestedMaxPositionPct: 0.2,
    help: {
      kurzinfo:
        "Die Mission handelt ausschließlich breite Märkte — Indizes und Index-ETFs statt einzelner Unternehmen.",
      technischeInfo:
        "Filter: InstrumentRegistry.query({ assetClass: ['index','etf'] }). Indizes liegen als CFD/Future der Venue IBKR vor (Preset „Indizes“, npm run universe:seed:markets), ETFs wie SPY/QQQ zusätzlich als PAPER-Spiegel.",
      risiko:
        "Index-CFDs sind Hebelprodukte der Venue; die Mission darf maxLeverage=1 nicht verlassen. Fehlt das Indizes-Preset in der Registry, ist die Kandidatenliste leer — dann `npm run universe:seed:markets` ausführen.",
    },
  },
  {
    id: "CRYPTO",
    label: "Krypto 24/7",
    emoji: "🪙",
    short: "Nur Kryptowährungen",
    description:
      "Kryptowährungen an den angebundenen Venues. Läuft rund um die Uhr, ist dafür deutlich volatiler als Aktien und kennt keine Börsenschluss-Atempause.",
    rule: "assetClass = crypto (Spot-Paare der Krypto-Venues und ihre PAPER-Spiegel).",
    universeQuery: { assetClass: ["crypto"], pageSize: 500 },
    maxCandidates: 10,
    suggestedRiskBudget: 0.015,
    suggestedMaxPositionPct: 0.15,
    help: {
      kurzinfo:
        "Die Mission beobachtet ausschließlich Kryptowährungen — 24 Stunden am Tag, sieben Tage die Woche.",
      technischeInfo:
        "Filter: InstrumentRegistry.query({ assetClass: 'crypto' }). Kurse liefert das Market-Data-Layer (Binance Public REST bzw. Broker-Modus), Kerzen kommen über getCandles(symbol, '15m'|'1h'|'1d').",
      risiko:
        "Krypto fällt schneller und tiefer als Aktien; Wochenenden und Feiertage sind nicht ruhiger. Stop-Loss ist Pflicht, das Risikobudget sollte kleiner sein als bei Indizes.",
    },
  },
  {
    id: "EQUITIES",
    label: "US-Aktien",
    emoji: "🏢",
    short: "Nur Aktien (Large Caps)",
    description:
      "Einzelaktien — im Preset die 50 liquidesten US-Large-Caps. Geregelte Handelszeiten und gute Datenlage, dafür Übernacht- und Ereignisrisiken.",
    rule: "assetClass = equity (US-Aktien der Venues ALPACA/IBKR plus PAPER-Spiegel).",
    universeQuery: { assetClass: ["equity"], pageSize: 500 },
    maxCandidates: 10,
    suggestedRiskBudget: 0.01,
    suggestedMaxPositionPct: 0.2,
    help: {
      kurzinfo:
        "Die Mission handelt einzelne Unternehmen — liquide US-Aktien statt Fonds oder Krypto.",
      technischeInfo:
        "Filter: InstrumentRegistry.query({ assetClass: 'equity' }). Das Aktien-Preset (50 Large Caps) kommt aus src/universe/presets.ts und wird mit `npm run universe:seed:markets` in die Registry geschrieben.",
      risiko:
        "Einzelwerte tragen Firmenrisiko: Quartalszahlen, Rückrufe und Klagen erzeugen Kurslücken, die ein Stop-Loss nicht zum geplanten Preis ausführt.",
    },
  },
  {
    id: "FX",
    label: "Devisen",
    emoji: "💱",
    short: "Nur Währungspaare",
    description:
      "Große Währungspaare (EUR/USD, USD/JPY, GBP/USD). Enge Spreads und sehr hohe Liquidität, aber kleine Bewegungen — deshalb eher Mean-Reversion als Trendfolge.",
    rule: "assetClass = fx (Währungspaare, venue-native Notation z. B. EURUSD=X).",
    universeQuery: { assetClass: ["fx"], pageSize: 500 },
    maxCandidates: 8,
    suggestedRiskBudget: 0.008,
    suggestedMaxPositionPct: 0.15,
    help: {
      kurzinfo: "Die Mission handelt Währungspaare — etwa Euro gegen US-Dollar.",
      technischeInfo:
        "Filter: InstrumentRegistry.query({ assetClass: 'fx' }). Die Symbol-Notation ist venue-nativ (EURUSD=X), die Normalisierung läuft über src/symbols/ (SYM-007).",
      risiko:
        "FX bewegt sich meist in kleinen Schritten; wer mit Hebel rechnet, unterschätzt Zinsentscheide. Ohne Hebel (maxLeverage=1) sind die Renditechancen entsprechend klein.",
    },
  },
  {
    id: "COMMODITIES",
    label: "Rohstoffe",
    emoji: "🛢️",
    short: "Nur Rohstoffe (Futures)",
    description:
      "Rohstoffe wie Gold, Silber, Öl und Erdgas — als Futures der Venue IBKR. Reagieren stark auf Makrodaten und kennen Kontraktwechsel (Rollover).",
    rule: "assetClass = commodity (Rohstoff-Futures des IBKR-Presets).",
    universeQuery: { assetClass: ["commodity"], pageSize: 500 },
    maxCandidates: 8,
    suggestedRiskBudget: 0.008,
    suggestedMaxPositionPct: 0.1,
    help: {
      kurzinfo:
        "Die Mission handelt Rohstoffe — Gold, Silber, Öl, Gas und ähnliche Futures.",
      technischeInfo:
        "Filter: InstrumentRegistry.query({ assetClass: 'commodity' }). Das Rohstoff-Preset (22 Futures) kommt aus src/universe/presets.ts; Kontraktwechsel bildet der Paper-Broker nicht ab.",
      risiko:
        "Futures haben Verfallsdaten und Rollover-Sprünge; ein Backtest über Kontraktgrenzen hinweg ist ohne Adjustierung wertlos. Rohstoffe reagieren zudem sprunghaft auf Lager- und Geopolitikdaten.",
    },
  },
  {
    id: "PENNY",
    label: "Penny Stocks (< 5 USD)",
    emoji: "⚠️",
    short: "Nur Penny Stocks / US-Smallcaps",
    description:
      "Spekulative US-Smallcaps unter 5 USD. Extrem chancen- und risikoreich: dünne Orderbücher, Verwässerung, Pump-and-Dump-Muster. Deshalb das kleinste Risikobudget aller Segmente.",
    rule:
      "assetClass = equity (Spot, ohne IBKR-Futures), zusätzlich zur Laufzeit Kurs < 5 USD und Volumenbestätigung aus dem Penny-Screener.",
    universeQuery: { assetClass: ["equity"], pageSize: 500 },
    filter: (i) => i.marketType === "spot" && i.venue !== "IBKR",
    maxCandidates: 8,
    suggestedRiskBudget: 0.005,
    suggestedMaxPositionPct: 0.05,
    runtimeFilterNote:
      "Die Preisgrenze „unter 5 USD“ prüft zur Laufzeit der Penny-Screener (Yahoo day_gainers/most_actives in src/lib/analysts.ts → runPennyScout) — die Registry führt keine Kurse.",
    help: {
      kurzinfo:
        "Die Mission sucht spekulative Kleinstwerte unter 5 USD — bewusst nur mit Mini-Positionen und Freigabeprozess.",
      technischeInfo:
        "Registry-Filter: assetClass=equity, marketType=spot, Venue ≠ IBKR. Die echte <5-USD-Prüfung plus Volumenbestätigung läuft im Penny-Desk (src/lib/analysts.ts: runPennyScout + runPennyDiligence, täglich nach US-Schluss).",
      risiko:
        "Penny Stocks können an einem Tag 50 % verlieren und sind oft nicht ohne Weiteres verkaufbar. Verwässerung und Pump-and-Dump sind die Regel — maximale Positionsgröße 5 % nicht anheben.",
    },
  },
  {
    id: "VOLATILE",
    label: "Hochvolatilität",
    emoji: "🌪️",
    short: "Nur Märkte mit hoher Volatilität",
    description:
      "Alle Märkte mit annualisierter Volatilität ab 60 %. Große Bewegungen in beide Richtungen — nur mit verkleinertem Risiko und breiteren Stops sinnvoll.",
    rule: "Beliebige Anlageklasse, volatility ≥ 0,60 (annualisiert) und Metrik vorhanden (nicht null).",
    universeQuery: { pageSize: 500 },
    filter: (i) => typeof i.volatility === "number" && i.volatility >= 0.6,
    maxCandidates: 8,
    suggestedRiskBudget: 0.006,
    suggestedMaxPositionPct: 0.08,
    help: {
      kurzinfo:
        "Die Mission konzentriert sich auf die unruhigsten Märkte — dort, wo sich Kurse besonders stark bewegen.",
      technischeInfo:
        "Filter: alle Instrumente, danach volatility ≥ 0,60. Die Metrik schreibt `npm run market:sync` (Enrichment) in die Registry; ohne Sync ist sie null und das Segment leer.",
      risiko:
        "Hohe Volatilität heißt nicht hohe Rendite: Ohne verkleinertes Risiko und ATR-basierte Stops werden Positionen von normalem Rauschen ausgestoppt.",
    },
  },
  {
    id: "LIQUID",
    label: "Top-Liquidität",
    emoji: "💧",
    short: "Nur sehr liquide Märkte",
    description:
      "Nur Märkte mit hohem 24h-Umsatz. Hier liegen Einstieg und Ausstieg am nächsten am angezeigten Kurs — die beste Wahl für den Start.",
    rule: "volume24h ≥ 10.000.000 (Quote-Währung) und Metrik vorhanden (nicht null).",
    universeQuery: { minVolume24h: 10_000_000, pageSize: 500 },
    maxCandidates: 12,
    suggestedRiskBudget: 0.01,
    suggestedMaxPositionPct: 0.2,
    help: {
      kurzinfo:
        "Die Mission handelt nur Märkte, in denen täglich viel Geld umgesetzt wird — dort ist der Ausstieg am zuverlässigsten.",
      technischeInfo:
        "Filter: InstrumentRegistry.query({ minVolume24h: 10000000 }). Instrumente mit volume24h = null fallen raus; die Metrik liefert `npm run market:sync`.",
      risiko:
        "Liquidität verschwindet in Stressphasen schneller, als die Tageszahl suggeriert. Ein hoher volume24h-Wert schützt nicht vor Slippage bei Nachrichten.",
    },
  },
];

/** Segment-Lookup nach ID (Groß-/Kleinschreibung egal). */
const SEGMENT_MAP: ReadonlyMap<string, MissionSegment> = new Map(
  MISSION_SEGMENTS.map((s) => [s.id, s])
);

/** Liefert ein Segment oder `null` — niemals einen stillen Default. */
export function findMissionSegment(raw: unknown): MissionSegment | null {
  if (typeof raw !== "string") return null;
  return SEGMENT_MAP.get(raw.trim().toUpperCase()) ?? null;
}

/** true, wenn `raw` eine bekannte Segment-ID ist. */
export function isMissionSegmentId(raw: unknown): raw is MissionSegmentId {
  return findMissionSegment(raw) !== null;
}

/**
 * Serialisierbare Segment-Projektion für API und UI.
 *
 * `universeQuery`/`filter` bleiben serverseitig (Funktionen sind nicht
 * JSON-fähig, und die Query-Details gehören nicht ins Browser-Bundle);
 * die UI bekommt `rule` als Klartext — derselbe Text wie im Prompt.
 */
export function missionSegmentDto(segment: MissionSegment) {
  return {
    id: segment.id,
    label: segment.label,
    emoji: segment.emoji,
    short: segment.short,
    description: segment.description,
    rule: segment.rule,
    maxCandidates: segment.maxCandidates,
    suggestedRiskBudget: segment.suggestedRiskBudget,
    suggestedMaxPositionPct: segment.suggestedMaxPositionPct,
    runtimeFilterNote: segment.runtimeFilterNote ?? null,
    help: segment.help,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) Risikoprofile — Klartext statt nackter Zahlen
// ─────────────────────────────────────────────────────────────────────────────

/** Grobe Einordnung einer Vorlage; rein informativ (erzwingt nichts). */
export const MISSION_RISK_PROFILES = [
  "MINIMAL",
  "DEFENSIV",
  "AUSGEWOGEN",
  "OFFENSIV",
  "STRESS",
] as const;
export type MissionRiskProfile = (typeof MISSION_RISK_PROFILES)[number];

/** Klartext + Tooltip je Profil (die UI zeigt beides direkt an der Vorlage). */
export const MISSION_RISK_PROFILE_LABELS: Record<
  MissionRiskProfile,
  { label: string; hint: string; help: MissionHelp }
> = {
  MINIMAL: {
    label: "Minimal",
    hint: "≤ 0,3 % Risiko pro Trade — Testen und Beobachten",
    help: {
      kurzinfo:
        "Fast kein Risiko: zum Ausprobieren der Pipeline, nicht zum Geldverdienen gedacht.",
      technischeInfo:
        "Vorlagen dieses Profils nutzen riskBudget ≤ 0,003 und maxPositionPct ≤ 0,05.",
      risiko:
        "Wer mit dem Minimal-Profil startet und später hochdreht, unterschätzt oft die Positionsgröße — das Budget immer schrittweise erhöhen.",
    },
  },
  DEFENSIV: {
    label: "Defensiv",
    hint: "≤ 1 % Risiko pro Trade — empfohlener Startwert",
    help: {
      kurzinfo:
        "Kleine Risiken, enge Regeln: der sinnvolle Standard für die ersten Wochen im Paper-Modus.",
      technischeInfo:
        "riskBudget ≤ 0,01 und maxPositionPct ≤ 0,20 — beides deutlich unter den Code-Deckeln (0,05 bzw. 0,5).",
      risiko:
        "Auch defensive Missionen verlieren in Serie; der eigentliche Schutz bleibt das Tagesverlust-Limit (dailyLossLimitPct).",
    },
  },
  AUSGEWOGEN: {
    label: "Ausgewogen",
    hint: "1–2 % Risiko pro Trade — Standard für geprüfte Setups",
    help: {
      kurzinfo:
        "Klassisches Trading-Risiko: genug Spielraum für normale Schwankungen, klein genug für Verlustserien.",
      technischeInfo:
        "riskBudget 0,01–0,02 und maxPositionPct bis 0,25; entspricht DEFAULT_LIMITS in src/lib/riskGuard.ts.",
      risiko:
        "2 % Risiko pro Trade bedeutet bei fünf Verlusten in Folge rund 10 % Drawdown — die Cooldown-Regel der Engine greift erst nach drei.",
    },
  },
  OFFENSIV: {
    label: "Offensiv",
    hint: "Spekulativ — nur mit Freigabeprozess",
    help: {
      kurzinfo:
        "Für spekulative Märkte wie Penny Stocks: kleine Positionen, aber hohe Einzelrisiken.",
      technischeInfo:
        "riskBudget bis 0,005 bei maxPositionPct ≤ 0,05; Ausführung zusätzlich über die Diligence-Freigabe (src/lib/analysts.ts).",
      risiko:
        "Offensiv heißt hier nicht „mehr Kapital“, sondern „höhere Ausfallwahrscheinlichkeit“. Ohne REQUIRE_HUMAN_APPROVAL=true nicht verwenden.",
    },
  },
  STRESS: {
    label: "Stresstest",
    hint: "Bewusst an den Code-Obergrenzen — nur zum Prüfen der Guardrails",
    help: {
      kurzinfo:
        "Diese Vorlage provoziert Absagen: Sie testet, ob die Sicherheitsgrenzen wirklich greifen.",
      technischeInfo:
        "riskBudget 0,05 und maxPositionPct 0,5 = exakt LIMIT_CEILINGS (src/lib/riskGuard.ts). Das Ergebnis steht als ORDER_REJECTED im audit_log.",
      risiko:
        "Niemals mit echtem Kapital oder geöffnetem Live-Gate verwenden. Nach dem Test die Mission auf COMPLETED setzen, damit sie nicht weiterläuft.",
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 5) Vorlagen-Katalog
// ─────────────────────────────────────────────────────────────────────────────

/** Kategorien der Vorlagen (Gruppierung in der Auswahlliste). */
export const MISSION_TEMPLATE_CATEGORIES = [
  "EINSTIEG",
  "MARKT_SCAN",
  "STRATEGIE",
  "DIAGNOSE",
] as const;
export type MissionTemplateCategory = (typeof MISSION_TEMPLATE_CATEGORIES)[number];

/** Deutsche Bezeichnung der Kategorien. */
export const MISSION_TEMPLATE_CATEGORY_LABELS: Record<MissionTemplateCategory, string> = {
  EINSTIEG: "Einstieg & Einzelwerte",
  MARKT_SCAN: "Markt-Scans (Segment)",
  STRATEGIE: "Strategien",
  DIAGNOSE: "Diagnose & Tests",
};

/**
 * Eine wiederverwendbare Missions-Vorlage.
 *
 * Vorlagen sind **Blaupausen**, keine laufenden Aufträge: „Vorlage übernehmen“
 * füllt das Formular, der Mensch prüft und speichert. `seeded: true` markiert
 * die 14 Missionen, die bei der Installation automatisch angelegt werden
 * (`src/lib/seed.ts` → `ensureSeeded()`).
 */
export interface MissionTemplate {
  /** Slug, z. B. `scan-all-markets`. Landet in `missions.template_id`. */
  id: string;
  /** Anzeigename der Vorlage (nicht identisch mit dem Missions-Titel). */
  name: string;
  /** Gruppe in der Auswahlliste. */
  category: MissionTemplateCategory;
  /** Missions-Typ. */
  scope: MissionScope;
  /** Segment bei `SCAN_UNIVERSE`, sonst `null`. */
  segment: MissionSegmentId | null;
  /** Symbol bei `SINGLE_SYMBOL`, sonst `null`. */
  symbol: string | null;
  /** Missions-Titel. MUSS eindeutig sein — der Seed erkennt Duplikate am Titel. */
  title: string;
  /** Auftragstext mit prüfbaren Regeln (Handbuch 5.2). */
  objective: string;
  /** Risikobudget als Bruchteil (0.01 = 1 %). */
  riskBudget: number;
  /** Maximale Positionsgröße als Bruchteil (0.15 = 15 %). */
  maxPositionPct: number;
  /** Grobe Risikoeinordnung. */
  riskProfile: MissionRiskProfile;
  /** true → wird bei der Installation bzw. „Seed / Reset“ angelegt. */
  seeded: boolean;
  /** Warum diese Mission sinnvoll ist (Tooltip, Doku). */
  why: string;
  /**
   * Erfolgskriterium, das sich mit SQL prüfen lässt — die Faustregel aus
   * Handbuch 5.2 („nicht in SQL prüfbar → zu vage“) direkt an der Vorlage.
   */
  successCriteria: string;
  /** Tooltip-Inhalt (3 Ebenen). */
  help: MissionHelp;
}

/**
 * Der Vorlagen-Katalog.
 *
 * Die ersten vier Einträge sind die historischen Standard-Mandate — ihre Titel
 * bleiben bewusst unverändert, weil `ensureSeeded()` bestehende Installationen
 * am Titel erkennt und nichts doppelt anlegt. Die Einträge 5–14 ergänzen die
 * Markt-Scans und Diagnosemandate (insgesamt 14 mit `seeded: true`);
 * `seeded: false` markiert Zusatzvorlagen, die nur im Workshop auswählbar sind.
 */
export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
  // ── Historische Standard-Mandate (Titel nicht ändern!) ────────────────────
  {
    id: "paper-btc-long-only",
    name: "Paper-Start: BTC Long-Only",
    category: "EINSTIEG",
    scope: "SINGLE_SYMBOL",
    segment: null,
    symbol: "BTC",
    title: "Erste Paper-Mission: BTC Long-Only",
    objective:
      "Nur Long in BTC. Maximal 25 % des Kapitals pro Position, Stop-Loss verpflichtend, " +
      "kein Hebel, keine Shorts. Ziel ist das Validieren der Pipeline, nicht die Rendite.",
    riskBudget: 0.02,
    maxPositionPct: 0.25,
    riskProfile: "AUSGEWOGEN",
    seeded: true,
    why:
      "Die erste Mission überhaupt: ein liquider Markt, nur Long, klare Grenzen. Damit läuft die " +
      "Pipeline einmal komplett durch, bevor irgendetwas anderes dazukommt.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND (side <> 'LONG' OR stop_loss IS NULL) → 0",
    help: {
      kurzinfo: "Der Klassiker zum Start: nur Bitcoin, nur Long, harte Obergrenzen.",
      technischeInfo:
        "scope=SINGLE_SYMBOL, symbol=BTC, riskBudget 2 %, maxPositionPct 25 % — alles innerhalb der LIMIT_CEILINGS.",
      risiko:
        "25 % Positionsgröße ist für den Anfang viel; wer echte Schwankungen erleben will, startet mit 10 %.",
    },
  },
  {
    id: "watch-spy",
    name: "Beobachtung: SPY",
    category: "EINSTIEG",
    scope: "SINGLE_SYMBOL",
    segment: null,
    symbol: "SPY",
    title: "Beobachtungsmandat: SPY",
    objective:
      "Beobachte SPY und melde Setups. Handle nur bei klarem Trendsignal, sonst HOLD. " +
      "Gleiche harte Grenzen wie in der BTC-Mission.",
    riskBudget: 0.01,
    maxPositionPct: 0.2,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Ein Markt als Referenz: SPY bewegt sich ruhig, liefert verlässliche Daten und eignet sich, " +
      "um Prompt-Änderungen ohne Handelslärm zu beurteilen.",
    successCriteria:
      "Protokoll zeigt überwiegend REPORT/HOLD; SELECT count(*) FROM positions WHERE mission_id = ? AND created_at > now() - interval '7 days' → klein",
    help: {
      kurzinfo: "Die Firma beobachtet den breiten US-Markt und handelt nur bei klarem Trend.",
      technischeInfo: "scope=SINGLE_SYMBOL, symbol=SPY, riskBudget 1 %, maxPositionPct 20 %.",
      risiko:
        "„Beobachten“ ist kein Selbstzweck: Ohne dokumentierte Regel, wann gehandelt wird, liefert die Mission nur Rauschen.",
    },
  },
  {
    id: "swing-multi-asset",
    name: "Swing-Research Multi-Asset",
    category: "MARKT_SCAN",
    scope: "SCAN_UNIVERSE",
    segment: "ALL",
    symbol: null,
    title: "Swing-Research: Multi-Asset (Tage bis Wochen)",
    // v1.35.0: prüfbare Regeln ergänzt (Haltedauer, Positionsanzahl, Stop-Band).
    // Titel unverändert — bestehende Installationen behalten ihre Fassung.
    objective:
      "Swing-Setups über das Research-Universum identifizieren und dokumentieren: Haltedauer 3 bis 15 " +
      "Handelstage, höchstens 3 gleichzeitig offene Positionen, Stop-Loss 5–9 %. Ausführung nur über die " +
      "normale Pipeline mit allen Guardrails; ohne sauberes Setup HOLD antworten statt zu raten.",
    riskBudget: 0.015,
    maxPositionPct: 0.2,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Swing-Handel (Tage bis Wochen) passt zu kleinen Modellen: wenige Entscheidungen, viel Zeit " +
      "für die Prüfung, geringe Latenzanforderung.",
    successCriteria:
      "SELECT avg(updated_at - created_at) FROM positions WHERE mission_id = ? AND status = 'CLOSED' → mehrere Tage",
    help: {
      kurzinfo:
        "Die Firma sucht über alle Märkte hinweg Setups mit einigen Tagen bis Wochen Haltedauer.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=ALL; die Kandidaten kommen aus src/lib/missionUniverse.ts (Registry-Query), nicht aus einer festen Liste.",
      risiko:
        "Über-Nacht-Positionen tragen Gap-Risiko: Ein Stop-Loss greift erst zum nächsten Kurs, nicht zum gewünschten Preis.",
    },
  },
  {
    id: "penny-desk-mini",
    name: "Penny-Desk (Mini-Risiko)",
    category: "STRATEGIE",
    scope: "SCAN_UNIVERSE",
    segment: "PENNY",
    symbol: null,
    title: "⚠️ PENNY-DESK: Spekulative US-Smallcaps < $5 (MINI-RISIKO)",
    objective:
      "Penny-Kandidaten des Scout-Teams beobachten. EXTREM spekulativ: maximale Positionsgröße 5 %, " +
      "Risiko pro Trade max 0,5 %. Nur mit Diligence-Freigabe und volumenbestätigtem Setup.",
    riskBudget: 0.005,
    maxPositionPct: 0.05,
    riskProfile: "OFFENSIV",
    seeded: true,
    why:
      "Zeigt die spekulative Seite des Systems — und wie man sie einhegt: Mini-Positionen, " +
      "Volumenbestätigung, Pflicht-Freigabe durch die Diligence-Rolle.",
    successCriteria:
      "SELECT max(qty * entry_price) FROM positions WHERE mission_id = ? → ≤ 5 % des aktuellen Equity",
    help: {
      kurzinfo: "Kleinstwerte unter 5 USD — nur mit Mini-Positionen und zweiter Meinung.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=PENNY. Kandidaten liefert der Penny-Screener (src/lib/analysts.ts: runPennyScout/runPennyDiligence, täglich nach US-Schluss).",
      risiko:
        "Totalverluste sind hier normal. Positionsgröße 5 % und Risiko 0,5 % niemals anheben; ohne REQUIRE_HUMAN_APPROVAL=true nicht aktivieren.",
    },
  },

  // ── Markt-Scans (neu in v1.35.0) ──────────────────────────────────────────
  {
    id: "scan-all-markets",
    name: "Markt-Scan: Alle Märkte",
    category: "MARKT_SCAN",
    scope: "SCAN_UNIVERSE",
    segment: "ALL",
    symbol: null,
    title: "Markt-Scan: Alle Märkte — täglich maximal drei Setups",
    objective:
      "Scanne das gesamte freigegebene Universum (alle Anlageklassen) und melde höchstens drei Setups " +
      "pro Berliner Kalendertag. Nur Long, Stop-Loss 3–8 %, Einstieg nur wenn das Volumen mindestens " +
      "das 1,5-Fache des 20-Perioden-Schnitts erreicht. Erfüllt kein Kandidat alle Punkte, antworte " +
      "HOLD statt das beste verfügbare Setup zu nehmen. Kein Hebel, keine Nachkäufe in dieselbe Position.",
    riskBudget: 0.01,
    maxPositionPct: 0.1,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Der eigentliche „Alle Märkte scannen“-Auftrag: breit suchen, streng auswählen. Das Tageslimit " +
      "von drei Setups verhindert, dass die Firma quer durch alle Regimes gleichzeitig handelt.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND created_at >= date_trunc('day', now()) → ≤ 3",
    help: {
      kurzinfo: "Sucht in allen Märkten nach Setups, nimmt aber höchstens drei pro Tag.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=ALL. Die Kandidatenliste (max. 12, nach 24h-Volumen sortiert) steht als UNIVERSUM-Zeile im Agenten-Prompt; Trades außerhalb dieser Liste blockt die Engine (MISSION_SCOPE_VIOLATION).",
      risiko:
        "Ein breiter Scan findet immer irgendetwas — die Qualität kommt aus den Filtern im Zieltext, nicht aus der Breite der Liste.",
    },
  },
  {
    id: "indices-trend-follow",
    name: "Indizes & ETFs: Trendfolge",
    category: "MARKT_SCAN",
    scope: "SCAN_UNIVERSE",
    segment: "INDICES",
    symbol: null,
    title: "Indizes & ETFs: Trendfolge über der 50-Tage-Linie",
    objective:
      "Nur Long auf Indizes und Index-ETFs, nur wenn der Schlusskurs über dem 50-Tage-Durchschnitt " +
      "liegt und EMA9 über EMA21 notiert. Stop-Loss 4–7 %, maximal eine Position pro Basiswert, keine " +
      "Nachkäufe. Wechselt die EMA9/EMA21-Reihenfolge innerhalb von zehn Tagen zweimal, gilt der Markt " +
      "als Seitwärts: HOLD antworten.",
    riskBudget: 0.01,
    maxPositionPct: 0.2,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Trendfolge auf breiten Indizes ist die am besten dokumentierte und robusteste " +
      "Einsteigerstrategie — wenige Trades, klare Regel, leicht nachzuprüfen.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND side <> 'LONG' → 0; Einstiege nur über der 50-Tage-Linie",
    help: {
      kurzinfo: "Kauft breite Märkte nur, wenn sie nachweisbar steigen.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=INDICES (assetClass index/etf). Die Durchschnittslinien liefert der Indikator-Layer (src/lib/indicators.ts, snapshot()).",
      risiko:
        "Trendfolge verliert in Seitwärtsmärkten durch viele kleine Stops; die Seitwärts-Regel im Zieltext ist Pflicht, nicht Dekoration.",
    },
  },
  {
    id: "crypto-momentum-247",
    name: "Krypto 24/7: Momentum",
    category: "MARKT_SCAN",
    scope: "SCAN_UNIVERSE",
    segment: "CRYPTO",
    symbol: null,
    title: "Krypto 24/7: Momentum mit ATR-Stop",
    objective:
      "Krypto rund um die Uhr, nur Long. Einstieg nur bei gestaffeltem Aufwärtstrend " +
      "(EMA9 > EMA21 > EMA50) und RSI zwischen 50 und 70. Stop-Loss aus ATR × 2, mindestens 4 % und " +
      "höchstens 10 %. Maximal zwei gleichzeitig offene Positionen aus dieser Mission, kein Hebel. " +
      "RSI über 75 oder fehlende Kerzendaten: HOLD antworten.",
    riskBudget: 0.015,
    maxPositionPct: 0.15,
    riskProfile: "AUSGEWOGEN",
    seeded: true,
    why:
      "Krypto läuft auch am Wochenende — ideal, um die Firma außerhalb der Börsenzeiten zu " +
      "beobachten, solange Risiko und Positionsanzahl gedeckelt bleiben.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND status = 'OPEN' → ≤ 2; jede Position hat stop_loss NOT NULL",
    help: {
      kurzinfo: "Handelt Krypto-Trends zu jeder Tageszeit, mit Stop aus der Marktschwankung.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=CRYPTO. ATR-Stop: atrPercent × atrStopMultiplier (DEFAULT_LIMITS.atrStopMultiplier = 2), geklemmt auf 0,5–50 %.",
      risiko:
        "Krypto gappt ohne Vorwarnung; zwei offene Positionen mit 1,5 % Risiko sind bereits 3 % Kontorisiko pro Bewegung.",
    },
  },
  {
    id: "equity-largecap-quality",
    name: "US-Large-Caps: ein Trade pro Tag",
    category: "MARKT_SCAN",
    scope: "SCAN_UNIVERSE",
    segment: "EQUITIES",
    symbol: null,
    title: "US-Large-Caps: Qualitätstrend, maximal ein Trade pro Tag",
    objective:
      "Nur liquide US-Large-Caps, nur Long, höchstens ein neuer Trade pro Berliner Kalendertag. " +
      "Einstieg nur über der 20-Tage-Linie und nur mit volumenbestätigtem Ausbruch, Stop-Loss 3–6 %. " +
      "Keine Eröffnungen in den letzten 30 Minuten vor US-Schluss. Notiert SPY unter der " +
      "50-Tage-Linie, antworte HOLD.",
    riskBudget: 0.01,
    maxPositionPct: 0.2,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Ein einziger gut geprüfter Trade pro Tag schlägt zehn hastige: Das Tageslimit erzwingt " +
      "Auswahl und macht die Entscheidungsqualität messbar.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND created_at >= date_trunc('day', now()) → ≤ 1",
    help: {
      kurzinfo: "Handelt große US-Aktien, aber bewusst nur einmal am Tag.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=EQUITIES (assetClass=equity). Der Marktfilter „SPY unter 50-Tage-Linie“ steht als Regel im Prompt.",
      risiko:
        "Einzelaktien reagieren auf Quartalszahlen mit Kurslücken; der Marktfilter ersetzt keine Prüfung des Terminplans.",
    },
  },
  {
    id: "fx-mean-reversion",
    name: "Devisen: Mean-Reversion",
    category: "STRATEGIE",
    scope: "SCAN_UNIVERSE",
    segment: "FX",
    symbol: null,
    title: "Devisen: Mean-Reversion an Extremen",
    objective:
      "Nur große Währungspaare (EUR/USD, USD/JPY, GBP/USD). Einstieg nur bei RSI unter 25 oder über 75 " +
      "und erkennbarer Rückkehr zur 20-Perioden-Linie. Stop-Loss 1,5–3 %, Ziel mindestens das " +
      "1,5-Fache des Risikos. Short nur, wenn die Konfiguration Shorts erlaubt (allowShort) — sonst " +
      "ausschließlich Long. Keine Eröffnungen in den 15 Minuten nach Zins- oder Inflationsdaten; " +
      "ohne klares Extrem HOLD antworten.",
    riskBudget: 0.008,
    maxPositionPct: 0.15,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Währungspaare pendeln häufiger um einen Mittelwert, als sie trenden — Mean-Reversion passt " +
      "damit besser zu diesem Segment als Trendfolge.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND side = 'SHORT' → 0, solange risk_config.allowShort = 0",
    help: {
      kurzinfo:
        "Kauft überverkaufte und verkauft überkaufte Währungspaare — nur an klaren Extremen.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=FX (assetClass=fx, Notation EURUSD=X). Shorts blockt die Engine zusätzlich hart, wenn riskLimits.allowShort = false.",
      risiko:
        "Mean-Reversion kauft in fallende Messer: Ohne engen Stop wird aus der „Rückkehr zum Mittelwert“ ein Dauerverlust.",
    },
  },
  {
    id: "commodities-trend",
    name: "Rohstoffe: Trend, halbes Risiko",
    category: "MARKT_SCAN",
    scope: "SCAN_UNIVERSE",
    segment: "COMMODITIES",
    symbol: null,
    title: "Rohstoffe: Trendfolge mit halbiertem Risiko",
    objective:
      "Rohstoffe (Gold, Silber, Öl, Gas) nur mit halbiertem Standardrisiko. Nur Long bei " +
      "Aufwärtstrend und ATR unter 4 % des Kurses; Stop-Loss 5–9 %. Keine Position über einen " +
      "Kontraktwechsel hinweg halten, solange der Adapter Rollover nicht abbildet. Bei Datenlücken im " +
      "Markt-Data-Layer HOLD antworten statt zu schätzen.",
    riskBudget: 0.008,
    maxPositionPct: 0.1,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Rohstoffe diversifizieren ein Aktien-/Krypto-Portfolio, reagieren aber sprunghaft auf " +
      "Makrodaten — halbes Risiko ist hier die ehrliche Antwort.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND risk_notional > 0.008 × equity → 0",
    help: {
      kurzinfo: "Handelt Rohstoff-Trends mit bewusst kleinerem Risiko als andere Segmente.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=COMMODITIES (assetClass=commodity, IBKR-Futures aus src/universe/presets.ts).",
      risiko:
        "Futures verfallen und werden gerollt; ein Paper-Broker ohne Rollover-Abbildung liefert verzerrte Ergebnisse.",
    },
  },
  {
    id: "volatile-half-risk",
    name: "Hochvolatilität: halbes Risiko",
    category: "STRATEGIE",
    scope: "SCAN_UNIVERSE",
    segment: "VOLATILE",
    symbol: null,
    title: "Hochvolatilität: nur mit halbiertem Risiko",
    objective:
      "Märkte mit annualisierter Volatilität über 60 % nur mit höchstens 0,6 % Risiko pro Trade und " +
      "höchstens 8 % Positionsgröße. Stop-Loss aus ATR × 2,5, mindestens 6 %. Maximal eine " +
      "gleichzeitig offene Position aus dieser Mission. Meldet das adaptive Risk-Limit das Regime " +
      "EXTREME, antworte HOLD.",
    riskBudget: 0.006,
    maxPositionPct: 0.08,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Zeigt, wie man volatile Märkte handelt, ohne das Konto zu riskieren: kleinere Position, " +
      "breiterer Stop, eine Position zur Zeit.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND status = 'OPEN' → ≤ 1",
    help: {
      kurzinfo: "Nur die unruhigsten Märkte — und dort mit deutlich kleineren Positionen.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=VOLATILE (volatility ≥ 0,60; Metrik aus `npm run market:sync`). Die Regime-Info liefert src/lib/adaptiveRisk.ts im Prompt-Kontext.",
      risiko:
        "Ohne Sync bleibt die Volatilitätsmetrik leer und das Segment findet nichts — eine leere Liste ist ein Datenproblem, kein Handelssignal.",
    },
  },
  {
    id: "liquidity-mandate",
    name: "Liquiditäts-Mandat",
    category: "MARKT_SCAN",
    scope: "SCAN_UNIVERSE",
    segment: "LIQUID",
    symbol: null,
    title: "Liquiditäts-Mandat: nur Top-Liquidität",
    objective:
      "Nur Instrumente mit 24h-Volumen über 10 Mio. USD und relativem Spread unter 10 bp. Nur Long, " +
      "Stop-Loss 3–6 %, maximal 20 % des Kapitals pro Position. Fehlt die Volumen- oder Spread-Metrik " +
      "(null), gilt das Instrument als nicht handelbar: HOLD antworten. Keine Nachkäufe.",
    riskBudget: 0.01,
    maxPositionPct: 0.2,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Der sicherste Markt-Scan: Wo viel gehandelt wird, liegen Einstieg und Ausstieg am nächsten " +
      "am angezeigten Kurs — ideal für belastbare Auswertungen.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND symbol NOT IN (Kandidaten mit volume24h > 10 Mio.) → 0",
    help: {
      kurzinfo:
        "Handelt nur Märkte mit hohem Tagesumsatz — weniger Slippage, sauberere Ergebnisse.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=LIQUID (InstrumentRegistry.query({ minVolume24h: 10000000 })). Instrumente ohne Metrik fallen automatisch raus.",
      risiko:
        "Die Volumenmetrik ist ein Tageswert aus dem letzten Sync; in Stressphasen gilt er nicht mehr.",
    },
  },
  {
    id: "eth-trend-defensive",
    name: "ETH Trendfolge, defensiv",
    category: "EINSTIEG",
    scope: "SINGLE_SYMBOL",
    segment: null,
    symbol: "ETH",
    title: "ETH Trendfolge, defensiv",
    objective:
      "Nur Long in ETH und nur bei klarem Aufwärtstrend. Stop-Loss zwischen 4 und 7 Prozent. Keine " +
      "Nachkäufe. Bei unklarer Lage HOLD antworten statt zu handeln. Ziel ist Prozesstreue, nicht " +
      "Rendite.",
    riskBudget: 0.01,
    maxPositionPct: 0.15,
    riskProfile: "DEFENSIV",
    seeded: true,
    why:
      "Das Beispiel aus Handbuch 5.1 als fertige Vorlage — die Referenz dafür, wie ein prüfbarer " +
      "Zieltext aussieht.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND (side <> 'LONG' OR stop_loss IS NULL) → 0",
    help: {
      kurzinfo: "Ethereum nur im Aufwärtstrend, mit festem Stop-Band und ohne Nachkäufe.",
      technischeInfo: "scope=SINGLE_SYMBOL, symbol=ETH, riskBudget 1 %, maxPositionPct 15 %.",
      risiko:
        "Auch ein sauberer Trend endet abrupt; der Stop-Bereich 4–7 % muss zur aktuellen ATR passen, sonst stoppt Rauschen aus.",
    },
  },
  {
    id: "baseline-hold",
    name: "Baseline: HOLD-Pflicht",
    category: "DIAGNOSE",
    scope: "SINGLE_SYMBOL",
    segment: null,
    symbol: "SPY",
    title: "Baseline: HOLD-Pflicht (JSON- und Prompt-Test)",
    objective:
      "Diagnose-Mission: Auf jede Anfrage mit HOLD antworten, Begründung in einem Satz, riskScore 0. " +
      "Es wird bewusst nie gehandelt. Zweck ist, JSON-Format, Modellqualität und Trefferquote zu " +
      "messen (Workshop Schritt 4). Jede TRADE-, APPROVE- oder KILL-Antwort ist ein Prompt-Fehler und " +
      "gehört unverändert ins Protokoll.",
    riskBudget: 0.002,
    maxPositionPct: 0.01,
    riskProfile: "MINIMAL",
    seeded: true,
    why:
      "Die Messlatte für den Workshop: Läuft die HOLD-Baseline sauber, sind Modell und Prompt gesund " +
      "— jeder INVALID_JSON-Treffer fällt sofort auf.",
    successCriteria:
      "Trefferquote (Workshop Schritt 4): 100 % HOLD, 0 % INVALID_JSON; SELECT count(*) FROM positions WHERE mission_id = ? → 0",
    help: {
      kurzinfo: "Eine Mission, die nie handelt — sie prüft, ob die Modelle sauber antworten.",
      technischeInfo:
        "riskBudget 0,2 % und maxPositionPct 1 % = Code-Minima (LIMIT_CEILINGS). Auswertung über classifyTurnOutcome/aggregateOutcomes (src/lib/workshop.ts).",
      risiko:
        "Wer die Baseline als Handelsmission missversteht, wartet vergeblich auf Trades. Sie gehört nach der Messung auf COMPLETED.",
    },
  },

  // ── Zusatzvorlagen (nicht Teil des Seeds) ─────────────────────────────────
  {
    id: "guardrail-stress-test",
    name: "Stresstest: Guardrails prüfen",
    category: "DIAGNOSE",
    scope: "SINGLE_SYMBOL",
    segment: null,
    symbol: "BTC",
    title: "Stresstest: Guardrails bewusst auslösen (nur Paper)",
    objective:
      "Bewusst überdimensionierte Test-Mission: 5 % Risiko pro Trade und 50 % Positionsgröße — exakt " +
      "die Code-Obergrenzen. Ziel ist der Nachweis, dass Engine-Validierung, riskGuard und " +
      "Broker-Schleuse unabhängig voneinander blockieren. Jede Ablehnung muss als ORDER_REJECTED im " +
      "audit_log erscheinen. Nie mit echtem Kapital verwenden; nach dem Test auf COMPLETED setzen.",
    riskBudget: 0.05,
    maxPositionPct: 0.5,
    riskProfile: "STRESS",
    seeded: false,
    why:
      "Der Nachweis, dass die Sicherheitskette trägt — Handbuch Schritt 6 („Guardrails bewusst " +
      "auslösen“) als wiederverwendbare Vorlage.",
    successCriteria:
      "SELECT count(*) FROM audit_log WHERE event = 'ORDER_REJECTED' AND mission_id = ? → ≥ 1",
    help: {
      kurzinfo:
        "Provoziert absichtlich zu große Orders, um zu prüfen, ob die Sicherheitsgrenzen greifen.",
      technischeInfo:
        "riskBudget 0,05 und maxPositionPct 0,5 = exakt LIMIT_CEILINGS (src/lib/riskGuard.ts). Die Klemmung passiert in missionSizedNotional(), die Ablehnung im audit_log.",
      risiko:
        "Nur im Paper-Modus und mit geschlossenem Live-Gate verwenden. Bleibt die Mission aktiv, handelt sie mit den größten erlaubten Werten weiter.",
    },
  },
  {
    id: "shortlist-only",
    name: "Nur Shortlist: melden, nie handeln",
    category: "DIAGNOSE",
    scope: "SCAN_UNIVERSE",
    segment: "ALL",
    symbol: null,
    title: "Research-only: Shortlist melden, keine Orders",
    objective:
      "Reine Research-Mission: Kandidaten aus dem Universum als REPORT melden, niemals eine Order " +
      "vorschlagen. Maximal 5 Kandidaten pro Lauf mit Symbol, Richtung, Begründung und Risiko. " +
      "Jede TRADE- oder APPROVE-Antwort widerspricht dem Auftrag und wird als Prompt-Fehler " +
      "protokolliert. Die Ausführung bleibt der regulären Pipeline vorbehalten.",
    riskBudget: 0.002,
    maxPositionPct: 0.01,
    riskProfile: "MINIMAL",
    seeded: false,
    why:
      "Trennt Research von Ausführung: Die Analysequalität wird messbar, ohne dass überhaupt " +
      "Positionen entstehen.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? → 0; agent_messages enthält REPORT-Einträge",
    help: {
      kurzinfo: "Die Firma liefert nur Ideen — gehandelt wird bewusst nichts.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=ALL bei Code-Minima (riskBudget 0,2 %, Position 1 %). Rollenprüfung: Nur EXECUTOR/RESEARCH dürften Orders auslösen (engine.ts).",
      risiko:
        "Auch ohne Orders gilt: Ideen sind keine Empfehlung. Die Protokolleinträge ersetzen kein Backtest-Ergebnis.",
    },
  },
  {
    id: "news-event-shield",
    name: "Event-Schutz um Makro-Termine",
    category: "STRATEGIE",
    scope: "SINGLE_SYMBOL",
    segment: null,
    symbol: "SPY",
    title: "Event-Schutz: keine Trades um Makro-Termine",
    objective:
      "Um Makro-Termine (Zinsentscheid, Inflationsdaten, Arbeitsmarktzahlen) 60 Minuten vorher und " +
      "30 Minuten danach keine neuen Positionen eröffnen. Außerhalb dieser Fenster nur Long über der " +
      "20-Tage-Linie, Stop-Loss 3–5 %. Ist der Terminplan unklar, antworte HOLD statt zu raten.",
    riskBudget: 0.005,
    maxPositionPct: 0.1,
    riskProfile: "DEFENSIV",
    seeded: false,
    why:
      "Die meisten unerklärlichen Verluste kleiner Systeme entstehen rund um Datenveröffentlichungen " +
      "— diese Vorlage macht die Sperrzeiten zur Regel.",
    successCriteria:
      "Keine Position mit created_at innerhalb ±60/30 min eines Makro-Termins (audit_log/positions-Abgleich)",
    help: {
      kurzinfo: "Handelt nicht rund um Zins- und Inflationstermine, sondern wartet ab.",
      technischeInfo:
        "scope=SINGLE_SYMBOL, symbol=SPY. Die Terminlogik steht als Regel im Zieltext; der Makro-Kontext kommt aus src/lib/macroCycle.ts bzw. den Analysten.",
      risiko:
        "Sperrfenster schützen vor Eintrittsrauschen, nicht vor Bestandspositionen — offene Positionen brauchen weiterhin Stops.",
    },
  },
  {
    id: "correlation-guard",
    name: "Korrelations-Wächter",
    category: "STRATEGIE",
    scope: "SCAN_UNIVERSE",
    segment: "LIQUID",
    symbol: null,
    title: "Korrelations-Wächter: keine Klumpenrisiken",
    objective:
      "Maximal zwei gleichzeitig offene Positionen aus dieser Mission und keine zwei Positionen, " +
      "deren 30-Tage-Korrelation über 0,8 liegt. Nur Long, Stop-Loss 3–6 %, maximal 15 % des Kapitals " +
      "pro Position. Ist die Korrelationsmatrix nicht verfügbar (Datenlücke), gilt: höchstens eine " +
      "Position, sonst HOLD.",
    riskBudget: 0.008,
    maxPositionPct: 0.15,
    riskProfile: "DEFENSIV",
    seeded: false,
    why:
      "Viele kleine Positionen sind keine Diversifikation, wenn sie sich gleich bewegen — diese " +
      "Vorlage erzwingt den Blick auf die Korrelation.",
    successCriteria:
      "SELECT count(*) FROM positions WHERE mission_id = ? AND status = 'OPEN' → ≤ 2; keine Paar-Korrelation > 0,8",
    help: {
      kurzinfo: "Verhindert, dass mehrere Positionen dasselbe Risiko doppelt tragen.",
      technischeInfo:
        "scope=SCAN_UNIVERSE, segment=LIQUID. Korrelationsdaten liefert die Portfolio-Analytics (src/portfolio/, Korrelationsmatrix über 30 Tagesrenditen).",
      risiko:
        "Korrelationen springen in Krisen gegen 1 — die geglaubte Streuung verschwindet genau dann, wenn sie gebraucht wird.",
    },
  },
];

/** Format der Vorlagen-Slugs (klein, Bindestriche, 3–64 Zeichen). */
export const MISSION_TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

/** Alle Vorlagen-IDs in Katalog-Reihenfolge (Fehlermeldungen, Doku, Tests). */
export const MISSION_TEMPLATE_IDS: readonly string[] = MISSION_TEMPLATES.map((t) => t.id);

/** Vorlagen-Lookup nach ID. */
const TEMPLATE_MAP: ReadonlyMap<string, MissionTemplate> = new Map(
  MISSION_TEMPLATES.map((t) => [t.id, t])
);

/** Liefert eine Vorlage oder `null` (unbekannte IDs werden nie erfunden). */
export function findMissionTemplate(raw: unknown): MissionTemplate | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  return TEMPLATE_MAP.get(id) ?? null;
}

/** Die Vorlagen, die bei der Installation angelegt werden (14 Stück). */
export function seededMissionTemplates(): MissionTemplate[] {
  return MISSION_TEMPLATES.filter((t) => t.seeded);
}

/**
 * Serialisierbare Vorlagen-Projektion für `GET /api/firm/missions` und die UI.
 * Enthält alles, was das Formular zum Vorausfüllen braucht — inklusive der
 * Drei-Ebenen-Hilfe für die Tooltips.
 */
export function missionTemplateDto(template: MissionTemplate) {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    categoryLabel: MISSION_TEMPLATE_CATEGORY_LABELS[template.category],
    scope: template.scope,
    scopeLabel: MISSION_SCOPE_LABELS[template.scope],
    segment: template.segment,
    segmentLabel: template.segment ? findMissionSegment(template.segment)?.label ?? null : null,
    symbol: template.symbol,
    title: template.title,
    objective: template.objective,
    riskBudget: template.riskBudget,
    maxPositionPct: template.maxPositionPct,
    riskProfile: template.riskProfile,
    riskProfileLabel: MISSION_RISK_PROFILE_LABELS[template.riskProfile].label,
    riskProfileHint: MISSION_RISK_PROFILE_LABELS[template.riskProfile].hint,
    seeded: template.seeded,
    why: template.why,
    successCriteria: template.successCriteria,
    help: template.help,
  };
}

export type MissionTemplateDto = ReturnType<typeof missionTemplateDto>;

/**
 * Vollständiger Missions-Entwurf aus einer Vorlage — die Form, die
 * `validateMissionInput()` akzeptiert bzw. die der Seed direkt schreibt.
 *
 * `overrides` erlaubt gezielte Anpassungen (z. B. anderer Titel beim zweiten
 * Einsatz derselben Vorlage); unbekannte Schlüssel werden ignoriert.
 */
export function templateToMissionDraft(
  template: MissionTemplate,
  overrides: Partial<{
    title: string;
    objective: string;
    symbol: string | null;
    segment: MissionSegmentId | null;
    riskBudget: number;
    maxPositionPct: number;
    status: string;
  }> = {}
) {
  return {
    title: overrides.title ?? template.title,
    objective: overrides.objective ?? template.objective,
    symbol: overrides.symbol !== undefined ? overrides.symbol : template.symbol,
    scope: template.scope,
    segment: overrides.segment !== undefined ? overrides.segment : template.segment,
    templateId: template.id,
    riskBudget: overrides.riskBudget ?? template.riskBudget,
    maxPositionPct: overrides.maxPositionPct ?? template.maxPositionPct,
    status: overrides.status ?? "PENDING",
  };
}

/**
 * Füllt fehlende Formularfelder aus einer Vorlage.
 *
 * Damit genügt `POST /api/firm/missions {"templateId":"scan-all-markets"}`,
 * um eine vollständige Mission anzulegen — praktisch für curl, Skripte und
 * Tests. Bereits gesetzte Felder des Aufrufers gewinnen immer (eine Vorlage
 * überschreibt keine bewusste Eingabe).
 *
 * @returns zusammengeführter Body, Vorlagen-ID und Warnungen (z. B. unbekannte ID)
 */
export function applyMissionTemplate(raw: unknown): {
  payload: Record<string, unknown>;
  templateId: string | null;
  warnings: string[];
} {
  const body: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  const warnings: string[] = [];
  const rawId = typeof body.templateId === "string" ? body.templateId.trim() : "";
  if (!rawId) return { payload: body, templateId: null, warnings };

  const template = findMissionTemplate(rawId);
  if (!template) {
    warnings.push(
      `Unbekannte Vorlage „${rawId.slice(0, 40)}“ — das Formular wurde nicht vorausgefüllt.`
    );
    return { payload: body, templateId: null, warnings };
  }

  const draft = templateToMissionDraft(template);
  // Nur leere Felder ergänzen: bewusste Eingaben haben Vorrang.
  const fillIfEmpty = (key: keyof typeof draft, value: unknown) => {
    const current = body[key];
    const empty = current === undefined || current === null || String(current).trim() === "";
    if (empty) body[key] = value;
  };
  fillIfEmpty("title", draft.title);
  fillIfEmpty("objective", draft.objective);
  fillIfEmpty("symbol", draft.symbol);
  fillIfEmpty("scope", draft.scope);
  fillIfEmpty("segment", draft.segment);
  fillIfEmpty("riskBudget", draft.riskBudget);
  fillIfEmpty("maxPositionPct", draft.maxPositionPct);
  fillIfEmpty("status", draft.status);
  body.templateId = template.id;

  return { payload: body, templateId: template.id, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) Anzeige-Helfer (UI + Tests)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimale Missions-Form für Anzeigen (DB-Zeile oder DTO). */
export interface MissionLabelInput {
  symbol?: string | null;
  scope?: string | null;
  segment?: string | null;
}

/**
 * Einzeilige Beschreibung des Missions-Typs für Listen und Auswahlmenüs.
 *
 * * `SINGLE_SYMBOL` → das Symbol (z. B. `BTC`).
 * * `SCAN_UNIVERSE` → `Markt-Scan: <Segment>` (z. B. „Markt-Scan: Indizes & ETFs“).
 * * Alt-Zeilen ohne `scope` verhalten sich wie `SINGLE_SYMBOL`.
 */
export function missionScopeLabel(mission: MissionLabelInput): string {
  const scope = normalizeMissionScope(mission.scope) ?? "SINGLE_SYMBOL";
  if (scope === "SINGLE_SYMBOL") {
    const symbol = typeof mission.symbol === "string" && mission.symbol.trim() ? mission.symbol.trim() : null;
    return symbol ?? "—";
  }
  const segment = findMissionSegment(mission.segment);
  return segment ? `Markt-Scan: ${segment.label}` : "Markt-Scan: kein Segment";
}
