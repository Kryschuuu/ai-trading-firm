# Changelog — Autonome KI-Trading-Firma

> **Status-Header:** Konsolidierter Überblick · **2026-09-18** · Code-Version **1.42.0**. Vollständige, detaillierte Einträge je Release (Keep a Changelog + SemVer) — kanonische Datei im Root (ehemals `docs/CHANGELOG.md` als Duplikat, jetzt konsolidiert).

# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen an der Handelsplattform `ai-trading-firm`
werden in dieser Datei dokumentiert.

Das Format basiert auf
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).

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
