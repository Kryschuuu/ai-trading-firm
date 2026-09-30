/**
 * STX-03-05 — Template: RSI Mean-Reversion (Phase 3, Paket 03-02 · Finding STX-18).
 *
 * Das dritte Strategie-Artefakt des Katalogs — und das **erste mit
 * `class: "mean-reversion"`**. Damit ist es zugleich der Testfall für ADR-E1
 * (ADR-008): 03-03 und 03-04 tragen beide `trend`, also die Klasse, für die das
 * Regime-Gate **nichts** dämpft (Faktor 1 in `TREND_UP`). Erst hier wird
 * sichtbar, ob die Klassifikation trägt: `mean-reversion` hat in `TREND_UP` und
 * `TREND_DOWN` den Faktor **0.5**, in `RANGE` den Faktor **1** — gelesen aus
 * `DEFAULT_MARKET_REGIME_CONFIG.gateFactors` (`src/lib/marketRegime.ts`), nicht
 * gesetzt. Dieses Template erfindet keine Klasse, kein Regime und keinen
 * Faktor; es **nutzt** das bestehende Vokabular und wird von ihm gedämpft.
 *
 * Wie 03-03/03-04 ist es ein **reines Parameterraster über dem bestehenden
 * `RuleSpec`-Vertrag**: kein neues Feld, kein neuer Indikator, keine Änderung
 * an `ruleEngine.ts`, `RULE_CEILINGS`, `ruleFieldCatalog.ts` oder
 * `indicators.ts`. `rsi14`, `priceVsEma21Pct`, `adx14`, `volumeRatio` und
 * `atrPct` stehen alle längst im Snapshot.
 *
 * ── Die Idee in einem Satz ─────────────────────────────────────────────────
 * Der Markt ist seitwärts (`adx14` **niedrig**), der Kurs ist unter seinen
 * EMA 21 gefallen (`priceVsEma21Pct` unter der Vorgabe), der RSI(14) steht
 * überverkauft und die Signalkerze trägt überdurchschnittliches Volumen — erst
 * dann kauft die Regel den Rücklauf zum Mittel. Alle vier Bedingungen sind eine
 * Konjunktion (`logic: "all"`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DOK-PFLICHT 1 — Warum `adx14` ein MAXIMUM ist (`lte`), kein Minimum
 * ══════════════════════════════════════════════════════════════════════════
 * In 03-03 und 03-04 steht `adx14 gte adxMin`: dort ist ein hoher ADX der
 * **Nachweis**, dass die gerichtete Bewegung existiert, auf die die Regel
 * aufspringt. Genau dieselbe Bedingung hier wäre eine Umkehrung der Strategie:
 * Mean-Reversion verdient an der Rückkehr zum Mittel, und die
 * Rückkehr gibt es nur, solange **kein** Trend läuft. Ein hoher ADX ist für
 * dieses Template kein Bestätigungs-, sondern ein **Ausschlussmerkmal** — er
 * sagt, dass die Überdehnung kein Ausrutscher ist, sondern der Anfang einer
 * gerichteten Bewegung, die der Long-Einstieg dann gegen sich hat.
 *
 * Der Parameter heißt deshalb `adxMax` und die Bedingung `adx14 lte adxMax`.
 * Das ist keine kosmetische Namensfrage, sondern der Unterschied zwischen zwei
 * gegensätzlichen Wetten auf dieselbe Zahl:
 *   - **Ohne** diesen Filter ist das Template kein Mean-Reversion-, sondern ein
 *     „Catching the falling knife"-System: RSI niedrig + Kurs unter dem EMA 21
 *     trifft in einem echten Abwärtstrend **jeden Tag** zu (RSI(14) fällt in
 *     einer monoton fallenden Reihe auf ~0, der Kurs liegt weit unter seinem
 *     EMA 21) — und genau dort ist der Kauf falsch. Der Testfall dazu liegt
 *     `tests/strategies.rsiMeanReversion.test.ts`: eine monoton fallende Reihe
 *     erfüllt RSI, EMA-21-Abstand und Volumen, und **nur** der ADX-Filter hält
 *     die Regel zurück (`adx14 = 100` bei `adxMax <= 30`).
 *   - Der ADX-Filter ist damit der **zweite** der beiden richtungsgebenden
 *     Filter dieses Templates: `rsi14` markiert die Überdehnung, `adx14`
 *     schließt den Trend aus. Ersterer liefert den Kandidaten, letzterer
 *     entscheidet, ob es ein Mean-Reversion-Kandidat ist.
 *   - Fail-closed: Bei zu kurzer Historie ist `adx14` `null` (Wilder-ADX(14)
 *     braucht 29 Kerzen), und `null` erfüllt `lte` **nicht** — kein Trade mit
 *     einem erfundenen Wert.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DOK-PFLICHT 2 — Warum `takeProfitRR` hier 1.5 ist, nicht 2 (03-03/03-04)
 * ══════════════════════════════════════════════════════════════════════════
 * Beide Trend-Templates verlangen `takeProfitRR: 2`. Das ist bei Trendfolge
 * vertretbar, weil der Ausstieg dort an der **Bewegung** hängt: läuft der
 * Trend weiter, läuft der Gewinn mit, und die Trefferquote ist zweitrangig
 * gegenüber der Größe der wenigen großen Gewinne.
 *
 * Mean-Reversion ist das Spiegelbild: Das Ziel ist **begrenzt** (die Rückkehr
 * zum Mittel — der EMA 21, die Range-Mitte), der Stop dagegen ist die
 * Feststellung, dass es kein Mittel gibt, zu dem zurückgekehrt wird. Die
 * Trefferquote ist damit strukturell niedriger als bei Trendfolge, und die
 * Erwartung muss über ein **kleineres** Chance/Risiko-Verhältnis kommen:
 *   Erwartungswert ≈ Trefferquote × RR − (1 − Trefferquote). Bei RR = 2
 *   bräuchte diese Klasse eine Trefferquote > 33 %, bei RR = 1.5 nur > 40 %
 *   — gezahlt wird der Unterschied in einem **kleineren** Ziel je Gewinntrade.
 * Genau diese Rechnung ist der Grund, warum die Klasse eine eigene
 * Decay-Policy hat (`DEFAULT_CLASS_POLICIES`, Eintrag der Klasse
 * `mean-reversion`: Halbwertszeit 4 h statt 24 h bei `trend`,
 * `absoluteDrop 0.25`, `minHoldMs 15 min`): Das Signal ist kurzlebig, weil die
 * Bewegung, die es ausnutzt, kurzlebig ist.
 *
 * Bewusst **nicht** getan: das Ziel an die Range-Mitte zu hängen (etwa „Ziel =
 * EMA 21“). `RuleSpec` kennt nur `takeProfitRR` als **Vielfaches des Stops**,
 * kein Kursziel — ein Ziel-`RuleSpec`-Feld wäre neue Engine-Semantik (STX-18).
 * Dass der Default bei 1.5 liegt und der Raster bis 4 geht, ist gewollt: 06-02
 * soll das Plateau **sehen**, nicht die Vorsicht des Defaults bestätigen.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DOK-PFLICHT 3 — Warum `bbZScore` hier FEHLT (Reihenfolge-Abhängigkeit)
 * ══════════════════════════════════════════════════════════════════════════
 * Die Analyse schlägt für Mean-Reversion den Bollinger-Z-Score vor — und damit
 * zu Recht: `bbZScore` ist **normalisiert** (Abstand zur BANDMITTE in
 * Standardabweichungen, `ruleFieldCatalog.ts`:
 * „Kurs vs. Bollinger-Mitte (20/2σ), Standardabweichungen“), während `rsi14`
 * ein Index 0…100 mit einer asymmetrischen, von der Reihenfolge der Gewinne
 * und Verluste abhängigen Skala ist. Für eine **Überdehnungs-Schwelle** ist der
 * Z-Score das bessere Maß: „Kurs 2σ unter der Mitte" heißt auf jedem Markt und
 * in jedem Kursniveau dasselbe, „RSI unter 30" ist eine Wette auf die
 * Verteilung der letzten 14 Kerzen.
 *
 * Trotzdem steht `bbZScore` hier **nicht** in `requiredFields`, und das ist
 * eine **Reihenfolge-Entscheidung, keine fachliche**:
 *   - `bbZScore` braucht `bollingerBands` (20/2σ) und existiert als Regelfeld
 *     erst seit **STX-02-02** (`src/lib/ruleFieldCatalog.ts`,
 *     `buildSnapshotFromCandles`). Dieses Template ist so gebaut, dass es
 *     **vor** 02-02 funktioniert: `rsi14`, `priceVsEma21Pct`, `adx14`,
 *     `volumeRatio` und `atrPct` sind alle älter als die Bollinger-Felder.
 *   - Die Roadmap trägt dem Rechnung: Das Bollinger-Template ist **03-06**
 *     und hängt ausdrücklich an 02-02
 *     (`docs/audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`: „03-06 …
 *     03-02, 02-02"). Dieses Template (03-05) hängt nur an 03-02.
 *   - **Reihenfolge-Abhängigkeit, die daraus folgt:** Wird `bbZScore` hier
 *     nachgerüstet, ist das keine Parameteränderung, sondern eine
 *     **Semantikänderung** — `requiredFields` ist Teil des Artefakt-Hashs
 *     (04-01), also eine **Versionserhöhung** (`RSI_MEAN_REVERSION_VERSION`),
 *     und die Abhängigkeitszeile der Roadmap wandert von „03-02" nach
 *     „03-02, 02-02". Der Ersatz wäre ein echter Austausch der
 *     Überdehnungs-Metrik, kein zusätzlicher Filter: zwei Überdehnungs-Maße
 *     in einer Konjunktion (`rsi14 lte …` UND `bbZScore lte …`) wären eine
 *     **doppelte Bedingung auf dieselbe Fachaussage** (Korrelations-Double-
 *     Count, 06-02) und würden die Trefferquote senken, ohne die Aussage zu
 *     schärfen.
 *   - `bollinger-squeeze` (03-06) ist der Ort, an dem die Bollinger-Lage
 *     load-bearing wird. Wer hier „nur schnell" den Z-Score ergänzt, erzeugt
 *     zwei Templates mit derselben Fachaussage und verschiedenen Feldern —
 *     genau der Drift, den ADR-008 ausschließt.
 *
 * ── Warum `supportedTimeframes` 15m/1h/4h sind (und nicht 5m/1m) ───────────
 * Dieselbe Fachentscheidung wie in 03-03, hier mit einer **Gegenrechnung**,
 * weil Mean-Reversion ein **kurzlebiges** Signal ist:
 *   - `adx14` braucht 29 Kerzen (`2 · 14 + 1`). Auf `5m` sind das 2,4 h, auf
 *     `1m` 29 Minuten — der Seitwärts-Filter würde eine einzige Session-Phase
 *     beurteilen, und „kein Trend" auf 2,4 Stunden ist eine andere Aussage als
 *     „kein Trend" auf zwei Tagen. Auf `15m` sind es 7,25 h, auf `1h` 29 h, auf
 *     `4h` 116 h.
 *   - Die Klasse **erlaubt** den kurzen Horizont: Die Decay-Policy der
 *     `mean-reversion` hat eine Halbwertszeit von **4 h** (`trend`: 24 h). Ein
 *     Signal, das nach vier Stunden zur Hälfte verfallen ist, darf auf `15m`
 *     bewertet werden — das ist der fachliche Grund, warum dieses Template
 *     einen feineren Takt trägt als 03-03/03-04 und trotzdem kein Intraday-
 *     Rauschen handelt.
 *   - **Ehrliche Grenze (wichtig für 06-02):** Auf `15m` liegt die ADX-Warm-up-
 *     Zeit mit 7,25 h **unter** einem Handelstag. Der Seitwärts-Filter misst
 *     dort eine Session-Phase, nicht einen Marktzyklus — dieselbe Zahl `20`
 *     heißt auf `15m` etwas anderes als auf `1h`. `15m` steht deshalb in der
 *     Liste (das Template **denkt** auf diesem Takt), ist aber **nicht** der
 *     Default der Regel (siehe nächster Abschnitt).
 * `3m`/`5m`/`30m` sind ausgeschlossen — `30m` wäre fachlich vertretbar (29
 * Kerzen = 14,5 h), ist aber nicht Teil dieses Prompts, und
 * `supportedTimeframes` ist Teil des Artefakt-Hashs: eine Erweiterung ist eine
 * Versionserhöhung, keine Nebenfolge.
 *
 * ── Warum `window.timeframe = 1h`, obwohl `15m` unterstützt wird ───────────
 * `supportedTimeframes` ist die Aussage „diese Strategie *denkt* in 15m, 1h und
 * 4h"; `RuleWindow.timeframe` ist die Aussage „diese eine Regel *läuft* auf
 * dieser Kerzenbreite" — `RuleSpec` trägt genau einen Wert, und welchen der
 * drei Takte eine konkrete Regel bekommt, entscheidet der Compiler (03-09) aus
 * dem Auftrag. Der Default ist die **Mitte** `1h`, nicht das feinere `15m`,
 * aus drei Gründen, die alle im Bestand liegen:
 *   - **Warm-up:** Erst auf `1h` überschreitet die ADX-Warm-up-Zeit (29 h)
 *     einen Handelstag. Auf `15m` (7,25 h) bewertet der lastende
 *     Seitwärts-Filter weniger als eine Session (siehe oben).
 *   - **Kosten:** Der Spread-/Slippage-Fallback des Backtests ist auf `15m`
 *     8 bp / 1,5 bp, auf `1h` 4 bp / 1 bp (`timeframeToSpreadFallbackBps` /
 *     `timeframeToSlippageBaseBps`, `src/backtest/paperExecution.ts`). Bei der
 *     Klasse mit der höheren Turnover-Rate ist das die **doppelte** Kostenlast
 *     auf dem halben Signalhorizont — kein guter Default für ein Artefakt,
 *     dessen COST-Annahme `critical: true` trägt.
 *   - **Live-Ausführbarkeit:** `4h` weist der Timeframe-Guard des
 *     Mikro-Executors fail-closed ab (Ausführungsintervall Default `1h`).
 *     `15m` und `1h` sind beide ausführbar; `1h` ist die Default-Obergrenze
 *     und damit der Takt, auf dem Snapshot und Ausführung zusammenfallen.
 *   - Und der Sanitizer fällt bei einem unbekannten Wert auf `15m` zurück —
 *     der Default muss deshalb explizit gesetzt sein, nie „irgendwie leer".
 *
 * ── Der Regime-Gegenpol (ADR-008, nur gelesen) ─────────────────────────────
 * Mean-Reversion und Trendfolge sind **regimegegensätzlich**: Eine
 * RSI-Mean-Reversion-Regel in `TREND_UP` ist nicht „schwächer", sie ist
 * **verkehrt herum** — sie kauft in eine fallende Bewegung, weil der RSI
 * niedrig ist, in einem Aufwärtstrend, in dem der RSI niedrig bleibt. Die
 * bestehende Infrastruktur weiß das bereits und dämpft genau dort:
 *   | Regime | Faktor `mean-reversion` | Quelle |
 *   |---|---|---|
 *   | `TREND_UP` | `0.5` | `DEFAULT_MARKET_REGIME_CONFIG.gateFactors` |
 *   | `TREND_DOWN` | `0.5` | dto. |
 *   | `RANGE` | `1` | dto. |
 *   | `HIGH_VOL` | `1` | dto. |
 *   | `CRASH` | `1` | dto. |
 * Live greift der Faktor über `resolveRegimeGateForExecution()`
 * (`src/lib/marketRegime.ts`) im Mikro-Executor — dort skaliert er das
 * Risikobudget der Regel, **nur** im Modus `enforce` und nur, wenn eine
 * Strategieklasse bekannt ist (`microExecutor.ts`, `gatedRiskBudgetPct`).
 * Ohne `class` (oder mit `unclassified`) wäre der Faktor **1** — eine
 * Risikoerhöhung ohne Fehlermeldung, genau der stille Verlust, den ADR-008
 * verbietet. Deshalb ist `class` hier Pflicht und der Test darauf eine
 * Akzeptanzbedingung.
 *
 * **Wirkungsgrenze (ADR-008):** Live wirkt das Gate über die Mission-Ableitung
 * (`strategyClassOfTemplate`), nicht über `RuleSpec`; der Backtest wendet **kein**
 * Regime-Gate an. Dieses Template beweist die **Wertebereichs-Passung**
 * (Klasse ↔ Gate-Faktoren ↔ Decay-Policy), keine neue Live-Verdrahtung — und
 * es **verändert** das Gate nicht (Sperre des Prompts).
 *
 * ── RSI-Warm-up: 15 Schlusskurse, und eine Falle, die hier nicht zuschnappt ─
 * `rsi(closes, 14)` in `src/lib/indicators.ts` verlangt `values.length >=
 * period + 1` = **15 Schlusskurse** und liefert darunter **nicht `null`,
 * sondern `50`** — einen neutralen Ersatzwert, kein Fail-closed. Das ist für
 * diese Regel trotzdem ungefährlich, und zwar **messbar**: Der gesamte
 * Parameterbereich von `rsiOversold` (`15 … 40`) liegt **unter** 50, also
 * erfüllt der Ersatzwert die Bedingung `rsi14 lte rsiOversold` an **keiner**
 * Stelle des Rasters — die Regel schweigt, statt auf einer erfundenen Zahl zu
 * handeln. (Ein `rsiOversold > 50` würde diese Sicherheit kippen und wäre ein
 * Fehler, kein Parameter.) Unerreichbar ist der Ersatzwert über
 * `buildSnapshotFromCandles()` ohnehin: Der Snapshot verlangt 25 Kerzen, also
 * immer mehr als die 15 des RSI — die Falle sitzt nur in Direktaufrufen des
 * Indikators. Beides hält der Test fest.
 *
 * ── Verifizierte Risiko-Grenzen (im Code nachgeprüft, nicht aus dem Kopf) ───
 * `RULE_CEILINGS` (`src/lib/ruleEngine.ts`) leitet sich aus `LIMIT_CEILINGS`
 * (`src/lib/riskGuard.ts`) ab; der **gesamte** Parameterbereich dieses Templates
 * liegt innerhalb dieser Deckel — kein Rasterpunkt kann klemmen:
 *   | Wert des Templates | Deckel (gelesen) | Quelle |
 *   |---|---|---|
 *   | `riskBudgetPct: 0.01` | `maxRiskPerTrade [0.002, 0.05]` | `riskGuard.ts` |
 *   | `maxPositionPct: 0.15` | `maxPositionPct [0.01, 0.5]` | `riskGuard.ts` |
 *   | `stopLossPct ∈ [1, 15]` | `defaultStopLossPct [0.005, 0.2] × 100 = [0.5, 20]` | `riskGuard.ts` → `RULE_CEILINGS.stopLossPct` |
 *   | `takeProfitRR ∈ [1, 4]` | `takeProfitRR [0.5, 5]` | `riskGuard.ts` |
 *   | `maxExecutionsPerDay: 2` | `[1, 10]` | `RULE_CEILINGS` |
 *   | `cooldownMinutes: 240` | `[0, 1440]` | `RULE_CEILINGS` |
 *   | `volumeWindow: 20` | `[5, 200]` | `RULE_CEILINGS` |
 *
 * ── `maxExecutionsPerDay: 2`, `cooldownMinutes: 240` ───────────────────────
 * 240 Minuten sind eine **ganze 4h-Kerze** — der gröbste unterstützte Takt. Auf
 * jedem der drei Takte liegt damit mindestens eine volle Kerze zwischen zwei
 * Einstiegen (16 auf `15m`, 4 auf `1h`, 1 auf `4h`); die Zahl ist also keine
 * Intraday-Zufälligkeit, sondern eine kerzenbezogene Setzung. Zusammen mit dem
 * Tageslimit (2) begrenzt das die Transaktionszahl der Klasse mit der höheren
 * Turnover-Rate, ohne das Signal zu verändern — die Kostenseite ist hier die
 * `critical: true`-Annahme, nicht eine Fußnote.
 *
 * ── `symbol` ist Pflicht des **Aufrufers**, nicht des Builders ──────────────
 * Wie 03-03/03-04: `buildRule(params)` liefert **kein** `symbol`. Ein Symbol im
 * Builder wäre nicht rein (dasselbe versionierte Artefakt lieferte je Markt eine
 * andere Regel) und falsch adressiert (welcher Markt gehandelt wird, entscheidet
 * die Mission bzw. das Screening, nicht die Strategie). Der Compiler (03-09)
 * setzt es vor `sanitizeRuleSpec()`: `{ ...template.buildRule(params), symbol }`.
 * Ohne Symbol lehnt der Sanitizer die Rohform ab — der gewünschte Fail-closed-
 * Zustand, kein Fehler dieses Templates.
 *
 * ── Was dieses Template bewusst NICHT tut ──────────────────────────────────
 *   - **Keine Änderung am Regime-Gate.** Dieses Template **nutzt** es. Kein
 *     Faktor, keine `gateFactors`-Zeile, keine Mode-Änderung, keine neue
 *     Verdrahtung (Sperre des Prompts).
 *   - **Kein `SHORT`** — `RULE_ALLOWED_SIDE` ist die einzige erlaubte Seite, ein
 *     Template darf das nicht aufweichen. Die `side` kommt deshalb **aus dieser
 *     Konstanten**, nicht als abgeschriebenes Literal. Dass Mean-Reversion
 *     short-seitig die **natürlichere** Variante wäre (überverkauft
 *     *verkaufen*?), ist ausdrücklich kein Auftrag, sondern der Grund für die
 *     globale Long-Sperre und einen **eigenen Audit**.
 *   - **Kein `bbZScore`** — Reihenfolge-Abhängigkeit zu 02-02/03-06 (siehe
 *     DOK-PFLICHT 3).
 *   - **Keine Änderung an `rsi` in `indicators.ts`** (Sperre des Prompts): Der
 *     15-Kerzen-Warm-up und der Ersatzwert `50` werden **gelesen**, nicht
 *     angepasst.
 *   - **Keine Sequenz-/Reclaim-Logik** — `RuleSpec` kennt nur
 *     Punkt-zu-Punkt-Bedingungen einer Kerze; Sequenz-Trigger wären
 *     Engine-Arbeit (STX-18, verworfen).
 *   - **Kein ATR-skalierter Stop** — `stopLossPct` ist ein fester Prozentwert.
 *     Die `atrPct`-Referenz in `mapsTo` dokumentiert den fachlichen Bezug (der
 *     Stop wird *an der Volatilität gemessen*, seine Größe aber nicht aus ihr
 *     berechnet); eine ATR-Skalierung wäre eine neue Engine-Semantik.
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
export const RSI_MEAN_REVERSION_ID = "rsi-mean-reversion" as const;

/**
 * Artefakt-Version. Monoton bei **Semantik**änderung (Regel, Timeframes,
 * Parameterraum) — nicht bei Formulierung. Siehe `types.ts`.
 */
export const RSI_MEAN_REVERSION_VERSION = 1 as const;

/** Keys des Parameterraums — die geschlossene Menge, die der Builder akzeptiert. */
export type RsiMeanReversionParamKey =
  | "rsiOversold"
  | "ema21GapPct"
  | "adxMax"
  | "volumeRatioMin"
  | "stopLossPct"
  | "takeProfitRR";

/**
 * Die Timeframes, auf denen das Template sinnvoll bewertet (Begründung im
 * Kopf). `satisfies` gegen das **bestehende** Vokabular: kein zweites
 * Timeframe-Register, aber die typsichere Allowlist-Prüfung (STX-01).
 */
export const RSI_MEAN_REVERSION_TIMEFRAMES = ["15m", "1h", "4h"] as const satisfies readonly SupportedTimeframe[];

/**
 * Der Parameterraum. `step` ist kein Rundungsschritt, sondern das **Raster**
 * der Sensitivitätsanalyse (06-02): Jeder Rasterpunkt muss eine gültige Regel
 * ergeben und darf an keiner Stelle klemmen — sonst misst die Analyse die
 * Klemmung des Sanitizers statt der Edge der Strategie.
 */
export const RSI_MEAN_REVERSION_PARAMS: Readonly<Record<RsiMeanReversionParamKey, ParamSpec>> = {
  rsiOversold: {
    key: "rsiOversold",
    kind: "threshold",
    label: "RSI-Überverkauft-Schwelle",
    unit: "Index",
    // 30 ist die klassische Überverkauft-Schwelle. Der Bereich 15…40 liegt
    // komplett unter dem RSI-Ersatzwert 50 (Warm-up-Falle, siehe Kopf) —
    // an keinem Rasterpunkt kann die Regel auf dem Ersatzwert handeln.
    default: 30,
    min: 15,
    max: 40,
    step: 1,
    mapsTo: "rsi14",
  },
  ema21GapPct: {
    key: "ema21GapPct",
    kind: "threshold",
    label: "Kurs mind. unter EMA 21",
    unit: "%",
    // 1.0 % Abstand zum EMA 21: unter „Preis in der Näge des Mittels" ist das
    // keine Überdehnung, sondern Rauschen — die Bedingung würde das Mittel
    // selbst handeln. Die Regel negiert den Wert (`lte -ema21GapPct`), weil
    // `priceVsEma21Pct` den Abstand vorzeichenrichtig trägt (negativ = darunter).
    default: 1,
    min: 0.3,
    max: 5,
    step: 0.1,
    mapsTo: "priceVsEma21Pct",
  },
  adxMax: {
    key: "adxMax",
    kind: "threshold",
    label: "Maximaler ADX (Seitwärts-Filter)",
    unit: "Index",
    // **DECKEL, kein Boden** — das load-bearing Feld dieses Templates
    // (DOK-PFLICHT 1). 20 liegt unter der üblichen „Trend beginnt"-Lesart
    // (25) und damit im Bereich, in dem der Markt keine Richtung hat.
    default: 20,
    min: 10,
    max: 30,
    step: 1,
    mapsTo: "adx14",
  },
  volumeRatioMin: {
    key: "volumeRatioMin",
    kind: "threshold",
    label: "Volumenverhältnis",
    unit: "ratio",
    // 1.1 statt 1.0 (03-03 nimmt 1.0): Der Einstieg kauft in eine laufende
    // Abwärtsbewegung, das Volumen ist das einzige Feld, das „Erschöpfung"
    // von „weiterem Verkaufsdruck" trennen hilft — es soll mehr als der
    // Schnitt sein, nicht nur der Schnitt.
    default: 1.1,
    min: 0.8,
    max: 2.5,
    step: 0.05,
    mapsTo: "volumeRatio",
  },
  stopLossPct: {
    key: "stopLossPct",
    kind: "threshold",
    label: "Stop-Loss",
    unit: "%",
    // [1, 15] liegt komplett in RULE_CEILINGS.stopLossPct = [0.5, 20].
    // 5 % ist weiter als in 03-03/03-04 (4 %): Bei Mean-Reversion ist der
    // Stop die Feststellung „kein Mittel" — er muss die Range aushalten,
    // ohne von deren normaler Breite ausgestoppt zu werden.
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
    // 1.5 statt 2 (03-03/03-04) — DOK-PFLICHT 2: niedrigere Trefferquote,
    // begrenztes Ziel, deshalb das kleinere Verhältnis.
    default: 1.5,
    min: 1,
    max: 4,
    step: 0.25,
    // Der Auftrag lässt dieses Feld „ohne" Mapping: Ein Zielkurs ist kein
    // Regelfeld. Der Vertrag (`ParamSpec.mapsTo: RuleField`) verlangt
    // trotzdem eines — gewählt ist `atrPct` wie in 03-03/03-04, weil Ziel und
    // Stop Vielfache derselben Volatilitätsstrecke sind. `mapsTo` ist Doku,
    // keine Auswertung.
    mapsTo: "atrPct",
  },
};

/**
 * Die Default-Parameter — **abgeleitet** aus `RSI_MEAN_REVERSION_PARAMS`, nie
 * eine zweite Liste (ein zweiter Default wäre ein Drift zwischen Raster und
 * Regel).
 */
export const RSI_MEAN_REVERSION_DEFAULTS: Readonly<Record<RsiMeanReversionParamKey, number>> = Object.fromEntries(
  (Object.keys(RSI_MEAN_REVERSION_PARAMS) as RsiMeanReversionParamKey[]).map((key) => [
    key,
    RSI_MEAN_REVERSION_PARAMS[key].default,
  ]),
) as Readonly<Record<RsiMeanReversionParamKey, number>>;

/**
 * Die Felder, die dieses Template auswertet. Der Typ ist die Whitelist selbst
 * (`RuleField = keyof typeof RULE_FIELDS`) — ein erfundenes Feld ist hier nicht
 * darstellbar, ein `as`-Cast bräuchte einen eigenen Kommentar.
 *
 * Bewusst **ohne** `bbZScore` (DOK-PFLICHT 3): Der Z-Score ist die bessere
 * Metrik, aber er hängt an 02-02 und gehört zu 03-06.
 */
const REQUIRED_FIELDS: readonly RuleField[] = ["rsi14", "priceVsEma21Pct", "adx14", "volumeRatio", "atrPct"];

/**
 * Die Annahmen (06-01 auditiert sie). `critical: true` heißt: fällt sie weg,
 * ist das **Ergebnis** wertlos — nicht „weniger schön".
 */
const ASSUMPTIONS: readonly StrategyAssumption[] = [
  {
    id: "regime-range",
    statement:
      "Funktioniert in RANGE. In TREND_UP/TREND_DOWN ist die Strategie nicht schwächer, sondern verkehrt herum — " +
      "sie kauft in eine fallende Bewegung, weil der RSI niedrig ist, in einem Trend, in dem der RSI niedrig " +
      "bleibt. Dort greift ausschließlich das Regime-Gate der Klasse (Faktor 0,5 auf das Risikobudget, nur im " +
      "Modus enforce); die Regel selbst kennt kein Regime.",
    category: "REGIME",
    critical: true,
  },
  {
    id: "ueberverkauf-keine-bodenbildung",
    statement:
      "Überverkaufte Zustände sind keine Bodenbildung: Der RSI markiert eine Überdehnung, keinen Wendepunkt. " +
      "Trifft das nicht zu, kauft die Regel in die Fortsetzung hinein — genau das Falling-Knife-Szenario, das der " +
      "ADX-Filter ausschließen soll und das der Stop dann bezahlt.",
    category: "MARKET",
    critical: false,
  },
  {
    id: "ema21-ist-das-mittel",
    statement:
      "Der EMA 21 ist das Mittel, zu dem der Kurs in der Range zurückkehrt. Der Abstand `priceVsEma21Pct` misst " +
      "damit die Überdehnung und nicht den Beginn eines neuen Trends — fällt diese Annahme, ist die zweite " +
      "Bedingung des Templates eine Trendaussage mit falschem Vorzeichen.",
    category: "MARKET",
    critical: false,
  },
  {
    id: "turnover-kosten-lastend",
    statement:
      "Mean-Reversion hat eine höhere Turnover-Rate als Trendfolge (kürzere Haltezeit, mehr Signale in derselben " +
      "Range) — die Gebühren- und Slippage-Annahme des Backtests ist hier deshalb besonders lastend: Sie wirkt " +
      "auf mehr Transaktionen bei kleinerem Ziel je Trade. Schon die Hälfte des angenommenen Zusatz-Slippage " +
      "kann die Edge der Klasse kippen, nicht nur schmälern.",
    category: "COST",
    critical: true,
  },
  {
    id: "rsi-15-schlusskurse",
    statement:
      "RSI(14) braucht 15 Schlusskurse (periode + 1). Darunter liefert `rsi()` keinen Null-Wert, sondern den " +
      "neutralen Ersatzwert 50 — der gesamte Parameterbereich von `rsiOversold` (15…40) liegt unter 50, die Regel " +
      "schweigt also auch auf dem Ersatzwert, statt auf einer erfundenen Zahl zu handeln.",
    category: "DATA",
    critical: true,
  },
  {
    id: "adx-29-kerzen",
    statement:
      "ADX(14) braucht 29 Kerzen (2 · 14 + 1); darunter liefert das Feld null und die Bedingung `adx14 lte adxMax` " +
      "scheitert fail-closed — ohne Seitwärts-Bestätigung wird nicht gehandelt. Auf dem feinsten unterstützten " +
      "Takt (15m) sind 29 Kerzen nur 7,25 Stunden, also weniger als ein Handelstag: dort misst der Filter eine " +
      "Session-Phase, keinen Marktzyklus.",
    category: "DATA",
    critical: false,
  },
  {
    id: "fill-in-der-signalkerze",
    statement:
      "Der Einstieg gelingt in der Signalkerze. Mean-Reversion kauft in eine laufende Abwärtsbewegung — ein Fill " +
      "erst danach verschlechtert den Einstiegskurs systematisch (adverse Selection), weil die Bewegung, gegen " +
      "die gekauft wird, noch läuft.",
    category: "EXECUTION",
    critical: false,
  },
];

/** Anzeigename (deutsch) für Katalog, Workshop-UI und Reports. */
const NAME = "RSI Mean-Reversion";

const DESCRIPTION =
  "Mean-Reversion long in der Range auf 15m/1h/4h: Der RSI(14) muss überverkauft stehen (Default 30), der Kurs " +
  "mindestens 1 % unter seinem EMA 21 liegen, der ADX(14) darf höchstens 20 betragen — der Seitwärts-Filter, ohne " +
  "den das Template ein Falling-Knife-System wäre — und die Signalkerze muss überdurchschnittliches Volumen " +
  "zeigen (Default 1,1×). Stop und Ziel sind feste Prozent- bzw. Chance/Risiko-Werte, kein ATR-Kanal; das Ziel " +
  "ist mit 1,5× bewusst kleiner als bei der Trendfolge.";

/**
 * Liest einen Parameter **fail-closed**: fehlend oder nicht endlich ist ein
 * Fehler, keine Gelegenheit für einen Default. Stille Defaults wären eine
 * zweite Wahrheit über die Regel — und der Katalog könnte sie nicht finden.
 */
function paramValue(params: Readonly<Record<string, number>>, key: RsiMeanReversionParamKey): number {
  const raw: unknown = params[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `rsi-mean-reversion: Parameter „${key}“ fehlt oder ist keine endliche Zahl ` +
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
export function rsiMeanReversionRule(params: Readonly<Record<string, number>>): RuleSpecInput {
  const rsiOversold = paramValue(params, "rsiOversold");
  const ema21GapPct = paramValue(params, "ema21GapPct");
  const adxMax = paramValue(params, "adxMax");
  const volumeRatioMin = paramValue(params, "volumeRatioMin");
  const stopLossPct = paramValue(params, "stopLossPct");
  const takeProfitRR = paramValue(params, "takeProfitRR");

  return {
    // Familienname ohne Symbol: das Symbol kommt vom Aufrufer, sonst würde der
    // Builder ein Faktum erfinden, das er nicht kennen darf.
    name: `${RSI_MEAN_REVERSION_ID} v${RSI_MEAN_REVERSION_VERSION}`,
    missionId: null,
    condition: {
      logic: "all",
      conditions: [
        // 1) Die Überdehnung: RSI(14) überverkauft (`lte` ist inklusiv — genau
        //    auf der Schwelle zählt der Zustand als überverkauft). Warm-up:
        //    unter 15 Schlusskursen steht hier der Ersatzwert 50, der den
        //    gesamten Parameterbereich (15…40) nicht erfüllt (siehe Kopf).
        { field: "rsi14", op: "lte", value: rsiOversold },
        // 2) Das Mittel, zu dem zurückgekehrt werden soll: Kurs mit Vorgabe
        //    UNTER dem EMA 21. `priceVsEma21Pct` ist negativ, wenn der Kurs
        //    darunter liegt — deshalb die Negation des Parameters, nicht ein
        //    zweiter Parameter mit negativem Vorzeichen (der eine Wert im
        //    Raster bleibt die Fachaussage; ein negiertes Raster wäre ein
        //    zweites Vorzeichen-Vokabular).
        { field: "priceVsEma21Pct", op: "lte", value: -ema21GapPct },
        // 3) DER LASTENDE FILTER: kein Trend. `lte`, nicht `gte` — sonst wäre
        //    das Template kein Mean-Reversion, sondern ein Falling-Knife-
        //    System (DOK-PFLICHT 1). null (29 Kerzen fehlen) ⇒ kein Trade.
        { field: "adx14", op: "lte", value: adxMax },
        // 4) Participation: Die Signalkerze trägt mehr Volumen als ihr
        //    20er-Schnitt. Bei einem Einstieg gegen die Bewegung ist das das
        //    einzige Feld, das Erschöpfung von fortgesetztem Druck trennt.
        { field: "volumeRatio", op: "gte", value: volumeRatioMin },
      ],
    },
    action: {
      side: RULE_ALLOWED_SIDE,
      stopLossPct,
      takeProfitRR,
      // 1 % Risiko je Trade, max. 15 % Positionsanteil — identisch zu
      // 03-03/03-04, damit 06-02 die Templates vergleichen kann, ohne die
      // Risikoseite mitzumessen. Beide gut innerhalb LIMIT_CEILINGS
      // (maxRiskPerTrade [0.002, 0.05], maxPositionPct [0.01, 0.5]).
      riskBudgetPct: 0.01,
      maxPositionPct: 0.15,
      positionSizeMode: "risk",
    },
    window: {
      // Die Mitte der drei unterstützten Takte — `RuleSpec` trägt genau EINEN
      // `timeframe` pro Regel; die Wahl trifft der Aufrufer (Begründung im
      // Kopf, Abschnitt „Warum `window.timeframe = 1h`").
      timeframe: "1h",
      validFrom: null,
      validUntil: null,
      // 2 Versuche/Tag und 240 min Abklingzeit (= eine ganze 4h-Kerze, also
      // auf jedem unterstützten Takt mindestens eine Kerze Abstand). Bei der
      // Klasse mit der höheren Turnover-Rate ist das die Kostenseite, nicht
      // die Signalqualität.
      maxExecutionsPerDay: 2,
      cooldownMinutes: 240,
      // Identisch zur 20-Perioden-Referenz von `volumeRatio` im Snapshot.
      volumeWindow: 20,
    },
    rationale:
      `Mean-Reversion long in der Range: RSI(14) höchstens ${num(rsiOversold)} (überverkauft), Kurs mindestens ` +
      `${num(ema21GapPct)} % unter EMA 21, ADX(14) höchstens ${num(adxMax)} als Seitwärts-Nachweis (ohne diesen ` +
      `Filter wäre es ein Falling-Knife-System), Signalkerzenvolumen mindestens ${num(volumeRatioMin)}× des ` +
      `20er-Schnitts. Ausstieg fest bei ${num(stopLossPct)} % Verlust oder ${num(takeProfitRR)}× Chance/Risiko.`,
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
 * das Ergebnis beim Import; `validateTemplate(buildRsiMeanReversion())` liefert
 * `[]`.
 */
export function buildRsiMeanReversion(): StrategyTemplate {
  return {
    id: RSI_MEAN_REVERSION_ID,
    name: NAME,
    description: DESCRIPTION,
    version: RSI_MEAN_REVERSION_VERSION,
    // ADR-008: Klasse ist eine Fachaussage aus dem bestehenden Vokabular —
    // „mean-reversion". Genau diese Zeile trägt: Ohne sie (oder mit
    // `unclassified`) wäre der Gate-Faktor in TREND_UP/TREND_DOWN still 1 und
    // die Decay-Policy der Klasse ohne Wirkung.
    class: "mean-reversion",
    // ADR-010: nur SINGLE_SYMBOL; Universe-Auswahl gehört zu `src/crossSectional/`.
    scope: "SINGLE_SYMBOL",
    supportedTimeframes: RSI_MEAN_REVERSION_TIMEFRAMES,
    requiredFields: REQUIRED_FIELDS,
    params: RSI_MEAN_REVERSION_PARAMS,
    buildRule: rsiMeanReversionRule,
    assumptions: ASSUMPTIONS,
    // ADR-009: bestehendes MarketRegime-Vokabular, ohne UNKNOWN. RANGE ist das
    // einzige Regime, in dem diese Strategie eine These hat; in TREND_UP/
    // TREND_DOWN trägt allein das Gate (Faktor 0,5), nicht die Regel.
    expectedRegimes: ["RANGE"],
  };
}
