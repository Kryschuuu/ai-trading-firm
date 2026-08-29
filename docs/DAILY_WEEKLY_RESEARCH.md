# Daily & Weekly Research — deterministischer Markt-Scanner (Task 04)

**Stand:** 2026-08-27 · **Modul:** `src/scanner/` · **API:** `/api/universe/*`
**Status:** Fundament-Umbau 4 von 12 — macht aus 10.000 Instrumenten eine begründete Tagesliste.

---

## 1. Zielbild

Task 01 hat definiert, *was* handelbar ist (Registry), Task 03 liefert *Kursdaten*.
Task 04 beantwortet die nächste Frage:

> **Welche 100 der 10.000 Instrumente sind heute überhaupt eine Analyse wert —
> und warum genau diese?**

Vier Prinzipien tragen das Modul:

| Prinzip | Bedeutung |
| --- | --- |
| **Kein LLM** | Der komplette Scan ist Arithmetik. Auch das News-Risiko ist eine Zählheuristik, kein Sprachmodell. Ein Architekturtest verbietet LLM-, DB-, Broker- und Netzwerk-Importe unter `src/scanner/**`. |
| **Determinismus** | Gleiche Eingabe ⇒ byte-identische Ausgabe. Kein `Math.random`, kein `Date.now()` im Kern (Zeit wird injiziert), stabile Sortierung, gerundete Ausgabewerte. |
| **Transparenz** | Jeder Score trägt sein vollständiges Breakdown: Faktor → Rohwert → normiert → Gewicht → Beitrag. Jede Ablehnung nennt die Regel, die gegriffen hat. |
| **Read-only** | Der Scanner liest Registry und Historie und schreibt ausschließlich Artefakte. Er ändert kein Instrument, keine Position, keine Order. |

**Abgrenzung:** kein Live-Trading, keine Orderentscheidung, keine LLM-Synthese des
Weekly Reviews (die kommt in einem späteren Task und konsumiert das hier erzeugte JSON).

---

## 2. Pipeline

```text
            ┌──────────────────────────┐        ┌─────────────────────────┐
            │ Instrument-Registry      │        │ Historical Store        │
            │ (Task 01, NDJSON)        │        │ (Task 03, OHLCV NDJSON) │
            └────────────┬─────────────┘        └────────────┬────────────┘
                         │  MarketInstrument[]                │ MarketCandle[]
                         └───────────────┬────────────────────┘
                                         ▼
                         ┌───────────────────────────────┐
                         │ scanUniverse()  pipeline.ts   │  asOf wird injiziert
                         └───────────────┬───────────────┘
                                         ▼
   ① Faktoren        14 Module × je 1 FactorValue        (factors/*, cache.ts)
                     raw · normalized ∈ [0,1] · available · detail
                                         ▼
   ② Regime          annualisierte RV → LOW/NORMAL/HIGH/EXTREME        (regime.ts)
                                         ▼
   ③ Filter          10 Regeln, erste Regel gewinnt → Rejection        (filters.ts)
                                         ▼
   ④ Score           9 gewichtete Komponenten → 0…100 + Breakdown      (ranker.ts)
                                         ▼
   ⑤ Trichter        10.000 → 2.000 → 500 → 100 → 20–40 (Deep)         (funnel.ts)
                                         ▼
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
 artifacts/<datum>/            classifyWeekly()                 GET /api/universe/
 universe.json                 CORE · ROTATION ·                daily · weekly ·
 weekly.json                   DISCOVERY · EXCLUDED             score/{id}
 (artifacts.ts)                (weekly.ts)                      (read-only, paginiert)
```

Einstiegspunkte:

| Ebene | Aufruf |
| --- | --- |
| Bibliothek | `scanUniverse({ instruments, data, asOf, config, cache })` → `ScanResult` |
| Service | `getScannerService().getScan() / .getWeekly() / .scoreFor(id)` |
| CLI | `npm run scan` (schreibt Artefakte) · `npm run scan -- --dry` |
| HTTP | `GET /api/universe/daily`, `/weekly`, `/score/{instrumentId}` |

---

## 3. Faktor-Katalog

Alle 14 Module implementieren dasselbe Interface:

```ts
interface Factor<C = unknown> {
  readonly id: FactorId;
  compute(input: FactorInput, config: C): FactorValue;
}

interface FactorValue {
  raw: number | null;        // Rohwert in Fachnotation (null = nicht berechenbar)
  normalized: number;        // 0…1, „höher ist besser“ — immer definiert
  available: boolean;        // false ⇒ Neutralwert, dokumentiert je Faktor
  detail: Readonly<Record<string, number | string | boolean | null>>;
}
```

| # | Faktor | Formel (Kurzform) | Datenbedarf | Normalisierung | Score-Gewicht |
| --- | --- | --- | --- | --- | --- |
| 1 | `liquidity` | `raw = volume24h` (Fallback `volume × close` der letzten Kerze) | Registry **oder** ≥ 1 Kerze | logarithmisch `log10(v/1e5)/log10(1e10/1e5)` | **25 %** |
| 2 | `spread` | `raw = (ask−bid)/mid` | Registry `spread` | invers linear `1e-4 → 1`, `5e-3 → 0` | **10 %** |
| 3 | `atr` | `TR = max(h−l, |h−c₋₁|, |l−c₋₁|)`, Wilder-RMA(14), `/close` | ≥ 15 Kerzen (H/L/C) | Trapez `0.002 / 0.01 … 0.04 / 0.12` | Diagnose |
| 4 | `volatility` | `σ = std(ln(cₜ/cₜ₋₁))` über 30, `raw = σ·√365` | ≥ 3 Kerzen | Trapez `0.05 / 0.2 … 0.8 / 2.5` | **15 %** |
| 5 | `momentum` | `Σ wₗ·(cₜ/cₜ₋ₗ − 1) / Σ wₗ`, L = 5/20/60, w = 0.2/0.3/0.5 | ≥ 6 Kerzen | `absolute`: `|raw|/0.3`, geklemmt | **10 %** |
| 6 | `trend` | EMA 9/21/50, `raw = (EMAf − EMAs)/EMAs` | ≥ 50 Kerzen | `aligned ? 0.5+0.5·s : 0.5·s`, `s = min(|raw|/0.1, 1)` | **15 %** |
| 7 | `volumeRatio` | `Ø vol(5) / Ø vol(20)` | ≥ 20 Kerzen mit Volumen | linear `0.5 → 0`, `2.0 → 1` | **10 %** (`volume`) |
| 8 | `rsi` | Wilder-RSI(14), `100 − 100/(1+RS)` | ≥ 15 Kerzen | Überhitzungsfilter `1 − clamp((|RSI−50|−20)/30)` | Diagnose |
| 9 | `drawdown` | `max((peakₜ − cₜ)/peakₜ)` über 60 | ≥ 2 Kerzen | invers linear `0 → 1`, `0.5 → 0` | Diagnose |
| 10 | `correlation` | Pearson (opt. Spearman) der letzten 30 gemeinsamen Log-Renditen vs. Benchmark | ≥ 3 gemeinsame Kerzen | `1 − |r|` (Diversifikationsnutzen) | **5 %** |
| 11 | `news` | `0.08·e24h + 0.02·e7d + 0.2·hi + 0.3·termin≤48h + 0.2·stale`, geklemmt | optionaler Zähler-Kontext + `lastSeen` | `1 − raw`; ohne Kontext Risiko 0.25 | **5 %** |
| 12 | `funding` | `|fundingRate| × 8760/intervalHours` (sonst 1095) | `DerivativeContext.fundingRate` | invers linear `0 → 1`, `0.5 p. a. → 0`; Spot = 1 | Diagnose |
| 13 | `openInterest` | `raw = openInterest` (Quote) | `DerivativeContext.openInterest` | logarithmisch `1e5 → 0`, `5e9 → 1`; Spot = 0.5 | Diagnose |
| 14 | `executionCost` | `2×takerFee (+ spread)` Roundturn, Modi `taker|maker|blend` | Registry-Gebühren (+ Spread) | invers linear `5 bp → 1`, `50 bp → 0` | **5 %** (`execution`) |

**Neutralwerte bei `available: false`:** in der Regel `0` (Unwissen darf nie belohnen).
Ausnahmen mit fachlicher Begründung: `correlation` 0.5, `openInterest` 0.5,
`funding` 0.5 (Spot 1), `news` 0.75.

**Edge Cases** (per Test abgedeckt): leere Serie, Einzelwert, konstante Preise,
`NaN`/`Infinity` in Kerzen, Nullvolumen, fehlende Registry-Felder, Benchmark ohne
Überschneidung. In allen Fällen gilt `normalized ∈ [0,1]`, niemals `NaN`.

**Caching:** `FactorCache` (`cache.ts`) memoisiert je `(instrumentId, factorId,
Datenfingerprint)`. Ein zweiter Lauf über dieselben Daten kostet in der Messung
rund ein Fünftel des ersten (24 ms statt 136 ms bei 2.000 Instrumenten).

---

## 4. Market Score

Neun der 14 Faktoren tragen Gewicht; die fünf Diagnose-Faktoren fließen in
Filter, Stops und Weekly-Begründungen ein, nicht in die Note.

| Komponente | Faktor | Gewicht |
| --- | --- | --- |
| Liquidity | `liquidity` | **25 %** |
| Volatility | `volatility` | **15 %** |
| Trend | `trend` | **15 %** |
| Momentum | `momentum` | **10 %** |
| Spread | `spread` | **10 %** |
| Volume | `volumeRatio` | **10 %** |
| Correlation | `correlation` | **5 %** |
| News | `news` | **5 %** |
| Execution | `executionCost` | **5 %** |
| **Summe** | | **100 %** |

```text
contribution = round(weight × normalized × 100, 10)
score        = round(Σ contribution, 10)        ∈ [0, 100]
```

Die Gewichte stehen ausschließlich in der versionierten Datei
`src/scanner/scanner.config.json` (`version: 1`); ein Test erzwingt die Summe 1.0
und die exakten Einzelwerte. Overrides sind über `SCANNER_CONFIG_FILE` möglich —
jede geladene Konfiguration wird validiert (Bereichs- und Summenprüfung) und mit
ihrer `version` in Artefakte und API-Antworten geschrieben.

**Breakdown** (Beispielausschnitt aus `/api/universe/score/BINANCE:BTCUSDT`):

```json
{
  "component": "liquidity",
  "factorId": "liquidity",
  "raw": 1000000000,
  "normalized": 0.8,
  "available": true,
  "weight": 0.25,
  "contribution": 20
}
```

---

## 5. Volatilitätsregime

Grundlage ist die annualisierte realisierte Volatilität aus Faktor 4.

| Regime | Bedingung (annualisiert) | Lesart |
| --- | --- | --- |
| `LOW` | `rv < 0.25` | zu ruhig — wenig Chance, enge Ranges |
| `NORMAL` | `0.25 ≤ rv < 0.60` | Arbeitsbereich der meisten Strategien |
| `HIGH` | `0.60 ≤ rv < 1.20` | erhöhtes Risiko, Positionsgröße reduzieren |
| `EXTREME` | `rv ≥ 1.20` | Filter greift: Instrument fliegt aus dem Trichter |

Schwellen: `regime.low/normal/high` in `scanner.config.json`. Fehlende oder
ungültige Volatilität ⇒ `NORMAL` (konservativ neutral, nie stillschweigend `LOW`).

---

## 6. Trichter

| Stufe | Ziel­größe | Regel | Konfiguration |
| --- | --- | --- | --- |
| Rohuniversum | ~10.000 | alles, was die Registry liefert | – |
| **Eligible** | ≤ 2.000 | 10 harte Eignungs-/Risikofilter | `funnel.eligibleMax` |
| **Interesting** | ≤ 500 | Score ≥ 55 | `funnel.interestingMax/interestingMinScore` |
| **Daily** | ≤ 100 | Top-N der Interesting-Liste | `funnel.dailyMax` |
| **Deep** | 20–40 | Daily + max. 8 je Anlageklasse | `funnel.deepMin/deepMax/maxPerAssetClass` |

Sortierung überall: **Score absteigend, bei Gleichstand `instrumentId` aufsteigend** —
damit ist die Auswahl reproduzierbar und unabhängig von der Eingabereihenfolge.

Erreicht die Diversifikationsregel `deepMin` nicht, wird das Klassenlimit
schrittweise um 1 erhöht; das Ergebnis trägt dann `diversificationRelaxed: true`.

### 6.1 Filterregeln (Reihenfolge = Priorität)

| # | `ruleId` | Bedingung für Ablehnung | Schwelle |
| --- | --- | --- | --- |
| 1 | `status-active` | Status ≠ `active` | `requireStatusActive` |
| 2 | `paper-available` | `paperAvailable` = false | `requirePaperAvailable` |
| 3 | `market-type` | Markttyp nicht erlaubt | `spot`, `perpetual`, `future` |
| 4 | `asset-class` | Anlageklasse nicht erlaubt | 6 Klassen |
| 5 | `min-candles` | zu wenig Historie | 30 |
| 6 | `min-volume` | `volume24h` zu klein/unbekannt | 1 000 000 |
| 7 | `max-spread` | Spread zu breit/unbekannt | 0.005 |
| 8 | `max-execution-cost` | Roundturn zu teuer | 0.006 |
| 9 | `max-drawdown` | Drawdown zu tief | 0.8 |
| 10 | `regime-extreme` | Regime `EXTREME` | `excludeExtremeRegime` |

Es gewinnt immer die **erste** greifende Regel; sie landet als
`{ instrumentId, ruleId, message, dataQuality }` in `scan.rejections` und
aggregiert in `scan.rejectionsByRule` (`dataQuality` seit v1.25.2,
nachgearbeitet zu PR #35). Unbekannte Werte führen zur Ablehnung
(Ausnahme: Drawdown ohne Historie wird bereits von `min-candles` erfasst).

`dataQuality: true` markiert Ablehnungen wegen **nicht geladener Daten**
(`min-candles`, `min-volume`, `max-spread`, `max-execution-cost`) — sie sind
mit einem Warmup-Lauf (`npm run market-sync`) behebbar und kein fachlicher
Marktausschluss; die Meldung nennt die fehlende Metrik („Spread wurde nicht
geladen …“). `false` ⇒ fachliche Ablehnung (Regeln 1–4 sowie zu kleines
Volumen, zu breiter Spread, zu hohe Kosten, Drawdown, Extrem-Regime).
Hintergrund: `docs/MARKET_DATA_PIPELINE.md` §3 und §8.

---

## 7. Weekly Universe Review

`classifyWeekly({ scan, instruments, previous })` vergleicht den aktuellen Scan mit
dem Vorwochen-Review und erzeugt für **jedes** Instrument genau einen validierten
Eintrag:

```json
{
  "instrumentId": "BINANCE:BTCUSDT",
  "class": "CORE",
  "reasons": ["score-70", "volume-50m", "persistence-4"],
  "score": 78.4,
  "asOf": "2026-08-27T00:00:00.000Z"
}
```

`validateWeeklyEntry()` erlaubt exakt diese fünf Schlüssel (max. 20 `reasons`) und
wirft sonst `WeeklyValidationError` — das Schema ist damit auch für die spätere
LLM-Synthese verbindlich.

| Klasse | Bedingung | Konfiguration |
| --- | --- | --- |
| `CORE` | Score ≥ 70 **und** `volume24h` ≥ 50 Mio. **und** Persistenz ≥ 1 | `weekly.coreMin*` |
| `ROTATION` | Score ≥ 55 | `weekly.rotationMinScore` |
| `DISCOVERY` | Score ≥ 40 **oder** Neulistung | `weekly.discoveryMinScore` |
| `EXCLUDED` | Filterablehnung, Score darunter, Delisting, Liquiditätseinbruch, Gebührensprung, Broker weg | `weekly.liquidityDropPct`, `feeIncreasePct` |

**Persistenz** = Anzahl aufeinanderfolgender Reviews mit Klasse ≠ `EXCLUDED`
(Reset bei Ausschluss). Damit ist der Pfad `DISCOVERY → ROTATION → CORE` möglich.

**Änderungsblock** `changes`: `newListings`, `delistings`, `liquidityDrops` (> 50 %
Rückgang), `feeIncreases` (> 50 % Anstieg), `brokerUnavailable`, `regimeShifts`,
`correlationClusters` (|r| ≥ 0.9 zum Benchmark).

---

## 8. Artefakte

```text
artifacts/
└── 2026-08-27/
    ├── universe.json   Tagesabzug inkl. Score-Breakdowns
    └── weekly.json     Weekly Review (Klassen, Gründe, Änderungen)
```

`universe.json` enthält `schemaVersion`, `generator`, `configVersion`, `asOf`,
`weights`, `funnel`-Größen, die Ebenen `deep`/`daily` **mit** Breakdown,
`interesting`/`eligible` als ID-Listen sowie `rejections { total, byRule }`.

Geschrieben wird atomar (`tmp` + `rename`, Modus 0644), JSON mit 2 Leerzeichen
Einrückung und abschließendem `\n`. **Wiederholte Läufe erzeugen byte-identische
Dateien** (per Test geprüft). Verzeichnis über `SCANNER_ARTIFACTS_DIR`
umstellbar; `artifacts/` ist bewusst **nicht** versioniert (aus Registry +
Historie jederzeit reproduzierbar).

---

## 9. API-Referenz

Alle Endpunkte sind **read-only**, `dynamic = "force-dynamic"`, ohne Token-Pflicht
(wie die übrigen GET-Routen), mit harten Query-Limits gegen DoS.
Fehlerformat einheitlich `{ ok: false, error, message }`; 500er-Texte laufen durch
`publicErrorMessage()` und enthalten keine internen Details.

### 9.1 `GET /api/universe/daily`

| Parameter | Typ | Default | Grenzen |
| --- | --- | --- | --- |
| `level` | `deep\|daily\|interesting\|eligible` | `daily` | Enum, sonst 400 |
| `page` | Ganzzahl | 1 | 1 … 100 000 |
| `pageSize` | Ganzzahl | 50 | 1 … **200** |
| `breakdown` | `true\|false\|1\|0` | `true` für `deep`/`daily` | nur für `deep`/`daily` möglich |

```json
{
  "ok": true,
  "asOf": "2026-08-27T00:00:00.000Z",
  "configVersion": 1,
  "level": "daily",
  "funnel": { "scanned": 10000, "eligible": 2000, "interesting": 500, "daily": 100, "deep": 40,
              "thresholds": { "interestingMinScore": 55, "maxPerAssetClass": 8 },
              "diversificationRelaxed": false },
  "weights": { "liquidity": 0.25, "…": "…" },
  "items": [{ "rank": 1, "instrumentId": "BINANCE:BTCUSDT", "assetClass": "crypto",
              "score": 78.4, "regime": "NORMAL", "breakdown": [ "…9 Einträge…" ] }],
  "page": 1, "pageSize": 50, "total": 100, "hasMore": true
}
```

### 9.2 `GET /api/universe/weekly`

| Parameter | Typ | Default | Grenzen |
| --- | --- | --- | --- |
| `class` | CSV aus `CORE,ROTATION,DISCOVERY,EXCLUDED` | alle | 1 … 4 Werte, max. 100 Zeichen |
| `page` / `pageSize` | Ganzzahl | 1 / 50 | wie oben (max. 200) |

Antwort: `{ ok, asOf, configVersion, summary, changes, items, page, pageSize, total, hasMore }`
mit `items[]` = validierte Weekly-Einträge.

### 9.3 `GET /api/universe/score/{instrumentId}`

* `instrumentId` URL-kodiert, max. 64 Zeichen; `~` wird als `/` interpretiert
  (`KRAKEN:BTC~USD` ⇒ `KRAKEN:BTC/USD`), Groß-/Kleinschreibung egal.
* Antwort `{ ok, asOf, configVersion, weights, score, levels, rejection }` —
  `score.breakdown` hat 9 Einträge, `score.factors` alle 14 Faktorwerte,
  `levels` sagt, in welchen Trichterstufen das Instrument steht,
  `rejection` nennt bei Ausschluss die greifende Regel (`ruleId`, `message`
  und `dataQuality` — fehlende Daten vs. fachlicher Ausschluss).
* Unbekannte ID ⇒ `404 { ok: false, error: "NOT_FOUND" }`, ungültige ⇒ `400`.

---

## 10. Benchmark

Messung auf der Referenzmaschine (`tests/scanner.benchmark.test.ts`, Node 20,
synthetische Instrumente mit je 120 Kerzen, seedbarer PRNG):

| Größe | Dauer | Durchsatz | Budget |
| --- | --- | --- | --- |
| 10.000 Instrumente (voller Scan) | **679 ms** | ~14 700 Instrumente/s | 15 min |
| + Artefakt + Weekly Review | **35 ms** | – | – |
| 2.000 Instrumente kalt / warm | 136 ms / **24 ms** | Cache-Effekt ≈ 5× | – |

Der Test schlägt fehl, wenn der 10.000er-Scan 15 Minuten überschreitet, und
protokolliert die Messwerte als `# [benchmark] …` in die Testausgabe.

---

## 11. Konfiguration & Kommandos

| Variable | Default | Zweck |
| --- | --- | --- |
| `SCANNER_CONFIG_FILE` | *(leer)* | Pfad zu einer Override-Konfiguration (validiert) |
| `SCANNER_ARTIFACTS_DIR` | `artifacts` | Zielverzeichnis der Tagesabzüge |
| `UNIVERSE_DATA_DIR` | `data/universe` | Quelle der Instrumente (Task 01) |

```bash
npm run scan                 # Scan + Artefakte für heute
npm run scan -- --dry        # nur rechnen, nichts schreiben
npm run test:coverage:scanner
```

Weitere Grenzen: `MAX_SCAN_INSTRUMENTS = 250 000` (Pipeline),
`MAX_SERVICE_INSTRUMENTS = 50 000` (Service-Ladepfad).

---

## 12. Offene Punkte

1. **Korrelationsmathematik** liegt lokal in `src/scanner/factors/correlation.ts`.
   Task 05 (Portfolio Analytics) existiert im Repo noch nicht; sobald er eine
   geprüfte Implementierung liefert, wird das Modul dorthin verschoben (im TSDoc markiert).
2. **News-Kontext** wird bislang nur injiziert, es gibt keinen Feed-Adapter —
   ohne Kontext gilt der dokumentierte Neutralwert.
3. **Derivate-Kontext** (`fundingRate`, `openInterest`) kommt ebenfalls von außen;
   Venue-Adapter sind Sache späterer Tasks.
4. **Weekly-Synthese durch ein LLM** ist bewusst nicht Teil dieses Tasks; das
   validierte JSON ist die Schnittstelle dorthin.
5. **Regime auf Marktebene** (Gesamtmarkt statt Instrument) fehlt noch — heute
   wird je Instrument klassifiziert.

---

## 13. Daily & Weekly Agent Cycle (Task 06)

**Stand:** 2026-08-27 · **Modul:** `src/cycle/` · **API:** `/api/analysis/*`
**Status:** Orchestrierung der Agenten-Routine (Task 6 von 12)

### 13.1 Zeitplan-Tabelle der Tagesroutine

Die Tagesroutine läuft in einer festen, exakten Reihenfolge. Alles Massenhafte läuft rein maschinell ohne LLM; LLM-Analysen erfolgen ausschließlich auf gerankten Shortlists (max. 40 Instrumente).

| Zeitfenster (UTC) | Schritt | Rolle / Agent | LLM-Erlaubnis | Input-Contract | Output-Contract & Code-Limits |
| --- | --- | --- | --- | --- | --- |
| **00:00–06:00** | Market Scanner | `MARKET_SCANNER` | **NEIN** (`llmAllowed: false`) | Universum (Registry) + OHLCV-Kerzen | `DailyUniverseArtifact` (Trichter: 10.000 → 2.000 → 500 → 100 Daily → 40 Deep) |
| **06:00–07:00** | Macro Analyst | `MACRO_ANALYST` (Cassini) | **JA** (`llmAllowed: true`) | Snapshot der 7 Pflicht-Assets: BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds | `MacroStepOutput`: Regime (`RISK_ON\|RISK_OFF\|MIXED`), Volatilität (`LOW\|NORMAL\|HIGH\|EXTREME`), Thesis |
| **07:00–08:00** | Market Selection | `MARKET_SELECTION` | **JA** (`llmAllowed: true`) | Scanner-Levels (Daily/Deep) + Macro-Regime | `SelectionStepOutput`: Daily Candidate List, **hart gedeckelt auf ≤ 40 Instrumente** |
| **08:00–09:00** | Technical Analyst | `TECHNICAL_ANALYST` (Kepler) | **JA** (`llmAllowed: true`) | Daily Candidate List (**Code-Limit: max. 40**) | `TechnicalStepOutput`: Multi-Timeframe-TA (15m/1h/4h), Bias, Scores, Key-Levels, Thesis |
| **09:00–10:00** | News Analyst | `NEWS_ANALYST` (Hubble) | **JA** (`llmAllowed: true`) | Top-40 Instrumente + Systemische News (**Payload-Trennung**) | `NewsStepOutput`: Sentiment, Impact-Score, Risk-Flags, Systemic Risk Level |
| **10:00–11:00** | Risk Manager | `RISK_MANAGER` (Rigel) | **JA** (`llmAllowed: true`) | Top-40 TA + News + Korrelationsmatrix (Task 05) | `RiskStepOutput`: `approvedCandidates`, `rejectedCandidates` mit Gründen, Klumpenrisiko-Warnungen |
| **danach** | Research | `RESEARCH` (Rhea) | **JA** (`llmAllowed: true`) | Freigegebene Kandidaten des Risk Managers | `ResearchStepOutput`: Konkrete Setups (Entry/SL/TP/Thesis) — **AUSSCHLIESSLICH VORSCHLÄGE (`isProposal: true`)** |
| **danach** | Backtest-Verifikation | `BACKTEST_VERIFICATION` (Milo) | **NEIN** (`llmAllowed: false`) | Research-Setups + Historische Kerzen | `BacktestStepOutput`: Max Drawdown, Profit Factor, Sharpe Ratio, Sortino Ratio, Regime-Robustheit |

### 13.2 Shortlist-Limits als harte Code-Schranken

- Das Limit von maximal **40 Instrumenten** für rechenintensive LLM-Schritte (`TECHNICAL_ANALYST`, `NEWS_ANALYST`) ist eine **nicht aufweichbare Code-Schranke** (`MAX_SHORTLIST_LIMIT = 40`).
- Bei Übergabe von mehr als 40 Instrumenten (z. B. 41) wirft `assertShortlistLimit()` einen `ShortlistLimitExceededError`. Die Validierung bricht sofort ab; kein Modellaufruf wird gestartet.
- Der Market Selection Agent klemmt jede Kandidatenliste im Code via `assertShortlistLimit` auf höchstens 40 Einträge.

### 13.3 Prompt-Injection-Schutz & Datentrennung

- Externe Daten (RSS-Nachrichten, Kurse, Broker-Meldungen) werden niemals als Prompt-Anweisungen interpretiert.
- Sie werden ausschließlich in strukturierter Form über `wrapUntrustedData()` in einen expliziten Sicherheits-Container (`type: "untrusted_external_data"`) verpackt.
- Alle Agent-Outputs werden gegen strenge TypeScript- und JSON-Schemas validiert (`validateMacroOutput`, `validateSelectionOutput`, `validateTechnicalOutput`, `validateNewsOutput`, etc.).
- Nicht-konforme oder bösartige Modellausgaben (z. B. Injektionen wie `"hack": true` oder fremde Schlüssel) werden sofort verworfen, geloggt und durch einen sicheren, deterministischen Fallback ersetzt.

### 13.4 Weekly Universe Review (1× wöchentlich)

Der wöchentliche Review (`src/cycle/weekly.ts`) bewertet das gesamte Universum an einem konfigurierbaren Wochentag (Standard: Sonntag 00:00 UTC):
- **Eingaben:** Neue Listings, Delistings, Liquiditätsrückgänge (> 50 %), Gebührenerhöhungen (> 50 %), Broker-Verfügbarkeiten, Regimewechsel, Korrelations- und Volatilitätscluster, strukturelle Nachrichten.
- **Output-Schema:** Strikt validiertes JSON (`WeeklyReview` und `WeeklyClassificationEntry`):
  - `instrumentId`: Kanonische ID
  - `class`: `CORE` | `ROTATION` | `DISCOVERY` | `EXCLUDED`
  - `reasons`: Bis zu 20 nachvollziehbare Begründungen (`reasons[]`)
  - `score`: Market Score
  - `asOf`: ISO-8601-Zeitstempel
- **LLM-Synthese:** Ein `WEEKLY_REVIEW`-Agent fasst die Verschiebungen in einer Executive Summary und wöchentlichen Themenschwerpunkten zusammen.

### 13.5 Fehlertoleranz & Kontrollierter Abbruch

- **Step-Ebene:** Jeder Schritt besitzt eine konfigurierbare `RetryPolicy` (`maxAttempts`, `backoffMs`, exponentieller Multiplikator).
- **Zyklus-Ebene:** Scheitert ein Schritt nach Ausschöpfung aller Retries, bricht der Zyklus kontrolliert ab:
  - Der Zyklusstatus wechselt auf `FAILED`.
  - Ein kritischer Eintrag wird in das `audit_log` geschrieben (`CYCLE_STEP_FAILED`, `CYCLE_FAILED`).
  - **Bereits geschriebene Artefakte vorheriger Schritte bleiben uneingeschränkt gültig und integer.**
  - Nachfolgende Schritte werden nicht mehr ausgeführt.

### 13.6 Vorbereitung für LLM-Eskalation (`MODEL_ESCALATION_REQUEST`)

- Schritte dürfen bei komplexen Lagen ein Eskalations-Event emittieren:
  ```ts
  interface ModelEscalationRequest {
    agent: string;
    reason: string;
    complexity: "low" | "medium" | "high" | "critical";
    confidence?: number;
    timestamp: string;
  }
  ```
- **Fallback ohne Task-09:** Da der Model-Router (Task 09) noch nicht existiert, wird das Event im `audit_log` und in den Lauf-Metadaten protokolliert. Der Zyklus nutzt transparent die bestehende Provider-Fallback-Kette (`chatLlm`) — es kommt zu keinem Fehlverhalten.

### 13.7 Artefakt-Layout & Index-Manifest

```text
artifacts/
├── index.json                                     # Index-Manifest aller Daily- und Weekly-Läufe
├── YYYY-MM-DD/
│   └── daily/
│       ├── 01-market-scanner.json                 # Scan-Result & Trichter-Ebenen
│       ├── 02-macro-analyst.json                  # Cross-Market Regime & Assets
│       ├── 03-market-selection.json               # Daily Candidate List (max. 40)
│       ├── 04-technical-analyst.json              # Multi-Timeframe TA
│       ├── 05-news-analyst.json                   # News Sentiment & Systemic Risk
│       ├── 06-risk-manager.json                   # Korrelationen, Exposure & Allokation
│       ├── 07-research.json                       # Konkrete Setups (Vorschläge)
│       ├── 08-backtest-verification.json          # Verifikationskennzahlen (Sharpe, Sortino, etc.)
│       └── daily-summary.json                     # Gesamtzusammenfassung des Tageslaufs
└── YYYY-Www/
    └── weekly/
        ├── weekly-review.json                     # Vollständiger Review mit Changes & Context
        ├── universe-classification.json           # Kompakte Klassifikationsliste mit reasons[]
        └── weekly-summary.json                    # Zusammenfassung des Wochenlaufs
```

- **Atomares Schreiben:** Atomar via temporäre Dateien (`.tmp`) und anschließendes `renameSync`.
- **Retention:** Pruning alter Artefakte über `pruneArtifacts({ retentionDays, retentionWeeks })` mit automatischer Aktualisierung von `index.json`.

### 13.8 Read-only REST-API

| Endpunkt | Methode | Beschreibung |
| --- | --- | --- |
| `/api/analysis/daily/latest` | `GET` | Liefert den jüngsten Tageslauf inkl. Summary und Step-Artefakten |
| `/api/analysis/daily/{date}` | `GET` | Liefert den Tageslauf für ein bestimmtes Datum `YYYY-MM-DD` |
| `/api/analysis/weekly/latest`| `GET` | Liefert das jüngste wöchentliche Universe Review |
| `/api/analysis/runs`         | `GET` | Paginierte Historie aller Zyklen (`type=daily\|weekly\|all`, `status`, `page`, `pageSize`) |

