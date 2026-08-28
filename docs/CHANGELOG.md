# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen werden hier dokumentiert. Das Format folgt
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).

## Versionierungsrichtlinie

| Versionsstelle | Bedeutung | Beispiel |
| --- | --- | --- |
| **MAJOR** (1.x.y) | Breaking Changes: DB-Schema-Brüche, entfernte Env-Variablen, neue Pflichtkonfiguration | 2.0.0 |
| **MINOR** (x.1.y) | Neue Features (z. B. Provider), abwärtskompatibel | 1.2.0 |
| **PATCH** (x.y.1) | Bugfixes und Sicherheits-Fixes, abwärtskompatibel | 1.1.1 |

* Die Version steht in `package.json` (`"version"`) und wird von `/api/health`
  (`"version"`) und `/api/firm` (`"version"`) ausgeliefert.
* Empfohlene Deploy-Kette: `git pull` → `npm ci` → `npx drizzle-kit push` →
  `npm run build` → `sudo systemctl restart ai-trading-firm`.
* Migrationshinweise stehen in der jeweils betroffenen Release-Sektion.

---

## [1.16.0] — 2026-08-28

**Broker Control Plane (Task 08): Backend-Credential-Manager mit
verschlüsseltem Secret-Store und das Frontend „Brokers & Venues".**
Datenfluss verbindlich: Frontend (masked credential form) → Backend →
verschlüsselter Secret-Store → Broker-Adapter; Frontend erhält NUR Status.
Live bleibt überall OFF (`liveEnabled:false`, einzige Quelle =
Gate-Service-Meldung bis task-11).

### Neu: `src/brokers/control-plane/`

- **Secret-Store:** AES-256-GCM mit **AAD = Venue-ID** (Auth-Tag bindet den
  Datensatz an die Venue), frischer IV je `put`, Buffer-Nullung (zeroize).
  Key ausschließlich aus Env/KMS (`SECRET_STORE_KEY`; KMS-Hook
  `SECRET_STORE_KMS_ENDPOINT` vorbereitet, fail-safe). Backends: DB
  (`broker_credentials`, verschlüsselte Envelopes) → Datei-Fallback
  (`data/secrets/*.enc`, 600, gitignored) → Memory (Tests). Interface
  `put/get/delete/exists`; Task-07-Bridge `createVenueBackedNamedStore`.
- **Credential-API:** `POST|DELETE /api/brokers/{venue}/credentials`,
  `GET …/status`, `POST …/test` (healthCheck + read-only Probe →
  `permissions[]`), `POST …/discover`. Antworten **status-only**
  (configured/connected/permissions[]/liveEnabled) — kein Echo, kein
  `keyHint`, keine Maskierung. Fehler 403/404/409/422/429/503 mit SAFE-Meldungen.
- **Zustandsmodell:** 6 Ebenen (connection, marketDiscovery, permissions,
  paper, testnet, live) × off/pending/active/error; Übergänge nur über
  `save|test|discover|disable`, Missbrauch → 409/422. **Live immer off.**
- **Permission-Probe (read-only):** PAPER real gegen den Ledger; andere
  Venues über lokalen Mock-Adapter (Unabhängigkeitsklausel, kein Netzwerk);
  Fehler → Ebene `error` mit SAFE-Meldung.
- **Sicherheit:** Admin-Guard (RBAC-Platzhalter, `FIRM_ADMIN_TOKEN`,
  TODO(task-10)), CSRF (`x-csrf-token`), Credential-Rate-Limit
  (5/min/IP, `BROKER_CREDENTIAL_RATE_LIMIT`), Audit je Ereignis
  (`BROKER_CONTROL_PLANE`: actor, venue, Aktion, Ergebnis, timestamp —
  ohne Secrets), Response-/Bundle-Secret-Scanner (`npm run scan:secrets`).

### Neu: Frontend „Brokers & Venues"

- Karten je Broker: Status-LED, Markets-Anzahl, Spot/Perpetual/Futures-Flags,
  Buttons [Verbinden] [Test] [Einstellungen], 6 Zustands-Chips je Ebene,
  Permissions-Badges, Loading-/Error-/Empty-States.
- Masked credential form (`type="password"`,
  `autoComplete="new-password"`, `noValidate`, State wird nach Submit
  geleert; kein Client-Speicher). Settings = read-only Flags inkl.
  `liveEnabled` mit deutlichem „gesperrt"-Zustand; Bestätigungsdialog vor
  Credential-Löschen.
- Neuer Dashboard-Tab „🌐 Brokers & Venues" + eigenständige Seite
  `/brokers` (ohne Firm-DB, Control-Plane-REST-Contract only).

### Geändert

- `src/db/schema.ts`: neue Tabelle `broker_credentials` (venue PK,
  verschlüsseltes Envelope) → `npx drizzle-kit push` erforderlich.
- `src/lib/seed.ts`: `broker_credentials` in der Schema-Prüfung.
- `src/lib/auditView.ts`: Katalog-Eintrag `BROKER_CONTROL_PLANE`.
- `.env.example`: `SECRET_STORE_KEY`, `SECRET_STORE_KMS_ENDPOINT`,
  `BROKER_SECRET_BACKEND`, `BROKER_SECRET_DIR`, `FIRM_ADMIN_TOKEN`,
  `BROKER_CREDENTIAL_RATE_LIMIT`.
- `package.json`: v1.16.0, Scripts `scan:secrets`,
  `test:coverage:controlplane`.

### Tests & Doku

- Neu: `tests/secretStore.test.ts` (Roundtrip, Wrong-Key, Tampering →
  Auth-Tag, AAD-Bindung, Zeroize, Backends, Task-07-Bridge),
  `tests/controlPlane.{states,api,integration,security,e2e}.test.ts`
  (Zustandsmaschine, RBAC/CSRF/Rate-Limit, Response-Scanner über ALLE
  Broker-API-Responses, Bundle-Scanner, Connect-Flow, Audit je Aktion,
  E2E Connect → Test → Status → Disconnect).
- Neu: `docs/FRONTEND_CONTROL_PLANE.md` (Datenfluss, API-Referenz,
  Zustandsmodell, Sicherheitskonzept, „Warum das Secret nie anzeigbar ist").
- Update: `docs/BROKER_ARCHITECTURE.md` (Control-Plane-Abschnitt),
  `docs/help/brokers.help.json` (3-Ebenen-Hilfe), `docs/SECURITY_AUDIT.md`
  (Kapitel „Security Audit — Task 08").

---

## [1.15.0] — 2026-08-27

**Bitunix-Adapter als 7. Venue (Task 07): Public REST/WS für USDT-M-Perpetuals,
offizielle Doppel-SHA256-Signatur, Paper-Modus B gegen echte Kurse, Live-Pfad
weiterhin hart `LiveTradingGateError` (`TODO(task-11)`). Kein dokumentiertes
Testnet, keine echten Private-Calls in Tests.**

### Neu: `src/brokers/bitunix/`

- **Public REST:** `trading_pairs` → `MarketInstrument` (`marketType=perpetual`,
  Registry-Upsert `source=discovery:bitunix`), Ticker (`lastPrice`/`markPrice`/
  `quoteVol`/`baseVol`/`high`/`low`), Klines, Orderbuch.
- **Public WS:** Channels `ticker` und `market_kline_*` mit Reconnect, exponentiellem
  Backoff und Resubscribe; Ticker = Full-Replace, Kline = Delta gleicher `time`.
- **Signing:** `SHA256(SHA256(nonce+timestamp+api-key+queryParams+body)+secret)`,
  UTF-8, Hex lower-case; Query ASCII-sortiert ohne Trenner; Body kompakt.
  Golden-Tests (inkl. offiziellem Doku-Beispiel).
- **Private REST vorbereitet:** Account, Pending-Positions, Place-Order inkl.
  `slPrice`/`tpPrice` (`stopAtVenue=true`). Der Adapter-Live-Pfad sendet **nie**.
- **Gates:** `BITUNIX_ENABLED` / `BITUNIX_LIVE_ENABLED` / `LIVE_TRADING_ENABLED`
  Default aus; `REQUIRE_HUMAN_APPROVAL` für Live nur bei exakt `"false"` offen.
  16 Flag-Kombinationen → immer `LiveTradingGateError`.
- **Secrets:** `SecretStore` + Env-Fallback `BITUNIX_API_KEY`/`BITUNIX_API_SECRET`
  (`TODO(task-08)`). Redactor maskiert Keys, Header und Hex-Signaturen.
- **SSRF/TLS/Rate-Limit:** Host-Allowlist `fapi.bitunix.com`, TLS erzwungen,
  Token-Bucket 8 req/s, Timeout/Retry nur für 429/5xx.
- **Paper (Modus B):** echte Public-Kurse, lokales Ledger, 0 Private-Calls.

### Geändert

- `BROKER_VENUE_IDS` und Factory-Matrix: 6→**7** Venues, 24er→**28er**.
- `GET /api/brokers` `count=7`; BITUNIX `paperAvailable=true`, `liveAvailable=true`
  (Capability; Ausführung gesperrt). Health lokal `offline` solange Flag aus.
- `inferMarketType("BITUNIX")` → `perpetual`.
- Audit-Katalog: Event `BITUNIX_PRIVATE_CALL` (Methode/Pfad/Outcome, keine Secrets).

### Tests & Doku

- `tests/bitunix.*.test.ts` + Fixture-Server; Factory/Contracts/API auf 7 Venues.
- `docs/BITUNIX.md`, Update BROKER_ARCHITECTURE / MARKET_UNIVERSE / ARCHITECTURE §10.1,
  SECURITY_AUDIT Task 07, `docs/help/brokers.help.json`, `.env.example`.
- `npm run test:coverage:bitunix`.

### Migrationshinweise

Kein Schema-Bruch. Optional in `.env`: `BITUNIX_ENABLED=false` (Default). Live bleibt
gesperrt, auch wenn alle Flags gesetzt werden.

---

## [1.14.0] — 2026-08-27

**Daily & Weekly Agent Cycle mit Shortlist-Limits und Artefakten (Task 06):
Ein neues Modul `src/cycle/` orchestriert die strukturierte Tages- und Wochenroutine
der 12 Agenten-Rollen. Massenverarbeitung (Scanner, Backtest) läuft ohne Sprachmodell;
LLM-Analysen erfolgen ausschließlich auf gerankten Shortlists mit strikt im Code
erzwungenen Obergrenzen (max. 40 Instrumente an Technical Analyst und News Analyst).
Vollständiger Prompt-Injection-Schutz über strikte Datentrennung, versionierte
Artefakte mit konfigurierbarer Retention, Vorbereitung für LLM-Eskalationen
(`MODEL_ESCALATION_REQUEST`), injizierbare Uhr für Zeitraffer-Tests und vier neue
read-only REST-Endpunkte unter `/api/analysis/*`.**

### Neu: `src/cycle/` (Agent-Orchestrierung & Zyklus-Engine)

- **8-stufige Tagesroutine** (`daily.ts`, `steps/`):
  1. `00:00–06:00` **Market Scanner**: Deterministischer Scan ohne LLM (`llmAllowed: false`).
  2. `06:00–07:00` **Macro Analyst**: Cross-Market-Blick auf BTC, ETH, DXY, SPX, Nasdaq, Gold, Bonds + Volatilitätsregime.
  3. `07:00–08:00` **Market Selection**: Filtert und rankt die Daily Candidate List (max. 40 Instrumente).
  4. `08:00–09:00` **Technical Analyst**: Multi-Timeframe-TA, **Code-Limit: max. 40 Instrumente** (`assertShortlistLimit`).
  5. `09:00–10:00` **News Analyst**: News-Sentiment & systemisches Risiko, **Code-Limit: max. 40 Instrumente**, Prompt-Injection-Schutz.
  6. `10:00–11:00` **Risk Manager**: Korrelationscluster & Portfolio-Exposure-Bewertung über Task 05 (`AnalyticsPort`).
  7. **danach** **Research**: Konkrete Trade-Setups mit Entry/SL/TP — verbindlich als Vorschläge markiert (`isProposal: true`, keine Orders).
  8. **danach** **Backtest-Verifikation**: Deterministische Verifikation historischer Kennzahlen (Max Drawdown, Profit Factor, Sharpe, Sortino, Regime-Robustheit) ohne LLM.
- **Weekly Universe Review** (`weekly.ts`):
  - 1× wöchentlich (konfigurierbarer Wochentag, Standard: Sonntag).
  - Bewertet neue Listings, Delistings, Liquiditäts- und Gebührenschnittstellen, Regimewechsel und Broker-Verfügbarkeit.
  - Erzeugt verbindliche Klassifikation `CORE` / `ROTATION` / `DISCOVERY` / `EXCLUDED` je Instrument mit bis zu 20 `reasons[]`.
- **Step-Engine & Scheduler** (`engine.ts`, `scheduler.ts`, `clock.ts`):
  - Injizierbare Uhr (`SimulatedClock`) ermöglicht das Durchspielen ganzer Tage/Wochen in Millisekunden.
  - Laufzeit-Gate sperrt LLM-Aufrufe bei `llmAllowed: false`.
  - Konfigurierbare `RetryPolicy` je Schritt mit exponentiellem Backoff.
  - Kontrollierter Abbruch bei Fehlschlägen (`status: "FAILED"`, Audit-Eintrag, bestehende Artefakte bleiben integer).
- **Prompt-Injection-Schutz & Schemavalidierung** (`security.ts`, `schemas.ts`):
  - Externe Inhalte (RSS-Feeds, Marktdaten) werden über `wrapUntrustedData` strikt als Daten gekapselt.
  - Nicht-konforme Antworten werden verworfen und durch deterministische Fallbacks ersetzt.
- **Modell-Eskalations-Event** (`MODEL_ESCALATION_REQUEST`):
  - Schritte dürfen ein Eskalations-Event emittieren; ohne Task-09 fällt das System transparent auf die Provider-Fallback-Kette zurück.
- **Artefakt- & Speicherverwaltung** (`artifacts.ts`):
  - `artifacts/YYYY-MM-DD/daily/*.json` (je Step eine Datei + `daily-summary.json`).
  - `artifacts/YYYY-Www/weekly/*.json` (`weekly-review.json` + `universe-classification.json`).
  - `artifacts/index.json` (globales Manifest aller Läufe).
  - Konfigurierbare Retention (`retentionDays`, `retentionWeeks`, `pruneArtifacts()`).

### Neu: Read-only API (`/api/analysis/*`)

- `GET /api/analysis/daily/latest`: Jüngster Tageslauf inklusive Zusammenfassung und Step-Outputs.
- `GET /api/analysis/daily/{date}`: Tageslauf für ein konkretes Datum `YYYY-MM-DD` (validiert).
- `GET /api/analysis/weekly/latest`: Jüngster wöchentlicher Universe Review.
- `GET /api/analysis/runs`: Paginierte Historie aller Zyklen (`type=daily|weekly|all`, `status`, `page`, `pageSize`).

### Dokumentation & Feldhilfe

- `docs/DAILY_WEEKLY_RESEARCH.md`: Umfassendes Kapitel 13 zur Tages- und Wochenroutine.
- `docs/HANDBUCH.md`: Neues Kapitel 19 „Tagesroutine der Mitarbeiter (Agenten-Zyklus)“.
- `docs/help/cycle.help.json`: 3-Ebenen-Hilfe (kurzinfo, technischeInfo, risiko) für alle Zyklus-Konzepte.
- `docs/SECURITY_AUDIT.md`: Kapitel „Security Audit — Task 06“.

---

## [1.13.0] — 2026-08-27

**Deterministische Portfolio-Analytics, Optimizer und Risk-Guard-Kette (Task 05):
ein neues Modul `src/portfolio/` berechnet Kennzahlen, Korrelations- und
Kovarianzmatrizen sowie Portfoliogewichte in drei Modi — und jedes Ergebnis läuft
durch eine feste Kontrollkette: Portfolio Optimizer → Risk Guard → Position Limits →
Correlation Limits. Reine Funktionen, keine I/O, kein LLM, kein Zufall, keine Uhr.
Gleiche Eingabe ergibt byte-identische Ausgabe; jede Guard-Entscheidung wird
auditiert.**

### Neu: `src/portfolio/` (deterministische Rechenschicht — kein LLM)

- **Kennzahl-Bibliothek** (`metrics.ts`, reine Funktionen, Formel im TSDoc jeder
  Funktion): logarithmische Renditen, realisierte Volatilität
  (`σ · √A`, Annualisierungsfaktor je Anlageklasse konfigurierbar — Krypto 365,
  Aktien/ETF/Indizes/FX/Rohstoffe 252), ATR mit Wilder-RMA (Default-Periode 14),
  Sharpe `(r̄ − r_f/A)/σ`, Sortino mit Downside-Deviation, Max Drawdown inkl.
  `peakIndex`/`troughIndex`/`recoveryIndex`/Dauer, Profit Factor, annualisierte
  Rendite und Volatilitätsregime `LOW/NORMAL/HIGH/EXTREME` (Schwellen 0,25/0,60/1,20,
  überschreibbar). Freiheitsgrade `ddof ∈ {0,1}` konfigurierbar (Default 1).
- **Korrelation & Kovarianz** (`correlation.ts`): Pearson **und** Spearman
  (Durchschnittsränge bei Gleichständen) als Matrix, Sample-Kovarianz (`ddof = 1`)
  und optional EWMA (Default `λ = 0,94`), Korrelationscluster per Union-Find über
  `|ρ| ≥ 0,8` (Schwellwert konfigurierbar). Nullvarianz ist definiert 0, nie `NaN`.
- **Optimizer, drei Modi** (`optimize.ts`): `min_variance` (`min wᵀΣw`, FISTA +
  Active-Set-Polish über das KKT-System), `max_sharpe` (monotoner projizierter
  Aufstieg, drei deterministische Starts), `risk_parity` (Newton auf der
  Spinu-Formulierung, gleichmäßige Risikobeiträge `w_i(Σw)_i`). Nebenbedingungen
  `Σw = 1` und konfigurierbare Bounds (Default long-only). Toleranz 1e-9
  (enger als die geforderte 1e-6), Iterationslimit 2000, beides konfigurierbar;
  Konvergenz wird explizit berichtet (`converged`, `iterations`,
  `notes: ["NOT_CONVERGED:iterations=…"]`).
- **Risk-Guard-Kette** (`riskGuard.ts`, `pipeline.ts`): Positions-Limits
  (Default 20 % je Instrument, `maxPositions`, `minWeight` 0,1 %) und
  Korrelations-Limits (max. 50 % je Cluster). Ergebnis
  `{ rejected, adjusted, reasons[], decisions[], clusterExposures[] }`, jeder
  Schritt ein strukturierter Audit-Eintrag. Die Kette ist als Konstante
  `AUTHORITY_CHAIN` im Code erzwungen — `applyRiskGuard` akzeptiert ausschließlich
  Eingaben des Optimizers, `optimizeWithGuard()` ist der einzige öffentliche Weg
  zu Gewichten.
- **Numerische Robustheit** (`numeric.ts`): Cholesky, Jacobi-Eigenzerlegung,
  Pseudo-Inverse, Ridge-Regularisierung, Vektor-/Matrix-Operationen. Singuläre
  Matrizen sind **konfigurierbar**: `error` (Default), `ridge` oder
  `pseudo-inverse` — nie ein still falsches Ergebnis, immer dokumentiert in
  `diagnostics.regularization` und `notes[]`. Zusätzlich erklärt die Cholesky-
  Zerlegung Pivots unter `1e-12 · max(diag)` für singulär (zwei perfekt korrelierte
  Assets liefern in Gleitkomma sonst ein Pivot von ~1e-19). `NaN`/`±Infinity` in
  Eingaben sind definierte Fehler.
- **Agenten-Schnittstelle** `getAnalysisContext(returns, symbols)`
  (`context.ts`): liefert ausschließlich **fertige** Kennzahlen, Matrizen, Cluster
  und Limits an die Interpretations-Ebene — keine Gewichte, kein Rechenauftrag —
  und trägt die Leitplanke (`llmMay`/`llmMustNot`) direkt im Payload.
- **Audit-Senke** (`audit.ts`, `auditFile.ts`): `AuditSink`-Interface mit
  Memory-Senke (Standard, Ereignisse stehen in der API-Antwort) und
  NDJSON-Datei-Senke (opt-in über `PORTFOLIO_AUDIT_DIR`, atomar über tmp+rename,
  Dateiname gegen Path-Traversal validiert) — `// vgl. task-01/06` für die zentrale
  `audit_log`-Integration.

### Neu: read-only API `/api/portfolio/*`

- `POST /api/portfolio/metrics` — Kennzahlen je Serie (Preise, Renditen oder
  Log-Renditen, optional Kerzen für die ATR).
- `POST /api/portfolio/correlation` — Korrelationsmatrix (Pearson/Spearman) plus
  Cluster.
- `POST /api/portfolio/optimize` — Modus, Bounds, Kovarianz-Methode und Limits;
  antwortet mit Gewichten **und vollständigem Risk-Guard-Report** inklusive
  `audit[]`. Ein Guard-Verwurf ist `422 RISK_GUARD_REJECTION`, nie `200` mit
  falschen Gewichten.
- Alle drei Endpunkte: `GET` ⇒ `405`, einheitliches Fehlerformat
  `{ ok: false, error, message }`, Größenlimits (max. 1000 Serien, max. 2000
  Punkte je Serie, max. 400.000 Stichproben, Body ≤ 16 MiB) ⇒ `413 LIMIT_EXCEEDED`,
  Symbole werden normalisiert und gegen eine strikte Zeichenklasse geprüft
  (Log-Injection-Schutz).

### Tests & Doku

- **8 Testsuiten, 130 Tests** (`tests/portfolio.*.test.ts`): Golden-Tests gegen
  unabhängig in Python berechnete Referenzwerte (Toleranz 1e-6, Kovarianz/
  Optimizer bis 1e-12), analytische 2-Asset-Minimum-Varianz, Property-Tests
  (Risk-Parity-Spread `< 1e-4`, `Σw = 1`, Bounds, min-variance ≤ Gleichgewichtung,
  max-Sharpe ≥ Gleichgewichtung), Robustheit (singulär, `NaN`/`Infinity`,
  Iterationslimit), Risk-Guard-Tests (Kappung, Cluster-Verwurf, ein Audit-Eintrag
  je Entscheidung), API-Contract-Tests und Determinismus-Check.
- **Architekturtest** (`tests/portfolio.architecture.test.ts`): erzwingt per
  Quelltext-Scan, dass `src/portfolio/` kein LLM, kein Netzwerk, keine Datenbank,
  keinen Zufall, keine Uhr und keinen Dateizugriff importiert (einzige Ausnahme:
  `auditFile.ts`), dass jede exportierte Rechenfunktion eine Formel dokumentiert,
  dass die API ausschließlich über die Guard-Kette geht und dass Doku,
  Hilfe-JSON, README-Index, `/api/docs`-Whitelist und Security-Audit vollständig sind.
- **Unit-Tests der Infrastruktur** (`tests/portfolio.unit.test.ts`): Numerik-Primitives
  (Cholesky, Eigenzerlegung, Pseudo-Inverse, Regularisierung), Fehlercodes,
  Konfigurationsvalidierung, Audit-Senken inkl. Datei-Schreibfehler und DB-No-op,
  Request-Parser und Fehlerformat. Coverage der neuen Module: **96,41 %** Zeilen
  (`npm run test:coverage:portfolio`).
- **Benchmark** (`tests/portfolio.benchmark.test.ts`): 500 Assets × 750 Perioden
  (375.000 Stichproben) — Kovarianz 0,21 s, min_variance 0,45 s, max_sharpe 3,7 s,
  risk_parity 0,52 s, vollständige Pipeline 1,0 s ⇒ **5,8 s von 30 s Budget**.
- **Doku**: `docs/PORTFOLIO_ANALYTICS.md` (Formelkatalog mit Annahmen und Grenzen,
  Optimizer-Modi, Guard-Ketten-Diagramm, Konvergenz-/Numerikregeln, API-Referenz mit
  Beispielen, Abschnitt „Warum das LLM keine Gewichte berechnet"),
  `docs/help/portfolio.help.json` (10 Begriffe × 3 Ebenen), README-Index,
  `/api/docs`-Eintrag `portfolio`, `## Security Audit — Task 05`.
- Neues Kommando: `npm run test:coverage:portfolio`.

### Nicht enthalten (bewusst)

- **Keine Order- oder Portfolio-Mutation.** Das Modul erzeugt Gewichte und Reports;
  nichts davon wird ausgeführt, kein Portfolio-, Positions- oder Orderzustand wird
  verändert. Die Order-Guardrails in `src/lib/riskGuard.ts` bleiben unberührt.
- **Keine Kovarianz-Shrinkage** (Ledoit-Wolf) und kein Faktor-Modell — `ridge` und
  `pseudo-inverse` sind dokumentierte Notlösungen für singuläre Matrizen.
- **Keine Transaktionskosten, keine Steuern, kein Rebalancing, kein Leverage.**
- **Keine LLM-Beteiligung an der Berechnung.** Das Modell interpretiert fertige
  Zahlen; Gewichte entstehen ausschließlich im Optimizer.
- **`src/scanner/factors/correlation.ts`** (Task 04) behält vorerst seine eigene
  Pearson/Spearman-Implementierung — der Umzug auf `src/portfolio` ist dokumentiert,
  der Scanner bleibt unverändert lauffähig.

---

## [1.12.0] — 2026-08-27

**Deterministischer Markt-Scanner, Market Score und Trichter (Task 04): Aus bis
zu 10.000 Instrumenten wird täglich eine begründete Liste von 100 Rotations- und
20–40 Deep-Kandidaten. 14 Faktor-Module, neun gewichtete Score-Komponenten,
Volatilitätsregime, Weekly Universe Review, versionierte Tagesartefakte und drei
read-only API-Endpunkte. Kein LLM, kein Netzwerk, kein Zufall — gleiche Eingabe
ergibt byte-identische Ausgabe.**

### Neu: `src/scanner/` (deterministische Analyseschicht — kein LLM)

- **14 Faktor-Module** mit einheitlichem Interface `Factor { id, compute() }` →
  `FactorValue { raw, normalized ∈ [0,1], available, detail }`:
  `liquidity`, `spread`, `atr`, `volatility`, `momentum`, `trend`,
  `volumeRatio`, `rsi`, `drawdown`, `correlation`, `news`, `funding`,
  `openInterest`, `executionCost`. Jede Datei dokumentiert Formel,
  Normalisierung und Datenbedarf im TSDoc (per Architekturtest erzwungen).
- **News-Risiko ohne Sprachmodell**: reine Zählheuristik über Ereigniszahlen,
  High-Impact-Flag, anstehende Termine und die Frische der Registry-Daten.
- **Market Score 0–100** (`ranker.ts`) aus neun Komponenten mit exakten
  Gewichten **Liquidity 25 · Volatility 15 · Trend 15 · Momentum 10 · Spread 10 ·
  Volume 10 · Correlation 5 · News 5 · Execution 5** (Summe 100 %, per Test
  erzwungen). Jeder Score trägt sein **Breakdown**: Faktor → Rohwert → normiert →
  Gewicht → Beitrag.
- **Volatilitätsregime** (`regime.ts`) auf annualisierter realisierter
  Volatilität: `LOW < 0.25 ≤ NORMAL < 0.60 ≤ HIGH < 1.20 ≤ EXTREME`
  (Schwellen konfigurierbar, fehlende Werte ⇒ `NORMAL`).
- **Trichter** (`filters.ts`, `funnel.ts`): 10.000 → **2.000** (10 Eignungs- und
  Risikoregeln, erste greifende Regel gewinnt und wird protokolliert) → **500**
  (Score ≥ 55) → **100** Daily Rotation → **20–40 Deep-Kandidaten** mit
  Diversifikationsregel (max. 8 je Anlageklasse, kontrollierte Lockerung).
- **Versionierte Konfiguration** `src/scanner/scanner.config.json` (`version: 1`)
  mit Validierung aller Bereiche und Summen; Override über `SCANNER_CONFIG_FILE`.
- **Faktor-Cache** (`cache.ts`) je `(instrumentId, factorId, Datenfingerprint)` —
  warmer Lauf ≈ 5× schneller.

### Neu: Weekly Universe Review & Artefakte

- **`classifyWeekly()`** stuft jedes Instrument deterministisch als
  `CORE` / `ROTATION` / `DISCOVERY` / `EXCLUDED` ein und liefert validiertes JSON
  `{ instrumentId, class, reasons[], score, asOf }` (`validateWeeklyEntry`,
  `WeeklyValidationError`). Erkannte Änderungen: Neulistings, Delistings,
  Liquiditätseinbrüche (> 50 %), Gebührensprünge (> 50 %), fehlende
  Broker-Verfügbarkeit, Regimewechsel, Korrelationscluster (|r| ≥ 0.9).
  Die **LLM-Synthese** des Reviews ist bewusst **nicht** Teil dieses Tasks.
- **Tagesartefakte** `artifacts/JJJJ-MM-TT/universe.json` (+ `weekly.json`)
  inklusive Score-Breakdowns, Gewichten, Trichtergrößen und Ablehnungsstatistik.
  Atomar geschrieben (tmp + rename), **byte-identisch reproduzierbar**;
  Verzeichnis über `SCANNER_ARTIFACTS_DIR`, nicht versioniert.

### Neu: read-only API `/api/universe/*`

- **`GET /api/universe/daily`** — Ebenen `deep|daily|interesting|eligible`,
  Pagination (`pageSize` max. **200**, Default 50), optionales `breakdown`.
- **`GET /api/universe/weekly`** — Filter `class` (CSV), gleiche Pagination,
  Antwort inklusive `summary` und `changes`.
- **`GET /api/universe/score/{instrumentId}`** — vollständiges Breakdown
  (9 Komponenten), alle 14 Faktorwerte, Trichter-Zugehörigkeit und ggf. die
  greifende Ablehnungsregel; `404` für unbekannte IDs.
- Alle Endpunkte sind lesend, ohne Token-Pflicht (wie die übrigen GET-Routen),
  mit harten Query-Limits und redigierten 500er-Meldungen.

### Neu: Kommandos

- **`npm run scan`** — Scan aus Registry + Historical Store, schreibt die
  Tagesartefakte (`-- --dry` rechnet nur). **`npm run test:coverage:scanner`.**

### Performance

- Benchmark (`tests/scanner.benchmark.test.ts`): **10.000 synthetische
  Instrumente in 0,68 s** (~14.700 Instrumente/s) gegen ein Budget von 15 Minuten;
  Artefakt + Weekly zusätzlich 35 ms. Der Test scheitert bei Budget-Überschreitung.

### Tests & Doku

- **123 neue Tests** (Gesamt 576, alle grün): Golden-Werte und Edge Cases je
  Faktor, Score-/Gewichts-/Regime-/Trichter-/Weekly-/API-Contract, Determinismus
  und Byte-Identität, Architekturtest „kein LLM/Netzwerk/DB/Zufall im Scanner",
  Benchmark. **Coverage der neuen Module 97,3 % (Zeilen).**
- Neu: [`docs/DAILY_WEEKLY_RESEARCH.md`](./DAILY_WEEKLY_RESEARCH.md) (Pipeline,
  Faktor-Katalog, Gewichte, Trichter, Regime, API-Referenz, Benchmark),
  `docs/help/scanner.help.json` (3-Ebenen-Hilfe), Kapitel „Security Audit —
  Task 04" in `SECURITY_AUDIT.md`, Abschnitt 10 in `MARKET_UNIVERSE.md`.

### Nicht enthalten (bewusst)

- Kein Live-Trading-Bezug, keine Orderentscheidung, keine Änderung an Guardrails,
  Broker oder Ledger. Der Scanner liest nur und schreibt ausschließlich Artefakte.

---

## [1.11.0] — 2026-08-27

**Paper-Market-Data & deterministische Execution-Simulation (Task 03): Die
Plattform läuft standardmäßig mit echten Kursen (Modus B) statt statischem
Preisbuch. Drei Paper-Modi, broker-unabhängige Feed-Abstraktion, Normalisierung
mit Anomalie-Erkennung, append-only Historical Store, deterministischer
Fill-Simulator (Gebühren/Spread/Slippage/Latenz/Partial Fills), auditiertes
Failover. Live bleibt gesperrt, kein Breaking Change.**

### Neu: `src/lib/marketdata/` (deterministische Schicht — kein LLM)

- **`MarketFeed`-Abstraktion** (`types.ts`): `getTicker`, `getCandles`,
  optional `getOrderBook`/`subscribe`. Implementierungen in `feeds/`:
  `BinanceFeed` (Bid/Ask via `bookTicker`, 24h-Volumen), `YahooFeed`
  (Aktien/ETF/FX, Spread aus Registry), `BrokerFeed` (delegiert an
  `BrokerAdapter`, vgl. Task 02), `SyntheticFeed` (seeded, deterministisch,
  NUR Modus A/expliziter Fallback), `ReplayFeed` (spielt Historical Store ab).
- **`MarketSnapshot { instrumentId, bid, ask, last, ts, source, venue, feed,
  spread, volume24h }`** über `normalization.ts`: NaN/≤0, Sprung über
  `PAPER_ANOMALY_MAX_JUMP_PCT`, staler Timestamp und kaputter Spread werden
  **verworfen und geloggt** (`ANOMALOUS_SNAPSHOT`) — nie gehandelt.
- **Historical Store** (`historicalStore.ts`): append-only **NDJSON**
  (`data/history/candles.ndjson`) mit Provenienz (venue, feed, ts, fetchedAt).
- **Failover-Kette** (`failover.ts`): Broker-Feed → unabhängiger Feed →
  Synthetic (nur bei `PAPER_ALLOW_SYNTHETIC_FALLBACK=true`). Jeder Wechsel +
  jede Anomalie → `audit_log` (`FEED_FAILOVER`/`ANOMALOUS_SNAPSHOT`) +
  In-Memory-Ring. **Kein stiller Kursquellwechsel.**
- **`MarketDataManager`** (`manager.ts`): Instrument-Auflösung, Kette je
  Paper-Mode, Cache, Status. **`production.ts`** verdrahtet Factory ↔ Manager
  ↔ Ledger (Import-Zyklen-frei).
- **Shared HTTP** (`http.ts`): Timeout, Retry/Backoff (hart begrenzt),
  **SSRF-Allowlist**, read-only, keine Credentials.

### Neu: Fill-Simulator (`simulator.ts`) — lokal & deterministisch

- Modelliert **Gebühren** (Registry-Felder `makerFee`/`takerFee`, vgl. Task 01),
  **Spread** (Snapshot-Bid/Ask), **Slippage** (linear wachsend mit Ordergröße
  relativ zum 24h-Volumen), **Latenz** (ms) und **Partial Fills**
  (konfigurierbar). Seed-basiert → bit-identisch reproduzierbar (100-Fall-Test).
- Alle Parameter + Defaults dokumentiert (Tabelle in `docs/PAPER_TRADING.md`).

### Paper-Modi (`paperMode`)

- **`synthetic`** (A): Synthetic-Feed, deterministisch, perfekt für Tests.
- **`broker-market-data`** (B, **Default**): echte Kurse über Broker-Feed →
  Binance/Yahoo, Ausführung lokal simuliert.
- **`broker-paper-api`** (C): Broker-Paper-/Testnet-API — nur mit
  Venue-Capability + `PAPER_MODE_C_ENABLED=true`; heute nicht wählbar
  (klarer `PaperConfigError` statt stiller Fallback).
- Statisches Preisbuch (`STATIC_PRICES`) ist **`@deprecated`** und nur noch
  expliziter Offline-Fallback hinter `PAPER_STATIC_FALLBACK=true` (Default aus).

### API (read-only, ohne Token)

- `GET /api/marketdata/snapshot?instrument=…` → normalisierter Snapshot.
- `GET /api/marketdata/status` → aktive Quelle, Cache-TTL, letzter Failover.

### Integration (kein Breaking Change)

- `PaperBroker` erhält optionale `PaperExecutionAdapter` (`setExecution`):
  Modus-B-Fills laufen über den deterministischen Simulator (echte Kurse +
  Gebühren). Rohe `new PaperBroker()`-Instanzen bleiben bytekompatibel.
- `engine.getBroker()` injiziert den Ausführungs-Adapter einmalig und wärmt
  den Snapshot-Cache vor jedem Submit; ohne Kurs → `NO_QUOTE` (nie raten).
- Live-Pfad bleibt hart gesperrt (`LiveTradingGateError`).

### Getestet

- **53 neue Tests** (`npm test` → **453 grün**, alle 400 Bestands-Tests
  unverändert): deterministischer Simulator (100 Fälle), Slippage-/Partial-
  Fill-Grenzfälle, Gebühren aus Registry-Feldern, Replay-/Golden-Test
  (Backtest 2× → byte-identisch), Integration Modus B gegen lokalen
  **Fixture-HTTP-Server** (echter Kursfluss, kein Netz), Failover + Audit,
  Stale-Kurs-Verwerfen, Negative-Tests (Modus C ohne Capability, Synthetic
  ohne Flag), Feed-Tests (Yahoo/Binance/Broker/Synthetic), API-Contract.
- **Coverage `src/lib/marketdata/**` + `src/app/api/marketdata/**`:** Zeilen
  **95,6 %** (≥ 90 %). `npm run typecheck`, `npm run lint` fehlerfrei.
- Kein echter Netzwerkverkehr in der CI-Suite (alles über lokale Fixture-
  Server mit `PAPER_FEED_ALLOWED_HOSTS=127.0.0.1`).

### Doku

- NEU `docs/PAPER_TRADING.md`: Modi A/B/C (Vergleichstabelle), Simulator-
  Parameter-Tabelle, Failover-Kette, Replay-Determinismus, MARKET-DATA-LAYER-
  Diagramm.
- UPDATE `docs/ARCHITECTURE.md` (§10.5 Paper-Modi & Market-Data-Layer,
  Execution-Mode-Tabelle verdrahtet), `docs/SECURITY_AUDIT.md` (Kapitel
  „Security Audit — Task 03“), `docs/README.md` (Doku-Index).
- NEU `docs/help/paper-trading.help.json`: 3-Ebenen-Hilfe (kurzinfo /
  technischeInfo / risiko) für paperMode, Slippage, Partial Fill, Latenz,
  Spread, Failover, Replay.
- NEU `docs/task-03-IMPLEMENTATION_PLAN.md` (Plan + RECON-Abweichungen).

### Migrationshinweise

- Kein Schema-Bruch, keine neuen Dependencies. `PAPER_MODE` (Default
  `broker-market-data`) und die `PAPER_*`-Knobs sind optional; der statische
  Fallback ist standardmäßig **aus** (`PAPER_STATIC_FALLBACK=false`).

---

## [1.10.0] — 2026-08-27

**Broker Capability-Modell (Task 02): Die Plattform ist jetzt
broker-unabhängig — 6 Adapter hinter einem Interface, Execution Modes als
erstklassiges Konzept, Live-Pfad hart und auditierbar gesperrt. Kein Live-
Trading, keine Credentials, kein Netzwerkverkehr (Remote-Health default
OFF).**

### Neu: `src/contracts/broker.ts` (geteilte Contracts)

- **`ExecutionMode = "backtest" | "paper" | "testnet" | "live"`** mit
  fester Semantik: Backtest = historischer Kurs + simulierte Order,
  Paper-Realtime = realer Kurs + simulierte Order, Testnet = realer
  (Testnet-)Kurs + Broker-Order, Live = realer Kurs + reale Order.
- **`BrokerCapabilities`** (discovery, marketData, trading, paper,
  testnet, live, instrumentTypes, `stopAtVenue` — letzteres der
  Ausbaupfad für den späteren Bitunix-Adapter) und **`BrokerAdapter`**
  (healthCheck, optionale capability-geprüfte Methoden).
- **Fehlerklassen:** `LiveTradingGateError`, `NotSupportedCapabilityError`,
  `UnknownVenueError` (alle mit maschinenlesbarem Code, informativ,
  leak-frei — getestet).
- `MarketInstrument` wird **nicht dupliziert**, sondern aus Task 01
  (`src/universe/types.ts`) wiederverwendet (Unabhängigkeitsklausel nicht
  greifend, weil Task 01 gemerged ist).

### Neu: `src/brokers/` (ausführbares Capability-Modell)

- **`capabilities.ts`** — `VENUE_CAPABILITIES` für die 6 Venues (Single
  Source of Truth) + Gating-Table `REQUIRED_CAPABILITY_BY_MODE`
  (backtest/paper → `paper`, testnet → `testnet`, live → hartes Gate).
  Die Flags beschreiben, was der Adapter-CODE ausführt — Venue-Angebote
  bleiben Doku in der Registry.
- **`paper.ts`** — `PaperBrokerAdapter`: delegiert Orders/Guardrails auf
  den bestehenden `PaperBroker`, Marktdaten auf `marketData.ts`, Discovery
  auf die lokale Universe-Registry. Einziger vollständig ausführbarer
  Broker.
- **`stubs.ts`** — ALPACA, IBKR, BINANCE, KRAKEN, DYDX als sichere Stubs:
  ehrliche Capability-Declarations (Exec-Flags false), alle Methoden
  werfen deterministisch und informativ `NotSupportedCapabilityError`
  (Discovery mit klar markiertem `TODO(task-02/07)` + Contract-Referenz),
  Trading im (unerrreichbaren) live-Kontext zusätzlich
  `LiveTradingGateError` (Defense in Depth). Kein Netzwerk, keine
  Credentials, keine Broker-SDKs.
- **`factory.ts`** — `getBroker(venue, mode)` als **einziges Erzeugungs-
  punkt**: Whitelist-Validierung → Live-Gate (IMMER `LiveTradingGateError`)
  → Capability-Gating (`NotSupportedCapabilityError`) → Cache. Niemals
  stiller Fallback. PAPER-Ledger als Prozess-Singleton (backtest/paper
  teilen denselben, von der Engine hydratierten Ledger).
- **`audit.ts`** — jeder Factory-Aufruf mit `mode != "paper"` (plus alle
  Unknown-Venue-Ablehnungen) landet im Audit: In-Memory-Ring (200, immer)
  + best-effort `audit_log` (Event `BROKER_FACTORY`; DB-Ausfall bricht den
  Pfad nie ab).
- **`health.ts`** — `BROKER_HEALTHCHECK_REMOTE` (Default **false** = OFF):
  read-only, credential-freie Public-Checks (Binance `ping`, Kraken `Time`,
  4 s Timeout). ALPACA/IBKR/DYDX führen bewusst keinen Remote-Check aus
  (`degraded` + Grund: CREDENTIALS_REQUIRED / GATEWAY_REQUIRED /
  REMOTE_CHECK_NOT_IMPLEMENTED) — ohne Credentials wird nie gecallt.

### Geändert: Engine, Registry, Audit-View, API

- **`engine.ts`:** Hardcode-Erzeugung entfernt — `getBroker()` nutzt die
  Factory (kein `new PaperBroker` mehr in der Engine); Hydration aus
  PostgreSQL bleibt in der Engine. Rückgabetyp `PaperBroker` und Verhalten
  **bytekompatibel** (alle 334 bestehenden Tests unverändert grün).
- **`BROKER_REGISTRY` (lib/broker.ts):** neue Projektions-Flags
  `paperAvailable`/`liveAvailable` = `projectCapabilityFlags(caps)` —
  Single Source of Truth = Adapter, Registry = Projektion (Test belegt es).
  `paperApi` bleibt als Venue-Angebot (Doku).
- **`auditView.ts`:** Katalogeintrag für das neue Audit-Event
  `BROKER_FACTORY` (deutsche Beschreibung, Sektionen, Widerspruchs-Check).

- **Neue API (read-only, ohne Token wie die übrigen GETs):**
  - `GET /api/brokers` → 6 Venues: id, label, assets, capabilities,
    paperAvailable/liveAvailable (Projektion), executionModes, Health
    (lokal); `remoteHealthCheck.enabled` (Default false).
  - `GET /api/brokers/{venue}/health` → Health (lokal bzw. remote je Flag),
    capabilities, executionModes; 404 `UNKNOWN_VENUE`, Fehler redigiert.
- **`.env.example`:** neue Sektion "Broker" mit
  `BROKER_HEALTHCHECK_REMOTE=false` (Doku, Default OFF).

### Getestet (Peer-Review)

- **66 neue Tests** (`npm test` → **400 grün**, alle 334 Bestands-Tests
  unverändert bytekompatibel):
  - `tests/brokerFactory.test.ts` — **DIE 24er-Matrix** (6 Venues × 4
    Modes) mit expliziter Erwartungstabelle: PAPER ✓/✓/NSE(testnet)/LGTE,
    Stubs NSE/NSE/NSE/LGTE; Capability-Gating; Fehlerklassen; kein
    stiller Fallback; Registry-Projektion (Test belegt die Spiegelung);
    Audit-Vollständigkeit (18 Einträge, paper NICHT auditiert);
    PAPER-Singleton; Ring-Overflow; Defense in Depth.
  - `tests/brokerContracts.test.ts` — gemeinsame Interface-Suite für alle
    6 Adapter (inkl. „Trading wirft sicher und informativ“), offline-
    deterministisch (fetch gestubbt), Leak-Schutz der Meldungen.
  - `tests/brokerApi.test.ts` — beide Endpunkte (Shape, 404,
    Normalisierung), Remote-Checks offline mit simuliertem fetch.
  - `tests/brokerHealth.test.ts` — Flag-Semantik (Default OFF, nur
    exakt "true"), null-Pfade des Remote-Check-Kerns, Leak-Schutz.
- **Coverage neu** (`npm run test:coverage:brokers`): Zeilen 98,3 %,
  Funktionen 95,6 % (>= 90 % Zielerreichung); Branches 89,6 % — die
  systematisch offene Branch ist der Erfolgspfad der DB-Senke (kein
  PostgreSQL in der Testumgebung; by design best-effort/Fail-Safe).
- `npm run typecheck`, `npm run lint` fehlerfrei; `npm run build`
  inklusive neuer Routen erfolgreich.

### Doku

- NEU `docs/BROKER_ARCHITECTURE.md`: Adapter-Vertrag, Capability-Matrix
  (Ist/Soll), Execution-Mode-Tabelle, Factory-Fluss, Fehlerklassen,
  Audit, API, Health/Remote-Flag, Ausbaupfad (inkl. Bitunix-`stopAtVenue`).
- UPDATE `docs/ARCHITECTURE.md` (neues Kapitel 10 + Diagramm,
  Kommunikationsweg Mikro-Broker, Glossar), `docs/SECURITY_AUDIT.md`
  (Kapitel "Security Audit — Task 02"), `docs/README.md` (Doku-Index).
- NEU `docs/help/brokers.help.json`: 3-Ebenen-Hilfe (kurzinfo /
  technischeInfo / risiko) für Execution Modes, Capability-Flags,
  Health-Status, `LiveTradingGateError` und Projektions-Flags.

### Migrationshinweise

- Kein Schema-Bruch, keine neuen Dependencies. Optional:
  `BROKER_HEALTHCHECK_REMOTE` in `.env` (Default OFF).

---

## [1.9.0] — 2026-08-27

**Lesbarer Audit-Trail und lesbares Protokoll: Aufklappbare Einträge mit
deutschen Erklärungen, Rohdaten-Reiter, logischer Bewertung und Paging
(20/50/100/200) — identisch in „Firm Overview" und „Protokoll".**

### Problem (gemeldet)

- Der Audit-Trail zeigte `JSON.stringify(detail).slice(0, 70)`: abgeschnittene,
  aneinanderhängende Roh-JSON ohne Beschriftung (`ceoRaw`, `fill`, `via`).
- Nicht erkennbar, ob eine `ORDER_REJECTED`-Meldung ein **Fehler** oder
  **korrektes Systemverhalten** ist.
- Kein Paging — die Liste war nicht navigierbar.

### Neu: `src/lib/auditView.ts` (reiner Aufbereiter, kein DB-/React-Import)

- **Event-Katalog** mit deutschen Titeln und fachlicher Erklärung für alle 28
  Events, die der Code schreibt (`AGENT_DECISION` → „Agent-Entscheidung",
  `ORDER_REJECTED` → „Order abgelehnt", `TAKE_PROFIT_HIT` → „Take-Profit
  erreicht", `RULE_MACRO_REJECTED` → „Makro-Regel abgelehnt", `RISK_ADAPTIVE`
  → „Risiko angepasst", …).
- **Feld-Wörterbuch**: `ceoRaw` → „CEO-Entscheidung (Rohantwort)", `via` →
  „Quelle der Änderung", `latencyMs` → „Antwortzeit", inkl. Einheiten
  („14,34402 Stück", „104,36426 USD", „1,3 s", „2 %").
- **Logische Prüfung** pro Eintrag und über die Sequenz: Widersprüche
  (`ORDER_SENT` mit `status: REJECTED`, Take-Profit unter Einstieg bei LONG,
  adaptiver Faktor > 1, `ROLE_NOT_ALLOWED_TO_TRADE` für EXECUTOR/RESEARCH)
  werden als ⛔ gekennzeichnet; korrektes Verhalten („Rollen-Mandat",
  „Pyramiding-Sperre", „Fail-safe REJECT") wird als ℹ️ eingeordnet.
- **Abgeschnittene Modellantworten** werden erkannt und benannt: Die Engine
  speichert `ceoRaw` mit 500 und `rawResponse` mit 2.000 Zeichen
  (`src/lib/macroCycle.ts`, `src/lib/engine.ts`). Verdikt und Begründung werden
  trotzdem aus der gekürzten Antwort extrahiert.
- **Zeitstempel eindeutig in UTC**: „27.08.2026, 14:56:14 UTC" + „vor 4 Minuten".

### Neu: `src/lib/paging.ts` + `src/components/common/`

- Paging-Kern (Default **20**, wählbar **20/50/100/200**) — server- und
  clientseitig dieselbe Logik, Seitengrößen geklemmt.
- `AuditTrailList` / `ProtocolList`: aufklappbare Karten mit Kurzfassung,
  „Lesbare Details" (gruppierte, beschriftete Sektionen für `fill`, `order`,
  `decision`) und **„Rohdaten (DB-Eintrag)"**-Reiter mit vollständiger Zeile.
- `AuditTrailPanel` / `ProtocolPanel`: Level-/Event-Filter, Suche, Auto-Refresh
  — in „Firm Overview" und „Protokoll" dieselbe Komponente.
- Farben: INFO grün, WARN gelb, CRITICAL rot; Widersprüche zusätzlich markiert.

### API

- `GET /api/firm/log` unterstützt `page` (1-basiert, alternativ `offset`),
  liefert `meta` (`page`, `pageSize`, `pages`, `auditTotal`, `entryTotal`) und
  pro Protokolleintrag die originale DB-Zeile unter `raw`. `limit` bleibt
  auf 1–200 geklemmt (Fix aus v1.1.0 unverändert).
- Abwärtskompatibel: `entries`, `turns`, `audit`, `agents` bleiben erhalten.

### Tests

- `tests/auditView.test.ts` (23): Katalog, Feldlabels, Widerspruchserkennung,
  gekürzte CEO-Antwort, Muster über mehrere Einträge, Zeitstempel.
- `tests/paging.test.ts` (5): Seitengrößen, Schnitt, Fenster, Klemmung.
- `tests/auditUi.render.test.ts` (3): rendert die echten Komponenten und prüft,
  dass nichts abgeschnitten ankommt und das Paging 20/50/100/200 anbietet.
- Regressionsschutz: Findet der Code ein Audit-Event ohne Katalogeintrag,
  schlägt der Test fehl.

---

## [1.8.0] — 2026-08-27

**Market Universe (Task 01): Die Plattform kennt jetzt Märkte statt Strings.
Eine broker-unabhängige Instrumenten-Registry löst die hart kodierte
`DEFAULT_WATCHLIST` als Marktdefinition ab.**

### Neu: `src/universe/` (deterministischer Kern — kein LLM, kein Netzwerk)

- **Datenmodell `MarketInstrument`** mit 20 fachlichen Pflichtfeldern plus
  kanonischer ID (`VENUE:SYMBOL`): Identität, Handelsbedingungen
  (`minQuantity`, `priceStep`, `quantityStep`, `makerFee`, `takerFee`),
  Capability-Flags (`leverageAvailable`, `shortAvailable`, `paperAvailable`,
  `liveAvailable`) und laufende Metriken (`volume24h`, `spread`, `volatility` —
  initial `null`, gefüllt durch spätere Tasks).
- **Symbol ≠ Markt:** strikte Trennung von `Instrument` (venue-gebunden),
  `Asset` (venue-unabhängig) und `Underlying` (ökonomische Exposure).
  `BINANCE:BTCUSDT`, `KRAKEN:BTC/USD` und `BITUNIX:BTCUSDT` sind drei
  Instrumente mit einem Underlying — per Golden-Test verifiziert.
- **Registry-Layer** (`registry.ts`): `upsert`, `upsertMany` (max. 5000/Batch),
  `query` mit 15 Filtern, Pagination (max. **500**/Seite, Default 100),
  `remove`, `groupByVenue`, `underlyings`. Deterministisch: stabile Sortierung
  nach `id`, Merge-Upsert ohne Default-Rücksetzer, `null`-Metriken überschreiben
  keine Bestandswerte.
- **Persistenz** als versionierbare NDJSON-Datei
  (`data/universe/instruments.ndjson`, atomar via `tmp`+`rename`) — reviewbar im
  Git-Diff und ohne laufende Datenbank nutzbar. Verzeichnis via
  `UNIVERSE_DATA_DIR` konfigurierbar.
- **Normalisierung & Policy** (`normalization.ts`, `policy.ts`,
  `policy.default.json`): venue-native Symbole → kanonische ID, base/quote-,
  Anlageklassen- und Markttyp-Ableitung; konfigurierbare Ausschlussregeln
  (Leveraged Tokens, Test-Symbole, gesperrte Venues/Quotes) mit Validierung der
  Policy-Datei; Override via `UNIVERSE_POLICY_FILE`.
- **Audit** (`audit.ts`): jede Mutation erzeugt genau einen Eintrag
  (`actor: system`, `source`, `action`, `changed`, `created`, `updated`,
  `rejected`, `ids`, `timestamp`) in `data/universe/audit-log.ndjson`;
  mit `UNIVERSE_AUDIT_DB=1` zusätzlich als `UNIVERSE_MUTATION` in `audit_log`.

### Neu: API

- `GET /api/markets` → `{ ok, venue, count, lastSync, instruments[], groups[],
  page, pageSize, total, hasMore }`, nach Venue gruppiert und über 15 Parameter
  filterbar; strikte Eingabevalidierung, Fehler-Contract
  `{ ok:false, error, message, details? }` (400/500).
- `GET /api/markets/{venue}/{symbol}` → Instrument inkl. `assetId`/`underlyingId`
  und `related` (gleiches Underlying an anderen Venues); 400/404/500 nach
  demselben Contract. Symbole mit `/` als `%2F` oder `~` adressierbar.

### Migration (kein Breaking Change)

- Die 9 Watchlist-Symbole wurden zu **26 Seed-Instrumenten** migriert:
  BTC/ETH/SOL → BINANCE + KRAKEN, SPY/QQQ/NVDA/AAPL/MSFT → ALPACA + IBKR,
  EURUSD=X → `IBKR:EUR.USD` (FX) sowie je ein `PAPER:*`-Spiegel, damit der
  bestehende Paper-Broker-Pfad unverändert läuft.
  Regenerierbar mit `npm run universe:seed` (byte-identisches Ergebnis).
- `DEFAULT_WATCHLIST` bleibt exportiert, ist aber **`@deprecated`** und leitet
  sich aus `UI_WATCHLIST_PREFERENCE` (`src/universe/watchlist.ts`) ab — einer
  Liste von Instrument-ID-Referenzen. Die Watchlist ist damit reine UI-Präferenz.

### Tests & Doku

- 66 neue Tests (Registry-CRUD, Upsert-Konflikte, alle Filter, Pagination-Limits,
  stabile Sortierung, Policy, Golden-Normalisierung, API-Contract,
  Persistenz-Reload, Seed-Fixture); Gesamtsuite **301 grün**.
  Coverage `src/universe/**`: **97,4 % Zeilen / 90,6 % Branches / 91,3 % Funktionen**
  (`npm run test:coverage`).
- Neu: `docs/MARKET_UNIVERSE.md`, `docs/help/market-universe.help.json`
  (3-Ebenen-Hilfetexte für alle Felder, Tooltip-Quelle für das Operations Center);
  aktualisiert: `docs/ARCHITECTURE.md` (§9 Universum-Pipeline),
  `docs/SECURITY_AUDIT.md` (Kapitel „Security Audit — Task 01“).

### Migrationshinweise

- Keine DB-Migration nötig; kein neues Paket (0 neue Dependencies).
- `data/universe/instruments.ndjson` ist versioniert und wird beim ersten Start
  automatisch geseedet, falls sie fehlt. `data/universe/audit-log.ndjson` ist
  bewusst **nicht** versioniert (`.gitignore`).

---

## [1.7.0] — 2026-08-26

**Adaptives Risk-Limit-System: `maxRiskPerTrade` senkt sich automatisch in
hochvolatilen Marktphasen — ohne Rebuild, ohne Neustart, zur Laufzeit
konfigurierbar und für Agenten/Monitoring beobachtbar.**

### Neu: `src/lib/adaptiveRisk.ts` (Kernmodul)

- **Vier Volatilitätsindikatoren** mit klaren, zur Laufzeit änderbaren
  Schwellwerten (Keys `adp.*` in `risk_config`):
  1. **VIX** (primärer Trigger, Yahoo `^VIX`, 5-Min-Cache): ≥ 30 → ELEVATED,
     ≥ 40 → EXTREME;
  2. **ATR (14)** auf 15-min-Kerzen, Korb-Spitzenwert über
     SPY/QQQ/BTC — Standard > 1 % des Kurses;
  3. **Bollinger Band Width (20, 2σ)** — Standard > 5 % Bandbreite;
  4. **Return-Standardabweichung (20 × 15-min)** — Standard > 1 % pro Kerze.
  Die beiden neuen Indikator-Funktionen (`bollingerBandWidthPct`,
  `returnStdDevPct`) sind reine, unit-getestete Funktionen in `indicators.ts`.
- **Dreistufige Regime-Logik** (deterministisch, `assessRegime()`):
  EXTREME, wenn VIX ≥ 40 **oder** (VIX ≥ 30 **und** ≥ 1 Korb-Indikator)
  **oder** alle drei Korb-Indikatoren; ELEVATED, wenn VIX ≥ 30 **oder**
  ≥ 1 Korb-Indikator; sonst NORMAL.
- **Dynamische Anpassung ohne Rebuild:** das wirksame
  `maxRiskPerTrade` = konfiguriertes Basis-Limit × Regime-Faktor
  (Standard: ELEVATED 0.5 → 2 % auf 1 %, EXTREME 0.25 → 0.5 %). Der Faktor
  liegt immer in (0, 1] — das System kann per Marktzustand **nur senken**,
  nie erhöhen. Der Boden bleibt das absolute Code-Minimum (0.002).
- **Anti-Flapping (schnelle Volatilitätswechsel):** Eskalation sofort
  (sichere Richtung), De-Eskalation erst nach `adp.deescalateAfter`
  konsekutiven ruhigen Bewertungen (Standard 3 ≈ 3 min). Implementiert als
  reine, getestete `RegimeStateMachine`.
- **Fehlende Daten (Fail-Open):** ein Indikator ohne Daten triggert nie
  (VIX-Timeout, leere Kerzen, NaN) — Reduktionen können ausbleiben, Risiko
  kann nie steigen. Der letzte wirksame Zustand bleibt bei Fehler bestehen.
- **Laufzeit-Konfiguration ohne Neustart:** alle Schwellwerte und Faktoren
  sind im Risk-Tab des Dashboards bzw. via `PUT /api/firm/config`
  (Keys `adp.*`) änderbar; Klemmung gegen `VOLATILITY_CONFIG_BOUNDS`.
- **Multi-Prozess:** der aktive Faktor wird persistiert
  (`adp.activeFactor` / `adp.activeAt`, Frische 15 min), damit der separate
  Mikro-Executor-Prozess (`npm run micro`) die Reduktion ohne eigenen
  Marktzugriff übernimmt.

### Neu: Observability für Agenten & Monitoring

- **`GET /api/firm/risk/volatility`** — Regime, Basis-/effektives
  `maxRiskPerTrade`, Faktor, alle Indikatorwerte mit Schwellen und
  Trigger-Status, Ring-Buffer der letzten 50 Trigger-Events (wann/warum),
  aktive Konfiguration + erlaubtes Fenster, `lastUpdate`/`lastChange`/`stale`.
- **`POST /api/firm/risk/volatility`** — sofortige Neubewertung erzwingen
  (Token + Rate-Limit wie die anderen Schreib-Endpunkte).
- **Audit-Log:** Event `RISK_ADAPTIVE` (WARN bei EXTREME) bei jeder
  Regime-/Limit-Änderung — dauerhafte Historie neben dem In-Memory-Buffer.
- **`GET /api/firm`** liefert zusätzlich `adaptiveRisk` (Status) und
  `volatilityConfig` (Parameter + Fenster); `GET /api/firm/config` ist
  nun namespace-getrennt (`config.limits` / `config.volatility`).
- **Agenten-Turn-Trace:** neue Schicht „ADAPTIVES-RISIKO“ zeigt pro Turn
  Regime, wirksames Limit und Begründung im Protokoll.
- **Monitor-Tick** bewertet bei jedem Durchlauf (60 s) die Volatilität;
  `TickResult` enthält jetzt den `adaptiveRisk`-Zustand.
- **Dashboard:** Risk-Tab zeigt Regime-Badge (grün/gelb/rot), Basis-→
  wirksames Limit, Indikator-Tabelle und letztes Trigger-Event; neue
  Sektion „Volatilitäts-Schwellwerte & Faktoren“ (laufzeitänderbar).

### Behoben

- **Prozent-Eingaben im Config-API wurden verfälscht:** `PUT /api/firm/config`
  nahm für Unit `%` die Prozentzahl (Eingabe 30) als Bruchteil (30.0) an und
  klemmte sie auf das Code-Ceiling — z. B. `maxPositionPct` 30 % → 0.5 statt
  0.3. Jetzt wird Unit `%` korrekt mit ÷ 100 normalisiert (regressionstestbar).

### Architektur (Sandbox-Prinzip, dreistufige Kaskade)

```
Code-Ceilings (LIMIT_CEILINGS, hartkodiert)
  └─ Basis-Limit (risk_config, Dashboard/API — Operator)
       └─ adaptiver Marktfaktor (adaptiveRisk.ts — VIX/ATR/BBW/StdDev)
            → wirksames maxRiskPerTrade (getLimits(), alle Order-Pfade)
```

`0.02` ist damit nur noch STARTWERT des konfigurierten Basis-Limits; die
harten Grenzen (Ceilings/Floors) bleiben bewusst im Code.

### Getestet

- **43 neue Tests** (`npm test` → 235 grün): Unit-Tests je Indikator
  (exakte Werte, Monotonie, unzureichende Daten, NaN/negative Werte),
  komplette Regime-Entscheidungs-Matrix, Hysterese-Sequenzen (inkl.
  schneller Wechsel/Flapping-Schutz), Misskonfigurations-Schutz
  (vixExtreme < vixHigh), Faktor-Klemmung (nie > 1, Code-Boden),
  DB-Neulade-Kumulations-Regression, Integrationstests mit simulierten
  Marktlagen (VIX 35 → 0.01, VIX 45 → 0.005, Korb-Sturm, VIX-Timeout
  Fail-Open, leere Kerzen, Laufzeit-Schwellwertwechsel ohne Neustart,
  Min-Interval/Single-Flight, Observability-Status + Event-Historie).
- `npm run typecheck`, `npm run lint` und `npm run build` fehlerfrei.

### Migrationshinweis

Kein Schema-Bruch — `risk_config` wird nur um `adp.*`-Zeilen ergänzt
(Seed-`POST /api/seed` rüstet nach; `drizzle-kit push` bleibt no-op).
Neu in der DB: `adp.activeFactor` / `adp.activeAt` (werden automatisch
vom System geschrieben — nicht manuell bearbeiten).

---

## [1.6.1] — 2026-08-26

**Bugfix-Release: `drizzle-kit push` bricht ab (42601), Risiko-Config-Save
crasht (22P02), Versionsnummer + Pipeline-Statusleiste.**

### Behoben

- **`drizzle-kit push` — syntax error 42601 beim Index `trade_rules_active_symbol_unique`.**
  Die Indexdefinition lag als eine SQL-Zeile mit Tuple
  `("symbol", COALESCE("mission_id", ''))` an. Drizzle-Kit rendert daraus
  `USING btree (("symbol", …))` — ein Row-Constructor im btree-Index, den
  PostgreSQL verweigert; der Push brach genau dort ab (Position 95).
  Zusätzlich war `''` als COALESCE-Platzhalter für die UUID-Spalte
  `mission_id` ungültig (22P02). Jetzt: zwei Indexspalten
  (`symbol`, `COALESCE(mission_id, NULL-UUID)`), partiell auf
  `status = 'ACTIVE'`. Semantik unverändert (pro Symbol/Mandat höchstens
  eine aktive Regel — jetzt auch erstmals *erzwingbar*). Beide Spalten sind
  SQL-Chunks, damit der Push-Diff den Index nicht bei jedem Lauf als
  geändert erkennt (Drizzle-Kit markiert Mixed-Index-Spalten beim
  Introspektieren auf Index-Ebene als Expression → DROP/CREATE-Drift).
- **`risk_config` — Crash bei `allowShort` (22P02: invalid input syntax
  for type numeric: "true").** Die Spalte `value` ist `numeric`,
  `setConfigValue()` persistierte aber `String(true)`/`String(false)`.
  Boolesche Limits werden jetzt als 0/1 gespeichert (konsistent mit dem
  Seed); die Lese-Seite akzeptiert zusätzlich Legacy-"true"/"false".

### Neu

- **Versionsnummer in der Fußzeile** des Dashboards (aus `package.json`,
  einziger Wahrheitsort `src/lib/version.ts` — derselbe Wert wie
  `/api/health` → `"version"`).
- **Pipeline-Statusleiste:** „Pipeline gestartet — läuft“ erscheint als
  pulsierender Emerald-Block mit Glow + Spinner (auch bei Neustart),
  danach grün „Pipeline fertig“ (löst sich nach 20 s), bei Fehler rot und
  bleibend. Der „▶▶ Ganze Pipeline“-Button leuchtet während des Laufs.
  `prefers-reduced-motion` wird respektiert.

### Migrationshinweis

`npx drizzle-kit push` legt den korrigierten Index
`trade_rules_active_symbol_unique` an (frühere Push-Läufe haben ihn nie
erzeugt — der Abbruch geschah genau an dieser Stelle). Keine Datenänderung.

---

## [1.6.0] — 2026-08-26

**Event-Driven Multi-Zyklen-Architektur: Makro (LLM, 1×/h) und Mikro
(kein LLM, pro Preis-Tick) vollständig entkoppelt — die alte lineare
Pipeline bleibt als Referenz/Workshop-Pfad erhalten.**

### Neu: Regelwerk & Regel-Engine (LLM-frei)

- **`src/lib/ruleEngine.ts`** — deterministische Regel-DSL: Whitelist-Felder
  (`rsi14`, `volumeRatio`, `ema9/21/50`, `trend`, `atrPct`, …), Operatoren
  (`lt/lte/gt/gte/eq/between/in`), `sanitizeRuleSpec()` (Normalisierung +
  Klemmung gegen Code-Ceilings — auch `__proto__`-Schutz), Kompilierung zu
  schnellen Closures, Snapshot-Berechnung, deterministischer Backtest.
- **`src/lib/ruleService.ts`** — Persistenz & Versionierung: `trade_rules`
  (immutable Versionen, DRAFT → ACTIVE → SUPERSEDED/PAUSED/ARCHIVED/REJECTED),
  idempotentes Upsert über Signatur, atomares Aktivieren mit partiellen
  UNIQUE-Indizes, **Rollback** über `previous_version_id`, Feedback-Aggregation
  (`rule_executions` + `positions.rule_id` → P&L/Win-Rate je Regel).
- **`src/lib/microExecutor.ts`** — Mikro-Zyklus als reiner TS-Pfad **ohne
  jeden LLM-Import** (per Test abgesichert): Binance-WebSocket-Feed
  (`@trade` + `@kline_1m`, Reconnect mit Backoff), `RollingTimeframeSeries`
  (1m→5m/15m/30m/1h, REST-Seed, RAM only), `RuleCache` (kompilierte
  ACTIVE-Regeln, Cooldown/Tageslimit in-Memory, Poll + Invalidation),
  `MicroExecutor` (Hot-Path-Metrik `latencyMicros`), Paper-Adapter mit
  **Postgres-Advisory-Lock pro Symbol** und DB-Wahrheitsprüfung
  (Kill-Switch, Positionssperre, Mission-Status) sowie determinstische
  `SimulatedFeed`/`SequenceFeed`.
- **`src/lib/macroCycle.ts`** — Makro-Zyklus: Research erzeugt den
  Regel-Entwurf (LLM, JSON-Schema erzwungen), CEO prüft/revidiert
  (APPROVE/REVISE/REJECT), hartes Risk-Gate, Upsert + Aktivierung;
  ohne LLM deterministischer Fallback (`sourceMode: FALLBACK`). Läuft im
  Scheduler-Takt `MACRO_CYCLE_INTERVAL_MIN` (Default 60 min).
- **`scripts/micro-executor.ts`** + **`deploy/micro-executor.service`** —
  eigenständiger Executor-Prozess (`npm run micro`) mit Health-HTTP
  (`MICRO_HEALTH_PORT`, Default 3380).
- **Neue API:** `GET/POST /api/firm/rules`, `POST /api/firm/rules/[id]`
  (activate/pause/archive/rollback/reject), `POST /api/firm/rules/[id]/backtest`,
  `POST/GET /api/firm/macro`, `GET /api/firm/micro`.
- **Neue DB-Tabellen:** `trade_rules`, `rule_executions`, `rule_backtests`;
  `positions.rule_id` für die P&L-Zuordnung; `checkSchema()` erweitert.
- **Doku:** neue Blaupause [ARCHITECTURE.md](ARCHITECTURE.md); HANDBUCH
  Kap. 15 (Makro/Mikro), 16 (Agenten-Register: **alle zwölf Rollen**),
  17 (Regel-API), 18 (Review-/Security-Checkliste); README aktualisiert.

### Behoben

- **Protokoll-Typen sauber getrennt:** `agent_messages` enthält nicht nur
  Agentenentscheidungen, sondern auch `ANALYSIS`/`RECOMMENDATION` und
  `MARKET_SCAN`. `GET /api/firm/log` liefert deshalb jetzt eine diskriminierte
  `entries`-Timeline. Das Dashboard stellt Analystenberichte (z. B. Cassini,
  Hubble) als Analyse mit Einschätzung/These dar und Systemmeldungen als solche
  — nie mehr als leere „Entscheidung (geparst)“ mit `?` oder `NaN s`.
- **Altbestand kompatibel:** fehlende historische Latenz/Quelle wird explizit
  als `null` normalisiert und im UI ausgelassen; verwaiste Agenten und
  Markt-Scans erhalten lesbare System-/Archiv-Attribution statt Platzhaltern.
  Neue Kern- und Analysten-Einträge speichern zusätzlich einen Actor-Snapshot
  sowie LLM-Trace (Quelle, Modell, Latenz, Prompt, Rohergebnis).
- **API-Kompatibilität:** Das bestehende Feld `turns` bleibt erhalten, enthält
  jetzt bewusst nur echte Agentenentscheidungen (z. B. für den Workshop).
  Die vollständige gemischte Chronologie steht additiv in `entries`.

### Getestet (Peer-Review)

- **181 Unit-Tests grün** (`npm test`; +32 neue: `tests/ruleEngine.test.ts` und
  `tests/microExecutor.test.ts`). Neue Abdeckung: Whitelist/Klemmung/
  Prototype-Pollution, Kompilierung, Snapshot-Determinismus, Backtest-
  Szenarien (Dip-Gewinn, Stop-Vorrang, keine Fehlsignale), **Import-Graph-
  Guard** (kein `ollama`/`llmProvider`/`engine` im Mikro-Pfad), Cooldown/
  Tageslimit/Fenster, Tick→Match→Adapter-E2E ohne DB, Latenz-Grenzen.
- `npm run typecheck` + `npm run lint` sauber; `npm run build` inkl. neuer
  Routen erfolgreich; `npm audit`: 0 Schwachstellen.
- Standalone-Smoke: `npm run micro` startet mit Sim- und Binance-Feed,
  Health-Endpunkt antwortet; ohne DB bleibt der Prozess am Leben
  (RAM-Cache, Fail-safe).

---

## [1.5.4] — 2026-08-26

**Setup-Schritt 2 repariert: `initdb`-Erfolg wurde fälschlich als „Cluster
unvollständig“ gemeldet (Rechte-Fehlalarm); umfassende Fehlerdiagnose und
Sofort-Hilfe-Anleitung ergänzt.**

### Ursache (Vorfall Nr. 2)

`initdb` läuft durch („Erfolg“), das Skript meldet trotzdem
`✗ Cluster nach initdb weiterhin unvollständig`. Grund: `initdb` setzt
`/var/lib/postgres` und `/var/lib/postgres/data` auf **0700 postgres:postgres**.
Die Cluster-Checks (`test -f PG_VERSION`, `global/pg_control`,
`global/pg_filenode.map`) liefen aber als **aufrufender Benutzer** →
`Permission denied` → falsch negativ. Dieselbe Ursache hatte die irreführende
Meldung „Datenverzeichnis existiert nicht oder ist leer“. Folge: Das Skript
hielt einen **vollständigen** Cluster für defekt und bot eine (datenzerstörende)
Neuinitialisierung an.

### Behoben

- **`scripts/lib/pg-cluster.sh` (neu):** Alle Prüfungen am Datenverzeichnis
  laufen als Cluster-Benutzer (`sudo -u postgres`, per `PG_SUDO_USER`
  übersteuerbar; Root/User selbst ohne sudo). Enthält:
  - Grundgerüst-Check (`PG_VERSION`, `global/pg_control`, `base/`) + optionaler
    Relmap-Marker **versionstolerant** (PG ≤ 18 verlangt `global/pg_filenode.map`,
    PG ≥ 19/unbekannt nur noch Warnpfad — künftige Major-Versionen brechen
    nicht mehr fälschlich ab);
  - **Versionsabgleich** Cluster ↔ Server (`PG_VERSION` + `pg_controldata`):
    Major-Mismatch ⇒ **Abbruch mit pg_upgrade/pg_dumpall-Anleitung statt
    automatischem, datenzerstörendem initdb**;
  - `pg_controldata`-Validierung (Version + Cluster-State) statt Datei-Raten;
  - ausführliche Diagnose (Owner/Rechte, Inhalt, PG_VERSION ↔ Server,
    pg_control, freier Platz, laufende Prozesse) — alles als postgres-Benutzer.
- **`scripts/setup-cachyos.sh` (Schritt 2):**
  - Preflight: sudo vorhanden? `postgres`-User existiert? sudoers-Mitgliedschaft?
  - Cluster-Check über den neuen Helper; Fehldiagnose „existiert nicht“ nur
    noch, wenn das Verzeichnis wirklich fehlt (sonst „Rechte nicht lesbar“);
  - nach `initdb`: erneute Verifikation mit Diagnose + **manuellem Fahrplan**
    (exakte Kommandos, inkl. „Nicht als root, nicht als normaler User —
    sondern `sudo -u postgres pg_ctl …` bzw. `sudo systemctl start postgresql`“);
  - Postgres-Dienststart: Port-/Fremdinstanz-Erkennung (fremder Prozess auf
    5432 ⇒ Abbruch; eigener, manuell gestarteter `pg_ctl`-Prozess auf
    demselben Cluster ⇒ Wiederverwendung mit Warnung);
  - veraltete `postmaster.pid` wird erkannt und (wenn der Prozess tot ist)
    entfernt; wartet nach `systemctl stop` auf echten Stop;
  - Cluster-Benutzergruppe dynamisch (`id -gn`), Locale-Fallback `C.UTF-8 → C`.
- **Neue Anleitung `docs/SETUP_PG_TROUBLESHOOTING.md`** (auch im Dashboard:
  `/api/docs?name=pgsetup`): Schritt-für-Schritt-Soforthilfe für den aktuellen
  Zustand, alle Fehlerfälle (Rechte, Version-Mismatch, postmaster.pid,
  Port-Konflikt, sudo/Benutzer, Logs) und eine Entscheidungstabelle.
- INSTALL.md Kap. 9/11 und HANDBUCH 10.6 verweisen auf die neue Anleitung.

### Getestet (Peer-Review)

- 149 Unit-Tests grün (`npm test`; +9: 8 neue in `tests/setupCluster.test.ts`
  plus 1 neuer Rechte-Regressionstest in `tests/dbConfig.test.ts`).
  Die Regressionstests stellen den Vorfall **mit echten Rechten** nach:
  Cluster-Verzeichnis gehört `nobody` und hat Mode 0700 — `test -f` als
  Aufrufer scheitert (EACCES), der neue Helper erkennt den Cluster trotzdem.
  Zusätzlich: Ablehnung unvollständiger PG-18-Cluster, Toleranz für
  künftige Layouts (PG 19 ohne Relmap), Versions-Mismatch,
  pg_controldata-Parser, set -e-Sicherheit.
- `npm run typecheck` + `npm run lint` sauber, `npm audit`: 0 Schwachstellen.
- **End-to-End** (Mock-systemd + Mock-initdb + echtes `sudo -u nobody` +
  PGlite-wire-Postgres):
  - Leeres Verzeichnis → `initdb` → Cluster wird als vollständig erkannt
    (vorher: „weiterhin unvollständig“) → Benutzer/DB → `drizzle-kit push`
    (9 Tabellen) → `next build` ✓;
  - **Datenschutz-Test:** vollständiger 0700-Cluster mit Sentinel-Datei →
    kein Neuinitialisierungs-Dialog, Sentinel überlebt, Setup läuft durch.

---

## [1.5.3] — 2026-08-26

**Setup-Installation läuft wieder durch: `${PGROOT}`-False-Positive behoben;
außerdem Passwort-URL-Encoding, echter `ANALYST_INTERVAL_MIN`-Zyklus und
durchgesetzte Missions-Positionsgrenzen.**

### Behoben

- **Setup-Skript (Schritt 2) — der gemeldete Installationsabbruch:**
  `systemctl show -p ExecStart --value postgresql.service` liefert die
  Arch-Unit-Zeile **unexpandiert** (`-D ${PGROOT}/data`). Der Datadir-Sicherheitsgurt
  verglich diesen Literalstring mit `/var/lib/postgres/data` und brach fälschlich ab:
  `✗ postgresql.service nutzt ein anderes Datenverzeichnis: '${PGROOT}/data'`.
  **Fix:** neues Modul `scripts/lib/pg-service.sh` — liest die
  Unit-Environment (`systemctl show -p Environment`, inkl. `EnvironmentFile`/Drop-ins)
  und expandiert `${VAR}`/`$VAR` im `-D`-Pfad, **bevor** verglichen wird. Versteht
  zusätzlich die systemd-Ausgabeformate `{ path=… ; argv[]=… }`, gequotete
  argv-Tokens und fällt bei fehlendem Bus auf `systemctl cat` zurück
  (Haupt-Unit + Drop-ins, letzte Definition gewinnt). Regressionstests simulieren
  die exakte Nutzer-Unit mit gemockter `systemctl`-Binary
  (`tests/setupPgService.test.ts`).
- **Setup-Skript: Passwort-URL-Encoding** — Zeichen wie `@ : / % + #` im
  DB-Passwort brachen die `DATABASE_URL` (psql, node-postgres, drizzle-kit).
  **Fix:** `jq '@uri'` vor dem URL-Bau; zusätzlich wird auch im
  „Benutzer existiert bereits“-Zweig ein leeres Passwort abgewiesen.
- **Scheduler:** `ANALYST_INTERVAL_MIN` wurde nur geloggt — der Analystenzyklus
  lief tatsächlich **jede Minute** (der v1.4.0-Kommentar versprach „echter Abstand“,
  der Code hielt es nicht). **Fix:** Slot-Key aus Berliner Tag + Intervallfenster
  (`Math.floor(Date.now() / analystIntervalMs)`), Overlap-Schutz gegen lange Läufe.
- **Missions-Cap wird durchgesetzt (Risiko-Entschärfung):** `missions.maxPositionPct`
  stand nur im Prompt — die PENNY-Mission („max 5 %“) konnte real **25 %** des
  Kapitals binden. **Fix:** `missionSizedNotional()` in `riskGuard.ts`
  (min(Missions-Cap, Code-Maximum), Sandbox-Prinzip), von der Engine verwendet;
  der Trace zeigt jetzt die wirksame Obergrenze.
- **Setup-Skript Konsistenz (Variante A):** `MODEL_EXECUTOR` wurde als 3b
  geschrieben, `.env.example`/Docs sagen 1.5b für den N150 — jetzt 1.5b.

### Getestet (Peer-Review)

- 138 Unit-Tests, alle grün (`npm test`) — inkl. neuer Regressionstests für
  `${PGROOT}`-Expansion, systemd-Formate, URL-Encoding, Missions-Sizing und
  Analysten-Intervall.
- `npm run typecheck` und `npm run lint` fehlerfrei; `npm audit`: 0 Schwachstellen.
- End-to-End gegen einen echten TCP-Postgres (PGlite-wire): kompletter
  `./scripts/setup-cachyos.sh --variant a`-Durchlauf mit der **exakten
  Arch-Unit des Nutzers** als Mock — Datadir-Check `✓`, hostile password
  `O'Brien@x:y/z p+q#%` angelegt und URL-encodet, `drizzle-kit push` → 9 Tabellen,
  `next build` ✓; zweiter Lauf (Idempotenz) ✓.
- Produktionsstart + `scripts/smoke-test.sh`: **18/18 Checks bestanden**
  (Pipeline → Paper-Trade → Kill-Switch → Flatten → Report/Kurve/Log →
  Ceiling-Klemmung). PENNY-Mission: Position ≈ 500 € statt 2.500 €.

---

## [1.5.2] — 2026-08-26

**Setup-/PostgreSQL-Robustheit: `global/pg_filenode.map`, ECONNREFUSED und
`next build` ohne `.env` behoben.** Ursachenanalyse und Fixes für den
Produktionsvorfall „Installation bricht bei Schritt 2 ab, danach schlagen alle
DB-Queries fehl“.

### Behoben

- **Setup-Skript (Schritt 2):** `sleep 1` + `systemctl is-active` meldete
  PostgreSQL fälschlich als „läuft“, obwohl ein halb initialisierter Cluster
  (fehlender `global/pg_filenode.map`) in einer Restart-Schleife crashte. Die
  Folge: `psql`-Fehler, danach fragte das Skript trotzdem nach dem
  Datenbank-Passwort und starb mit demselben Fehler. Neu:
  - Cluster-Vollständigkeit (`PG_VERSION`, `global/pg_control`,
    `global/pg_filenode.map`) wird **vor** dem Dienststart geprüft;
  - der Dienst wird vor einer Neuinitialisierung **gestoppt** (kein Race gegen
    systemd-Auto-Restart mehr);
  - echte Bereitschafts-Wartung mit `pg_isready` (30 s Timeout, Logauszug aus
    `journalctl` bei Fehlschlag) statt blindem Sleep;
  - harte SQL-Verifikation als Superuser, **bevor** Benutzer/Passwort abgefragt
    werden — der Fehler wird nicht mehr vom `if/grep` verschluckt;
  - Abgleich des systemd-Datenverzeichnisses gegen das erwartete
    `/var/lib/postgres/data` (Drop-in-Erkennung).
- **Quote-/Injection-Bug im Setup-Skript:** `CREATE USER … PASSWORD
  '${DB_PASS}'` brach bei einem `'` im Passwort das SQL. Neu: psql-Variablen
  (`-v db_pass=…` + `:'db_pass'`), kontextsicher maskiert; DB-User/DB-Name
  werden per Regex validiert. Gegen echte PostgreSQL 16/18 mit feindlichem
  Passwort (`O'Brien"; DROP SCHEMA public; --`) getestet.
- **`initdb`-Defaults:** `--data-checksums --auth-local=peer
  --auth-host=scram-sha-256` — keine „trust“-Warnung mehr, Korruption wird
  erkannt, TCP-Logins laufen über scram-sha-256.
- **`next build` ohne `.env` (frischer Clone):** `src/db/index.ts` warf beim
  Modul-Import ohne `DATABASE_URL` und riss damit den Build während der
  Next.js-Page-Data-Collection ab (`Failed to collect page data for
  /api/firm/agents`). Neu: Pool/Drizzle werden **lazy** beim ersten Zugriff
  erzeugt (Proxy-Facade); der Import ist ohne Konfiguration harmlos, die erste
  echte Nutzung wirft eine präzise, actionabel Fehlermeldung. Build und Tests
  funktionieren damit auch ohne `.env`.
- **`uncaughtException` bei PostgreSQL-Ausfall:** Fällt PostgreSQL weg, während
  Pool-Verbindungen idle sind (SIGTERM → `57P01`), emittierte node-postgres ein
  `'error'`-Event ohne Listener → uncaughtException mit riesigem Objekt-Dump im
  Journal. Fix: Pool-`'error'`-Handler (`[db] Pool-Fehler (idle client): …`);
  die App degradiert kompakt und erholt sich nach DB-Rückkehr ohne Neustart
  (end-to-end verifiziert).
- **SL/TP gingen bei der Broker-Hydration verloren:** `getBroker` reichte
  `stop_loss`/`take_profit` beim Wiederherstellen aus der DB nicht an den
  Paper-Broker weiter — das Dashboard zeigte nach jedem Neustart „kein
  Stop-Loss", obwohl die DB ihn hat (die Absicherung via Monitor blieb intakt,
  die Anzeige log). Fix: SL/TP werden mithydratiert und in `hydrate()`
  zusätzlich gesanitized (null/NaN/≤0 → null).
- **Missions-API-Fehlermeldung mehrdeutig:** `POST /api/firm/missions` erwartet
  Bruchteile (0.02 = 2 %), die Meldung nannte nur Prozent („zwischen 0.2 % und
  5.0 %"). Neu: Meldung nennt Bruchteil **und** Prozent mit Umrechnungshinweis.

### Hinzugefügt

- **8 Regressionstests** (`tests/dbConfig.test.ts`, `tests/broker.test.ts`):
  pg_isready-Wartung, Cluster-Vollständigkeitsprüfung, initdb-Auth-Flags,
  injection-sichere Passwort-Interpolation, Import ohne `DATABASE_URL`
  (Subprozess), actionable Fehlermeldung bei Nutzung ohne `DATABASE_URL`,
  Pool-`'error'`-Handler sowie Erhalt/Sanitizing von SL/TP bei der Hydration.
- **Handbuch-Runbook 10.6 „PostgreSQL-Cluster defekt“** — Diagnose und
  Reparatur des `pg_filenode.map`-Zustands inkl. der kettenreaktionsartigen
  Symptome (Scheduler-/Hydration-Fehler, Setup-Seite, `ECONNREFUSED` beim Push).
- INSTALL.md: gehärtete initdb-Zeile, `pg_isready`-Schritt, aktualisierte
  Fehlertabelle (u. a. entfernte, veraltete `SCHEMA_MISSING`/HTTP-503-Zeile).

### Diagnose

- Der Vorfall ist vollständig reproduziert und verifiziert: Ein Cluster mit
  fehlender `global/pg_filenode.map` startet laut `pg_ctl status`/systemd
  normal („running“/„active“), nimmt aber keine Verbindungen an
  (`pg_isready` → *rejecting*) und wirft exakt
  `FATAL: could not open file "global/pg_filenode.map"`.
- End-to-End gegen echte PostgreSQL-18-/16-Cluster geprüft: Setup-Kette
  (initdb → User/DB mit feindlichem Passwort → `drizzle-kit push` → Seed →
  Pipeline-Run → Position/Equity/Audit), Deprecation-freier Build mit und ohne
  `.env`, DB-Ausfall mitten im Betrieb (kompakte Degradation) und
  Wiederanlauf ohne Dienstneustart.

---

## [1.5.1] — 2026-08-25

**Sicherheits-Härtung und DB-Konfigurationsdiagnose.** Peer-Review-Fixes für
Fehlerbehandlung in API-Routen und gehärtete Datenbank-Pool-Konfiguration.

### Behoben (Sicherheit)

- **S-21 (Medium)**: API-Routen `firm/run`, `firm/tick`, `firm` (GET) gaben rohe
  Fehlermeldungen an den Client zurück. Datenbank-Connection-Strings und interne
  Details konnten in HTTP-Responses landen. Fix: `publicErrorMessage()` in allen
  betroffenen catch-Blöcken.
- **S-22 (Low)**: `GET /api/firm` hatte keinen try/catch — DB-Ausfall führte zu
  unhandled exceptions mit potenziellem Stack-Trace-Leak. Fix: 503 mit redacted
  Error und Fix-Hinweis.
- **S-23 (Low)**: DB-Connection-Pool hatte keine `max`-Grenze und keine Timeouts.
  Fix: `max: 10`, `connectionTimeoutMillis: 5000`, `idleTimeoutMillis: 30000`.

### Hinzugefügt

- **12 neue Tests** (`tests/dbConfig.test.ts`): Validierung der DB-Konfiguration,
  Sicherheitsdirektiven und Fehlerbehandlung. Prüft drizzle.config.ts auf
  Hardcodierung, Pool-Sicherheit, Security-Header und API-Error-Redaktion.

### Diagnose

- Der Datenbankfehler `password authentication failed for user "trader"` ist
  ein Konfigurationsproblem — das Setup-Script `scripts/setup-cachyos.sh` legt
  den User korrekt an, muss aber ausgeführt werden. Siehe `docs/INSTALL.md`.

---

## [1.5.0] — 2026-08-25

**Workshop: Handbuch-Kapitel 5 und 6 ohne Terminal.** Neuer Dashboard-Reiter
🛠 Workshop mit vier Schritten (Mission anlegen → Agent ausführen → Prompt
iterieren → Trefferquote messen), dazu die passenden API-Routen. Kein
Schema-Bruch, keine neuen Pflicht-Env-Variablen. Nach `git pull`:
`npm ci && npm run build` und Dienst neu starten.

### Added
- **Reiter „🛠 Workshop“** (`src/components/workshop/`):
  - **1 · Mission anlegen/bearbeiten** (5.1–5.3): Formular mit Titel, Ziel,
    Symbol-Autocomplete (aus `GET /api/firm/missions` → Broker-Liste),
    Risikobudget % und max. Position %; Nachschlagkasten mit Faustregel
    („nicht per SQL prüfbar → zu vage“) und der Schlecht/Besser-Tabelle aus 5.2.
  - **2 · Agent ausführen** (6.2): Agent + Mission wählen, ein Turn; Ergebnis
    formatiert (`type`/`side`/`stopLossPct`/`riskScore`/`reason` mit
    Hover-Erklärungen), Guardrail-Kette aufklappbar, Rohdaten-Anzeige; rechts
    die letzten 3 Agenten-Nachrichten mit Quelle und Latenz.
  - **3 · Prompt iterieren** (6.3): `system_prompt`-Editor mit sofortiger
    Wirkung (DB, kein Neubau), JSON-Sollformat + vollständiges Beispiel,
    Feld-Hilfen zu `type`/`side`/`stopLossPct`/`riskScore`, „Beispiel an Prompt
    anhängen“-Knopf, grünes Speicher-Bestätigungsfeld. Bewusst **ohne**
    Guardrail-Regler (weiche vs. harte Schicht).
  - **4 · Trefferquote** (6.4): sequenzielle Testschleife (1–20 Läufe, Standard
    10) mit Live-Balken (TRADE / HOLD / HOLD·kaputtes JSON / ERROR / ANDERE),
    automatischen Debug-Tipps ab 2 JSON-Fällen bzw. 20 % Anteil, Fehlerliste
    mit Sprung ins Protokoll-Tab; Stop-Knopf; sauberes 429-Handling.
- **Hover-/Tastatur-Hilfe überall**: `InfoTip`-Komponente (i-Symbol) auf jedem
  Feld und Fachbegriff — Tooltip bei Hover UND Focus, `title`-Fallback,
  `aria-label` + sr-only-Text für Screen Reader.
- **API-Routen**: `GET/POST/PUT /api/firm/missions` und `PUT /api/firm/agents`
  (nur `system_prompt`). Budgets werden gegen `LIMIT_CEILINGS` validiert (90 %
  Risiko → 400 statt Broker-Block), Symbole gegen die Paper-Broker-Liste,
  Prompts auf Länge; Audit-Einträge `MISSION_CREATED`/`MISSION_UPDATED`/
  `AGENT_PROMPT_UPDATED`.
- **`src/lib/workshop.ts`**: reine Validierungs-/Klassifikationslogik
  (`validateMissionInput`, `validatePromptInput`, `classifyTurnOutcome`,
  `aggregateOutcomes`), von Routen und Tests geteilt.
- **Typsicherheit**: `src/lib/types.ts` (AgentRow, MissionRow, TurnResultDto,
  Response-Interfaces) — `FirmData.agents/missions` typisiert statt `any`.
- **`src/lib/apiClient.ts`**: geteilter `apiFetch` (Token-Header) +
  `readJson`-Fehlerwrapper für aussagekräftige API-Fehlermeldungen.
- `GET /api/firm/log` liefert jetzt auch `content` (Kurzform der Nachricht) —
  Grundlage für die „letzten 3 Nachrichten“-Anzeige.
- Neue Tests: `tests/workshop.test.ts` (Validierungs-Edge-Cases: leere
  Eingaben, 90-%-Budget, unbekannte Symbole, Prompt-Grenzen, Warnungen;
  Klassifikation TRADE/HOLD/INVALID_JSON/ERROR; Aggregation inkl. Tipps-
    Schwelle und Division durch 0).

### Changed
- `package.json` Version **1.5.0**.
- Handbuch 2.3/4.1/5.1–5.3/6.1–6.4: UI-Weg jeweils vorangestellt, Terminal als
  Alternative belassen; API-Tabelle um die Workshop-Routen ergänzt.

### Security
- Missions-/Prompt-Endpunkte hängen am bestehenden `guardWrite` (Token +
  Rate-Limit); DB-Fehler werden als 503 mit redaktierter Meldung
  (`publicErrorMessage`) zurückgegeben statt als undurchsichtiger 500-Crash.
- Missions-Budgets werden **serverseitig** gegen die Code-Deckel geprüft —
  die UI ist nur Anzeige, nicht Kontrollinstanz.

---

## [1.4.0] — 2026-08-25

Security-Härtung, Provider-Korrektheit und Scheduler-Fix. Kein Schema-Bruch,
keine neuen Pflicht-Env-Variablen. Nach `git pull`: `npm ci && npm run build`
und Dienst neu starten.

### Added
- **Schreib-Rate-Limit** für POST/PUT (`guardWrite`): Standard 60 Anfragen / 60 s,
  abschaltbar via `FIRM_RATE_LIMIT=0`. Antwort 429 + `Retry-After`.
- **Secret-Redaktion** (`src/lib/secrets.ts`): Connection-Strings, Bearer-Tokens
  und API-Keys werden aus Health-Fehlern, LLM-Logs und öffentlichen Error-Strings
  entfernt.
- **`extractJsonObject()`**: sicherer JSON-Extractor für Analysten-Payloads
  (view/thesis/recommendation), ohne Prototype-Pollution.
- **`envInt()`**: NaN-feste Env-Zahlen mit Clamp — `TICK_INTERVAL_MS=abc` startet
  den Scheduler nicht mehr mit `setInterval(NaN)`.
- Neue Tests: `tests/hardening.test.ts` (Secrets, Token, Rate-Limit, Intervalle,
  parseDecision-Allowlist, Broker-Reject) plus Erweiterungen in `llmProvider.test.ts`.

### Changed
- `package.json` Version **1.4.0**.
- Gemini-Auth: Key ausschließlich im Header `x-goog-api-key` (nicht mehr als
  Query-Parameter — Keys gehören nicht in Access-Logs/Referrer).
- `LLM_MODEL` gilt jetzt für Gemini **und** Anthropic, nicht nur OpenAI-kompatibel.
- Ollama `keep_alive` ist Top-Level (API-konform); Usage (`prompt_eval_count` /
  `eval_count`) wird geparst.
- Token-Limit der Builder folgt `req.maxTokens` (nicht dem bei Client-Erzeugung
  eingefrorenen Wert).
- `parseDecision` kopiert nur Allowlist-Felder (`type/symbol/side/stopLossPct/reason/riskScore`).
- Audit-Log-Filter (`level`/`event`) und Equity-`range` sind gewhitelistet.
- Agenten-Meta speichert `provider`, `usage`, `costUsd`.

### Fixed
- **Gemini-API-Key in der URL** (High): Query `?key=` entfernte den Key in Logs.
- **Gemini-Modellliste** `models/gemini-…` wurde 1:1 in den Pfad gesetzt →
  `/models/models/…`. Prefix wird jetzt gestrippt.
- **Anthropic `listModels`** las `models[].name` statt `data[].id` → leere Liste.
- **Retry-`attempt`** war immer 1, weil `client.chat` den Zähler verwarf.
- **Analysten-Intervall**: `ANALYST_INTERVAL_MIN` wurde nur geloggt; der Slot-Key
  `HH:MM` ließ die Analysten **jede Minute** laufen. Jetzt echter Abstand
  (Default 30 min, Minimum 10).
- **Broker-Cash nach Slippage**: Prüfung gegen Pre-Slippage-Notional konnte das
  Konto um 0,1 % negativ machen. Jetzt Fill-Kosten.
- **`reject()` crashte** bei nicht-string `symbol` (`toUpperCase` auf Number).
- **`hydrate()`** übernahm unsanitized DB-Symbole in die Position-Map.
- **Kerzen-Intervalle und Yahoo-Screener-IDs** ohne Whitelist (URL-Injection).
- **Health-500** konnte `DATABASE_URL` in `error` durchreichen.
- **Provider-Base-URL**: `file:` / Userinfo (`user:pass@host`) werden abgelehnt.

### Security
- Timing-sicherer Token-Vergleich mit Längen-Padding (kein Length-Oracle).
- `npm audit`: Ziel 0 Vulnerabilities (siehe SECURITY_AUDIT.md).

### Tests
- Bisherige 67 Tests bleiben; neu ~25 Härte-/Provider-Tests. `npm test` muss
  vollständig grün sein.

### Anmerkung Migration
Kein DB-Schema-Change. `.env` optional um `FIRM_RATE_LIMIT` ergänzen.
Wer Gemini nutzt: Header-Auth ist transparent, keine Key-Änderung nötig.

---

## [1.3.0] — 2026-08-24

### Added
- **LLM-Provider-Abstraktion** (`src/lib/llmProvider.ts`) mit vier konfigurierbaren
  Providern hinter EINEM Interface:
  - `ollama` — nativer Ollama-Server (Standard)
  - `openai` — jeder OpenAI-kompatible Endpunkt (llama.cpp, LM Studio, vLLM, LocalAI, Cloud)
  - `gemini` — Google Gemini (`GEMINI_API_KEY`, `GEMINI_BASE_URL`)
  - `anthropic` — Anthropic Claude (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
- **Provider-Fallback-Kette** `LLM_FALLBACK_PROVIDERS` (kommagetrennt): scheitert der
  primäre Provider, werden die nächsten der Kette probiert, bevor die Regel-Engine greift.
- **Standardisierte API-Calls**: `LlmChatRequest {model, messages, temperature, maxTokens, json, schema, timeoutMs}` → `LlmChatResult {content, usage, latencyMs, costUsd}`.
- **Fehlerbehandlung & Retries**: `withRetry()` mit exponentiellem Backoff + Jitter;
  Retry nur bei Netzwerkfehlern, HTTP 429 und 5xx; `LLM_MAX_ATTEMPTS` (Standard 2).
- **Kosten-/Performance-Trade-offs**:
  - `LLM_MAX_TOKENS` (Standard 512) begrenzt jede Antwort (`num_predict`/`max_tokens`/`maxOutputTokens`).
  - `estimateCostUsd()` schätzt Kosten je Aufruf (Referenztarife + `LLM_COST_*`-Overrides, lokal = 0).
  - Token-Verbrauch (`usage`) wird in `agent_messages.meta` protokolliert.
- **Versions-Reporting**: `/api/health` und `/api/firm` liefern jetzt `version` aus `package.json`.
- **Dokumente umstrukturiert**: alle Markdown-Dateien liegen unter `docs/`
  (`docs/README.md`, `docs/INSTALL.md`, `docs/HANDBUCH.md`, `docs/CHANGELOG.md`,
  `docs/SECURITY_AUDIT.md`, `docs/PROVIDER_INTEGRATION.md`).
- Neue Tests: `tests/llmProvider.test.ts` (Builder, Parser, Retry, Backoff, Kosten,
  Fallback-Kette), `tests/broker.test.ts` (Hydration, Guardrails, Validierung),
  `tests/security.test.ts` (Symbol-Whitelist, Injection-Versuche, parseDecision-Robustheit).

### Changed
- `package.json`: Name `ai-trading-firm`, Version `1.3.0`, `engines.node >= 20`, License MIT.
- `.env.example`: neue Sektionen „Cloud-Provider", „Retries", „Kosten", „Scheduler".
- `src/lib/ollama.ts` ist jetzt die Kompatibilitäts- und Orchestrierungsschicht über
  `llmProvider.ts`; öffentliche Funktionen (`getOllamaStatus`, `localReason`,
  `fallbackReason`, `DECISION_SCHEMA`) bleiben stabil.
- `scripts/setup-cachyos.sh` erwartet jetzt **9** Tabellen (inkl. `equity_snapshots`).

### Fixed
- Siehe [1.1.0] (alle Bugfixes sind in 1.3.0 enthalten).

---

## [1.1.0] — 2026-08-24 (Security- & Stabilitäts-Release)

### Fixed (hoch)
- **P&L-Verlust nach Neustart** (`engine.getBroker` + `PaperBroker.hydrate`):
  Der Cash-Stand wurde aus `STARTING_EQUITY − Einstiegs-Notional` rekonstruiert.
  Realisierte Gewinne/Verluste geschlossener Trades gingen bei jedem Prozess-Neustart
  verloren (Depot zeigte wieder 10.000 € statt z. B. 10.200 €).
  **Fix:** letzter persistenter Cash-Wert aus `equity_snapshots` wird als `cashHint`
  übernommen; Fallback nur bei leerer/frischer DB.

### Fixed (mittel)
- **Tagesverlust-Fenster in `engine.ts`** nutzte Server-Localtime statt
  `Europe/Berlin` — inkonsistent zu `monitor.tick()` und `equity.realizedPnlToday()`
  (systemd läuft oft mit UTC). **Fix:** `startOfBerlinDay()`.
- **GET `/api/firm/tick` mutierte Zustand** (Kurse, SL/TP → Positionen schließen).
  Browser-Prefetches/Monitore lösten dort Handel aus. **Fix:** GET → HTTP 405.
- **Race Conditions**: `monitor.tick()` und `runPipeline()` hatten keinen
  Single-Flight-Schutz — überlappende Zyklen erzeugten doppelte Snapshots,
  Vorschläge und Audit-Einträge. **Fix:** Promise-Lock (Tick) bzw. Guard
  (`PIPELINE_ALREADY_RUNNING` → HTTP 409).
- **Symbol-Validierung**: Modell-/DB-Symbole flossen ungeprüft in externe URLs
  (Binance-Query), Prompts und JSONB. **Fix:** `sanitizeSymbol()`-Whitelist
  (`^[A-Z0-9]{1,12}([.=][A-Z0-9]{1,5})?$`) in `marketData`, `broker.submit` und
  `engine.runAgentTurn`; Binance-URLs zusätzlich `encodeURIComponent`.
- **Security-Header fehlten** (`next.config.ts`): jetzt CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy` in Produktion (Dev bleibt offen für HMR).
- **`checkSchema()` kannte `equity_snapshots` nicht** → Healthcheck meldete
  „schemaReady" obwohl die Equity-Kurve/Snapshots fehlten; Setup-Skript prüfte 8 statt 9 Tabellen.

### Fixed (niedrig)
- `/api/firm/log?limit=NaN|-5` → SQL-Fehler 500. **Fix:** Limit auf 1–200 geklemmt.
- `stopLossPct: "abc"`/`NaN` → Order wurde mit NaN kalkuliert und pauschal geblockt.
  **Fix:** nicht-zahlfähige Werte gelten als „keine Angabe" → ATR-/Default-Fallback.
- `riskScore` aus Modell-Output ohne Zahlenvalidierung konnte Insert in `numeric`
  sprengen. **Fix:** Normalisierung auf [0,1].
- `scripts/drizzle.config.json` (veraltet, hardcodierte DB-Zugangsdaten) entfernt —
  das Projekt nutzt `drizzle.config.ts` mit `DATABASE_URL` aus `.env`.
- `scripts/smoke-test.sh` prüfte das Feld `status`/`SCHEMA_MISSING`, das die API nie
  liefert (toter Setup-Zweig). **Fix:** `schemaReady === false`.
- Scheduler-Analysten-Slot nutzte Server-Stunde statt Berliner Zeit → Doppelstart-
  Schutz griff auf UTC-Servern unzuverlässig. **Fix:** `Europe/Berlin`-Schlüssel.
- Lint: 10 Fehler in `FirmDashboard.tsx`/`docs/page.tsx` (unescaped entities,
  setState im Effekt) behoben — `npm run lint` ist jetzt fehlerfrei.
- `tsconfig.tsbuildinfo` aus dem Repo entfernt und per `.gitignore` ausgeschlossen.

### Security (geprüft, keine Änderung nötig)
- `npm audit`: **0 Schwachstellen** (Stand des Release).
- API-Token-Vergleich: `crypto.timingSafeEqual` ✓
- Keine `eval`/`child_process`/`exec`, keine `dangerouslySetInnerHTML` ✓
- `parseDecision`-Prototype-Pollution-Test (neu) ✓
- SQL: ausschließlich parametrisierte Queries via Drizzle ✓

### Tests
- 63 Unit-Tests, alle grün (`npm test`).
- Neu: Broker-Hydration (Neustart-Fix), Symbol-Injection, parseDecision-Robustheit,
  Provider-Builder/Parser, Retry/Backoff, Kosten, Fallback-Kette, KILL-Marker.

### Anmerkung Migration
Kein Schema-Bruch: `equity_snapshots` existierte bereits; geändert wurde nur die
Prüfung. Bei Alt-Installationen einfach `npx drizzle-kit push` erneut ausführen.

---

## [1.0.0] — 2026-08 (Ausgangsstand beim Audit)

Baseline: Archiv-Repository mit Engine, Paper-Broker, Ollama/OpenAI-Client,
Guardrails, Monitor, Analysten, Dashboard und erster Test-Suite (26 Tests).

---

## Offen / bewusst nicht gemacht (Backlog)

| Thema | Grund |
| --- | --- |
| Multi-Node Rate-Limit / Scheduler-Locks | v1.4.0 limiter ist prozess-lokal; Cluster bräuchte Redis/DB |
| Auto-Upgrade der Abhängigkeiten | Versions-Pins sind bewusst stabil; `npm audit` als Teil des Deploy-Checks |
| Live-Broker-Adapter (Alpaca/ccxt) | bewusst außerhalb des Paper-only-Scopes (Handbuch Kapitel 8) |
| Persistente Scheduler-Locks über Prozesse hinweg | aktuell prozess-lokal (Single-Node-Betrieb); Multi-Node bräuchte DB-Locks |
