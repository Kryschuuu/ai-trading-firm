# Observability — Marktdaten-Fehler, Metriken und strukturierte Logs

> **Status-Header:** **Implementiert** (MDERR-006) · **2026-08-29** ·
> Code-Version **1.26.1** · Module `src/lib/marketDataErrors.ts`,
> `src/lib/telemetry.ts`, `src/lib/logger.ts`,
> `src/marketdata/dataErrors.ts`

Dieses Dokument beschreibt, wie der Marktdaten-Pfad Fehler **sichtbar**
macht. Das ist die Antwort auf den P1-Defekt „stille leere Arrays“: `getCandles()`
bildete HTTP 429/5xx, DNS-Fehler, ungültige Symbole, Schema-Abweichungen und
TLS-Fehler alle auf `[]` ab — nicht unterscheidbar von „0 Kerzen vorhanden“,
im Scanner als `min-candles` sichtbar und ohne jede Alarmierung.

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

`classifyMarketDataError(err)` liest `httpStatus`/`status`/`statusCode`
(inkl. `BitunixApiError.httpStatus`), die `.cause`-Kette (undici kapselt) und —
für Fremd-Clients — bekannte Codes in Messages (`ENOTFOUND`, `ECONNREFUSED`,
`ERR_TLS_*`).

`MarketDataFetchError` trägt `venue`, `symbol`, `timeframe`, `reason`,
`retryable`, optional `httpStatus` und `cause`. Die Message sagt explizit:
**Infrastrukturfehler, KEIN „keine Historie vorhanden“ — der Scanner meldet
dafür `DATA_UNAVAILABLE`** (`buildMarketDataErrorMessage`).

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
| `market_data_fetch_failed` | `error` | venue, symbol, timeframe, reason, httpStatus, retryable |
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
