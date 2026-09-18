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
