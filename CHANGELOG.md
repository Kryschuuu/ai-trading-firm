# Changelog — Autonome KI-Trading-Firma

> **Status-Header:** Konsolidierter Überblick · **2026-09-18** · Code-Version **1.44.0**. Vollständige, detaillierte Einträge je Release (Keep a Changelog + SemVer) — kanonische Datei im Root (ehemals `docs/CHANGELOG.md` als Duplikat, jetzt konsolidiert).

# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen an der Handelsplattform `ai-trading-firm`
werden in dieser Datei dokumentiert.

Das Format basiert auf
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).

## [1.44.0] — 2026-09-18 · feat(paper): Server-seitiges Exit-Management — Trailing-Stop, Time-Stop, OCO-Exklusivität (GAP-05)

**Hintergrund:** Laut Feature-Gap-Audit 2026-09-18
([GAP-05](docs/audits/2026-09-18-feature-gap/findings/GAP-05-server-side-exit-management.md))
prüft der Monitor zwar serverseitig Stop-Loss/Take-Profit unabhängig von
LLM-Turns — Trailing-Stop und Time-Stop fehlten jedoch vollständig, und die
Garantie „genau **ein** Exit pro Position, auch bei parallelen Ticks/Instanzen“
war nicht belegt (Check-then-Act im Prozessspeicher). Dieser Release schließt
das Delta (PROMPT-05 der Remediation-Serie): paper-only, Fail-closed, alle
Flags per Default **aus** (= heutiges Verhalten), keine neuen
Runtime-Dependencies. Umsetzung: Branch `arena/01a0b5f8-ai-trading-firm`.

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
