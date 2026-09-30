# Changelog — Autonome KI-Trading-Firma

> ## ⚠️ BETA-PHASE (v0.x.x)
>
> Dieses Projekt befindet sich in der **Beta-Phase** und ist **nicht produktionsreif**.
> Es ist für **Bildungszwecke und private Nutzung auf eigene Gefahr** konzipiert.
> Der Autor lehnt jegliche Haftung für finanzielle Verluste, technische Fehler,
> Datenverlust oder Schäden ab. Trading und Investitionen beinhalten erhebliche
> Risiken — nutze diesen Code nur nach vollständiger rechtlicher Prüfung.
>
> **Versionsschema:** Ab sofort wird das Projekt nach dem öffentlichen
> **v0.x.x-Schema** (SemVer, 0.x = Beta) versioniert. Die bis 2026-09-23 intern
> verwendete Zählung `v1.x.x` war die fortlaufende Nummer der **Beta-Entwicklung**
> und gehört nicht zum öffentlichen Schema. Die vollständige, unveränderte
> Historie unter der alten Zählung ist archiviert unter
> [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md)
> und dort als Meilenstein-Referenz zu lesen (dortige `v1.73.1` ≙ hier `v0.1.0`).

Alle für Nutzer sichtbaren Änderungen werden in dieser Datei dokumentiert.
Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/de/1.1.0/) ·
Versionierung: [SemVer](https://semver.org/lang/de/) (0.x: Breaking Changes sind
erlaubt, solange sie hier dokumentiert sind).

> **Status-Header:** **Beta** · Dokumentationsstand **2026-09-30** · Code-Version **0.6.5** ·
> Kanonische Quelle der Version: `package.json` (siehe [`VERSION.md`](VERSION.md)).

## [Unreleased]

> **Status: Beta.** Nächste Schritte: die restlichen Templates 03-05 … 03-08 und
> der Compiler 03-09 (`v0.7.0`); offen bleibt die optionale Feature-Store-Parität 02-04.

### Added

* **Drittes Strategie-Template: RSI Mean-Reversion** (`src/strategies/templates/rsi-mean-reversion.ts`,
  STX-03-05, Phase 3) — das **erste Artefakt mit `class: "mean-reversion"`** und damit der
  Testfall, ob ADR-E1 (ADR-008) trägt: Erst diese Klasse wird im Regime-Gate tatsächlich
  gedämpft (`TREND_UP`/`TREND_DOWN` Faktor **0.5**, `RANGE` **1** — gelesen aus
  `DEFAULT_MARKET_REGIME_CONFIG.gateFactors`, nicht gesetzt). Auch dieses Template braucht
  nichts Neues: `rsi14`, `priceVsEma21Pct`, `adx14`, `volumeRatio` und `atrPct` stehen
  längst im Snapshot.
  * `buildRsiMeanReversion()` liefert ein `StrategyTemplate` (`class: "mean-reversion"`,
    `version: 1`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes: ["15m", "1h", "4h"]`,
    `expectedRegimes: ["RANGE"]`); `STRATEGY_TEMPLATES` führt den Eintrag an dritter
    Stelle (Roadmap-Reihenfolge) und validiert ihn **beim Import**.
  * Die Regel: `condition.logic = "all"` über vier Bedingungen — `rsi14 lte rsiOversold`,
    `priceVsEma21Pct lte -ema21GapPct`, **`adx14 lte adxMax`** und `volumeRatio gte
    volumeRatioMin`. Action und Fenster wie 03-03/03-04 (`side LONG` über
    `RULE_ALLOWED_SIDE`, `riskBudgetPct 0.01`, `maxPositionPct 0.15`, `1h`, 2
    Ausführungen/Tag, 240 min Abklingzeit), dazu `sourceRole: "RESEARCH"`,
    `missionId: null`, `riskScore: 0.5` und ein deutschsprachiges, parametergeprägtes
    `rationale`.
  * **`adx14` ist hier ein Deckel (`lte`), kein Boden** — der load-bearing Unterschied zur
    Trendfolge: Ohne diesen Filter ist das Template kein Mean-Reversion-, sondern ein
    „Catching the falling knife"-System (in einer monoton fallenden Reihe stehen RSI(14)
    bei ~0 und der Kurs weit unter dem EMA 21 — nur der ADX hält die Regel zurück). Der
    Test hält den Operator über das **ganze** Raster fest und kontrastiert ihn mit
    `gte` in 03-03/03-04.
  * Sechs Parameter mit `step` als Sensitivitätsraster (06-02): `rsiOversold` 30
    (15…40, Schritt 1), `ema21GapPct` 1.0 (0.3…5, Schritt 0.1 — in der Regel negiert,
    weil `priceVsEma21Pct` das Vorzeichen trägt), `adxMax` 20 (10…30, Schritt 1),
    `volumeRatioMin` 1.1 (0.8…2.5, Schritt 0.05), `stopLossPct` 5 (1…15, Schritt 0.5),
    `takeProfitRR` **1.5** (1…4, Schritt 0.25). Der **gesamte** Bereich liegt innerhalb
    `RULE_CEILINGS` — kein Rasterpunkt wird je geklemmt.
  * Warum `takeProfitRR` hier **1.5** statt 2 ist: Mean-Reversion hat das begrenzte Ziel
    (Rückkehr zum Mittel) und die schlechtere Trefferquote; das kleinere
    Chance/Risiko-Verhältnis kompensiert das Odds-Ratio. Dasselbe Argument trägt die
    eigene Decay-Policy der Klasse (Halbwertszeit 4 h statt 24 h bei `trend`).
  * Sieben `assumptions` (06-01), drei davon `critical: true`: REGIME „funktioniert in
    RANGE; in TREND_UP/TREND_DOWN greift nur das Regime-Gate", COST „höhere
    Turnover-Rate ⇒ Gebühren-/Slippage-Annahme besonders lastend", DATA „RSI(14) braucht
    15 Schlusskurse" — plus MARKET („überverkauft ist keine Bodenbildung", EMA 21 als
    Mittel), DATA (ADX-Warm-up 29 Kerzen) und EXECUTION (Fill in der Signalkerze,
    adverse Selection).
  * **Bewusst nicht getan** (Sperren des Prompts): **kein `bbZScore`** — der Z-Score ist
    normalisiert und damit die bessere Überdehnungs-Metrik, braucht aber
    `bollingerBands` (STX-02-02); dieses Template ist so gebaut, dass es **vor** 02-02
    funktioniert, und das Bollinger-Template 03-06 ist der Ort der Lage-Metrik (die
    Reihenfolge-Abhängigkeit steht im Kopf, eine Nachrüstung wäre eine
    **Versionserhöhung**). Kein `SHORT` (Mean-Reversion wäre short-seitig die
    natürlichere Variante — eigener Audit), **keine Regime-Gate-Änderung** (das Template
    nutzt es nur), keine Änderung an `rsi` in `indicators.ts` — und unverändert:
    `ruleEngine.ts`, `RULE_CEILINGS`, `RULE_FIELDS`, `marketRegime.ts`.
  * **Tests:** `tests/strategies.rsiMeanReversion.test.ts` (66 Fälle) — Vertrag,
    Prompt-Treue Zeile für Zeile, Klemmfreiheit über **jedem** Rasterpunkt
    (`validateTemplate` + `sanitizeRuleSpec` im Verbund), der ADX-Operator-Grep über
    Builder-Output **und** Quelltext (mit Kontrast zu 03-03/03-04), die
    ADR-008-Invarianten (`class !== "unclassified"`,
    `regimeGateFactor("TREND_UP", …) < 1`, `regimeGateFactor("RANGE", …) === 1`,
    Gate-Faktoren vor/nach jedem Aufruf unverändert) und die Semantik über den echten
    Snapshot-Pfad: Range-Abverkauf löst aus, die monoton fallende Reihe **nicht** (nur
    der ADX-Filter bremst — mit `adx14 = 15` auf demselben Snapshot würde sie
    auslösen), flache Range nicht. Dazu die RSI-Warm-up-Falle: `rsi()` liefert unter 15
    Schlusskursen nicht `null`, sondern **50** — der gesamte `rsiOversold`-Bereich
    (≤ 40) liegt darunter, die Regel kann also nie auf dem Ersatzwert handeln.
* **Zweites Strategie-Template: MACD Momentum** (`src/strategies/templates/macd-momentum.ts`,
  STX-03-04, Phase 3) — das **Referenztemplate für 06-02 (Overfit)**: die
  wenigsten Parameter (vier) und die klarste Ökonomie. Auch dieses Artefakt
  braucht nichts Neues — `macdHist`, `priceVsEma50Pct` und `adx14` stehen längst
  im Snapshot.
  * `buildMacdMomentum()` liefert ein `StrategyTemplate` (`class: "trend"` nach
    ADR-008, `version: 1`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes:
    ["1h", "4h"]`, `requiredFields: macdHist | priceVsEma50Pct | adx14 | atrPct`);
    `STRATEGY_TEMPLATES` führt den Eintrag an zweiter Stelle (Roadmap-Reihenfolge)
    und validiert ihn **beim Import**.
  * Die Regel: `condition.logic = "all"` über drei Bedingungen — `macdHist gt 0`,
    `priceVsEma50Pct gt ema50BufferPct` (strikt: „über EMA 50“, nicht „auf
    EMA 50“), `adx14 gte adxMin`. Action und Fenster wie 03-03 (`side LONG` über
    `RULE_ALLOWED_SIDE`, `stopLossPct`, `takeProfitRR`, `riskBudgetPct 0.01`,
    `maxPositionPct 0.15`, `1h`, 2 Ausführungen/Tag, 240 min Abklingzeit), dazu
    `sourceRole: "RESEARCH"`, `missionId: null`, `riskScore: 0.5` und ein
    deutschsprachiges, parametergeprägtes `rationale`.
  * **Keine Magnitude-Bedingung auf `macdHist`** — die wichtigste Aussage des
    Files: `macdHist` ist `macd − signal` in **Preiseinheiten**, ein Schwellwert
    `macdHist > X` mit `X > 0` ist deshalb **nicht** marktübergreifend (dieselbe
    `0.5` bedeutet für BTC etwas anderes als für einen 5-stelligen Aktienkurs —
    die Verwechslung von Momentum und Volatilität, die die Analyse prüft). Die
    einzige Bedingung auf dem Feld ist `gt 0` (das Vorzeichen ist skalenfrei);
    der skalenfreie Ersatz für jede Stärkefrage ist `priceVsEma50Pct` (Prozent).
    Ein Test greppt den Builder-Output über das **ganze** Parameterraster: genau
    eine `macdHist`-Bedingung, und sie ist `gt 0`.
  * Vier Parameter mit `step` als Sensitivitätsraster (06-02): `adxMin` 20
    (14…35, Schritt 1), `ema50BufferPct` 0.0 (−1…3, Schritt 0.1 — `min` bewusst
    negativ, damit 06-02 den frühen Impuls auch **unter** dem EMA 50 messen
    kann), `stopLossPct` 4 (1…12, Schritt 0.5), `takeProfitRR` 2 (1…4,
    Schritt 0.25). Der **gesamte** Bereich liegt innerhalb `RULE_CEILINGS`
    (`stopLossPct [0.5, 20]`, `takeProfitRR [0.5, 5]`, aus `LIMIT_CEILINGS`
    abgeleitet) — kein Rasterpunkt wird je geklemmt.
  * Sechs `assumptions` (06-01) mit `category` und `critical`: MARKET „das
    Histogramm-Vorzeichen dreht vor dem Trend“ (nicht kritisch); MARKET
    **kritisch** „`macdHist` wird ausdrücklich nicht als Stärke-Metrik
    verwendet“ (Preiseinheiten, nicht skalenfrei); DATA **kritisch**
    „MACD(12/26/9) braucht 35 Schlusskurse, darunter `null`“ (`slow 26 + signal 9`);
    COST „häufige Histogramm-Wechsel werden durch Cooldown und Tageslimit
    gedämpft“; dazu REGIME (`TREND_UP`) und eine zweite DATA-Annahme zur
    EMA-50-Warm-up-Falle. `expectedRegimes: ["TREND_UP"]` — ohne `UNKNOWN`
    (ADR-009).
  * **Bewusst nicht getan** (Sperren des Prompts): kein `SHORT` (die negative
    MACD-Variante bräuchte einen `side`-Wert, den die Engine nicht kennt), keine
    Bedingung auf `macd`/`macdSignal` (dieselbe Preiseinheiten-Falle), kein
    `bbZScore` (03-06), keine Sequenz-/Reclaim-Logik, kein Backtest-Lauf (03-10)
    — und unverändert: `indicators.ts`, `ruleEngine.ts`, `RULE_CEILINGS`,
    `RULE_FIELDS`.
  * **Tests:** `tests/strategies.macdMomentum.test.ts` (56 Fälle) — Vertrag,
    Prompt-Treue Zeile für Zeile, Klemmfreiheit über **jedem** Rasterpunkt
    (`validateTemplate` + `sanitizeRuleSpec` im Verbund), der Magnitude-Grep über
    Builder-Output **und** Quelltext, Reinheit/Determinismus und die Semantik
    über den echten Snapshot-Pfad: Aufwärtstrend ab 35 Kerzen löst aus, bei 34
    Kerzen schweigt die Regel (`macdHist = null`, fail-closed — obwohl ADX und
    EMA-50-Abstand längst erfüllt wären), Seitwärtsphase nicht (Histogramm exakt
    0, `gt` nicht `gte`), und in der fallenden Reihe trägt allein
    `priceVsEma50Pct` die Ablehnung. Dazu die neuen Kopf-Invarianten:
    `histogram = macd − signal` (Preiseinheiten) und `macdHist` im Snapshot
    unskaliert (nur auf 6 Stellen gerundet).
* **Erstes Strategie-Template: EMA/ADX Trend** (`src/strategies/templates/ema-adx-trend.ts`,
  STX-03-03, Phase 3) — der Katalog ist keine leere Registry mehr. Das Artefakt
  braucht genau nichts Neues: keine Felder, keine Indikatoren, keine
  Engine-Änderung. Damit ist STX-18 auch praktisch beantwortet (bestätigt:
  `RuleSpec` trägt Templates).
  * `buildEmaAdxTrend()` liefert ein `StrategyTemplate` (`class: "trend"` nach
    ADR-008, `version: 1`, `scope: "SINGLE_SYMBOL"`, `supportedTimeframes:
    ["1h", "4h"]`, `requiredFields: trend | priceVsEma50Pct | adx14 |
    volumeRatio | atrPct`); `STRATEGY_TEMPLATES` nimmt den Eintrag auf und
    validiert ihn **beim Import** (`assertTemplatesValid()`).
  * Die Regel: `condition.logic = "all"` über vier Bedingungen — `trend eq "UP"`,
    `priceVsEma50Pct gte ema50BufferPct`, `adx14 gte adxMin`, `volumeRatio gte
    volumeRatioMin`. Action: `side LONG` (über `RULE_ALLOWED_SIDE`, nicht als
    abgeschriebenes Literal), `stopLossPct`, `takeProfitRR`, `riskBudgetPct
    0.01`, `maxPositionPct 0.15`, `positionSizeMode "risk"`. Fenster: `1h`, 2
    Ausführungen/Tag, 240 min Abklingzeit, 20-Kerzen-Volumenfenster. Dazu
    `sourceRole: "RESEARCH"`, `missionId: null`, `riskScore: 0.5` und ein
    deutschsprachiges, parametergeprägtes `rationale`.
  * **`symbol` ist Pflicht des Aufrufers, nicht des Builders**: Die Rohform hat
    bewusst kein Symbol; der Compiler (03-09) setzt es vor `sanitizeRuleSpec()`.
    Ohne Symbol bleibt die Rohform eine Rohform — `sanitizeRuleSpec` lehnt ab,
    statt einen Markt zu erfinden.
  * Fünf Parameter mit `step` als Sensitivitätsraster (06-02): `adxMin` 22
    (15…35, Schritt 1), `ema50BufferPct` 0.2 (0…3, Schritt 0.1), `volumeRatioMin`
    1.0 (0.8…2.0, Schritt 0.05), `stopLossPct` 4 (1…12, Schritt 0.5),
    `takeProfitRR` 2 (1…4, Schritt 0.25). Der **gesamte** Bereich liegt innerhalb
    `RULE_CEILINGS` (`stopLossPct [0.5, 20]`, `takeProfitRR [0.5, 5]`, aus
    `LIMIT_CEILINGS` abgeleitet) — kein Rasterpunkt wird je geklemmt, sonst
    messen die Sweeps die Klemmung statt der Edge.
  * Zwei fachliche Grenzen im Kopf der Datei, beide am Code festgemacht:
    `1m`/`5m` sind ausgeschlossen, weil `adx()` 29 Kerzen verlangt
    (`2 * period + 1`) und eine Trendreihenfolge über 29 Fünf-Minuten-Kerzen ein
    anderes Maß ist als über 29 Stunden; `ema50BufferPct` muss über der
    `trend`-Hysterese liegen (`|EMA9 − EMA21| / price ≥ 0.001`, also 0,1 % —
    sonst filtert die Bedingung nichts, was `trend` nicht schon gefiltert hätte).
    Der Default (0,2 %) ist die Invariante, `min: 0` bleibt messbar.
  * Fünf `assumptions` (06-01) mit `category` und `critical`: MARKET, DATA
    (**kritisch**: ohne ADX kein Trend — `adx14` ist `null`, die Bedingung
    scheitert fail-closed), COST, REGIME (`TREND_UP`; in RANGE degradiert die
    ADX-Bedingung) und eine zweite DATA-Annahme zur EMA-50-Warm-up-Falle
    (`buildSnapshotFromCandles` rechnet `min(50, Kerzenzahl)`).
    `expectedRegimes: ["TREND_UP"]` — ohne `UNKNOWN` (ADR-009).
  * **Bewusst nicht getan** (Sperren des Prompts): kein `SHORT`, kein `vwapPct`
    (Tagesanker auf `1h` nicht belastbar, STX-01), keine Sequenz-/Reclaim-Logik,
    kein ATR-skalierter Stop, kein Backtest-Lauf (03-10) — und unverändert:
    `ruleEngine.ts`, `RULE_CEILINGS`, `indicators.ts`.
* **Tests:** `tests/strategies.emaAdxTrend.test.ts` (47 Fälle) — Vertrag,
  Prompt-Treue Zeile für Zeile, Klemmfreiheit über **jedem** Rasterpunkt
  (`validateTemplate` + `sanitizeRuleSpec` im Verbund), der Nachweis, dass
  `adxMin: 99` in `validateTemplate` scheitert und den Sanitizer
  **unbehelligt** ließe (kein Deckel auf `adx14`), Reinheit/Determinismus,
  Statik-Wächter für die Doku-Pflichten und die Sperren. Dazu Semantik über den
  echten Snapshot-Pfad: Aufwärtstrend löst aus, unter 29 Kerzen nicht
  (`adx14 = null`, fail-closed), Seitwärtsphase nicht, Volumenschwäche nicht, und
  die Margin-Kerze zwischen 0 und 0,2 % genau dann, wenn der Buffer auf `min`
  steht.
* `tests/strategies.catalog.test.ts`: Die Registry-Prüfung vergleicht
  `STRATEGY_TEMPLATES` jetzt mit dem Verzeichnis
  `src/strategies/templates/` statt eine leere Liste zu erwarten — eine fehlende
  oder doppelte Registrierung ist damit ein Testfehler, und 03-04 … 03-08 ziehen
  den Test nicht mehr nach.

* **Template-Katalog + Registry-Validierung** (`src/strategies/catalog.ts`,
  STX-03-02, Phase 3) — der Katalog prüft Templates **beim Import**, nicht erst
  beim Backtest. Der gesamte Sicherheitswert hängt daran, dass eine kaputte
  Strategie früher stirbt als eine kaputte Order.
  * `STRATEGY_TEMPLATE_IDS` als **geschlossene Union** der sechs geplanten IDs
    (`ema-adx-trend`, `macd-momentum`, `rsi-mean-reversion`,
    `bollinger-squeeze`, `vwap-pullback`, `donchian-breakout`) plus
    `StrategyTemplateId`, `isStrategyTemplateId()` und
    `STRATEGY_TEMPLATE_ID_RE`. Die Templates selbst kommen in 03-03 … 03-08;
    `STRATEGY_TEMPLATES` ist hier noch leer, aber bereits validiert.
  * `validateTemplate(t)` liefert **fail-closed** eine Fehlerliste (leer =
    gültig) über: ID-Format, Version (Ganzzahl ≥ 1), Klasse (in
    `STRATEGY_CLASS_KEYS` **und** ungleich `unclassified`, ADR-008), Timeframes
    (Allowlist, nicht leer, eindeutig), `requiredFields` (Whitelist), Params
    (`min ≤ default ≤ max`, `step > 0`, eindeutiger `key`), `mapsTo`,
    Assumptions (eindeutige ID, nicht leerer `statement`) und
    `expectedRegimes` (genau die fünf `MarketRegime`, **ohne `UNKNOWN`** —
    ADR-009).
  * Der Builder wird als **reine Funktion der Parameter** geprüft (STX-05):
    zweimal `buildRule(defaults)` muss tiefengleich sein, die Rückgabe ein
    Objekt, jedes Bedingungs-`field` in `RULE_FIELDS`, `action.side`
    ausschließlich `LONG` und **kein** Zahlenwert außerhalb `RULE_CEILINGS`.
    Der Katalog liest die Deckel, er erweitert sie nicht — und er sanitized
    nichts: `sanitizeRuleSpec()` (03-09) bleibt Pflicht.
  * Lese-Helfer `getTemplate()`, `listTemplates()` und `templateByField()`
    („welches Template nutzt `bbwPct`?“) — eine SSoT für Workshop-UI, CLI und
    Tests.
  * **Import-Zeit-Wächter:** `assertTemplatesValid()` läuft beim Modul-Import
    und wirft bei einem ungültigen Template; ein kaputtes Template lässt den
    Prozess nicht starten. Zusätzlich eine Canary gegen einen absichtlich
    kaputten `__fixtures`-Fall — der Validator muss ihn beanstanden (sonst ist
    er fail-open) und die gültige Fixture durchlassen (sonst überstreng).
  * **Tests:** `tests/strategies.catalog.test.ts` mit 41 Negativfällen, je
    genau einem erwarteten Fehler, plus Deckel-Grenztests gegen die **lebenden**
    `RULE_CEILINGS` und Strukturwächtern (Fixtures nicht exportiert, kein
    zweites Klassen-/Regime-Vokabular, kein LLM-/DB-Pfad).

### Fixed

* **ADR-010-Wächter** (`tests/adrVocabulary.test.ts`): Der Guard „keine
  `MultiAssetStrategySpec` in `src/` und `scripts/`“ schlug seit 03-01 fehl —
  ausgelöst von einem **Doc-Kommentar** in `src/strategies/types.ts`, der die
  verworfene Spec beim Namen nannte. Der Kommentar verweist jetzt auf ADR-E3
  (ADR-010) statt auf das Token; der Wächter selbst ist unverändert
  vollstreng. `npm test` ist damit wieder grün.

## [0.6.5] — Donchian-Regelfeld (STX-02-03) (2026-09-30)

> **Status: Beta, nicht produktionsreif.** Ein additives Regel-Feld und ein rein
> additiv gepflegter Indikator-Cache; **keine** Migration, keine Änderung an
> bestehenden Feldern, Labels oder Werten, kein neues Verhalten ohne
> Donchian-Feld.

### Added

* **Regel-Feld `donchianBreakoutPct`** (`src/lib/ruleFieldCatalog.ts`,
  `src/lib/ruleEngine.ts`) — der letzte der sieben Strategie-Vorschläge, der
  ohne neues Feld nicht ausdrückbar war:
  * `(close / upper − 1) · 100`, wobei `upper` das **Donchian-Kanalhoch der
    vorigen 20 Kerzen** ist (`DONCHIAN_ENTRY_PERIOD`, ausdrücklich ohne die
    aktuelle Signalkerze — kein Look-ahead, STX-02-01). `> 0` = Ausbruch über
    den vorher bekannten Kanal; marktneutral, weil relativ.
  * Deutsche Labels mit Einheit im Text; der LLM-Hinweis in
    `RULE_FIELD_SCHEMA_HINTS` nennt Bezug, typische Werte und die
    `null`-Semantik (`Object.keys(RULE_FIELDS)` bleibt das Schema-`enum`).
  * `null` — nie eine erfundene 0 — unter 21 Kerzen (kein Kanal) oder bei
    `upper <= 0`. Eine echte `0` bleibt möglich und heißt „Schlusskurs exakt
    auf dem Kanalhoch“.
  * Die Fensterlänge ist **kein Regelfeld**: Sie gehört als Parameter in das
    Donchian-Template (03-08), nicht in den Snapshot — sonst bedeutete
    derselbe Feldwert je Strategie etwas anderes.
* **`donchianBreakoutPct(close, upper)`** in `src/lib/indicators.ts`: Formel und
  `null`-Semantik an genau einer Stelle, von beiden Snapshot-Pfaden genutzt.
  Dazu die kanonischen Fenster `DONCHIAN_ENTRY_PERIOD = 20` /
  `DONCHIAN_EXIT_PERIOD = 10` als Defaults von `donchianChannel` (Werte
  unverändert, nur benannt).
* **`indicatorCache`** wächst rein additiv um `donchianUpper`:
  `donchianUpperArray()` rechnet das laufende Kanalhoch mit einer monotonen
  Deque in **O(n)** vor (jeder Index wird einmal eingefügt und höchstens einmal
  entfernt) — bewusst **kein** `Math.max(...slice)` je Bar, das wäre O(n·20) und
  damit die STX-12-Regression im Backtest-Pfad. `snapshotFromCache` rundet auf
  dieselben 4 Dezimalstellen wie `buildSnapshotFromCandles`.
* **Tests:** Lookahead-Test (streng steigende Reihe: Wert erst ab der Kerze nach
  dem Kanalhoch, vorher `null`, nie 0), Ausbruchskerze gegen den vorigen Kanal,
  Bar-für-Bar-Parität Cache ↔ Direktpfad über drei Symbole, Engine-Parität
  Single-Rule ↔ Multi-Asset, `null`-Fälle, statischer O(n)-Beleg und Accessor/
  fail-closed-Prüfung (`tests/ruleEngine.test.ts`, `tests/indicators.test.ts`,
  `tests/backtest.multiAsset.test.ts`).

### Unverändert

* Bestehende Felder, Labels, Werte und Ceilings — der Golden-Test
  (`tests/backtest.multiAsset.test.ts`) belegt, dass Läufe ohne Donchian-Feld
  weiter byte-identisch sind (`fnv1a` `0uz3hqb`).

## [0.6.4] — Bollinger-Regelfelder (STX-02-02) (2026-09-30)

> **Status: Beta, nicht produktionsreif.** Additive Regel-Felder und ein additiv
> gepflegter Indikator-Cache; **keine** Migration, keine Änderung an bestehenden
> Feldern, Labels oder Werten, kein neues Verhalten ohne Bollinger-Feld.

### Added

* **Drei neue Regel-Felder** (`src/lib/ruleFieldCatalog.ts`, `src/lib/ruleEngine.ts`),
  alle marktneutral und damit über Kursniveaus hinweg vergleichbar:
  * `bbZScore` = `(close − middle) / σ` — Lage zur Bandmitte in
    Standardabweichungen (0 = Mitte, ±2 = Kante, typisch ±3).
  * `priceVsUpperBbPct` = `(close − upper) / close · 100` — Abstand zur oberen
    Kante in Prozent des Kurses; `> 0` ist der Ausbruch über die Kante.
  * `priceVsLowerBbPct` = `(close − lower) / close · 100` — Abstand zur unteren
    Kante; `< 0` ist der Ausbruch darunter.
  Bandparameter sind fest 20 Schlusskurse / 2 σ (Population), identisch zu `bbwPct`
  (`BOLLINGER_PERIOD`/`BOLLINGER_MULT`) — die Periode bleibt Snapshot-Definition,
  kein Regelfeld. Deutsche Labels mit Einheit im Text; `RULE_FIELD_SCHEMA_HINTS`
  liefert Einheiten und typische Werte für die `field`-Beschreibung im
  `RULE_LLM_SCHEMA` (Enum weiterhin `Object.keys(RULE_FIELDS)`).
* **`bollingerPosition(close, reading, mult)`** in `src/lib/indicators.ts`: die drei
  Werte an genau einer Stelle. σ wird aus der Bandgeometrie gelesen
  (`upper = middle + mult·σ`) statt zweimal aus der Varianz gerechnet.
* **`buildSnapshotFromCandles`** befüllt die Felder aus `bollingerBands(closes)`,
  gerundet auf die 4. Dezimalstelle wie `bbwPct`.
* **`indicatorCache`** wächst rein additiv um `bbZScore`, `priceVsUpperBbPct` und
  `priceVsLowerBbPct`: `bollingerPositionArrays()` rechnet sie in O(n) vor
  (festes 20er-Fenster je Bar), `snapshotFromCache` rundet wie der Direktpfad.
  Gemessen: +17 ms für 17 520 Stundenkerzen — der Cache bleibt linear.

### Fixed

* **STX-02-02 / STX-18 (Bollinger-Teil):** „Preis bricht die obere Bandkante“ ist
  regelformulierbar, ohne absolute Preise zu vergleichen. Vorher gab es nur
  `bbwPct` (Bandbreite) — die Lage im Band existierte im Regel-Vokabular nicht.
  Die Multi-Asset-Engine (liest aus dem Indikator-Cache) und der Single-Rule-Pfad
  (`buildSnapshotFromCandles`) liefern jetzt **identische** Feldwerte; vorher wäre
  ein nur im Direktpfad gepflegtes Feld im Portfolio-Backtest `null`/`undefined`
  gewesen.

### Documentation

* `docs/BACKTESTING.md` §1.2: Einheiten, `null`-Fälle und der Beispiel-Workflow
  **„Squeeze → Breakout“** inklusive der gemessenen Grenze, dass der Ausbruch das
  Band selbst weiter aufzieht (Squeeze-Schwelle mitdenken) und dass der
  Regel-Dialekt bewusst zustandslos bleibt (keine Sequenzen).
* `docs/ARCHITECTURE.md` §2.2 (Feld-Whitelist), `docs/MISSIONS.md` §4
  (Workshop-Dropdown + Beispielregel), `docs/architecture/STRATEGY_STACK.md`
  (Ist-Zustand) und die Audit-Doku auf 02-02 nachgezogen.

### Tests

* **Paritätstest** in `tests/backtest.multiAsset.test.ts`: Bar-für-Bar-Vergleich
  der drei Felder zwischen `buildSnapshotFromCandles` und `snapshotFromCache` über
  drei Symbole; eine `bbZScore`-Regel liefert über `backtestRule` und
  `runMultiAssetBacktest` dieselben Signal-Kerzen (18/18 Einstiege identisch).
* **Byte-Identität**: Golden-Hash (FNV-1a, 22 415 Zeichen) eines
  Multi-Asset-Laufs **ohne** Bollinger-Feld — unverändert gegenüber `v0.6.3`.
* **`null`-Fälle** in `tests/ruleEngine.test.ts` (zu wenig Kerzen, flache Reihe
  σ == 0, nicht-positive Mitte), Whitelist (unbekannte Felder wie `bbUpper`
  fliegen weiter), `sanitizeRuleSpec`-Akzeptanz + `RULE_CEILINGS`-Klemmung und
  Formel-/Geometrietests in `tests/indicators.test.ts`. Kein bestehender Test
  wurde angepasst, um grün zu werden; nur Snapshot-Fixtures wuchsen um die drei
  Pflichtfelder.

## [0.6.3] — Indikator-Grundlage (STX-02-01) (2026-09-30)

> **Status: Beta, nicht produktionsreif.** Additive pure Funktionen aus Phase 2;
> keine Rule-Felder, Cache-/Snapshot-Änderung, Migration oder ausführbaren Templates.

### Added

* `bollingerBands(closes, period = 20, mult = 2)` liefert `upper`, `middle`, `lower`,
  `width` und `bandwidthPct`. Bandbreite ist ein **Bruch** (0.05 = 5 %), Populations-σ
  und SMA wie bei der unveränderten Funktion `bollingerBandWidthPct`; fünf Fixtures
  beweisen exakte Parität. Die mathematisch äquivalente Formel `2·mult·σ/SMA` vermeidet
  Rundungsabweichung durch explizite Subtraktion der Bandlevel.
* `donchianChannel(candles, entryPeriod = 20, exitPeriod = 10)` liefert das Hoch der
  vorigen Entry-Kerzen und das Tief der vorigen Exit-Kerzen sowie deren Mitte.
  Die aktuelle Kerze wird **ausgeschlossen** (Lookahead-Schutz). Template 03-08
  muss einen Mindest-Timeframe für diese Higher-Timeframe-Logik festlegen.
* Parametergrenzen für LLM-Vorschläge: Bollinger 5…200/1…4, Donchian 5…200/3…100
  (Exit höchstens Entry); `null` bei unzureichenden oder nicht-berechenbaren Daten.
  Tests decken Randfälle, Klemmung, exakte BBW-Parität und steigenden Breakout ab.

### Fixed

* **Security-Audit:** transitive `brace-expansion`-Versionen im Lockfile auf
  `1.1.21` (über ESLint/minimatch) und `5.0.12` (über typescript-eslint/minimatch)
  aktualisiert. Damit sind die gemeldeten High-DoS-Advisories behoben;
  `npm audit --audit-level=high` meldet keine Schwachstellen. Keine Änderung
  an direkten Abhängigkeiten oder am Laufzeitcode.

### Documentation

* Version/Strategie-Stack, Root-/Docs-README und Audit-Tracking auf 02-01 nachgezogen.
  Die bislang bestehende BBW-Funktion sowie sämtliche bisherigen Indikatoren bleiben
  unverändert. Rule-Felder und IndicatorCache-Parität folgen erst in 02-02/02-03.

## [0.6.2] — Timeframe-Angleichung (STX-01) (2026-09-29)

> **Status: Beta — und bleibt Beta.** Prompt **01-01** der Strategie-Roadmap (Finding **STX-01**,
> Gate **G1**): Der Regel-Pfad trägt jetzt alle zehn `SUPPORTED_TIMEFRAMES` (`1m … 5d`), und der
> Mikro-Executor weist Regeln jenseits seines Ausführungsintervalls **fail-closed und sichtbar**
> ab. Regeln mit `1m … 1h` bleiben **byte-identisch** (Golden-Test gegen die Sanitize-Ausgabe des
> Stands `v0.6.1`, zusätzlich ein Differenzlauf über Snapshots und Backtests). Es gibt keine
> Migration und keine Schema-Änderung; `RULE_FIELDS`, `RuleAction`, `RULE_CEILINGS` und
> `RULE_ALLOWED_SIDE` sind unverändert — Shorts bleiben global gesperrt. `package.json` folgt dem
> Release-Plan [`VERSIONING.md`](docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md) §2.

### Added

* **`src/lib/marketdata/timeframes.ts`:** das Timeframe-Vokabular (`SUPPORTED_TIMEFRAMES`,
  `SupportedTimeframe`, `SUPPORTED_TIMEFRAME_MS`, `isSupportedTimeframe`) als reine, client-sichere
  Datei ohne Imports. Der Historical Store re-exportiert alles unverändert — alle bestehenden Importe
  aus `historicalStore.ts` bleiben gültig. Grund für die eigene Datei: Regel-Engine und Workshop-UI
  dürfen `node:fs` (Store-Persistenz) nicht in ihren Import-Graphen ziehen (die Workshop-Komponenten
  liegen im Client-Bundle; `next build` ist grün).
* **`RULE_ALLOWED_TIMEFRAMES`** (`ruleEngine.ts`): aus `SUPPORTED_TIMEFRAMES` abgeleitet — kein zweites
  Vokabular. `sanitizeRuleSpec` und `RULE_LLM_SCHEMA` lesen genau diese Liste (ersetzt das private
  `ALLOWED_TIMEFRAMES` und das handgepflegte Enum im LLM-Schema).
* **Timeframe-Guard im Mikro-Executor (fail-closed, sichtbar):** Der Executor wertet eine Regel
  gegen den Snapshot ihres Timeframes inklusive der noch laufenden Kerze aus; für `2h`/`4h`/`1d`/`5d`
  wäre das ein teilweise abgelaufener Snapshot. Neu: `MicroExecutorOptions.executionInterval` (Default
  `1h` = bisheriges Maximum, `MICRO_EXECUTION_INTERVAL_DEFAULT`) und die reine Funktion
  `ruleTimeframeBlockReason` (`timeframe_exceeds_interval` | `timeframe_unsupported`). Eine
  abgewiesene Regel bekommt keine Serie und löst nie eine Order aus; das „Nein“ ist sichtbar:
  Counter `micro_executor_rule_blocked_total{reason,timeframe}` (Labels ohne Symbol/Regel-ID,
  Kardinalitätsregel), strukturiertes Log `micro_executor_rule_blocked` (je Regel einmal beim Start,
  nicht je Tick) und `ruleGuard` im Status des Executors (`GET /api/firm/micro` →
  `microProcess.ruleGuard`).
* **30 Tests, rein additiv (kein bestehender Test angepasst):**
  `tests/ruleEngine.test.ts` (+14: `4h`/`1d` akzeptiert, Fail-closed-Tabelle, **Golden-Test** für
  `1m|5m|15m|30m|1h`, Schema-Ableitung, Ceilings/LONG/Felder unverändert, `vwapPct === null` auf
  `1d`/`5d` und bei < 2 Kerzen am UTC-Tag, Engine-Pfad-Parität, `volumeWindow` auf `1d`, Guard-Test
  „`1d`-Regel auf 1m-Intervall → keine Order, genau ein Counter“),
  `tests/microExecutor.test.ts` (+11: 10×10-Matrix des Guards, Fail-closed bei unbekanntem Timeframe,
  Serien-Periode je Timeframe = kanonische Dauer, `3m`-Regression, Status, Konfiguration),
  `tests/marketdata/timeframes.test.ts` (4: Invarianten, Re-Export, Client-Sicherheit),
  `tests/ui/RuleBacktestPanel.test.tsx` (1: Workshop-Auswahl = Allowlist).

### Changed

* **`RuleWindow.timeframe` ist ein `SupportedTimeframe`** (vorher eine Union aus fünf Werten).
  `sanitizeRuleSpec` nimmt jeden der zehn Werte an und bleibt sonst unverändert fail-safe: Die
  Schreibweise wird kleingeschrieben (`"1H"` → `"1h"`), alles außerhalb der Allowlist (`"2h "`,
  `"7d"`, `""`, `null`) fällt auf den sicheren Default `15m` — nie wird ein Rohwert durchgereicht.
* **`RollingTimeframeSeries`** rechnet mit der kanonischen Periodentabelle
  (`SUPPORTED_TIMEFRAME_MS`) statt mit einer zweiten, unvollständigen. `MicroExecutor.addSymbol` wirft
  einen `RangeError` für Timeframes oberhalb des Ausführungsintervalls oder außerhalb des Vokabulars;
  der Konstruktor von `MicroExecutor` wirft bei unbekanntem `executionInterval`.
* **`MicroStatus`** hat ein zusätzliches Feld `ruleGuard` (`executionInterval`, `blocked[]`; additiv).
* **Workshop-Schritt 5 (`RuleBacktestPanel`):** Die Auswahl „Fenster“ bietet alle zehn Timeframes
  (aus `SUPPORTED_TIMEFRAMES`, nicht handgepflegt). Die Vorgabe „Workshop-Panel mitziehen“ stammt aus
  dem `1m`-Präzedenzfall (`2026-09-24-internal-adapter-daytrading`).
* **`scripts/bench-backtest.ts`:** der Cast nach der Sanitize-Kette in `buildBenchSpec` entfällt wie
  angekündigt („fällt mit 01-01 ersatzlos weg“) — der gemessene Timeframe läuft durch die Kette selbst.
* **Audit-Doku auf `v1.1.2`:** STX-01 behoben (`FIXED`), Gate **G1** erfüllt, Phase 1 abgeschlossen;
  `ROADMAP.md`, `remediation/TRACKING.md`, Findings-Index und Prompt-Index nachgezogen.

### Fixed

* **Stiller 15m-Fallback im Mikro-Executor:** `TIMEFRAME_MS[tf] ?? TIMEFRAME_MS["15m"]` kannte nur
  `1m…1h`. Mit der erweiterten Allowlist hätten `3m`/`2h`/`4h`/`1d`/`5d`-Regeln still auf
  15-Minuten-Kerzen gelaufen — auf einem anderen Takt, als sie unterschrieben haben (derselbe Fehler,
  der bei der Einführung von `1m` schon einmal auftrat, CYCLE-DAYTRADE-01). Die Serie nutzt jetzt die
  kanonische Tabelle (`3m` aggregiert exakt auf 3 Minuten) und wirft bei einem unbekannten Timeframe
  laut, statt zu fallen; bei Werten oberhalb des Ausführungsintervalls greift der Guard.

### Documentation

* **Tabelle „Rule-Timeframe ↔ unterstützte Felder“** in `docs/BACKTESTING.md` §1.1 (Kerzen je UTC-Tag,
  `vwapPct`, `volumeWindow` in Zeit, `changePct24h`-Spanne, Live-Ausführbarkeit, Kostenmodell) samt
  Begründung, warum `RULE_CEILINGS.volumeWindow` (5…200) unverändert bleibt; Verweise in
  `docs/MISSIONS.md` (Workshop), `docs/ARCHITECTURE.md`, `docs/architecture/STRATEGY_STACK.md`
  (SSoT-Zeile „Rule-Timeframes“), `docs/HISTORY.md`, `docs/architecture/PIPELINE_MAP.md`,
  `docs/HANDBUCH.md` (Glossar „Rolling-Serie“/„Ausführungsintervall“, §15.3),
  `docs/OBSERVABILITY.md` (Counter und Log) und `docs/REPOSITORY_STRUCTURE.md` (`ruleEngine` mit
  Timeframe-Hinweis).
* **Befundkorrekturen an STX-01:** (1) `sessionVwap` war auf `1d` bereits fail-closed — bei weniger
  als zwei Kerzen am UTC-Tag liefert es `null` (nie `0`), ein VWAP über eine Einzelkerze entstand nie.
  Es war kein Code-Fix nötig; die Eigenschaft ist jetzt per Test und Tabelle belegt. (2)
  `sanitizeRuleSpec` „verwirft“ einen unbekannten Timeframe nicht, sondern fällt auf `15m` und
  kleinschreibt vorher — der Prompt nennt `"1H"` als verworfen, real wird es zu `"1h"`. Die Semantik ist
  vom Prompt als gesperrt markiert und bleibt; getestet ist das Ist-Verhalten.
* **Bekannte Altlasten, bewusst unverändert** (kein Teil dieses Releases, beim Fixen beobachtet):
  das Kosten-Fallback-Modell des Paper-Backtests (`paperExecution.ts`) ist für `3m`, `2h`, `5d` nicht
  kalibriert (`3m` rechnet mit 4 bp/1 bp und ist damit optimistisch gegenüber `1m`/`5m`); die
  `RollingTimeframeSeries.touch()`-Aggregation addiert das kumulierte 1m-Volumen bei jedem Tick erneut
  (`volume` wächst statt 1, 2, 3 als 1, 3, 6 — live überhöht `volumeRatio`); und Serien entstehen nur
  beim Start bzw. für `MICRO_SYMBOLS` (`5m`/`15m`): eine später aktivierte Regel mit neuer
  Symbol-/Timeframe-Kombination wird erst nach einem Neustart ausgewertet, obwohl das Handbuch „kein
  Neustart nötig“ sagt. Jeder dieser Punkte ändert bestehende Ergebnisse und braucht ein eigenes
  Versionsereignis.

## [0.6.1] — Strategie-Stack-SSoT & Vokabular-ADRs (2026-09-29)

> **Status: Beta — und bleibt Beta.** Dieser Release bündelt die Prompts **00-02**
> (Strategie-Stack-SSoT — mit PR #182 ohne Changelog, Version und Tracking gemergt und hier
> nachträglich versioniert) und **00-03** (drei Vokabular-ADRs). Er ändert **kein**
> Laufzeitverhalten: kein Eintrag in `src/`, `scripts/` oder `drizzle/` wurde angefasst, es
> gibt keine Migration und keine Schema-Änderung. `package.json` folgt dem Release-Plan
> [`VERSIONING.md`](docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md) §2; Gate
> **G0** der Strategie-Roadmap ist erfüllt, Phase 1 darf starten.

### Added

* **ADR-008, ADR-009, ADR-010** in [`docs/roadmap/DECISIONS.md`](docs/roadmap/DECISIONS.md)
  (Prompt 00-03, Findings STX-02/03/04). Jeder Eintrag folgt dem Schema Status · Kontext ·
  Optionen (Verworfenes mit Begründung) · Entscheidung · Konsequenzen · Auswirkung auf die Roadmap:
  * **ADR-008 (ADR-E1) Strategie-Klassifikation:** `StrategyTemplate.class` ist ein Pflichtfeld
    vom Typ `StrategyClassKey` (aus `STRATEGY_CLASS_KEYS`, kein eigener Union-Typ);
    `unclassified` ist kein Template-Status, sondern ein Fehler; **keine neue Klasse** —
    MACD → `trend`, RSI → `mean-reversion`; Zuordnung aller sechs Templates.
  * **ADR-009 (ADR-E2) Regime-Vokabular:** `MarketRegime` (5) + `UNKNOWN`, persistiert in
    `regime_snapshots`; die 7er-Taxonomie des Ausbaudokuments ist **verworfen**; `UNKNOWN` wird
    fail-closed ausgeschlossen; High-/Low-Volume ist der Scanner-Faktor `volumeRatio`, kein Regime.
  * **ADR-010 (ADR-E3) Universe-Strategie:** **keine** `MultiAssetStrategySpec`; eine
    `PortfolioConstruction`-Schicht (`EQUAL_WEIGHT`/`INVERSE_VOLATILITY`) liest den
    `CrossSectionalConfig`-Snapshot, die Exposure bleibt über `VOLATILITY_TARGETING_BOUNDS`
    geklemmt, Rebalance-Frequenz = `CrossSectionalConfig.timeframe`; die Schicht selbst ist
    bewusst **nicht** Teil der 32 Prompts.
* **`docs/architecture/STRATEGY_STACK.md`** (Prompt 00-02, PR #182 — nachträglich versioniert):
  Single-Source-of-Truth-Karte „welcher Baustein ist wofür zuständig“, explizite Lücken
  (`src/strategies/`, `src/screening/`, `src/copy/`) und 5-zeilige Einordnungsregel.
* **`tests/adrVocabulary.test.ts` (neu, nur lesend, 36 Tests):** nagelt die ADRs statisch fest —
  Form (Schema, genau eine Entscheidung, jede Alternative „verworfen“ mit Begründung, keine
  Vorbehalte), Code-Fakten (Klassenliste, Gate-Faktoren je Regime × Klasse, `regime_snapshots`-CHECK,
  `evaluateRegimeOos`-Verhalten, `UNIVERSE_CAP`, Vol-Targeting-Bounds, `AUTHORITY_CHAIN`),
  Guards für künftigen Code (keine eigene Klassenliste in `src/strategies/`, keine
  `MultiAssetStrategySpec`) und die Verweise in Roadmap, Tracking und Prompts.
* **`tests/docsVersioning.test.ts`:** neuer Test, dass `VERSION.md` und das Root-`README.md`
  dieselbe Version wie `package.json` nennen (die Bump-Checkliste, die bei PR #182 fehlte).

### Changed

* **Strategie-Audit nachgezogen** (`docs/audits/2026-09-29-strategy-template-ausbau/`): Audit-Version
  `v1.1.1`; Phase 0 abgeschlossen (00-01 `v0.6.0`, 00-02/00-03 `v0.6.1`), Gate **G0** erfüllt,
  OP-2 beantwortet; STX-02/03 in Arbeit (Entscheidung gefallen, Umsetzung in Phase 3/6), STX-04 und
  STX-15 behoben, STX-10/11 dokumentiert. `ROADMAP.md` nennt die ADR-Nummer in jeder Phase, die ein
  Vokabular berührt (Phasen 0, 1, 3, 4, 5, 6, 7) und führt `MultiAssetStrategySpec`, die 7er-Taxonomie
  und neue Klassen als verworfen.
* **Prompts an die Entscheidungen angeglichen:** 03-01/03-02/03-10 (`expectedRegimes` ist
  `readonly MarketRegime[]`, `UNKNOWN` ist ein Validierungsfehler; `scope` leitet sich aus
  `MissionScope` ab), 03-05 (Wirkungsgrenze der Klasse), 03-09 (`CompileResult.strategyClass`),
  06-04 (Aggregator „Strategie je Regime“ statt `evaluateRegimeOos`), 01-01 (Cross-Sectional-Rebalance
  ist nicht blockiert).
* **Doku-Indizes und Verweise** (`docs/README.md`, `docs/audits/README.md`,
  `docs/REPOSITORY_STRUCTURE.md`, `docs/architecture/PIPELINE_MAP.md`, `README.md`):
  `STRATEGY_STACK.md` und der ADR-Log sind auffindbar; `docs/REGIME_GATE.md`, `docs/SIGNAL_DECAY.md`,
  `docs/CROSS_SECTIONAL_RANKING.md` und `docs/VOLATILITY_TARGETING.md` verweisen auf ihre ADR.

### Documentation

* **Korrekturen an `STRATEGY_STACK.md`** (gegen den Code verifiziert): `evaluateRule` existiert nicht
  (`CompiledRule.evaluate` via `compileRuleSpec`); Bollinger gibt es nur als Bandbreite
  (`bollingerBandWidthPct`), `bollingerBands`/`donchianChannel` liefert erst 02-01;
  `BacktestEngineConfig.feeModel` hat kein `feeMode`; die Funktion heißt `normalizeVenueSymbol`
  (nicht `normalizeSymbol`); `src/scanner/factors/` hat 17 Dateien (15 Faktormodule + `helpers.ts` +
  `index.ts`); Eligibility gibt es in drei Stufen (Registry-Policy, Scanner-Trichter,
  Snapshot-Membership), nicht als „zentralen Vertrag“.
* **Faktenkorrekturen in Indizes und Glossar:** `README.md` nennt die **14 aktiven** Scanner-Faktoren
  (statt „15+“, STX-15); das Glossar in `docs/ARCHITECTURE.md` trennt „Volatilitäts-Regime“
  (NORMAL/ELEVATED/EXTREME, Risikofaktor) von „Markt-Regime“ (`MarketRegime`) und führt
  Strategieklasse und Cross-Sectional-Snapshot auf; der Severity-Zähler im Audit-README war
  inkonsistent (INFO-Zeile) und ist korrigiert.
* **Präzisierungen an den Befunden STX-01…STX-04** (Details: ADR-008 bis ADR-010):
  `evaluateRegimeOos` misst **Markt**-Forward-Returns und weist `UNKNOWN` als eigenen Bucket aus
  (der Befund-Test „schließt `UNKNOWN` aus“ gilt dem künftigen Aggregator); `selection.topN` ist durch
  `maxUniverseSize` **nicht** gedeckt (`UNIVERSE_CAP` kappt nach Volumen); die Bounds in
  `volatilityTargeting.ts` begrenzen den Risiko-Multiplikator, keine Gewichte; Regeln tragen keine
  Strategieklasse (Ableitung über das Mission-Template), und der Backtest wendet kein Regime-Gate an;
  der Cross-Sectional-Rebalance hängt nicht an `RuleWindow.timeframe` (der Hinweis zu STX-01 im
  Eintrag `0.6.0` gilt nur für regelbasierte Strategien).
* **Bekannte Altlasten, bewusst unverändert** (kein Code in diesem Release): die vier Klassenwerte
  stehen zusätzlich als Literale in `signalDecay.ts`, `signalDecayRuntime.ts` und im CHECK von
  `signal_decay_events`; `VolatilityRegime` ist in `adaptiveRisk.ts`, `src/portfolio/types.ts` und
  `src/scanner/types.ts` dreifach definiert. Neuer Code importiert die bestehenden Konstanten.
  Außerdem löst der In-App-Doku-Viewer (`/docs/<Datei>.md`, `GET /api/docs`) über `resolveDoc`
  (`src/lib/docsCatalog.ts`) weder `docs/architecture/` noch `docs/roadmap/` auf — das betrifft auch
  `STRATEGY_STACK.md` und den ADR-Log (im Repo und auf GitHub lesbar, im Browser-Viewer nicht).
  Die Behebung wäre eine Code-Änderung (zwei Suchpfade) und ist nicht Teil dieses Doku-Release.

## [0.6.0] — Backtest-Performance-Baseline (2026-09-29)

> **Status: Beta — und bleibt Beta.** Dieser Release bündelt die mit PR #180 gemergte
> Audit-/Beta-Dokumentation und den ersten umgesetzten Roadmap-Prompt **00-01**
> (Backtest-Performance-Baseline). Es ändert **kein** Laufzeitverhalten: die
> gemessenen Pfade (`src/lib/ruleEngine.ts` `backtestRule()`, `src/backtest/engine.ts`,
> `src/backtest/indicatorCache.ts`) bleiben unverändert, es gibt keine Migration und
> keine Schema-Änderung. `package.json` folgt dem Release-Plan
> [`VERSIONING.md`](docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md) §2
> (`v0.5.1` ist in `v0.6.0` gefaltet; alle Releases liegen in `0.x`).

### Added

* **Audit 2026-09-29 — Strategie-Template-Ausbau** (`docs/audits/2026-09-29-strategy-template-ausbau/`):
  Code-verifizierende Prüfung eines externen Ausbaudokuments gegen `main` @ `e3509fd`.
  **19 Findings** (0 CRITICAL, 5 HIGH, 7 MEDIUM, 4 LOW, 3 INFO) und eine **Roadmap aus
  32 kopierfertigen Prompts** in 8 Phasen mit Abhängigkeitsgraph, Gates (G0–G8) und
  globalen Gesperrt-Klauseln. Siehe [`report.md`](docs/audits/2026-09-29-strategy-template-ausbau/report.md).
* **`docs/BETA_STATUS.md` (neu, kanonisch):** verbindliche Beta-Zusage. Kriterien
  `B1…B8` für einen Beta-Exit (Out-of-Sample über 12 Monate Live-Paper, Regime-Abdeckung,
  Live-Readiness-Audit, Security, Compliance, Betriebsreife, **unabhängige**
  Drittprüfung, bewusste Haftungsentscheidung), verbotene Handlungen, Review-Kadenz
  und die Zuordnung Roadmap → Kriterien.
* **`docs/audits/2026-09-29-strategy-template-ausbau/VERSIONING.md` (neu):**
  Audit-Versionsschema (`audit-2026-09-29`, aktuell `v1.1.0`) mit Bump-Regeln und
  **Release-Plan `v0.6.0` … `v0.11.2`** — ein Minor-Release je Phase bzw. Template,
  sämtlich in `0.x`. Enthält außerdem die drei erwarteten Bruchstellen in `0.x`
  (Timeframe-Erweiterung, Snapshot-Wachstum, neues Copy-Modul) und die
  Abwärtskompatibilitätsregeln.

* **`scripts/bench-backtest.ts` + `npm run bench:backtest` (neu, Prompt 00-01 / STX-12):**
  Messprotokoll der Backtest-Performance-Baseline. Misst auf **einer** echten,
  aus dem `HistoricalStore` gelesenen Reihe (keine synthetischen Bars) drei Pfade —
  `backtestRule()` (Single-Rule), `runMultiAssetBacktest()` (Engine) und
  `buildIndicatorCache()` + `snapshotFromCache()` (Indikator-Pfad) — bei
  n ∈ {1 000, 5 000, 17 520} Kerzen, je 1 ungemessenem Warmlauf + 3 Läufen (Median),
  inklusive `ms/1000 Kerzen`, log-log-Fit-Exponent und der „1 Zelle Matrix"-Rechnung
  (7 500 Zellen → Kernstunden seriell). Braucht **keine** Datenbank und kein Netz,
  schreibt nur nach `data/bench/` (gitignoriert).
* **`scripts/import-history-csv.ts` + `npm run history:import-csv` (neu):** netzfreier
  CSV-Import in den `HistoricalStore` (Kopfzeilen-Aliasing, Zeit in Sekunden/ms/ISO,
  `--from`/`--to`-Fenster, `--max-bars`, Dry-Run als Default mit Exit 2, `--apply`).
  Dedup und Validierung bleiben beim Store — verworfene und doppelte Zeilen werden
  gemeldet, nie still ersetzt.
* **`docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md` (neu):**
  Messprotokoll mit allen Rohwerten. Kernergebnis: `backtestRule()` wächst mit
  Exponent **1,99** und kostet bei 17 520 Stundenkerzen **25 986 ms je Zelle**
  (7 500 Zellen = **54,14 Kernstunden** seriell), `runMultiAssetBacktest()` mit
  Exponent **1,01** und **213,5 ms** je Zelle (**0,44 Kernstunden** für die volle
  Matrix) — **121,7×** bzw. **360,1×** schneller als der Single-Rule-Pfad.

### Changed

* **Beta-Positionierung in `README.md` und `VERSION.md` verstärkt und
  operationalisiert:** beide nennen jetzt explizit, dass die vollständige Umsetzung
  der Strategie-Roadmap die Beta-Phase **nicht** beendet. In `VERSION.md` als
  eigene Zeile `Beta-Zusage` in der Metadatentabelle, in `README.md` als Zeile
  `Beta-Exit` in der Versions-Status-Tabelle plus ein hervorgehobener Hinweis.
* **Doku-Indizes ergänzt** (`docs/README.md`, `docs/audits/README.md`): neuer
  Eintrag für das Audit 2026-09-29 und Verweis auf `BETA_STATUS.md`.

* **Entscheidung aus der Messung (Gate G5 erfüllt):** Screening, Template-Compiler-Tests
  und Validator-Läufe fahren über `runMultiAssetBacktest()` (bzw. direkt über den
  Indikator-Cache); `backtestRule()` bleibt der Einzel-/Referenzpfad. STX-12 ist damit
  von „Blocker der Matrix" auf **Patch-Task mit Paritätstest** herabgestuft, `worker_threads`
  ist keine Voraussetzung für 05-04. Die Audit-Doku wurde nachgezogen (STX-12, Roadmap,
  Tracking, Audit-Version `v1.1.0`).

### Findings (Auszug, Details je Datei unter `findings/`)

* **STX-01 (HIGH)** — `RuleWindow.timeframe` ist auf `1m|5m|15m|30m|1h` begrenzt,
  während `SUPPORTED_TIMEFRAMES` bis `5d` reicht. Ohne Angleichung sind sämtliche
  Screening- und Cross-Sectional-Ziele **nicht ausdrückbar**.
* **STX-05 (HIGH)** — der vorgeschlagene `buildRule(ctx)`-Builder erzeugt zur Laufzeit
  eine fertige `RuleSpec` und würde damit `sanitizeRuleSpec()` und `RULE_CEILINGS`
  umgehen — also genau die Kette, die das Sicherheitsmodell „Code entscheidet" trägt.
  Korrektur: pure Funktion der **Parameter**, Rückgabetyp `RuleSpecInput`.
* **STX-02/03/04 (HIGH)** — `StrategyClass`, `MarketRegime` und `CrossSectionalConfig`
  existieren bereits; das Ausbaudokument hätte dafür je ein zweites Vokabular
  angelegt. Kein neues Klassifikations-, Regime- oder Eligibility-Modell.
* **STX-08 (MEDIUM)** — `src/brokers/alpaca/` enthält **keinen** WebSocket; der
  Alpaca-Adapter ist REST-only. Alpaca ist deshalb **nicht** Teil der Copy-Roadmap.
* **STX-12 (MEDIUM)** — `backtestRule()` ist O(n²) (`ruleEngine.ts:787`); nur die
  Multi-Asset-Engine nutzt `IndicatorCache`. Bestimmt, ob eine Matrix mit Tausenden
  Zellen überhaupt lauffähig ist → Benchmark ist Phase 0.
  **Gemessen in diesem Release:** Exponent **1,99** (O(n²)) für `backtestRule()`
  gegen **1,01** (O(n)) für die Engine; siehe
  [`BENCH-BASELINE.md`](docs/audits/2026-09-29-strategy-template-ausbau/remediation/BENCH-BASELINE.md).
* **STX-16 (LOW, organisatorisch hoch)** — Copy-Trading verschiebt das
  Haftungsprofil. Deshalb `CopyMode` als Enum mit **genau einem** Wert
  (`SIMULATE_ONLY`) und DB-CHECK, kein Env-Flag.

### Documentation

* **Faktenkorrektur im Umfeld:** Der Scanner hat **14** aktive Faktoren
  (`src/scanner/scanner.config.json`), nicht „15+". Das Audit dokumentiert die
  SSoT-Verweise statt Dateizahlen.

## [Unreleased]

> **Status: Beta.** Offen für den nächsten Zyklus (aus den Audits): `IAD-T-07`
> Limit-/Stop-Markt/OCO am Broker (`src/execution`), `IAD-T-08` Session-VWAP
> mit börsenlokaler Tagesgrenze (Exchange-Kalender), Shorts
> (`RULE_ALLOWED_SIDE=LONG`) bleiben Risikoentscheidung.

## [Unreleased] — ALPACA-Datenpfad, OpenCode Zen & Laufzeit-Schalter (2026-09-25)

> **Status: Beta.** Quelle: Arena-Auftrag 2026-09-25 („nur 2 Symbole",
> Alpaca-Integration, Remote-Check-Frage, OpenCode-Free-Modelle per UI).

### Added

* **OpenCode Zen als LLM-Provider** (`opencode`, `src/lib/llmProvider.ts`):
  OpenAI-kompatibler Cloud-Provider mit kostenlosen Modellen
  (`OPENCODE_API_KEY`, `OPENCODE_BASE_URL` → `https://opencode.ai/zen/v1`,
  `OPENCODE_MODEL`, Default `big-pickle`). Free-Model-Snapshot
  (`OPENCODE_FREE_MODELS`, `isOpenCodeFreeModel`), Kosten 0
  (`LLM_COST_OPENCODE_*` für bezahlte Modelle), Token-Deckel
  `ROUTING_BUDGET_OPENCODE_TOKENS` (Policy-Default 250 000/Tag), letzte
  Präferenz in `MODEL_C`. Doku: `docs/PROVIDER_INTEGRATION.md` §4b.
* **Laufzeit-Schalter (UI)** — `GET|PUT /api/ops/toggles` + Panel
  `src/components/ops/RuntimeTogglesPanel.tsx`:
  * je LLM-Provider `provider.<id>.enabled` (ein-/ausschalten ohne Neustart),
  * `broker.healthcheck.remote` für die Broker-Remote-Checks.
  Persistenz `data/runtime/flags.json` (`src/lib/runtimeFlags.ts`, nur
  Bool-Werte, chmod 600, atomar, fail-soft). Admin-Guard + CSRF, Audit-Event
  `RUNTIME_FLAG_CHANGED` (Katalog-Eintrag in `src/lib/auditView.ts`).
* **Env-Sperrliste** `ROUTING_DISABLED_PROVIDERS`, effektiv per
  `isProviderEnabled()`/`resolveProviderChain()`: gesperrte Provider werden nie
  gewählt, nie als Fallback genutzt und **nie abgefragt** (auch kein
  Health-Ping). `/api/providers` liefert `enabled`/`toggleSource`/`toggleKey`.
* **ALPACA-Datenpfad dokumentiert und im Hinweis sichtbar:**
  `docs/ALPACA.md` §1a/§1b (Sync über Yahoo, Aktivierungs-Checkliste,
  Health-Semantik); `.env.example` dokumentiert `ALPACA_ENABLED` und den
  Venue-Sync.

### Changed

* **Sync-Hinweis ist venue-bewusst** (`buildReadinessHint`,
  `syncCommandsFor`, `offenderVenues` in `src/ops/collectMarketData.ts`): Der
  Hinweis nennt die Venues der worst offenders (`npm run market:sync --
  --venue=ALPACA …`, ein Kommando je Venue) plus den Flag-Hinweis
  (`<VENUE>_ENABLED=true`), wenn eine Venue noch nie synchronisiert wurde —
  vorher stand dort pauschal BITUNIX.
* **Broker-Remote-Check** ist ohne Neustart umschaltbar; die Auflösung
  (Runtime-Flag → Env → Default aus) ist als `source` in `/api/brokers` und
  `/api/brokers/{venue}/health` sichtbar. ALPACA/IBKR prüfen credential-frei
  ihre Sync-Quelle (Yahoo) und melden NIE `online` ohne Keys/Gateway: der
  Status bleibt `degraded`, `syncSourceReachable` trägt die Zusatzinformation.
* **LLM-Operations-Sektion** weist gesperrte Provider und deren Begründung aus
  (Metrik „Provider freigegeben", Hinweiszeile).

### Fixed

* `.env.example` dokumentierte `ALPACA_ENABLED` nicht — die Venue ließ sich
  damit nur durch Raten freischalten; Sync und Adapter waren für ALPACA
  faktisch nicht erreichbar (`0/61 Kerzen`).

## [0.5.0] — 2026-09-26 · Multi-Venue-Warmup und datenbewusster Missionskontext

> **Status: Beta.** Scan-Missionen erhalten belastbaren Multi-Kandidatenkontext,
> rotierenden Fokus und handeln nur Kandidaten mit ausreichend Kerzen.

### Hinzugefügt

- **Mission-Venue-Warmup** (`npm run market:sync:mission-venues`): führt die
  bestehenden public-only Syncs für IBKR, PAPER, BINANCE und KRAKEN aus,
  setzt keine Sicherheits-/Env-Gates außer Kraft und versucht nach Venue-Fehlern
  die restlichen Läufe trotzdem. Der Gesamtstatus ist nicht-null, wenn mindestens
  ein Venue nicht warm wurde.
- **Top-5 Multi-Kandidaten-Snapshots** im Missionsprompt: je Kandidat Preis,
  RSI(14), Trend und ATR%; Kandidaten ohne mindestens 25 verwertbare Kerzen
  werden aus dem Mandat entfernt. Ist kein Kandidat warm, wird HOLD angewiesen
  und die Engine blockiert eine Trade-Entscheidung fail-closed.
- **Deterministische Fokusrotation** je UTC-15-Minuten-Zyklus mit
  missionsspezifischem Offset. Ein aktueller (max. 48 h), READY-Scanner-Snapshot
  sortiert Kandidaten nach Scanner-Score; volumenbasiertes Ranking bleibt der
  robuste Fallback.
- Gezielte Tests für Fokusrotation und Scanner-Score-Ranking.

### Geändert

- Versionsstand auf `v0.5.0` angehoben; Setup- und Marktdaten-Dokumentation um
  Venue-Gates, Warmup-Ablauf und Mandatssemantik ergänzt.

## [0.4.0] — 2026-09-24 · bookDepthUsd + Orderbuch-Qualitätsgrenze je Venue

> **Status: Beta.** Logische Fortsetzung von `spreadPct` (IAD-T-06): Die
> Orderbuch-**Tiefe** wird zum Regelfeld, abgesichert durch eine
> **Qualitätsgrenze je Venue** — ein Feld auf dünnen Büchern wäre eine
> Fehlentscheidungs-Maschine. Quelle: Arena-Auftrag 2026-09-24.

### Hinzugefügt

- **`bookDepthUsd` als Regelfeld** (`IAD-T-06`): Orderbuch-Tiefe der
  abriegelnden Seite `min(Σ bid×qty, Σ ask×qty)` in Quote-Währung. Verfügbar in
  `MarketInstrument.bookDepthUsd` (Registry + sync-Upsert + Spread-/Depth-Cache
  `data/spread-cache.json`, abwärtskompatibel), `RuleSnapshot`, `RULE_FIELDS`,
  `buildSnapshotFromCandles`/`snapshotFromCache`, `microExecutor.updateBook`
  (Live-Buch aus dem Binance-`@depth5`-Stream), `TrustedReading.bookDepthUsd`.
  `null` blockiert die Bedingung (fail-closed) — eine 0 wäre eine erfundene Tiefe.
- **Orderbuch-Qualitätsgrenze je Venue** (`src/lib/bookDepthProvenance.ts`):
  Nur `depth`-Venues (BINANCE/BITUNIX/KRAKEN) liefern `VERIFIED`-Tiefe
  (≥ 3 Levels je Seite, Snapshot ≤ 5 s alt). `top`-Venues (YAHOO — Preise ohne
  Lotgröße) und `none` (PAPER-Presets) bleiben `UNQUALIFIED`. Unbekannte Venues
  fallen auf `none` (nie auf `depth`).
- **`src/lib/bookDepth.ts`**: deterministische Tiefenberechnung
  (`computeBookDepth`), Rohlevel-Sanitisierung mit harter Kappung
  (Security) und ordnungsunabhängigem Best-Bid/Ask.

### Geändert

- `MarketInstrument` + `INSTRUMENT_FIELDS` + Normalisierung/Validierung um
  `bookDepthUsd` (NULL-Metrik-Semantik wie `volume24h`/`spread`).
- `enrichWithOrderBooks` misst Tiefe aus denselben Depth-Levels (kein Extra-Request).
- `formatSyncLog` führt bei Messungen die Zählerzeile `book depth measured`.
- Tech-Debt/Kosmetik: 6 ungenutzte `eslint-disable`-Directiven entfernt
  (`lint` jetzt 0 warnings), redundanter Seitenfilter in der Tiefenberechnung
  gestrichen.
- Execution-Quality-Golden-Pin neu gesetzt: der Evidence-Hash deckt jetzt
  `bookDepthUsd` als Entscheidungsinput ab.

## [0.3.0] — 2026-09-24 · Paper n≥100, Kostenmodell feine Takte, 6 rote Tests grün, spreadPct

> **Status: Beta.** Umsetzung der 4 Prioritäten vor Kosmetik:
> 1. Paper lange genug für n ≥ 100, 2. Kostenmodell auf den feinen Takten,
> 3. die 6 vorbestehenden roten Tests, 4. `spreadPct` für Daytrading.
> Quelle: Arena-Auftrag 2026-09-24.

### Hinzugefügt

- **Regelfeld `spreadPct`** (`DAYTRADING-SPREAD-01`): Relativer Spread in Prozent
  (`instrument.spread` = (ask-bid)/mid ×100, `null` ohne Orderbuch). Quelle:
  `MarketInstrument.spread` (Orderbook-Top-Level, Plausibilität ≤50 %), gemessen
  im `market-sync` via `spreadCache` (6 h TTL, `data/spread-cache.json`),
  verfügbar im `RuleSnapshot`, `RULE_FIELDS`, Mikro-Executor (`updateSpread`),
  Trusted-Indicators (`spreadPct` im Reading) und Workshop-Katalog. Für Daytrading
  die zentrale Kosten-/Liquiditätsgröße — hoher Spread frisst die Edge pro Trade.
- **Indikator-Cache für die Backtest-Engine** (`PERF-CACHE-01`,
  `src/backtest/indicatorCache.ts`): EMA9/21/50, RSI14, ATR/ATR-Pct, ADX14, BBW-Pct,
  MACD/Signal/Hist, VolumeMa20 und VWAP werden einmal pro Symbol in O(n)
  vor-gerechnet, danach O(1)-Lookup je Bar. Macht aus O(n²) → O(n): 2 Jahre
  Stundenkerzen (17 520 Bars) von 17–21 s auf 0,6–0,8 s (Performance-Deckel <10 s
  im Test `tests/backtest.replay.test.ts`).
- **Timeframe-abhängiges Kostenmodell** (`COST-TIMEFRAME-01`,
  `src/backtest/paperExecution.ts`): `timeframeToSpreadFallbackBps` und
  `timeframeToSlippageBaseBps` — 1m 15 bp / 3 bp, 5m 10/2, 15m 8/1.5, 30m 6/1,
  1h 4/1, 4h 3/0.5, 1d 2/0.5. `createPaperExecutionRuntime` skaliert
  `syntheticSpreadBps` und `slippageBpsBase` nach Timeframe, wenn kein expliziter
  Simulator übergeben wurde. `runMultiAssetBacktest` führt den Timeframe in den
  Paper-Optionen mit (`paper.timeframe`), Event-Replay nutzt denselben Fallback.
  Feiner Takt = höhere Kosten = ehrlichere Edge.

### Geändert

- **Paper lange genug für n ≥ 100** (`SAMPLE-N100-01`):
  `RULE_BACKTEST_MIN_BARS` 40 → 100, `JOURNAL_DEFAULTS.minTrades` 20 → 100,
  `POLICY_BODY.backtestMinTrades` 30 → 100, `paperMinTrades` 20 → 100,
  `driftMinSample` 20 → 100. Begründung: <20 Trades = Münzwurf, n≥100 =
  statistisch belastbar (Wilson, Profit-Faktor). Tests angepasst
  (`tests/ruleBacktest.test.ts`: `oneDip` 70 → 130 Bars, `tests/tradeJournal.test.ts`,
  `tests/strategyLifecycle.*`).
- **Backtest-Engine nutzt Cache**: `src/backtest/engine.ts` baut pro Symbol einen
  `IndicatorCache` und nutzt `snapshotFromCache` mit Spread aus dem Instrument
  (Paper-Pfad). Fallback auf `buildSnapshotFromCandles` wenn kein Cache.
- **Mikro-Executor kennt Spread**: `RollingTimeframeSeries.snapshot(spread)` und
  `MicroExecutor.updateSpread(symbol, spread)` + `spreads`-Map — Spread aus dem
  Orderbook kann jetzt in den Hot-Path fließen.
- **Trusted-Indicators mit spreadPct**: `TrustedReading.spreadPct` + Param in
  `readingFromCandles(spread)`, Payload enthält das Feld (LLM sieht es als
  Messwert, nicht als erfundene Zahl).
- **Sentiment-API fail-soft**: `listSentimentForecasts` fängt DB-Fehler und liefert
  `[]` statt 500 — Route bleibt lesbar ohne DB (Test `sentiment.api.test.ts`).
- **Audit-Reliability Fake-DB**: `tests/auditReliability.test.ts` behandelt
  `promptArtifacts` korrekt (select → [], insert → valides Artefakt), damit
  `missedAuditCount` nicht doppelt zählt (2 → 1 bzw. 1 → 0).
- **Mission-Template-Test**: `guardrail-stress-test` liegt bewusst an den Deckeln
  (0,05/0,5) und löst 75-%-Warnung aus — Test erlaubt jetzt Deckel-Warnungen nur
  für dieses Template.

### Behoben

- **6 rote Tests grün** (Vollsuite `npm test` 3605 Tests: 3569 pass, 0 fail, 36 skipped):
  - `auditReliability`: Prompt-Update trotz Totalverlust (missed count 2→1) und
    Spool-Reserve (1→0) — Fake-DB fix.
  - `missionTemplates`: guardrail-stress-test mit erlaubter Deckel-Warnung.
  - `sentiment.api`: 500 → 200 mit leerer Liste ohne DB.
  - `backtest.replay`: Performance-Deckel 15–20 s → 0,6 s via Cache.
  - `ruleBacktest` (5 Tests) und `tradeJournal`/`strategyLifecycle` nach
    n≥100-Anhebung.
  - `monitor.exits` DB-Skip: `skipWithoutDb` return + early return statt
    weiterlaufen nach `t.skip()` (verhinderte „not ok # SKIP“).

### Nicht gebaut (bewusst, Begründung im Audit 2026-09-24)

Shorts (`RULE_ALLOWED_SIDE = "LONG"` bleibt Risikoentscheidung), 1m-Backfill als
Sync-Default (Request-Sturm), `bookDepthUsd` als Regelfeld (Orderbuch-Qualität je
Venue noch ohne belastbare Grenze), Limit-/Stop-Markt/OCO am Broker (gehört in
`src/execution`).

## [0.2.0] — 2026-09-23 · Adapter-Prüfung, Prompt-Budget, vwapPct, 1m-Timeframe

> **Status: Beta.** Prüfung aus
> [Adapter, Parallelität, Daytrading 2026-09-24](docs/audits/2026-09-24-internal-adapter-daytrading/README.md).
> `backtestRule` bleibt unverändert, der Engine-Default bleibt `"legacy"`,
> keine neue API-Route, keine neuen Datenadapter (Begründung im Audit).

### Hinzugefügt

- **Prompt-Budget-Planung der Analysten** (`CYCLE-BATCH-01`,
  `src/cycle/promptBudget.ts`): der Technical Step misst seinen Prompt mit
  derselben Baufunktion, die der Agent-Port sendet, und zerfällt bei Bedarf in
  deterministisch gepackte Batches. Der Grund ist Korrektheit, nicht
  Geschwindigkeit: Bei 40 Kandidaten mass der Einzelaufruf **92 449 Zeichen
  (~25 700 Tokens) gegen `OLLAMA_NUM_CTX=4096` und `LLM_MAX_TOKENS=512`** —
  Antwort abgeschnitten, JSON unvollständig, der Lauf endete mit
  `NEUTRAL`/Score 50 für **alle** 40 Kandidaten. Jetzt: 10 Aufrufe
  à ≤ 1 650 Tokens und ≤ 4 Analysen, Merge in Eingabereihenfolge.
- **News-Schritt genauso geplant** (`05-news-analyst`): 40 Instrumente mit
  120 Headlines bauten **31 594 Zeichen ≈ 8 800 Tokens** gegen ein 4 096er
  Fenster — dieselbe Abschneide-Kette, Ergebnis war ABSTAIN für alle („ruhige
  Nachrichtenlage"). Headline ohne Symbolbezug steht jetzt in JEDEM Batch
  (sonst übersieht ein Batch die Markt-Krise), das systemische Risiko wird über
  die Batches nach **Schwere** gemerged (MAX, nicht Mehrheitsvotum), und die
  Injection-Hülle ist unverändert: der fremde Text bleibt in `untrustedData`
  (Nachweis im Test).
- **Nebenläufigkeit mit Sinn** (`CYCLE_ANALYST_CONCURRENCY`): Default 1 bei
  lokaler Inferenz (ein Slot — Parallelität wäre nur Warteschlange), 2 bei
  `openai`/`gemini`/`anthropic`; `mapBounded` hält die Ergebnisreihenfolge und
  das Limit ein.
- **Regelfeld `vwapPct`** (`CYCLE-DAYTRADE-01`): Kurs gegen den Tages-VWAP in
  Prozent (`sessionVwap`, UTC-Tagesanker, `null` ohne Volumen ⇒ Bedingung
  feuert nicht). Die Referenzgröße des Daytradens fehlte komplett — alle
  bestehenden Felder vergleichen mit Zeitmitteln (EMA), keiner mit dem
  Volumenmittel. Workshop-Feldauswahl übernimmt es automatisch aus dem Katalog.
- **`1m` als Regel-Timeframe**: Whitelist, JSON-Schema,
  `TIMEFRAME_MS` im Mikro-Executor, Workshop-Port. Vorher hätte
  `?? TIMEFRAME_MS["15m"]` eine 1m-Regel **still auf 15 Minuten
  aggregiert** — die Regel wäre auf einem anderen Takt gelaufen, als sie
  unterschrieben hat.
- **Flags** `CYCLE_PROMPT_RESERVE_TOKENS`,
  `CYCLE_PROMPT_INPUT_BUDGET_TOKENS`, `CYCLE_ANALYST_BATCH_SIZE`,
  `CYCLE_ANALYST_CONCURRENCY` (`CONFIGURATION.md`, `.env.example`).

### Geändert

- **Kein stilles Neutral mehr:** Fällt ein Batch aus, überdeckt nur DIESER
  Batch sich selbst, und der Schritt meldet `promptFit.failedBatches` /
  `fallbackInstruments` / `incomplete` im Artefakt statt 40 Nichtaussagen als
  Analyse auszuliefern.
- **Redundanz-Hebel vor Aufteilung:** die Voll-Snapshots der MTF-Konfluenz
  waren 64 % des Prompts und duplicated die kompakte Zeilenform. Sie fliegen
  je Batch einzeln raus (nur wenn DAS Fenster zu klein ist) — im Artefakt
  stehen sie weiterhin vollständig, die Autorität bleibt bei der
  serverseitigen Anhängung.
- **`validateTechnicalOutput` lässt `confluenceMeta` und `promptFit` durch**
  (sanitized, keine Fremdschlüssel). Vorher schluckte die Validierung beide
  Meta-Blöcke im Engine-Handoff — `confluenceMeta` erreichte Research-Schritt
  und Tages-Artefakt nie.

### Gefunden, nicht geändert

- **`changePct24h` ist keine 24-Stunden-Größe.** Die Snapshot-Rechnung bezieht
  die Kerze vor **97 Perioden** — auf `1h` ~4 Tage, auf `5m` ~8 Stunden, auf
  `1m` ~1,6 Stunden. Label und Code-Kommentar sagen das jetzt; die Rechnung
  bleibt, weil jede Korrektur bestehende Regeln und ihre Backtests still
  umwerten würde. Das gehört in eine dokumentierte Snapshot-/Formelversion,
  nicht in einen Nebenbefund (Audit §7.4).

### Nicht gebaut (bewusst, Begründung im Audit)

Yahoo-Adapter (produktiv vorhanden: ALPACA/IBKR/PAPER via
`src/marketdata/adapters/yahoo.ts`), Polygon- und FRED-Adapter,
`RULE_FIELDS`-Erweiterung um ADX/BBW/MACD (seit v0.2.0 da), MACD in
`indicators.ts` (da), Pre-Compute im Technical Step (ist als strengere
Variante da: Code **überschreibt** Modellzahlen), Binomialtest (Wilson reicht),
Shorts im Regelwerk (`RULE_ALLOWED_SIDE = "LONG"` ist eine
Risikoentscheidung, keine Zeile Code).

## [0.2.0] — 2026-09-23 · Kostenwahrheit im Regel-Backtest, Workshop-Schritt 5, Trusted-Indikatoren

> **Status: Beta.** Additiver Schnitt aus dem Audit
> [Verbesserungen 2026-09-23](docs/audits/2026-09-23-verbesserungen-fahrplan/README.md).
> `backtestRule` bleibt byte-identisch. Der Default von `runMultiAssetBacktest`
> bleibt `"legacy"`. Keine neue API-Route.

### Hinzugefügt

- **Paper-Default auf der bestehenden Regel-Backtest-Route**
  (`POST /api/firm/rules/[id]/backtest`): Gebühren, Spread, Slippage und
  Funding über den Fill-Simulator, Kerzen nur aus dem Historical Store.
  Fehlende Historie ist 422, ohne stilles Yahoo. `model=reference` behält
  den gebührenfreien Altpfad (VBF-P1-01).
- **Workshop-Schritt 5** prüft eine Regel und speichert sie nur als `DRAFT`.
  `activate` wird nicht gesendet (VBF-P1-02).
- **Trusted-Block:** RSI(14), ATR(14) und MACD kommen aus
  `src/lib/indicators.ts` und überschreiben Modellzahlen. Ist die Konfluenz
  aus, bleibt die Herkunft `trusted-indicators@1` (VBF-P2-01).
- **Regelfelder** `macd`, `macdSignal`, `macdHist` plus `adx14` und `bbwPct`
  in der Whitelist, mit Ceiling (VBF-P2-02).
- **Wilson-95-%-Intervall** der Trefferquote (`src/lib/stats.ts`) und
  Warnung ab 2000 Prompt-Zeichen. Speichern bleibt bis 8000 möglich
  (VBF-P2-03).
- **Warnung** ab 75 % des Positionsdeckels. Abgelehnt wird nur der Deckel
  selbst (VBF-P3-02).
- **Rohantwort in den Prompt-Editor**, ohne automatisches Speichern
  (VBF-P3-03).
- **Paritätstest** `detectExit` gegen `detectExitTrigger`. Die Funktionen
  werden nicht zusammengelegt (VBF-P3-01).

### Behoben

- **Regel-Backtest findet Store-Reihen.** Das Regel-Symbol (`BTC/USDT`) ist nicht
  die Store-ID (`BITUNIX:BTCUSDT`). Der Paper-Pfad nimmt eine explizite
  `instrumentId` oder genau eine passende Reihe. Mehrdeutigkeit ist 422, kein
  stiller Tausch und kein Yahoo.

### Geändert

- Handbuch (Kapitel 2.3, 6, 15.4, 19.1), `docs/MISSIONS.md`,
  `docs/BACKTESTING.md` und `docs/help/workshop.help.json` beschreiben die
  fünf Workshop-Schritte und den Paper-Default der bestehenden Route.

### Nicht enthalten

- Kein K-Fold, kein Ulcer-Index, kein Regime-Regelfeld, kein Binomialtest,
  keine Prompt-Historie, keine neuen Daten-Adapter (Polygon, FRED, Finnhub,
  Alpha Vantage), kein stilles Yahoo auf dem Paper-Pfad, kein Wechsel des
  Engine-Defaults, kein Ersatz von `detectExit`.

## [0.1.0] — 2026-09-23 · Beta-Baseline: Re-Versionierung, Struktur-Reorganisation, Dokumentationskonsolidierung

> **Status: Beta.** Erstes öffentliches Release unter dem v0.x.x-Schema.
> Enthält den vollständigen Funktionsstand der bisherigen Beta-Entwicklung
> (interne Zählung bis v1.73.1) plus die nachfolgende Überarbeitung.

### Hinzugefügt

- **`VERSION.md`:** kanonische Versions-Metadaten (Version, Datum, Status Beta,
  Komponenten- und API-Übersicht, Versionsregel).
- **`CONTRIBUTING.md`:** Beitrags-Leitfaden (Pflicht-Checks, Konventionen,
  Audit-/Doku-Sync-Pflichten, Beta-Hinweise).
- **Prominenter Beta-Disclaimer im Root-`README.md`** (erste Zeile, vor allem
  übrigen Inhalt) sowie in `package.json`, `VERSION.md` und diesem Changelog.
- **Header-Kommentare in allen Quelldateien** (`src/`, `scripts/`): Zweck,
  Verantwortung und Abhängigkeiten je Datei; JSDoc-Ergänzungen in den
  kernkritischen Modulen (Execution, Risk, Live-Gate, Scanner, Portfolio,
  Market Data).

### Geändert

- **Versionierung neu etabliert:** `package.json` auf `0.1.0` (Beta-Baseline);
  alle „aktuellen“ Versionsverweise in der Dokumentation auf `v0.1.0`
  umgestellt. Historische Verweise auf die alte Zählung `v1.x.x` bleiben in
  Archiv-/Audit-Dokumenten erhalten und werden über die
  [Versions-Zuordnung](#versionszuordnung-v0xx--v1xx) lesbar gemacht.
- **Repository-Struktur konsolidiert:**
  - Doppeltes Testverzeichnis `test/` in `tests/` **zusammengeführt**
    (`tests/marketdata/`, `tests/integration/`, `tests/ops/`, `tests/ui/`,
    `tests/fixtures/bitunix/`); npm-Test-Skripte angepasst.
  - Veraltetes Template-File `.ignore` entfernt (kontradiktorisch zu
    `.gitignore`: es ignorierte versionierte Verzeichnisse wie `tests/`
    und `scripts/`).
  - Kanonische Root-Dokumente unverändert: `README.md`, `CHANGELOG.md`,
    `INSTALL.md` (Wrapper), `CONFIGURATION.md` (Flag-Referenz).
- **Altes Changelog archiviert:** die detaillierte Historie der
  Beta-Entwicklung (v1.40.0–v1.73.1) liegt jetzt unter
  [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md)
  (unverändert, mit Archiv-Header).

### Behoben

- **Dokumentationsinkonsistenzen:** `docs/REPOSITORY_STRUCTURE.md` beschreibt
  jetzt die konsolidierte Struktur (einzige `tests/`-Datei-Quelle, keine
  `.ignore`); der Docs-Index (`docs/README.md`) dokumentiert das
  v0.x.x-Versionschema und die Zuordnung zur Legacy-Zählung.
- **README-Dokumentationsstand:** alle Status-Header zeigen jetzt `v0.1.0 (Beta)`.

### Kompatibilität

- **Keine Änderung des Laufzeitverhaltens** durch dieses Release: es betrifft
  Versionierung, Struktur (Testpfade) und Dokumentation. Alle Features der
  Beta-Entwicklung (Meilensteine unten) bleiben unverändert.
- Testpfade: Skripte in `package.json` referenzieren jetzt ausschließlich
  `tests/**`; eigene CI-/Befehlszeilen-Aufrufe, die `test/…` nutzten, sind
  entsprechend anzupassen.

---

## v0 — Beta-Meilensteine

Zusammenfassung der Beta-Entwicklung. Die **vollständigen, detailgetreuen
Einträge** (mit Formeln, Migrations- und Rollback-Runbooks, Testmatrizen) stehen
im Archiv: [`docs/archive/CHANGELOG-legacy-v1.md`](docs/archive/CHANGELOG-legacy-v1.md).
Klammer: interne Legacy-Nummer, auf die sich ältere Dokumente und Audit-Reports
beziehen (siehe [Versions-Zuordnung](#versionszuordnung-v0xx--v1xx)).

### Phase 1 — Fundament, Agenten-Zyklus & Paper-Trading (Frühe Beta, v1.0.0–v1.39.x)

- Autonome **Agenten-Firma**: CEO, Research, Technical-, News- und
  Macro-Analyst, Risk Manager, Portfolio Engine, Approver und Executor als
  getrennte, versionierte Schritte des Daily-/Weekly-Cycle (`src/cycle/`).
- **Deterministischer Market Scanner** (Liquidität/Volatilität/Korrelation,
  15+ Faktoren) mit Market-Universe-Registry (354 Preset-Instrumente) und
  point-in-time Historical Store (append-only OHLCV, `src/marketdata/`).
- **Paper-Broker mit realistischer Execution-Simulation** (Gebühren, Spread,
  Slippage, Partial Fills) und serverseitigem Exit-Management (Stop-Loss,
  Take-Profit, Trailing-Stop, Time-Stop, OCO-Exklusivität, Funding-Accrual).
- **Portfolio-Engine & Analytics** (Task 05, `src/portfolio/`): Formelkatalog
  (Sharpe/Sortino/Drawdown/Kalmar), Kovarianz-/Korrelations-Cluster,
  Optimizer mit Guard-Kette — Details in `docs/PORTFOLIO_ANALYTICS.md`.
- **Abstrakte LLM-Provider-Schicht** (Ollama, OpenAI-kompatible Endpunkte,
  Gemini, Claude) mit Model-Router, Routing-Overrides, Turn-Budgets und
  Prompt-Versionierung (`src/routing/`, `src/promptPerformance/`).
- **PostgreSQL als institutionelles Gedächtnis** (Drizzle, append-only
  Migrations), Audit-Trail mit Retry/Spool (sicherheitskritische Schreibvorgänge
  at-least-once, fail-closed), RBAC (Admin/Operator/Viewer), Session-Login.
- **Security-Härtung (Legacy v1.36.x):** Auth-Modus `local-open` /
  `token-required` mit Boot-Guard, unabhängiger `FIRM_SESSION_SECRET`
  (SEC-01), geschützte Dashboard-Reads (SEC-02), gepinnte Next.js/ws-Versionen
  (SEC-03/SEC-04), Rule-Governance mit RBAC (SEC-05/06), Environment-/
  Credential-Hygiene (SEC-07/09), Session-Revocation (SEC-08),
  Rate-Limits ohne Client-Header-Identität, Kill-Switch mit
  admin-only + CSRF + single-use-Nonce-Disarm, Live-Gate als harte
  Freigabeschicht für jeden Live-Pfad.

### Phase 2 — Backtesting, Forschung & Datenqualität (v1.40.0–v1.53.0)

- **Market-Sync-Fixes & Multi-Venue-Sync** (alle 6 Venues: Bitunix, Binance,
  Kraken, Alpaca, IBKR, Paper; gemeinsame `SyncHttpClient` mit
  Fehlerklassifizierung) *(v1.40.0, v1.59.0)*.
- **Feature-Gap-Audit 2026-09-18** (GAP-01…GAP-10) als Audit-Zyklus mit
  ausführbarer Prompt-Serie *(v1.41.0)*.
- **Multi-Asset Event-Driven Backtest-Engine** mit Walk-Forward-Fenstern,
  Kostenmodellen und persistierten Runs *(v1.42.0)*; Funding-Kosten im
  Paper-PnL + kalibrierbare Execution-Simulation *(v1.42.0)*.
- **Trade-Journal mit Agenten-Attribution** (append-only, MAE/MFE, begrenzte
  Gewichts-Rückführung, Default off) *(v1.43.0)*.
- **Server-seitiges Exit-Management** (Trailing/Time-Stop, OCO-Exklusivität
  als atomarer DB-Claim) *(v1.44.0)*.
- **Observability:** Firmen-Metriken, Auto-Circuit-Breaker (Drawdown/
  Tagesverlust/Verlustserie), Alert-Sinks, Heartbeat & Watchdog *(v1.45.0)*.
- **Markt-Regime-Klassifikator + Regime-Gate** für Strategie-Gewichtung
  (deterministisch, monitor-first) *(v1.46.0)*.
- **Datenqualitäts-Layer** (Gap/Outlier/Invalid/Duplicate/Cross-Check,
  deterministische Multi-TF-Aggregation, Stale-Guards) *(v1.47.0)*.
- **ATR-/Vol-basiertes Position-Sizing** + Korrelations-Cluster-Exposure-
  Limits im Order-Pfad (Fractional-Kelly-Deckel, monitor-first) *(v1.48.0)*.
- **LLM-Plausibilitäts-Schicht**, Prompt-Eval-Harness, Turn-Budget-Hartdeckel
  *(v1.49.0)*; **Reconciliation-Job** mit Differenz-Klassifikation und
  idempotenten Order-IDs *(v1.50.0)*.
- **Regelbasierte Backtesting-Engine** (GAP-01: Walk-Forward, Paper-Ausführung
  durch dieselbe `FillSimulator`-Klasse, fail-closed statt synthetischer
  Fallback) *(v1.51.0)*; Test- und Audit-Nachträge *(v1.51.1–v1.51.3)*.
- **25-Punkte-Roadmap-Audit 2026-09-20** mit 21 Remediation-Prompts
  *(v1.51.3)*; **persistente Backtest-Trades** als Trade-Level-Wahrheitsquelle
  *(v1.52.0)*; **Point-in-Time Feature Store** *(v1.53.0)*.

### Phase 3 — Perpetual-Daten, Forecasts, Attribution (v1.54.0–v1.59.0)

- **Historische Perpetual-Daten** (Funding, Open Interest, Liquidationen;
  as-of-Queries, Qualitäts-Layer, Sync-CLI) *(v1.54.0)*.
- **Forecast-Ledger** mit Brier-Score, Kalibrierung und idempotentem Resolver
  *(v1.55.0)*.
- **Venueübergreifendes Execution-Benchmarking** (append-only Quality-Ledger,
  echte Fill-Fakten, bounded Read-API) *(v1.56.0)*.
- **Deterministische Trade-PnL-Attribution** (Quellenbeiträge + Kosten +
  Residual = realisiertes Netto-PnL; immutable Entry-Snapshots v2) *(v1.57.0)*.
- **Event-Replay mit realistischen Friktionen** (Latenz, Depth, Impact,
  Funding, kein Look-ahead) *(v1.58.0)*.

### Phase 4 — Walk-Forward, Regime & Konfluenz (v1.60.0–v1.64.0)

- **Train-Select-Freeze-Test Walk-Forward** (Candidate-Vertrag, IS-Selektor,
  Freeze-Artefakte, Leakage-Protection, Holdout) *(v1.60.0)*.
- **Mehrdimensionale Regime-Erkennung** (point-in-time-sicher, Persistenz,
  Evaluation) *(v1.61.0)*.
- **Deterministische Multi-Timeframe-Konfluenz** (15m/1h/4h, fail-closed,
  Trusted-Data für die Analysten) *(v1.62.0)*.
- **Point-in-Time Cross-Sectional Momentum Ranking** *(v1.63.0)*.
- **Kalibrierbare strukturierte Sentiment-Outputs** (NEUTRAL vs. ABSTAIN,
  Syndikations-Deduplikation, Forecast-Envelope) *(v1.64.0)*.

### Phase 5 — Research, Execution & Risiko-Tiefen (v1.65.0–v1.73.1)

- **Prompt-Performance & Version-Metrikvergleich** (Brier/LogLoss/ECE/
  Attribution, gated Version-Vergleiche) *(v1.65.0)*.
- **Strukturierter Devil’s-Advocate-Agent** (adversale Falsifikation,
  fail-closed Abstention, nur defensive Risiko-Wirkung) *(v1.66.0)*.
- **Portfolio-Volatility-Targeting** (as-of-sichere Forecast-Volatilität,
  Multiplikator hart ≤ 1, Live & Backtest teilen den pure Kern) *(v1.67.0)*.
- **Hysteretisches Drawdown-Risk-Scaling** (Cashflow-bereinigter HWM,
  Sofort-Degradation, bestätigte Erholung, PAUSE-Veto) *(v1.68.0)*.
- **Versionierte Signal-Decay-Exits** (Entry-Snapshot vs. Current-Signal,
  default-off je Klasse, Safety-Exits vorrangig) *(v1.69.0)*.
- **Post-Only-Ausführung mit Market-Fallback** (versionierte Maker-Policy,
  bounded Repricing, idempotente Workflow-Keys, Paper-Simulation) *(v1.70.0)*.
- **TWAP- und Depth-aware Execution** (Parent/Child-Scheduler, Depth-Gates,
  kein Market-Chase) *(v1.71.0)*.
- **Reproduzierbare Monte-Carlo-/Trade-Resampling-Analyse** (IID/Block/
  Stationary-Bootstrap, Kostenstress, Ruin-Wahrscheinlichkeit) *(v1.72.0)*.
- **Strategy-Lifecycle mit Driftgates** (9-Zustands-Machine, immutables
  Evidence, Backtest↔Paper↔Live, Order-Gate) *(v1.73.0)*.
- **Roadmap-Audit-Closure:** 25-Punkte-Audit vollständig abgeschlossen
  (4 VERIFIED + 21 FIXED, 0 OPEN) *(v1.73.1)*.

---

## Versions-Zuordnung: v0.x.x ↔ v1.x.x

Das öffentliche v0.x.x-Schema beginnt am **2026-09-23** mit `v0.1.0`, das den
vollständigen Stand der internen Zählung `v1.73.1` (einschließlich aller
davor dokumentierten Beta-Releases) überträgt. Ältere Dokumente, Audit-Reports
und Archiv-Einträge nennen weiterhin die Legacy-Nummern; sie sind über diese
Zuordnung lesbar:

| Öffentlich (v0.x.x) | Intern (Legacy, v1.x.x) | Datum | Bedeutung |
| --- | --- | --- | --- |
| **v0.2.0** (Beta) | — | 2026-09-23 | Regel-Backtest mit Paper-Kosten, Workshop-Schritt 5, Trusted-Indikatoren |
| **v0.1.0** (Beta) | v1.73.1 | 2026-09-23 | Beta-Baseline: vollständiger Funktionsstand + Re-Versionierung/Struktur/Doku |

Legacy-Verweise auf `v1.40.0` … `v1.73.0` in Audits, Peers-Reviews und der
Dokumentation bezeichnen die jeweiligen Beta-Stände der Tabelle oben
(detailliert im Archiv-Changelog). Es gibt **keine** öffentliche Version `1.x` —
die Legacy-Zählung ist rein historisch.
