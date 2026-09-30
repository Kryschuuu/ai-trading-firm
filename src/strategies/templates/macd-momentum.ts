/**
 * STX-03-04 — Template: MACD Momentum (Phase 3, Paket 03-02 · Finding STX-18).
 *
 * Das zweite Strategie-Artefakt des Katalogs — und wie 03-03 ein **reines
 * Parameterraster über dem bestehenden `RuleSpec`-Vertrag**: kein neues Feld,
 * kein neuer Indikator, keine Änderung an `ruleEngine.ts`, `RULE_CEILINGS`,
 * `ruleFieldCatalog.ts` oder `indicators.ts`. Alle drei Felder (`macdHist`,
 * `priceVsEma50Pct`, `adx14`) sind seit 02-01/02-02/02-03 bzw. seit der
 * Regel-Engine selbst im Snapshot vorhanden; dieses Template ergänzt also
 * nichts, es misst aus.
 *
 * Es ist zugleich das **Referenztemplate für 06-02 (Overfit)**: die wenigsten
 * Parameter (vier), die klarste Ökonomie (ein Vorzeichen und zwei Filter) und
 * kein Rauschen aus einem zweiten Indikator. Kollabiert es schon im In-Sample,
 * ist das ein **Befund über die Idee**, kein Bug im Code — genau deshalb ist
 * der Parameterraum hier bewusst klein und der Default absichtlich schlicht.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DIE WICHTIGSTE ZEILE DIESER DATEI: keine Magnitude-Bedingung auf `macdHist`
 * ══════════════════════════════════════════════════════════════════════════
 * `macdHist` ist `macd − signal` in **Preiseinheiten** — nicht in Prozent und
 * nicht normalisiert (`ruleFieldCatalog.ts`: „Histogramm = MACD − Signal“;
 * `buildSnapshotFromCandles()` schreibt `macdValue.histogram` ungefiltert in
 * das Feld). Das hat eine harte Folge, die dieses Template nicht wegdefinieren
 * darf:
 *
 *   Ein Schwellwert `macdHist > 0` ist **marktskalenfrei** (das Vorzeichen ist
 *   eine reine Aussage über die Ordnung zweier Glätter), ein Schwellwert
 *   `macdHist > X` mit `X > 0` ist es **nicht**. Dieselbe Zahl `0.5` bedeutet
 *   für BTC (6-stelliger Kurs) und für einen 5-stelligen Aktienkurs völlig
 *   Verschiedenes: beim einen ein Rauschen um die Nulllinie, beim anderen ein
 *   bereits klar ausgeprägter Impuls. Auf einem Kursniveau von 100 ist 0.5 ein
 *   halbes Prozent, auf einem Kursniveau von 60.000 ist es ein
 *   Achtzigtausendstel.
 *
 * Deshalb steht in `macdMomentumRule()` genau **eine** `macdHist`-Bedingung,
 * und sie lautet **immer** `gt 0`:
 *   - `0` ist der einzige Wert dieses Feldes, der auf jedem Markt dasselbe
 *     heißt; jede Magnitude wäre eine versteckte Wette auf das Kursniveau und
 *     damit eine **Verwechslung von Momentum und Volatilität** — genau die
 *     Reihenfolge, die die Analyse in 06-02 prüft (und in 06-03 gegen die
 *     Kosten stellt). Ein Rasterpunkt `macdHist = X` würde bei jeder
 *     Sensitivitätsanalyse nur die Skala des getesteten Symbols messen.
 *   - **Der skalenfreie Ersatz ist `priceVsEma50Pct`.** Statt „wie groß ist der
 *     Impuls in Kurseinheiten“ fragt dieses Template „liegt der Kurs wie weit
 *     **in Prozent** über seinem EMA 50“ — dieselbe Fachfrage (ist der Impuls
 *     bestätigt, oder nur ein Ausschlag), aber über Kursniveaus hinweg
 *     vergleichbar. Der zweite Filter ist `adx14`, ebenfalls dimensionslos
 *     (0…100) und damit marktübergreifend lesbar.
 *   - Es gibt zusätzlich **keine** Bedingung auf `macd`/`macdSignal` (dieselbe
 *     Preiseinheiten-Falle, und die Sperrliste dieses Prompts nennt sie
 *     ausdrücklich): das Vorzeichen des Histogramms ist die einzige Aussage,
 *     die aus der MACD-Familie ohne Skala trägt.
 *
 * Wird das Template später um eine „stärkere“ Histogramm-Bedingung erweitert,
 * ist das keine Parameteränderung, sondern (a) ein neues Regelfeld
 * (`macdHistPct` o. Ä.) und (b) eine **Versionserhöhung** — `MACD_MOMENTUM_VERSION`
 * ist Teil des Artefakt-Hashs (04-01).
 *
 * ── Die Idee in einem Satz ─────────────────────────────────────────────────
 * Das Momentum dreht (Histogramm über null), der Kurs liegt über seinem
 * EMA 50 (nicht nur „irgendwie darüber“, sondern mit Vorgabe), und der ADX
 * bestätigt, dass überhaupt eine gerichtete Bewegung läuft — erst dann darf
 * die Regel handeln. Alle drei Bedingungen sind eine **Konjunktion**
 * (`logic: "all"`); ein Histogramm-Vorzeichen allein wäre ein Münzwurf.
 *
 * ── Warum `gt` (und nicht `gte`) für `priceVsEma50Pct` ─────────────────────
 * Die Bedingung heißt `priceVsEma50Pct gt ema50BufferPct` und ist damit
 * **strikt** — der Default `0.0` verlangt „Kurs über EMA 50“, nicht „auf
 * EMA 50“. Das ist der Unterschied zu 03-03 (`gte`, dort mit Buffer über der
 * `trend`-Hysterese): hier ist der Buffer eine Vorzeichen-/Momentumfrage, kein
 * Mindestabstand. Der Fall „Kurs exakt auf dem EMA 50“ ist mit `gt 0` per
 * Definition kein Reclaim — und weil `min: -1` erlaubt ist, kann 06-02 messen,
 * ob der frühe Histogramm-Impuls **unter** dem EMA 50 bereits trägt (eine
 * fachliche Frage, keine Empfehlung: die Antwort darf „nein“ sein).
 *
 * ── Warum `adxMin` hier 20 statt 22 ist ────────────────────────────────────
 * 03-03 verlangt den ADX als *primären* Trendnachweis über einer bereits
 * expliziten Trendordnung (`trend = UP` plus EMA-50-Buffer) und setzt ihn
 * deshalb mit 22 an. Hier ist der Auslöser das **Histogramm-Vorzeichen**, der
 * ADX ist der nachgeordnete „läuft überhaupt eine gerichtete Bewegung“-Filter;
 * 20 liegt genau am unteren Rand der üblichen „Trend beginnt“-Lesart und lässt
 * dem Raster (14…35) nach unten Luft. Der Wert ist eine Setzung, keine
 * Messung — er ist der erste Kandidat, den 06-02 verschieben wird.
 *
 * ── Warm-up: 35 Kerzen für das Histogramm, 29 für den ADX ──────────────────
 * `macd(closes, 12, 26, 9)` in `src/lib/indicators.ts` verlangt
 * `closes.length >= slow + signalPeriod` = **35 Schlusskurse**, sonst `null`.
 * `adx(closes, 14)` verlangt `2 * period + 1` = **29 Kerzen**. Beide Felder
 * fallen bei zu kurzer Historie **fail-closed**: `null` erfüllt keine
 * Vergleichsbedingung, die Regel schweigt, statt einen Wert zu erfinden. Der
 * Snapshot selbst (`buildSnapshotFromCandles`) existiert schon ab 25 Kerzen —
 * Rechenbarkeit ist also keine Aussage über Belastbarkeit. (Einzelheiten als
 * `critical: true`-Annahmen unten.)
 *
 * ── Warum `supportedTimeframes` nur `1h` und `4h` sind ─────────────────────
 * Dieselbe Fachentscheidung wie in 03-03, hier zusätzlich MACD-spezifisch:
 *   - 35 Kerzen sind auf `5m` knapp drei Stunden, auf `1m` rund eine halbe.
 *     Das Histogramm-Vorzeichen misst dann die Mikrostruktur einer einzigen
 *     Session-Phase (Spreads, Orderfluss) — die „Momentum“-Aussage ist auf dem
 *     feinen Takt eine andere Größe als auf `1h`/`4h`, und ein Vorzeichen kann
 *     sich innerhalb von Minuten mehrfach drehen, ohne dass der Markt seine
 *     Richtung geändert hat.
 *   - Die Kostenseite verschärft das: der Spread-/Slippage-Fallback des
 *     Backtests ist auf `1m` 15 bp und auf `5m` 10 bp, auf `1h` 4 bp und auf
 *     `4h` 3 bp (`docs/BACKTESTING.md`). Ein Vorzeichen-Oszillator auf einem
 *     10-bp-Takt bezahlt je Drehung und hat keine Edge-Komponente, die das
 *     trägt.
 * Die Engine-Allowlist (`RULE_ALLOWED_TIMEFRAMES`) ließe `3m`…`30m` zu — die
 * Beschränkung ist die des **Templates**, nicht die der Engine (STX-01).
 * `1d`/`5d` sind fachlich denkbar, aber nicht Teil dieses Prompts;
 * `supportedTimeframes` ist Teil des Artefakt-Hashs, eine Erweiterung wäre
 * eine Versionserhöhung — kein Nebenprodukt.
 *
 * ── Warum `window.timeframe = 1h`, obwohl `4h` unterstützt wird ────────────
 * `RuleSpec` trägt genau **einen** `timeframe`; welcher der beiden Takte eine
 * konkrete Regel bekommt, entscheidet der Compiler (03-09). Der Default ist
 * das feinere `1h`, aus denselben zwei Gründen wie in 03-03: `sanitizeRuleSpec`
 * fällt bei einem unbekannten Wert auf `15m` zurück (einen Takt, den dieses
 * Template nicht bedient), und der Mikro-Executor wertet live nur Regeln bis
 * zu seinem Ausführungsintervall aus — `4h` wäre dort ein Backtest-/Screening-
 * Artefakt.
 *
 * ── `maxExecutionsPerDay: 2`, `cooldownMinutes: 240` ───────────────────────
 * Ein Vorzeichen-Oszillator liefert in Seitwärtsphasen mehrere Wechsel pro
 * Woche; beide Deckel begrenzen die Zahl der Transaktionen, ohne das Signal zu
 * verändern. 240 Minuten sind auf `1h` vier Kerzen Abstand — derselbe Impuls
 * darf nicht mehrfach hintereinander gekauft werden. `maxExecutionsPerDay` ist
 * Teil der Regel, nicht der Strategie: der Backtest (03-10) respektiert es
 * genauso wie der Mikro-Executor.
 *
 * ── Verifizierte Risiko-Grenzen (im Code nachgeprüft, nicht aus dem Kopf) ───
 * `RULE_CEILINGS` (`src/lib/ruleEngine.ts`) leitet sich aus `LIMIT_CEILINGS`
 * (`src/lib/riskGuard.ts`) ab; der **gesamte** Parameterbereich dieses
 * Templates liegt innerhalb dieser Deckel — kein Rasterpunkt kann klemmen:
 *   | Wert des Templates | Deckel (gelesen) | Quelle |
 *   |---|---|---|
 *   | `riskBudgetPct: 0.01` | `maxRiskPerTrade [0.002, 0.05]` | `riskGuard.ts` |
 *   | `maxPositionPct: 0.15` | `maxPositionPct [0.01, 0.5]` | `riskGuard.ts` |
 *   | `stopLossPct ∈ [1, 12]` | `defaultStopLossPct [0.005, 0.2] × 100 = [0.5, 20]` | `ruleEngine.ts` → `RULE_CEILINGS` |
 *   | `takeProfitRR ∈ [1, 4]` | `takeProfitRR [0.5, 5]` | `riskGuard.ts` |
 *   | `maxExecutionsPerDay: 2` | `[1, 10]` | `RULE_CEILINGS` |
 *   | `cooldownMinutes: 240` | `[0, 1440]` | `RULE_CEILINGS` |
 *   | `volumeWindow: 20` | `[5, 200]` | `RULE_CEILINGS` |
 *
 * ── `symbol` ist Pflicht des **Aufrufers**, nicht des Builders ──────────────
 * Wie 03-03: `buildRule(params)` liefert **kein** `symbol`. Ein Symbol im
 * Builder wäre weder rein (dasselbe versionierte Artefakt lieferte je Markt
 * eine andere Regel) noch richtig adressiert (welcher Markt gehandelt wird,
 * entscheidet die Mission bzw. das Screening, nicht die Strategie). Der
 * Compiler (03-09) setzt es vor `sanitizeRuleSpec()`:
 * `{ ...template.buildRule(params), symbol }`. Ohne Symbol lehnt der Sanitizer
 * die Rohform ab — der gewünschte Fail-closed-Zustand, kein Fehler dieses
 * Templates.
 *
 * ── Was dieses Template bewusst NICHT tut ──────────────────────────────────
 *   - **Keine Magnitude-Bedingung auf `macdHist`** (siehe oben) — weder im
 *     Builder noch als Parameter. Es gibt deshalb hier auch keinen Parameter,
 *     der auf `macdHist` mappt.
 *   - **Kein `macd`/`macdSignal` als Regelfeld** — dieselbe Preiseinheiten-
 *     Falle; die Sperrliste des Prompts nennt sie ausdrücklich.
 *   - **Kein `SHORT`** — die negative Variante bräuchte einen `side`-Wert, den
 *     die Engine nicht kennt (`RULE_ALLOWED_SIDE = "LONG"` ist die einzige
 *     erlaubte Seite). Die `side` kommt aus dieser Konstanten, nicht aus einem
 *     abgeschriebenen Literal.
 *   - **Kein `bbZScore`** — das Feld gehört zum Bollinger-Template (03-06),
 *     nicht hierher.
 *   - **Kein ATR-skalierter Stop**: `stopLossPct` ist ein fester Prozentwert;
 *     die `atrPct`-Referenz in `mapsTo` dokumentiert nur den fachlichen Bezug.
 *   - **Kein Klemmen, keine Default-Reparatur**: Ein fehlender oder nicht
 *     endlicher Parameter ist ein Wurf, kein still auf `default` gesetzter
 *     Wert. Grenzen prüft der Katalog, Risiko klemmt der Sanitizer — beides
 *     repariert keine Tippfehler im Aufrufer.
 */

import { RULE_ALLOWED_SIDE } from "@/lib/ruleEngine";
import type { RuleField, RuleSpecInput } from "@/lib/ruleEngine";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";

import type { ParamSpec, StrategyAssumption, StrategyTemplate } from "../types";

/** Stabile Template-ID — identisch mit dem Eintrag in `STRATEGY_TEMPLATE_IDS`. */
export const MACD_MOMENTUM_ID = "macd-momentum" as const;

/**
 * Artefakt-Version. Monoton bei **Semantik**änderung (Regel, Timeframes,
 * Parameterraum, neue Bedingung) — nicht bei Formulierung. Teil des
 * Artefakt-Hashs (04-01).
 */
export const MACD_MOMENTUM_VERSION = 1 as const;

/** Keys des Parameterraums — die geschlossene Menge, die der Builder akzeptiert. */
export type MacdMomentumParamKey = "adxMin" | "ema50BufferPct" | "stopLossPct" | "takeProfitRR";

/**
 * Die Timeframes, auf denen das Template sinnvoll bewertet (Begründung im
 * Kopf). `satisfies` gegen das **bestehende** Vokabular: kein zweites
 * Timeframe-Register (STX-01).
 */
export const MACD_MOMENTUM_TIMEFRAMES = ["1h", "4h"] as const satisfies readonly SupportedTimeframe[];

/**
 * Der Parameterraum — bewusst der kleinste des Katalogs (Referenztemplate für
 * 06-02). `step` ist das **Raster** der Sensitivitätsanalyse (06-02): Jeder
 * Rasterpunkt muss eine gültige Regel ergeben und darf an keiner Stelle
 * klemmen, sonst misst die Analyse die Klemmung des Sanitizers statt der Edge.
 *
 * Kein Parameter mappt auf `macdHist` — es gibt hier nichts zu kalibrieren,
 * was nicht skalenfrei wäre (siehe Kopf).
 */
export const MACD_MOMENTUM_PARAMS: Readonly<Record<MacdMomentumParamKey, ParamSpec>> = {
  adxMin: {
    key: "adxMin",
    kind: "threshold",
    label: "ADX-Mindestwert",
    unit: "Index",
    // 20 statt 22 (03-03): der ADX ist hier der nachgeordnete Filter hinter dem
    // Histogramm-Vorzeichen, nicht der primäre Trendnachweis (Kopf).
    default: 20,
    // Der untere Rand ist keine Geschmacksfrage: adx() liefert erst ab 29
    // Kerzen einen Wert, und unter ~14 löst der ADX praktisch immer aus.
    min: 14,
    max: 35,
    step: 1,
    mapsTo: "adx14",
  },
  ema50BufferPct: {
    key: "ema50BufferPct",
    kind: "threshold",
    label: "Kurs über EMA 50",
    unit: "%",
    // 0.0 = „Kurs über EMA 50“, strikt (`gt`): der Fall „exakt auf dem EMA 50“
    // ist kein Reclaim. Der skalenfreie Ersatz für jede Magnitude-Frage.
    default: 0,
    // min -1 ist bewusst negativ: 06-02 soll messen, ob der frühe
    // Histogramm-Impuls auch UNTER dem EMA 50 schon trägt (Kopf).
    min: -1,
    max: 3,
    step: 0.1,
    mapsTo: "priceVsEma50Pct",
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
    // Der Auftrag lässt dieses Feld „ohne“ Mapping: Ein Zielkurs ist kein
    // Regelfeld. Der Vertrag (`ParamSpec.mapsTo: RuleField`) verlangt trotzdem
    // eines — gewählt ist `atrPct` wie in 03-03, weil Ziel und Stop Vielfache
    // derselben Volatilitätsstrecke sind. `mapsTo` ist Doku, keine Auswertung.
    mapsTo: "atrPct",
  },
};

/**
 * Die Default-Parameter — **abgeleitet** aus `MACD_MOMENTUM_PARAMS`, nie eine
 * zweite Liste (ein zweiter Default wäre ein Drift zwischen Raster und Regel).
 */
export const MACD_MOMENTUM_DEFAULTS: Readonly<Record<MacdMomentumParamKey, number>> = Object.fromEntries(
  (Object.keys(MACD_MOMENTUM_PARAMS) as MacdMomentumParamKey[]).map((key) => [key, MACD_MOMENTUM_PARAMS[key].default]),
) as Readonly<Record<MacdMomentumParamKey, number>>;

/**
 * Die Felder, die dieses Template auswertet. Der Typ ist die Whitelist selbst
 * (`RuleField = keyof typeof RULE_FIELDS`) — ein erfundenes Feld ist hier nicht
 * darstellbar.
 */
const REQUIRED_FIELDS: readonly RuleField[] = ["macdHist", "priceVsEma50Pct", "adx14", "atrPct"];

/**
 * Die Annahmen (06-01 auditiert sie). `critical: true` heißt: fällt sie weg,
 * ist das **Ergebnis** wertlos — nicht „weniger schön“.
 */
const ASSUMPTIONS: readonly StrategyAssumption[] = [
  {
    id: "macd-histogramm-vorzeichen",
    statement:
      "Das Vorzeichen des MACD-Histogramms dreht vor dem Trend: Die Drehung ist ein Frühindikator, kein " +
      "Nachläufer. Trifft das nicht zu, kommt das Signal nach der Bewegung — die Edge verschwindet in " +
      "ebenjener Strecke, die der Einstieg dann schon verpasst hat.",
    category: "MARKET",
    critical: false,
  },
  {
    id: "macd-hist-keine-staerke-metrik",
    statement:
      "`macdHist` wird ausdrücklich NICHT als Stärke-Metrik verwendet: Der Wert steht in Preiseinheiten " +
      "(macd − signal) und ist nicht skalenfrei — dieselbe Zahl bedeutet für BTC und einen 5-stelligen " +
      "Aktienkurs Verschiedenes. Die Regel nutzt nur das Vorzeichen (`gt 0`); die Stärke-/Lagefrage " +
      "beantwortet allein `priceVsEma50Pct` in Prozent.",
    category: "MARKET",
    critical: true,
  },
  {
    id: "macd-35-kerzen",
    statement:
      "MACD(12/26/9) braucht 35 Schlusskurse (slow 26 + signal 9); darunter liefert `macd()` null und die " +
      "Bedingung `macdHist gt 0` scheitert fail-closed — ohne Histogramm wird nicht gehandelt, statt einen " +
      "Wert zu erfinden.",
    category: "DATA",
    critical: true,
  },
  {
    id: "histogramm-wechsel-cooldown",
    statement:
      "Häufige Histogramm-Wechsel in Seitwärtsphasen werden durch Cooldown (240 min) und Tageslimit (2) " +
      "gedämpft; die verbleibende Transaktionszahl bleibt auf dem Niveau des Backtest-Kostenmodells " +
      "(Kosten-Fallback 1h: 4 bp, docs/BACKTESTING.md). Wird der Cooldown unterschritten, wächst die " +
      "Kostenseite schneller als die Signalzahl.",
    category: "COST",
    critical: false,
  },
  {
    id: "regime-trend-up",
    statement:
      "Funktioniert in TREND_UP. In RANGE wechselt das Vorzeichen ohne Richtung — die Bedingungen bleiben " +
      "formal erfüllbar, ohne dass ein Trend existiert; Tageslimit und Cooldown begrenzen den Schaden, " +
      "verhindern ihn aber nicht.",
    category: "REGIME",
    critical: false,
  },
  {
    id: "ema50-min-50-kerzen",
    statement:
      "priceVsEma50Pct bezieht sich auf einen echten EMA 50: buildSnapshotFromCandles() rechnet " +
      "ema(closes, min(50, closes.length)) — unter 50 Kerzen ist der Vergleichswert ein kürzerer EMA und " +
      "die Buffer-Bedingung sagt etwas anderes. Fachlich verlangt dieses Template 50 Kerzen " +
      "(1h ≈ 2 Tage, 4h ≈ 8 Tage Historie).",
    category: "DATA",
    critical: false,
  },
];

/** Anzeigename (deutsch) für Katalog, Workshop-UI und Reports. */
const NAME = "MACD Momentum";

const DESCRIPTION =
  "Momentum auf 1h/4h: Das MACD(12/26/9)-Histogramm muss über null drehen (nur das Vorzeichen — der Wert " +
  "steht in Preiseinheiten und ist nicht marktübergreifend vergleichbar), der Kurs mit einer Vorgabe über " +
  "seinem EMA 50 liegen (Default 0 %, also strikt darüber; die skalenfreie Stärkebedingung) und der " +
  "ADX(14) eine gerichtete Bewegung bestätigen (Default 20). Stop und Ziel sind feste Prozent- bzw. " +
  "Chance/Risiko-Werte, kein ATR-Kanal.";

/**
 * Liest einen Parameter **fail-closed**: fehlend oder nicht endlich ist ein
 * Fehler, keine Gelegenheit für einen Default. Stille Defaults wären eine
 * zweite Wahrheit über die Regel — und der Katalog könnte sie nicht finden.
 */
function paramValue(params: Readonly<Record<string, number>>, key: MacdMomentumParamKey): number {
  const raw: unknown = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `macd-momentum: Parameter „${key}“ fehlt oder ist keine endliche Zahl ` +
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
export function macdMomentumRule(params: Readonly<Record<string, number>>): RuleSpecInput {
  const adxMin = paramValue(params, "adxMin");
  const ema50BufferPct = paramValue(params, "ema50BufferPct");
  const stopLossPct = paramValue(params, "stopLossPct");
  const takeProfitRR = paramValue(params, "takeProfitRR");

  return {
    // Familienname ohne Symbol: das Symbol kommt vom Aufrufer.
    name: `${MACD_MOMENTUM_ID} v${MACD_MOMENTUM_VERSION}`,
    missionId: null,
    condition: {
      logic: "all",
      conditions: [
        // 1) Load-bearing: das Vorzeichen des Histogramms. Der Wert 0 ist die
        //    EINZIGE Konstante dieses Feldes, die auf jedem Markt dasselbe
        //    bedeutet — jede Magnitude wäre eine Wette auf das Kursniveau
        //    (Kopf, „DIE WICHTIGSTE ZEILE“).
        { field: "macdHist", op: "gt", value: 0 },
        // 2) Skalenfreier Ersatz: Kurs in Prozent über EMA 50, strikt (`gt`) —
        //    der Default 0.0 verlangt „über“, nicht „auf“ dem EMA 50.
        { field: "priceVsEma50Pct", op: "gt", value: ema50BufferPct },
        // 3) Richtungsbestätigung: ohne ADX kein Trend (null ⇒ Bedingung
        //    scheitert fail-closed).
        { field: "adx14", op: "gte", value: adxMin },
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
      // `timeframe` pro Regel; die Wahl zwischen 1h und 4h trifft der Aufrufer.
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      // 2 Versuche/Tag und 240 min Abklingzeit: auf 1h sind das vier Kerzen
      // Abstand — derselbe Impuls darf nicht mehrfach gekauft werden.
      maxExecutionsPerDay: 2,
      cooldownMinutes: 240,
      // Identisch zur 20-Perioden-Referenz von `volumeRatio` im Snapshot. Die
      // Regel nutzt kein Volumenfeld; der Wert steht trotzdem explizit im
      // Fenster, damit er nicht über den Sanitizer-Default entsteht.
      volumeWindow: 20,
    },
    rationale:
      `MACD-Momentum long: Histogramm (12/26/9) über null — nur das Vorzeichen, der Wert steht in ` +
      `Preiseinheiten und ist nicht marktübergreifend (macd − signal > 0), Kurs über EMA 50 um mehr als ` +
      `${num(ema50BufferPct)} % (skalenfreie Stärkebedingung), ADX(14) mindestens ${num(adxMin)} als ` +
      `Trendbestätigung. Ausstieg fest bei ${num(stopLossPct)} % Verlust oder ${num(takeProfitRR)}× ` +
      `Chance/Risiko.`,
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
 * das Ergebnis beim Import; `validateTemplate(buildMacdMomentum())` liefert `[]`.
 */
export function buildMacdMomentum(): StrategyTemplate {
  return {
    id: MACD_MOMENTUM_ID,
    name: NAME,
    description: DESCRIPTION,
    version: MACD_MOMENTUM_VERSION,
    // ADR-008: Klasse ist eine Fachaussage aus dem bestehenden Vokabular —
    // „trend“. Das ist deckungsgleich mit `strategyClassOfTemplate("macd-momentum")`
    // (Namens-Heuristik: „momentum“ ⇒ `trend`); der Test hält beide Richtungen.
    class: "trend",
    // ADR-010: nur SINGLE_SYMBOL; Universe-Auswahl gehört zu `src/crossSectional/`.
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: MACD_MOMENTUM_TIMEFRAMES,
    requiredFields: REQUIRED_FIELDS,
    params: MACD_MOMENTUM_PARAMS,
    buildRule: macdMomentumRule,
    assumptions: ASSUMPTIONS,
    // ADR-009: bestehendes MarketRegime-Vokabular, ohne UNKNOWN. In
    // TREND_DOWN gibt es kein Long-Setup, in RANGE wechselt das Vorzeichen
    // ohne Richtung.
    expectedRegimes: ["TREND_UP"],
  };
}
