/**
 * STX-03-01 — Der Template-Vertrag der Strategie-Templates (Phase 3,
 * Paket 01-01 / 00-03).
 *
 * Eine **Strategie** ist in dieser Roadmap ein *versioniertes technisches
 * Artefakt* — kein Prompt-Text. Diese Datei definiert den Vertrag, an den
 * **jede** spätere Datei der Phase 3 sich hält:
 *
 *   - `catalog.ts` (03-02) validiert Templates gegen diesen Vertrag
 *     (IDs, Parameter-Grenzen, `class !== "unclassified"`, `UNKNOWN` in
 *     `expectedRegimes`, …).
 *   - Die konkreten Templates (03-03 … 03-08) implementieren
 *     `StrategyTemplate`.
 *   - `compiler.ts` (03-09) ist der einzige Aufrufer von `buildRule` und
 *     leitet das Ergebnis ZWINGEND durch `sanitizeRuleSpec()`
 *     (`src/lib/ruleEngine.ts`), bevor eine Regel existieren darf.
 *
 * ── Reine Typen ────────────────────────────────────────────────────────────
 * Keine Logik, keine IO, kein DB-Import (gleiche Regel wie
 * `src/lib/missionTemplates.ts`): ausschließlich `import type`, keine
 * Wertausdrücke. Das Modul erzeugt zur Laufzeit null Bytes und keine
 * Runtime-Dependency.
 *
 * ── BEWIESEN das bestehende Vokabular (ADR-E1/E2/E3 ⇒ ADR-008/009/010,
 * `docs/roadmap/DECISIONS.md`) ─────────────────────────────────────────────
 *   - `StrategyClassKey`    aus `src/lib/signalDecay`          (ADR-008)
 *   - `MarketRegime`        aus `src/lib/marketRegime`         (ADR-009)
 *   - `SupportedTimeframe`  aus `src/lib/marketdata/historicalStore`
 *   - `MissionScope`        aus `src/lib/missionTemplates`     (ADR-010)
 *   - `RuleField`/`RuleSpecInput` aus `src/lib/ruleEngine`
 *
 * Kein eigener Klassen-/Regime-/Timeframe-/Feld-Typ wird in diesem Modul
 * definiert — Ableitungen (`Extract`) ja, neue Vokabulare nein.
 *
 * ── Warum KEIN `buildUniverseStrategy` (Entscheidung 3) ────────────────────
 * ADR-E3 (ADR-010) hat die Universe-Spec des Ausbaudokuments (§1.9) verworfen.
 * (Der Wächter in `tests/adrVocabulary.test.ts` prüft jedes File unter `src/`
 * auf deren Tokennamen — hier steht deshalb die Referenz, nicht der Token.)
 * Universe-Mitgliedschaft und Ranking besitzt `src/crossSectional/`
 * (versionierte, hash-identifizierte `CrossSectionalConfig` mit
 * `EligibilityConfig` und `horizons`, Point-in-Time-Snapshots, bewusst
 * order-frei), und die Gewichte erzeugt die dünne
 * `PortfolioConstruction`-Schicht (`EQUAL_WEIGHT` / `INVERSE_VOLATILITY`,
 * geklemmt über `VOLATILITY_TARGETING_BOUNDS` / `WeightBounds`). Ein zweiter
 * Builder in diesem Vertrag würde zwei Wahrheiten über
 * Universe-Mitgliedschaft und Ranking erzeugen — und zudem den
 * Runtime-Builder zurückholen, den STX-05 korrigiert hat (siehe
 * `buildRule`). Der Template-Vertrag ist deshalb `SINGLE_SYMBOL` (siehe
 * `scope`).
 */

import type { StrategyClassKey } from "@/lib/signalDecay";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { RuleField, RuleSpecInput } from "@/lib/ruleEngine";
import type { MarketRegime } from "@/lib/marketRegime";
import type { MissionScope } from "@/lib/missionTemplates";

/** Eine abstrahierte, versionierte Annahme einer Strategie. */
export interface StrategyAssumption {
  id: string; // stabil, ^[a-z0-9-]{1,64}$
  statement: string; // deutscher Klartext
  category:
    | "MARKET" // z. B. „Trend-Phasen sind häufiger als Seitwärtsphasen"
    | "COST" // z. B. „Gebühren bleiben auf dem Niveau des Backtests"
    | "LIQUIDITY" // z. B. „Orderbuch ist mindestens so tief wie die Position"
    | "DATA" // z. B. „Keine Lücken > 2 Bars im Fenster"
    | "REGIME" // z. B. „Funktioniert nur in TREND_UP/TREND_DOWN"
    | "EXECUTION"; // z. B. „Fills innerhalb eines Bars"
  /** true = ohne diese Annahme ist das Ergebnis wertlos. */
  critical: boolean;
}

export type ParamKind = "threshold" | "period" | "ratio";

export interface ParamSpec {
  key: string; // ^[a-zA-Z][a-zA-Z0-9]{0,31}$
  kind: ParamKind;
  label: string; // deutsch
  unit: string; // z. B. "%" | "Bars" | "ratio"
  default: number;
  min: number;
  max: number;
  /** Raster für die Sensitivitätsanalyse (06-02). */
  step: number;
  /**
   * Regel-Feld, das dieser Parameter speist (Doku-Zweck, keine
   * Auswertung). Muss ein **existierendes** `RULE_FIELDS`-Feld referenzieren
   * (nach 02-02/02-03 u. a. `bbZScore`, `donchianBreakoutPct`) — typsicher
   * erzwungen: `RuleField` ist `keyof typeof RULE_FIELDS`, ein unbekanntes
   * Feld ist hier nicht darstellbar.
   */
  mapsTo: RuleField;
}

/** Ein versioniertes, parametrisiertes Strategie-Artefakt. */
export interface StrategyTemplate {
  /** stabil, schema-validiert: ^[a-z0-9-]{3,64}$ */
  id: string;
  /** Anzeigename (deutsch). */
  name: string;
  description: string;
  /** Monoton steigend bei Semantikänderung. Teil des Artefakt-Hashs. */
  version: number;

  /**
   * Pflicht, aus dem **BESTEHENDEN** Vokabular (ADR-E1 ⇒ ADR-008).
   *
   * **Entscheidung 1 — warum `StrategyClassKey` und nicht `StrategyClass`:**
   * `StrategyClassKey = StrategyClass | "unclassified"` ist der bewiesene
   * Schlüssel der gesamten Klassifikations- und Persistenzschicht
   * (`STRATEGY_CLASS_KEYS`, `DEFAULT_CLASS_POLICIES:
   * Record<StrategyClassKey, …>`, `signal_decay_events.strategy_class`,
   * `positions.strategy_class`). ADR-008 verpflichtet exakt gegen diesen
   * Key zu typisieren — keinen schmaleren, und erst recht keinen eigenen
   * Union-Typ in `src/strategies/`: Abweichende Werte würden in den
   * Gate-Faktoren und den Decay-Policies **still** auf Faktor 1 bzw.
   * `unclassified` fallen — eine Risiko-Abschwächung ohne Fehlermeldung.
   *
   * ADR-008 verbietet `unclassified` deshalb **zur Laufzeit**, nicht im
   * Typ: Der Typ enthält es bewusst (es steht in `STRATEGY_CLASS_KEYS`),
   * der Ausschluss ist eine Validierungsregel — 03-02 (Katalog) lehnt ein
   * Template mit `class: "unclassified"` ab, dazu 03-09 (Compiler) und
   * 04-01 (DB-CHECK). `unclassified` bleibt Regeln ohne Klassen-Herkunft
   * (manuelle Regeln, Positionen ohne ableitbare Klasse) vorbehalten.
   */
  class: StrategyClassKey;

  /**
   * Nur `SINGLE_SYMBOL`, abgeleitet aus dem bestehenden `MissionScope`
   * (`src/lib/missionTemplates`) — kein eigener Scope-Typ (ADR-010). Ein
   * UNIVERSE-Scope **entfällt** (ADR-E3 ⇒ ADR-010):
   * `src/crossSectional/` besitzt die Querschnitts-Auswahl, die
   * `PortfolioConstruction`-Schicht die Gewichte — Begründung im
   * Modul-Header („Warum KEIN `buildUniverseStrategy`“).
   */
  scope: Extract<MissionScope, "SINGLE_SYMBOL">;

  /**
   * Aus `SUPPORTED_TIMEFRAMES` abgeleitet (`SupportedTimeframe` re-exportiert
   * `src/lib/marketdata/historicalStore` unverändert von
   * `src/lib/marketdata/timeframes`), nie ein eigenes Vokabular.
   */
  supportedTimeframes: readonly SupportedTimeframe[];

  /**
   * Felder, die das Template auswertet — Teil von `RULE_FIELDS` (Whitelist
   * in `src/lib/ruleFieldCatalog.ts`, re-exportiert über
   * `src/lib/ruleEngine.ts`). Ein Feld, das die Whitelist nicht kennt, ist
   * hier nicht darstellbar (`RuleField = keyof typeof RULE_FIELDS`).
   */
  requiredFields: readonly RuleField[];

  params: Readonly<Record<string, ParamSpec>>;

  /**
   * **PURE** Funktion der Parameter. KEIN `ctx`, KEIN Marktdatenzugriff —
   * das ist der Kern der STX-05-Korrektur.
   *
   * Das Ausbaudokument schlug `buildRule(ctx: StrategyContext) => RuleSpec`
   * vor. Ein Builder, der zur Laufzeit aus Marktdaten eine *fertige*
   * `RuleSpec` erzeugt, ist nicht reproduzierbar, nicht auditierbar — und
   * umgeht nebenbei `sanitizeRuleSpec()`, die Whitelist, das Klemmen an
   * `RULE_CEILINGS` und die Persistenz: genau die Kette, die
   * `src/lib/ruleEngine.ts` (Modul-Header) als Sicherheitsmodell „Code
   * entscheidet" beschreibt. Eine pure Funktion der Parameter ist
   * deterministisch (gleiche Parameter ⇒ gleiche Regel), und die ROHFORM
   * des Ergebnisses ist reine Daten — serialisierbar, hashbar, persistier-,
   * testbar.
   *
   * **Entscheidung 2 — warum `RuleSpecInput` und nicht `RuleSpec`:**
   * Der Rückgabetyp **ist** der Vertrag. `RuleSpecInput`
   * (`Record<string, unknown>`, `src/lib/ruleEngine.ts`) ist die ROHFORM —
   * und `sanitizeRuleSpec()` ist ihre EINZIGE legale Transformation:
   * unbekannte Keys und Prototype-Pollution werden verworfen, Strings statt
   * Zahlen normalisiert, exotische Operatoren abgelehnt und jeder
   * numerische Wert gegen `RULE_CEILINGS` (abgeleitet aus `LIMIT_CEILINGS`,
   * `src/lib/riskGuard.ts`) geklemmt. Ein Builder-Rückgabetyp `RuleSpec`
   * würde dem Aufrufer „fertig, sicher, verwendbar" signalisieren — und
   * den Sanitizer dadurch *überspringbar* machen: Ein handgefertigtes
   * `RuleSpec`-Objekt *sieht* normalisiert aus, ist es aber nicht, weil es
   * den Code nicht durchlaufen hat; damit könnte eine bösartige oder
   * halluzinierte Regel wieder mehr Risiko fordern, als der Code zulässt.
   * Bei `Record<string, unknown>` lässt sich der Sanitizer strukturell
   * nicht umgehen: Ohne `sanitizeRuleSpec()` (→ `RuleSpec`) und
   * `compileRuleSpec()` (→ `CompiledRule`) wird aus der Rohform schlicht
   * keine Regel. Das ist der Grund, warum dieses Repo sicher ist.
   *
   * **Pflicht für den Aufrufer** (`compiler.ts`, 03-09): Das Ergebnis von
   * `buildRule` MUSS durch `sanitizeRuleSpec()` geleitet werden — erst
   * danach darf persistiert bzw. ausgeführt werden. Die Rohform direkt
   * zu konsumieren, ist ein Vertragsbruch.
   */
  buildRule(params: Readonly<Record<string, number>>): RuleSpecInput;

  /** Was diese Strategie annimmt — wird 06-01 auditiert. */
  assumptions: readonly StrategyAssumption[];

  /**
   * Regime, in denen die Strategie plausibel ist (ADR-E2 ⇒ ADR-009:
   * bestehendes `MarketRegime`-Vokabular, ohne `UNKNOWN`).
   * `UNKNOWN` ist ein `MarketRegimeLabel`-Zustand („kein belastbares
   * Datum") — kein Regime, in dem man Edge unterstellt; fail-closed ist es
   * daher ein Validierungsfehler in dieser Liste (03-02), analog zu
   * `unclassified` in `class` (ADR-008). Die 7er-Taxonomie des
   * Ausbaudokuments (bull/bear/sideways/…) ist verworfen.
   */
  expectedRegimes: readonly MarketRegime[];
}
