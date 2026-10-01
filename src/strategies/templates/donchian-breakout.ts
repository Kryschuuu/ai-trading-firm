/**
 * STX-03-08 — Template: Donchian Breakout (Phase 3, Paket 03-02 / 02-03 ·
 * Finding STX-18).
 *
 * Sechstes und letztes Template der Reihe. Es nutzt `donchianBreakoutPct` aus
 * 02-03 und fügt dem Bestand nichts Neues hinzu: kein Indikator, kein
 * Regel-Feld, keine Änderung an `donchianChannel()`, `donchianBreakoutPct()`,
 * `RULE_FIELDS` oder `RULE_CEILINGS`. Klasse `breakout` aus ADR-E1 / ADR-008,
 * ausschließlich LONG (Shorts sind im Code global gesperrt —
 * `RULE_ALLOWED_SIDE`).
 *
 * ── Punkt 1 — Higher-Timeframe-only ─────────────────────────────────────────
 * „Donchian ist per Definition Ausbruchs-/Trendfolge-Systemik. Auf `5m` ist ein
 * 20-Bar-Kanal 100 Minuten — kein Ausbruch im Sinne der Strategie."
 * `supportedTimeframes = ["1h", "4h"]`.
 *
 * Deshalb steht hier auch kein feiner Takt, obwohl die Engine ihn zuließe
 * (`RULE_ALLOWED_TIMEFRAMES`): Ein 20-Bar-Kanal ist auf `1m`/`5m`/`15m` keine
 * „längere Nicht-Bestätigung" des Kurses, sondern Mikrostruktur. Derselbe
 * Schwellwert `breakoutMinPct` misst dort ein anderes Ereignis als auf `1h`/`4h`
 * — dieselbe Schwellensemantik auf beiden Seiten ist genau die
 * Fragmentierung, die STX-18/ADR-008 ausschließen. `1d`/`5d` sind fachlich
 * denkbar, aber nicht Teil dieses Prompts: `supportedTimeframes` ist Teil des
 * Artefakt-Hashs (04-01), eine Erweiterung wäre eine **Versionserhöhung**,
 * keine Nebenfolge. Der Wirkungsbereich ist damit ausdrücklich auf die
 * Higher-Timeframes `1h`/`4h` beschränkt.
 *
 * ── Punkt 2 — Der Ausbruch kostet ───────────────────────────────────────────
 * „Der Einstieg zum Schlusskurs **nach** einem Ausbruch über dem 20-Bar-Hoch
 * kauft typischerweise am lokalen Hoch. Das ist eine **strukturelle**
 * Eigenschaft, kein Parameterfehler — und genau der Grund, warum die
 * `takeProfitRR`-Vorgabe niedriger ist als beim EMA/ADX-Trend."
 *
 * Der Mechanismus dahinter: `donchianBreakoutPct > 0` heißt, die Signalkerze
 * hat den vorher bekannten Kanal bereits verlassen; ihr Schlusskurs ist das
 * bislang höchste Niveau des Fensters. Wer erst dann kauft, zahlt genau den
 * Aufschlag gegenüber dem Kanalhoch, den die Strategie als Signal liest. Jede
 * kleinere Auflösung des Parameters (`breakoutMinPct` gegen 0) kauft noch
 * dichter am Hoch, jede größere kauft noch später — die Kosten sind nicht
 * wegparametrisierbar, nur anders verteilt. Deshalb ist der Stop hier mit 5 %
 * weiter als bei 03-03/03-04 und das Ziel mit 2× Chance/Risiko nicht höher;
 * 06-02 muss die **realisierte** Ausführung (Fill gegen Signalkurs, Spread,
 * Slippage) messen, nicht die Signalqualität allein.
 *
 * Präzisierung gegenüber dem Auftrag (im Stil der σ-Korrektur aus 03-06): Der
 * Auftrag begründet mit der strukturellen Kostenaussage eine Vorgabe
 * „niedriger als beim EMA/ADX-Trend". Das gelieferte Parameterraster setzt den
 * Default mit `2` jedoch auf **denselben** Wert wie 03-03/03-04. Die
 * strukturelle Aussage trägt damit die Richtung — nicht über die Trend-Werte
 * hinauszugehen —, nicht eine Differenz zu 03-03. Vor einer Erhöhung über 2
 * muss 06-02 zeigen, dass der Einstieg am lokalen Hoch sie überhaupt trägt.
 *
 * ── Die Idee in einem Satz ──────────────────────────────────────────────────
 * Der Kurs schließt über dem Hoch der vorigen 20 Kerzen, der ADX bestätigt,
 * dass überhaupt eine gerichtete Bewegung läuft, und das Volumen der
 * Ausbruchskerze liegt über seinem 20er-Schnitt — alle drei Bedingungen
 * müssen gleichzeitig gelten, sonst passiert nichts.
 *
 * ── `entryPeriod` (20) ist Template-Konfiguration, kein Regelfeld ───────────
 * `donchianChannel(candles, entryPeriod, exitPeriod)` (02-01) lässt die
 * Fensterlänge offen; das **Regelfeld** `donchianBreakoutPct` (02-03) ist
 * dagegen an den kanonischen Default gebunden: Der Snapshot rechnet mit
 * `DONCHIAN_ENTRY_PERIOD = 20` (und `DONCHIAN_EXIT_PERIOD = 10`), ohne dass
 * eine Regel die Periode sieht. Dieses Template baut deshalb **kein**
 * `entryPeriod`-Regelfeld und keinen Parameter dafür — es würde den Feldwert
 * je Strategie unterschiedlich bedeuten lassen (genau die Warnung im Kopf von
 * `donchianBreakoutPct`). Solange die Periode 20 gewollt ist, ist sie mit dem
 * Snapshot-Default aus 02-03 bereits erfüllt.
 *
 * **Bekannte Grenze, bewusst nicht gebaut:** Wenn 06-02 eine **andere**
 * Periode testen will, braucht es **dann** ein zusätzliches Feld (bzw. eine
 * explizite, versionierte Snapshot-Definition) — nicht hier als stiller
 * Parameter. Ein `entryPeriod` in `params`, das die `RuleSpec` nicht erreicht,
 * wäre eine Zahl, die der Code nicht liest; ein Eingriff in
 * `donchianBreakoutPct`/`donchianChannel` ist durch diesen Prompt gesperrt.
 * Diese Grenze steht auch als Annahme `entry-period-ist-snapshot-default`
 * (06-01 auditiert sie).
 *
 * ── Ein Ausbruch pro Tag ────────────────────────────────────────────────────
 * `maxExecutionsPerDay: 1` ist fachlich zwingend, nicht nur Vorsicht: Ein
 * Ausbruch über dem 20-Bar-Hoch bleibt typischerweise mehrere Kerzen über dem
 * Kanal. Ohne die Tagesgrenze würde dasselbe Breakout-Charset an der nächsten
 * Kerze erneut feuern („Nachfolge-Einstiege am selben Ausbruch") und die
 * Kosten des lokalen Hochs mehrfach zahlen — für dieselbe Bewegung.
 * `cooldownMinutes: 720` (12 h) hält den Abstand auch über den Tageswechsel
 * hinweg, bleibt aber innerhalb von `RULE_CEILINGS.cooldownMinutes` ([0, 1440]).
 * `window.timeframe` ist explizit `1h`, nicht der Sanitizer-Fallback `15m`.
 *
 * ── Snapshot statt Sequenz ──────────────────────────────────────────────────
 * Die Regel ist zustandslos: Alle drei Bedingungen gelten auf derselben
 * geschlossenen Kerze. Der Lookahead-Schutz liegt **im Feld** — `upper` stammt
 * ausschließlich aus den vorigen 20 Kerzen, die Signalkerze ist ausgeschlossen
 * (02-01/02-03). Ein CROSS-/Sequenz-Trigger wäre eine neue Regel-Semantik und
 * ist nicht Teil dieses Prompts (vgl. STX-18 für den echten Reclaim).
 *
 * ── Datenhorizont und fail-closed ───────────────────────────────────────────
 * `donchianBreakoutPct` ist `null`, solange weniger als 21 Kerzen vorliegen
 * (oder das Kanalhoch `<= 0` ist) — nie eine erfundene 0. `adx(14)` braucht
 * 29 Kerzen. Fehlende Readings blockieren die Bedingung fail-closed; der
 * Builder setzt keine Defaults nach.
 *
 * ── Reiner Builder und bestehende Sicherheitskette (STX-05) ─────────────────
 * `buildRule(params)` liefert nur die ROHFORM (`RuleSpecInput`), ohne Symbol,
 * ohne IO, ohne Klemmung. Der Aufrufer (Compiler 03-09) setzt Symbol und den
 * gewählten unterstützten Timeframe, dann MUSS `sanitizeRuleSpec()` folgen —
 * ohne Symbol scheitert der Sanitizer wie bei den übrigen Templates.
 * `ParamSpec.mapsTo` ist Pflicht-Dokumentation und wird nicht ausgewertet:
 * `stopLossPct` und `takeProfitRR` referenzieren `atrPct` als Risikobezug;
 * `takeProfitRR` hat kein eigenes Regelfeld (im Auftrag „—"). Alle
 * Parametergrenzen liegen innerhalb der bestehenden `RULE_CEILINGS`; fehlende
 * oder nicht-endliche Parameter sind Fehler, keine stillen Defaults.
 */

import { RULE_ALLOWED_SIDE } from "@/lib/ruleEngine";
import type { RuleField, RuleSpecInput } from "@/lib/ruleEngine";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";

import type { ParamSpec, StrategyAssumption, StrategyTemplate } from "../types";

export const DONCHIAN_BREAKOUT_ID = "donchian-breakout" as const;

/** Monoton bei Semantikänderungen; Teil des Artefakt-Hashs (04-01). */
export const DONCHIAN_BREAKOUT_VERSION = 1 as const;

export type DonchianBreakoutParamKey =
  | "breakoutMinPct"
  | "adxMin"
  | "volumeRatioMin"
  | "stopLossPct"
  | "takeProfitRR";

/**
 * Higher-Timeframe-only (Punkt 1 im Kopf): `1h`/`4h`, kein Intraday-Takt.
 * `satisfies` gegen das **bestehende** Vokabular — kein zweites
 * Timeframe-Register (STX-01).
 */
export const DONCHIAN_BREAKOUT_TIMEFRAMES = ["1h", "4h"] as const satisfies readonly SupportedTimeframe[];

/**
 * Der Parameterraum. `step` ist das Raster der Sensitivitätsanalyse (06-02):
 * Jeder Rasterpunkt muss eine gültige Regel ergeben und darf an keiner Stelle
 * klemmen — sonst misst die Analyse die Klemmung des Sanitizers statt der Edge
 * der Strategie.
 */
export const DONCHIAN_BREAKOUT_PARAMS: Readonly<Record<DonchianBreakoutParamKey, ParamSpec>> = {
  breakoutMinPct: {
    key: "breakoutMinPct",
    kind: "threshold",
    label: "mind. Abstand über Kanal",
    unit: "%",
    // > 0 heißt „Schlusskurs über dem Kanalhoch"; 0.3 verlangt einen echten
    // Abstand statt eines Grenzfalls auf der Kante.
    default: 0.3,
    min: 0,
    max: 3,
    step: 0.1,
    mapsTo: "donchianBreakoutPct",
  },
  adxMin: {
    key: "adxMin",
    kind: "threshold",
    label: "ADX-Bestätigung",
    unit: "Index",
    default: 20,
    min: 14,
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
    // Weiter als bei 03-03/03-04: Der Einstieg sitzt am lokalen Hoch, der
    // Stop braucht Abstand zum normalen Rauschen (Punkt 2 im Kopf).
    default: 5,
    min: 1,
    max: 15,
    step: 0.5,
    mapsTo: "atrPct",
  },
  takeProfitRR: {
    key: "takeProfitRR",
    kind: "ratio",
    label: "Chance/Risiko",
    unit: "ratio",
    // Kein Anheben über die Trend-Werte: der Ausbruchseinstieg zahlt bereits
    // den lokalen Hoch-Punkt (Punkt 2 und Präzisierung im Kopf).
    default: 2,
    min: 1,
    max: 4,
    step: 0.25,
    // Kein eigenes Regelfeld; Pflicht-Mapping wie bei den übrigen Templates.
    mapsTo: "atrPct",
  },
};

/** Defaults ausschließlich aus dem Parameterraster abgeleitet (eine SSoT). */
export const DONCHIAN_BREAKOUT_DEFAULTS: Readonly<Record<DonchianBreakoutParamKey, number>> = Object.fromEntries(
  (Object.keys(DONCHIAN_BREAKOUT_PARAMS) as DonchianBreakoutParamKey[]).map((key) => [
    key,
    DONCHIAN_BREAKOUT_PARAMS[key].default,
  ]),
) as Readonly<Record<DonchianBreakoutParamKey, number>>;

const REQUIRED_FIELDS: readonly RuleField[] = ["donchianBreakoutPct", "adx14", "volumeRatio", "atrPct"];

/** Explizite Thesen und Grenzen; 06-01 prüft, ob sie tatsächlich tragen. */
const ASSUMPTIONS: readonly StrategyAssumption[] = [
  {
    id: "20-bar-ausbrueche-regimewechsel",
    statement:
      "20-Bar-Ausbrüche markieren Regime-Wechsel: Ein Schlusskurs über dem Hoch der vorigen 20 Kerzen ist ein " +
      "plausibles Signal für den Beginn einer neuen Aufwärtsbewegung — aber nur ein Signal, kein Beweis. " +
      "Fehlausbrüche sind Teil der Verteilung, nicht ein Defekt der Regel.",
    category: "MARKET",
    critical: false,
  },
  {
    id: "einstieg-am-lokalen-hoch",
    statement:
      "Der Einstieg erfolgt zum Schlusskurs NACH dem Ausbruch — das ist der lokale Hoch-Punkt; strukturelle " +
      "Properties, keine Parameterfrage. Der Fill liegt systematisch über dem Kanalhoch, weil die Signalkerze " +
      "den Kanal bereits hinter sich gelassen hat; keine Parametersetzung macht daraus einen frühen Einstieg.",
    category: "EXECUTION",
    critical: true,
  },
  {
    id: "vorige-20-kerzen-kein-lookahead",
    statement:
      "donchianBreakoutPct bezieht sich auf die VORIGEN 20 Kerzen, ohne die aktuelle (kein Look-ahead): Das " +
      "Kanalhoch stammt ausschließlich aus der vor der Signalkerze bekannten Historie. Die Signalkerze kann " +
      "sich nicht selbst bestätigen — `upper` enthält ihr eigenes Hoch ausdrücklich nicht.",
    category: "DATA",
    critical: true,
  },
  {
    id: "spread-am-lokalen-hoch",
    statement:
      "Breakout-Einstiege zahlen den Spread am lokalen Hoch: Spread und Slippage fallen auf einem Kurs an, der " +
      "bereits über dem Kanal liegt. Die Kosten wirken damit genau gegen die Position und sind in 06-02 gegen " +
      "die Signalqualität zu messen (Fill vs. Signalkurs), nicht wegzudefinieren.",
    category: "COST",
    critical: true,
  },
  {
    id: "ein-ausbruch-pro-tag",
    statement:
      "Ein Ausbruch bleibt typischerweise mehrere Kerzen über dem Kanal, deshalb maxExecutionsPerDay 1: Ohne " +
      "die Tagesgrenze erzeugte dasselbe Breakout-Charset Nachfolge-Einstiege am selben Ausbruch und zahlte die " +
      "Kosten des lokalen Hochs mehrfach für dieselbe Bewegung. Der Cooldown von 720 Minuten hält den Abstand " +
      "auch über den Tageswechsel hinweg.",
    category: "EXECUTION",
    critical: true,
  },
  {
    id: "entry-period-ist-snapshot-default",
    statement:
      "entryPeriod (20) ist kein Regelfeld, sondern Template-/Snapshot-Konfiguration: Der Snapshot rechnet mit " +
      "dem kanonischen Default DONCHIAN_ENTRY_PERIOD aus 02-03, die Regel sieht die Periode nicht. Eine andere " +
      "Periode braucht in 06-02 ein zusätzliches Feld (oder eine versionierte Snapshot-Definition) — bis dahin " +
      "ist die feste 20 die bekannte Grenze dieses Templates.",
    category: "DATA",
    critical: true,
  },
  {
    id: "warm-up-blockiert-fail-closed",
    statement:
      "donchianBreakoutPct ist null, solange weniger als 21 Kerzen vorliegen (oder das Kanalhoch <= 0 ist), und " +
      "adx(14) braucht 29 Kerzen. Fehlende Readings blockieren die Regel fail-closed — nie eine erfundene 0, " +
      "kein stiller Ersatzwert.",
    category: "DATA",
    critical: true,
  },
];

const NAME = "Donchian Breakout";
const DESCRIPTION =
  "Higher-Timeframe-Long-Ausbruch auf 1h/4h: Schlusskurs mindestens 0,3 % über dem Hoch der vorigen 20 Kerzen " +
  "(Donchian-Kanal ohne Signalkerze, kein Look-ahead), ADX(14) mindestens 20 und Volumen mindestens 1,2× des " +
  "20er-Schnitts. Höchstens ein Ausbruch pro Tag (Cooldown 12 h), weil dasselbe Breakout sonst mehrfach kauft; " +
  "der Einstieg erfolgt strukturell am lokalen Hoch. Stop 5 %, Ziel 2× Chance/Risiko.";

/** Keine stillen Defaults: fehlende oder nicht-endliche Parameter sind Fehler. */
function paramValue(params: Readonly<Record<string, number>>, key: DonchianBreakoutParamKey): number {
  const raw: unknown = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `donchian-breakout: Parameter „${key}“ fehlt oder ist keine endliche Zahl ` +
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
export function donchianBreakoutRule(params: Readonly<Record<string, number>>): RuleSpecInput {
  const breakoutMinPct = paramValue(params, "breakoutMinPct");
  const adxMin = paramValue(params, "adxMin");
  const volumeRatioMin = paramValue(params, "volumeRatioMin");
  const stopLossPct = paramValue(params, "stopLossPct");
  const takeProfitRR = paramValue(params, "takeProfitRR");

  return {
    name: `${DONCHIAN_BREAKOUT_ID} v${DONCHIAN_BREAKOUT_VERSION}`,
    missionId: null,
    condition: {
      logic: "all",
      conditions: [
        { field: "donchianBreakoutPct", op: "gte", value: breakoutMinPct },
        { field: "adx14", op: "gte", value: adxMin },
        { field: "volumeRatio", op: "gte", value: volumeRatioMin },
      ],
    },
    action: {
      side: RULE_ALLOWED_SIDE,
      stopLossPct,
      takeProfitRR,
      // Wie 03-03…03-07: Vergleichbarkeit ohne Änderung des Risikobudgets.
      riskBudgetPct: 0.01,
      maxPositionPct: 0.15,
      positionSizeMode: "risk",
    },
    window: {
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      // Ein Ausbruch pro Tag — dasselbe Breakout-Charset darf nicht mehrfach
      // kaufen; 720 Minuten Abstand auch über den Tageswechsel (Begründung
      // im Kopf, Abschnitt „Ein Ausbruch pro Tag").
      maxExecutionsPerDay: 1,
      cooldownMinutes: 720,
      volumeWindow: 20,
    },
    rationale:
      `Donchian-Ausbruch long (Higher-Timeframe): Schlusskurs mindestens ${num(breakoutMinPct)} % über dem Hoch ` +
      `der vorigen 20 Kerzen (Donchian-Kanal ohne Signalkerze, kein Look-ahead), ADX(14) mindestens ` +
      `${num(adxMin)}, Volumen mindestens ${num(volumeRatioMin)}× des 20er-Schnitts. Höchstens ein Ausbruch pro ` +
      `Tag; der Einstieg liegt strukturell am lokalen Hoch. Ausstieg bei ${num(stopLossPct)} % Verlust oder ` +
      `${num(takeProfitRR)}× Chance/Risiko.`,
    sourceRole: "RESEARCH",
    riskScore: 0.5,
  };
}

/** Frisches Artefakt; der Katalog validiert es beim Import. */
export function buildDonchianBreakout(): StrategyTemplate {
  return {
    id: DONCHIAN_BREAKOUT_ID,
    name: NAME,
    description: DESCRIPTION,
    version: DONCHIAN_BREAKOUT_VERSION,
    class: "breakout",
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: DONCHIAN_BREAKOUT_TIMEFRAMES,
    requiredFields: REQUIRED_FIELDS,
    params: DONCHIAN_BREAKOUT_PARAMS,
    buildRule: donchianBreakoutRule,
    assumptions: ASSUMPTIONS,
    expectedRegimes: ["TREND_UP", "RANGE"],
  };
}
