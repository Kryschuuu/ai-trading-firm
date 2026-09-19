# Status-Review der IN_PROGRESS-Findings — 2026-09-19

> **Umgesetzt in v1.51.1** (PR [#146](https://github.com/Kryschuuu/ai-trading-firm/pull/146), gleicher PR wie dieses Dokument): Alle
> Empfehlungen aus §12 sind angewendet — `TRACKING.md` führt alle zehn GAPs
> als `FIXED` (inkl. PR-Nummern), der GAP-04-Audit-Katalog ist nachgetragen
> (`tests/auditView.test.ts` 26/26 grün), Audit-README, `docs/README.md`,
> Finding GAP-04 und `.gitignore` sind synchron. Die Befunde unten
> beschreiben den Zustand **vor** diesem Fix (Stand `main` @ `8b5b36a`).

**Gegenstand:** [`TRACKING.md`](TRACKING.md) (Stand `main` @ `8b5b36a`, Code-Version 1.51.0).
**Frage:** Für jeden GAP mit Status `IN_PROGRESS`: Was ist umgesetzt, was fehlt,
und ist der Status noch korrekt?
**Methode:** Nicht nur Doku gelesen, sondern gegen den realen Codebestand
verifiziert — PR-Status via GitHub, Existenz aller referenzierten Artefakte,
Konfigurations-Flags in Code + `.env.example` + `CONFIGURATION.md`,
CHANGELOG-Einträge, Findings-„Umsetzung“-Abschnitte, und **Ausführung der
Test-Suite inkl. der DB-gegateten Tests** gegen eine lokal gestartete
PostgreSQL-18-Instanz (`embedded-postgres`, Schema via `drizzle-kit push`).

---

## 0. Ergebnis auf einen Blick

**9 von 10 GAPs stehen auf `IN_PROGRESS` — bei allen 9 ist der Status falsch
dokumentiert.** Alle zugehörigen PRs sind gemerged, alle Artefakte liegen in
`main`, alle GAP-Tests sind grün. Die Zeilen wurden schlicht nach dem Merge
nicht von `IN_PROGRESS` auf `FIXED` gezogen (Workflow-Schritt 3 in
`TRACKING.md`: „nach Merge `FIXED`“ — jede Notiz endet bereits mit
„FIXED nach Merge“).

| GAP | PR | Merge-Zeitpunkt (UTC) | Artefakte in `main` | GAP-Tests | Empfehlung |
|-----|----|----------------------|---------------------|-----------|------------|
| GAP-01 | [#145](https://github.com/Kryschuuu/ai-trading-firm/pull/145) | 2026-09-19 18:11 | ✅ vollständig | ✅ 33/33 (mit DB) | **→ FIXED** |
| GAP-03 | [#137](https://github.com/Kryschuuu/ai-trading-firm/pull/137) | 2026-09-18 19:15 | ✅ vollständig | ✅ 21/21 (mit DB) | **→ FIXED** |
| GAP-04 | [#142](https://github.com/Kryschuuu/ai-trading-firm/pull/142) *(fehlt in TRACKING)* | 2026-09-19 13:38 | ✅ vollständig | ✅ 28/28, **aber 1 Regression in Fremd-Suite** | **→ PARTIAL** (oder FIXED nach Mini-Fix) |
| GAP-05 | [#138](https://github.com/Kryschuuu/ai-trading-firm/pull/138) | 2026-09-18 21:22 | ✅ vollständig | ✅ 17/17 (mit DB, inkl. Multi-Instanz-Race) | **→ FIXED** |
| GAP-06 | [#140](https://github.com/Kryschuuu/ai-trading-firm/pull/140) *(fehlt in TRACKING)* | 2026-09-19 01:23 | ✅ vollständig | ✅ 63/63 | **→ FIXED** |
| GAP-07 | [#141](https://github.com/Kryschuuu/ai-trading-firm/pull/141) *(fehlt in TRACKING)* | 2026-09-19 10:57 | ✅ vollständig | ✅ 63/63 | **→ FIXED** |
| GAP-08 | [#143](https://github.com/Kryschuuu/ai-trading-firm/pull/143) | 2026-09-19 14:31 | ✅ vollständig | ✅ 45/45 + Eval-Harness 12/12 offline | **→ FIXED** |
| GAP-09 | [#144](https://github.com/Kryschuuu/ai-trading-firm/pull/144) *(fehlt in TRACKING)* | 2026-09-19 16:31 | ✅ vollständig | ✅ 17/17 + CLI-Lauf | **→ FIXED** |
| GAP-10 | [#139](https://github.com/Kryschuuu/ai-trading-firm/pull/139) | 2026-09-18 23:48 | ✅ vollständig | ✅ 32/32 | **→ FIXED** |

**Einziger echter Restdefekt:** GAP-04 hat vier neue Audit-Events eingeführt
(`POSITION_SIZING`, `POSITION_SIZING_UNKNOWN`, `CLUSTER_EXPOSURE_MONITOR`,
`CLUSTER_EXPOSURE_BLOCKED`), aber keines davon in den Audit-Katalog
(`AUDIT_EVENT_CATALOG` in `src/lib/auditView.ts`) eingetragen. Dadurch ist
`tests/auditView.test.ts` („Katalog: jedes im Code geschriebene Audit-Event
ist lesbar beschrieben“) seit dem Merge von #142 **rot auf `main`** — ein
Verstoß gegen Baseline-Regel R9 („`npm test` … 0 Failures“). Details in §4.

### Gesamt-Testlauf (Beleg)

```text
npm run typecheck      → 0 Fehler
npm run lint           → 0 Errors (4 pre-existing Warnings, unverändert)
npm run docs:validate  → OK, 8 Checks grün
npm test (MIT DB)      → 2439 Tests · 2436 pass · 3 fail · 0 skipped
```

Die 3 Failures:

| # | Test | Bewertung |
|---|------|-----------|
| 370 | `auditView` — Katalog: jedes Audit-Event lesbar beschrieben | **echter Defekt, GAP-04-Scope** (§4) |
| 1234 | `GET: ohne Datenbank 503 mit redaktierter Meldung` | Umweltartefakt — Test erwartet *keine* DB, in diesem Lauf war eine erreichbar |
| 2070 | `resolveSecretStorage: … db→file-Fallback (ohne DATABASE_URL)` | Umweltartefakt — **ENV-01**, in `TRACKING.md` bereits als OPEN dokumentiert; laut R9 zulässige Ausnahme bei erreichbarer DB |

Ohne DB (wie in den meisten Session-Sandboxen): 1 Failure (#370), 21 Skips.

---

## 1. Warum sind alle 9 Zeilen falsch?

Die Ursache ist prozessual, nicht technisch:

1. Der Workflow in `TRACKING.md` sieht vor, dass die Zeile *im PR* auf
   `IN_PROGRESS` gesetzt wird und *nach Merge* auf `FIXED`. Der zweite Schritt
   hat keinen Eigentümer — die Arena-Session endet mit dem PR, und der
   Merge passiert danach durch einen Menschen.
2. `docs/README.md` (Zeile 90) ist bereits weiter als das Tracking und führt
   GAP-05 und GAP-10 als **FIXED**, während `TRACKING.md` („einzige
   Wahrheit“) sie noch als `IN_PROGRESS` führt → Doku-Doku-Diskrepanz.
3. `docs/audits/2026-09-18-feature-gap/README.md` führt im Findings-Index
   **alle 10 GAPs noch als `OPEN`** und im Header „**Status:** OPEN“ — auch
   GAP-02, das im Tracking seit v1.42.0 FIXED ist.
4. Vier Zeilen (GAP-04, -06, -07, -09) tragen nur den Branch, keine
   PR-Nummer — obwohl die PRs (#142, #140, #141, #144) existieren und
   gemerged sind. Die Legende verlangt für `FIXED` „Version + PR belegt“.

**Wichtige Kontext-Erkenntnis:** Die CI (`.github/workflows/main.yml`) führt
nur `typecheck` + `docs:validate` aus, **nicht `npm test`**. Mehrere PRs
verweisen aber darauf, dass die Suite „in der CI läuft“ (#142 wörtlich:
„`npm test` bewusst nicht lokal ausgeführt — läuft in der CI“; #140:
„auf Anweisung der Session übersprungen“). Dieses Sicherheitsnetz existiert
nicht — genau deshalb konnte die GAP-04-Regression bis heute in `main` bleiben.

---

## 2. GAP-01 — Backtesting-Engine mit Walk-Forward-Validierung

**Zusammenfassung des GAPs:** Der Backtest-Step fiel bei < 5 Kerzen auf eine
*synthetische* Bewertung zurück („erzeugte statt gemessener Performance“);
es fehlten Walk-Forward (IS/OOS), Zeitmasken-Architektur, dasselbe
Kostenmodell wie im Paper-Betrieb und persistierte, vergleichbare Runs.

### 2.1 Was wurde umgesetzt (verifiziert in `main`)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Engine mit Paper-Kostenmodell | `src/backtest/paperExecution.ts` (335 Z.) | vorhanden; Tests belegen Identität `fillEntry == new FillSimulator().simulate` und dieselbe `computeFunding`-Formel wie der Paper-Monitor |
| D2 Walk-Forward | `src/backtest/walkforward.ts` (443 Z.) | vorhanden; Flags `WF_IS_WINDOW_DAYS`/`WF_OOS_WINDOW_DAYS`/`WF_MAX_SPAN_DAYS` in Code, `.env.example`, `CONFIGURATION.md` |
| D3 Persistenz + Zugriff | `drizzle/2026-09-19_backtest_runs.sql`, `src/backtest/runStore.ts`, `scripts/run-backtest.ts` (`npm run backtest`), `GET /api/firm/backtests` + `/[id]` | vorhanden; Tabelle `backtest_runs` entsteht per `drizzle-kit push`; CLI-Hilfe läuft; kein POST-Endpunkt (wie gefordert) |
| D4 Fallback entfernt | `src/cycle/steps/backtestStep.ts` | `< 5` Kerzen ⇒ `verified=false`, `DATA_UNAVAILABLE`, `data:insufficient-candles:<n>-of-5-minimum`, `CYCLE_STEP_SKIPPED`-Audit |
| Tests | `tests/backtest.engine.test.ts` (29), `tests/backtest.step.nosynthetic.test.ts` (4) | **33/33 grün mit DB** (ohne DB: 31 pass, 2 DB-Skips) |
| Docs | `docs/BACKTESTING.md`, `docsCatalog`-Eintrag `backtesting`, CHANGELOG 1.51.0 (feat + fix), `docs/README.md` 1.51.0 | vorhanden |
| Finding-Umsetzungsabschnitt | `findings/GAP-01-…md` §„Umsetzung (v1.51.0)“ | vorhanden |

### 2.2 Was fehlt noch

Nichts im Sinne der Akzeptanzkriterien (Lookahead-Test, IS/OOS-Determinismus,
Kostenmodell-Einbindung, Fallback-Entfernung, Checks grün, Docs + Changelog —
alles belegt). Im PR #145 dokumentierte, **bewusst** ausgeklammerte Punkte:

- `runMultiAssetBacktest` (Alt-Code aus Task 02) nutzt `Date.now()` für
  `lastTime` bei leerer Timeline — R8-Unschärfe im eingefrorenen Legacy-Pfad,
  nicht im neuen Paper-Pfad. Kandidat für Folge-PR.
- Funding-Raten im Backtest kommen aus dem statischen
  `PAPER_FUNDING_RATE_PCT_PER_8H`-Pfad — dieselbe offene Provider-Anbindung
  wie bei GAP-02 (dort ebenfalls als offen dokumentiert, Status trotzdem FIXED).

### 2.3 Klärung des Status

**Arbeit abgeschlossen, Status veraltet.** PR #145 wurde am 2026-09-19 18:11 UTC
gemerged; `main` = Merge-Commit von #145. Die TRACKING-Notiz endet mit
„FIXED nach Merge“ — der Merge ist erfolgt.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.51.0, PR #145). Die zwei
Offen-Punkte gehören in die Notiz-Spalte (wie bei GAP-02: „Offen: echte
Funding-Raten-Anbindung“), nicht in den Status.

---

## 3. GAP-03 — Trade-Journal mit Agenten-Attribution & Feedback-Loop

**Zusammenfassung des GAPs:** Rohdaten (Positionen, Proposals, Agenten-
Nachrichten, Audit) existierten, aber ohne Verknüpfung Position ↔
Entscheidungskette, ohne MAE/MFE-Auswertung nach Close, ohne Trefferquote je
Agent × Regime und ohne (begrenzte) Gewichts-Rückführung.

### 3.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Journal-Verknüpfung | `drizzle/2026-09-18_trade_journal.sql` → Tabellen `trade_journal` + `journal_agent_weights` (append-only) | vorhanden; Tabellen entstehen per Push; Schreibwege Eröffnung (Engine/Proposal/Mikro-Regel) + Close (Monitor/Flatten) inkl. UNKNOWN-Backfill per E2E-Test belegt |
| D2 MAE/MFE | `src/lib/journalMetrics.ts` | vorhanden; `CANDLE_GAP`/`NO_DATA` statt Schätzung (Tests) |
| D3 Auswertung | `src/lib/journalAnalytics.ts`, `GET /api/firm/journal` | vorhanden; Beta-Prior α=β=2, `JOURNAL_MIN_TRADES` (Default 20, Bounds [5, 200]) |
| D4 Rückführung | `JOURNAL_FEEDBACK_MODE` off (Default)/monitor/enforce | Flag in Code (3 Dateien), `.env.example`, `CONFIGURATION.md`; Bounds [0.5, 1.5], max Δ je Zyklus |
| Tests | `tests/tradeJournal.test.ts` (21) | **21/21 grün mit DB** (ohne DB: 17 pass, 4 Skips — genau die E2E-/Feedback-Tests) |
| Docs | `docs/HANDBUCH.md` §20, CHANGELOG 1.43.0 | vorhanden |
| Finding-Umsetzungsabschnitt | vorhanden (v1.43.0, PR #137) | ✅ |

Zusatzbeleg: GAP-04 (v1.48.0) konsumiert die Journal-Statistiken bereits als
Kelly-Edge-Quelle und GAP-05 schreibt den Exit-Grund ins Journal (Test
„GAP-05 Audit (DB): Journal-Zeile erhält den Exit-Grund“ grün) — das Journal
ist also produktiv in zwei nachgelagerte Features integriert.

### 3.2 Was fehlt noch

Nichts gegenüber den Akzeptanzkriterien (Attributions-Verknüpfung, MAE/MFE,
Glättung/Mindest-Stichprobe, Bounds auf Gewichte, append-only Migration —
alle mit Tests belegt). Im Finding bewusst ausgeklammert: Qualitäts-Degradierung
bei vielen `CANDLE_GAP`-Flags; Lernraten-Anpassung über Regime-Generationen.
Beides sind Verbesserungen, keine Lücken im Delta.

### 3.3 Klärung des Status

**Abgeschlossen, Status veraltet.** PR #137 gemerged 2026-09-18 19:15 UTC —
das ist der *älteste* offene IN_PROGRESS-Eintrag (über 24 h vor GAP-01). Die
Notiz sagt sogar noch „D1–D4 **in Umsetzung**“, was nicht mehr stimmt.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.43.0, PR #137); Notiz
„in Umsetzung“ → „umgesetzt“.

---

## 4. GAP-04 — Vol-Sizing + Korrelations-Exposure-Limits

**Zusammenfassung des GAPs:** Korrelations-/Cluster-Mathematik existierte
(`src/portfolio/correlation.ts`), war aber nicht als Guardrail im Order-Pfad
verdrahtet; Sizing war fix (`maxPositionPct`), kein ATR-basiertes Sizing,
kein Fractional-Kelly-Deckel.

### 4.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 ATR-/Vol-Sizing | `src/lib/positionSizing.ts` (412 Z.), `atr()` in `indicators.ts`, verdrahtet in `engine.ts` + `microExecutor.ts` | vorhanden; Flags `RISK_ATR_STOP_MULT`, `RISK_KELLY_FRACTION` (Default 0 = aus) dokumentiert |
| D2 Cluster-Guardrail | `src/lib/clusterExposure.ts` (567 Z.), importiert `correlationMatrix`/`correlationClusters` aus `src/portfolio` | vorhanden; `RISK_CORR_*`, `RISK_MAX_PER_CLUSTER`, `RISK_CLUSTER_LIMITS_MODE` (Default monitor) dokumentiert; Stale-Policy fail-closed |
| D3 Transparenz | `GET /api/firm/risk` | vorhanden |
| Tests | `tests/positionSizing.test.ts` (14), `tests/riskGuard.cluster.test.ts` (14) | **28/28 grün** (DB-frei) |
| Docs | CHANGELOG 1.48.0, `docs/PORTFOLIO_ANALYTICS.md` §10, CONFIGURATION, `.env.example` | vorhanden |
| Finding-Umsetzungsabschnitt | vorhanden (v1.48.0) | ✅ |

### 4.2 Was fehlt noch — **echter Restdefekt**

**Audit-Katalog-Regression (R6/R9-Verstoß):**

- GAP-04 schreibt vier neue Audit-Events:
  - `POSITION_SIZING` — `src/lib/engine.ts:957` via `logAudit(...)`
  - `POSITION_SIZING_UNKNOWN` — `src/lib/microExecutor.ts:697` via `ruleAudit(...)`
  - `CLUSTER_EXPOSURE_MONITOR` / `CLUSTER_EXPOSURE_BLOCKED` —
    `src/lib/clusterExposure.ts:541` via `auditWrite(event, …)`
- **Keines der vier** hat einen Eintrag in `AUDIT_EVENT_CATALOG`
  (`src/lib/auditView.ts`, 49 Einträge). Zum Vergleich: GAP-05 (`TRAILING_STOP_HIT`,
  `TIME_STOP_HIT`), GAP-06 (`REGIME_CHANGE`, `REGIME_GATE_APPLIED`) und
  GAP-03 (`JOURNAL_WRITE_FAILED`, `JOURNAL_WEIGHT_*`) haben ihre Events
  korrekt nachgetragen.
- Folge 1: `tests/auditView.test.ts` → „Diese Audit-Events haben keine
  deutsche Beschreibung: POSITION_SIZING, POSITION_SIZING_UNKNOWN“ — **rot
  auf `main`** seit Merge von #142. Der Test erkennt nur die beiden
  `logAudit`/`ruleAudit`-Literale; die `CLUSTER_EXPOSURE_*`-Events werden über
  eine Variable geschrieben und rutschen am Regex vorbei — sind aber genauso
  unbeschrieben.
- Folge 2 (funktional): Im Audit-Viewer fallen diese Einträge auf
  `UNKNOWN_EVENT_SPEC` zurück — kein Crash, aber die Risiko-Entscheidungen des
  neuen Guardrails (gerade die, die R6 „revisionssicher“ verlangt) werden dem
  Menschen ohne Erklärung/Kategorie/Headline angezeigt.
- Ursache: PR #142 hat `npm test` laut eigenem Testbericht „bewusst nicht
  lokal ausgeführt — läuft in der CI“; die CI führt `npm test` aber nicht aus.
  Die nachfolgenden PRs #143 und #145 haben den Failure jeweils als
  „pre-existing, GAP-04-Scope“ dokumentiert und regelkonform (R11) **nicht**
  mitgefixt — er wartet also auf einen Eigentümer.

**Fix-Umfang (klein, ~15 Min.):** Vier Einträge in `AUDIT_EVENT_CATALOG` im
Muster von `REGIME_GATE_APPLIED` (label, category `risk`, expectedLevel
`WARN`, description mit GAP-Verweis, headline/explain aus `symbol`, `code`,
`note` bzw. `clusterOfSymbol`/`count`/`limit`/`wouldBlock`). Danach ist
`tests/auditView.test.ts` grün und `npm test` ohne DB bei 0 Failures.

Sonstige, bewusst dokumentierte Abgrenzungen (kein Defekt): Kelly-Edge nur
aus Trade-Journal (`ruleExecutions` trägt kein P&L); Korrelationen aus dem
lokalen HistoricalStore statt Venue-REST.

### 4.3 Klärung des Status

**Hauptarbeit abgeschlossen (PR #142 gemerged 2026-09-19 13:38 UTC), aber die
R9-Bedingung „`npm test` … 0 Failures“ ist durch das eigene Delta verletzt.**
Nach der Legende passt `PARTIAL` („Teile umgesetzt, Rest mit Begründung
offen“) besser als `FIXED`.

**Empfehlung:** Entweder
(a) **sofort `PARTIAL`** (1.48.0, PR #142) mit Notiz „Audit-Katalog-Einträge
für `POSITION_SIZING`, `POSITION_SIZING_UNKNOWN`, `CLUSTER_EXPOSURE_MONITOR`,
`CLUSTER_EXPOSURE_BLOCKED` fehlen → `tests/auditView.test.ts` rot“, oder
(b) **Mini-Fix-PR** (4 Katalog-Einträge + CHANGELOG-Patch 1.51.1) und dann
direkt **`FIXED`**. Variante (b) ist zu bevorzugen — der Aufwand ist
minimal und `main` hat danach eine grüne Suite. PR-Nummer #142 in jedem Fall
nachtragen.

---

## 5. GAP-05 — Server-seitiges Exit-Management (Trailing/Time-Stop/OCO)

**Zusammenfassung des GAPs:** SL/TP-Watcher existierte im Monitor-Tick, aber
ohne Trailing-Stop, ohne Time-Stop, ohne belegte OCO-Exklusivität (genau ein
Exit bei parallelen Ticks) und ohne konfigurierbare Schwellen.

### 5.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Trailing-Stop | `src/lib/exits.ts` (`decideExit`, rein), `positions.trailing_armed`/`trailing_stop` (`drizzle/2026-09-18_exit_management.sql`) | vorhanden; Spalten per Push bestätigt; Restart-Persistenz getestet |
| D2 Time-Stop | `RISK_TIME_STOP_HOURS` (0 = aus, Bounds [0, 720]) | Flag in Code/Docs |
| D3 OCO-Exklusivität | atomarer DB-Claim `UPDATE … WHERE status='OPEN' RETURNING` (`applyExit()`) | vorhanden; **Multi-Instanz-Race-Test über zwei echte Postgres-Verbindungen grün** |
| D4 Konfiguration | `loadExitConfig()` mit Bounds-Clamp; alle Defaults aus = Byte-identisches Verhalten | Test „alle Flags aus → nur SL/TP wie bisher“ grün |
| Tests | `tests/monitor.exits.test.ts` (17) | **17/17 grün mit DB** (ohne DB: 9 pass, 8 Skips) |
| Docs | `docs/PAPER_TRADING.md` §3.3, CONFIGURATION „Exit-Management“, `.env.example`, CHANGELOG 1.44.0 | vorhanden |
| Finding-Umsetzungsabschnitt | vorhanden (v1.44.0, PR #138) | ✅ |

### 5.2 Was fehlt noch

Nichts gegenüber den Akzeptanzkriterien (Trailing-Aktivierung/Nachzug/
Restart, Time-Stop, Race-Test 2 Ticks → 1 Exit, Audit-Assertions — alle
belegt). Bewusst ausgeklammert (Finding): Stop-Hunting-Guard; OCO-Mapping an
echte Venues (Live-Gate, Paper-only-Scope); Trailing-Parameter je
Mission/Regime statt global.

Hinweis: Die DB-Tests dieses GAPs sind die einzigen, die die
Kern-Garantie (prozessübergreifend genau ein Exit) belegen. Da die CI
`npm test` nicht ausführt, sollte jede Änderung an `monitor.ts`/`exits.ts`
lokal **mit** DB getestet werden — sonst werden diese 8 Tests still
übersprungen.

### 5.3 Klärung des Status

**Abgeschlossen, Status veraltet.** PR #138 gemerged 2026-09-18 21:22 UTC.
`docs/README.md` führt GAP-05 bereits als „FIXED v1.44.0“ — nur `TRACKING.md`
hinkt nach.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.44.0, PR #138).

---

## 6. GAP-06 — Regime-Detection als Gate für Agenten-Gewichtung

**Zusammenfassung des GAPs:** Nur ein Vol-Regime (NORMAL/ELEVATED/EXTREME) als
Risikofaktor vorhanden; kein Trend/Range/Crash-Klassifikator, kein Gate, das
Strategieklassen je Regime dämpft, kein Ausweis im Ops-Center.

### 6.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Klassifikator | `src/lib/marketRegime.ts` (947 Z.), ADX (Wilder) in `indicators.ts` | vorhanden; Priorität CRASH > HIGH_VOL > TREND_* > RANGE; Hysterese `MarketRegimeStateMachine` |
| D2 Gate | `applyRegimeGate()`; `REGIME_GATE_MODE` off/monitor (Default)/enforce; verdrahtet in `engine.ts` (Z. 590–696) + `microExecutor.ts` (Z. 656) | vorhanden; kein Veto, nur Budget-Dämpfung |
| D3 Sichtbarkeit | Ops-Center (`src/ops/collect.ts`, `toneForMarketRegime`), `regime-history.json` (`src/cycle/artifacts.ts:170`), Audit `REGIME_CHANGE`/`REGIME_GATE_APPLIED` (**im Katalog eingetragen**) | vorhanden |
| Flags | `REGIME_LOOKBACK_CANDLES`, `REGIME_CONFIRM_CANDLES`, `REGIME_GATE_FACTORS`, `CRASH_DRAWDOWN_PCT`, `HIGH_VOL_PERCENTILE`, … | alle in Code + `.env.example` + `CONFIGURATION.md` |
| Tests | `tests/marketRegime.test.ts` + ADX in `tests/indicators.test.ts` | **63/63 grün** (DB-frei), inkl. Architektur-Test „kein LLM im Klassifikator“ |
| Docs | `docs/REGIME_GATE.md` (§6 Abweichungen), CHANGELOG 1.46.0 | vorhanden |
| Finding-Umsetzungsabschnitt | vorhanden (v1.46.0) | ✅ |

### 6.2 Was fehlt noch

Nichts gegenüber den Akzeptanzkriterien (Golden-Cases, Hysterese/Whipsaw,
Gate-Dämpfung, UNKNOWN-Pfad, Architektur-Test — alle belegt). Bewusst
ausgeklammert und in `docs/REGIME_GATE.md` §6 begründet: Anreicherung der
Zyklus-Steps (riskStep/selectionStep, bis zu 40 Kerzen-Abrufe je Lauf);
Strategieklasse kommt aus dem Mission-Template statt aus einem neuen
Schema-Feld (Regeln ohne Mission → Faktor 1).

Formales Manko: TRACKING-Zeile nennt keine PR-Nummer (ist **#140**). PR #140
hat `npm test` als Gesamt-Suite „auf Anweisung übersprungen“ — die betroffenen
Suites wurden einzeln grün gefahren; die heutige Gesamt-Suite bestätigt, dass
GAP-06 keine Regression hinterlassen hat.

### 6.3 Klärung des Status

**Abgeschlossen, Status veraltet.** PR #140 gemerged 2026-09-19 01:23 UTC.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.46.0, PR #140 nachtragen).

---

## 7. GAP-07 — Datenqualitäts-Layer & Multi-Timeframe-Konsistenz

**Zusammenfassung des GAPs:** MDERR-Taxonomie + Stale-Fallback vorhanden, aber
keine Gap-Detection, kein Outlier-/Plausibilitätsfilter, keine deterministische
1h→4h/1d-Aggregation, kein Zweitquellen-Cross-Check.

### 7.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Qualitätsprüfung | `src/marketdata/quality.ts` (821 Z.), MDERR-IDs `QUALITY_*`, `MARKETDATA_QUALITY_MODE` log (Default)/strict; verdrahtet in `scripts/run-scan.ts:160` + `src/scanner/service.ts:396` (`qualityStrictDataErrorsForScan`) | vorhanden |
| D2 Stale-Guard | `MARKETDATA_STALE_{1H,4H,1D}_HOURS` mit Bounds, Zähler im Sync-Status | Flags in Code/Docs |
| D3 Aggregation | `src/marketdata/aggregate.ts` (260 Z.), `market-sync --aggregate` / `MARKET_SYNC_AGGREGATE` (Default off) | vorhanden; CLI-Flag in `scripts/market-sync.ts:71/137/296` |
| D4 Cross-Check | Interface `getCrosscheckCandles()` + `MARKETDATA_CROSSCHECK` (off) + Toleranz | vorhanden — **nur Vertrag, keine Zweitquelle** (so im Prompt gefordert: „feature-flag-gated, Default off“) |
| Tests | `test/marketdata/quality.test.ts` (35), `aggregate.test.ts` (14), `cli.test.ts` | **63/63 grün** |
| Docs | CHANGELOG 1.47.0, CONFIGURATION, `.env.example` | vorhanden; PR #141 hat als einziger die **volle Suite mit 0 Failures** belegt (2318/2299/0) |
| Finding-Umsetzungsabschnitt | vorhanden (v1.47.0) | ✅ |

### 7.2 Was fehlt noch

Nichts gegenüber den Akzeptanzkriterien. Bewusst abgegrenzt (Finding, mit
Begründung): keine zweite Venue-Quelle angebunden (Rate-Limit-Budget je Venue
wäre eigener Schritt); aggregierte 4h/1d-Reihen haben noch keinen Konsumenten
(Scanner bleibt auf 1h); Stale-Zähler je Venue statt Symbol-Liste
(Security-Policy). Das sind Folge-Features, keine Lücken im Delta.

Formales Manko: PR-Nummer fehlt in der TRACKING-Zeile (ist **#141**).

### 7.3 Klärung des Status

**Abgeschlossen, Status veraltet.** PR #141 gemerged 2026-09-19 10:57 UTC.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.47.0, PR #141 nachtragen).

---

## 8. GAP-08 — LLM-Output-Validierung & Prompt-Eval-Harness

**Zusammenfassung des GAPs:** Schema-Validatoren existierten, aber keine
Plausibilitäts-Schicht (Monotonie, Preisband, Confidence↔Begründung,
Kurs-Halluzinationen), kein Golden-Dataset/Eval-Runner, mögliche
Turn-Budget-Lücken.

### 8.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Plausibilität | `src/cycle/plausibility.ts` (616 Z.), verdrahtet in Research- + Makro-Step via `spec.plausibility`; genau ein Retry, dann `CYCLE_STEP_SKIPPED plausibility:CODE` | vorhanden; Flags `PLAUSIBILITY_PRICE_BAND_PCT`, `PLAUSIBILITY_MIN_RATIONALE_CHARS` dokumentiert |
| D2 Eval-Harness | `scripts/eval-prompts.ts` (`npm run eval:prompts`), `tests/fixtures/golden/` (**12 Fixtures**: 3 macro + 9 research) | **Live ausgeführt:** `Modus=offline Fixtures=12 bestanden=12 regressionen=0`, Exit 0, JSON+MD-Report geschrieben |
| D3 Turn-Budget | `src/routing/turnBudget.ts`, `LLM_MAX_TOKENS_PER_TURN`/`LLM_MAX_TURN_MS`, Audit `llm-budget:*` | vorhanden |
| Tests | `tests/plausibility.test.ts` (25), `turnBudget.test.ts` (9), `evalPrompts.test.ts` (11) | **45/45 grün** |
| Docs | `docs/LLM_ROUTING.md` §17.1–17.3, CONFIGURATION, `.env.example`, CHANGELOG 1.49.0 | vorhanden |
| Finding-Umsetzungsabschnitt | vorhanden (v1.49.0) | ✅ |

### 8.2 Was fehlt noch

Nichts gegenüber den Akzeptanzkriterien (Validator-Gut/Schlecht, Retry-Policy,
Eval-Determinismus, Budget-Test, keine neue Dependency — alle belegt). Bewusst
ausgeklammert (Finding): Plausibilitätsregeln für weitere Steps
(Backtest/Schlussfolgerung nur Schema-geprüft); bekannte Heuristik-Fehlbefunde
bei Kennzahlen ohne Kursbezug; Token-Zählung = gemeldeter `routeChat`-Verbrauch;
kein LLM-as-Judge.

### 8.3 Klärung des Status

**Abgeschlossen, Status veraltet.** PR #143 gemerged 2026-09-19 14:31 UTC.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.49.0, PR #143).

---

## 9. GAP-09 — Reconciliation Broker ↔ DB + idempotente Order-IDs

**Zusammenfassung des GAPs:** `orderIntents` + Bitunix-Idempotenz teilweise
vorhanden, aber kein periodischer adapter-übergreifender Abgleich mit
Differenz-Klassifikation, kein Pause-Pfad, keine einheitliche
Client-Order-ID-Konvention, kein Paper-Invarianz-Selbsttest.

### 9.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Reconciliation-Job | `src/brokers/reconciliation.ts` (795 Z.), Scheduler in `src/instrumentation.ts:220–240` (`RECON_INTERVAL_MINUTES`, Busy-Guard), CLI `scripts/reconcile.ts` (`npm run reconcile`) | vorhanden; **CLI live ausgeführt:** erkannte gegen die Test-DB korrekt einen `BALANCE_MISMATCH` (Broker-Cash 10000 vs. DB-Snapshot 9839.79 — Testartefakt), Exit 1, Report unter `data/reconciliation/last-report.json` (gitignored) |
| D2 Pause-Pfad | `RECON_PAUSE_ON_MISMATCH` (Default false) → `killSwitch.pull("recon:<klasse>")` + CRITICAL-Audit + Alert; kein Auto-Flatten | vorhanden; Disarm bleibt Challenge-geschützt (Tests `disarmChallenge` 5/5 grün laut PR, Gesamt-Suite bestätigt) |
| D3 Client-Order-ID | `buildClientOrderId()` in `src/brokers/alpaca/execution.ts`, `bitunix/orders.ts`, `index.ts`; `submitWithIntent()` | vorhanden |
| D4 Paper-Invarianzen | Klasse `INVARIANT_VIOLATION` | vorhanden; Tests gesund vs. manipuliert |
| Tests | `tests/reconciliation.test.ts` (17) | **17/17 grün** (DB-frei; nutzt Mocks) |
| Docs | `docs/BROKER_ARCHITECTURE.md` §10, `docs/LIVE_TRADING.md` §12, CONFIGURATION, `.env.example`, CHANGELOG 1.50.0 | vorhanden |
| Finding-Umsetzungsabschnitt | vorhanden (v1.50.0) | ✅ |

### 9.2 Was fehlt noch

Nichts gegenüber den Akzeptanzkriterien (Klassifikations-Tests je Typ,
Pause-Flag, Idempotenz mit Mock-Timeout, Paper-Invarianz, Live-Gate
unangetastet). Dokumentiertes Rest-Delta (kein Defekt): kein generisches
`getOrders()` am `BrokerAdapter`-Vertrag (nur `reconcileOrder(orderId)`);
Stubs IBKR/BINANCE/KRAKEN/DYDX werfen weiter `NotSupportedCapabilityError`.

Formales Manko: PR-Nummer fehlt in der TRACKING-Zeile (ist **#144**). PR #144
hat nur die Delta-Suites belegt (17 + 7 + 5 Tests), keine Gesamt-Suite — der
heutige Gesamtlauf zeigt aber keine GAP-09-Regression.

### 9.3 Klärung des Status

**Abgeschlossen, Status veraltet.** PR #144 gemerged 2026-09-19 16:31 UTC.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.50.0, PR #144 nachtragen).

---

## 10. GAP-10 — Observability & automatische Circuit-Breaker

**Zusammenfassung des GAPs:** Telemetrie nur für Marktdaten-Fehler; kein
automatischer Kill-Switch bei Limit-Bruch (Grenzen blockierten nur neue
Orders), kein Alerting, kein Heartbeat/Stale-Alarm für den Monitor-Tick.

### 10.1 Was wurde umgesetzt (verifiziert)

| Delta | Artefakt | Befund |
|-------|----------|--------|
| D1 Firmen-Metriken | `prometheusMetrics()` async, `src/lib/firmState.ts` (server-only) | vorhanden |
| D2 Auto-Circuit-Breaker | `src/lib/circuitBreaker.ts` (451 Z.), verdrahtet in `src/lib/monitor.ts:326` (`checkCircuitBreaker`), Latching, `AUTO_CIRCUIT_BREAKER` Default on, `RISK_MAX_CONSECUTIVE_LOSSES` | vorhanden; Route verlangt Nonce (Test) |
| D3 Alerts | `src/lib/alerts.ts` (Log/File/Webhook-Sink, Debounce `ALERT_DEBOUNCE_MINUTES`, Secret nur aus Store) | vorhanden |
| D4 Heartbeat | `src/lib/heartbeat.ts`, `/api/health` liefert `monitorLastTickAt`/`monitorAgeMs`/`stale` (Route Z. 65–67), `scripts/watchdog.ts` (`npm run watchdog`) | vorhanden |
| Tests | `telemetry.firm` (7), `circuitBreaker` (12), `alertSink` (8), `health.heartbeat` (5) | **32/32 grün** |
| Docs | `docs/OBSERVABILITY.md` §9–12, `docs/OPERATIONS.md` Runbook, CONFIGURATION, `.env.example`, CHANGELOG 1.45.0 | vorhanden |
| Finding-Umsetzungsabschnitt | vorhanden (v1.45.0) | ✅ |

### 10.2 Was fehlt noch

Nichts gegenüber den Akzeptanzkriterien (Metrik-Snapshot, Breaker-Trigger →
ENGAGE + Audit, Re-Arm-Verweigerung ohne Challenge, Heartbeat-Stale,
Debounce — alle belegt). Dokumentierte Rest-Deltas (verifiziert, bewusst so
gelassen):

- **Kein `/api/metrics`-Scrape-Endpoint** — bestätigt: `src/app/api/metrics`
  existiert nicht; Exposition nur über `prometheusMetrics()`. Für einen echten
  Prometheus-Scrape ist das eine funktionale Lücke, im Prompt aber nicht
  gefordert (D1 = „`prometheusMetrics()` erweitern“).
- **Doppelter Drawdown-Pfad** — bestätigt: `src/lib/engine.ts:528–538` zieht
  bei `drawdownPct > maxEquityDrawdownPct` weiterhin selbst den Kill-Switch
  (Grund `DRAWDOWN x% > y%`, Audit `KILL_SWITCH`), parallel zum zentralen
  Brecher im Monitor-Tick. Idempotent (`!killSwitch.isArmed()`), aber je nach
  Reihenfolge zwei verschiedene Gründe im Audit. Zusammenführung ist
  Folge-Arbeit.
- Keine Hysterese/Cooldown am Brecher (bewusst Latching); keine
  Telegram/E-Mail-Zustellung.

**Kleiner Nebenbefund (neu, nicht in den PRs):** Der `FileAlertSink` schreibt
`data/alerts.ndjson` — dieser Pfad ist **nicht** in `.gitignore` (im
Gegensatz zu `/data/eval`, `/data/reconciliation`, `/data/backtest`, die von
GAP-08/-09/-01 korrekt eingetragen wurden). Ein lokaler Lauf hinterlässt eine
untracked Datei mit Betriebsalarmen im Arbeitsbaum. Einzeiler-Fix, kein
Status-Blocker.

### 10.3 Klärung des Status

**Abgeschlossen, Status veraltet.** PR #139 gemerged 2026-09-18 23:48 UTC.
`docs/README.md` führt GAP-10 bereits als „FIXED v1.45.0“.

**Empfehlung:** `IN_PROGRESS` → **`FIXED`** (1.45.0, PR #139). Rest-Deltas
in der Notiz belassen; `.gitignore`-Eintrag für `data/alerts.ndjson` als
Nebenpunkt.

---

## 11. Was ich nicht abschließend klären konnte

- **Live-Verhalten unter Produktionsdaten** (z. B. Regime-Klassifikation auf
  echten Kerzen, Cluster-Guardrail mit echtem HistoricalStore, Reconciliation
  gegen einen realen Broker) — dafür fehlen in der Sandbox Marktdaten und
  Venue-Zugang. Die Aussagen oben stützen sich auf Code, Unit-/Integrations-
  Tests mit synthetischen Fixtures und auf lokale DB-Tests.
- **Ob der Merge-Verantwortliche bewusst auf `FIXED` verzichtet hat** (z. B.
  „erst nach Beobachtung im Paper-Betrieb“) — dafür gibt es in `TRACKING.md`,
  den Findings und den PR-Texten keinen Hinweis; jede Notiz endet mit
  „FIXED nach Merge“. Ich gehe daher von einem vergessenen Schritt aus.
- Die exakten Testzahlen einzelner PRs (z. B. #137 „2158 Tests, 2 rot“) habe
  ich nicht historisch reproduziert; relevant ist der heutige Stand von `main`.

---

## 12. Empfohlene Änderungen (kompakt) — Umsetzungsstand v1.51.1

1. ✅ **`TRACKING.md`:** GAP-01, -03, -05, -06, -07, -08, -09, -10 → `FIXED`
   (Version + PR wie in der Tabelle in §0); GAP-04 → **`FIXED`** (Variante (b),
   Mini-Fix im selben Release). PR-Nummern #140, #141, #142, #144
   nachgetragen. GAP-03-Notiz „in Umsetzung“ → „umgesetzt“. Kopfvermerk +
   Workflow-Punkte 3/5 ergänzt.
2. ✅ **GAP-04-Nachfix (Patch-Release 1.51.1):** vier Einträge in
   `AUDIT_EVENT_CATALOG` (`src/lib/auditView.ts`) für `POSITION_SIZING`,
   `POSITION_SIZING_UNKNOWN`, `CLUSTER_EXPOSURE_MONITOR`,
   `CLUSTER_EXPOSURE_BLOCKED` + gemeinsame Sektions-Hilfsfunktion
   `clusterExposureSections()`; Render-Test ergänzt; Verifikation:
   `node --import tsx --test tests/auditView.test.ts` → 26/26 grün.
3. ✅ **Doku-Konsistenz:** `docs/audits/2026-09-18-feature-gap/README.md`
   (Findings-Index ×10 → `FIXED vX.Y.Z`, Header → FIXED, Abschnitt
   „Abschluss“), `docs/README.md` Zeile 90 („alle 10 FIXED“), Finding GAP-04
   („Nachtrag v1.51.1“).
4. ◐ **Prozess:** Workflow-Text in `TRACKING.md` stellt jetzt klar, dass
   `npm test` **nicht** in der CI läuft und der lokale Gesamtlauf der Beleg
   ist. **Nicht** umgesetzt (bewusst, eigener Scope): ein Test-Job in
   `.github/workflows/` — die Workflows sind SHA-gepinnt und in `docs/ci/`
   gespiegelt (SEC-10); eine Erweiterung gehört in einen eigenen, reviewten
   CI-PR.
5. ✅ **Nebenpunkte:** `.gitignore` um `/data/alerts.ndjson` ergänzt (GAP-10);
   ENV-01 bleibt wie dokumentiert OPEN.
