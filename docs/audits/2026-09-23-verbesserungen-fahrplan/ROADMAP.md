# Implementierungs-Fahrplan — Strategie, Workshop, Datenquellen

> **Abschluss:** Dieser Fahrplan ist in `v0.2.0` geschlossen. Status nur in
> [`remediation/TRACKING.md`](remediation/TRACKING.md). Der Text darunter
> ist die Prüfung vom 2026-09-23 und wird nicht umgeschrieben.

**Prüfung:** 2026-09-23, Commit `ba772cc`, Produktversion damals `v0.1.0`
(interne Legacy-Zählung bis `v1.73.1`).
**Methode:** statischer Abgleich des Big-Pickle-Audits vom 2026-09-20 gegen
den aktuellen Code. Kein `npm test`, kein Venue-Zugriff. Zeilenangaben sind
der Stand dieses Checkouts.
**SSoT-Status:** [`remediation/TRACKING.md`](remediation/TRACKING.md).

Der Audit ist als Arbeitsauftrag nützlich und als Inventur veraltet. Er
beschreibt Lücken, die GAP-01…10 und der Roadmap-Zyklus bis v1.73.0 bereits
geschlossen oder durch eine strengere Architektur ersetzt haben. Wer die
Audit-Reihenfolge O1 → W1 → O2 → O3/O4 → Datenquellen abarbeitet, baut
vorhandene Module ein zweites Mal und übersieht die Stelle, an der heute
noch gebührenfreie PnL als Entscheidungsgrundlage entsteht.

---

## 1. Zusammenfassung

| Bereich | Audit-Annahme | Ist-Stand | Konsequenz |
|---------|---------------|-----------|------------|
| O1 Indikatoren in der Rule Engine | ADX, BBW, MACD fehlen komplett | ADX und Bollinger-Breite existieren und werden benutzt. MACD fehlt. Die Regel-Whitelist kennt sie nicht | Sinnvoll, aber nicht das Fundament |
| O2 TechnicalStep | LLM schätzt RSI/ATR | Stimmt für RSI/ATR. MTF-Konfluenz wird dagegen schon vor dem LLM gerechnet und serverseitig angehängt | Sinnvoll, unabhängig von O1 |
| O3/O4 Exit-Einheit + Kosten | Live und Backtest nutzen verschiedene Exits; Quick-Backtest ohne Kosten | Drei Ausführungspfade plus ein gebührenfreier Quick-Pfad. Walk-Forward erzwingt bereits `paper`. Live-Exit ist reicher als der Kerzen-Trigger | Kosten im Quick-Pfad ja. Naive Vereinheitlichung nein |
| O5 Walk-Forward / K-Fold | Basis-Engine, fehlende Metriken | Train-Select-Freeze, Purge, Embargo, Holdout, Profit-Factor, Expectancy, Calmar | K-Fold nicht bauen |
| O6 Regime in Rules | `regime eq BULL` fehlt | Regime-Gate dämpft das Risikobudget im Code. Andere Labels | Als Rule-Feld schädlich |
| W1 Schritt 5 | Panel fehlt | API und `backtestRule` existieren, UI nicht | Höchster sichtbarer Nutzen, aber erst nach Kosten |
| W2 Statistik | Wilson/Binomial fehlen | JSON-Tipps exakt wie spezifiziert. Wilson liegt im Forecast-Modul | Nur das Intervall übernehmen |
| W3–W5 Workshop-Politur | weitgehend offen | Ceilings, Vorlagen, Optimistic Lock, Rohantwort und Trace sind da | Nur kleine Reste |
| Datenquellen | Yahoo/Polygon/FRED/Finnhub als Stubs | Yahoo, Binance, Kraken, Bitunix, Alpaca/IBKR-via-Yahoo sind produktiv | Keine neuen Gratis-Adapter als Default |
| Arena-Prompts | sechs neue Prompt-Dateien | Zwei abgeschlossene Prompt-Serien (GAP, RMA) | Audit-Prompts nicht 1:1 starten |
| AGENTS.md Abschnitt 7 | drei additive Edits | Die drei Inhalte stehen bereits in Doku und `docs:validate` | Nicht anlegen |

**Verteilung:** 7 erfüllt oder ersetzt · 6 teilweise · 5 offen, davon 2 mit
hohem Nutzen (O4-Rest, W1) und 3 mit eingeschränktem oder bedingtem Nutzen
(O1, O2, W2-Wilson).

### Korrigierte Abhängigkeiten

```text
O4-Rest  Kosten im Quick-Backtest (API + backtestRule)
   └── W1  Workshop-Schritt 5 konsumiert genau diesen Pfad
            und speichert nur DRAFT

O2  Pre-Compute im TechnicalStep     ── unabhängig von O1
O1  MACD + Whitelist-Felder          ── unabhängig von O2 und O4
O3  Paritätstest, kein gemeinsamer Exit-Code
O5, O6, Yahoo, Regime-Gate, Walk-Forward  ── bereits erledigt, blockieren nichts
```

O1 blockiert O2 nicht: der Technical Analyst schreibt in
`TechnicalStepOutput.rsi` / `.atr`, nicht in `RuleSnapshot`. O1 blockiert
O3/O4 nicht: Exits vergleichen Stop und Target mit Kerzen oder Ticks, nicht
mit ADX. O4 blockiert W1, weil ein Panel ohne Kosten die teuerste Fehlentscheidung
des Workshops wäre: eine gebührenfreie Equity-Kurve als Freigabe für `trade_rules`.

---

## 2. Bereits implementiert

### 2.1 Indikatoren, die der Audit als fehlend beschreibt

`src/lib/indicators.ts` ist die deterministische Bibliothek ohne externe
Abhängigkeit.

| Funktion | Zeilen | Verwendung | Audit |
|----------|--------|------------|-------|
| `ema` | 8–18 | Rule-Snapshot, `snapshot()` | vorhanden, korrekt |
| `rsi` (Wilder) | 20–52 | Rule-Snapshot, Feature Store `scanner.rsi` | vorhanden |
| `bollingerBandWidthPct` | 54–77 | Adaptive-Risk-Schwelle `adp.bbwHighPct` in `src/lib/seed.ts` | vorhanden, nicht in `RULE_FIELDS` |
| `adx` (Wilder, null bei `< 2·period+1`) | 109–158 | `marketRegime.ts` Trend-Trigger | vorhanden, nicht in `RULE_FIELDS` |
| `atr` / `atrPct` | 160–189 | Sizing (GAP-04), Feature Store `scanner.atr` | vorhanden |
| `macd` | — | nirgends (`rg macd` leer) | fehlt |

Tests: `tests/indicators.test.ts` deckt BBW (flach, alternierend, zu wenig
Daten) und ADX (Handrechnung, Trend vs. Chop, zu wenig Kerzen) ab.

**Warum das den Audit-Schnitt O1 entwertet:** ADX ist kein ungebautes
Alpha-Signal. Es ist der Trendstärke-Input des Regime-Klassifikators
(`src/lib/marketRegime.ts`, Priorität `CRASH > HIGH_VOL > TREND_* > RANGE`).
BBW ist der Volatilitäts-Trigger des adaptiven Risikos. Beide noch einmal in
die Regel-Whitelist zu kopieren, erweitert die DSL. Es legt nicht das
Fundament für Exits oder den Technical Step.

### 2.2 Rule Engine — Whitelist, die der Audit erweitern will

`RULE_FIELDS` (`src/lib/ruleEngine.ts`, Zeilen 45–59) enthält bereits
`price`, `rsi14`, `ema9`, `ema21`, `ema50`, `trend`, `atrPct`, `volume`,
`volumeMa20`, `volumeRatio`, `changePct24h`, `priceVsEma21Pct`,
`priceVsEma50Pct`.

`buildSnapshotFromCandles` (ab Zeile 566) rechnet diese Felder aus Kerzen,
ohne IO. `accessor` (Zeilen 468–483) ist ein erschöpfender `switch`: ein
neues Feld ohne Case ist ein Typfehler, kein stiller Durchfall.
`sanitizeRuleSpec` verwirft unbekannte Felder. Alte Regeln bleiben lauffähig,
wenn die Whitelist wächst — diese Audit-Mitigation stimmt.

Einheitenfalle, die ein naiver O1-Patch erzeugen würde: `atrPct()` liefert
einen **Anteil** (`0.01 = 1 %`), der Snapshot speichert **Prozent**
(`atrPct(candles) * 100`, Zeile 601). `bollingerBandWidthPct` liefert trotz
des Namens ebenfalls einen Anteil (`0.05 = 5 %`, Kommentar ab Zeile 54).
Das adaptive Risiko vergleicht diesen Anteil mit `bbwHigh` (Default `0.05`,
`src/lib/adaptiveRisk.ts`). Die Dashboard-Beschreibung desselben Keys
(„Eingabe z. B. 5 = 5 %“) widerspricht dem gespeicherten Bruchteil und den
Bounds `[0.002, 0.5]` — eine `5` würde dort auf `0.5` geklemmt. Ein
Rule-Feld darf diese Beschreibung nicht kopieren. Es soll, wie `atrPct` im
Snapshot, **Prozent** speichern, und `RULE_LLM_SCHEMA` muss das sagen.
Sonst vergleicht `bbwPct gt 5` mit `0.05`.

Der Mikro-Executor (`src/lib/microExecutor.ts`, Aufruf von
`buildSnapshotFromCandles` um Zeile 253) bewertet nur diese Whitelist. Neue
Felder sind damit automatisch im Hot-Path, sobald der Snapshot sie setzt.
Das ist machbar und der richtige Ort — aber ein Feature, kein Blocker.

### 2.3 TechnicalStep — halb erledigt, und der erledigte Teil ist der wichtigere

`src/cycle/steps/technicalStep.ts` bittet das Modell weiterhin, RSI und ATR
zu **schätzen** (System-Prompt Zeile 157, „RSI and ATR estimates“). Der
Fallback setzt `rsi: 50` (Zeile 135) und erfundene Key-Levels `0`.
`researchStep.ts` schreibt `techOutput.analyses` in den User-Prompt
(Zeile 139) und baut den deterministischen Fallback-Entry aus
`keyLevels.support` (Zeile 103), nicht aus gerechnetem ATR.

Dagegen ist RMA-P2-03 umgesetzt: vor dem LLM-Call lädt der Step einen
MTF-Konfluenz-Batch aus dem `HistoricalStore`, übergibt ihn als `trustedData`
und hängt `analysis.confluence` **nach** der Schema-Validierung an. Das Modell
kann die Zahlen nicht überschreiben. Das ist genau das Muster, das O2 für
RSI/ATR/ADX wiederverwenden sollte — nicht ein zweiter Prompt-Abschnitt, den
das Modell „exakt nutzen“ soll und dann doch halluziniert.

GAP-08 (`src/cycle/plausibility.ts`, verdrahtet in `researchStep.ts`) fängt
Preisband- und Monotonie-Fehler. Es prüft nicht, ob `rsi: 54.2` zur Kerzenreihe
gehört. Deshalb bleibt O2 sinnvoll. Es ist aber kein Neubau der Konfluenz.

### 2.4 Exits — vier Pfade, nicht zwei

Der Audit behauptet, der Live-Monitor nutze `detectExitTrigger` aus
`paperExecution.ts`. Das ist falsch.

| Pfad | Trigger | Fill / Kosten | Wo |
|------|---------|---------------|----|
| Live-Monitor | `decideExit` auf **einem** Kurs: SL, TP, Trailing, Time-Stop, danach Signal-Decay. OCO über `UPDATE … WHERE status='OPEN'` | Broker-Fill, Funding über `runFundingAccrual` | `src/lib/exits.ts`, `src/lib/monitor.ts` |
| Backtest `paper` | `detectExitTrigger` auf Kerzen-High/Low, Stop vor TP | derselbe `FillSimulator` wie der PaperBroker, Funding über `FundingAccrualEngine` | `src/backtest/paperExecution.ts`, Engine ab Zeile 347 |
| Backtest `legacy` (Engine-Default) | `evaluateExit` | eigenes Slippage-/Fee-Modell, eingefroren | `src/backtest/simulator.ts`, `DEFAULT_BACKTEST_CONFIG.executionModel` Zeile 90 |
| Backtest `event_replay` | Order-Lifecycle, Latenz, Depth | Replay-Runtime | `src/backtest/replayExecution.ts` |
| Quick-Backtest | High/Low inline, nur `STOP_LOSS` / `TAKE_PROFIT` | **keine** Fees, Slippage, Funding | `backtestRule`, `src/lib/ruleEngine.ts` ab Zeile 674 |

Walk-Forward setzt `executionModel` auf `paper`, außer der Aufrufer verlangt
`event_replay` (`src/backtest/walkforward.ts`, um Zeile 829). Signal-Decay
im Backtest ruft dieselbe `decideExit`-Funktion wie der Monitor
(`src/backtest/signalDecay.ts`) — aber nur für den Decay-Grund, und die
Engine schaltet Trailing und Time-Stop in diesem Lauf explizit aus.

**Warum „ein Exit-Code für beide Modi“ nicht sinnvoll ist:**

- Live sieht einen Tick-Preis, der Backtest eine Kerze. `decideExit` kann
  Intra-Bar-Kollisionen nicht sehen. `detectExitTrigger` kann Trailing und
  Time-Stop nicht sehen, weil die Kerze kein Pfad ist.
- Live hat eine DB-OCO-Garantie. Die in den Backtest zu ziehen, würde den
  deterministischen Lauf an Postgres binden.
- Der Paper-Fill-Simulator ist bereits der gemeinsame **Kosten**-Pfad von
  Paper-Broker und Walk-Forward. Das war das eigentliche GAP-01-Ziel und ist
  erfüllt (`docs/BACKTESTING.md`).
- Den Engine-Default von `legacy` auf `paper` zu drehen, bricht die
  dokumentierte Byte-Kompatibilität bestehender Läufe. Walk-Forward braucht
  das nicht mehr.

Was fehlt, ist nicht die Vereinheitlichung, sondern der Quick-Pfad: die
Route, die ein Mensch vor dem Aktivieren einer Regel sieht.

### 2.5 Walk-Forward, Metriken, Lifecycle

`src/backtest/walkforward.ts` (1082 Zeilen) implementiert rollierende
IS/OOS-Fenster, Train-Select-Freeze, Purge (`filterCandlesWithLeakageProtection`),
Embargo, Holdout und harte IS-Gates auf Trades, Win-Rate, Sharpe, Profit-Factor
und Drawdown. Selektion kann `profitFactor` und `expectancy` als Ziel nutzen.

`src/backtest/metrics.ts` liefert Sharpe, Sortino, Max-Drawdown, Profit-Factor,
Expectancy, Calmar (`CAGR / MaxDD`), Fees, Slippage, Funding. `ulcerIndex` und
`recoveryFactor` kommen im Repo nicht vor. Calmar ist die vorhandene
Erholungs-Kennzahl. Ein Ulcer-Index misst Drawdown-Schmerz anders, ändert aber
keine Promotion-Entscheidung, solange die Lifecycle-Policy ihn nicht kennt.

`src/strategyLifecycle/` (RMA-P1-05, v1.73.0) ist die Drift-Schicht zwischen
Backtest, Paper und Live: kein `DRAFT → LIVE`, Evidence-Hashes, fail-closed
bei fehlender Stichprobe. Das ersetzt nicht die Exit-Parität. Es macht eine
zweite, parallele „Live vs. Backtest“-Vereinheitlichung im Workshop überflüssig.

### 2.6 Regime — das Gate ist die richtige Schicht

`MarketRegime` ist `TREND_UP | TREND_DOWN | RANGE | HIGH_VOL | CRASH`, plus
`UNKNOWN` (`src/lib/marketRegime.ts`, Zeile 85). Das ist nicht
`BULL | BEAR | SIDEWAYS | VOLATILE`.

`applyRegimeGate` skaliert das Signalgewicht nach Strategieklasse. Der
Modulkommentar nennt das ausdrücklich einen Datenkontext, kein hartes Veto.
Default-Modus ist `monitor` (Faktor wird ausgewiesen, wirkt nicht). Erst
`enforce` multipliziert das Budget, im Mikro-Executor ab Zeile 745
(`resolveRegimeGateForExecution`) und in `src/lib/engine.ts`. Die
Default-Faktoren dämpfen nur (`0.5`) oder bleiben `1`. Die Bounds `[0, 2]`
erlauben per `REGIME_GATE_FACTORS` auch `0` — das ist ein Operator-Override,
keine fehlende Regelbedingung. Hysterese verhindert Whipsaw. Snapshots
landen in `regime_snapshots`.

Eine Regel `regime eq BULL` würde diese Schicht umgehen: das LLM könnte eine
Bedingung schreiben, die das Gate nicht sieht, oder eine, die ihm widerspricht.
Unbekannte Enums fallen heute durch die Whitelist — das ist der Schutz.
`sanitizeRuleSpec` würde ein neues Enum-Feld akzeptieren, sobald es in
`RULE_FIELDS` steht. Deshalb ist O6 als spezifiziert nicht sinnvoll.

### 2.7 Workshop — vier Schritte, die der Audit als drei Lücken beschreibt

`WorkshopTab.tsx` hat die Schritte Mission, Agent-Lauf, Prompt, Trefferquote.
Kein `RuleBacktestPanel`.

| Audit-Punkt | Ist | Beleg |
|-------------|-----|-------|
| W1 Panel + Export | UI fehlt. `POST /api/firm/rules` legt `DRAFT` an. `POST /api/firm/rules/[id]/backtest` ruft `backtestRule` | `src/app/api/firm/rules/[id]/backtest/route.ts` |
| W2 JSON-Tipps ab 2 Fällen und 20 % | exakt so | `JSON_TIPS_MIN_COUNT`, `JSON_TIPS_MIN_SHARE`, `JSON_DEBUG_TIPS` in `src/lib/workshop.ts`; Banner in `HitRatePanel.tsx` |
| W2 Wilson / Binomial / n≥30 | nicht im Workshop. Wilson existiert in `src/forecasts/scoring.ts` (`wilsonInterval`) | UI-Maximum ist 20 Läufe (`MAX_RUNS`) — n≥30 ist in dieser Oberfläche unerreichbar |
| W2 KILLED filtern | erledigt | `HitRatePanel.tsx` Zeile 57, ebenso `AgentRunPanel.tsx` Zeile 67 |
| W3 `LIMIT_CEILINGS` | harte Ablehnung, nicht nur Warnung | `validateMissionInput`, `src/lib/workshop.ts` Zeilen 211–231 |
| W3 Segment-Vorlagen | `MissionTemplatePicker`, `MISSION_SEGMENTS` | `MissionsPanel.tsx` |
| W3 75 % des Ceilings | keine Warnung | — |
| W4 Optimistic Lock | `expectedVersion`, 409 verwirft den Entwurf | `PromptPanel.tsx`, Schema `agents.version` |
| W4 Verlauf, Diff, Rollback | keine Prompt-Historientabelle. `prompt_artifacts` speichert ab v1.65.0 neue Versionen, die UI zeigt sie nicht | `src/db/schema.ts` `promptArtifacts` |
| W4 Warnung > 2000 Zeichen | harte Grenze 8000, keine 2000er-Warnung | `PROMPT_LIMITS` |
| W5 Rohantwort + Trace | Turn-JSON, `rawResponse` der letzten Nachrichten, Trace-Liste ohne Zeiten | `AgentRunPanel.tsx` |
| W5 Copy-to-Prompt | fehlt | — |

Zusätzlich, vom Audit nicht gesehen: Prompt-Metrikvergleich
(`GET /api/firm/prompts/compare`, `docs/PROMPT_PERFORMANCE.md`) ist die
belastbare Versionsauswertung. Ein Diff-Panel ohne diese Metriken wäre Kosmetik.

### 2.8 Datenquellen — Yahoo ist kein Stub

Produktiv registriert in `src/marketdata/registerAdapters.ts`:

- `BITUNIX` über den Public-Client, Capability aus der Broker-Matrix
- `BINANCE`, `KRAKEN` credential-frei, Token-Bucket je Host
- `ALPACA` und `IBKR` über Yahoo-Chart
- `PAPER` als Binance- plus Yahoo-Bein

`src/marketdata/adapters/yahoo.ts`: Chart-API `query1.finance.yahoo.com`,
User-Agent, Rate **2/s** (nicht 5/s wie im Audit), Timeframes `1m`, `5m`,
`15m`, `30m`, `1h`, `1d`, `5d`. `3m`, `2h`, `4h` sind dokumentierte Lücken
(`YAHOO_TIMEFRAME_MAP`), kein stilles Resampling. Index-Map inklusive `^VIX`.
SSRF-Allowlist: `PAPER_FEED_ALLOWED_HOSTS` in `src/lib/marketdata/config.ts`.

Nicht vorhanden und nicht als halbfertige Datei liegend: `polygon.ts`,
`fred.ts`, `finnhub.ts`, Alpha Vantage.

VIX fürs Regime kommt aus dem adaptiven Risikozustand
(`src/lib/regimeFamilyInputs.ts`), nicht aus FRED. Perpetual-Funding,
Open Interest und Liquidationen haben einen eigenen, as-of-sicheren Store
(`src/perpdata/`, Bitunix-Adapter). Ein FRED-Adapter für CPI/GDP würde diese
Pipeline nicht füttern.

### 2.9 Arena-Prompts und die drei AGENTS.md-Edits

Die Prompt-Serien
[`docs/audits/2026-09-18-feature-gap/prompts/`](../2026-09-18-feature-gap/prompts/README.md)
und
[`docs/audits/2026-09-20-roadmap-audit/prompts/`](../2026-09-20-roadmap-audit/prompts/README.md)
sind abgearbeitet (GAP alle FIXED, Roadmap CLOSED v1.73.0). Die sechs
Audit-Prompts existieren nicht als Dateien. Sie enthalten Anweisungen, die
heute falsch wären: Paper als Engine-Default, Live auf `detectExitTrigger`
umbiegen, Binomial gegen 50 % TRADE, Polygon-WebSocket als Abnahmekriterium.

Abschnitt 7 des Audits:

1. `PAPER_MODE_C_ENABLED` steht in `docs/PAPER_TRADING.md` (Boot verweigert
   Modus C ohne das Flag).
2. Der Spiegel `docs/ci/*.workflow.yml` ↔ `.github/workflows/` ist in
   `docs/ci/README.md` beschrieben und vom Job `docs-validate` byte-identisch
   erzwungen.
3. `docs/help/*.help.json` wird in `scripts/docs-validate.ts` gegen
   `help.schema.json` geprüft.

`AGENTS.md` existiert nicht. Eine neue Datei nur für diese drei Hinweise
würde eine zweite Wahrheit neben der Doku erzeugen.

---

## 3. Priorität 1 — Kostenwahrheit, dann Workshop-Export

Das sind die beiden Änderungen mit direktem Einfluss darauf, ob eine Regel
aktiviert wird. Alles andere verbessert Signale oder Kosmetik.

### 3.1 O4-Rest — Quick-Backtest mit dem Paper-Kostenpfad

**Warum jetzt:** `POST /api/firm/rules/[id]/backtest` ist der einzige
HTTP-Backtest einer einzelnen Regel. Er ruft `backtestRule` auf: Einstieg zum
Schlusskurs, Ausstieg zum Stop- oder Zielpreis, Stückzahl aus
`riskAdjustedSize`, PnL ohne Fee, Slippage und Funding. Eine Regel mit
enger Stop-Distanz und vielen Trades sieht hier systematisch besser aus als
im Walk-Forward, der Fees bucht. Der Strategy-Lifecycle verlangt für die
Promotion einen Walk-Forward-Run — der Workshop-Nutzer sieht aber zuerst die
gebührenfreie Zahl und wird sie für die Wahrheit halten.

**Warum nicht der Audit-Schnitt:** `executionModel: "paper"` ist für neue
Walk-Forward-Läufe schon der Default. Den Engine-Default umzulegen, ändert
alte Artefakte und löst das API-Problem nicht, weil die API die Engine nicht
aufruft.

**Betroffene Stellen:**

- `src/lib/ruleEngine.ts` — `backtestRule` (ab Zeile 674) **nicht** im Verhalten
  ändern. Tests und gespeicherte `detail`-Payloads hängen an der gebührenfreien
  Form. Neue Funktion oder Option `costs: "none" | "paper"`, Default der
  Funktion bleibt `"none"`.
- `src/app/api/firm/rules/[id]/backtest/route.ts` — Default der Route auf den
  Paper-Pfad über `runRuleSetBacktest` (`src/backtest/engine.ts`, Zeile 742)
  mit `executionModel: "paper"`. Query-Flag `model=reference` behält den alten
  Pfad, explizit beschriftet. Heute liefert die Route bei `< 40` Kerzen 422
  und bei `MarketDataFetchError` 503. Der Store-Pfad soll fehlende Historie
  als 422 mit Grund zurückgeben, ohne Yahoo nachzuladen.
- Kerzen aus dem `HistoricalStore` (`historyDir()`), nicht aus `getCandles`.
  `getCandles` ist ein Live-Abruf und damit nicht as-of-reproduzierbar. Fehlt
  die Reihe, 422 mit Grund, kein stiller Yahoo-Call aus der UI.
- `saveBacktest` (`src/lib/ruleService.ts`, Zeilen 488–489) schreibt `from`
  und `to` beide als `new Date()`. Das sind nicht die Kerzenzeiten. Beim
  Anfassen auf die erste und letzte Kerzenzeit setzen und im `detail` ein
  Feld `executionModel` ablegen. Die numerischen Spalten bleiben die Summary;
  keine Migration nötig, solange `detail` das Modell trägt. Alte Zeilen ohne
  das Feld gelten als `reference` (unbekannt ≠ paper).
- Tests: bestehende `backtestRule`-Fälle bleiben byte-gleich. Neuer Fall:
  gleiche Kerzen, Paper-Fee > 0 ⇒ Netto-PnL ≤ Referenz-PnL bei Long-only und
  positiver Taker-Fee. Fail-closed: Simulator-Reject erzeugt keinen Trade.

**Nicht in diesem Schnitt:** Trailing, Time-Stop, Signal-Decay in den
Quick-Pfad ziehen. Der Quick-Pfad soll die Kosten des bestehenden Paper-Fills
zeigen, nicht ein drittes Exit-Produkt werden.

**Aufwand:** mittel, ein PR. Keine neue Dependency, kein Schema-Zwang.

### 3.2 W1 — Workshop-Schritt 5, nur DRAFT

**Warum danach:** Der sichtbare Nutzen des Audits ist real. Missionen werden
heute nicht gegen Kerzen geprüft, bevor ein Agent sie handelt. Der Backend-Weg
existiert. Ein Panel, das den gebührenfreien Pfad hübsch macht, würde den
Fehler aus 3.1 zementieren.

**Warum der Audit-Flow so nicht stimmt:**

- `applyMissionTemplate` erzeugt einen Missions-Entwurf (Titel, Ziel, Risiko),
  keine `RuleSpec`. Eine Mission „nur Long über der 20-Tage-Linie“ ist Prosa.
  Das Panel muss Bedingungen aus `RULE_FIELDS` bauen lassen (oder eine kleine,
  im Code liegende Regelvorlage anwenden) und das Ergebnis durch
  `sanitizeRuleSpec` schicken. Freitext aus dem Missionsziel in Bedingungen
  zu parsen, wäre ein LLM im Speicherpfad — widerspricht der Rule Engine.
- `POST /api/firm/rules` legt `DRAFT` an. Aktivierung ist `activateRule`,
  auditiert, eigene Permission. Der Button heißt „Als Entwurf speichern“,
  nicht „live übernehmen“. Kein Auto-Activate.
- Nur `LONG`. Das erzwingt `sanitizeRuleSpec` bereits.
- `LIMIT_CEILINGS` greifen in `sanitizeRuleSpec` über `RULE_CEILINGS`. Das
  Panel zeigt die geklemmten Werte, es erfindet keine zweite Prüfung.
- Metriken aus der API-Antwort, nicht lokal nachgerechnet. Sonst driften
  UI und `rule_backtests` auseinander.
- Equity-Kurve nur, wenn der Paper-Pfad eine liefert (`runMultiAssetBacktest`
  hat `equityCurve`). Der Referenz-Pfad hat keine — dann kein erfundenes SVG.

**Betroffene Dateien:**

- `src/components/workshop/WorkshopTab.tsx` — fünfter Schritt, Typ
  `WorkshopStep` erweitern. Bestehende vier Schritte nicht umnummerieren in
  der Hilfe, ohne `docs/help/workshop.help.json` und Handbuch Kapitel 6
  mitzuziehen (`docs:validate` prüft Help-Schema und Links).
- Neue Datei `src/components/workshop/RuleBacktestPanel.tsx`.
- Keine neue API-Route.
- `docs/MISSIONS.md`, `docs/HANDBUCH.md`, `docs/help/workshop.help.json` im
  selben PR. Sonst beschreibt die Hilfe vier Schritte, die UI fünf.

**Aufwand:** mittel, ein PR nach 3.1. Mobile ist mit den bestehenden
Tailwind-Mustern der anderen Panels machbar. Kein Canvas, wenn ein schmales
SVG der Equity-Punkte reicht.

### Konkrete nächste Schritte für Phase 1

1. In `route.ts` des Regel-Backtests den Ist-Pfad markieren: Antwortfeld
   `executionModel: "reference"` und Hinweistext, der heute nur in `note`
   steht, um den Satz „ohne Gebühren, Slippage und Funding“ ergänzen. Das
   ist ein ehrlicher Zwischenstand, falls der Paper-Umbau länger dauert.
   Allein reicht er nicht als Abschluss.
2. Paper-Aufruf über `runRuleSetBacktest` mit explizitem
   `executionModel: "paper"`, Kerzen aus `HistoricalStore.query`. Symbol der
   Regel ist die `instrumentId`. Timeframe aus `spec.window.timeframe`,
   gegen `isSupportedTimeframe` geprüft.
3. `saveBacktest` um optionales `{ from, to, executionModel }` erweitern.
   `from`/`to` = erste/letzte Kerze, nicht `new Date()`.
4. Test: Referenz-Pfad unverändert; Paper-Pfad weist `totalFeesPaid` aus der
   Engine-Metrik in `detail` aus; fehlende Historie → 422, kein Netzwerk.
5. Erst dann das Panel: Mission wählen (nicht `KILLED`), Bedingungen setzen,
   Backtest, Zahlen der Antwort, Entwurf speichern, `onChanged`.
6. Doku und Help-JSON im selben PR. Kein CI-Workflow-Diff — die Suite läuft
   lokal (`docs/ci/README.md`: `npm test` ist kein Required Check).

---

## 4. Priorität 2 — hoher Nutzen, keine kritische Abhängigkeit

Diese Arbeiten können parallel zu Phase 1 laufen. Sie sollten nicht in
denselben PR, weil sie andere Module und andere Tests berühren.

### 4.1 O2 — RSI, ATR, ADX, EMAs vor dem LLM, serverseitig angehängt

**Warum sinnvoll:** Research-Setups (`researchStep.ts`, Fallback-Entry Zeile 103)
leiten Entry, Stop und Take-Profit aus `keyLevels` und `bias` ab. Wenn das
Modell RSI 54 bei einem tatsächlichen RSI 28 behauptet, ändert das die These,
und die Plausibilitätsschicht sieht nur die Preise. Konfluenz zeigt, dass
der Trusted-Data-Pfad hält: rechnen, validieren, danach überschreiben.

**Warum nicht auf O1 warten:** Die Output-Felder `rsi` und `atr` existieren
in `src/cycle/schemas.ts` (um Zeile 192). Sie müssen nicht Rule-Felder werden,
damit der Analyst sie nicht mehr schätzt.

**Schnitt, enger als der Audit-Prompt:**

- Pro Kandidat (max. 40, `assertShortlistLimit` bleibt) 120 geschlossene
  1h-Kerzen aus dem `HistoricalStore`, as-of = Step-Zeit. Dasselbe Muster wie
  der Konfluenz-Batch, idealerweise ein gemeinsamer Store-Aufruf, nicht 40
  einzelne `getCandles`-Netzwerkcalls.
- Rechnen mit `rsi`, `atrPct`, `adx`, `ema` aus `src/lib/indicators.ts`.
  MACD nur, wenn O1 ihn geliefert hat — O2 hängt nicht daran.
- System-Prompt: Schätzen verbieten. Die Zahlen stehen in `trustedData`.
- Nach `validateTechnicalOutput` die Felder `rsi` und `atr` mit den
  gerechneten Werten überschreiben, analog zu `analysis.confluence`. Was das
  Modell zurückgibt, ist die These, nicht die Messung. Fehlende Kerzen:
  Feld weglassen oder `null`, nicht `rsi: 50`. Der heutige Fallback `50` ist
  eine Lüge (neutral erfunden). `rsi()` selbst gibt bei zu wenig Daten 50
  zurück — der Step darf das nicht als Messung ausgeben. Lookback prüfen,
  sonst `null`.
- `researchStep.ts` bekommt dieselben Zahlen im Technical-Kontext. Kein
  zweiter Indikator-Lauf, kein zweites LLM-Schätzen.

**Aufwand:** mittel. Schema additiv. `CONFLUENCE_ENABLED=false` darf diesen
Pfad nicht abschalten — das sind verschiedene Features.

### 4.2 O1 — MACD neu, ADX und BBW nur in die Whitelist

**Warum sinnvoll, aber später:** Regeln können Trend heute nur über
EMA-Lage (`trend`, `priceVsEma21Pct`) ausdrücken. ADX trennt starken Trend
von Lage. BBW trennt Squeeze von Expansion. Beides sind etablierte Filter
und im Code schon deterministisch. MACD ist das einzige fehlende Stück und
der einzige Grund, `indicators.ts` zu erweitern.

**Warum nicht Priorität 1:** Kein bestehender Consumer scheitert, weil
`adx14` nicht in `RULE_FIELDS` steht. Das Regime-Gate nutzt ADX bereits und
darf nicht über eine Regelbedingung dupliziert werden. O1 ist Ausdruckskraft
für menschliche und LLM-Regeln, kein Robustheitsloch.

**Schnitt:**

- `macd(closes, fast=12, slow=26, signal=9)` in `src/lib/indicators.ts`.
  Signal-Linie als EMA der MACD-Linie, nicht als SMA. Rückgabe `null`, wenn
  `closes.length < slow + signal`. Letzter Wert, keine Reihe — passend zu
  `rsi`/`adx`. Tests mit einer kurzen Handrechnung, nicht nur „ist eine Zahl“.
- `RULE_FIELDS`: `adx14`, `bbwPct`, `macd`, `macdSignal`, `macdHist`, alle
  `"number"`. `RuleSnapshot`: `number | null`. `accessor`-Switch erweitern.
  `buildSnapshotFromCandles` setzt `null`, wenn die Historie nicht reicht
  (ADX braucht 29 Kerzen bei Periode 14; der Snapshot bricht heute schon bei
  `< 25` ab — die Schwelle auf das Maximum der Lookbacks anheben, sonst ist
  `adx14` immer `null`).
- Einheiten: `adx14` ist ein Index 0–100. `bbwPct` als **Prozent** speichern
  (`bollingerBandWidthPct * 100`), Name und LLM-Schema-Beschreibung müssen
  das sagen. MACD in Preiseinheiten, nicht normalisiert — eine Regel
  `macdHist gt 0` ist einheitenfrei im Vorzeichen, `macd gt 1` ist es nicht.
  Das Schema-Kommentarfeld im Prompt muss das aussprechen.
- `RULE_LLM_SCHEMA` zieht die Enum aus `Object.keys(RULE_FIELDS)` (Zeile 800;
  Schema-Objekt ab Zeile 783).
  Kein zweites Schema pflegen.
- Tests in `tests/indicators.test.ts` und `tests/ruleEngine.test.ts`:
  Regel `adx14 gt 25` und `macdHist gt 0` kompiliert und evaluiert; zu wenig
  Kerzen ⇒ Bedingung false, weil `accessor` `null` als nicht erfüllt wertet
  (bestehendes Verhalten von `lt`/`gt`).

**Aufwand:** mittel, ein PR. Coverage-Gate `test:coverage:marketdata` aus dem
Audit nicht anfassen: die Workflows sind SHA-gepinnt und gespiegelt, und
Indikator-Tests laufen in `npm test`. Ein neuer CI-Job ist ein eigener,
reviewter Workflow-PR.

### 4.3 W2 — Wilson-Intervall, kein Binomial gegen 50 %

**Warum das Intervall sinnvoll ist:** Die Trefferquote bei 10 Läufen ist eine
Punktschätzung. `wilsonInterval` ist rein, getestet (`tests/forecastScoring.test.ts`)
und an den Rändern korrekt (`k=0`, `k=n`, `n=0 → null`). Import aus
`src/forecasts/scoring.ts` in `src/lib/workshop.ts` ist vertretbar, weil die
Funktion keine IO hat. Wenn der Import die Forecast-Schicht in den Workshop
zieht, die Funktion in ein kleines `src/lib/stats.ts` verschieben und beide
Caller umstellen — kein zweites Wilson.

**Warum der Binomial-Test gegen 50 % nicht sinnvoll ist:** Die Null „die Hälfte
der Läufe ist TRADE“ ist keine Handels-Null. Ein disziplinierter Agent mit
5 % TRADE ist von 50 % weit weg und wäre „signifikant“, ohne dass das etwas
über die Qualität der Trades sagt. Die UI würde Ablehnung oder Zustimmung
anzeigen, die der Nutzer als Trading-Evidenz liest. Das Forecast-Modul nutzt
Wilson genau, um diese Verwechslung zu vermeiden: Intervall zeigen, nicht
einen p-Wert gegen eine falsche Hypothese.

**Warum n≥30 als Banner irreführt:** `MAX_RUNS` ist 20, wegen des
Schreib-Rate-Limits (60/60 s, im Panel kommentiert). Ein Banner „zu wenige
Läufe“ wäre bei jedem Lauf wahr und damit wertlos. Stattdessen das Intervall
und den Satz „deskriptiv, n ≤ 20, kein Signifikanztest“. Die JSON-Tipps
bleiben. Dynamische Prompt-Länge gehört nicht hierher: das Panel kennt den
Prompt des gewählten Agenten nicht zuverlässig als Ursache des JSON-Fehlers,
und die statischen Tipps nennen Kürzen und `qwen2.5` bereits.

**Aufwand:** klein.

### 4.4 W4-Rest, nur die Warnung

`validatePromptInput` warnt bereits, wenn „JSON“ oder `{` fehlt. Eine weitere
Warnung ab 2000 Zeichen ist ein Zweizeiler und deckt den Audit-Punkt, der
stimmt: kleine Modelle verlieren Struktur. Die harte Grenze bleibt 8000.

Versionsgeschichte und Rollback sind kein Zweizeiler. `agents` hält nur den
aktuellen Text plus Integer. `prompt_artifacts` hält ab dem Capture neue
Versionen, nicht die Historie vor v1.65.0, und die UI hat keinen Leser.
Rollback ohne lückenlose Historie würde einen alten Hash als aktuellen Prompt
ausgeben und die Optimistic-Lock-Version überspringen. Das ist ein Schema-
und Migrationsschnitt (append-only, wie der Rest des Repos) und gehört nicht
in die Politur. Der Metrikvergleich unter `/api/firm/prompts/compare` ist der
vorhandene Ersatz für „welche Version war besser“.

---

## 5. Priorität 3 — sinnvoll nur eng begrenzt

### 5.1 O3 — Paritätstest, kein gemeinsamer Trigger

Ein Golden-Test, der für Long dieselbe Kerze prüft: Stop und Target in einer
Bar ⇒ beide Pfade `STOP_LOSS` (`detectExitTrigger` und `evaluateExit`). Das
sichert die Invariante, die beide schon behaupten. Live bleibt auf
`decideExit`, weil die Daten anders sind.

Optional und getrennt: Trailing und Time-Stop im Paper-Backtest über
`decideExit` auf dem **Schlusskurs**, nicht auf High/Low, und nur wenn der
Lauf es einschaltet. Default aus, sonst driften bestehende Paper-Läufe.
Signal-Decay ist dort schon angebunden. Das ist Härtung, kein Phase-1-Thema.

### 5.2 W3 — Warnung bei 75 % des Ceilings

`validateMissionInput` lehnt Werte außerhalb `LIMIT_CEILINGS` ab. Eine Warnung
bei `riskBudget > 0.75 * riskMax` ist ehrlich und billig. Sie ändert keine
Order. Segment-Buttons und Template-Vorschau existieren. Nicht noch einmal
bauen.

### 5.3 W5 — Copy-to-Prompt

Roh-JSON des Turns und `rawResponse` der letzten drei Nachrichten sind da.
Trace zeigt Schicht und Detail, keine Zeiten — die Turn-Latenz steht separat.
Ein Button, der System-Prompt plus ein Beispiel-JSON in den Prompt-Entwurf
kopiert, braucht einen Callback von `WorkshopTab` zu `PromptPanel`. Klein,
kein Verhaltenswechsel der Engine. Nicht den rohen Modelltext ungeprüft als
System-Prompt speichern: der Button füllt den Entwurf, der Mensch speichert.

### 5.4 Ulcer-Index

Nur anfassen, wenn eine Lifecycle- oder Walk-Forward-Policy ihn als Gate
benutzen soll. Sonst ist es eine Zahl ohne Konsument. Calmar bleibt die
Erholungs-Kennzahl. Recovery-Factor (`Netto-PnL / MaxDD`) ist eine Zeile in
`computeBacktestMetrics` und genauso konsumentenlos, bis jemand ihn liest.

### 5.5 Polygon.io — nur mit Bezahlung und einem konkreten Loch

Yahoo deckt Aktien und ETFs für die Timeframes, die der Store kennt, außer
`2h`/`4h`/`3m`. Crypto-History kommt von Binance, Kraken und Bitunix.
Tick-Daten und Corporate Actions wären der einzige Polygon-Mehrwert. Der
Audit hat recht, dass der Adapter default-aus und key-only sein müsste
(`POLYGON_API_KEY` nur über `process.env`, nie loggen). Er hat nicht recht,
dass das die nächste Datenbasis ist. Ein WebSocket mit Reconnect ist ein
zweiter Realtime-Pfad neben bestehenden Feeds und dem Paper-Simulator — das
ist ein Betriebsrisiko (SSRF-Allowlist, Token-Bucket, Capability-Gate), kein
Quick-Win.

Wenn er gebaut wird: `src/marketdata/adapters/polygon.ts`, Eintrag in
`KNOWN_SYNC_VENUES` und `SYNC_VENUE_MARKET_DATA`, Flag `POLYGON_ENABLED`
(das Repo-Muster ist `<VENUE>_ENABLED`, nicht `MARKET_SYNC_POLYGON_ENABLED`),
Host in `PAPER_FEED_ALLOWED_HOSTS`, Dokumentation in `CONFIGURATION.md` und
`docs/MARKET_DATA_PIPELINE.md` im selben PR, weil `docs:validate` Env-Flags
gegen die Doku prüft. Kein Key in `.env.example` außer einem leeren Namen.

### 5.6 FRED — nicht als Kerzenadapter

CPI, GDP und die 10Y-Rendite ändern sich langsam und sind keine
`MarketCandle[]`. VIX ist über Yahoo (`^VIX`) und `regimeFamilyInputs` schon
optionaler Makro-Vote. Ein FRED-Client lohnt erst, wenn ein Research-Step
eine offizielle Serie als Trusted Data braucht. Dann als eigener Typ
`MacroObservation`, nicht als `MarketDataAdapter`, sonst vermischt der Sync
Tages-Makro mit 1h-Kerzen.

---

## 6. Nicht umsetzen

| Vorschlag | Warum nicht |
|-----------|-------------|
| Purged K-Fold neben Walk-Forward | Zeitreihen-K-Fold ohne purges Fenster leakt. Mit Purge und Embargo ist es ein zweites Walk-Forward. `runWalkForward` hat Purge, Embargo, Holdout und Freeze-Hashes. Ein zweiter Split erzeugt zwei Wahrheiten für dieselbe Promotion. |
| `regime` als `RULE_FIELDS`-Enum `BULL/BEAR/SIDEWAYS/VOLATILE` | Falsche Labels, zweite Entscheidungsschicht neben `regimeGateFactor`, LLM kann das Gate konterkarieren. Code entscheidet, die Regel nicht. |
| Engine-Default `executionModel: "paper"` | Walk-Forward erzwingt `paper` bereits. Der Legacy-Default ist die Byte-Kompatibilität von GAP-01. Umschalten ist ein stiller Bruch, kein Feature. |
| Live-Monitor auf `detectExitTrigger` | Verliert Trailing, Time-Stop, Signal-Decay-Priorität und die DB-OCO. Andere Datengranularität. |
| Binomial-Test der TRADE-Quote gegen 50 % | Falsche Null, und die UI kann die dafür suggerierte Stichprobe (n≥30) nicht erzeugen (`MAX_RUNS = 20`). |
| Alpha Vantage als Fallback | 25 Requests/Tag ist kein Fallback für einen Sync über ein Universum. Schlechter als Yahoo ohne Key. |
| Finnhub-Realtime | Binance, Kraken und Bitunix liefern bereits Public-Marktdaten. Ein fünfter Key-Pfad erhöht die Allowlist, ohne eine Lücke zu schließen. |
| TradingView, IEX | Audit-Urteil stimmt: kein offizielles API bzw. Sunset. Nicht anfassen. |
| Yahoo neu schreiben | Adapter, Tests (`tests/marketdata/adapters/yahoo.test.ts`), Rate-Limit und Allowlist existieren. 2h/4h nicht durch `90m` ersetzen — der Adapter kommentiert, warum das Reihen mischen würde. |
| Audit-Prompts als `arena/*`-Subagenten 1:1 | Sie schreiben vor, was Abschnitt 6 ablehnt, und ignorieren Konfluenz, Feature Store, Lifecycle und den Paper-Pfad. Neue Prompts erst aus diesem Fahrplan, nach dem Schnitt in Abschnitt 3. |
| `AGENTS.md` mit den drei Edits | Inhalte sind in `docs/PAPER_TRADING.md`, `docs/ci/README.md` und `scripts/docs-validate.ts`. Eine untracked Root-Datei wäre die schlechtere Quelle. |
| CI-Job `test:coverage:marketdata` in diesem Zuge | Workflows sind gespiegelt und SHA-gepinnt. Coverage löst keine der offenen Lücken. Eigener PR, wenn der Owner den Required Check erweitern will. |

---

## 7. Phasen und Dateien

| Phase | Inhalt | Dateien | Fertig, wenn |
|-------|--------|---------|--------------|
| 1a | Paper-Kosten im Regel-Backtest, Referenzpfad bleibt | `src/app/api/firm/rules/[id]/backtest/route.ts`, `src/lib/ruleService.ts` (`saveBacktest`), `src/backtest/engine.ts` (`runRuleSetBacktest`), Tests neben `tests/backtest.engine.test.ts` | Route-Default bucht Fees; `backtestRule()` byte-gleich; fehlende Historie 422 |
| 1b | Workshop-Schritt 5, Entwurf only | `WorkshopTab.tsx`, neues `RuleBacktestPanel.tsx`, `docs/help/workshop.help.json`, `docs/HANDBUCH.md`, `docs/MISSIONS.md` | Mission → Bedingungen → Backtest → `DRAFT` in `trade_rules`, keine Aktivierung |
| 2a | TechnicalStep überschreibt RSI/ATR | `src/cycle/steps/technicalStep.ts`, `researchStep.ts`, `src/cycle/schemas.ts` nur additiv | LLM-RSI steht nicht mehr im persistierten Output, wenn Kerzen da sind |
| 2b | MACD + Whitelist | `src/lib/indicators.ts`, `src/lib/ruleEngine.ts`, `tests/indicators.test.ts`, `tests/ruleEngine.test.ts` | `adx14 gt 25` und `macdHist gt 0` evaluieren; kurze Historie → `null` → Bedingung false |
| 2c | Wilson im HitRatePanel, Prompt-Längenwarnung | `src/lib/workshop.ts` oder `src/lib/stats.ts`, `HitRatePanel.tsx`, `validatePromptInput` | Intervall sichtbar; kein p-Wert; Warnung ab 2000 Zeichen, Speichern weiter bis 8000 |
| 3 | Paritätstest, 75-%-Warnung, Copy-Button, Polygon nur bei Key-Beschluss | `tests/backtest.*.ts`, `validateMissionInput`, `AgentRunPanel.tsx` / `PromptPanel.tsx`, Adapter nur nach Beschluss | jeweils ein kleiner PR, Polygon nicht „auf Vorrat“ |

Nicht in diesen Phasen: O5, O6, Finnhub, FRED, Alpha Vantage, Engine-Default,
AGENTS.md, neue Arena-Prompt-Sammlung.

---

## 8. Was diese Prüfung nicht belegt

- Ob `npm test` auf diesem Commit grün ist. Die Aussagen stützen sich auf
  gelesenen Code und auf die Tracking-Dokumente der abgeschlossenen Audits,
  nicht auf einen neuen Lauf.
- Live-Verhalten von Yahoo, Binance oder Bitunix. Die Adapter sind verdrahtet
  und getestet gegen Fixtures (`tests/marketdata/adapters/`), nicht gegen
  den heutigen Vendor.
- Ob Operatoren den Quick-Backtest im Alltag überhaupt öffnen. Die Route
  existiert; ein UI-Zähler dafür nicht. Phase 1 bleibt richtig, weil die
  Route die einzige programmatische Regel-Prüfung vor dem Aktivieren ist
  und falsche PnL speichert (`rule_backtests.pnl`).
