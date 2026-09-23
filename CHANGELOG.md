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

> **Status-Header:** **Beta** · Dokumentationsstand **2026-09-23** · Code-Version **0.1.0** ·
> Kanonische Quelle der Version: `package.json` (siehe [`VERSION.md`](VERSION.md)).

## [Unreleased]

_Noch nicht freigegeben._

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
| **v0.1.0** (Beta) | v1.73.1 | 2026-09-23 | Beta-Baseline: vollständiger Funktionsstand + Re-Versionierung/Struktur/Doku |

Legacy-Verweise auf `v1.40.0` … `v1.73.0` in Audits, Peers-Reviews und der
Dokumentation bezeichnen die jeweiligen Beta-Stände der Tabelle oben
(detailliert im Archiv-Changelog). Es gibt **keine** öffentliche Version `1.x` —
die Legacy-Zählung ist rein historisch.
