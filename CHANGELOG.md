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

> **Status-Header:** **Beta** · Dokumentationsstand **2026-09-26** · Code-Version **0.5.0** ·
> Kanonische Quelle der Version: `package.json` (siehe [`VERSION.md`](VERSION.md)).

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
