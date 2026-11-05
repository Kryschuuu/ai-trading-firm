# Audit-Report — Strategien, Workshop & Datenquellen

**Quelle:** LLM-Agent **Big Pickle** · **Audit-Basis:** `7d8b07b` (`v1.51.3`) ·
**Datum:** 2026-09-20 · **Status:** OPEN (10 Befunde, 10 Umsetzungs-Prompts)

## 1. Executive Summary

Das Repository ist in den drei untersuchten Flächen deutlich weiter als ein
typischer Greenfield-Stand: Es gibt eine deterministische Regel-Engine mit
Whitelist und Code-Ceilings (`src/lib/ruleEngine.ts`), eine Multi-Asset-
Backtest-Engine samt Walk-Forward (`src/backtest/`), einen vierstufigen
Workshop-Lernpfad mit 18 Missionen-Vorlagen und 3-Ebenen-Feldhilfe
(`src/components/workshop/`, `src/lib/workshop.ts`) sowie eine Marktdaten-
Schicht mit Binance-/Yahoo-Feeds, Bitunix-Sync und Fehler-Manifest
(`src/lib/marketdata/`, `src/marketdata/`). Trotzdem bestehen drei konzeptionelle
Brüche:

1. **Die Regel-Bedingungsschicht kann vorhandene Indikatoren nicht abfragen.**
   `adx()`, `bollingerBandWidthPct()` und `returnStdDevPct()` sind in
   `src/lib/indicators.ts` implementiert und getestet, werden aber nur vom
   Firmen-Volatilitätsregime genutzt (`adaptiveRisk.ts`, `marketRegime.ts`).
   `RULE_FIELDS`/`RuleSnapshot` (`ruleEngine.ts:45-59` bzw. `:125-141`) bieten
   sie nicht an; MACD existiert gar nicht.
2. **Der Tages-"Technical Analyst" lässt das LLM Indikatoren schätzen**
   (`technicalStep.ts`, „RSI and ATR estimates“, Fallback `rsi: 50`,
   `keyLevels: {support: 0, resistance: 0}`), während der Makro-Zyklus dieselben
   Größen aus Kerzen berechnet (`macroCycle.ts`, `snapshot()`). Zwei Zyklen,
   zwei Datenqualitäten.
3. **Der Workshop endet bei der Trefferquote.** `src/components/workshop/*`
   enthält keinen Backtest-Verweis; die große Backtest-/Regel-Infrastruktur des
   Repos ist nicht an den Lernpfad angeschlossen — iterierte Missionen können
   weder validiert noch produktiv werden.

Zusätzlich sind der einfache Regel-Backtest kostenfrei (`POST
/api/firm/rules/[id]/backtest` → `backtestRule()`, keine Gebühren/Slippage/
Funding), das Backtest-/Live-Exit-Modell driftet auseinander (Live:
`decideExit()` mit Trailing-/Time-Stop; Replay: nur SL/TP), und die Datenquellen-
Schicht kann die bereits vorhandene Yahoo-`getCandles()`-Fähigkeit nicht für
Historik nutzen.

Der Implementierungsplan (`§5`) schneidet zehn Befunde in vier Wellen mit
definierten Dateien, Tests und Gates. Jeder Befund hat einen eigenständigen
Arena-Umsetzungs-Prompt in `prompts/`.

## 2. Methodik

- **Statische Pfad-/Symbolprüfung:** Zielgerichte Reads und `grep`-Suchen über
  `src/`, `docs/`, `package.json`, `scripts/`-Konventionen. Keine reine
  Dokumentationsquote als Implementierungsbeleg; jede Aussage trägt Datei- und
  (wo sinnvoll) Zeilennummern.
- **Testbestand als Wahrheit:** Indikator-Implementierungen wurden gegen
  `tests/indicators.test.ts` etc. nur auf *Existenz* geprüft; Handrechnungs-
  Assertions bleiben Aufgabe der Umsetzungs-Prompts.
- **Abgrenzung gegen bestehende Audits:** Die Findings
  [`2026-09-18-feature-gap`](../2026-09-18-feature-gap/README.md) (GAP-01…10)
  und [`2026-09-20-roadmap-audit`](../2026-09-20-roadmap-audit/README.md)
  (RMA-P1…P6) wurden gelesen; Berührungspunkte sind in den Befunden markiert.
  BP-05 schneidet den Exit-Drift schmaler als RMA-P1-01 (Event-Replay) und
  nutzt die bereits vorhandene `decideExit()`-Logik; BP-02 ist die
  Datengrundlage für RMA-P2-03 (Multi-Timeframe-Konfluenz) und RMA-P2-01
  (Regime).
- **Hinweis:** Verzeichnisse `/tests/`, `/scripts/`, `/deploy/` sind über
  `.ignore` für ripgrep/read gesperrt; relevante Inhalte wurden per
  `read`/`shell` mit expliziten Pfaden geprüft.

## 3. Verifizierter Status quo (Fundament)

| Ebene | Befund (belegt) |
|---|---|
| Regel-Felder | `RULE_FIELDS` = `price, rsi14, ema9, ema21, ema50, trend, atrPct, volume, volumeMa20, volumeRatio, changePct24h, priceVsEma21Pct, priceVsEma50Pct` (`ruleEngine.ts:45-59`) |
| Regel-Action | `side: "LONG"` (fix), `stopLossPct`, `takeProfitRR`, `riskBudgetPct`, `maxPositionPct`, `positionSizeMode: "risk"` (`ruleEngine.ts:89-96`) |
| LLM-Schema | `RULE_LLM_SCHEMA` nutzt `Object.keys(RULE_FIELDS)` als Feld-Enum — neue Felder propagieren automatisch (`ruleEngine.ts:798-800`) |
| Snapshot | `buildSnapshotFromCandles()` (Pflicht `>=25` Kerzen) baut `RuleSnapshot`; Hot-Path ohne DB/Netz (`ruleEngine.ts:566`, `:20`) |
| Schnell-Backtest | `backtestRule()` (kostenfrei, SL/TP, Entry am Kerzenschluss); API `POST /api/firm/rules/[id]/backtest`; Multi-Asset-Engine mit Kosten/Slippage (Funding nur `"paper"`-Pfad) |
| Exits | `decideExit()` (Trailing/Ratchet, Time-Stop, OCO-Semantik) — Import nur in `monitor.ts:23,204`; Replay-Pfade (`simulator.ts`, `paperExecution.ts:191-208`) nur SL/TP |
| Workshop | 4 Schritte (`WorkshopTab.tsx`), 18 Vorlagen, 9 Segmente, Trefferquote-Kategorien + JSON-Debug-Tipps (`workshop.ts:363-391`), `baseline-hold`-Diagnose; kein Backtest-Verweis in `src/components/workshop/` |
| Feeds | Binance (Krypto) + Yahoo (Non-Krypto) als `MarketFeed`; Yahoo hat bereits `getCandles()` (`yahoo.ts:106-112`), wird aber für Historik-Sync nicht genutzt |
| Sync | Bitunix `MarketDataAdapter` mit Timeframe-Map, Token-Bucket 8 req/s, `data/history`-Store mit Dedup; Fehler-Manifest `data/market-data-errors.json` |
| Makro | `runMacroCycle()` mit echtem `snapshot()`/`snapshotLine()` als Kontext; Deterministischer Fallback `meanReversionRule()` (`macroCycle.ts`) |
| News | RSS CoinDesk/Cointelegraph/Finviz (Headlines, Anti-Injection, `src/lib/news.ts`) |

## 4. Findings-Übersicht

| # | Titel | Severity | Kernbeleg |
|---|---|---|---|
| BP-01 | Indikatoren nicht regelbar / MACD fehlt | HIGH | `indicators.ts` vs. `RULE_FIELDS` |
| BP-02 | LLM schätzt Indikatoren | HIGH | `technicalStep.ts:75-102` |
| BP-03 | Workshop ohne Backtest-/Export-Brücke | HIGH | kein Backtest-Verweis in `workshop/` |
| BP-04 | Workshop ohne Baseline/Prompt-Preview/Übungen | MEDIUM | `HitRatePanel.tsx`/`PromptPanel.tsx` |
| BP-05 | Backtest/Live-Exit-Drift | HIGH | `exits.ts` nur in `monitor.ts` |
| BP-06 | Schnell-Backtest kostenfrei, kein Benchmark | MEDIUM | `backtestRule()` |
| BP-07 | Kein ATR-Stop in Regeln | MEDIUM | `RuleAction` |
| BP-08 | Yahoo-Historik ungenutzt | MEDIUM | `yahoo.ts:106` vs. Sync-Adapters |
| BP-09 | Kein Makro-/Kalender-Feed | LOW–MEDIUM | `newsStep`/`macroStep` ohne externe Makrodaten |
| BP-10 | Datenquellen-Evaluation nicht geregelt | LOW | nur Bitunix-Sync + 2 Feeds |

Details und Akzeptanzkriterien: `findings/BP-*.md`.

## 5. Implementierungsplan

### 5.1 Abhängigkeiten und Wellen

Grundregel: **Genau ein Prompt pro PR** (außer dort, wo eine Abhängigkeit einen
gemeinsamen Slice verlangt). Reihenfolge nach Abhängigkeit, nicht nach
Priorität:

| Welle | Prompt | Warum hier |
|---|---:|---|
| 1 | [PROMPT-BP-01](prompts/PROMPT-BP-01-rule-field-indikatoren.md) | erweitert `RULE_FIELDS`/`RuleSnapshot` — Basis für BP-02 und alle späteren Konfluenz-Regeln |
| 1 | [PROMPT-BP-08](prompts/PROMPT-BP-08-yahoo-historik.md) | unabhängig; füllt Datenbasis für Regel-Backtests |
| 2 | [PROMPT-BP-02](prompts/PROMPT-BP-02-technical-analyst-berechnete-daten.md) | konsumiert die neuen Snapshot-Felder aus BP-01 |
| 2 | [PROMPT-BP-06](prompts/PROMPT-BP-06-backtest-kosten-und-benchmark.md) | Voraussetzung, damit BP-03/BP-05 belastbare Zahlen zeigen |
| 2 | [PROMPT-BP-05](prompts/PROMPT-BP-05-backtest-live-exit-konsistenz.md) | Replay-Erweiterung unabhängig, Ausgabe fließt in BP-03-UI |
| 3 | [PROMPT-BP-07](prompts/PROMPT-BP-07-atr-stops-in-regeln.md) | ändert `RuleAction`/`RULE_CEILINGS` im selben Modul wie BP-01 |
| 3 | [PROMPT-BP-03](prompts/PROMPT-BP-03-workshop-backtest-bruecke.md) | TOP-Gate; konsumiert BP-06-Ergebnisse + `runMultiAssetBacktest` |
| 3 | [PROMPT-BP-04](prompts/PROMPT-BP-04-workshop-baseline-prompt-preview.md) | erweitert die Workshop-UI; unabhängig von BP-03, gemeinsam released |
| 4 | [PROMPT-BP-09](prompts/PROMPT-BP-09-fred-makro-feed.md) | eigenständig; kleines vertikales Slice |
| 4 | [PROMPT-BP-10](prompts/PROMPT-BP-10-datenquellen-integration.md) | Evaluation + erste konkrete Integration hinter Env-Flag |

### 5.2 Pro Befund: Umfang auf Datei-Ebene

**BP-01 — Regel-Felder erweitern (ADX, BB-Bandbreite, MACD).**
- `src/lib/indicators.ts`: `macd()` ergänzen (EMA-Diff + Signal + Histogramm);
  `adx()`/`bollingerBandWidthPct()` existieren bereits.
- `src/lib/ruleEngine.ts`: `RULE_FIELDS` (`adx14`, `bbWidthPct`, `macdHist`,
  `macdSignal`), `RuleSnapshot`, `buildSnapshotFromCandles()`,
  `RULE_CEILINGS`-Bounds für neue Felder, `RULE_LLM_SCHEMA`-Unit-Beschreibungen.
- `src/lib/macroCycle.ts`: Prompt-/Schema-Zeilen um neue Felder ergänzen.
- Tests: `tests/indicators.test.ts` (MACD-Handrechnung), Regel-Kompilierung +
  Golden-Snapshot, Look-Ahead-Test (`buildSnapshotFromCandles` darf nur
  geschlossene Kerzen nutzen).

**BP-02 — Technical-Analyst auf berechnete Daten.**
- `src/cycle/steps/technicalStep.ts`: Kontext aus `buildSnapshotFromCandles()`
  + deterministische Key-Level (rolling High/Low, ATR-Band) statt
  LLM-Schätzungen; Fallback mit realen Neutrallinien.
- `src/cycle/steps/researchStep.ts`: `technical context` weiterreichen.
- Konsistenz-Test: gleiche Kerzen ⇒ identische Analysesymmetrie (kein neuer
  Halluzinationsraum).

**BP-03 — Workshop-Schritt „Regel-Backtest + Export“.**
- Neuer API-Slice unter `src/app/api/firm/...` (kein neuer POST auf
  `/api/firm/backtests` — dort gibt es bewusst keinen POST): vorhandene
  `runMultiAssetBacktest`/`backtestRule` orchestrieren.
- `src/components/workshop/`: Schritt „5 · Regel-Backtest“ (Mission →
  RuleSpec-Skelett → Replay → Metriken → „als Regel aktivieren“ via
  `sanitizeRuleSpec`/`upsertRuleSpec`).
- `src/lib/workshop.ts`: reine Funktionen für Mission→RuleSpec-Mapping.
- Tests: Konvertierungs-Roundtrip, Guardrail-Einhaltung (Ceilings), Idempotenz.

**BP-04 — Workshop: Baseline-Vergleich, Prompt-Preview, Übungen.**
- `src/components/workshop/HitRatePanel.tsx`: `baseline-hold`-Delta,
  Stichproben-Warnung (n < 30).
- `src/components/workshop/PromptPanel.tsx`: reale `MISSION:`/`SEGMENT:`/
  `UNIVERSUM:`-Promptzeilen als lesbarer Block (aus `missionUniverse.ts`).
- Übungseinheit (optional separat): 3 Übungen mit fester Checkerlogik.
- Tests: Rendering-, Null-/Leerzustand, Kein-Secret-Leak.

**BP-05 — Backtest/Live-Exit-Konsistenz.**
- `src/backtest/` (beide Pfade): je offener Position pro Kerche
  `decideExit(input, config)` verwenden; `DEFAULT_EXIT_CONFIG`
  (verhaltensneutral) als Default, bei expliziter Konfig diese übernehmen.
- Worst-Case-SL: Lücke überspringt Stop → Fill zum Gap/Open (nicht exakt zum
  Stop-Preis); Kollision SL/TP mit dokumentiertem Tie-Break.
- Golden-Tests: Trailing-Ratchet, Time-Stop, Gap-SL, SL/TP-Kollision;
  Determinismus-Hash.

**BP-06 — Kostenmodell + Benchmark im Schnell-Backtest.**
- `src/lib/ruleEngine.ts::backtestRule()` oder Delegation an die Multi-Asset-
  Engine: Taker-Fee + Slippage (Defaults aus `DEFAULT_BACKTEST_CONFIG`),
  optional Funding.
- `src/backtest/metrics.ts`: Buy-&-Hold-Referenzlinie je Symbol (Excess Return,
  relatives MDD), nicht nur absolute Kennzahlen.
- Tests: Kosten-Golden-Werte, Benchmark-Konsistenz, Abwärtskompatibilität
  (Legacy-Default bleibt).

**BP-07 — ATR-Stop als Regel-Feld.**
- `src/lib/ruleEngine.ts`: `RuleAction.atrStopK` (optional, Bounds [0.5, 6]),
  `sanitizeRuleSpec`, `RULE_CEILINGS.atrStopK`; `action` ist DB-`jsonb` ⇒ keine
  Migration, `signature`-Hash deckt Feld automatisch ab.
- `src/lib/positionSizing.ts`: atrStopK-Pfad vor Fallback verwenden.
- Semantik: `stopLossPct` gewinnt, wenn beide gesetzt (expliziter Vorrang);
  Doku in `RULE_LLM_SCHEMA`.

**BP-08 — Yahoo-Historik für den HistoricalStore.**
- Neuer Sync-Use-Case (nicht Feed-Wechsel): `yahoo.ts::getCandles()` als
  Datenquelle für einen Yahoo-`MarketDataAdapter`-Pfad bzw. einen erweiterten
  `MarketDataSyncService`-Venue im `ConfigurationFeed`-Sinn — EQUITIES/INDICES/
  FX füllen `data/history`.
- Host `query1.finance.yahoo.com` bleibt in `PAPER_FEED_ALLOWED_HOSTS`,
  Rate-/Fehlerpfad aus `src/marketdata/dataErrors.ts` wiederverwenden.
- Tests: Range-Mapping (`5m`→`5d`, `1h`→`1mo`), Limit-Kappung, Fehlerfall /
  Degraded Reason.

**BP-09 — FRED-Makro-Feed (Regime & Event-Shield).**
- Neuer `MarketFeed`-artiger Makro-Reader (e.g. `src/lib/marketdata/feeds/fred.ts`
  oder portbasiert in `src/cycle/`): Serie CPI/Leitzins/VIX-Anker aus FRED,
  Host `api.stlouisfed.org`, Env-Key optional, SSRF-Allowlist.
- Konsum im Makro-Zyklus-Kontext (Regime-Envelope) + `news-event-shield`-
  Segment (Terminwochen).
- Tests: Formatumsetzung, Fehlende-Serie-Fail-soft, keine Prompt-Injection.

**BP-10 — Datenquellen-Evaluation + erste Integration (Polygon).**
- `docs/DATENQUELLEN_EVALUATION.md`: Bewertungsraster (Kosten, Lizenz, Coverage,
  Rate Limits, WS) für Polygon.io, Alpha Vantage, Finnhub, Twelve Data u. a.;
  explizite Aussagen zu TradingView (kein öffentliches API) und IEX Cloud
  (eingestellt).
- Erste Integration: Polygon-EOD-Feed hinter `POLYGON_ENABLED=true` +
  `POLYGON_API_KEY` (Env, nie committen) als `MarketFeed` mit Keyless-Skip.
- Tests: Keyless-Skip, SSRF-Allowlist, Format-/Fehlerpfade.

### 5.3 Definition of Done pro Befund

- Pflichtgates grün: `npm run typecheck`, `npm run lint`, relevante Tests,
  `npm run docs:validate`.
- Bei Replay-/Indikatoren-Änderungen: Determinismus-/Golden-Test und (falls
  historische Daten berührt) Look-Ahead-/As-of-Test.
- Doku: betroffene README-/Code-Doku und `CONFIGURATION.md` (neue Env-Flags),
  `CHANGELOG.md`-Eintrag.
- Tracking: Finding + `remediation/TRACKING.md` erst mit PR, Commit, Testliste
  und Fix-Version auf `FIXED`.

### 5.4 Risiken

- **Kompatibilität:** `RULE_FIELDS`/`RuleSnapshot` erweitern ist additiv, aber
  `trend`- und `number`-Sätze müssen konsistent bleiben (Tests fangen das ab).
- **Backtest-Defaults:** BP-06 darf Legacy-Läufe nicht unbemerkt verändern —
  Default-Konfiguration einfrieren, neue Modus-Optionen additiv ergänzen.
- **Yahoo-Volatilität:** rate-limiting/Fehlersignaturen sind venue-spezifisch;
  Fail-soft über die bestehende Fehler-Taxonomie.
- **Workshop-Export:** Aktivierung von Regeln muss die bestehenden
  UNIQUE-Indizes (`trade_rules_active_*`) und `ruleService`-Transaktionen
  respektieren — kein Weg am `sanitizeRuleSpec` vorbei.

## 6. Referenzen

- [`README.md`](README.md) — Status-Tabelle und Gate-Faktoren.
- [`findings/`](findings/) · [`prompts/`](prompts/) ·
  [`remediation/TRACKING.md`](remediation/TRACKING.md).
- Vorgänger-Audits: `docs/audits/2026-09-18-feature-gap/`,
  `docs/audits/2026-09-20-roadmap-audit/`.