/**
 * STX-03-03 — Template: EMA/ADX Trend (Phase 3, Paket 03-02 · Finding STX-18).
 *
 * Das erste echte Strategie-Artefakt des Katalogs: ein **reines Parameterraster
 * über dem bestehenden `RuleSpec`-Vertrag**. Kein neues Feld, kein neuer
 * Indikator, keine Änderung an `ruleEngine.ts`, `RULE_CEILINGS` oder
 * `indicators.ts`. Genau das ist die These von STX-18: `RuleSpec` trägt dieses
 * Template bereits — hier wird also nichts ergänzt, sondern ausgemessen.
 * Diese Datei ist damit auch die **Referenz** für 03-04 … 03-08 (Aufbau,
 * Doku-Tiefe, Testbasis).
 *
 * ── Die Idee in einem Satz ─────────────────────────────────────────────────
 * Der Kurs hält Abstand zu seinem EMA 50, die Trendreihenfolge der EMAs ist
 * entschieden (nicht bloß geraten), der ADX bestätigt, dass überhaupt ein Trend
 * läuft, und das Volumen tut mehr als seinen eigenen Schnitt — alle vier
 * Bedingungen müssen gleichzeitig gelten, sonst passiert nichts.
 *
 * ── Warum KEIN `1m` und KEIN `5m` (supportedTimeframes = `1h`, `4h`) ───────
 * `adx14` ist keine beliebige Zahl, sondern Wilder-ADX(14): `adx()` in
 * `src/lib/indicators.ts` verlangt `candles.length >= 2 * period + 1` =
 * **29 Kerzen** und liefert sonst `null`. Auf `5m` sind das 145 Minuten
 * (~2,4 h), auf `1m` 29 Minuten — der Snapshot wäre nach einer halben Stunde
 * Marktdaten „vollständig“. Das Problem ist nicht die Rechenzeit, sondern die
 * **Aussagekraft**:
 *   - Ein ADX über 29 Fünf-Minuten-Kerzen bildet eine einzige Session-Phase
 *     ab (Asien/Europa/US-Overlap), keinen Marktzyklus. Die Zahl ist formal
 *     existent und inhaltlich ein anderes Maß als auf `1h`/`4h` — dieselbe
 *     Schwelle `adxMin = 22` bedeutet auf beiden Timeframes Verschiedenes.
 *   - `trend` ist die Anordnung von EMA9 gegen EMA21, also ein **Ordering**
 *     zweier Glätter über 21 Kerzen. Auf Intraday-Takten dominiert Mikrostruktur
 *     (Spreads, Orderfluss, Sessions) dieses Ordering; die Reihe wechselt
 *     UP/DOWN/FLAT innerhalb von Stunden mehrfach, ohne dass der Markt seine
 *     Richtung geändert hat. Der Filter ist dort strukturell schwach, nicht nur
 *     verrauscht.
 *   - Die Kostenseite verstärkt das: Das Backtest-Kostenmodell ist auf den
 *     feinen Takten teurer (Spread-/Slippage-Fallback `1m` 15 bp, `5m` 10 bp,
 *     `1h` 4 bp, `4h` 3 bp, `docs/BACKTESTING.md`). Ein Intraday-Trendfilter
 *     mit `cooldownMinutes = 240` handelt gegen diese Kosten an, ohne dass die
 *     Edge-Komponente (Trendordnung) auf dem Takt trägt.
 * `3m`/`15m`/`30m` sind ausgeschlossen, weil sie dasselbe Argument trifft. Die
 * Allowlist der Engine (`RULE_ALLOWED_TIMEFRAMES`) lässt sie zu — **hier** ist
 * die Beschränkung die Fachentscheidung des Templates, nicht die der Engine.
 * Bewusst **nicht** aufgenommen: `1d`/`5d`. Fachlich vertretbar (der ADX hat
 * dort erst recht genug Historie), aber nicht Teil dieses Prompts —
 * `supportedTimeframes` ist Teil des Artefakt-Hashs (04-01), eine Erweiterung
 * ist eine **Versionserhöhung**, keine Nebenfolge.
 *
 * ── Warum `ema50BufferPct` über der `trend`-Hysterese liegen muss ──────────
 * `trend` wird in `buildSnapshotFromCandles()` gesetzt:
 * `|EMA9 − EMA21| / price >= 0.001` → `UP`/`DOWN`, sonst `FLAT`
 * (`src/lib/ruleEngine.ts`). Das ist eine **Hysterese von 0,1 %**: Unterhalb
 * dieses Abstands gilt ein Trend ausdrücklich als *nicht entscheidbar*.
 * Die Buffer-Bedingung heißt `priceVsEma50Pct >= ema50BufferPct`. Sie misst eine
 * andere Strecke als `trend` (Kurs gegen EMA 50 statt EMA 9 gegen EMA 21) — aber
 * in derselben Größenordnung. Ein Buffer **unter** 0,1 % verlangt vom Kurs eine
 * geringere Trennung, als die Trendbedingung selbst schon verlangt; er filtert
 * dann nichts mehr, was `trend` nicht ohnehin durchlässt, und wird zum Durchlass
 * für genau die Margin-Kerzen, gegen die die Hysterese schützt (Kurs 0,05 % über
 * EMA 50, EMA-Abstand gerade so „UP“). In der Sensitivitätsanalyse (06-02) wäre
 * das eine Pseudo-Plateau-Kante, die man als „robust“ missdeuten könnte. Deshalb:
 *   - **Default `0.2`** = das Doppelte der Hysterese.
 *   - **`min: 0`** bleibt trotzdem erlaubt — *nicht* als Empfehlung, sondern
 *     weil 06-02 das Plateau unterhalb der Hysterese **sehen** soll. Ein
 *     Parameterbereich, der bei der Hysterese beginnt, könnte den Wirkungsverlust
 *     dieses Bereichs nicht mehr messen.
 *   - Der Test `tests/strategies.emaAdxTrend.test.ts` hält den Default als
 *     Invariante gegen die im Code gelesene Hysterese (0,001 · 100 = 0,1 %).
 *
 * ── Warum `window.timeframe = 1h`, obwohl `4h` unterstützt wird ────────────
 * `supportedTimeframes` ist die Aussage „diese Strategie *denkt* in 1h und 4h“;
 * `RuleWindow.timeframe` ist die Aussage „diese eine Regel *läuft* auf dieser
 * Kerzenbreite" — `RuleSpec` trägt genau einen Wert (kein Array). Der Default
 * ist das feinere `1h`, und zwar aus zwei Gründen, die beide im Bestand liegen:
 *   - `sanitizeRuleSpec()` fällt bei einem unbekannten Wert auf `15m` zurück —
 *     ein Takt, den dieses Template bewusst nicht bedient. Der Default muss
 *     deshalb explizit gesetzt sein, nie „irgendwie leer“.
 *   - Der Mikro-Executor wertet live nur Regeln bis zu seinem
 *     Ausführungsintervall (Default `1h`) aus; `4h`-Regeln weist sein
 *     Timeframe-Guard fail-closed ab (`ruleTimeframeBlockReason`, STX-01 —
 *     Counter `micro_executor_rule_blocked_total`, sichtbar, nicht still).
 *     Eine auf `4h` kompilierte Regel ist also ein Backtest-/Screening-Artefakt,
 *     solange der Operator `executionInterval` nicht anhebt.
 * Welcher der beiden unterstützten Timeframes eine konkrete Regel bekommt,
 * entscheidet der Compiler (03-09) aus dem Auftrag — nicht dieses Template.
 *
 * ── Verifizierte Risiko-Grenzen (im Code nachgeprüft, nicht aus dem Kopf) ───
 * `RULE_CEILINGS` (`src/lib/ruleEngine.ts`) leitet sich aus `LIMIT_CEILINGS`
 * (`src/lib/riskGuard.ts`) ab; der **gesamte** Parameterbereich dieses Templates
 * liegt innerhalb dieser Deckel, es gibt also für keinen Rasterpunkt ein
 * Klemmen (der Katalog wäre sonst der erste, der es merkte):
 *   | Wert des Templates | Deckel (gelesen) | Quelle |
 *   |---|---|---|
 *   | `riskBudgetPct: 0.01` | `maxRiskPerTrade [0.002, 0.05]` | `riskGuard.ts` |
 *   | `maxPositionPct: 0.15` | `maxPositionPct [0.01, 0.5]` | `riskGuard.ts` |
 *   | `stopLossPct ∈ [1, 12]` | `defaultStopLossPct [0.005, 0.2] × 100 = [0.5, 20]` | `riskGuard.ts` → `RULE_CEILINGS.stopLossPct` |
 *   | `takeProfitRR ∈ [1, 4]` | `takeProfitRR [0.5, 5]` | `riskGuard.ts` |
 *   | `maxExecutionsPerDay: 2` | `[1, 10]` | `RULE_CEILINGS` |
 *   | `cooldownMinutes: 240` | `[0, 1440]` | `RULE_CEILINGS` |
 *   | `volumeWindow: 20` | `[5, 200]` | `RULE_CEILINGS` |
 *
 * ── `symbol` ist Pflicht des **Aufrufers**, nicht des Builders ──────────────
 * `buildRule(params)` liefert bewusst **kein** `symbol`-Feld (und der Vertrag
 * `StrategyTemplate["buildRule"]` nimmt auch nur `Record<string, number>` an).
 * Ein Symbol im Builder würde zwei Dinge brechen: (a) die Reinheit — dasselbe
 * versionierte Artefakt müsste für jeden Markt eine andere Regel liefern und
 * wäre damit nicht mehr „Parameter → Regel“, und (b) die Adressierung — welcher
 * Markt gehandelt wird, entscheidet die Mission (bzw. das Screening, Phase 5),
 * nicht die Strategie. Der Compiler (03-09) setzt das Symbol **vor**
 * `sanitizeRuleSpec()`: `{ ...template.buildRule(params), symbol }`. Ohne
 * Symbol lehnt der Sanitizer die Rohform ab (`symbol ungültig`) — das ist der
 * gewünschte Fail-closed-Zustand, nicht ein Fehler dieses Templates; der Test
 * hält beide Richtungen fest.
 *
 * ── Was dieses Template bewusst NICHT tut ──────────────────────────────────
 *   - **Kein `SHORT`** — `RULE_ALLOWED_SIDE` ist die einzige erlaubte Seite, ein
 *     Template darf das nicht aufweichen. Die `side` kommt deshalb **aus dieser
 *     Konstanten** und nicht als abgeschriebenenes Literal; der Katalog prüft
 *     zusätzlich die Rohform (`action.side !== RULE_ALLOWED_SIDE` ⇒ Fehler).
 *   - **Kein `vwapPct`** — der Anker ist der UTC-Kalendertag der letzten Kerze,
 *     und `sessionVwap()` verlangt mindestens **zwei** Kerzen seit diesem Anker
 *     (`samples < 2 ⇒ null`). Auf `1h` heißt das: kurz nach 00:00 UTC steht die
 *     Größe aus 2–3 Kerzen, abends aus 24 — dasselbe Feld, je nach Stunde ein
 *     anderes Maß. Eine Schwellenregel gegen einen so gleitenden Tagesanker ist
 *     nicht belastbar (STX-01), auch wenn der Wert formal vorhanden ist.
 *   - **Keine Sequenz-/Reclaim-Logik** — `RuleSpec` kennt nur
 *     Punkt-zu-Punkt-Bedingungen einer Kerze; Sequenz-Trigger wären
 *     Engine-Arbeit (STX-18, verworfen).
 *   - **Kein ATR-skalierter Stop** — `stopLossPct` ist ein fester Prozentwert.
 *     Die `atrPct`-Referenz in `mapsTo` dokumentiert den fachlichen Bezug
 *     (der Stop wird *an der Volatilität gemessen*, seine Größe aber nicht aus
 *     ihr berechnet); eine ATR-Skalierung wäre eine neue Engine-Semantik.
 *   - **Kein Klemmen, keine Default-Reparatur**: Ein fehlender oder nicht
 *     endlicher Parameter ist ein Wurf, kein still auf `default` gesetzter Wert.
 *     Der Katalog prüft Grenzen, der Sanitizer klemmt Risiko — beides repariert
 *     keine Tippfehler im Aufrufer.
 */

import { RULE_ALLOWED_SIDE } from "@/lib/ruleEngine";
import type { RuleField, RuleSpecInput } from "@/lib/ruleEngine";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";

import type { ParamSpec, StrategyAssumption, StrategyTemplate } from "../types";

/** Stabile Template-ID — identisch mit dem Eintrag in `STRATEGY_TEMPLATE_IDS`. */
export const EMA_ADX_TREND_ID = "ema-adx-trend" as const;

/**
 * Artefakt-Version. Monoton bei **Semantik**änderung (Regel, Timeframes,
 * Parameterraum) — nicht bei Formulierung. Siehe `types.ts`.
 */
export const EMA_ADX_TREND_VERSION = 1 as const;

/** Keys des Parameterraums — die geschlossene Menge, die der Builder akzeptiert. */
export type EmaAdxTrendParamKey =
  | "adxMin"
  | "ema50BufferPct"
  | "volumeRatioMin"
  | "stopLossPct"
  | "takeProfitRR";

/**
 * Die Timeframes, auf denen das Template sinnvoll bewertet (Begründung im
 * Kopf). `satisfies` gegen das **bestehende** Vokabular: kein zweites
 * Timeframe-Register, aber die typsichere Allowlist-Prüfung (STX-01).
 */
export const EMA_ADX_TREND_TIMEFRAMES = ["1h", "4h"] as const satisfies readonly SupportedTimeframe[];

/**
 * Der Parameterraum. `step` ist kein Rundungsschritt, sondern das **Raster**
 * der Sensitivitätsanalyse (06-02): Jeder Rasterpunkt muss eine gültige Regel
 * ergeben und darf an keiner Stelle klemmen — sonst misst die Analyse die
 * Klemmung des Sanitizers statt der Edge der Strategie.
 */
export const EMA_ADX_TREND_PARAMS: Readonly<Record<EmaAdxTrendParamKey, ParamSpec>> = {
  adxMin: {
    key: "adxMin",
    kind: "threshold",
    label: "ADX-Mindestwert",
    unit: "Index",
    default: 22,
    min: 15,
    max: 35,
    step: 1,
    mapsTo: "adx14",
  },
  ema50BufferPct: {
    key: "ema50BufferPct",
    kind: "threshold",
    label: "Kurs mindestens über EMA 50",
    unit: "%",
    // 0.2 = Doppeltes der trend-Hysterese (0,1 %). Begründung im Kopf.
    default: 0.2,
    // min 0 ist bewusst unter der Hysterese: 06-02 soll den Wirkungsverlust messen.
    min: 0,
    max: 3,
    step: 0.1,
    mapsTo: "priceVsEma50Pct",
  },
  volumeRatioMin: {
    key: "volumeRatioMin",
    kind: "threshold",
    label: "Volumenverhältnis",
    unit: "ratio",
    default: 1,
    min: 0.8,
    max: 2,
    step: 0.05,
    mapsTo: "volumeRatio",
  },
  stopLossPct: {
    key: "stopLossPct",
    kind: "threshold",
    label: "Stop-Loss",
    unit: "%",
    // [1, 12] liegt komplett in RULE_CEILINGS.stopLossPct = [0.5, 20].
    default: 4,
    min: 1,
    max: 12,
    step: 0.5,
    mapsTo: "atrPct",
  },
  takeProfitRR: {
    key: "takeProfitRR",
    kind: "ratio",
    label: "Chance/Risiko",
    unit: "ratio",
    default: 2,
    min: 1,
    max: 4,
    step: 0.25,
    // Das Ausbaudokument lässt dieses Feld „ohne“ Mapping: Ein Zielkurs ist
    // kein Regelfeld. Der Vertrag (`ParamSpec.mapsTo: RuleField`) verlangt
    // trotzdem eines — gewählt ist `atrPct`, weil Ziel und Stop Vielfache
    // derselben Volatilitätsstrecke sind und `atrPct` das einzige Feld dieses
    // Templates ist, das den Stop trägt. `mapsTo` ist Doku, keine Auswertung.
    mapsTo: "atrPct",
  },
};

/**
 * Die Default-Parameter — **abgeleitet** aus `EMA_ADX_TREND_PARAMS`, nie eine
 * zweite Liste (ein zweiter Default wäre ein Drift zwischen Raster und Regel).
 */
export const EMA_ADX_TREND_DEFAULTS: Readonly<Record<EmaAdxTrendParamKey, number>> = Object.fromEntries(
  (Object.keys(EMA_ADX_TREND_PARAMS) as EmaAdxTrendParamKey[]).map((key) => [key, EMA_ADX_TREND_PARAMS[key].default]),
) as Readonly<Record<EmaAdxTrendParamKey, number>>;

/**
 * Die Felder, die dieses Template auswertet. Der Typ ist die Whitelist selbst
 * (`RuleField = keyof typeof RULE_FIELDS`) — ein erfundenes Feld ist hier nicht
 * darstellbar, ein `as`-Cast bräuchte einen eigenen Kommentar.
 */
const REQUIRED_FIELDS: readonly RuleField[] = ["trend", "priceVsEma50Pct", "adx14", "volumeRatio", "atrPct"];

/**
 * Die Annahmen (06-01 auditiert sie). `critical: true` heißt: fällt sie weg,
 * ist das **Ergebnis** wertlos — nicht „weniger schön“.
 */
const ASSUMPTIONS: readonly StrategyAssumption[] = [
  {
    id: "trendreihen-1h-4h",
    statement:
      "Auf 1h/4h sind Trendreihen (EMA9 über EMA21 mit ausreichendem Abstand) häufiger als " +
      "Seitwärtsphasen — der Markt liefert dem Filter überhaupt eine nennenswerte Zahl an " +
      "Auslösungen, statt ihn monatelang leer laufen zu lassen.",
    category: "MARKET",
    critical: false,
  },
  {
    id: "adx-29-kerzen",
    statement:
      "ADX(14) braucht 29 Kerzen (2 · 14 + 1); bei kürzerer Historie liefert das Feld null und " +
      "die Bedingung `adx14 gte adxMin` scheitert fail-closed — ohne ADX wird nicht gehandelt.",
    category: "DATA",
    critical: true,
  },
  {
    id: "volumenfilter-reduzierte-transaktionskosten",
    statement:
      "Die Volumenbedingung reduziert die Zahl der Transaktionen; die Gebühren bleiben dabei auf " +
      "dem Niveau des Backtests (Kosten-Fallback je Timeframe, docs/BACKTESTING.md) — realer " +
      "Slippage-Abschlag also nicht größer als modellierter. Ist er es doch, schrumpft die Edge " +
      "pro Trade, nicht pro Signal.",
    category: "COST",
    critical: false,
  },
  {
    id: "regime-trend-up",
    statement:
      "Funktioniert in TREND_UP. In RANGE degradiert die ADX-Bedingung zur bloßen " +
      "Rauschunterdrückung: Ein auslaufender Trend kann kurz über der ADX-Schwelle stehen, " +
      "während die Richtung bereits gedreht hat — die Bedingung unterscheidet dann nicht mehr " +
      "zwischen Trend und Range, sie verzögert nur.",
    category: "REGIME",
    critical: false,
  },
  {
    id: "ema50-min-50-kerzen",
    statement:
      "priceVsEma50Pct bezieht sich auf einen echten EMA 50: buildSnapshotFromCandles() rechnet " +
      "ema(closes, min(50, closes.length)) — unter 50 Kerzen ist der Vergleichswert also ein " +
      "kürzerer EMA und die Buffer-Bedingung sagt etwas anderes. Der Snapshot braucht erst ab 25 " +
      "Kerzen; fachlich verlangt dieses Template 50 (1h ≈ 2 Tage, 4h ≈ 8 Tage Historie).",
    category: "DATA",
    critical: false,
  },
];

/** Anzeigename (deutsch) für Katalog, Workshop-UI und Reports. */
const NAME = "EMA/ADX Trend";

const DESCRIPTION =
  "Trendfolge auf 1h/4h: Der Kurs muss mit klarer Marge über seinem EMA 50 liegen (Default " +
  "0,2 %), EMA 9 über EMA 21 stehen (Trendentscheidung, nicht Trendvermutung), der ADX(14) muss " +
  "die Stärke bestätigen (Default 22) und die Signalkerze muss mindestens auf Höhe ihres " +
  "20er-Volumenschnitts schließen. Stop und Ziel sind feste Prozent- bzw. Chance/Risiko-Werte, " +
  "kein ATR-Kanal.";

/**
 * Liest einen Parameter **fail-closed**: fehlend oder nicht endlich ist ein
 * Fehler, keine Gelegenheit für einen Default. Stille Defaults wären eine
 * zweite Wahrheit über die Regel — und der Katalog könnte sie nicht mehr finden.
 */
function paramValue(params: Readonly<Record<string, number>>, key: EmaAdxTrendParamKey): number {
  const raw: unknown = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `ema-adx-trend: Parameter „${key}“ fehlt oder ist keine endliche Zahl ` +
        `(ist ${raw === null ? "null" : Array.isArray(raw) ? "Array" : typeof raw}).`,
    );
  }
  return raw;
}

/** Anzeige-Rundung für den `rationale`-Text — die Regel selbst rechnet ungerundet. */
function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * Die Regel als **ROHFORM** (`RuleSpecInput`) — reine Funktion der Parameter,
 * kein `ctx`, kein Marktdatenzugriff, keine IO (STX-05). Keine der Zahlen wird
 * hier geklemmt oder gerundet; der einzige Weg zur gültigen Regel führt über
 * `sanitizeRuleSpec()` (Pflicht des Compilers, 03-09).
 *
 * Bewusst **ohne** `symbol` — das setzt der Aufrufer (siehe Kopf).
 */
export function emaAdxTrendRule(params: Readonly<Record<string, number>>): RuleSpecInput {
  const adxMin = paramValue(params, "adxMin");
  const ema50BufferPct = paramValue(params, "ema50BufferPct");
  const volumeRatioMin = paramValue(params, "volumeRatioMin");
  const stopLossPct = paramValue(params, "stopLossPct");
  const takeProfitRR = paramValue(params, "takeProfitRR");

  return {
    // Familienname ohne Symbol: das Symbol kommt vom Aufrufer, sonst würde der
    // Builder ein Faktum erfinden, das er nicht kennen darf.
    name: `${EMA_ADX_TREND_ID} v${EMA_ADX_TREND_VERSION}`,
    missionId: null,
    condition: {
      logic: "all",
      conditions: [
        // 1) Trendentscheidung (Hysterese 0,1 % in `buildSnapshotFromCandles`).
        { field: "trend", op: "eq", value: "UP" },
        // 2) Der Bruch-Filter: Kurs mit Marge über EMA 50 — muss über der
        //    Hysterese liegen, sonst ist er ein Durchlass (siehe Kopf).
        { field: "priceVsEma50Pct", op: "gte", value: ema50BufferPct },
        // 3) Trendstärke: ohne ADX kein Trend (null ⇒ Bedingung scheitert).
        { field: "adx14", op: "gte", value: adxMin },
        // 4) Participation: Signalkerze mindestens auf Höhe ihres 20er-Schnitts
        //    (`gte` ist inklusiv: bei exakt normalem Volumen zählt die Kerze).
        { field: "volumeRatio", op: "gte", value: volumeRatioMin },
      ],
    },
    action: {
      side: RULE_ALLOWED_SIDE,
      stopLossPct,
      takeProfitRR,
      // 1 % Risiko je Trade, max. 15 % Positionsanteil — beide gut innerhalb
      // LIMIT_CEILINGS (maxRiskPerTrade [0.002, 0.05], maxPositionPct [0.01, 0.5]).
      riskBudgetPct: 0.01,
      maxPositionPct: 0.15,
      positionSizeMode: "risk",
    },
    window: {
      // Das feinere der beiden unterstützten Takte — `RuleSpec` trägt genau EINEN
      // `timeframe` pro Regel; die Wahl zwischen 1h und 4h trifft der Aufrufer
      // (Begründung im Kopf, Abschnitt „Warum `window.timeframe = 1h`“).
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      // 2 Versuche/Tag und 240 min Abklingzeit: auf 1h sind das vier Kerzen
      // Abstand — derselbe Trend darf nicht viermal in Folge nachgekauft werden.
      maxExecutionsPerDay: 2,
      cooldownMinutes: 240,
      // Identisch zur 20-Perioden-Referenz von `volumeRatio` im Snapshot.
      volumeWindow: 20,
    },
    rationale:
      `Trendfolge long: Kurs mindestens ${num(ema50BufferPct)} % über EMA 50, EMA 9 über EMA 21 ` +
      `(Trend = UP), ADX(14) mindestens ${num(adxMin)} als Stärkenachweis, Signalkerzenvolumen ` +
      `mindestens ${num(volumeRatioMin)}× des 20er-Schnitts. Ausstieg fest bei ${num(stopLossPct)} % ` +
      `Verlust oder ${num(takeProfitRR)}× Chance/Risiko.`,
    // RESEARCH: Die Herkunft ist eine Research-Idee, keine CEO-Anweisung und
    // keine manuelle Regel. `sanitizeRuleSpec` übernimmt den Wert (nur bei
    // `forceSourceRole` — API-Pfad — gewinnt der Server).
    sourceRole: "RESEARCH",
    // 0.5 = neutral: Das Template behauptet kein erhöhtes Risiko und keines mit
    // Siegel. Der Sanitizer klemmt auf [0, 1], hier bleibt der Wert unangetastet.
    riskScore: 0.5,
  };
}

/**
 * Das Template — **frisch konstruiert** bei jedem Aufruf (kein geteiltes
 * Modul-Singleton, das ein Konsument verbiegen könnte). `catalog.ts` validiert
 * das Ergebnis beim Import; `validateTemplate(buildEmaAdxTrend())` liefert `[]`.
 */
export function buildEmaAdxTrend(): StrategyTemplate {
  return {
    id: EMA_ADX_TREND_ID,
    name: NAME,
    description: DESCRIPTION,
    version: EMA_ADX_TREND_VERSION,
    // ADR-008: Klasse ist eine Fachaussage aus dem bestehenden Vokabular —
    // „trend“ (nicht `unclassified`, kein eigener Schlüssel).
    class: "trend",
    // ADR-010: nur SINGLE_SYMBOL; Universe-Auswahl gehört zu `src/crossSectional/`.
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: EMA_ADX_TREND_TIMEFRAMES,
    requiredFields: REQUIRED_FIELDS,
    params: EMA_ADX_TREND_PARAMS,
    buildRule: emaAdxTrendRule,
    assumptions: ASSUMPTIONS,
    // ADR-009: bestehendes MarketRegime-Vokabular, ohne UNKNOWN. RANGE/HIGH_VOL/
    // CRASH sind bewusst nicht erwartet — in TREND_DOWN gibt es kein Long-Setup.
    expectedRegimes: ["TREND_UP"],
  };
}
