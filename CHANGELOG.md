# Changelog — Autonome KI-Trading-Firma

> **Status-Header (Task 12):** Konsolidierter Überblick · **2026-08-29** ·
> Code-Version **1.25.0**. Vollständige, detaillierte Einträge je Release stehen
> in [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (Keep a Changelog + SemVer).
> Diese Datei ist der konsolidierte, task-zugeordnete Überblick.

## Versionierung

| Stelle | Bedeutung |
| --- | --- |
| **MAJOR** (1.x.y) | Breaking Changes: DB-Schema-Brüche, entfernte Env-Variablen, neue Pflichtkonfiguration |
| **MINOR** (x.1.y) | Neue Features (z. B. Provider), abwärtskompatibel |
| **PATCH** (x.y.1) | Bugfixes und Sicherheits-Fixes |

Die Version steht in `package.json` und wird von `/api/health` und `/api/firm`
ausgeliefert.

## [1.25.0] — 2026-08-29 · Markt-Daten-Sync-Pfad (nachträglich PR #33)

**Nacharbeit zur Architekturänderung:** Der Scanner (`scanUniverse()`) las bisher
nur die lokale, oft leere Historie (`data/history/candles.ndjson`). Ohne einen
vorherigen Warmup-Lauf war der Trichter leer. Dafür gibt es jetzt einen
**eigenen Sync-Pfad** vor dem Scan — deterministisch, ohne den Scanner zu
verändern.

**Architektur (nach PR #33):**

```
Venue-Adapter (public REST) → MarketDataSyncService → Registry + HistoricalStore
                                                      → Scanner (weiterhin ohne Netz)
```

* `MarketDataAdapter.discoverInstruments()` (1×) → Registry
* `MarketDataSyncService.syncVenue()` (1× Batch-Ticker, N× Depth, N× 4 Timeframes)
* `scanUniverse()` bleibt deterministisch und netzwerkfrei; `/api/markets` bleibt read-only.

**Neu / bestätigt (nachträglich):**

* `src/marketdata/` — `MarketDataAdapter`, `MarketDataSyncService`, `Spread`,
  `UnsupportedVenueError`, `Bitunix-Public-Adapter` (Public-Client, keine Keys).
* CLI-Befehle: `npm run market-sync` und `npm run scan -- --sync-first`.
* Dokumentation: `docs/MARKET_DATA_PIPELINE.md` (Discovery, Enrichment,
  Backfill 5m/15m/30m/1h mit 150 Kerzen, Persistence, Readiness, Scanner,
  Failure-Semantics, Rate-Limiting 8 req/s, Venue-Matrix, Sicherheit).
* Verhalten: Fehler pro Instrument isoliert (kein Full-Abort); Token-Bucket
  8 req/s nur Public-Client; CLI loggt nur aggregierte Zähler.
* Doku-Stand auf 1.25.0 aktualisiert.

**Sicherheit:** Keine Private-API, keine Credentials im Sync-Pfad; Adapter-Instanzierung
nur über `AdapterRegistry` im Modus `"paper"`; Integrationstests prüfen `privateCalls === 0`.

---

## [1.24.1] — 2026-08-29 · Instrument-Enrichment: volume24h + Orderbook-Spread

**Nacharbeit zu 1.24.0 (CODE-REVIEW-SCANNER §4/§5):** `discoverInstruments()`
liefert nur statische Handelsparameter (`symbol`, `base`, `quote`,
`minTradeVolume`, Präzisionen, `maxLeverage`, `symbolStatus`, `isApiSupported`) —
**keine** Liquiditäts- oder Preismetriken. Ohne Enrichment ist `spread` für
jedes Instrument `null`, der `spread`-Faktor hat (anders als `liquidity`)
keinen Fallback, und der Trichter läuft an der `max-spread`-Regel leer — auch
nach einem Candle-Backfill.

* **Enrichment-Pfad** `trading_pairs → tickers → volume24h → depth →
  bestBid/bestAsk/spread → kline → HistoricalStore → Scanner`:
  `MarketDataSyncService.syncVenue()` ruft je Instrument `getTicker()` (bzw.
  1× `getTickers()` als Batch) und `getOrderBook()` auf und schreibt
  `volume24h` + berechneten relativen Spread mit `lastSeen` in die Registry.
* **`calculateRelativeSpread()`** (`src/marketdata/spread.ts`):
  `(ask − bid) / mid`; fehlende/invertierte/nicht-positive/`NaN`-Werte ⇒
  `null` („nicht geladen“), niemals `0` und niemals eine Exception.
* **Data-Quality-Rejections:** `FilterRejection.dataQuality` trennt fehlende
  Daten (`min-candles`, `min-volume`, `max-spread`, `max-execution-cost`) von
  fachlichen Marktgründen; Meldungen sagen „… wurde nicht geladen“ statt eines
  generischen „Instrument ungeeignet“.
* **Symbol-Guard:** Ein Ticker wird nur übernommen, wenn sein `symbol` exakt
  zum Instrument passt — sonst bleibt `volume24h` unbekannt statt fremd.
* **Doku:** `docs/MARKET_DATA_PIPELINE.md` (Enrichment-Datenfluss,
  Data-Quality-Tabelle) und `docs/BITUNIX.md` §1.2 (Spread kommt aus
  `/depth`, nicht aus dem Ticker; 1 zusätzlicher Call je Instrument).

## [1.24.0] — 2026-08-29 · Persistenter Venue-Market-Data-Sync

**Haupt-Task:** `MarketDataSyncService` orchestriert Discovery → Ticker- und
Orderbook-Enrichment → Candle-Backfill (5m/15m/30m/1h) in Registry und
Historical Store. Der Scanner bleibt deterministisch und netzwerkfrei.
CLI: `npm run market-sync`, `npm run scan -- --sync-first`. Doku:
`docs/MARKET_DATA_PIPELINE.md`.

## [1.23.0] — 2026-08-29 · Operations Center vollständig integriert (Task 10)

**Haupt-Task:** Das Operations Center ist keine Phase-1-Hülle mehr. Der Tab
zeigt zehn Sektionen mit echten Werten aus bestehenden Modulen — statt sieben
Karten, von denen fünf auf `stub` standen.

**Ausgangslage (Beanstandung aus dem Review):** `docs/ARENA_TASKS.md` wies Task
10 als „Implementiert“ aus, während Code und API sich selbst als
„Operations-Center-Hülle“ bezeichneten und der Tab textlich erklärte, er sei
„bewusst die leere Hülle“. Korrektur: **Code an Doku angeglichen** (nicht die
Doku herabgestuft).

**Neu — zehn Sektionen, jede mit Quellen und Ist-Daten:**

- **Market Universe** — Bestand je Venue, Datenstand, Policy-Version (`src/universe`).
- **Scanner** — Trichter scanned→eligible→interesting→daily→deep, Top-Scores mit
  Regime (`src/scanner`).
- **Portfolio Analytics** — offene Positionen, Exposure, Eigenkapital,
  Tagesergebnis; Gewichte/Kennzahlen bleiben Sache des Portfolio-Moduls.
- **Research Operations** — Tages-/Wochenläufe, Status, Dauer, Weekly-Klassen
  (`src/cycle`).
- **Broker Operations** — sieben Venues mit Capabilities, Execution-Modi und
  lokalem Health (`GET /api/brokers`).
- **LLM Operations** — Routing-Policy, Modus, Provider-Health, Tagesbudget,
  letzte Entscheidungen (`GET /api/routing`).
- **Agent Operations** — Agenten, Rollen, Missionen, letzte Aktivität.
- **Risk** — Limits, Volatilitäts-Regime, Kill-Switch, Live-Gate-Lage.
- **Audit** — Ereignisse/Warnungen/kritische Treffer plus Integrität der
  Live-Gate-Hash-Kette.
- **Help** — Hilfe-Dateien, Fachbegriffe und der Dokumentationskatalog.

**Architektur:** Neues Modul `src/ops/` (`types.ts`, `collect.ts`, `index.ts`)
aggregiert ausschließlich bestehende Fassaden. Keine zweite Fachlogik, keine
Mutation, kein Secret im Payload. `src/auth/ops.ts` hält weiterhin Katalog und
RBAC-Projektion (Rolle, Live-Sperre); `buildOpsPayload()` führt Katalog und
Ist-Daten zusammen.

**Robustheit:** Jede Sektion ist fail-soft. Eine nicht erreichbare Quelle
(z. B. PostgreSQL aus, `docs/`-Ordner fehlt) macht nur ihre Sektion
`unavailable` mit redigierter Meldung — das Cockpit bleibt lesbar. Der
Zustandsraum `ready | degraded | empty | locked | unavailable` ersetzt `stub`.

**Bedienung:** Der Reiter „🧭 Operations Center“ ist jetzt im Dashboard
sichtbar (vorher nur im Code vorhanden). Karten mit Ziel-Tab (Brokers, Risk,
Protokoll) springen direkt dorthin; jede Karte nennt unter „Quellen“ ihre
Datenherkunft.

**Getrennt/Sauber:** `src/lib/docsCatalog.ts` ist die neue Single Source of
Truth für die Dokumentations-Whitelist — `GET /api/docs` und die Help-Sektion
lesen dieselbe Liste (vorher nur in der Route).

## [1.22.0] — 2026-08-29 · Provider/Modell-Overrides + Audit-Härtung + Test-Isolation

**Administrative Provider/Modell-Auswahl je Agent (Haupt-Task):** Admins können
jetzt pro Agent einen expliziten Provider und ein explizites Modell festlegen
(Overrides), die vor der normalen Policy-/Modusauswertung greifen — mit
best-effort-Persistenz, Fallback und vollständiger Auditierung.

- **Neu `Provider/Modell-Override`** im Router (`setOverrides()`/`getOverrides()`):
  pro Agent ein Tupel `{provider, model, fallbackMode}`. Override wird zuerst
  versucht (Health, Cloud-Freigabe, Budget, Kontext, Fähigkeiten bleiben harte
  Router-Guardrails); bei Fehlschlag (offline/Quota/Kontext/…) fällt der Router
  transparent in den konfigurierten `fallbackMode` und die normale Kette läuft
  weiter.
- **Persistenz:** Overrides werden best-effort unter `data/routing/overrides.json`
  (chmod 600) gespeichert und beim nächsten Start geladen — analog zu den
  bereits vorhandenen Routing-Modi (`data/routing/modes.json`). Korrupte oder
  fehlende Dateien werden toleriert (leerer Startzustand). Deaktivierung via
  `null` (z. B. `{"TECHNICAL_ANALYST": null}`) entfernt einen Override.
- **API-Erweiterung** `PUT /api/routing/modes`: akzeptiert jetzt zusätzlich
  `overrides` im selben Request; Antwort enthält beide Audit-Logs. `GET
  /api/routing/modes` liefert neben den Modi auch die aktuellen Overrides.
  Ungültige Modelle werden abgewiesen (Modell muss in der Provider-Registry
  registriert sein).
- **Snapshot/Audit:** `RouterSnapshot.overrides` und der Routing-API-Snapshot
  liefern die Overrides mit; jede Setzung/Deaktivierung wird als
  `ADMIN_OVERRIDE_CHANGE` mit `from → override:provider:model → to` auditiert.
- **Fallback-Verhalten:** Scheitert der Override-Provider (offline, Quota
  erschöpft, Kontext zu klein, Fähigkeit fehlt, Kostendeckel, Agenten-Budget),
  wird automatisch in den `fallbackMode` gewechselt — kein harter Fehler.
  Jeder Fallback ist als `FALLBACK_CHAIN` auditiert.

**Actor-Audit-Sicherheitsfix:**

- **Client-geliefertes `actor`-Feld wird ignoriert.** Das betrifft
  `PUT /api/routing/modes` (und war bereits für alle Control-Plane-Routen
  unter `/api/brokers/*` umgesetzt): die Audit-ID wird ausschließlich aus der
  authentifizierten Principal-Rolle nach RBAC/CSRF aufgelöst
  (`actorAuditId(req)` → `admin`/`operator`/`viewer`). Ein Angreifer, der
  Operator- oder Viewer-Token besitzt, kann keine Admin-Aktionen als
 另一 Benutzer im Audit unterschieben; lokaler Offen-Betrieb (kein Token
  gesetzt) schreibt konsistent `admin`. TSDoc-Kommentare an den betroffenen
  Routen verschärft, Regressions-Test für Routing-API vorhanden.

**Weitere Änderungen:**

- **Test-Fixture-Härtung:** `tests/fixtures/routingTestUtil.ts` setzte
  `overridesFile: null` nicht, so dass On-Disk-Overrides zwischen Tests
  leckten und einen Override-Validierungstest falsch negativ schlugen
  (Reihenfolgenabhängigkeit). Behoben — beide Persistenz-Pfade (`modesFile`,
  `overridesFile`) sind im Test-Modus jetzt `null`.
- **Neue Routing-Tests (+5, total 1148):** Override-Deaktivierung (Null),
  Persistenz (Write → Reload), Malformed-JSON-Toleranz, Fallback-Kette bei
  Offline-Override, Snapshot-Invarianten. `tests/routing.*.test.ts` jetzt
  **107 grün**.
- **Doku-Aktualisierungen:** `docs/LLM_ROUTING.md` auf Version 1.22.0
  aktualisiert (Overrides, Persistenz, Deaktivierung, Fallback-Verhalten,
  Authentifizierung und Audit-Identität, Peer-Review-Checkliste ergänzt),
  `docs/PROVIDER_INTEGRATION.md` und `README.md` auf 1.22.0 nachgezogen.
  Neues Peer-Review-Dokument `docs/PEER_REVIEW_ROUTING_OVERRIDES.md`.
- **Keine Breaking Changes:** Bestehende Modi (`manual`/`automatic`/`hybrid`),
  Policy-Datei, API-Responses (additive Felder) und Env-Variablen bleiben
  kompatibel. Weder `putCredentials`-Arbeitsfluss noch Live-Gate oder
  Broker-Coverage werden berührt.

## [1.21.0] — 2026-08-29 · Coverage-Trennung + vereinheitlichte Paper-Execution

**Terminologie & Broker-Status-Tracking getrennt (Haupt-Task):** „gescannte“
bzw. registrierte Venues sind jetzt klar von der tatsächlichen Capability-
Abdeckung getrennt.

- **Neu `src/brokers/coverage.ts`** (`computeBrokerCoverage`): reine Projektion
  aus der Capability-SSoT + Live-Gate-Enforcer. Liefert Headline-Kennzahlen
  („7 Venues registriert · 1 mit vollständiger Discovery · 1 mit Paper-Market-Data
  · 0 mit aktiviertem Live Trading“) und fünf Coverage-Metriken (Discovery /
  Market Data / Paper / Testnet / Live Execution).
- **Neu `GET /api/brokers/coverage`** (read-only, tokenfrei, keine Secrets).
- **Neu `CoveragePanel`** im Brokers-&-Venues-Tab: differenzierte Headline,
  fünf Coverage-Balken und eine Detailtabelle je Venue (intern/extern, Live-
  Fähigkeit vs. Live-Freigabe getrennt). Ersetzt die irreführende Zählung
  „7 Broker“.
- **Headline extern gezählt:** Der interne `PAPER`-Simulator wird transparent
  als *intern* markiert; die Headline misst reale externe Venue-Integration.

**Paper-Execution vereinheitlicht (Sekundär-Task):** Der Bitunix-Paper-Ledger
verwendet **keine** separate, vereinfachte Simulation mehr.

- **Fix `src/brokers/bitunix/paper.ts`:** statt fester Faktoren
  (LONG → `price·1.0001`, SHORT → `price·0.9999`) läuft jeder Fill jetzt durch
  den **zentralen** `FillSimulator` (Spread, Slippage, Gebühren, Latenz,
  Partial Fills). `Generic Paper === Bitunix Paper`.
- **Neu `src/lib/marketdata/snapshot.ts`** (`snapshotFromLastPrice`,
  `fallbackInstrument`): wandelt einen reinen Last-Preis-Ticker in einen
  normalisierten `MarketSnapshot` (Bid/Ask symmetrisch aus synthetischem
  Spread), damit ticker-basierte Venues dieselbe Fill-Engine nutzen.
- **Neuer Env-Knopf** `PAPER_SIM_SYNTHETIC_SPREAD_BPS` (Default 2 bp).
- **Keine Breaking Changes:** Reject-Pfade, Guardrails, Kill-Switch und der
  Live-Pfad (weiterhin `LiveTradingGateError`) unverändert.
- **Neue Tests (+24):** `brokerCoverage.test.ts`, `brokerCoverage.api.test.ts`,
  `bitunix.paper.unified.test.ts`, `marketdata.snapshot.test.ts`.

## [1.20.0] — 2026-08-28 · Bitunix-Ausführungs-Refactor (Paper/Broker getrennt)

**Kritischer Bugfix + Architektur-Trennung (Peer-Review umgesetzt):** Der
Bitunix-Live-Pfad handelt **niemals mehr über das lokale Paper-Ledger**.

- **`ExecutionPort`** (`src/brokers/bitunix/execution.ts`): `PaperExecutionEngine`
  (paper/backtest, lokales Ledger) und `BrokerExecutionEngine` (live, echte
  Private-API) sind zwei getrennte Implementierungen desselben Ports.
- **Adapter-Fix:** `placeOrder`, `getAccount`, `getPositions` im Live-Modus
  delegieren nach bestandener Live-Gate-Prüfung an die **Broker-Engine**
  (`BitunixPrivateClient.placeSerializedOrder` / echte Venue-Daten) — nicht mehr
  an `paper.submit()` / Paper-Account. Kein stiller Fallback.
- **Semantik-Trennung** (Fehler 3): neues Instrument-Feld `liveTradable`
  (Fähigkeit des Instruments am Broker) klar getrennt von `adapterCapabilities.live`,
  `venueControl.liveEnabled` und `liveGate.state`. `liveAvailable` bleibt als
  abwärtskompatibler Spiegel. Bitunix-Mapping: `liveTradable=true`,
  `liveAvailable=false`.
- **Keine Breaking Changes:** Paper-Trading & Testnet-Verhalten unverändert;
  Live bleibt ohne bestandene Gate-Prüfung `LiveTradingGateError`.
- Neue Tests: Live-Gate-OPEN → Broker-Engine (nicht Paper), ExecutionPort-Separation,
  Semantik-Trennung der vier Live-Konzepte.

## [1.19.0] — 2026-08-28 · Task 11 (Live-Trading-Gate)

- Auditierte Live-Trading-State-Machine: 9 Zustände, exakt 8 legale Übergänge.
- Single-Point-Enforcer vor jeder Venue-Order; Human-Gate mit 24 h Cooldown und
  4-Augen-Modus; Kill-Switch mit persistenter Failsafe-Datei.
- Append-only Audit mit SHA-256-Hash-Kette; merge-blockierender CI-Job
  `security-live-gate` (Coverage ≥ 95 %).
- **Aktiviert KEIN Live-Trading** — Default bleibt DISCONNECTED/off.

## [1.18.0] — 2026-08-28 · Task 10 (Operations Center + RBAC)

- Rollen `viewer` / `operator` / `admin`; Ops-Tab; Doku-Drift-Fixes.
- 3-Ebenen-Hilfe (`docs/help/*.help.json`) als Tooltip-Grundlage.

## [1.17.0] — 2026-08-28 · Task 09 (Model-Router)

- `MODEL_ROUTER` mit 9 Routing-Inputs, Default-Tabelle
  (CEO→automatic, Research→large, Technical→local-small, News→local-small,
  Risk→local-medium, Portfolio→local-medium), Eskalationsfluss, Budgets, Audit.

## [1.16.0] — 2026-08-28 · Task 08 (Broker Control Plane)

- Credential-Secret-Store mit Verschlüsselung, Health-Checks, Red-Team-Checks,
  Audit-Katalog-UI.

## [1.15.0] — 2026-08-27 · Task 07 (Bitunix-Adapter)

- Bitunix als 7. Venue: Public REST/WS, Signing, Paper-Modus B; Live bleibt
  gesperrt.

## [1.14.0–1.12.0] — 2026-08-27 · Tasks 05–06 (Portfolio-Analytics, Cycle)

- Portfolio-Analytics mit Formelkatalog, drei Optimizer-Modi und Risk-Guard-
  Kette; Daily/Weekly-Agent-Cycle mit CORE/ROTATION/DISCOVERY/EXCLUDED.

## [1.11.0–1.9.0] — 2026-08-27 · Tasks 03–04 (Paper-Trading, Scanner)

- Broker-unabhängige Paper-Market-Data (Modi A/B/C) mit deterministischem
  Fill-Simulator; deterministischer Markt-Scanner mit Score-Gewichten
  (25/15/15/10/10/10/5/5/5) und Trichter (10.000→2.000→500→100 + 20–40 Deep).

## [1.8.0–1.6.0] — 2026-08-26/27 · Tasks 01–02 (Universe, Broker-Modell)

- Instrument-Registry (Market Universe) mit Normalisierung; Broker-Capability-
  Modell mit Execution Modes `backtest/paper/testnet/live` und Adapter-Vertrag.

## [1.0.0–1.5.x] — 2026-08 (Ausgangsstand)

- Next.js + Drizzle + PostgreSQL, 6-Agenten-Pipeline, LLM-Provider-Schicht,
  Security-Härtung (Secret-Store, Guard, Audit-View). Ausführliche Einträge:
  `docs/CHANGELOG.md`.

## Unreleased / Backlog

- Vollständige, code-synchronisierte Docs (15/15 Zieldateien mit Status-Header),
  Root-Docs (`README.md`, `INSTALL.md`, dieser Changelog) — seit 1.22.0
  durchgehend versioniert.
- Hilfe-Systematik: `docs/help/help.schema.json` + alle `*.help.json` schema-valid.
- CI-Job `docs-validate` (Schema, Link-Check, Markdown-Lint, Secret-Scan, Konsistenz).
- Audit-Report `docs/DOCS_SYNC_AUDIT.md`; Task-Tracker `docs/ARENA_TASKS.md`
  (Tasks 1–12); SECURITY_AUDIT-Kapitel Task 12.
- Multi-Node Rate-Limit/Scheduler-Locks (prozess-lokale Limits im Single-Node-Betrieb).
- Persistente Scheduler-Locks über Prozesse hinweg (siehe docs/CHANGELOG.md Backlog-Tabelle).
