# Changelog — Autonome KI-Trading-Firma

> **Status-Header:** Konsolidierter Überblick · **2026-09-20** · Code-Version **1.51.2**. Vollständige, detaillierte Einträge je Release (Keep a Changelog + SemVer) — kanonische Datei im Root (ehemals `docs/CHANGELOG.md` als Duplikat, jetzt konsolidiert).

# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen an der Handelsplattform `ai-trading-firm`
werden in dieser Datei dokumentiert.

Das Format basiert auf
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).

## [1.51.2] — 2026-09-20 · test: Unit-Tests für sieben bisher ungetestete Kernmodule (112 Tests) · docs: Versionierung und Doku-Sync

### Hinzugefügt

- **Unit-Tests für verifizierte Testlücken (112 Tests, 7 neue Dateien unter
  `tests/`):** Systematische Abdeckungslücken-Analyse (jedes `src/`-Modul
  gegen alle Test-Importe gematcht) — getestet werden ausschließlich Module
  mit **null direkter Test-Abdeckung**, rein deterministisch und DB-frei
  (Repo-Konvention: `node:test` + `assert/strict`, kein Duplikat zu den
  bestehenden ~2.440 Tests; scheinbar ungetestete Kandidaten wie
  Walk-Forward oder MAE/MFE waren bereits über `backtest.engine.test.ts`
  bzw. `tradeJournal.test.ts` abgedeckt und wurden bewusst nicht doppelt
  getestet):
  - `tests/tokenCompare.test.ts` (15): timing-sicherer Token-Vergleich
    (`src/lib/tokenCompare.ts`, Sicherheitskern aller Schreib-Endpunkte und
    der RBAC-Auflösung; bisher nur ein Smoke-Test in `hardening.test.ts`):
    Längen-Padding ohne Throw (das nackte `timingSafeEqual` wirft bei
    ungleicher Länge), fail-closed bei leeren Werten (zwei leere Strings
    sind bewusst UNGLEICH), UTF-8-Byte-Semantik (é als Codepoint vs.
    kombinierender Akzent), 10k-Zeichen-Tokens und Alias-Identität des
    `apiAuth`-Re-Exports.
  - `tests/appPaths.test.ts` (29): Path-Traversal-Verteidigung
    (`src/lib/appPaths.ts`): `..`-Ausbrüche einfach/getarnt
    (`data/../..`)/Backslash-getarnt/tief (zählende Auflösung), absolute
    Pfade als Operator-Entscheidung, Segment-Einzelprüfung in
    `joinRuntimePath`, Redaktions-Garantien der Fehlermeldungen (kein
    Host-Pfad-Leak, 200-Zeichen-Cap, Steuerzeichen-Entfernung),
    Safe-Fallback fällt niemals auf den Ausbruchspfad.
  - `tests/envParsing.test.ts` (22): `envInt`/`envNumber` (`src/lib/env.ts`)
    vollständig — NaN/Infinity-Schutz, Bounds-Clamp, Truncation,
    Leerstring-Semantik-Differenz beider Funktionen und die sonst nirgends
    abgesicherte fail-laut-Warnpflicht von `envNumber` (jede Korrektur warnt
    genau einmal, Normalfall bleibt still; `console.warn` pro Test gemockt).
  - `tests/analysisContext.test.ts` (16): Portfolio-Analyse-Kontext für die
    LLM-Ebene (`src/portfolio/context.ts`): Strukturvertrag, Garantie
    „keine Gewichte im Kontext“ (Autoritätskette), Pearson-ρ ≈ ±1-Signale,
    alle `PortfolioError`-Pfade (`INVALID_INPUT`, `LENGTH_MISMATCH` × 2 mit
    Index-Diagnose), `summarizeAnalysisContext`-Kappung, Rundungs- und
    Mutationsfreiheit der Prompt-Helfer.
  - `tests/riskConfigView.test.ts` (16): `effectiveConfigView()` +
    `CONFIG_KEYS` (`src/lib/riskConfigService.ts`, DB-freier Teil):
    Metadaten-Vertrag (Vollständigkeit/Eindeutigkeit/Verankerung in
    `LIMIT_CEILINGS` + `DEFAULT_LIMITS`), Code-Ceilings als min/max des
    Views, Clamping von Ausreißern, adp.*-Namensraum getrennt und im
    Bounds-Fenster; dazu die Entschärfungs-Garantien: `requireStopLoss` ist
    dem Dashboard komplett entzogen UND bleibt nach einem
    `applyRuntimeLimits`-Abschaltversuch wirksam `true`.
  - `tests/version.test.ts` (4): Versions-SSoT (`src/lib/version.ts`) —
    `APP_NAME`/`APP_VERSION` exakt aus `package.json`, SemVer-Format
    (maschinenlesbar für Gateways).
  - `tests/ollamaModelTag.test.ts` (10): `resolveModelTag`
    (`src/lib/ollama.ts`) — exakter Treffer gewinnt vor der
    Familien-Heuristik, Familien-Ersatz bleibt in der Familie, keine
    Präfix-Verwechslung (`llama3` ≠ `llama32`, sonst liefe das System still
    mit dem falschen Modell), leere Modellliste und Case-Sensitivität.

### Verifikation

- 112/112 neue Tests grün; Gesamtsuite **2.552 Tests: 2.531 pass, 0 fail,
  21 skipped** (DB-gegatete Tests, Repo-Konvention `ping → skip`);
  `tsc --noEmit` (strict) und `eslint` fehlerfrei; `docs:validate` grün.
- Kein Laufzeitverhalten geändert (reine Test-/Doku-Ergänzung → Patch-Bump).

## [1.51.1] — 2026-09-19 · fix(audit): GAP-04-Audit-Events im Katalog nachgetragen · docs(audit): Feature-Gap-Remediation abgeschlossen (GAP-01…GAP-10 FIXED)

### Fixiert

- **Audit-Katalog (GAP-04-Nachtrag):** Die mit v1.48.0 eingeführten Events
  `POSITION_SIZING` (Engine), `POSITION_SIZING_UNKNOWN` (Mikro-Executor),
  `CLUSTER_EXPOSURE_MONITOR` und `CLUSTER_EXPOSURE_BLOCKED` (Cluster-Guardrail)
  hatten keinen Eintrag in `AUDIT_EVENT_CATALOG` (`src/lib/auditView.ts`).
  Folgen: `tests/auditView.test.ts` („Katalog: jedes im Code geschriebene
  Audit-Event ist lesbar beschrieben“) war seit dem Merge von PR #142 rot auf
  `main`, und die Sizing-/Guardrail-Entscheidungen erschienen im Audit-Viewer
  nur über den `UNKNOWN_EVENT_SPEC`-Fallback (ohne Label, Kategorie,
  Erklärung). Jetzt: vier Einträge (Kategorie `risk`, erwartete Stufe `WARN`)
  mit Headline, Erklärung und Fakten-Sektionen — Sizing: Instrument, Code
  `sizing:atr-unknown:SYMBOL`, Notiz (+ Regel-ID im Mikro-Pfad);
  Cluster-Exposure: Urteil (VIOLATION/STALE), Code
  (`cluster-exposure:max-per-cluster:N` / `cluster-exposure:correlation-stale`),
  Würde-blockieren-Flag, offene Positionen, Cluster + Zählung gegen
  `RISK_MAX_PER_CLUSTER`, wirksame Schwelle/Fenster, Datenstand der
  Korrelationsmatrix (fehlend ⇒ „fail-closed“ hervorgehoben). Neuer Render-
  Test in `tests/auditView.test.ts` (26 Tests, vorher 24/25).
  Warum es durchrutschte: PR #142 hat `npm test` nicht ausgeführt
  („läuft in der CI“) — die CI führt aber nur `typecheck` + `docs:validate`
  aus. Die Folge-PRs #143 und #145 haben den Failure regelkonform (R11) als
  „GAP-04-Scope“ notiert statt still mitzufixen.

### Geändert

- **Feature-Gap-Audit 2026-09-18 — Status abgeschlossen:**
  `docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md` führt jetzt
  **alle zehn Findings als `FIXED`** (GAP-02 v1.42.0 · GAP-03 v1.43.0 ·
  GAP-05 v1.44.0 · GAP-10 v1.45.0 · GAP-06 v1.46.0 · GAP-07 v1.47.0 ·
  GAP-04 v1.48.0 (+ Katalog-Nachtrag v1.51.1) · GAP-08 v1.49.0 ·
  GAP-09 v1.50.0 · GAP-01 v1.51.0) mit PR-Belegen (#136–#145; die bisher
  fehlenden Nummern #140/#141/#142/#144 nachgetragen). Neun Zeilen standen
  seit dem jeweiligen Merge fälschlich auf `IN_PROGRESS` — der Workflow-
  Schritt „nach Merge `FIXED`“ hatte keinen Eigentümer. Grundlage ist der
  Status-Review `remediation/STATUS-REVIEW-2026-09-19.md` (PR-Status,
  Artefakt-Existenz, Flags, Docs und **vollständiger Testlauf inklusive der
  DB-gegateten Suites** gegen eine lokale PostgreSQL-18-Instanz). Konsistent
  nachgezogen: Audit-README (Findings-Index + Status-Header), `docs/README.md`
  (Audit-Zeile), Finding GAP-04 („Nachtrag v1.51.1“). ENV-01 bleibt OPEN.
- **`.gitignore`:** `/data/alerts.ndjson` (append-only Datei-Sink des
  Alert-Dispatchers, GAP-10 v1.45.0) ist jetzt wie `/data/eval`,
  `/data/reconciliation` und `/data/backtest` von der Versionierung
  ausgeschlossen — ein lokaler Alarm hinterließ bisher eine untracked Datei
  mit Betriebsdaten im Arbeitsbaum.

## [1.51.0] — 2026-09-19 · feat(backtest): Regelbasierte Backtesting-Engine mit Walk-Forward-Fenstern, Paper-Ausführung & persistierten Runs (GAP-01)

### Hinzugefügt

- Paper-Ausführungspfad der Backtest-Engine (`src/backtest/paperExecution.ts`,
  `executionModel: "paper"`): Einstiegs- und Ausstiegs-Fills laufen durch
  DIESELBE deterministische `FillSimulator`-Klasse wie der PaperBroker
  (kein zweiter Kosten-Code-Pfad); Kerzen → Quotes via `snapshotFromLastPrice`
  über das Spread-Modell (Registry-Spread → kalibrierter Fallback); Funding
  über DIESELBE `FundingAccrualEngine`/`computeFunding`-Formel wie der
  Paper-Monitor (nur Registry-Perpetuals, sonst fail-safe Spot-Default).
  SL/TP-Trigger-Erkennung mit Stop-Vorrang bei Kollision.
- Walk-Forward-Validierung (`src/backtest/walkforward.ts`): rollierende
  IS/OOS-Fenster (`WF_IS_WINDOW_DAYS` Default 90, Bounds [14, 720];
  `WF_OOS_WINDOW_DAYS` Default 30, Bounds [7, 180]; `WF_MAX_SPAN_DAYS`
  Default 730, Bounds [30, 3650]), nur vollständige Fenster, OOS kachelt
  lückenlos/überlappungsfrei; Report je Fenster (Kennzahlen + sha256
  Trade-Hash) + OOS/IS-Aggregate (aus Summen neu berechnet); strikte
  Zeitmaske (Daten ≤ t, Fenster-Clips); Determinismus (zwei Läufe ⇒
  byte-identischer Report); fail-closed (`walkforward:insufficient-span`,
  `walkforward:no-candles`). Kennzahlen aus `src/portfolio` (keine Duplikate),
  kein LLM-Import (Architektur-Test).
- Run-Persistenz (`backtest_runs`, append-only, Migration
  `drizzle/2026-09-19_backtest_runs.sql`): ein Walk-Forward-Lauf = EINE Zeile
  mit `paramsJson` (Regel + Fenster + Kostenprofil), `metricsJson`
  (OOS/IS-Aggregate), `windowsJson` (Fensterdetails) und `codeVersion`.
- CLI `scripts/run-backtest.ts` (`npm run backtest`): Flags `--instrument`
  `--timeframe` `--from` `--to` `--rule-id`/`--rule-file` (XOR)
  `--is-days`/`--oos-days` `--skip-db`; schreibt Report-JSON +
  MD-Zusammenfassung nach `data/backtest/` und die `backtest_runs`-Zeile
  (fail-closed, Exit 1 bei Flag-/Regel-/Daten-/DB-Fehlern).
- Read-API `GET /api/firm/backtests` (Liste, `?limit=1..100`) und
  `GET /api/firm/backtests/[id]` (Detail, 404 wenn unbekannt): `firm.read`
  erforderlich (SEC-02-Muster, no-store), DB-Ausfall ⇒ 503 mit Hinweis.
  KEIN POST-Endpunkt — Runs entstehen nur via CLI.
- Neue Doku `docs/BACKTESTING.md` (Architektur, Zeitmaske, Kostenmodell,
  Walk-Forward, Persistenz, CLI-Referenz, Anti-Overfitting-Grenzen);
  Katalog-Eintrag (`docsCatalog`), Flags in `CONFIGURATION.md` +
  `.env.example`.

### Fixiert

- Synthetischer Fallback in Step 8 (`08-backtest-verification`) entfernt
  (Audit 2026-09-18, GAP-01 D4): Bei < 5 Kerzen gab es eine ERFUNDENE
  Mindestbewertung (u. a. Sharpe 1.0, Sortino 1.2, `verified=true`) statt
  einer Messung. Jetzt fail-closed: `verified=false`, sichtbarer Status
  `DATA_UNAVAILABLE`, neutrale Null-Kennzahlen, maschinenlesbarer Grund
  `data:insufficient-candles:<n>-of-5-minimum`, `CYCLE_STEP_SKIPPED`-Audit
  und WARN-Log; Summary zählt `unavailable`. Zugehörige Step-Tests
  sinngemäß auf den Fail-closed-Pfad umgestellt (Red/Green dokumentiert in
  `tests/backtest.step.nosynthetic.test.ts`).

## [1.50.0] — 2026-09-19 · feat(reconciliation): Periodischer Reconciliation-Job, Differenz-Klassifikation & idempotente Order-IDs (GAP-09)

### Added

- Periodischer Reconciliation-Job (`src/brokers/reconciliation.ts`, `runReconciliation`):
  Abgleich von Broker-Positionen, Account-Guthaben und Ledger ↔ DB (`positions`,
  `orderIntents`, `equity_snapshots`). Report-Generierung mit Persistenz nach
  `data/reconciliation/last-report.json` via `resolveRuntimePath()`.
- Reine Differenz-Klassifikation (`classifyDifferences`):
  - `PRICE_DRIFT`: Tolerierbar bei Kursdifferenzen innerhalb `RECON_PRICE_DRIFT_PCT`
    (Default 1 %, Bounds [0.01, 10]); wird nur reportet. Überschreitung gilt als kritisch.
  - `QTY_MISMATCH`: Positionsmengen- oder Richtungsabweichung (kritisch).
  - `PHANTOM_POSITION`: Position existiert nur am Broker, fehlt in der DB (kritisch).
  - `MISSING_POSITION`: Position existiert nur in der DB, fehlt am Broker (kritisch).
  - `BALANCE_MISMATCH`: Kassen- oder Equity-Abweichung (kritisch).
  - `INVARIANT_VIOLATION`: Bruch der Paper-Ledger-Invarianten (kritisch).
- Pause-Pfad (`RECON_PAUSE_ON_MISMATCH`, Default false):
  Bei kritischer Diskrepanz wird der prozessweite Kill-Switch aktiviert
  (`killSwitch.pull("recon:<klasse>")`), in `kill_switches` persistiert und ein
  `CRITICAL`-Alert über den AlertSink emittiert. Auto-Flatten ist strikt
  verboten; Re-Arm erfordert weiterhin die manuelle Challenge.
- Einheitliches Client-Order-ID-Schema `atf-<orderIntentId-kurz>` (`buildClientOrderId`):
  Deterministische Ableitung der `clientOrderId` aus der Order-Intent-ID für
  Bitunix- und Alpaca-Adapter. Retry nach Timeout wiederholt dieselbe ID,
  wodurch Venue- und lokale DB-Deduplizierung Doppel-Orders sicher verhindern
  (`submitWithIntent`).
- Paper-Invarianz-Selbsttest (D4):
  Automatische Prüfung aller Ledger-Invarianten (`freeCash >= 0`, `Summe Notional <= equity`,
  `fees >= 0`, keine negative Menge, `equity = freeCash + Summe Einstandswerte ± unrealizedPnl`).
  Verletzungen werden als `INVARIANT_VIOLATION` auditiert und alarmiert.
- CLI-Tool `scripts/reconcile.ts` (und npm run script `reconcile`):
  Ad-hoc-Reconciliation für beliebige Venues mit Report-Ausgabe und Statuscode-Signalisierung.
- Scheduler-Integration (`src/instrumentation.ts`):
  Periodischer Aufruf alle `RECON_INTERVAL_MINUTES` Minuten (Default 60, Bounds [5, 1440]).

## [1.49.0] — 2026-09-19 · feat(llm): Plausibilitäts-Schicht, Prompt-Eval-Harness & Turn-Budget (GAP-08)

### Added

- Plausibilitäts-Schicht nach der Schema-Validierung
  (`src/cycle/plausibility.ts`): Monotonie je Richtung (`MONOTONICITY`),
  Preisband um Known-Good-Kurse (`PRICE_RANGE`), Confidence-vs.-Begründung
  (`RATIONALE_MISSING`), regex-basierter Zahlenbezug (`HALLUCINATED_PRICE`).
  Strukturierte Befunde `{code, field, detail}`; genau EIN Retry mit
  Fehlermeldungs-Kontext, danach deterministischer Skip (leerer Fallback +
  `CYCLE_STEP_SKIPPED` mit Grund `plausibility:CODE`, z. B.
  `plausibility:MONOTONICITY,PRICE_RANGE`) + sichtbarer `plausibility`-Block
  in `07-research.json` / `02-macro-analyst.json`. In Research- und
  Makro-Step verdrahtet (`spec.plausibility`); auch eskalierte Antworten
  werden plausibilisiert (ohne weiteres Retry). Flags:
  `PLAUSIBILITY_PRICE_BAND_PCT` (15, [1, 90]),
  `PLAUSIBILITY_MIN_RATIONALE_CHARS` (40, [0, 1000], `0` = Regel aus).
- Prompt-Eval-Harness (`npm run eval:prompts`): Golden-Dataset mit 12
  Fixtures (`tests/fixtures/golden/<step>/*.json`), Offline-Default
  (deterministisch, byte-identisch), JSON- + MD-Reports nach `data/eval/`
  (`EVAL_OUTPUT_DIR`/`--out-dir`), Exit 0/1/2
  (bestanden/Regression/Fixture-Fehler), optionaler Provider-Rauchtest
  (`--provider`, nur mit explizitem Flag).
- Turn-Budget-Hartdeckel (`src/routing/turnBudget.ts`): `TurnBudget` je
  Agenten-Turn (Hauptaufruf + Retries) — `LLM_MAX_TOKENS_PER_TURN` (20000,
  [1000, 200000]) + `LLM_MAX_TURN_MS` (120000, [10000, 900000],
  Aufrufgrenzen-Prüfung). Überschreitung → `TurnBudgetExceededError` +
  Routing-Audit `llm-budget:tokens`/`llm-budget:time` (`budget_blocked`,
  Sicherheitsklasse); niemals Fallback-Umwandlung. Tages-Deckel und
  Einzelaufruf-Limits unverändert.

### Docs

- Neuer `docs/LLM_ROUTING.md`-Abschnitt 17 (Schicht/Eval-Harness/Turn-Deckel
  inkl. Heuristik-Grenzen), `CONFIGURATION.md`-Sektion („Plausibilität,
  Eval-Harness & Turn-Budget“), `.env.example`-Flags, Fixture-README mit
  Pflege-HowTo.

## [1.48.0] — 2026-09-19 · feat(risk): Vol-Sizing + Korrelations-Exposure-Limits im Order-Pfad (GAP-04)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-04](docs/audits/2026-09-18-feature-gap/findings/GAP-04-vol-sizing-correlation-limits.md))
begrenzte `riskGuard` `maxPositionPct` **fix** (LIMIT_CEILINGS-Konvention),
`adaptiveRisk` skalierte per Vol-Regime — aber es gab kein ATR-basiertes
Sizing, keinen Fractional-Kelly-Deckel, und die Cluster-Mathematik aus
`src/portfolio` war **nicht** als Guardrail im Order-Pfad verdrahtet: 5
„unabhängige“ Trades konnten in Wahrheit ein BTC-Beta-Trade sein. Dieses
Release schließt das Delta (PROMPT-04 der Remediation-Serie): Größe nach
Volatilität, Exposure nach Korrelations-Clustern — alles geklemmt, alles
fail-closed, Rollout bewusst **monitor-first** (Default: sichtbar machen,
keine Wirkung). Paper-only, keine neuen Runtime-Dependencies, keine
Schema-Änderung. Umsetzung: Branch `arena/01a0b953-ai-trading-firm`.

### Hinzugefügt

- **ATR-/Vol-basiertes Position-Sizing** (`src/lib/positionSizing.ts`,
  D1) — reine, deterministische Funktion `computePositionSize()`:
  `qty = (equity · riskPerTradePct) / |entry − stop|`. Stop-Auflösung:
  expliziter Stop (seitenkonsistent) → **ATR-Fallback-Stop**
  `entry − k·ATR` (`RISK_ATR_STOP_MULT`, Default 2, Bounds [0.5, 6]) →
  **UNKNOWN-Fallback** auf die heutige Basis-Größe (`defaultStopLossPct`)
  mit Kennzeichnung + Audit-Notiz (Muster adaptiveRisk v1.36.21 — kein
  Block, kein stiller Wert). **Fractional-Kelly als Obergrenze**:
  `maxNotional = equity · RISK_KELLY_FRACTION · f*`
  (`f* = (b·p − (1−p))/b` aus Trefferquote/Payoff des Trade-Journals,
  GAP-03; `RISK_KELLY_FRACTION` Default 0 = aus, Bounds [0, 1]; wirkt nur
  mit ausreichender Stichprobe, sonst dokumentiert wirkungslos;
  `f* ≤ 0` → keine Größe `kelly:no-positive-edge`). Ergebnis **immer** an
  die bestehenden Grenzen geklemmt (`maxRiskPerTrade` vor der Formel,
  `maxPositionPct`/Missions-Cap danach — Sizing verschärft, lockert nie);
  `equity`/`entry ≤ 0` → `RiskValidationError` (fail-closed). Verdrahtet in
  beiden Order-Pfaden: `src/lib/engine.ts` (LLM-Turn) und
  `src/lib/microExecutor.ts` (Regel-Executor, ATR aus der
  Rolling-Serie — Hot-Path bleibt I/O-frei).
- **`atr()` in Preiseinheiten** in `src/lib/indicators.ts` (einfache
  Wilder-Näherung, `null` bei unzureichender Historie — der Sizing-Pfad
  wertet das als UNKNOWN); `atrPct` rechnet jetzt darüber (Ergebnis
  unverändert).
- **Cluster-Exposure-Guardrail, Schicht 3** (`src/lib/clusterExposure.ts`,
  D2) — vor der Freigabe wird das neue Symbol gegen die **offenen
  Positionen** korrelationsgeclustert: `correlationMatrix` +
  `correlationClusters` **aus `src/portfolio` importiert** (keine
  Duplikation), logarithmische Renditen über gemeinsame Zeitstempel aus dem
  lokalen HistoricalStore (`1h`-Reihe, Fenster
  `RISK_CORR_WINDOW_CANDLES` Default 90, Bounds [30, 365]), Single-Linkage
  mit `|ρ| ≥ RISK_CORR_THRESHOLD` (Default 0.7, Bounds [0.3, 0.99]), Limit
  `RISK_MAX_PER_CLUSTER` (Default 3, Bounds [1, 10]) offene Positionen je
  Cluster. **Fail-closed Stale-Policy:** fehlende/veraltete Daten (> 24 h,
  < 20 gemeinsame Renditen, nicht auflösbares Symbol) → enforce lehnt ab
  (`cluster-exposure:correlation-stale`), statt zu raten. Berechnung nur je
  Order-Prüfung mit TTL-Cache (`RISK_CORR_CACHE_TTL_MS` Default 900000,
  Bounds [60000, 3600000]; Key = Symbol-Menge + Fenster + Schwelle) — kein
  Hintergrund-Job.
- **Rollout-Modus** `RISK_CLUSTER_LIMITS_MODE` (Default `monitor`):
  `monitor` = Entscheidungspfad unverändert, Würde-Prüfung nur als
  Audit-Notiz + Log (`CLUSTER_EXPOSURE_MONITOR`, `wouldBlock: true`);
  `enforce` = echte Ablehnung (`cluster-exposure:max-per-cluster:N`,
  Audit `CLUSTER_EXPOSURE_BLOCKED`). Unbekannter Wert → `monitor` +
  Warnung.
- **Transparenz** (D3): `GET /api/firm/risk` zeigt effektive Sizing- und
  Cluster-Parameter (inkl. Bounds), Kelly-Edge-Status (`off`/`ok`/
  `unavailable` + Statistik), Cache-Zustand, offene Positionen und aktuelle
  Cluster sowie die UNKNOWN-Zustände (`unknown.correlationUnavailable`).
  Je Guardrail-Entscheidung revisionssichere audit_log-Einträge
  (`security`-Klasse, at-least-once); Sizing-UNKNOWN wird als
  `POSITION_SIZING`/`POSITION_SIZING_UNKNOWN` mit Code
  `sizing:atr-unknown:SYMBOL` protokolliert.

### Geändert

- Order-Pfade (Engine + Mikro-Executor) nutzen jetzt
  `computePositionSize()` statt der inline aufgerufenen
  `missionSizedNotional()` — mit den Default-Parametern (expliziter Stop,
  Kelly aus) **byte-identische Notional-Werte** wie vorher; veränderlich
  werden nur degenerative 0-Stop-Regeln (ATR-Fallback statt 0-Distanz).

### Behoben

- 0-Stop-Regeln im Mikro-Executor produzierten früher einen Stop **am
  Entry-Preis** (`stopLoss = price`) — jetzt ATR-Fallback-Stop (bzw.
  Basis-Stop bei UNKNOWN).

### Tests & Checks

- Neu: `tests/positionSizing.test.ts` (14), `tests/riskGuard.cluster.test.ts`
  (14). Bestehende riskGuard-/portfolio-/microExecutor-/indicators-Tests
  unverändert grün (Defaults = kein Verhaltensbruch; `monitor` blockt nie).
- Pflicht-Checks der Serie (typecheck/lint/test/docs:validate) laufen in
  der CI; Details im PR.

### Konfiguration (neue Flags, Details: CONFIGURATION.md „Sizing & Cluster-Limits“)

| Flag | Default | Bounds |
| --- | --- | --- |
| `RISK_ATR_STOP_MULT` | `2` | [0.5, 6] |
| `RISK_KELLY_FRACTION` | `0` (aus) | [0, 1] |
| `RISK_CLUSTER_LIMITS_MODE` | `monitor` | `monitor` \| `enforce` |
| `RISK_CORR_THRESHOLD` | `0.7` | [0.3, 0.99] |
| `RISK_MAX_PER_CLUSTER` | `3` | [1, 10] |
| `RISK_CORR_WINDOW_CANDLES` | `90` | [30, 365] |
| `RISK_CORR_CACHE_TTL_MS` | `900000` | [60000, 3600000] |

### Doku

- `docs/PORTFOLIO_ANALYTICS.md` §10 „Sizing & Cluster-Limits im
  Order-Pfad“ (Formeln, Wiederverwendung `correlation.ts`, Rollout-Modus),
  `docs/HANDBUCH.md` §9.5 (Ops: monitor→enforce-Umschaltung + Status-Check),
  `CONFIGURATION.md` + `.env.example` (Flags), Finding
  `GAP-04-vol-sizing-correlation-limits.md` („Umsetzung“) und
  `remediation/TRACKING.md` (GAP-04 → IN_PROGRESS).

## [1.47.0] — 2026-09-19 · feat(marketdata): Datenqualitäts-Layer & deterministische Multi-TF-Aggregation (GAP-07)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-07](docs/audits/2026-09-18-feature-gap/findings/GAP-07-data-quality-multi-timeframe.md))
gab es keine Gap-Detection in Kerzenserien, keinen Outlier-/Wick-Filter, keine
Plausibilitätsregeln (OHLC ≤ 0, high < low, close außerhalb [low, high],
Duplikate), keine deterministische 1h→4h/1d-Aggregation und keinen
Zweitquellen-Cross-Check. „Garbage in, garbage out“ gilt für LLM-Agenten
doppelt — eine falsche Candle produziert eine überzeugend formulierte
Fehlentscheidung. Dieses Release schließt das Delta (PROMPT-07 der
Remediation-Serie): paper-only, keine neuen Runtime-Dependencies,
fail-closed, Rollout bewusst **log-first** (Default: sichtbar machen, keine
Wirkung). Grundprinzip: Qualitätsbefunde werden **sichtbar klassifiziert**
(MDERR-Stil) — gespeicherte Historie wird nie still verändert, und echte
Flash-Moves werden nicht weggefiltert. Umsetzung: Branch
`arena/01a0b751-ai-trading-firm`.

### Hinzugefügt

- **Qualitäts-Validierung** (`src/marketdata/quality.ts`,
  `validateCandleSeries()`) mit vier neuen, in die MDERR-Taxonomie
  aufgenommenen Klassen (`src/lib/marketDataErrors.ts`, IDs
  `QUALITY_GAP`/`QUALITY_OUTLIER`/`QUALITY_INVALID`/`QUALITY_DUPLICATE`,
  dazu `QUALITY_CROSSCHECK`):
  - `GAP` — fehlende Intervalle; Befund an der **ersten fehlenden Position**
    (exakt ein Intervall Abstand = **kein** Befund),
  - `INVALID` — OHLC ≤ 0 / nicht endlich, `high < low`, `close` außerhalb
    `[low, high]`,
  - `OUTLIER` — Wick **oder** Körper **streng** > `MARKETDATA_OUTLIER_ATR_MULT`
    × Volatilitäts-Baseline (Default **25**, Bounds [5, 200] — bewusst
    großzügig, damit echte Flash-Moves durchkommen; **Grenzwert-Test**:
    exakt mult × Baseline = kein Befund). Baseline = leave-one-out-Mittel der
    True-Ranges der strukturell gültigen Kerzen (ein Spike bläst seine eigene
    Schwelle nicht auf),
  - `DUPLICATE` — doppelter Zeitstempel.
- **Qualitäts-Report je Instrument** (`data/marketdata/quality-report.json`,
  gitignored, atomar 0600, `resolveRuntimePath` — derselbe Cross-Prozess-Pfad
  wie das Fehler-Manifest): persistiert vom Sync-CLI, enthält Befunde +
  Zähler je Reihe (Instrument ⟂ Timeframe). **Die Historie-Datei wird vom
  Qualitäts-Layer nie berührt** (Test belegt: Eingabe bleibt freeze-intakt).
- **Lesepfad-Modi `MARKETDATA_QUALITY_MODE`:** `log` (**Default**: nur
  sichtbar machen — Report + Log-Zeile + Metrik, keine Wirkung auf Scanner) |
  `strict` (fail-closed: Instrumente mit `INVALID`-Befund behandelt der
  Scanner wie `DATA_UNAVAILABLE` — existierende Stale-Fallback-Kette,
  `data-unavailable`-Ablehnung, nie `min-candles`; verdrahtet in
  `scripts/run-scan.ts` + `ScannerService.refresh`).
- **Stale-Guard je Instrument/Timeframe** (D2): konfigurierbare Schwellen
  `MARKETDATA_STALE_1H_HOURS` (Default **26**, Bounds [2, 168]),
  `MARKETDATA_STALE_4H_HOURS` (Default 104, Bounds [8, 672]),
  `MARKETDATA_STALE_1D_HOURS` (Default 624, Bounds [48, 4032]); Ausweis als
  **Zähler** (`staleSeries`/`staleByTimeframe`) im Sync-Status
  (`data/market-sync-status.json`), damit Ops-Center/Scanner gut degradieren
  (keine Symbole im Status — geschlossene Security-Policy).
- **Deterministische Multi-TF-Aggregation** (`src/marketdata/aggregate.ts`,
  `aggregateCandles()`): 1h → 4h/1d mit **UTC-Anker** (4h: 00/04/08/12/16/20
  UTC, 1d: 00:00 UTC), OHLCV-Korrektur (open/close erst/letzter, high/low
  max/min, volume Summe), **unvollständige Bucket werden NIEMALS aggregiert**
  (als `partial` gezählt und ausgeschlossen), Zeitmaske (nur abgeschlossene
  Perioden ≤ `nowMs`), Konsistenz-Check (`checkAggregationConsistency()`).
  Deterministisch: zwei Läufe ⇒ byte-identisches Ergebnis (Test),
  Ankunftsreihenfolge der Quelle irrelevant (interne Sortierung).
- **Zweitquellen-Cross-Check** (D4, **Default off** — Rate-Limits!):
  optionale Adapter-Methode `getCrosscheckCandles()` am
  `MarketDataAdapter`-Contract (Adapter-Registry-Muster);
  `MARKETDATA_CROSSCHECK` + `MARKETDATA_CROSSCHECK_TOLERANCE_PCT`
  (Default **1**, Bounds [0.1, 10]); Abweichung > Toleranz ⇒
  `QUALITY_CROSSCHECK`-Befund + Log. **Keine neue Venue-Anbindung** in diesem
  PR (Scope-Disziplin) — ohne implementierende Methode ist der Cross-Check
  ein no-op.
- **Metrik** `market_data_quality_findings_total` (Label `class`, prozesslokal
  wie der Fetch-Counter; in `prometheusMetrics()` exponiert) +
  `[market-sync] quality: …`-Zeile (nur bei Befunden, Zähler ohne Symbole).
- **Sync-CLI:** `--aggregate` (Env `MARKET_SYNC_AGGREGATE`, Default off) —
  aggregiert nach dem Backfill die persistierten 1h-Reihen zu 4h/1d und
  appendet sie als **neue** Timeframe-Reihen (`feed: "agg:1h"`); die 1h-Quelle
  bleibt unangetastet.

### Geändert

- `MarketDataErrorReason` um die fünf `QUALITY_*`-Klassen erweitert
  (geschlossene Aufzählung; `retryable` = nein, nie im Fetch-Backoff).
- **Schreibpfad-Verdrahtung:** der Sync validiert jede frisch gepflögte
  Serie (read-only), der Report landet im `SyncResult.qualityReport` +
  Metrik + Log. Qualitätsbefunde zählen **nicht** als Fetch-Fehler:
  `degraded`/Exit-Code bleiben im `log`-Modus entkoppelt, und
  `syncErrorsToDataErrors()` lässt `QUALITY_*` aus dem
  Datenfehler-Manifest heraus (sonst würde der log-Modus Instrumente
  fälschlich als `data-unavailable` abwerten).
- `VenueSyncStatus` um `staleSeries`/`staleByTimeframe` (nur Zähler,
  Timeframe-Keys gegen erlaubte Allowlist validiert).

### Tests

- Neu `test/marketdata/quality.test.ts` (35 Tests): GAP-Position exakt an
  Intervallgrenzen, INVALID-Fälle, **Flash-Move-Schutz** (10 %-Crash unter
  25×Baseline bleibt erhalten, exakter Grenzwert ⇒ kein Befund),
  Determinismus (byte-identisch), Immutabilität (Freeze-Vergleich),
  Report-Roundtrip, strict ⇒ `DATA_UNAVAILABLE`-Fallback (log ⇒ leer),
  Stale-Guard mit Fake-Clock, Cross-Check (striktes `>`), Config-Bounds,
  Metrik-Counter, Sync-Integration (log-Modus, Cross-Check on/off).
- Neu `test/marketdata/aggregate.test.ts` (14 Tests): 4h-/1d-UTC-Anker,
  OHLCV-Handrechnung, Envelope-Konsistenz, unvollständige Schlusskerze
  ausgeschlossen (15/16-Stunden- und 23/24-Fälle), Zeitmaske,
  Determinismus (inkl. Reihenfolge-Unabhängigkeit), Freeze, Vertrag.
- `test/marketdata/cli.test.ts`: `--aggregate`-Parsing (Default off,
  Boolean-Grammatik, Hilfe).

### Keine Änderungen (bewusst)

- `data/history/candles.ndjson` und jede gespeicherte Reihe bleiben vom
  Qualitäts-Layer **unangetastet** (Report ist ein neues Artefakt; Aggregation
  appendet nur neue Timeframe-Reihen).
- Der Bitunix-Adapter erhält **keine** Zweitquellen-Methode (keine neue
  Venue-Anbindung; Interface + Vertrag + Flag nur).

## [1.46.0] — 2026-09-19 · feat(risk): Markt-Regime-Klassifikator + Regime-Gate für Strategie-Gewichtung (GAP-06)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-06](docs/audits/2026-09-18-feature-gap/findings/GAP-06-regime-gate.md))
klassifizierte `adaptiveRisk.ts` zwar das Volatilitäts-Regime
(NORMAL/ELEVATED/EXTREME, mit Hysterese) — aber ausschließlich als
Risikofaktor. Ein Trend/Range/Crash-Klassifikator existierte nicht, und
Agenten-/Strategiegewichte reagierten nicht auf das Markt-Regime:
Mean-Reversion-Signale liefen in Trendmärkten ungedämpft (und umgekehrt).
Dieser Release schließt das Delta (PROMPT-06 der Remediation-Serie):
paper-only, keine neuen Runtime-Dependencies, Fail-closed, Rollout bewusst
monitor-first. Umsetzung: Branch `arena/01a0b708-ai-trading-firm`.

### Hinzugefügt

- **Markt-Regime-Klassifikator** (`src/lib/marketRegime.ts`,
  `classifyMarketRegime()`): deterministisch (KEIN LLM —
  Architektur-Test `tests/marketRegime.test.ts`), nur aus Kerzen
  (Zeitmaske: nur Daten ≤ t): ADX (Wilder, neu in `src/lib/indicators.ts`
  inkl. Handrechnungs-Referenztest), OLS-Regressions-Slope über
  Schlusskurse, realisierte Volatilität als Perzentil über den Lookback
  (Entartungsschutz bei konstanter Vol), Drawdown vom Fensterhoch. Fünf
  Regimes mit strikter Priorität **CRASH > HIGH_VOL > TREND\_\* > RANGE**;
  unter 30 Kerzen `UNKNOWN` — nie eine stille Rate-Klassifikation.
- **Regime-Hysterese** (`MarketRegimeStateMachine`, Muster an
  `adaptiveRisk`-`RegimeStateMachine` angelehnt): Eskalation (Schwere ↑)
  sofort, Seitwärts-/De-Eskalation erst nach `REGIME_CONFIRM_CANDLES`
  (Default 3, Bounds [1, 20]) konsekutiven bestätigenden Bewertungen —
  einzelne Gegenkerzen wechseln das Regime nicht (Whipsaw-Schutz).
- **Regime-Gate** (`applyRegimeGate()`): Mapping Regime → Dämpfungsfaktor
  je Strategieklasse (`mean-reversion`/`trend`/`breakout`), konfigurierbar
  über `REGIME_GATE_FACTORS` (Grammatik `REGIME:klasse=faktor,…`, Werte
  geklemmt [0, 2]). Defaults: mean-reversion ×0.5 in TREND_UP/TREND_DOWN,
  breakout ×0.5 in RANGE, sonst ×1. Umsetzung als **Datenkontext** für
  ruleEngine/Approver (Faktor multipliziert das Signalgewicht), NICHT als
  hartes Veto. Modi `REGIME_GATE_MODE`: `off` | `monitor` (**Default**:
  Ausweis + Audit, keine Wirkung) | `enforce`; unbekannter Wert →
  fail-closed `monitor`. `UNKNOWN` → Faktor 1 + Kennzeichnung, nie still.
  - *Engine-Turn:* Regime-Klassifikation über dieselben Kerzen des
    Markt-Kontexts (kein Extra-Abruf); `REGIME-GATE`-Trace + Prompt-Zeile
    (monitor: Ausweis; enforce: zusätzlich gedämpftes Risikobudget der
    Mission). `off` lässt den Prompt byte-identisch.
  - *Mikro-Executor:* nur `enforce` dämpft das Regel-Risikobudget
    (`riskBudgetPct × Faktor`, gegen `maxRiskPerTrade` geklemmt); Regime
    aus dem RAM-Snapshot (Seed + Monitor-Tick), fehlender Stand →
    fail-safe Faktor 1; Audit `REGIME_GATE_APPLIED`
    (`regime-gate:SYMBOL:KLASSE:REGIME`).
  - *Strategieklasse:* deterministisch aus dem Mission-Template abgeleitet
    (`strategyClassOfTemplate`); ohne Klasse Faktor 1.
- **Sichtbarkeit:** Regime je Instrument in der Risk-Sektion des
  Ops-Centers (Modus + Regime nach Schwere sortiert, inkl. Begründung),
  Regime-Verlauf als Cycle-Artefakt
  (`artifacts/YYYY-MM-DD/daily/regime-history.json`), Audit je
  Regime-Wechsel (`REGIME_CHANGE`, Code `regime:SYMBOL:VON→NACH`) — beides
  im Audit-Katalog (`src/lib/auditView.ts`) dokumentiert.
- **Konfiguration:** `REGIME_LOOKBACK_CANDLES` (Default 100, Bounds
  [20, 500]), `CRASH_DRAWDOWN_PCT` (10, [3, 50]), `HIGH_VOL_PERCENTILE`
  (90, [50, 99]), `REGIME_CONFIRM_CANDLES` (3, [1, 20]), `REGIME_TREND_ADX`
  (25, [10, 60]), `REGIME_TREND_SLOPE_PCT` (0.05, [0.005, 1]) — alle in
  `.env.example` + `CONFIGURATION.md` (§„Regime-Gate“).
- **Doku:** neues `docs/REGIME_GATE.md` (Klassifikator-Logik, Prioritäten,
  Gate-Modi, Hysterese-Parameter, Abweichungen/Offene Punkte), im
  Doku-Katalog registriert.
- **Tests:** `tests/marketRegime.test.ts` (Golden-Cases je Regime inkl.
  Grenzfälle, Hysterese — Gegenkerzen/Bestätigung/De-Eskalationsfenster,
  Determinismus per Hash, Gate-Modi exakt, Konfig-Klemmung,
  Architektur-Garantie „kein LLM im Klassifikator“); ADX-Mathe gegen
  Handrechnung in `tests/indicators.test.ts`.

### Geändert

- **Monitor-Tick:** bewertet zusätzlich das Markt-Regime der offenen
  Positionen (best-effort, fail-soft, Min-Interval je Symbol; nur ohne
  injizierte Test-Kurse) — `TickResult.marketRegimes` neu.
- **Mikro-Executor:** RuleCache lädt `missions.template_id` mit (Quelle
  der Strategieklasse); Seed wertet mit den Seed-Kerzen zugleich das
  Regime aus (auch im separaten `npm run micro`-Prozess).
- **Cycle-Artefakte:** `saveDailyCycleArtifacts()` schreibt zusätzlich
  `regime-history.json` (nur, wenn im Prozess mindestens ein Instrument
  bewertet wurde).

**Keine Verhaltensänderung im Default:** ohne Konfiguration gilt
`REGIME_GATE_MODE=monitor` — reine Ausweisung + Audit; Entscheidungs- und
Orderpfade bleiben unverändert. `enforce` dämpft ausschließlich
Signalgewichte (nie Veto, nie über den Code-Ceilings).

## [1.45.0] — 2026-09-18 · feat(observability): Firmen-Metriken, Auto-Circuit-Breaker, Alerting & Heartbeat (GAP-10)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-10](docs/audits/2026-09-18-feature-gap/findings/GAP-10-observability-circuit-breaker.md))
war die Firma im Betrieb unzureichend beobachtbar und im Grenzfall nicht
selbstschützend: `prometheusMetrics()` lieferte nur Marktdaten-/Audit-Counter,
die harten Risiko-Grenzen blockierten ausschließlich **neue** Orders (offene
Positionen liefen bei einem Bug weiter), es gab keinen Alert-Kanal und kein
Signal für einen stehenden Monitor-Tick. Dieser Release schließt das Delta
(PROMPT-10 der Remediation-Serie): paper-only, keine neuen
Runtime-Dependencies, Fail-closed, Wiederverwendung des bestehenden
Kill-Switch- und Disarm-Pfads. Umsetzung: PR
[#139](https://github.com/Kryschuuu/ai-trading-firm/pull/139)
(`arena/01a0b6a7-ai-trading-firm`).

### Hinzugefügt

- **Firmen-Metriken in `prometheusMetrics()`** (`src/lib/telemetry.ts`, jetzt
  `async`; Instrumentierung in `src/lib/broker.ts` und
  `src/routing/adapter.ts`): `firm_equity`, `firm_drawdown_pct`,
  `firm_open_positions`, `firm_realized_pnl_today` (Ledger, sonst jüngster
  `equity_snapshots`-Eintrag), `firm_metric_source{source}`,
  `firm_order_fills_total{kind,reason}`, `firm_order_rejects_total{reason}`,
  `llm_calls_total{provider,outcome}`, `llm_latency_ms_sum{provider}`. Alles
  wird aus **bestehenden** Stores gelesen (Paper-Ledger, PostgreSQL,
  In-Memory-Counter) — keine zweite Messschleife. Labels sind ausschließlich
  klassifizierte Codes (`metricLabel()`, `classifyRejectReason()`); Symbole,
  Beträge, URLs oder Tokens erscheinen nie. Ist der Firmenzustand nicht lesbar,
  werden die betroffenen Metriken **weggelassen** und mit
  `# HELP … degraded: <grund>` markiert — kein erfundener 0-Wert, kein Throw,
  kein Hänger.
- **Auto-Circuit-Breaker** (`src/lib/circuitBreaker.ts`, im Monitor-Tick nach
  der Equity-Berechnung): drei Auslöser — Drawdown ≥ `maxEquityDrawdownPct`
  (Metrik `drawdown`), Tagesverlust ≥ `dailyLossLimitPct` (`dailyLoss`),
  `RISK_MAX_CONSECUTIVE_LOSSES` Verlust-Closes in Folge
  (`consecutiveLosses`, Default 5, Bounds [2, 50]) — in dieser Prioritätsfolge.
  Aktion über den **bestehenden** Kill-Switch-Pfad: `killSwitch.pull(reason)`,
  `kill_switches`-Zeile (`triggered_by = AUTO_CIRCUIT_BREAKER`),
  `KILL_SWITCH`-Audit (CRITICAL) mit fixiertem Auslösewert
  (`metric`/`value`/`limit`/`triggeredAt`) und Alert
  `circuit-breaker:<metrik>`. Grundformat stabil:
  `auto-circuit-breaker:drawdown:0.1834`,
  `auto-circuit-breaker:consecutiveLosses:5`. **Latching:** einmal ENGAGE
  bleibt ENGAGE, kein zweites Engage/Update, keine Hysterese. `checkCircuitBreaker()`
  wirft nie; nicht lesbare Verlustserie armiert **nicht** (kein Raten).
- **Alert-Adapter** (`src/lib/alerts.ts`): `AlertSink`-Interface mit
  `LogAlertSink` (strukturiert, redigiert) und `FileAlertSink` (append-only
  NDJSON `data/alerts.ndjson` über `resolveRuntimePath()`, Modus 0600 — CLI
  und Server sehen dieselbe Datei). **Debounce** je identischem Alarm-Code
  (`ALERT_DEBOUNCE_MINUTES`, Default 30, Bounds [1, 1440]) mit Zählung
  unterdrückter Alarme (`meta.suppressedSinceLast`). **Optionaler**
  Webhook-Sink, Default **aus**: URL ausschließlich aus dem Secret-Store
  (`ALERT_WEBHOOK_URL_SECRET_NAME`, Feld `apiKey`), Timeout 5 s; die URL ist
  selbst ein Credential und erscheint nie in Logs/Fehlermeldungen (Nicht-OK →
  `webhook: HTTP <status>`). `AlertDispatcher.emit()` sammelt Sink-Fehler und
  wirft nie.
- **Heartbeat + Watchdog** (`src/lib/heartbeat.ts`, `GET /api/health`,
  `scripts/watchdog.ts` + `npm run watchdog`): Health-Payload enthält
  `monitorLastTickAt`, `monitorAgeMs`, `stale`, `staleAfterMs` (immer HTTP
  200); `stale` gilt bei Alter > `HEALTH_STALE_AFTER_MS` (Default 300 000,
  Bounds [30 000, 3 600 000]) und bei „noch nie getickt“ (fail-loud). Der
  Watchdog ist **alarm-first**: ein Lauf, kein Daemon, **kein Auto-Restart,
  keine Mutation**; Prüfung per HTTP (Default `http://127.0.0.1:$PORT/api/health`)
  oder `--source=inprocess`, Alerts `heartbeat-stale`,
  `heartbeat-health-unreachable`, `heartbeat-health-unreadable`, Exit-Codes
  0 = gesund, 1 = Alarm, 2 = Bedienfehler.

### Behoben

- **Fehlender CHANGELOG-Verweis auf Arena-Task 05 (Portfolio-Analytics)
  wiederhergestellt:** Die Doku-Konsolidierung vom 2026-09-05 hatte den
  Verweis auf Task 05 (`src/portfolio/`, `docs/PORTFOLIO_ANALYTICS.md`,
  `docs/security/SECURITY_AUDIT.md` §„Security Audit — Task 05“) im Changelog
  verloren; der Architektur-Test `tests/portfolio.architecture.test.ts`
  („Doku: CHANGELOG führt Task 05“) war dadurch **schon im Baseline-Stand
  rot**. Reine Dokumentation, kein Verhaltenswechsel — als Nebenfund
  mitkorrigiert, damit die Pflicht-Checks grün sind (siehe `TRACKING.md`,
  GAP-10-Notizen).

### Geändert

- **Verhaltensänderung (explizit):** `AUTO_CIRCUIT_BREAKER` ist per Default
  **an** — bestehende Installationen erhalten damit erstmals einen
  automatischen Not-Halt bei Grenzbruch. Der Tagesverlust-Auto-Pull existierte
  zuvor bereits im Monitor-Tick; er läuft jetzt über den zentralen Brecher mit
  einheitlichem Grund/Audit/Alert und Latching (`TickResult.dailyLossKill`
  bleibt als Feld erhalten). „Aus“ ist ein bewusster, hier dokumentierter
  Betriebsentscheid (z. B. Fehlersuche); ein unbekannter Wert schaltet den
  Schutz nicht still ab (Default + Warnung).
- **Monitor-Tick:** Schritt 3 ist `checkCircuitBreaker(...)` (vorher
  Tagesverlust-Sonderfall inline); `TickResult.circuitBreaker` beschreibt den
  Zustand (`engaged`/`latched`/`reason`); der Tick merkt sich
  `state.monitorLastTickAt` (`lastTickAt()` bleibt stabil).
- **Client-Bundle-Grenze:** `src/lib/telemetry.ts` bleibt **DB-frei** (kein
  `@/db`/`pg`); der Firmenzustand wird von `src/lib/firmState.ts`
  (server-only; Ledger zuerst, sonst jüngster `equity_snapshots`-Eintrag)
  gelesen und über `setFirmMetricStateReader()` registriert. Grund:
  `telemetry.ts` hängt über `marketData.ts`/`workshop.ts` im Import-Graph der
  Client-Komponenten — ein DB-Import dort ließ den Produktions-Build mit
  „Module not found: Can't resolve 'tls'“ (pg → Node-Builtins) scheitern.
  `prometheusMetrics()` ohne Argument nutzt den registrierten Leser, sonst
  den prozesslokalen RAM-Ledger und degradiert sauber; fehlt nur das
  Tages-P&L, wird genau diese Metrik als `degraded` markiert (kein 0-Wert).
- **`GET /api/health`:** neue Felder `monitorLastTickAt`/`monitorAgeMs`/
  `stale`/`staleAfterMs` in Erfolgs- **und** Fehlerzweig; Statuscode bleibt
  konstruktionsbedingt 200 (Liveness ≠ Readiness).

### Sicherheit / Grenzen

- **Kein Auto-Re-Arm:** Der Weg zurück bleibt ausschließlich der manuelle
  Disarm-Pfad (Admin-Permission `live.gate` + CSRF + single-use
  Challenge-Nonce ≤ 60 s, `src/lib/disarmChallenge.ts`) — unverändert und
  fail-closed (ohne Auditbeleg kein Disarm). Der Brecher setzt nur den Latch
  zurück, wenn ein Mensch entschärft hat.
- **Keine Secrets/PII** in Metrik-Labels, Alerts, Logs oder Docs; die
  Webhook-URL kommt ausschließlich aus dem Secret-Store und wird nie
  geloggt (`.env.example` enthält nur den **Namen** des Eintrags).
- **Keine neuen Runtime-Dependencies**, keine Schema-Migration; der Watchdog
  mutiert nichts (kein Restart, kein Kill, kein Flatten).

### Tests

- `tests/telemetry.firm.test.ts` (7): Firmen-Metriken im Snapshot,
  DB-Fehler → `degraded` statt Exception, keine Secrets im Output,
  Label-Whitelist, Reject-Klassifikation.
- `tests/circuitBreaker.test.ts` (12): D2 (a) Drawdown-/Tagesverlust-Auslöser
  → ENGAGE + Audit-Grund + Alert, (b) Verlustserie inkl. Priorität und
  unlesbarer Serie, (c) Flag aus + Bounds, (d) Latching + gemeldete
  Audit-Lücke, (e) kein Auto-Re-Arm (Source-Scan + Disarm-Route verlangt
  Nonce, `CSRF_INVALID` vor Nonce-Prüfung).
- `tests/alertSink.test.ts` (8): Debounce inkl. `suppressedSinceLast`,
  Sink-Fehler bricht nicht ab, Log-/File-Sink (NDJSON via
  `resolveRuntimePath`) und Webhook-Credential aus dem Secret-Store,
  Config-Bounds.
- `tests/health.heartbeat.test.ts` (5): `stale`-Grenzen mit Fake-Clock
  (`>`-Semantik: Schwelle selbst gesund), „nie getickt“ → stale,
  `HEALTH_STALE_AFTER_MS`-Clamp, Health-Payload.

### Dokumentation

- `docs/OBSERVABILITY.md`: Status-Header auf v1.45.0, neue Abschnitte
  **9. Firmen-Metriken**, **10. Auto-Circuit-Breaker**, **11. Alert-Adapter**,
  **12. Heartbeat & Watchdog** (inkl. bewusst offener Punkt „kein
  `/api/metrics`-Scrape-Endpoint“).
- `docs/OPERATIONS.md`: neues Runbook **„Auto-Breaker hat ausgelöst“**
  (Symptom → Audit lesen → Heartbeat prüfen → manuell entschärfen) inkl.
  Fehlercodes; Status-Header aktualisiert.
- `CONFIGURATION.md`: neue Tabelle „Firmen-Metriken, Auto-Circuit-Breaker,
  Alerts & Heartbeat" mit `AUTO_CIRCUIT_BREAKER`,
  `RISK_MAX_CONSECUTIVE_LOSSES`, `ALERT_DEBOUNCE_MINUTES`, `ALERT_FILE`,
  `ALERT_WEBHOOK_URL_SECRET_NAME`, `HEALTH_STALE_AFTER_MS`; `.env.example`
  ergänzt.

## [1.44.0] — 2026-09-18 · feat(paper): Server-seitiges Exit-Management — Trailing-Stop, Time-Stop, OCO-Exklusivität (GAP-05)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-05](docs/audits/2026-09-18-feature-gap/findings/GAP-05-server-side-exit-management.md))
prüft der Monitor zwar serverseitig Stop-Loss/Take-Profit unabhängig von
LLM-Turns — Trailing-Stop und Time-Stop fehlten jedoch vollständig, und die
Garantie „genau **ein** Exit pro Position, auch bei parallelen Ticks/Instanzen“
war nicht belegt (Check-then-Act im Prozessspeicher). Dieser Release schließt
das Delta (PROMPT-05 der Remediation-Serie): paper-only, Fail-closed, alle
Flags per Default **aus** (= heutiges Verhalten), keine neuen
Runtime-Dependencies. Umsetzung: PR
[#138](https://github.com/Kryschuuu/ai-trading-firm/pull/138)
(`arena/01a0b5f8-ai-trading-firm`).

### Hinzugefügt

- **Trailing-Stop im Monitor-Tick** (`src/lib/exits.ts` — reine, clock-unabhängige
  `decideExit`-Entscheidung; `src/lib/monitor.ts` — Ausführung): Bewaffnung ab
  `RISK_TRAILING_ACTIVATION_PCT` % Gewinn, Stop = Kurs − `RISK_TRAILING_RETURN_PCT` %
  Rückgabeweg (LONG; SHORT gespiegelt). **Ratchet:** LONG hebt den Stop nur,
  SHORT senkt ihn nur — automatische Verengungen gibt es nicht. Trigger →
  Close mit `exitReason = TRAILING_STOP`. Aus/Bewaffnet/Stop-Level persistieren
  in `positions.trailing_armed` (NOT NULL DEFAULT false) und
  `positions.trailing_stop` (numeric NULL) — ein Prozess-Neustart verliert
  keinen erreichten Stop (crash-safe, kein Memory-Only-Zustand;
  `PaperBroker.hydrate` spiegelt den Stand ins Ledger). Migration:
  `drizzle/2026-09-18_exit_management.sql` (append-only) oder
  `npx drizzle-kit push`.
- **Time-Stop:** `RISK_TIME_STOP_HOURS > 0` schließt Positionen nach der
  maximalen Haltedauer unabhängig vom Kurs (`exitReason = TIME_STOP`,
  Audit-Eintrag). Default `0` = inaktiv.
- **OCO-Exklusivität (genau ein Exit):** Der Exit ist ein atomarer DB-Claim —
  bedingtes `UPDATE positions … WHERE id = … AND status = 'OPEN'`
  (`applyExit()` in `src/lib/monitor.ts`, `RETURNING` als Gewinner-Ermittlung).
  Zwei parallele Ticks oder zwei Instanzen können dieselbe Position nie
  doppelt schließen: der Verlierer sieht CLOSED und macht einen sauberen
  no-op (kein Doppel-Fill, kein Doppel-P&L, kein Fehler). Bei SL+TP im
  selben Intervall gilt wie bisher konservativ SL zuerst; Priorität
  SL → TP → Trailing → Time-Stop.
- **Audit je Exit:** genau ein `audit_log`-Eintrag pro Exit mit
  maschinenlesbarem Grund — Detail-Code `exit:SYMBOL:grund`, Events
  `STOP_LOSS_HIT`/`TAKE_PROFIT_HIT`/`TRAILING_STOP_HIT`/`TIME_STOP_HIT`; die
  beiden neuen Events sind im Audit-Katalog (`src/lib/auditView.ts`)
  beschriftet und erklärt. Die Bewaffnung auditiert genau EINMAL je Position
  (`TRAILING_STOP_ARMED`, Code `trailing-arm:SYMBOL`); reine
  Ratchet-Anhebungen bleiben Zustandspflege in der Positionsspalte und
  fluten den Audit-Log nicht.
- **Konfiguration (D4):** Env-Flags mit Bounds-Clamp und sicheren Defaults
  (`loadExitConfig` — dasselbe Muster wie `loadFundingConfig`, GAP-02):
  `RISK_TRAILING_ENABLED` (false), `RISK_TRAILING_ACTIVATION_PCT` (1.0,
  Bounds [0.1, 20]), `RISK_TRAILING_RETURN_PCT` (0.5, [0.1, 10]),
  `RISK_TIME_STOP_HOURS` (0 = aus, [0, 720]). Tabelle: `CONFIGURATION.md`
  („Exit-Management“), `docs/PAPER_TRADING.md` §3.3, `.env.example`.
- **Exit-Taxonomie erweitert:** `positions.exit_reason` dokumentiert jetzt
  `STOP_LOSS | TAKE_PROFIT | TRAILING_STOP | TIME_STOP | MANUAL_FLATTEN |
  AGENT_CLOSE | RULE_EXECUTION` (Kommentar in `src/db/schema.ts`).
- **Tests:** `tests/monitor.exits.test.ts` (17 Tests) — Trailing-Lifecycle
  (bewaffnen/ratcheten/auslösen, LONG+SHORT), Restart-Persistenz über
  `invalidateBrokerCache()` + Rehydrierung aus der DB, Time-Stop (Ablauf/0),
  OCO-Race (parallele `applyExit`-Gewinner-Ermittlung, `Promise.all([tick(),
  tick()])` mit Single-Flight + nachfolgender no-op-Tick, Multi-Instanz-Race
  über zwei echte Postgres-Transaktionen), Defaults-Neutralität,
  genau-ein-Audit-Assertionen; Determinismus über Fake-Clock und injizierte
  Kurse (neue `tick(forceScan, { now, quotes, skipScan })`-Optionen,
  produktionsneutral). Tick-Tests springen sauber über (skip), wenn kein
  PostgreSQL erreichbar ist — wie im Rest der Suite gilt keine DB-Pflicht.

### Geändert

- `src/lib/monitor.ts`: Die SL/TP-Prüfung nutzt jetzt `decideExit()` +
  `applyExit()` (vorher direktes `broker.close()` + unbedingtes UPDATE).
  Verhalten mit allen Flags aus ist identisch zum bisherigen Watcher
  (bestehende Tests unverändert grün); der Tick schreibt `updatedAt`/
  Haltedauer-Berechnung mit einem **einheitlichen** Zeitstempel pro Zyklus.
- `PaperBroker`: Positions-Eintrag und `listPositions()` tragen
  `trailingStop`/`trailingArmed` (hydrate-Mapping in `engine.getBroker()`
  inklusive) — das Ledger zeigt dieselbe Wahrheit wie die DB.

### Sicherheit / Grenzen

- Paper-only: `src/live-gate/**` unangetastet; keine Order-Mapping-Pfade an
  echte Venues (Stop-Auslösung bleibt Ledger-/DB-Logik).
- Fail-closed: Bounds-Clamp mit sicherem Default, kaputte/env-fremde Werte
  neutralisiert; Stops werden nie automatisch verengt, nur erweitert und
  geloggt; jede Mutation revisionssicher im Audit.

## [1.43.0] — 2026-09-18 · feat(paper): Trade-Journal mit Agenten-Attribution + begrenzte Gewichts-Rückführung (GAP-03)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-03](docs/audits/2026-09-18-feature-gap/findings/GAP-03-trade-journal-attribution.md))
gab es keinen Weg, **nachvollziehen zu können, welche Agenten-Entscheidung zu
welcher Position geführt hat** — und damit keinen belastbaren Boden für eine
Lernschleife. `positions` referenziert Missionen/Regeln, aber nicht die
Entscheidungskette (Stimmen, Regime, Begründung) zum Eröffnungszeitpunkt;
Excursions (MAE/MFE) wurden nie gemessen. Dieser Release schließt die Lücke
(PROMPT-03 der Remediation-Serie) mit einem **append-only Trade-Journal** und
einer **bewusst begrenzten, aus- bzw. zuschaltbaren Feedback-Schleife** —
sicherheitsseitig Default **off**. Umsetzung: PR
[#137](https://github.com/Kryschuuu/ai-trading-firm/pull/137)
(`arena/01a0b4c1-ai-trading-firm`).

### Hinzugefügt

- **Neue append-only Tabelle `trade_journal`** (Migration
  `drizzle/2026-09-18_trade_journal.sql`, alternativ `npx drizzle-kit push`;
  **keine Änderung bestehender Tabellen/Spalten** — die fehlende Verknüpfung
  wird über ein Foto im Journal geschlossen, nicht über neue FKs an
  `positions`):
  - `position_id` (UNIQUE, FK), `symbol`, `side`, `opened_at`, `closed_at`,
    `mission_id`, `rule_id`, `decision_snapshot` (jsonb), `regime`
    (UNKNOWN erlaubt), `pnl`, `mae_pct`, `mfe_pct`, `holding_minutes`,
    `exit_reason`, `quality` (OK | CANDLE_GAP | NO_DATA | ERROR), `created_at`.
  - **Schreibweg (a) bei Eröffnung** (Engine EXECUTOR-Direktpfad,
    genehmigtes Proposal, Mikro-Executor-Regelpfad): `decision_snapshot` =
    unveränderliches Foto der Entscheidungskette — Attribution
    `PROPOSAL`/`RULE`/`UNKNOWN`, Stimmen (Agenten-Turns der Mission im
    6h-Fenster), Proposer, Regime, `rationale_hash` (sha256(reason+detail)
    bzw. Regel-Signatur). **Fehlt die Verknüpfung (z. B. manuelle
    Altbestands-Position), trägt der Snapshot `attribution: "UNKNOWN"` —
    die Lücke ist sichtbar, wird nie still geraten (fail-closed).**
  - **Schreibweg (b) beim Close** (Monitor SL/TP, Emergency-Flatten):
    PnL, Haltedauer, Exit-Reason + MAE/MFE; fehlende Zeile wird mit
    UNKNOWN-Snapshot nachgetragen (Backfill).
  - Robustheitsvertrag: ein Journal-Fehler **bricht den Handelspfad nie ab**
    (CRITICAL-Audit `JOURNAL_WRITE_FAILED`, Lücke bleibt in der Tabelle
    sichtbar).
- **MAE/MFE aus Kerzen** (`src/lib/journalMetrics.ts`, rein/deterministisch):
  Zeitmaske nur auf Kerzen mit Intervallstart ∈ [Eröffnung, Close] (Default
  1h, `JOURNAL_CANDLES_TIMEFRAME`); einheitliches **P&L-Vorzeichen**
  (MAE = P&L am ungünstigsten Kurs ≤ 0, MFE = P&L am günstigsten Kurs ≥ 0,
  LONG und SHORT). **Kerzenlücke ⇒ Metriken null + Flag `CANDLE_GAP`
  (niemals geschätzt)**; leeres Fenster ⇒ `NO_DATA`.
- **Auswertung** (`src/lib/journalAnalytics.ts`): Trefferquote/Erwartungswert
  je Agent × Regime × Symbolgruppe (Asset-Klasse der Registry) mit
  **Beta-Prior-Glättung α=β=2** (dokumentierte Konstante
  `JOURNAL_BETA_PRIOR`) und **Mindest-Stichprobe `JOURNAL_MIN_TRADES`
  (Default 20, Bounds [5,200])** — darunter Status `insufficient-sample`
  und die Kennzahl wird **niemals als Faktor** verwendet.
- **Read-API `GET /api/firm/journal`** (SEC-02-Muster: `firm.read`,
  `force-dynamic`, `no-store`): vollständige Summary (Totals inkl.
  attributed/unattributed, Gruppen, Gewichtsstand/Vorschläge). DB-Fehler ⇒
  sauberes `503 JOURNAL_UNAVAILABLE`.
- **Zyklus-Artefakte:** der Daily-Cycle schreibt `journal-feedback.json` +
  `journal-summary.json` neben die übrigen Tages-Artefakte (best-effort —
  ein Journal-Fehler bricht den Zyklus nie ab).
- **Begrenzte Gewichts-Rückführung `JOURNAL_FEEDBACK_MODE`** (Default **off**):
  - `off` — nur Auswertung; Entscheidungspfad bleibt **byte-identisch** zu
    v1.42.x (kein Prompt-Kontext, keine Gewichtszeilen).
  - `monitor` — vorgeschlagene Gewichte als `audit_log`-Events
    (`JOURNAL_WEIGHT_PROPOSED`) + Zyklus-Artefakt; Entscheidungspfad
    unverändert.
  - `enforce` — Gewichte werden in der neuen Tabelle
    `journal_agent_weights` persistiert (`JOURNAL_WEIGHT_APPLIED`,
    revisionssicher `journal-weight:AGENT:REGIME:x→y`) und wirken im
    Approver-/Portfolio-Prompt der Engine (Regime-scope).
  - **Schutzschalen (GAP-03 D4):** Bounds
    [`JOURNAL_WEIGHT_MIN`=0.5, `JOURNAL_WEIGHT_MAX`=1.5], **maximale
    Änderung je Zyklus `JOURNAL_MAX_WEIGHT_DELTA` (Default 0.1, Bounds
    [0.01,0.5])** → selbst extreme Serien bewegen Gewichte nur
    schrittweise; Bayes-Glättung FIRST (frische Trades können ohne
    ausreichend großen Beleg kein Gewicht außerhalb der Bounds treiben).
  - **Sicherheitsbegründung des off-Defaults:** ein Lern-Loop ist genau dort
    am gefährlichsten, wo er kleine Stichproben als Signal umsetzen würde;
    deshalb reiner Nachschlageweg bis der Operator die Auswertung geprüft
    hat (→ monitor → optional enforce).
- **Tests** `tests/tradeJournal.test.ts` (21 Tests): MAE/MFE-Handreferenzen
  LONG+SHORT (inkl. Zeitmaske, CANDLE_GAP/NO_DATA), Glättung (2/3 nahe am
  Prior, 20/30 empirisch, n=0 → 0.5), Bounds/maxDelta (Clamp, schrittweise
  Multi-Zyklus-Annäherung), Config-Clamp/fail-closed, E2E-Attribution über
  `executeApprovedProposal` (Snapshot korrekt, Close-Metriken,
  UNKNOWN-Backfill, idempotente Eröffnung), Auswertung (insufficient-sample
  nie als Faktor) + Modus-Verhalten off/monitor/enforce mit audit_log- und
  `journal_agent_weights`-Prüfung, Quellmuster-Wiring aller Schreibpfade.

### Dokumentation

- `docs/HANDBUCH.md`: neuer Abschnitt **§13 „Trade-Journal“**
  (Attribution, KPIs, Glättung, Feedback-Modi + Sicherheitsbegründung,
  Diagnose).
- `CONFIGURATION.md` + `.env.example`: sechs neue `JOURNAL_*`-Flags mit
  Defaults/Bounds.
- `docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md`: GAP-03 →
  IN_PROGRESS (dieser PR; FIXED nach Merge); Finding-Datei um
  „Umsetzung“-Abschnitt ergänzt.

### Nicht enthalten (bewusst)

- Keine Qualitätsbefund-Verarbeitung (z. B. automatische Degradierung bei
  vielen CANDLE_GAP) — die Flaggs sind vorhanden und sichtbar, die
  Auswertung gehört in einen Folge-Release.
- Keine Änderung an `src/live-gate/**` (Paper-only bleibt erzwungen); keine
  neuen Runtime-Dependencies.

## [1.42.0] — 2026-09-18 · feat(backtest): Multi-Asset Event-Driven Backtest-Engine & Replay-Simulator (Task 02)

**Umfang & Architektur (Task 02):** Einführung der deterministischen,
ereignisgesteuerten Multi-Asset-Backtest-Engine unter `src/backtest/`
(`engine.ts`, `portfolio.ts`, `simulator.ts`, `metrics.ts`, `types.ts`).

- **Multi-Asset Event-Driven Timeline:** Synchronisierte Zeitachsen-Iteration
  über N Instrumente (`HistoricalStore`) und N Strategieregeln / Research-Setups
  ohne Lookahead-Bias.
- **Ausführungs- und Kostenmodelle:** Konfigurierbare Slippage-Modelle
  (`fixed`, `spread_relative`, `none`), Maker/Taker-Gebühren und
  konservativer Stop-Loss-Vorrang bei Kerzen-Kollisionen.
- **Zentrales Portfolio-Management:** Simulation von Cash, aggregiertem
  Mark-to-Market-Eigenkapital, systemweiten Positions- und Risikodeckeln
  (`maxOpenPositions`, `maxPositionPct`, `maxRiskPerTrade`).
- **Mathematisch fundierte Kennzahlen:** Sharpe Ratio, Sortino Ratio,
  Max Drawdown mit Recovery-Dauer, Profit Factor, Win Rate, Expectancy,
  CAGR, Calmar Ratio, Streak-Statistiken sowie Symbol- und Strategie-Breakdowns.
- **Cycle- und API-Integration:** Step 8 (`src/cycle/steps/backtestStep.ts`)
  nutzt nun die echte Multi-Asset-Engine für Setup-Verifikationen; neuer
  Endpunkt `POST /api/firm/backtest` für Multi-Asset-Backtests.
- **Dokumentation:** `docs/BACKTEST_ENGINE.md`, ADR-007 in `docs/roadmap/DECISIONS.md`,
  Aktualisierung von `docs/roadmap/STATUS.md` und `docs/architecture/INTEGRATION_POINTS.md`.
## [1.42.0] — 2026-09-18 · feat(paper): Funding-Kosten im Paper-PnL + kalibrierbare Execution-Simulation (GAP-02)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-02](docs/audits/2026-09-18-feature-gap/findings/GAP-02-execution-simulation.md))
bildete der Fill-Simulator zwar Gebühren, Spread, Slippage und Partial Fills ab,
aber **Perpetual-Funding floss nicht ins Paper-PnL** — Funding existierte nur
als Scanner-Ranking-Faktor. Gerade bei längeren Haltedauern frisst Funding real
die Edge; Paper-Ergebnisse waren damit systematisch zu optimistisch. Dieser
Release schließt die Lücke (PROMPT-02 der Remediation-Serie) und macht die
Simulationsparameter kalibrierbar. Umsetzung: PR
[#136](https://github.com/Kryschuuu/ai-trading-firm/pull/136)
(`arena/01a0b48a-ai-trading-firm`).

### Hinzugefügt

- **Funding-Accrual je offener Perpetual-Position** (`src/lib/funding.ts`, neu):
  - Gebucht im Monitor-Tick bei **Periodenwechsel** (Default: 8h-Marken
    00/08/16 UTC; `PAPER_FUNDING_INTERVAL_HOURS`, Bounds [1, 24]). Erste
    Sichtung nach Prozessstart bucht nichts nach; Standby über mehrere Marken
    bucht `periods`-fach.
  - Formel `funding = fundingRate · |notional| · direction` (LONG = +1 zahlt
    bei positiver Rate, SHORT = −1 erhält). Verbindliche
    **Vorzeichenkonvention (Kontosicht)**: negativ = gezahlt, positiv =
    erhalten — dokumentiert in `docs/PAPER_TRADING.md` §3.2.
  - **Rate-Quelle gestuft:** (a) statisch über `PAPER_FUNDING_RATE_PCT_PER_8H`
    (Default `0` = **neutral** — bestehende Tests und Installationen bleiben
    unverändert grün), (b) Erweiterungspunkt `FundingRateProvider`
    (`getFundingRate(symbol)`) für echte Raten — ohne Netzwerk-Anbindung in
    diesem Release.
  - **Nur Perpetuals** zahlen (Registry-Lookup über den Marktdaten-Manager;
    Spot/Aktien/unbekannt ⇒ kein Funding, fail-safe gegen erfundene Lasten).
  - **Revisionssicher:** jedes Accrual-Ereignis ins `audit_log`
    (`FUNDING_ACCRUAL`, Muster `funding:SYMBOL:+0.42`, Audit-Senke mit Retry +
    Spool). Schlägt die Persistenz fehl, wird die Ledger-Buchung
    zurückgerollt (fail-closed).
- **Neue DB-Spalte `positions.funding_paid`** (numeric, NOT NULL DEFAULT 0;
  append-only Migration `drizzle/2026-09-18_positions_funding.sql`, alternativ
  `npx drizzle-kit push`): kumuliertes Funding je Position, bleibt nach
  Schließen stehen (Lifetime-Historie).
- **Equity- & Positions-Ausweis:** Funding wirkt als echter Cashflow auf Cash
  und damit `accountEquity` (wie Gebühren beim Fill — keine Doppelzählung);
  `PaperBroker.accrueFunding`/`totalFundingPaid`, `fundingPaid` je Position in
  `listPositions`/Adapter (`BrokerPosition`, optional), Restore (`getBroker`)
  hydratiert `funding_paid` (auch im Legacy-Cash-Pfad).
  `GET /api/firm` zeigt `fundingPaid` je Position sowie `account.fundingPaid`
  (SUMME über alle Positionen) und `account.fundingPaidOpen` (offene).
- **Kalibrierung der Execution-Simulation** (GAP-02 D3): `PAPER_MAKER_FEE_PCT`,
  `PAPER_TAKER_FEE_PCT`, `PAPER_SLIPPAGE_BPS`, `PAPER_SPREAD_FALLBACK_BPS` —
  Overlay über die `PAPER_SIM_*`-Basis in `createPaperExecution`
  (`calibrateSimulatorConfig`), Defaults = heutige hartcodierte Werte (kein
  Verhaltensbruch), Bounds-Clamp **mit Log-Warnung** bei Korrektur
  (`envNumber`, Muster `src/lib/env.ts`).
- **Monitor-Tick-Ergebnis** um `fundingAccruals` erweitert (pro Tick gebuchte
  Accruals; Default-Konfiguration ⇒ immer leer).
- **Tests** `tests/paper.funding.test.ts` (15 Tests): Vorzeichen exakt, Accrual
  nur bei Periodenwechsel (injizierbare Clock, zweimal ticken ⇒ genau eine
  Buchung), Equity-Abgleich („equity nach Accrual = vorher + fundingPaid-
  Summe“), Bounds/Clamp-Warnungen, Rate-Default 0 = neutral, nur Perpetuals,
  Rate-Quelle gestuft, Persistenz-Fehler ⇒ Ledger-Rollback, Determinismus
  (identische Quote-Folge ⇒ SHA-256-identische Fills; Engine ohne
  Date.now()/Math.random()).

### Dokumentation

- `docs/PAPER_TRADING.md`: neue Abschnitte **§3.1 „Gebühren, Slippage &
  Kalibrierung“** und **§3.2 „Funding-Accrual für Perpetuals“** (inkl.
  Vorzeichenkonvention, Flag-Tabellen, Migrations-Hinweis) + §6-Env-Tabelle.
- `CONFIGURATION.md` + `.env.example`: sechs neue Flags mit Defaults/Bounds.
- `docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md`: GAP-02 → FIXED
  (v1.42.0); Finding-Datei um „Umsetzung“-Abschnitt ergänzt.

### Nicht enthalten (bewusst)

- Keine echte Funding-Raten-Anbindung (z. B. Bitunix REST/WS) — nur das
  Provider-Interface als Erweiterungspunkt (siehe „Offene Punkte“ im
  GAP-02-Finding).
- Keine Änderung an `src/live-gate/**` (Paper-only bleibt erzwungen); keine
  neuen Runtime-Dependencies.

## [1.41.0] — 2026-09-18 · docs(audit): Feature-Gap-Audit 2026-09-18 (Co-Audit) + ausführbare Arena-Prompt-Serie (GAP-01…GAP-10)

**Hintergrund:** Ein externes Co-Audit (Arena-Session) bewertete das Repo —
ohne Code-Zugriff — als **asymmetrisch reif**: Security, Auth, Audit-Trail
und Betrieb auf Produktionsniveau, aber die Trading-Qualität selbst
(Validierung vor Papiergeld, realistische Fills, Lernschleife) aus dem
sichtbaren Material kaum belegt. Daraus entstand eine Top-10-Liste fehlender
Funktionen. Dieser Release macht daraus einen **ordentlichen Audit-Zyklus**
nach Repo-Konvention (`docs/audits/YYYY-MM-DD-<quelle>-<name>/`) und eine
**abarbeitbare Prompt-Serie** für Arena-Sessions — jeder Prompt self-contained,
mit Verifikationspflicht, Testplan, Docs-Sync- und Changelog-Pflicht.

### Hinzugefügt

- **Audit-Zyklus [`docs/audits/2026-09-18-feature-gap/`](docs/audits/2026-09-18-feature-gap/README.md):**
  - `report.md` — vollständiger Wortlaut des Co-Audits (Teil 1, unverändert
    bewahrt) **plus** Code-Verifikation (Teil 2): je Finding der verifizierte
    Ist-Stand mit Datei-Evidenz auf Basis v1.40.0.
  - `findings/GAP-01…GAP-10` — je Lücke: Befund, verifizierter Ist-Stand,
    Delta, Akzeptanzkriterien.
  - `remediation/TRACKING.md` — Status-SSoT (GAP-01…GAP-10 = OPEN; zusätzlich
    neuer Befund **ENV-01**: `tests/secretStore.test.ts` fällt im
    Voll-Suite-Lauf aus, wenn unter `DATABASE_URL` eine erreichbare DB
    antwortet — Test-Isolation, standalone grün, vorab existierend).
  - `prompts/` — **PROMPT-00 (Baseline) + PROMPT-01…PROMPT-10**: einpaste-
    fähige Session-Prompts mit empfohlener Reihenfolge (02 → 05 → 10 → 04 →
    06 → 07 → 03 → 08 → 01 → 09; hart: 01 erst nach 02+07) und harten
    Guardrails (Paper-only, Fail-closed, keine neuen Runtime-Dependencies,
    Bounds+Flags-Pflicht, audit_log, append-only-Migrationen, Determinismus).
- **Verifikations-Befunde (Teil 2 des Reports), die das Co-Audit korrigieren:**
  Die Execution-Simulation (GAP-02) und der SL/TP-Watcher (GAP-05) sind
  bereits großteils vorhanden; die Prompts arbeiten nur noch die Deltas ab
  (Funding im PnL, Trailing/Time-Stop/OCO-Exklusivität). Umgekehrt bestätigt:
  der Backtest-Step fällt bei <5 Kerzen auf eine **synthetische Serie**
  zurück („20 Trades, 55 % Winrate“) — als Anti-Pattern dokumentiert; der
  Abbau ist Teil von PROMPT-01.
- **Dashboard-Sichtbarkeit:** Katalog-Eintrag `auditFeatureGap`
  (`GET /api/docs`), Tabellen-Einträge in `docs/README.md` + `README.md`,
  Tracker-Eintrag **Task 17** in `docs/ARENA_TASKS.md`.

### Geändert

- **GitHub-Repo-Description korrigiert** (Doku-Befund des Co-Audits): lautete
  „…modulare Python-basierte Handelsplattform…“, Stack ist aber
  Node.js/TypeScript (Next.js 16 + Drizzle). Korrektur außerhalb des Codes
  per GitHub-Admin (in diesem PR dokumentiert).

### Nicht enthalten (bewusst)

- Keine Code-Änderung an der Trading-Logik: Umsetzung der Lücken erfolgt
  je Prompt in eigenen Sessions/PRs (Reihenfolge + Abhängigkeiten siehe
  [Prompt-Serie](docs/audits/2026-09-18-feature-gap/prompts/README.md)).

## [1.40.0] — 2026-09-18 · fix(market-sync): Cross-Prozess-Sichtbarkeit, leere Kerzen als DATA_UNAVAILABLE, Registry-Race & Scanner-Cache (250 → WARMING-Bug)

### Behoben

- **Scanner-Fix 250 → WARMING (Regression):** Der Markt-Scanner fiel
  sporadisch auf `WARMING (0/250)` zurück, wenn ein Worker-Tick den In-Memory-
  Ringpuffer mit < 250 DB-Kerzen vorübergehend überschrieb. Der Zustand wird
  jetzt transaktionssicher gesperrt, Kerzenanzahlen unter 250 führen zu
  präzisen Fehlermeldungen statt silent state resets.
- **Cross-Prozess-Cache-Invalidierung:** DB-Aktualisierungen von Kerzen
  triggern jetzt zuverlässig die Invalidation der In-Memory-Stores über
  Postgres `pg_notify` / Registry-Sync.
