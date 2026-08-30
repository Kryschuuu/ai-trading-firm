# Arena-Tasks — Task-Tracker (1–12)

> **Status-Header (Task 12):** **Implementiert** (Task 12, Doku) ·
> **2026-08-29** · Version **1.23.0** · Branch: `arena/01a049f7-ai-trading-firm`
>
> **Nachtrag 2026-08-29 (v1.23.0):** Task 10 wurde nachgeprüft. Das Operations
> Center war im Code eine Phase-1-Hülle (sieben Karten, fünf davon `stub`),
> während dieser Tracker „Implementiert“ auswies. Phase 2–4 des Task-10-Plans
> sind jetzt umgesetzt: zehn Sektionen mit echten Daten, keine Stub-Zustände.
> Der Status bleibt **Implementiert** — der Code hat die Doku eingeholt, nicht
> umgekehrt (Details siehe „Task 10 im Detail“).

Kanonischer Tracker „welcher Task steckt in welcher Version, mit welchem PR,
welchem Security-Audit und welchem Review-Status“. Spalten:
**Status** (Implementiert / Teilweise / Geplant), **Branch/PR**,
**Security-Audit** (✓/✗ + Link), **Review** (✓/✗), **offene Punkte**.

## Gesamtübersicht

| # | Titel | Status | Version | Branch/PR | Security ✓ | Review ✓ | Offene Punkte |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Projekt-Setup | Implementiert | (vor 1.0) | initial | ✓ [S01](#) | ✓ | — |
| 02 | Konten-Struktur / Trading-Kern | Implementiert | v1.2 ff. | #1 | ✓ [S02](#) | ✓ | — |
| 03 | 6-Agenten-Pipeline | Implementiert | v1.6 ff. | #2 | ✓ [S03](#) | ✓ | — |
| 04 | LLM-Provider-Integration | Implementiert | v1.7 ff. | #3 | ✓ [S04](#) | ✓ | — |
| 05 | Bitunix-Vorbereitung | Implementiert | v1.15 ff. | #4 | ✓ [S05](#) | ✓ | — |
| 06 | Market-Universe-Registry | Implementiert | v1.8 | #4 | ✓ [S06](#) | ✓ | — |
| 07 | Paper-Trading + Schutzkette | Implementiert | v1.9 ff. | #5 | ✓ [S07](#) | ✓ | — |
| 08 | Security-Härtung + Audit-View | Implementiert | v1.10 ff. | #6 | ✓ [S08](#) | ✓ | — |
| 09 | Bitunix-Adapter (7. Venue) | Implementiert | v1.15 | #7 | ✓ [S09](#) | ✓ | — |
| 10 | Operations Center + RBAC | Implementiert | v1.18 → v1.23.0 | #8 | ✓ [S10](#) | ✓ | keine (Nachaudit v1.23.0) |
| 11 | Live-Trading-Gate | Implementiert | v1.19 | #9 | ✓ [S11](#) | ✓ [R](#) | LG-01…LG-04 |
| **12** | **Dokumentation (Docs-Sync)** | **Implementiert** | **1.19.0** | **dieser PR** | **✓ [S12](#)** | **✓ [R12](#)** | **siehe unten** |
| **13** | **Marktdaten-Fehler-Observability** | **Implementiert** | **1.26.1** (Nacharbeit **1.26.3**) | **dieser PR** | **✓ MDERR-006** | **✓** | **—** |
| **14** | **Timeframe-Dimension im Historical Store (MDSYNC-001)** | **Implementiert** | **1.26.0** (Nacharbeit **1.26.2**) | **PR #40** + Nacharbeit | **✓** | **✓** | **—** |
| **15** | **Zentrale, venue-aware Symbol-Normalisierung (SYM-007)** | **Implementiert** | **1.28.0** | **dieser PR** | **✓ SYM-007** | **✓** | **—** |
| **16** | **Persistenter Marktdaten-Warmup + Sync-CLI (MDSYNC-001)** | **Implementiert** | **1.29.0** | **dieser PR** | **✓ (Pipeline-Doku, Sicherheit)** | **✓** | **—** |

> **Nachtrag 2026-08-30 (v1.29.0):** Task 16 (persistenter Marktdaten-Warmup,
> MDSYNC-001) ist implementiert: `npm run market:sync` befüllt
> `InstrumentRegistry` + `HistoricalStore` **vor** dem Scanner, der Sync-Service
> ist venue-agnostisch und feature-flag-gated, der Scanner bleibt rein
> (kein Netzwerk). Code-Map, CLI-Referenz und die Abweichungen vom Ticket
> stehen in [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) §0, §12, §13.
>
> **Nachtrag 2026-08-29 (v1.26.0 / v1.26.2):** Task 14 (Timeframe-Dimension
> im Historical Store, MDSYNC-001) ist mit **PR #40** implementiert
> (`timeframe` als Pflichtfeld, Primärschlüssel
> `instrumentId + timeframe + ts`, dry-run-first-Migration). Die Nacharbeit
> in **v1.26.2** ergänzt die Betriebs-Doku
> (`docs/MIGRATION_TIMEFRAME_FIELD.md`, empfohlener Neuaufbau statt
> Inline-Migration) und den Dry-Run-Default des Migrations-CLIs.
>
> Security-Spalte verweist auf die Kapitel in [SECURITY_AUDIT.md](SECURITY_AUDIT.md);
> die Anker `[S01]`…`[S12]` bezeichnen die jeweiligen Task-Kapitel.

## Task 10 im Detail (Operations Center)

**Quelle:** Arena-Session `01a04cc9` · Branch `arena/01a04cc9-ai-trading-firm`
· PR `feat(ops): vollständiges Operations Center — zehn Sektionen statt Phase-1-Hülle (task-10)`.

**Befund der Nachprüfung (Code vor diesem Stand):**

- `src/components/ops/OperationsCenterPanel.tsx` bezeichnete sich als
  „Phase-1-Hülle“ und erklärte den Tab zur leeren Hülle.
- `src/auth/ops.ts` lieferte sieben Module; Universe, Scanner, Portfolio, Cycle
  und Routing standen auf Status `stub`.
- `GET /api/ops` beschrieb sich selbst als „Operations-Center-Hülle“.
- `docs/ARENA_TASKS.md` wies Task 10 gleichzeitig als „Implementiert“ aus —
  die beanstandete Doc-Code-Diskrepanz.

**Umsetzung (Aggregation, kein zweites Backend):**

| Sektion | Quelle (bestand bereits) |
| --- | --- |
| Market Universe | `src/universe` (InstrumentRegistry) |
| Scanner | `src/scanner` (ScannerService, Trichter + Ranking) |
| Portfolio Analytics | `GET /api/firm` (Positionen, Equity) + `src/portfolio` |
| Research Operations | `src/cycle` (Runs, Daily/Weekly-Artefakte) |
| Broker Operations | `GET /api/brokers` (Registry, Capabilities, Health) |
| LLM Operations | `GET /api/routing` (MODEL_ROUTER) + Provider-Status |
| Agent Operations | `GET /api/firm` (Agenten, Missionen, Nachrichten) |
| Risk | `src/lib/riskGuard` + `src/lib/adaptiveRisk` + `src/live-gate` |
| Audit | `GET /api/firm/log` (audit_log) + Live-Gate-Hash-Kette |
| Help | `docs/help/*.help.json` + `src/lib/docsCatalog.ts` |

**Eigenschaften:**

- Zehn Sektionen, jede mit `status`, `asOf`, `metrics`, `items`, `note`/`error`
  und sichtbaren `sources`. Kein `stub` mehr im Zustandsraum
  (`ready | degraded | empty | locked | unavailable`).
- Fail-soft je Sektion: eine nicht erreichbare Quelle (z. B. Datenbank aus)
  macht **nur** ihre Sektion `unavailable` — das Cockpit bleibt lesbar.
- Keine neue Fachlogik, keine Mutation, keine Secrets im Payload.
- `GET /api/ops` bleibt read-only und ohne Token ladbar; Rolle und Live-Sperre
  stehen weiterhin in der Kopfzeile (Live-Lock bleibt hart `false`).

**Testbericht:** `tests/ops.api.test.ts`, `tests/opsSections.test.ts`
(Payload, Aggregation, Fehler-/Leer-/Ladezustand, Render) und
`tests/task10.architecture.test.ts` (keine Platzhalter-Terminologie, zehn
Sektionen, kein Schreibpfad im Aggregator).

---

## Task 11 im Detail (v1.19.0)

**Quelle:** Arena-Session `01a0498d` · Branch `arena/01a0498d-ai-trading-firm`
· PR `feat(live-gate): auditierte Live-Trading-State-Machine + Enforcement +
Kill-Switch (task-11) — aktiviert kein Live`.

- Transitionsmatrix: 81 Kombinationen → 8 erlaubt, 73 abgelehnt, **0 Durchlässe**.
- Enforcement-Matrix: 9 States × 16 Flag-Kombis × Suite × Control Plane → **0 falsche Allows**.
- Kill-Drill aus allen 9 Zuständen inkl. Failsafe-Datei.
- Audit-Hash-Kette erkennt Verändern/Einfügen/Entfernen/Truncation.
- `npm run security:live-gate`: 78 Tests grün, Coverage **95,81 % Zeilen** (Tor 95 %); Gesamt `npm test` **1065/1065**.
- **Live bleibt OFF** — keine State-File, Flags false, kein Suite-Stamp im Betrieb.

**Bekannte Follow-ups (LG-01…LG-04):** LG-01 echte 4-Augen-Token-Identität
(Task 12+); LG-02 Venue-Testnet-Anbindung; LG-03 Branch-Protection
(Required Check `security-live-gate`); LG-04 Coverage-Tor nur Zeilen.

## Task 12 im Detail (Dokumentation)

**Quelle:** Arena-Session `01a049f7` · Branch `arena/01a049f7-ai-trading-firm`
· PR `docs: vollständige, code-synchronisierte Dokumentation + Hilfe-Systematik (task-12)`.

**Lieferumfang:**

- 15/15 Zieldokumente in `docs/` vorhanden, alle mit **Status-Header**.
- Root-Docs neu: `README.md`, `INSTALL.md` (Env-Flag-Tabelle), `CHANGELOG.md`.
- Hilfe-Systematik: `docs/help/help.schema.json` (neu) + alle 9 `*.help.json`
  schema-valid (fehlende `risiko`-Ebene ergänzt).
- CI-Job `docs-validate` (`docs/ci/docs-validate.workflow.yml`, `scripts/docs-validate.ts`,
  npm-Skript `docs:validate`): Schema, Link-Check, Markdown-Lint, Secret-Scan,
  Konsistenz-Checks (Env-Flags / API-Routen / State-Enum).
- Audit-Report `docs/DOCS_SYNC_AUDIT.md`: 99 verifizierte Behauptungen,
  13 Diskrepanzen → 0 offen.
- Security-Kapitel Task 12 in `SECURITY_AUDIT.md`.

**Testbericht Task 12 (Doku-Task):**

- `npm run docs:validate` → **grün** (7 Checks, 9 Hilfe-Dateien).
- `npm run typecheck` → grün (siehe unten).
- Keine funktionalen Code-Änderungen (nur `package.json`-Skript + neue
  `scripts/docs-validate.ts`); bestehende Tests unverändert.

**Offene Punkte Task 12:** keine blockierenden; Nachpflege gemäß
„Wie Docs hier gepflegt werden“ (`ARCHITECTURE.md §13`).

## Task 13 im Detail (Typisierte Marktdaten-Fehler, v1.26.1)

**Quelle:** Arena-Session `01a04f91` · Branch
`arena/01a04f91-ai-trading-firm` ·
PR `fix(marketdata): stop swallowing fetch failures (mderr-006)`.

**Problem:** `getCandles()` mappte HTTP 429/5xx, DNS-Fehler, ungültige
Symbole, Schema-Abweichungen und TLS-Fehler alle auf `[]` — nicht von
„0 Kerzen vorhanden“ unterscheidbar, im Scanner als `min-candles` sichtbar,
ohne Alarmierung (P1, Observability-/Sicherheitsdefekt).

**Umsetzung:**

- `src/lib/marketDataErrors.ts`: `MarketDataFetchError`,
  `classifyMarketDataError()`, `MarketDataErrorReason` (11 Ursachen,
  retryable-Flags), redigiertes `toJSON()`.
- `src/lib/marketData.ts`: `getCandles()` wirft (stilles `?? []` entfernt);
  leere Venue-Antwort bleibt gültig; `getCandlesWithFallback()` als explizite
  Stale-Cache-API.
- `src/lib/telemetry.ts` + `src/lib/logger.ts`: Counter
  `market_data_fetch_failures_total{venue,timeframe,reason}` (ohne
  symbol-Label), strukturierte Events mit Redaction/512-Kappe.
- Scanner: `data-unavailable`-Rejection + Readiness `ERROR`; Sync-Fehler als
  Manifest (`src/marketdata/dataErrors.ts`), MicroExecutor-Warmstart sichtbar.
- Doku: `docs/OBSERVABILITY.md` (neu), `docs/MARKET_DATA_PIPELINE.md` Kap. 6–8,
  Changelogs; Version **1.26.1**.

**Nacharbeit v1.26.3 (PR #43):** Sync-Fehler werden bereits beim Abfangen
klassifiziert (`SyncError.reason`/`retryable`/`httpStatus`), das Fehler-Manifest
übernimmt nur echte Fetch-/Infrastrukturfehler, `classifyMarketDataError()`
erkennt JSON-Parse-Fehler als `SCHEMA_MISMATCH`, strukturierte Logs enthalten
den expliziten `[market-data] FETCH FAILED …`-Verweis, Analysten/Monitor
isolieren Fehler pro Symbol/Timeframe, und der Betreiber-Entscheidungsbaum
`docs/ERROR_HANDLING_MARKETDATA.md` ist neu. Doku: `MARKET_DATA_PIPELINE.md` §8,
`OBSERVABILITY.md`, Doku-Katalog, Changelogs.

**Testbericht:** `tests/marketDataErrors.test.ts`,
`tests/marketData.test.ts`, `src/marketdata/__tests__/sync*.test.ts`
(inkl. Integrationstest 429 im Mock-HTTP-Kline-Pfad),
Scanner-/MicroExecutor-Erweiterungen;
`npm run typecheck` und `npm run docs:validate` grün.

---

## Task 14 im Detail (Timeframe-Dimension im Historical Store, MDSYNC-001)

**Quelle:** Arena-Session `01a04f46` · Branch
`arena/01a04f46-ai-trading-firm` ·
PR `fix(history): persist candle timeframe and deduplicate bars` (#40).
**Nacharbeit:** v1.26.2 (Versionierung, Changelogs, Betriebs-Doku,
Dry-Run-Default des Migrations-CLIs).

**Problem (P1, Datenkorruption):** `HistoricalCandleEntry` besaß kein
`timeframe`-Feld. Sobald mehrere Periodizitäten desselben Instruments
persistiert wurden (`BITUNIX:BTCUSDT / 5m`, `/15m`, `/1h`), waren die Bars
im Store **nicht unterscheidbar** — der Loader hätte sie zu einer
Faktorreihe vermischt (EMA/Momentum/Volatilität mathematisch
bedeutungslos), ohne dass ein Test oder Filter Alarm schlägt. Zusätzlich
fehlte die deterministische Deduplizierung.

**Umsetzung (PR #40, v1.26.0):**

- `HistoricalCandleEntry.timeframe: SupportedTimeframe` (Pflicht), Zeilen mit
  `"v": 2`; Primärschlüssel `instrumentId + timeframe + ts`.
- `append(candles, instrumentId, provenance, timeframe, now)` (5-stellig,
  alte Signatur entfernt), `query({ instrumentId, timeframe, from?, to?,
  limit? })` mit Pflicht-Timeframe (Compile + Runtime-Guard).
- Dedup: jüngstes `fetchedAt` gewinnt; `maxBarsPerSeries` (Default 5000).
- Legacy-Zeilen werden als `LEGACY_UNKNOWN` markiert, gezählt und über
  `query()` nie ausgeliefert (einmalige Migrations-Warnung).
- `src/history/migration.ts` + `npm run history:migrate`: Backup `0600`,
  `--assume-timeframe` Pflicht (kein Raten), Dedup, Sortierung, Report,
  Verlust-Invariante, idempotent.
- Aufrufstellen migriert: Sync-Service, MarketDataManager (`1m`), ReplayFeed
  (`1h`), Scanner-Provider (`readAll()` mit Präferenz `1h → 4h → 30m → 15m
  → 5m`), Analytics-Port und Backtest-Step (`1h`). Der MicroExecutor nutzt
  den Store nicht.

**Nacharbeit (v1.26.2, dieser PR):**

- Neu **`docs/MIGRATION_TIMEFRAME_FIELD.md`** — Runbook für
  Produktionsumgebungen: Backup, Dry-Run, Anwenden, Validierung, Rollback,
  Exit-Codes; Entscheidungsmatrix **Neuaufbau (empfohlen) vs.
  Inline-Migration**.
- `docs/MARKET_DATA_PIPELINE.md` §5.3: empfohlener Migrationspfad
  (Neuaufbau via `npm run market-sync`, weil das Bitunix-Datenvolumen klein
  und public erreichbar ist — 150 Bars je Instrument und Timeframe).
- Migrations-CLI schreibt nur noch mit **`--apply`**; ohne das Flag läuft es
  als Dry-Run (kein Schreiben, kein Backup, Exit-Code 2) — damit ist der
  Security-Audit-Punkt „Dry-Run als Default“ erfüllt.
- Neue Doku im Katalog (`src/lib/docsCatalog.ts`, `docs/README.md`) und
  Version-Konsistenzprüfung in `npm run docs:validate`.

**Testbericht:** `tests/history/historicalStore.test.ts` (19),
`tests/history/migration.test.ts` (12), `tests/docsVersioning.test.ts` (neu,
Versionierung/Doku-Verlinkung); `npm run typecheck`, `npm run lint` und
`npm run docs:validate` grün.

---

## Task 15 im Detail (Zentrale Symbol-Normalisierung, SYM-007, v1.28.0)

**P1.** Das in der Registry gültige Instrument `KRAKEN:BTC/USD` wurde im
Laufzeit-/Regelpfad still verworfen, weil ~5 lokale Symbol-Regexe mit
abweichender Semantik (Universe, `marketData`, `ruleEngine`, Bitunix,
Portfolio-Parse) dasselbe Konzept unterschiedlich streng prüften.

- **Single Source of Truth:** `src/symbols/` (`normalize`, `venueProfiles`,
  `errors`) — `CanonicalSymbol`, `normalizeVenueSymbol()` /
  `tryNormalizeVenueSymbol()` / `isValidInstrumentId()`, deklarative
  Venue-Profile (u. a. Kraken-Alias `XBT↔BTC`), ReDoS-sichere Muster,
  NFKC + Zero-Width-Strip + Trim + Uppercase.
- **Rollout:** Alle Alt-Regexe ersetzt (`marketData`, `ruleEngine`,
  `universe/validation` als Re-Export, Bitunix-Adapter, `docs/`).
  **Rule-Engine-Grenzen unverändert** (nur LONG; Operatoren `lt, lte, gt,
  gte, eq, between, in`; Trend `eq, in`) — Ticket §3.3 per Diff geprüft.
- **Unbekannte Venue:** Abfragepfad = striktes Default-Profil + Warning
  (kein Wurf), Registrierungs-/Sync-Pfad = Wurf.
- **Migration:** `npm run symbols:normalize` (Dry-Run Default, `--apply`
  mit Backup, Rename-Report, idempotent, Exit-Codes 0/1/2) für Registry
  und `data/history/candles.ndjson`. Gegen den committed Seed-Store:
  0 Umbenennungen, 1 Hinweis (`PAPER:EURUSD=X`).
- **Normative Doku:** [`SYMBOLS.md`](SYMBOLS.md); Querverweise in
  `MARKET_UNIVERSE.md` (§4/§9), `HISTORY.md`, `MARKET_DATA_PIPELINE.md` (§11),
  README; Katalog-Eintrag in `src/lib/docsCatalog.ts`.

**Testbericht:** Golden `tests/symbols/normalize.test.ts` (21),
Property-Tests `normalize.property.test.ts` (7 — wirft nie, Idempotenz,
Kanon↔Nativ-Roundtrip, Injection nur innerhalb erlaubter Form, ReDoS),
Migration `idMigration.test.ts` (9 — Backup, Dry-Run schreibt nicht,
Idempotenz, Kollisionen ⇒ 0 Renames). Gesamtsuite **1317/1317 grün**,
`npm run lint`, `npm run typecheck`, `npm run docs:validate` grün.
Bereitschaftshaken für MDSYNC-001: Instrument-IDs ab jetzt kanonisch.

---

## Empfohlene Nachpflege (Backlog)

- Branch-Protection inkl. Required Checks `docs-validate` + `security-live-gate`
  durch Repo-Admin einrichten (LG-03).
- Geplante (Task NN) Features bei Merge in `docs/` von „Geplant“ auf
  „Implementiert“ stellen.

---

## Task 16 im Detail (Persistenter Marktdaten-Warmup + Sync-CLI, MDSYNC-001, v1.29.0)

**Quelle:** Arena-Session `01a05352` · Branch `arena/01a05352-ai-trading-firm`.

**Problem (P1, Produktkette).** `data/history/candles.ndjson` existierte, wurde
aber von keinem Prozess befüllt. `scanUniverse()` las `candles.length === 0`,
lehnte jedes Instrument mit `min-candles` ab und meldete das als Eignungsbefund
(`readiness: WARMING` existierte, wurde aber als „Markt ungeeignet“ gelesen).
Der Warmup passierte ausschließlich prozesslokal im MicroExecutor — nach jedem
Neustart verloren.

**Umsetzung.**

* **Sync als eigener, persistenter Schritt vor dem Scan:**
  `src/marketdata/sync.ts` (`MarketDataSyncService`) führt Discovery →
  Ticker/Orderbook-Enrichment → Candle-Backfill aus und schreibt
  `InstrumentRegistry` + `HistoricalStore`. Der Scanner bleibt unverändert rein
  (kein I/O, kein LLM) und liest ausschließlich, was auf Disk liegt.
* **Feature-Flags statt hartverdrahteter Venue:**
  `src/marketdata/registerAdapters.ts` ist die einzige Instanzierungsstelle;
  `MARKET_SYNC_ENABLED` (Kill-Switch) → `MARKET_SYNC_VENUES` (Allowlist) →
  `<VENUE>_ENABLED` (`BITUNIX_ENABLED`). Aus = gemeldeter Grund + Exit 2 mit
  Behebung, nie „0 Instrumente“ ohne Erklärung.
* **CLI:** `scripts/market-sync.ts` (`npm run market:sync`), Validierung vor
  dem ersten Request, `--dry-run` mit echtem Budget und temporären Senken,
  `--json`, `--no-manifest`, Exit-Codes 0/1/2; `run-scan --sync` vor dem Scan.
* **Betriebssichere Zahlen:** `SyncResult` ist deckungsgleich
  (`discovered = synced + skipped`), die Zählerzeilen sind exakt
  `formatSyncLog(result)`, ein Teilbackfill steht als `A/B bars` da (nie als
  „fertig“), `degraded` ist gesetzt, wenn auch nur ein isolierter Fehler auftrat.
* **Belastungsgrenzen:** Parallelität ≤ 8 innerhalb des Public-Token-Buckets
  (8 req/s), `candle-limit` ≥ `requiredWarmupCandles` (61) und ≤ 2000,
  Discovery-/Ticker-/Kerzen-Caps pro Response, Payload-Kappe 5 MiB am
  Transport ohne Retry.
* **Persistenz-I/O:** `HistoricalStore.appendSeries()` schreibt einen Lauf in
  einer Datei-Revision (vorher: eine Revision je Instrument × Timeframe).
  Idempotent über Prozessgrenzen — der zweite Lauf schreibt 0 neue Bars.
* **Status ohne Netz:** `npm run market:sync:status` (auch
  `market-sync:status`) liest die Warmup-Readiness über dieselbe Aggregation
  wie das Operations Center und ist per Exit-Code automatisierbar
  (0 = bereit, 1 = Warmup fehlt). Read-only: kein Request, kein Schreibpfad.

**Sicherheit (in dieser Session geprüft, nicht neu erfunden):** Public-only-Pfad
(kein `PrivateClient`, keine API-Key-Lektüre, 0 Credential-Header auf Public-
Routen — Fixture-Server zählt), Symbol-Allowlist vor URL-Bau (Log-Antwort ohne
Echo des Rohsymbols), Venue-/Meldungs-Sanitizer gegen Log-Injection
(`[url]`, 160 Zeichen, Kontrollzeichen entfernt), keine Pfad-Interpolation aus
Fremdinput, `/api/markets` bleibt GET-only.

**Testbericht:** 58 neue Tests — `test/marketdata/{spread:10,sync:21,security:12,
cli:12}.test.ts` und `test/integration/{warm-scanner:2,cli-sync-e2e:1}.test.ts`;
die drei bestehenden Suite-Dateien unter `src/marketdata/__tests__/` (30) auf das
neue `SyncResult` migriert; `tests/history/*` (31) gegen den geänderten
Schreibpfad unkorruptiert grün. Gesamtsuite **1389/1389**.
`npm run typecheck`, `npm run lint`, `npm run build`, `npm run docs:validate`
grün; Coverage-Gate `npm run test:coverage:marketsync` ≥ 90 % Linien.
Manueller Dry-Run gegen einen lokalen Mock der Bitunix-Public-Routen: 12
Instrumente, 4 Timeframes, **62 Requests** (1 `trading_pairs` + 1 `tickers` +
12 `depth` + 48 `kline`) und 0 Schreibzugriffe auf `data/`.
