# Datenadapter, Parallelität, Daytrading — Prüfung und Umsetzung 2026-09-24

> **Status-Header:** **Umgesetzt (Teilmenge)** · **v0.2.0** · 2026-09-24 ·
> Quelle `internal` (Code-Prüfung gegen einen Werk-Auftrag) ·
> Branch `arena/01a0d0db-ai-trading-firm` · Status-SSoT:
> [`remediation/TRACKING.md`](remediation/TRACKING.md)
>
> Grundlage: ein Werk-Auftrag („Prompt Data Sources — Yahoo/Polygon/FRED
> Adapter" plus „Strategieverbesserungen O1–O6"), der den Stand **vor**
> `v0.2.0` beschreibt. Vorgänger-Zyklus:
> [`../2026-09-23-verbesserungen-fahrplan/README.md`](../2026-09-23-verbesserungen-fahrplan/README.md)
> — dortiger Abschluss gilt, dieser Ordner schreibt ihn nicht um.

Der Auftrag ist an mehreren Stellen bereits erledigt, an einer Stelle
messtechnisch unmöglich, und an einer Stelle baubar. Die drei Behauptungen
wurden gegen den Code geprüft, nicht gegen den Text des Auftrags.

---

## 1. Was der Auftrag forderte, und was der Code schon tat

| Forderung | Befund am Checkout | Konsequenz |
| --- | --- | --- |
| Yahoo-Adapter neu bauen (`yahoo.ts`) | **Existiert und ist produktiv** (`src/marketdata/adapters/yahoo.ts`): Chart-API `query1.finance.yahoo.com`, Timeframes `1m…1mo` über `YAHOO_TIMEFRAME_MAP`, Token-Bucket (`YAHOO_SYNC_RATE_PER_SEC`), Symbol-Mapping `toYahooSymbol`, Index-Map, UA-Pflicht, SSRF-Allowlist über `SyncHttpClient`, Orderbook-Attrappe mit ehrlichem `null`-Spread | **Nicht gebaut.** Ein zweiter Yahoo-Adapter hätte zwei Wahrheiten über denselben Feed erzeugt |
| `RULE_FIELDS` um `adx14`/`bbwPct`/`macd*` erweitern | **Existiert** (`src/lib/ruleFieldCatalog.ts`, `RuleSnapshot`, `accessor`, `buildSnapshotFromCandles`) — v0.2.0, Ticket VBF-P2-02 | Nicht gebaut |
| `macd()` in `indicators.ts` | **Existiert** (EMA12/26, Signal 9, `null` unter `slow + signal`) | Nicht gebaut |
| TechnicalStep: Indikatoren vor dem LLM rechnen | **Existiert**, und strenger als gefordert: `trustedIndicators.ts` rechnet RSI/ATR/ADX/MACD aus geschlossenen 1h-Bars und **überschreibt** die Modellwerte nach der Validierung; Vorschlag des Auftrags hätte sie nur in den Prompt geschrieben | Nicht gebaut (der Bestand ist die härtere Variante) |
| Binomialtest + Wilson + Mindest-N im HitRatePanel | **Wilson existiert** (`src/lib/stats.ts`, Panel nutzt es); Binomialtest bewusst verworfen (VBF-W2: „Wilson reicht") | Nicht gebaut |
| „`backtestRule` und Engine-Default `legacy` unverändert" | Stimmt — und bleibt so | — |

Der Auftrag war also überwiegend eine Inventarliste des bereits Gelieferten.
Das ist der Grund, warum dieser Zyklus **nichts davon doppelt** baut.

## 2. Die drei Datenadapter — Entscheidung und Begründung

### 2.1 Yahoo — kein Neubau, sondern Bestand

`ALPACA`/`IBKR` haben keinen key-freien Public-REST-Pfad; Yahoo ist dort die
dokumentierte Sync-Quelle, `PAPER` spiegelt sie. Verdrahtet in
`src/marketdata/registerAdapters.ts` (Gate: `MARKET_SYNC_VENUES`,
`SYNC_VENUE_MARKET_DATA`, geteilter Token-Bucket je Host). Wer Aktien/ETFs/FX/
Indices im Store will, aktiviert `ALPACA_ENABLED=true` o. ä. — nicht einen
neuen Adapter.

### 2.2 Polygon — abgelehnt, mit Preis angegeben

Abgelehnt wurde das bereits in VBF-D-polygon (`WONTFIX: Kein Prompt.`). Diese
Prüfung sagt, **was** den Beschluss kippen würde, statt ihn nur zu wiederholen:

1. **Vertrag.** `SyncHttpClient` ist ein GET-only-JSON-Client mit
   Host-Allowlist, Payload-Kappe und Retry-Taxonomie. Polygon braucht
   (a) `next_url`-Blätterung über die Aggregates-Route, (b) einen
   Auth-Pfad — der Auftragsentwurf sagt „API-Key via `POLYGON_API_KEY`", der
   Sync-Pfad ist aber credential-frei konstruiert (kein Secret im
   Market-Data-Zweig, siehe Kopf von `registerAdapters.ts`). Ein Query-Param
   mit Key wäre ein bewusster Bruch dieser Invariante, nicht ein Feature.
2. **Capability-Matrix.** `VENUE_CAPABILITIES` ist Broker-Semantik und
   test-gepinnt (`tests/brokerCoverage.test.ts`); der Sync führt seine eigene
   `SYNC_VENUE_MARKET_DATA`. Ein `POLYGON`-Venue hätte dort einen Eintrag,
   einen Env-Flag, einen Bucket — und **kein Instrument**, das darauf
   zeigt: `seeded.ts` liefert die Universen, die Presets kennen keine
   Polygon-Symbolik.
3. **Realtime.** Der geforderte WebSocket (`socket.polygon.io`, Reconnect mit
   Backoff) existiert in dieser Form schon zweimal: `src/brokers/bitunix/ws.ts`
   (Venue-Feed) und `BinanceTradeFeed` im Mikro-Executor. Ein dritter Feed
   braucht eine Tick-Normierung auf `MarketTick`-Semantik und ein
   Subscription-Management — das ist ein eigenes Projekt, kein Adapter.

Würde Polygon den Paper-Pfad **billiger** machen (andere Bar-Qualität,
Splits/Dividenden als Adjustment, längere Historie für 1m), ist der richtige
Einstieg nicht der Adapter, sondern `HistoricalStore`-Provenienz plus ein
Doku-Abschnitt „Quelle der Wahrheit je Assetklasse". Dieser Auftrag hat das
nicht geleistet, weil die Datenlage (welche Klassen, welche Historie, welcher
Preis) offen ist.

### 2.3 FRED — abgelehnt, Begründung ist härter geworden

Der Auftrag wollte `MacroObservation[]` „für `marketRegime.ts` nutzbar". Das
Regime **hat** bereits eine Makro-Ebene: `src/lib/macroCycle.ts` plus
`marketRegime.ts` mit den Labels `CRASH > HIGH_VOL > TREND_* > RANGE`,
gespeist aus Kursdaten, und `regimeEvaluation.ts` / `regime:eval` messen sie.

FRED-Serien (VIXCLS, DGS10, CPIAUCSL, GDP) haben zwei Eigenschaften, die in
einer Regel-Engine verbieten, sie als Regelfelder zu nehmen:

* **Kein as-of-Vertrag.** `CPIAUCSL` wird nachträglich revidiert, `GDP`
  erst mit Verzug veröffentlicht. Wer „CPI > x" als Bedingung gegen eine
  Tageskerze prüft, schaut in die Zukunft (Look-ahead), außer die Serie wird
  mit Veröffentlichungsdatum **und** Revisionsstand gespeichert — ein
  Feature-Store mit Point-in-Time-Semantik, nicht ein Adapter.
* **Andere Frequenz.** Ein Stunden-Cache auf eine Makroserie, die monatlich
  erscheint, ändert nichts an der Entscheidungsqualität, aber alles an der
  Nachvollziehbarkeit (zwei Regime-Quellen, eine davon ohne Punkt-in-Zeit).

Darum bleibt es dabei: FRED ist kein OHLCV-Feed und kein Regelfeld. Wenn Makro
rein soll, dann als **eigene, PIT-versionierte** Familie im Feature-Store
(`src/features/`) mit eigenem Evaluations-Pfad — nicht über den Kerzen-Sync.

## 3. „Warum nicht mehrere Agenten parallel und mehr Märkte?"

Die ehrliche Antwort lautet: **das Limit war nicht die Vorstellungskraft,
sondern die Token-Rechnung — und der Fehler war, dass sie still
herunterkam.**

Gemessen am Code dieses Checkouts (40 Kandidaten, Default-Flags):

| Größe | Wert |
| --- | --- |
| gebauter User-Prompt (Trusted- + Untrusted-Blöcke) | **92 449 Zeichen ≈ 25 700 Tokens** |
| `OLLAMA_NUM_CTX` (Default) | **4 096 Tokens** |
| `LLM_MAX_TOKENS` → `num_predict` (Default) | **512 Tokens** |
| davon redundant (Voll-Snapshots ≡ Zeilenform) | 58 862 Zeichen = **64 %** |

Der Prompt war also **6,3× zu lang** und die erlaubte Antwort zu kurz für 40
Analyseobjekte (≈ 90 Tokens je Objekt ⇒ 512 decken ~4 ab). Die Kette danach
ist deterministisch: Ollama kürzt die Eingabe, `format: json` schneidet die
Antwort ab, `safeExtractJson` findet kein vollständiges Objekt, der Agent-Port
liefert `spec.fallback` — und der Fallback des Schritts ist je Kandidat
`NEUTRAL`/Score 50. **Ergebnis: 40 Zeilen, die nach Analyse aussehen und keine
sind.** Mehr Märkte auf diesem Pfad = mehr neutrales Nichts, nicht mehr
Erkenntnis. Genau deshalb war die Shortlist auf 40 gedeckelt (Code-Grenze,
`assertShortlistLimit`) — der Deckel war Symptom, nicht Ursache.

Gebaut wurde deshalb die Aufteilung, nicht das Versprechen:

* `src/cycle/promptBudget.ts` — Budget aus `num_ctx`/`num_predict` ableiten,
  Batch-Grenzen **aus Messung** (nicht Schätzung) bestimmen, gieriges
  deterministisches Packen, `mapBounded` als Nebenläufigkeitsbegrenzer.
* `src/cycle/steps/technicalStep.ts` — misst den Prompt mit **derselben**
  Baufunktion, die der Port sendet (`promptPayload.ts`), entfernt zuerst die
  Redundanz, teilt dann, führt in Eingabereihenfolge zusammen, überdeckt
  kaputte Batches einzeln und zählt sie (`promptFit.failedBatches`,
  `fallbackInstruments`, `incomplete`).
* Nach der Umstellung, gleiche Konfiguration: **10 Aufrufe à ≤ 1 650 Tokens
  und ≤ 4 Analysen**, jeder nachweislich im Fenster, 40 echte Analysen statt
  40 Neutralwerte.

Derselbe Defekt steckte im News-Schritt (Schritt 05), nur mit fremdem Text statt
Messwerten: 40 Instrumente × 3 Headlines ≈ 110 Zeichen bauen einen Prompt von
**31 594 Zeichen ≈ 8 800 Tokens — das 2,6-Fache des Fensters**. Beide Schritte
planen jetzt am gemessenen Budget; beim News-Schritt bleibt der
Injection-Schutz unverändert (externe Texte ausschließlich im
`untrustedData`-Block, je Batch die Teilmenge der Meldungen plus jede
symbollose Ganzmeldung — sonst übersieht ein Batch eine Markt-Krise), und das
systemische Risiko wird über die Batches nach **Schwere** gemerged (MAX), nicht
nach Mehrheitsvotum: ein `CRITICAL` unter drei `LOW` ist ein `CRITICAL`-Problem.

Zur Nebenläufigkeit selbst: ein lokaler Ollama-Server bedient standardmäßig
**einen** Inferenz-Slot. Zwei parallele Batches laufen dort nicht parallel,
sondern stehen Schlange und verdrängen sich den KV-Cache — Wandzeit steigt.
Deshalb ist `CYCLE_ANALYST_CONCURRENCY` bei `ollama` per Default 1 und bei
Remote-Providern 2; der Router-Tagesdeckel (`tokensPerDay`) gilt über alle
Batches weiter. Parallelität ist hier ein Provider-Feature, kein
Code-Feature. Wer sie wirklich will, skaliert die Inferenz (mehr Slots /
zweite Box / Remote-Provider) und setzt dann den Flag.

Und „mehr Märkte" hat eine zweite, physische Grenze: der Daten-Sync.
`SYNC_TIMEFRAMES` lädt standardmäßig **nur `1h`**, Yahoo läuft mit 2 req/s,
Bitunix mit 8 req/s pro IP. 250 Instrumente × ein Timeframe sind 250 Requests;
drei Timeframes wären 750 — für Konsumenten, die (heute) nur `1h` lesen. Feiner
Takt kostet Request-Budget und Store-Größe, bevor er überhaupt analysiert
werden kann.

## 4. Daytrading — Bestand, Lücke, Umsetzung

**Da ist mehr, als der Auftrag vermutet:**

* Mikro-Executor (`src/lib/microExecutor.ts`): Regel-Cache, `RollingTimeframeSeries`
  (Ticks → 1m-Kerzen → Aggregation), Trade-Feed, Advisory-Lock je Symbol,
  Tageslimit und Cooldown je Regel, Regime-Gate, Kostenpfad.
* Exit-Schicht (`src/lib/exits.ts`): `STOP_LOSS → TAKE_PROFIT → TRAILING_STOP
  → TIME_STOP → SIGNAL_DECAY` (Trailing/Time-Stop sind opt-in, Default
  verhält sich wie vorher) — plus Paritätstest gegen den Live-Trigger
  (`tests/exitParity.test.ts`).
* Regel-Fenster: `maxExecutionsPerDay` (1–10), `cooldownMinutes`,
  `validFrom`/`validUntil`, `volumeWindow`.

**Das fehlte wirklich, und ist jetzt gebaut:**

1. **`vwapPct`** als Regel-Feld. Der volumen-gewichtete Tagesdurchschnitt ist
   *die* Referenz des Intraday-Handels (über/unter VWAP = Käufer-/Verkäufer-
   markt, Anker für Stops und Targets). Alle vorhandenen Felder vergleichen
   mit Zeitmitteln (EMA 9/21/50), keiner mit dem Volumenmittel. Neu:
   `sessionVwap()`/`utcDayAnchorMs()` in `src/lib/indicators.ts`, Feld in
   `RULE_FIELDS` (damit auch im Workshop wählbar, weil die UI die Katalog-Liste
   liest), `buildSnapshotFromCandles` füllt es, `trustedIndicators` gibt es als
   Messwert an den Analysten. `null` ohne Volumen — eine 0 wäre eine erfundene
   Neutralität.
2. **`1m` als Regel-Timeframe.** Vorher: `RuleWindow.timeframe` kannte
   5m/15m/30m/1h, `TIMEFRAME_MS` im Executor ebenfalls. Die Serie hätte eine
   `1m`-Regel **still auf 15 Minuten aggregiert** (`?? TIMEFRAME_MS["15m"]`)
   — die Regel wäre auf einem anderen Takt gelaufen, als sie unterschrieben
   ist. Jetzt ist `1m` erlaubt, verdrahtet (Whitelist, JSON-Schema,
   `TIMEFRAME_MS`, Workshop-Panel) und getestet.

**Was weiterhin fehlt — bewusst, und mit Begründung:**

* **Shorts.** `RULE_ALLOWED_SIDE = "LONG"` ist eine Code-Schranke
  („Shorts sind im Code gesperrt"). Ein Daytrader ohne Short ist in
  Abwärtsphasen blind — das ist ein reales Defizit, aber es ist eine
  Risikoentscheidung (unbegrenzter Verlust, Leihgebühr, Margin), keine
  Zeile Code. Freigabe braucht: Short-Pfade in Sizing, Exits, Backtest,
  Funding/Kosten **und** eine Deckelung, die den Verlust nach oben begrenzt.
* **1m-Historie im Store.** `npm run market:sync -- --timeframes=1m,5m,15m,1h`
  ist nötig, damit ein `1m`-Regel-Backtest Daten hat. Der Sync lädt
  standardmäßig nur `1h`; wer den Takt nicht backfüllt, bekommt 422 statt
  Zahlen (bewusst: keine erfundene Historie).
* **Markt-Mikrostruktur als Entscheidungsgröße.** Spread ist da
  (`spreadCache`, `spreadsUnknown`), aber kein Regel-Feld — für Daytrading
  (Gebühren + Slippage schlagen pro Trade durch) wäre `spreadPct`/
  `bookDepthUsd` wertvoller als jeder weitere Oszillator. Bewusst nicht in
  diesem Zyklus gebaut: die Datenqualität der Orderbücher ist je Venue
  unterschiedlich gut belegt, und ein Feld auf dünnen Büchern ist eine
  Fehlentscheidungs-Maschine.
* **Order-Typen.** Nur Markt zum Fill mit Slippage-Modell; Limit/Stop-Markt
  und OCO am Broker wären für Intraday sinnvoll, gehören aber in
  `src/execution`/Broker-Verträge, nicht in die Regel-DSL.

## 5. Was dieser Zyklus geändert hat

| Bereich | Änderung |
| --- | --- |
| `src/cycle/promptBudget.ts` | neu: Budget aus `OLLAMA_NUM_CTX`/`LLM_MAX_TOKENS`, `packBatches`, `resolveConcurrency`, `mapBounded` |
| `src/cycle/promptPayload.ts` | neu (Extraktion aus `ports.ts`, gleiche Baufunktion für Messung und Versand) |
| `src/cycle/steps/technicalStep.ts` | Messung → Redundanz-Hebel → Batch-Aufteilung → Merge in Eingabereihenfolge; Fallback je Batch, nicht je Lauf |
| `src/cycle/steps/newsStep.ts` | dieselbe Budget-Planung für Headline-Material; Ganzmeldungen in jedem Batch, systemisches Risiko nach Schwere gemerged, `promptFit` im Output |
| `src/cycle/schemas.ts` | `TechnicalPromptFitMeta` (additiv); `validateTechnicalOutput` lässt `confluenceMeta`/`promptFit` durch (vorher verlor die Engine beide im Handoff) und saniert sie gegen Einschleusung |
| `src/lib/indicators.ts` | `sessionVwap`, `utcDayAnchorMs` |
| `src/lib/ruleFieldCatalog.ts`, `src/lib/ruleEngine.ts` | Feld `vwapPct`, Snapshot + `accessor`, `1m` im Fenster |
| `src/lib/microExecutor.ts` | `TIMEFRAME_MS["1m"]` (sonst stille 15m-Aggregation) |
| `src/cycle/trustedIndicators.ts` | `vwapPct` im Messwert-Block |
| `src/components/workshop/RuleBacktestPanel.tsx` | `1m` im Timeframe-Port |
| Doku | `CONFIGURATION.md` (Flag-Tabelle + Messung), `.env.example`, `docs/ARCHITECTURE.md`, `docs/HANDBUCH.md`, `CHANGELOG.md` |

Neue Flags: `CYCLE_PROMPT_RESERVE_TOKENS`, `CYCLE_PROMPT_INPUT_BUDGET_TOKENS`,
`CYCLE_ANALYST_BATCH_SIZE`, `CYCLE_ANALYST_CONCURRENCY` (Bounds und Verhalten:
`CONFIGURATION.md`).

Nicht geändert: `backtestRule`, der Engine-Default `legacy`, die
Whitelist-Semantik, die Code-Grenze 40, `VENUE_CAPABILITIES`, die
Broker-/Secret-Grenzen.

## 6. Nachweis

* `tests/cycle.promptBudget.test.ts` — 16 Fälle: Budget-Ableitung, Untergrenze,
  Override, Klemmung, Ausgabekapazität (512 ⇒ 4 Analysen), Packung
  (Reihenfolge, Vollständigkeit, Riesen-Item, leer), Nebenläufigkeits-Entscheidung,
  `mapBounded` (Reihenfolge bei staggered Completion, Peak = Limit, Fehler
  wirft).
* `tests/cycle.newsBatching.test.ts` — 4 Fälle: Aufteilung nach Kandidatenmenge,
  je Batch nur eigene Instrumente plus jede Ganzmeldung, Headline-Text leakt
  nicht in den Instruktionstext, `CRITICAL` gewinnt gegen drei `LOW`,
  kaputter Batch zählt als ABSTAIN-Fallback, kleines Set bleibt ein Aufruf.
* `tests/cycle.technicalBatching.test.ts` — 9 Fälle: ein Aufruf wenn es passt,
  6 → 3 Aufrufe, je Batch nur eigene Kandidaten (Prompt, Untrusted-Block,
  Trusted-Zeilen, Indikator-Subset), kaputter Batch zählt und vergiftet die
  anderen nicht, Wurf-Isolation (Einzelbatch wirft wie bisher),
  Redundanz-Hebel, RSI-Überschreibung bleibt, Meta-Handoff.
* `tests/indicators.test.ts` — 6 Fälle `sessionVwap`/`utcDayAnchorMs`
  (Handrechnung, Tagesreset, `null`-Fälle, Anker-Override).
* `tests/ruleEngine.test.ts` — 4 Fälle: `vwapPct` Handrechnung im Snapshot,
  `null` ohne Volumen (fail-closed), Richtung der Bedingung, `1m`-Fenster und
  Fallback auf `15m`.
* Grün: `npm run typecheck`, `npm run lint` (0 errors), `npm run docs:validate`
  (8 Checks), `npm run test:coverage:marketsync` (90-%-Gate),
  `npm run test:coverage:cycle`, `tests/cycle.*`, `tests/confluence.*`.

## 7. Offene Punkte (nicht gebaut, mit Grund)

1. **Polygon-Beschluss revidieren?** Nur mit Preisangabe: Query-Auth im
   credential-freien Sync-Zweig oder ein zweiter, gekennzeichneter Pfad mit
   Secret-Read; plus `next_url`-Blätterung im `SyncHttpClient`; plus
   Polygon-Universum in `seeded.ts`. Wer das will, sollte zuerst die
   Preis-/Qualitätsfrage beantworten (welche Assetklasse braucht was?), nicht
   den Adapter schreiben.
2. **1m-Historie-Beschaffung.** Backfill-Volumen und Store-Größe sind
   unkalibriert; ein 1m-Default-Lauf wäre ein Request-Sturm. Erst mit
   dokumentiertem Budget je Venue.
3. **`spreadPct` als Regelfeld.** Höchster Daytrading-Nutzen unter den
   offenen Ideen, braucht aber eine belastbare Qualitätsgrenze pro Venue
   (Orderbuch-Tiefe, Alter des Snapshots), sonst gewinnt die Regel das
   Rauschen.
4. **`changePct24h` misst keine 24 Stunden.** Die Rechnung bezieht die Kerze
   vor **97 Perioden** (`ruleEngine.buildSnapshotFromCandles`), der Feldname und
   das frühere Label sagen 24 h bzw. 24 Kerzen. Auf `1h` sind das ~4 Tage, auf
   `5m` ~8 h, auf `1m` ~1,6 h. Dieser Zyklus hat Label und Kommentar auf die
   Wahrheit gebracht (Doku, kein Verhalten), die Rechnung **nicht** geändert:
   eine Zeitanker-Korrektur wertet jede bestehende Regel und ihren Backtest
   still um. Richtig ist das über eine `ruleFormulaVersion`/Snapshot-Version mit
   dokumentierter Migration — nicht als Nebenprodukt.
5. **Shorts.** Größte verbleibende Funktionslücke, kleinste Bereitschaft, sie
   zu schließen: Risiko, nicht Code. Ein Daytrader ohne Short ist in
   Abwärtsphasen auf Neutralität beschränkt.
6. **K-Fold, Ulcer-Index, `regime` als Regelfeld, Binomialtest** bleiben
   abgelehnt (Zeitreihen-Leak bzw. Doppel-Erklärung derselben Unsicherheit);
   siehe VBF-Tabelle im Vorläufer-Audit.
