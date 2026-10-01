/**
 * STX-03-06 — Template: Bollinger Squeeze Breakout (Phase 3,
 * Paket 03-02 / 02-02 · Finding STX-18).
 *
 * Viertes Strategie-Artefakt und erstes Template mit einem neuen Regelfeld
 * aus Phase 2: `bbZScore` (02-02). Es liest ausschließlich bestehende
 * Snapshot-Felder; `bollingerBandWidthPct`, Bandformel, Cache und Regel-DSL
 * bleiben unverändert. Klasse `breakout` aus ADR-E1 / ADR-008, nur LONG.
 * Die Klasse wird explizit deklariert, nicht aus dem Namen abgeleitet: Die
 * Legacy-Heuristik `strategyClassOfTemplate` kennt „squeeze“ noch nicht; der
 * Template-Compiler (03-09) muss die deklarierte Klasse transportieren.
 *
 * ── Bandbreite: ein kalibrierbarer Parameter, keine marktneutrale Zahl ─────
 * `bbwPct` = (upper − lower) / middle · 100 ist die relative Breite des
 * Bollinger(20, 2)-Fensters in Prozent, NICHT dessen Perzentil. Eine Breite
 * von 6 % hat auf einer Large-Cap-Aktie und einem Crypto-Paar sowie auf `1h`
 * und `4h` unterschiedliche Bedeutung. `bbwMaxPct` ist deshalb ein eigener
 * Template-Parameter; der Anwendungsbereich ist ausschließlich `1h`/`4h`,
 * keine Zusage marktübergreifender oder regimeübergreifender Kalibrierung.
 *
 * Der vorgegebene Default 6 % ist ein **vorläufiger Research-Startwert**,
 * keine bereits vermessene 20. Perzentile. Kalibrierungsweg für 06-01/06-02:
 * die 20. Perzentile gültiger `bbwPct`-Readings über die letzten 200 bereits
 * geschlossenen Kerzen auf `1h` gegen den Store prüfen; `4h` separat messen,
 * nach Markt und Regime auswerten und auf dem Parameterraster vergleichen.
 * Diese Herleitung ist VOR einem Live-Einsatz zu verifizieren, nicht im
 * Builder zu erfinden. Der Builder hat keinen Store-/Marktdatenzugriff und
 * berechnet insbesondere kein rollendes Perzentil und keine neue Bandbreite.
 *
 * ── σ-Rechnung: warum der frühe Default 0.5 und nicht 2 ist ────────────────
 * Die Definition aus 02-02 (`bollingerPosition`) ist verbindlich:
 *
 *   bbZScore = (close − middle) / σ
 *   upper = middle + 2 · σ
 *   close == upper ⇒ z = (2 · σ) / σ = 2                 (σ > 0)
 *   z = 0.5 ⇒ close = middle + 0.5 · σ < upper
 *
 * An der oberen Bandkante gilt also z = 2, NICHT z ≈ 1.4; dafür ist keine
 * Normalverteilungsannahme erforderlich. 2 ist die Kante, erst > 2 ist ein
 * strikter Ausbruch darüber. Der gewünschte Default 0.5 verlangt bewusst
 * nur einen Kurs oberhalb der mittleren Bandlinie: ein frühes Ausbruchssetup
 * im noch engen Band, KEINE Bestätigung eines Bruchs der oberen Kante.
 * Der angeforderte Parameter-Label „Kurs über oberer Bandkante“ benennt das
 * klassische Zielbild; die tatsächliche Aussage hängt von der σ-Schwelle ab.
 *
 * `priceVsUpperBbPct gte 0` wäre bei σ > 0 ein ALTERNATIVER Kantenfilter,
 * äquivalent zu `bbZScore gte 2`, nicht zum frühen Default 0.5. Hier ist
 * `bbZScore` verfügbar: keine Kombination und kein stiller Ersatz bei null.
 * Bei σ == 0 bleibt `bbZScore` null und blockiert die Regel fail-closed.
 *
 * ── Snapshot statt Sequenz: bewusste Vereinfachung ─────────────────────────
 * Ein klassischer Squeeze ist „vorher eng, jetzt weit“. Die vier Bedingungen
 * dieses Templates gelten hingegen ALLE auf derselben geschlossenen Kerze:
 * enges Band, frühe positive Bandposition, ADX- und Volumenbestätigung.
 * Der Schlusskurs der Signalkerze ist bereits Teil des 20er-Bandes und kann
 * dessen Breite erhöhen. Weder eine vorherige Kontraktion noch eine folgende
 * Expansion wird bewiesen. Kein CROSS-/Sequenz-Trigger, kein Zustand; die
 * Annahme `snapshot-statt-sequenz` macht diese Grenze auditierbar (06-01).
 *
 * ── Reiner Builder und bestehende Sicherheitskette (STX-05) ─────────────────
 * `buildRule(params)` liefert nur `RuleSpecInput`, ohne Symbol, ohne IO und
 * ohne Klemmung. Der Aufrufer (Compiler 03-09) setzt Symbol und den gewählten
 * unterstützten Timeframe, dann MUSS `sanitizeRuleSpec()` folgen. Ohne Symbol
 * scheitert der Sanitizer wie bei den übrigen Templates fail-closed.
 * `window.timeframe` ist explizit `1h`, nicht der Sanitizer-Fallback `15m`.
 * Alle Parametergrenzen liegen innerhalb der bestehenden `RULE_CEILINGS`;
 * fehlende/nicht-endliche Parameter sind Fehler, keine stillen Defaults.
 *
 * Stop und Ziel sind feste Prozent-/R:R-Werte, kein ATR-skalierter Stop.
 * `ParamSpec.mapsTo` ist verpflichtende Felddokumentation: `stopLossPct` und
 * `takeProfitRR` referenzieren wie in 03-03…03-05 `atrPct` als Risikobezug;
 * R:R hat kein eigenes Regelfeld (im Auftrag „—“). Das Mapping wird nicht
 * ausgewertet. Periode 20 und Multiplikator 2 sind Snapshot-Definitionen,
 * KEINE Bollinger-Parameter in der `RuleSpec`.
 */

import { RULE_ALLOWED_SIDE } from "@/lib/ruleEngine";
import type { RuleField, RuleSpecInput } from "@/lib/ruleEngine";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";

import type { ParamSpec, StrategyAssumption, StrategyTemplate } from "../types";

export const BOLLINGER_SQUEEZE_ID = "bollinger-squeeze" as const;

/** Monoton bei Semantikänderungen; Teil des Artefakt-Hashs (04-01). */
export const BOLLINGER_SQUEEZE_VERSION = 1 as const;

export type BollingerSqueezeParamKey =
  | "bbwMaxPct"
  | "bbZScoreMin"
  | "adxMin"
  | "volumeRatioMin"
  | "stopLossPct"
  | "takeProfitRR";

export const BOLLINGER_SQUEEZE_TIMEFRAMES = ["1h", "4h"] as const satisfies readonly SupportedTimeframe[];

/** Parameterraum; `step` ist das Raster der Sensitivitätsanalyse (06-02). */
export const BOLLINGER_SQUEEZE_PARAMS: Readonly<Record<BollingerSqueezeParamKey, ParamSpec>> = {
  bbwMaxPct: {
    key: "bbwMaxPct",
    kind: "threshold",
    label: "maximale Bandbreite (Squeeze)",
    unit: "%",
    // Vorläufiger Default, markt-/timeframe-/regimeabhängig; Kalibrierungsweg
    // über die 20. Perzentile von 200 Kerzen und Store-Prüfung siehe Kopf.
    default: 6,
    min: 2,
    max: 15,
    step: 0.25,
    mapsTo: "bbwPct",
  },
  bbZScoreMin: {
    key: "bbZScoreMin",
    kind: "threshold",
    label: "Kurs über oberer Bandkante",
    unit: "σ",
    // 0.5 σ über der MITTE, nicht über der oberen Kante (2 σ); Rechnung im Kopf.
    default: 0.5,
    min: 0,
    max: 3,
    step: 0.1,
    mapsTo: "bbZScore",
  },
  adxMin: {
    key: "adxMin",
    kind: "threshold",
    label: "ADX-Bestätigung",
    unit: "Index",
    default: 22,
    min: 15,
    max: 35,
    step: 1,
    mapsTo: "adx14",
  },
  volumeRatioMin: {
    key: "volumeRatioMin",
    kind: "threshold",
    label: "Volumen beim Ausbruch",
    unit: "ratio",
    default: 1.2,
    min: 0.9,
    max: 3,
    step: 0.05,
    mapsTo: "volumeRatio",
  },
  stopLossPct: {
    key: "stopLossPct",
    kind: "threshold",
    label: "Stop-Loss",
    unit: "%",
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
    default: 2.5,
    min: 1,
    max: 5,
    step: 0.25,
    // Kein eigenes Regelfeld; Pflicht-Mapping wie bei den übrigen Templates.
    mapsTo: "atrPct",
  },
};

/** Defaults ausschließlich aus dem Parameterraster abgeleitet (eine SSoT). */
export const BOLLINGER_SQUEEZE_DEFAULTS: Readonly<Record<BollingerSqueezeParamKey, number>> = Object.fromEntries(
  (Object.keys(BOLLINGER_SQUEEZE_PARAMS) as BollingerSqueezeParamKey[]).map((key) => [
    key,
    BOLLINGER_SQUEEZE_PARAMS[key].default,
  ]),
) as Readonly<Record<BollingerSqueezeParamKey, number>>;

const REQUIRED_FIELDS: readonly RuleField[] = ["bbwPct", "bbZScore", "adx14", "volumeRatio", "atrPct"];

/** Explizite Thesen und Grenzen; 06-01 prüft, ob sie tatsächlich tragen. */
const ASSUMPTIONS: readonly StrategyAssumption[] = [
  {
    id: "kontraktion-vor-expansion",
    statement:
      "Volatilitätskontraktion geht einer Expansion voraus. Ein enges Bollinger-Band ist ein plausibles " +
      "Ausbruchssetup, aber weder eine Garantie für Expansion noch für deren Richtung.",
    category: "MARKET",
    critical: true,
  },
  {
    id: "bbw-kalibrierung",
    statement:
      "bbwPct ist nicht marktübergreifend; die Schwelle ist markt-, timeframe- und regime-spezifisch. " +
      "Der vorläufige Default 6 % für 1h/4h ist vor Live-Einsatz gegen den Store zu prüfen: in 06-01/06-02 " +
      "die 20. Perzentile über die letzten 200 geschlossenen Kerzen je Markt/Timeframe/Regime vermessen.",
    category: "DATA",
    critical: true,
  },
  {
    id: "schlusskurs-latenz",
    statement:
      "Der Ausbruch wird am Schluss der Kerze erkannt, gehandelt wird zum Schlusskurs. Im Live-Pfad ist " +
      "das eine kritische Latenzannahme: Erkennung und Order folgen erst nach Kerzenschluss; ein Fill zum " +
      "beobachteten Schlusskurs ist nicht garantiert und muss mit Slippage geprüft werden.",
    category: "EXECUTION",
    critical: true,
  },
  {
    id: "squeeze-kosten-rr",
    statement:
      "Squeeze-Phasen haben niedrige Volatilität; R:R muss die höhere Trefferzahl und deren Kosten " +
      "ausgleichen. Das vorläufige Ziel 2,5× muss nach Gebühren und Slippage in 06-02 geprüft werden; " +
      "ein engeres Band allein belegt keine profitable Trefferquote.",
    category: "COST",
    critical: false,
  },
  {
    id: "snapshot-statt-sequenz",
    statement:
      "Bewusste Vereinfachung im Snapshot-Dialekt: Alle vier Bedingungen gelten auf derselben " +
      "geschlossenen Kerze, nicht als Sequenz vorher eng, jetzt weit. Die Signalkerze steckt bereits " +
      "im Band und kann es weiten; vorherige Kontraktion und folgende Expansion werden nicht geprüft.",
    category: "DATA",
    critical: true,
  },
  {
    id: "fruehe-bandposition",
    statement:
      "bbZScoreMin 0,5 bedeutet mindestens 0,5 σ über der Bandmitte, nicht über der oberen Bandkante " +
      "(z = 2). ADX und Volumen sollen das frühe Setup bestätigen; eine Überschreitung der oberen " +
      "Kante wird beim Default nicht verlangt.",
    category: "MARKET",
    critical: false,
  },
  {
    id: "indikator-warm-up",
    statement:
      "Das Bollinger-Band braucht 20 Schlusskurse, ADX(14) 29 Kerzen. Fehlende Readings blockieren " +
      "die Regel fail-closed; bei σ == 0 bleibt bbZScore null, auch wenn bbwPct und Kantenabstand " +
      "echte Nullen liefern. Kein stiller Ersatz durch priceVsUpperBbPct.",
    category: "DATA",
    critical: true,
  },
];

const NAME = "Bollinger Squeeze Breakout";
const DESCRIPTION =
  "Frühes Long-Ausbruchssetup auf 1h/4h: enges Bollinger(20, 2σ)-Band (vorläufig maximal 6 %), Kurs " +
  "mindestens 0,5 σ über der Bandmitte, ADX(14) mindestens 22 und Volumen mindestens 1,2× des 20er-Schnitts. " +
  "Snapshot-Vereinfachung, keine Squeeze-Sequenz und beim Default kein bestätigter Bruch der oberen Kante. " +
  "Die Bandbreitenschwelle ist markt-/timeframe-/regimeabhängig; Stop 4 %, Ziel 2,5× Chance/Risiko.";

/** Keine stillen Defaults: fehlende oder nicht-endliche Parameter sind Fehler. */
function paramValue(params: Readonly<Record<string, number>>, key: BollingerSqueezeParamKey): number {
  const raw: unknown = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `bollinger-squeeze: Parameter „${key}“ fehlt oder ist keine endliche Zahl ` +
        `(ist ${raw === null ? "null" : Array.isArray(raw) ? "Array" : typeof raw}).`,
    );
  }
  return raw;
}

/** Nur die Anzeige wird gerundet, niemals die Bedingung oder das Risiko. */
function num(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** Reine Parameterfunktion; Symbol und Sanitizer sind Pflicht des Aufrufers. */
export function bollingerSqueezeRule(params: Readonly<Record<string, number>>): RuleSpecInput {
  const bbwMaxPct = paramValue(params, "bbwMaxPct");
  const bbZScoreMin = paramValue(params, "bbZScoreMin");
  const adxMin = paramValue(params, "adxMin");
  const volumeRatioMin = paramValue(params, "volumeRatioMin");
  const stopLossPct = paramValue(params, "stopLossPct");
  const takeProfitRR = paramValue(params, "takeProfitRR");

  return {
    name: `${BOLLINGER_SQUEEZE_ID} v${BOLLINGER_SQUEEZE_VERSION}`,
    missionId: null,
    condition: {
      logic: "all",
      conditions: [
        { field: "bbwPct", op: "lte", value: bbwMaxPct },
        { field: "bbZScore", op: "gte", value: bbZScoreMin },
        { field: "adx14", op: "gte", value: adxMin },
        { field: "volumeRatio", op: "gte", value: volumeRatioMin },
      ],
    },
    action: {
      side: RULE_ALLOWED_SIDE,
      stopLossPct,
      takeProfitRR,
      // Wie 03-03…03-05: Vergleichbarkeit ohne Änderung des Risikobudgets.
      riskBudgetPct: 0.01,
      maxPositionPct: 0.15,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      // Vier 1h-Kerzen bzw. eine 4h-Kerze Abstand, kein Cross-Trigger.
      maxExecutionsPerDay: 2,
      cooldownMinutes: 240,
      volumeWindow: 20,
    },
    rationale:
      `Bollinger-Squeeze long (Snapshot, keine Sequenz): Bandbreite höchstens ${num(bbwMaxPct)} % ` +
      `(markt-/timeframe-/regimeabhängig), Kurs mindestens ${num(bbZScoreMin)} σ über der Bandmitte, ` +
      `ADX(14) mindestens ${num(adxMin)}, Volumen mindestens ${num(volumeRatioMin)}× des 20er-Schnitts. ` +
      `Ausstieg bei ${num(stopLossPct)} % Verlust oder ${num(takeProfitRR)}× Chance/Risiko.`,
    sourceRole: "RESEARCH",
    riskScore: 0.5,
  };
}

/** Frisches Artefakt; der Katalog validiert es beim Import. */
export function buildBollingerSqueeze(): StrategyTemplate {
  return {
    id: BOLLINGER_SQUEEZE_ID,
    name: NAME,
    description: DESCRIPTION,
    version: BOLLINGER_SQUEEZE_VERSION,
    class: "breakout",
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: BOLLINGER_SQUEEZE_TIMEFRAMES,
    requiredFields: REQUIRED_FIELDS,
    params: BOLLINGER_SQUEEZE_PARAMS,
    buildRule: bollingerSqueezeRule,
    assumptions: ASSUMPTIONS,
    expectedRegimes: ["RANGE", "TREND_UP"],
  };
}
