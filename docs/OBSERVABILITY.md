# Observability — Marktdaten-Fehler, Firmen-Metriken, Alerts und Heartbeat

> **Status-Header:** **Implementiert** (MDERR-006; GAP-10 v1.45.0 ergänzt
> Firmen-Metriken, Auto-Circuit-Breaker, Alerting und Heartbeat; GAP-07
> v1.47.0 ergänzt die Datenqualitäts-Klassen §2.1) ·
> **2026-09-19** · Code-Version **1.47.0** · Module
> `src/lib/marketDataErrors.ts`, `src/lib/telemetry.ts`,
> `src/lib/alerts.ts`, `src/lib/circuitBreaker.ts`, `src/lib/heartbeat.ts`,
> `src/lib/logger.ts`, `src/marketdata/dataErrors.ts`,
> `src/marketdata/quality.ts`, `src/marketdata/aggregate.ts`

Dieses Dokument beschreibt, wie der Marktdaten-Pfad Fehler **sichtbar**
macht. Das ist die Antwort auf den P1-Defekt „stille leere Arrays“: `getCandles()`
bildete HTTP 429/5xx, DNS-Fehler, ungültige Symbole, Schema-Abweichungen und
TLS-Fehler alle auf `[]` ab — nicht unterscheidbar von „0 Kerzen vorhanden“,
im Scanner als `min-candles` sichtbar und ohne jede Alarmierung.

Die operative Entscheidung „Werfen vs. Cache vs. `DATA_UNAVAILABLE`“ ist im
[**ERROR_HANDLING_MARKETDATA.md**](ERROR_HANDLING_MARKETDATA.md)
(Entscheidungsbaum) dokumentiert. Die **Firma als Ganzes** (Equity, Drawdown,
Auto-Not-Halt, Alerts, Tick-Heartbeat) behandeln die Abschnitte 9–12; das
Runbook dazu steht in [OPERATIONS.md](OPERATIONS.md).

## 1. Grundsatz

> **Ein leeres Array bedeutet ausschließlich:** die Venue hat für dieses
> Symbol/Timeframe nachweislich keine Bars geliefert. **Niemals** „Abruf
> fehlgeschlagen“.

Jeder echte Abruf-Fehler erzeugt **drei** Beobachtungen gleichzeitig:

1. eine **Metrik** (`market_data_fetch_failures_total`, prozesslokal),
2. ein **strukturiertes Log** mit klassifizierter Ursache,
3. einen **typisierten Fehler** (`MarketDataFetchError`) für den Aufrufer.

## 2. Fehler-Taxonomie (`MarketDataErrorReason`)

| `reason` | Auslöser | `retryable` | Betriebsbedeutung |
| --- | --- | :---: | --- |
| `RATE_LIMITED` | HTTP 429 | **ja** | Request-Budget zu aggressiv → Drossel prüfen |
| `UPSTREAM_5XX` | HTTP 500/502/503 … | **ja** | Venue-Problem → Venue-Status prüfen |
| `UNAUTHORIZED` | HTTP 401/403 | nein | **Konfigurationsfehler**: Public-Pfad ruft Auth-Endpunkt auf → laut alarmiert (`critical`) |
| `NOT_FOUND` | HTTP 404 / unbekanntes Symbol | nein | Symbol nicht (mehr) handelbar |
| `INVALID_SYMBOL` | Symbolformat verletzt Whitelist | nein | Eingabe-/Config-Fehler |
| `SCHEMA_MISMATCH` | Response validiert nicht | nein | Venue-API hat sich geändert → Adapter anpassen |
| `TIMEOUT` | AbortError / Timeout-Timer | **ja** | Netz/Latenz |
| `NETWORK` | DNS, ECONNREFUSED, ECONNRESET … | **ja** | Netz/Infrastruktur |
| `TLS` | `ERR_TLS_CERT_ALTNAME_INVALID` … | nein | Zertifikat/Hostname → sofort prüfen (MitM/Veraltet) |
| `ABORTED` | expliziter Abbruch | nein | Aufrufer-Abbruch |
| `UNKNOWN` | alles andere | nein | Doku/Log analysieren |
| `QUALITY_GAP` | (GAP-07) fehlende Intervalle in der Serie | nein | Datenqualität: Lücke im Raster — Report prüfen |
| `QUALITY_OUTLIER` | (GAP-07) Wick/Körper > `MARKETDATA_OUTLIER_ATR_MULT` × Baseline | nein | Datenqualität: Ausreißer — bewusst großzügig, Flash-Moves bleiben |
| `QUALITY_INVALID` | (GAP-07) OHLC ≤ 0, `high < low`, close außerhalb `[low, high]` | nein | Datenqualität: inkonsistente Kerze — `strict` ⇒ `DATA_UNAVAILABLE` |
| `QUALITY_DUPLICATE` | (GAP-07) doppelter Zeitstempel | nein | Datenqualität: Duplikat im Raster |
| `QUALITY_CROSSCHECK` | (GAP-07) Zweitquellen-Abweichung > Toleranz (opt-in) | nein | Datenqualität: Quellen divergieren — Venue prüfen |

Die `QUALITY_*`-Klassen sind **keine Abruf-Fehler**: die Daten sind gelandet,
die Serie ist nur auffällig. Sie sind deshalb nie `retryable`, fließen nie in
den Fetch-Backoff und **nie** in das Fetch-Fehler-Manifest
(`data/market-data-errors.json`). Ihr Ausweis läuft über den
Qualitäts-Report (`data/marketdata/quality-report.json`), die
`[market-sync] quality:`-Logzeile und die Metrik
`market_data_quality_findings_total` (Abschnitt 2.1). Details:
[MARKET_DATA_PIPELINE.md](MARKET_DATA_PIPELINE.md) §14.

`classifyMarketDataError(err)` liest `httpStatus`/`status`/`statusCode`
(inkl. `BitunixApiError.httpStatus`), die `.cause`-Kette (undici kapselt) und —
für Fremd-Clients — bekannte Codes in Messages (`ENOTFOUND`, `ECONNREFUSED`,
`ERR_TLS_*`).

`MarketDataFetchError` trägt `venue`, `symbol`, `timeframe`, `reason`,
`retryable`, optional `httpStatus` und `cause`. Die Message sagt explizit:
**Infrastrukturfehler, KEIN „keine Historie vorhanden“ — der Scanner meldet
dafür `DATA_UNAVAILABLE`** (`buildMarketDataErrorMessage`).

### 2.1 Datenqualitäts-Ausweis (GAP-07, v1.47.0)

Qualitätsbefunde (`QUALITY_*`) sind Beobachtungen über **vorhandene** Daten —
kein Abruf-Fehler. Deshalb drei Ausweiskanäle, aber kein Fetch-Manifest:

| Kanal | Ort | Inhalt |
| --- | --- | --- |
| **Report je Instrument** | `data/marketdata/quality-report.json` (gitignored, atomar 0600, `resolveRuntimePath`) | Befunde + Zähler je Reihe (Instrument ⟂ Timeframe); vom Sync-CLI geschrieben (auch bei 0 Befunden) |
| **Log** | `[market-sync] quality: N Befund(e) (GAP …, OUTLIER …)` | nur bei Befunden, Zähler ohne Symbole |
| **Metrik** | `market_data_quality_findings_total{class=…}` | prozesslokal, in `prometheusMetrics()` exponiert; Label `class` ∈ {GAP, OUTLIER, INVALID, DUPLICATE, CROSSCHECK} (geschlossene Aufzählung — keine Kardinalität) |
| **Lesepfad (strict)** | `MARKETDATA_QUALITY_MODE=strict` | Instrumente mit `INVALID` ⇒ `DATA_UNAVAILABLE` (existierende Stale-Fallback-Kette, fail-closed); `log` (Default) = nur sichtbar machen |
| **Stale-Guard** | Sync-Status `data/market-sync-status.json` → `staleSeries`/`staleByTimeframe` | Zähler je Venue (keine Symbole), Schwellen `MARKETDATA_STALE_*_HOURS` |

**Redaction/Garantien:** Report-Felder sind stabile Codes (`instrumentId`,
Klasse, Zeitstempel, kurze Details) — keine Rohmeldungen, keine URLs, keine
Secrets. Die Historie-Datei wird vom Qualitäts-Layer **nie** berührt; die
Eingabeserie wird nie mutiert (Freeze-Tests in `test/marketdata/quality.test.ts`).
Kein Outlier-Filter entfernt Daten: Befund ≠ Löschung, ein realistischer
Flash-Move bleibt unterhalb der (bewusst großzügigen) 25×-Schwelle erhalten
(Grenzwert getestet).

### 2.2 Perpetual-Daten (RMA-P2-02, v1.54.0)

Fünf Counter, alle mit begrenzten Labels (kein Instrument-Identifier):

| Metrik | Labels | Bedeutung |
| --- | --- | --- |
| `perp_sync_runs_total` | `result` (`written`\|`replayed`\|`failed`), `mode` | Läufe je Ergebnis — `replayed` ist der Idempotenznachweis |
| `perp_sync_rows_total` | `kind`, `result` (`written`\|`duplicate`\|`rejected`) | Zeilen je Reihe und Schicksal |
| `perp_data_quality_findings_total` | `class` (`GAP`\|`OUTLIER`\|`INVALID`\|`DUPLICATE`\|`CROSSCHECK`\|`STALE`) | Befunde aus `validatePerpSeries` |
| `perp_data_revisions_total` | `kind` | abweichender Satz zum selben natürlichen Schlüssel (nicht überschrieben) |
| `perp_data_asof_queries_total` | `result` (Verfügbarkeit), `kind` | as-of-Lesungen inkl. `MISSING`/`STALE`/`UNSUPPORTED`/`UNAVAILABLE` |

Logs: `[perp]`/`[perp:warn]`/`[perp:error]`-Zeilen des CLI und des Services,
statt Zahlenlisten mit Symbolen. Ein Fremd-Fehler der Venue wird vor Log und
Manifest redigiert (URLs → `[url]`, `key=value`-Secrets → `[redacted]`,
einzeilig, ≤ 200 Zeichen). Artefakte: `data/perpdata/quality-report.json`
(Befund-Headline je Reihe) und `data/perpdata/derivatives.json`
(Konsumenten-Artefakt, 0600). Details: [PERPETUAL_DATA.md](PERPETUAL_DATA.md).

## 3. Metrik: `market_data_fetch_failures_total`

```text
market_data_fetch_failures_total{venue="binance",timeframe="15m",reason="RATE_LIMITED"} 3
```

- **Labels:** `venue`, `timeframe`, `reason` — bewusst **ohne `symbol`**
  (Kardinalitäts-/Speicher-DoS; 50 000 Instrumente × 11 Timeframes wären ein
  unbegrenzter Label-Raum). Das Symbol steht im strukturierten Log.
- **Prozesslokal** (`src/lib/telemetry.ts`, In-Memory): zählt App-Fehler
  (Analysten, Monitor, MicroExecutor). Kein prom-client nötig; die
  Exposition (`prometheusMetrics()`) steht für späteres Scraping bereit.
- **Cross-Prozess:** Der Sync-Job (`npm run market-sync`) schreibt zusätzlich
  ein persistiertes Manifest `data/market-data-errors.json`
  (`src/marketdata/dataErrors.ts`, gitignored) mit `instrumentId`, `reason`,
  `stage`, `timeframe`. Scanner und Operations Center lesen es.
- **Ops-Tooltip** (Scanner-Sektion): „Fehlgeschlagene Kerzenabrufe nach
  Ursache. Ein Anstieg bei RATE_LIMITED bedeutet, dass das Request-Budget zu
  aggressiv ist; UPSTREAM_5XX deutet auf ein Venue-Problem.“

## 4. Strukturierte Logs (JSON-Zeilen)

`src/lib/logger.ts` — `structuredLog(level, event, fields)`:

| Event | level | Felder |
| --- | --- | --- |
| `market_data_fetch_failed` | `error` | venue, symbol, timeframe, reason, httpStatus, retryable, message (`[market-data] FETCH FAILED …`, Verweis auf `ERROR_HANDLING_MARKETDATA.md`) |
| `market_data_unauthorized_public_endpoint` | `critical` | venue, symbol, timeframe, httpStatus |
| `market_data_fetch_retry` | `warn` | reason, httpStatus, attempt, maxAttempts, venue |
| `micro_executor_seed_fetch_failed` | `error` | symbol, timeframe, reason, retryable, httpStatus |
| `market_sync_fetch_failures` | `error` | venue, count, byStage (nur Zähler, keine Symbole) |

**Redaction/Garantien:**

- Jedes Feld läuft durch `redactSecrets` (secrets.ts) — keine API-Keys,
  Authorization-Header, Signaturen, Nonces.
- Fremdinhalte sind **einzeilig** (Steuerzeichen ersetzt) und auf
  **512 Zeichen** gekürzt — keine Log-Injection, keine Log-Flut.
- Volle URLs/Query-Strings erscheinen nie: `fetchJson` nennt nur den Host;
  der Sync redigiert URLs bereits in `sanitizeSyncErrorMessage`.
- `MarketDataFetchError.toJSON()` enthält **keinen** `cause`-Message/Stack —
  nur `{ name, code }`. HTTP-Antworten (z. B. Backtest-Route → 503) erhalten
  ausschließlich diese redigierte Serialisierung.

## 5. Bewusster Cache-Fallback: `getCandlesWithFallback`

```ts
const r = await getCandlesWithFallback("SPY", "1h", 120);
// r = { candles, source: "live" | "cache", stale, ageMs, error? }
```

- Nur Aufrufer, die degradierten Betrieb **bewusst** erlauben (z. B.
  UI-Preview), nutzen diese API. **Scanner-/Executor-Pfad nutzt sie nicht.**
- `stale: true` + `ageMs` macht veraltete Daten explizit; der auslösende
  `MarketDataFetchError` bleibt im Ergebnis (`error`) sichtbar.
- **Ohne Cache-Eintrag wird geworfen** — niemals ein stilles `[]`.

## 6. Scanner-Integration

- Sync-Fehler → Manifest → `dataErrors: Map<instrumentId, reason>` →
  `assessDataReadiness()` → **`ScannerReadiness.ERROR`** (Infrastruktur
  schlägt Fachlogik).
- Betroffene Instrumente werden mit **`data-unavailable`** abgelehnt
  (`dataQuality: true`) — **nie** mit `min-candles`. `min-candles` bleibt die
  behebbare Warnung „Historie fehlt“ (`WARMING`).
- CLI: `npm run scan -- --sync-first` läuft auch bei Sync-Fehlern weiter,
  schreibt das Manifest, meldet Readiness `ERROR` und beendet mit Exit-Code 1.

## 7. Retry-Budget

- `MARKET_DATA_FETCH_ATTEMPTS = 2` (1 Erstversuch + 1 Retry),
  `MARKET_DATA_RETRY_BACKOFF_MS = 250 ms × Versuch`.
- Nur `retryable`-Ursachen werden wiederholt; `UNAUTHORIZED`, `NOT_FOUND`,
  `INVALID_SYMBOL`, `SCHEMA_MISMATCH`, `TLS` werden sofort geworfen.
- Getestet (`tests/marketData.test.ts`): begrenzte Versuche, Erfolg nach
  Backoff, kein Retry bei 404.

## 8. Sicherheits-Audit (MDERR-006)

- [x] **Redaction:** weder Message, `toJSON()`, Log noch Metrik enthalten
  API-Keys, Authorization-Header, Signaturen, Nonces oder vollständige URLs.
  Dedizierter Test mit Secret-Marker im gefakten Upstream-Fehler.
- [x] `cause` wird nicht ungefiltert an HTTP-Antwort/UI durchgereicht
  (kein Stacktrace an Clients; `toJSON` nur `{ name, code }`).
- [x] **Metrik-Kardinalität:** `symbol` ist kein Label.
- [x] Fehlerpfad erzeugt keine unbegrenzten Retries (Budget + Backoff
  getestet).
- [x] Kein Log-Injection: mehrzeilige Fremdinhalte werden einzeilig
  gemacht und auf 512 Zeichen gekürzt.
- [x] `UNAUTHORIZED` im Public-Pfad wird als Konfigurationsfehler laut
  alarmiert (`critical`-Event).

## 9. Firmen-Metriken in `prometheusMetrics()`

Seit **GAP-10 (v1.45.0)** liefert `prometheusMetrics()` (jetzt `async`) neben
den Marktdaten-/Audit-Countern die Kennzahlen der **Firma** — gelesen
ausschließlich aus **bestehenden Stores** (Paper-Ledger, PostgreSQL,
In-Memory-Counter der Routing-/Order-Pfade), nicht aus einer zweiten
Messschleife:

| Metrik | Typ | Quelle | Bedeutung |
| --- | --- | --- | --- |
| `firm_equity` | Gauge | Paper-Ledger (Fallback: jüngster `equity_snapshots`-Eintrag) | Kontostand (mark-to-market) |
| `firm_drawdown_pct` | Gauge | Paper-Ledger (`drawdownPct`, dieselbe Rechnung wie der Brecher) | Drawdown gegenüber Startkapital (`0.12` = 12 %) |
| `firm_open_positions` | Gauge | Paper-Ledger | offene Positionen |
| `firm_realized_pnl_today` | Gauge | `realizedPnlToday()` (Berliner Tag) | realisiertes Tages-P&L |
| `firm_metric_source{source}` | Gauge | — | Quelle des Zustands (`paper-broker` = 1, sonst `db-snapshot`) |
| `firm_order_fills_total{kind,reason}` | Counter | Order-Pfad (`src/lib/broker.ts`) | Fills: `kind` = `OPEN`/`CLOSE`, `reason` = `ORDER`/`ORDER_PARTIAL` bzw. der Exit-Grund (`STOP_LOSS`, `TAKE_PROFIT`, `TRAILING_STOP`, `TIME_STOP`, `SIGNAL_DECAY`, …) |
| `signal_decay_evaluations_total{result,mode,strategy_class}` | Counter | Signal-Decay (`src/lib/signalDecayRuntime.ts`) | Bewertungen. Labels nur Code-Konstanten, keine Positions-IDs. |
| `signal_decay_events_total{result,mode}` | Counter | Signal-Decay | `written` / `duplicate` / `conflict` / `failed`. |
| `firm_order_rejects_total{reason}` | Counter | Ablehnungs-Funnel (`reject()`) | Rejects je Grund-**Klasse** (`INSUFFICIENT_CASH`, `KILL_SWITCH_ARMED`, `GUARDRAIL`, …) |
| `llm_calls_total{provider,outcome}` | Counter | Routing-Schicht (`src/routing/adapter.ts`) | LLM-Aufrufe je Provider; `outcome` = `ok`/`error`/`fallback` |
| `llm_latency_ms_sum{provider}` | Counter | Routing-Schicht (Latenz fällt dort ohnehin an) | Summe der Latenzen; Mittelwert = `llm_latency_ms_sum / llm_calls_total{outcome="ok"}` |
| `backtest_run_persist_total{result,reason}` | Counter | Backtest-Persistenz (`persistBacktestRun`, RMA-P1-04) | Walk-Forward-Runs mit Trade-Ledger: `result` = `created`/`replayed`/`failed`; `reason` = `ok` bzw. Fehlercode-Klasse (`ledger:reconciliation-mismatch`, `ledger:idempotency-conflict`, `persist:db-error`, …) — nie Run-IDs oder Symbole |

**Kardinalitäts- und Secret-Regel** (wie beim Marktdaten-Counter): Labels sind
ausschließlich **klassifizierte Codes** — `metricLabel()` verwirft alles, was
nicht dem konservativen Zeichensatz entspricht, und `classifyRejectReason()`
schneidet Rohgründe wie `POSITION_ALREADY_OPEN:SOL (kein Nachkauf erlaubt)` auf
die Code-Klasse ab. Symbole, Beträge, URLs oder Tokens erscheinen nie in einem
Label; der vollständige Grund bleibt im strukturierten Log.

**Client-Bundle-Grenze (Build-relevant):** `telemetry.ts` liegt über
`marketData.ts` → `workshop.ts` im Import-Graph der **Client**-Komponenten
und bleibt deshalb **DB-frei** (kein `@/db`/`pg`). Den Ledger-/DB-Zugriff
(Ledger zuerst, sonst jüngster `equity_snapshots`-Eintrag) übernimmt
`src/lib/firmState.ts` — ein **server-only** Modul, das sich beim Import als
Leser registriert (`setFirmMetricStateReader`). Ohne dieses Modul nutzt
`prometheusMetrics()` den prozesslokalen RAM-Ledger und markiert sonst
`degraded`; ein `@/db`-Import in `telemetry.ts` brach den Produktions-Build
mit „Module not found: Can't resolve 'tls'“ (Node-Builtins im Browser).

**Degradierter Betrieb (verbindlich):** Ist der Firmenzustand nicht lesbar
(DB weg, Ledger in diesem Prozess noch nicht hydratisiert), werden die
betroffenen Metriken **weggelassen** und mit einem
`# HELP firm_equity … degraded: …`-Kommentar markiert — kein erfundener
`0`-Wert (0 wäre eine falsche Aussage über den Kontostand), kein Throw, kein
Hänger. `prometheusMetrics()` ist damit auch bei komplettem DB-Ausfall
aufrufbar.

> **Offener Punkt (bewusste Abgrenzung):** Es gibt weiterhin **keinen
> HTTP-Scrape-Endpoint**; die Exposition ist über `prometheusMetrics()`
> aufrufbar (z. B. aus einem eigenen, authentifizierten Scraper). Ein
> `/api/metrics` wäre wegen der enthaltenen Kontodaten ein sensibler Read
> (`firm.read`) und ist als eigener Schritt dokumentiert — siehe
> `docs/audits/2026-09-18-feature-gap/remediation/TRACKING.md` (Spalte
> „Notizen“).

## 10. Auto-Circuit-Breaker (D2)

Der Kill-Switch war bis v1.44.0 rein manuell: die Risiko-Grenzen blockierten
nur **neue** Orders, offene Positionen liefen bei einem Bug weiter. Seit
**v1.45.0** prüft der Monitor-Tick **nach der Equity-Berechnung** drei
Auslöser und nutzt den **bestehenden Kill-Switch-Pfad**:

| Auslöser | Bedingung | Metrik im Grund |
| --- | --- | --- |
| Drawdown | `drawdownPct >= maxEquityDrawdownPct` | `drawdown` |
| Tagesverlust | Tagesverlust ≥ `dailyLossLimitPct` (Anteil des Startkapitals) | `dailyLoss` |
| Verlustserie | `RISK_MAX_CONSECUTIVE_LOSSES` Verlust-Closes in Folge (Default 5, Bounds [2, 50]) | `consecutiveLosses` |

Es gewinnt der **erste** zutreffende Auslöser in dieser Reihenfolge
(Eingriffstiefe). Aktion je Auslösung:

1. `killSwitch.pull(reason)` — die in-memory Sperre (jede Order läuft dagegen),
2. Zeile in `kill_switches` (`triggered_by = AUTO_CIRCUIT_BREAKER`, best effort),
3. **Audit** `KILL_SWITCH` (CRITICAL, Security-Klasse) mit fixiertem
   Auslösewert: `reason`, `trigger`, `metric`, `value`, `limit`, `triggeredAt`,
   `drawdownPct`, `dailyLossPct`, `consecutiveLosses` — eine Lücke wird gemeldet
   (Missed-Audit-Zähler), der Engage selbst nie durch einen Auditfehler
   blockiert (die sichere Richtung zu verweigern wäre gefährlicher),
4. **Alert** `circuit-breaker:<metrik>` (severity `critical`) über den
   Alert-Adapter (Abschnitt 11).

**Maschinenlesbarer Grund** (stabil, im Audit fixiert):

```text
auto-circuit-breaker:<metrik>:<wert>
auto-circuit-breaker:drawdown:0.1834      # Dezimalanteil, 4 Nachkommastellen
auto-circuit-breaker:dailyLoss:0.0621
auto-circuit-breaker:consecutiveLosses:5  # ganze Zahl
```

**Latching (Flatter-Schutz):** Einmal ENGAGE bleibt ENGAGE. Weitere Ticks
ändern nichts — kein zweites Engage, kein zweiter Audit, kein zweiter Alert,
keine Hysterese. Der Latch fällt ausschließlich, wenn der Not-Halt
**manuell** entschärft wurde (siehe unten); danach darf der Brecher erneut
greifen.

**Re-Arm-Politik (unverändert manuell):** Es gibt **keine Auto-Re-Arm-Logik**.
Der Weg zurück ist ausschließlich der bestehende Disarm-Pfad
(`POST /api/firm/kill` mit `{ arm: false }`): Permission `live.gate` (Admin),
CSRF-Header und ein kurzlebiger **single-use Challenge-Nonce** aus
`GET /api/firm/kill/challenge` (≤ 60 s). Jeder Disarm wird mit `stage=PRECHECK`
und `stage=APPLIED` auditiert und ist fail-closed (ohne Auditbeleg kein
Disarm).

**Verhaltensänderung:** `AUTO_CIRCUIT_BREAKER` ist per Default **an** —
existierende Installationen erhalten damit erstmals einen automatischen
Not-Halt bei Grenzbruch. Der Tagesverlust-Trigger existierte zuvor bereits im
Monitor, jetzt mit einheitlichem Grund/Audit/Alert und Latching; „aus“ ist ein
bewusster Betriebsentscheid (z. B. Fehlersuche) und steht im CHANGELOG.

## 11. Alert-Adapter (`src/lib/alerts.ts`)

`AlertSink { send(alert: { code, severity, message, meta, at }) }` mit drei
Implementierungen:

| Senke | Verhalten |
| --- | --- |
| `LogAlertSink` | strukturiertes JSON-Log (`event: "alert"`, Muster `logger.ts`): redigiert, einzeilig, ≤ 512 Zeichen je Feld |
| `FileAlertSink` | append-only NDJSON, Default `data/alerts.ndjson` über `resolveRuntimePath()` (Modus 0600) — CLI und Server sehen dieselbe Datei |
| `WebhookAlertSink` | **optional, Default aus**: URL ausschließlich aus dem verschlüsselten Secret-Store (`ALERT_WEBHOOK_URL_SECRET_NAME`), Timeout 5 s; die URL ist selbst ein Credential und erscheint nie in Logs oder Fehlermeldungen |

**Debounce (Alert-Fatigue-Schutz):** Ein identischer `alert.code` wird
höchstens einmal pro `ALERT_DEBOUNCE_MINUTES` (Default 30, Bounds [1, 1440])
versendet. Unterdrückte Alarme werden gezählt und beim nächsten Versand als
`meta.suppressedSinceLast` ausgewiesen — der Operator sieht „2 weitere
identische Alarme im Fenster“ statt zwei Zeilen Rauschen. Ein Fehler einer
Senke bricht nichts ab: `AlertDispatcher.emit()` sammelt Fehler, loggt sie und
wirft nie (Alarmierung ist Beobachtbarkeit, kein Handelspfad).

## 12. Heartbeat & Watchdog (D4)

`/api/health` (antwortet konstruktionsbedingt immer HTTP 200) meldet
zusätzlich:

| Feld | Bedeutung |
| --- | --- |
| `monitorLastTickAt` | ISO-Zeitpunkt des letzten Monitor-Ticks (`null` = noch keiner) |
| `monitorAgeMs` | Alter in ms (`null` = kein Tick bekannt) |
| `stale` | `true`, wenn Alter > `HEALTH_STALE_AFTER_MS` **oder** noch nie ein Tick lief |
| `staleAfterMs` | wirksame Schwelle (Default 300000 ms = 5 min, Bounds [30000, 3600000]) |

Quelle ist der RAM-Heartbeat des Ticks (`state.monitorLastTickAt`) — das Signal
ist absichtlich **DB-frei** lesbar: gerade bei einem Datenbank-Ausfall muss
erkennbar bleiben, ob der Scheduler noch tickt. Die Schwelle selbst ist
gesund (`stale` erst bei echtem Überschreiten); ein frisch gestarteter Prozess
ist bis zum ersten Tick `stale: true` (fail-loud).

**`npm run watchdog`** (`scripts/watchdog.ts`) ist der alarm-first Gegenpart:
ein Lauf, ein Alarm, kein Daemon, **kein Auto-Restart**. Er prüft
`/api/health` (Default `http://127.0.0.1:$PORT/api/health`, überschreibbar per
`--url=`/`WATCHDOG_HEALTH_URL`) und meldet über den Alert-Adapter:

| Code | Ursache |
| --- | --- |
| `heartbeat-stale` | `stale: true` (Tick überfällig oder nie gelaufen) |
| `heartbeat-health-unreachable` | `/api/health` nicht erreichbar oder HTTP ≠ 200 |
| `heartbeat-health-unreadable` | Antwort ist kein lesbares JSON |

Exit-Codes: `0` gesund · `1` Alarm · `2` Bedienfehler. Der Aufruf gehört in
einen systemd-Timer/Cron (z. B. alle 5 Minuten); der Debounce verhindert, dass
ein andauernder Ausfall die Alert-Datei flutet. Für den Sonderfall „Prüfung im
eigenen Prozess“ gibt es `--source=inprocess` (liest `lastTickAt()` direkt —
ein separater Prozess hat seinen eigenen RAM-Heartbeat und muss HTTP nutzen).
