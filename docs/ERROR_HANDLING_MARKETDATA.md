# Fehlerbehandlung Marktdaten — Entscheidungsbaum (MDERR-006)

> **Status-Header:** Implementiert (MDERR-006, Nacharbeit) · **2026-08-30** ·
> Code-Version **1.26.3** · Module `src/lib/marketDataErrors.ts`,
> `src/lib/marketData.ts`, `src/marketdata/sync.ts`,
> `src/marketdata/dataErrors.ts`, `src/lib/telemetry.ts`

Dieses Dokument beantwortet die zentrale Betriebsfrage des Marktdaten-Pfads:

> **Wann wird ein Fehler geworfen? Wann darf ein Cache verwendet werden?
> Wann wird `DATA_UNAVAILABLE` zurückgegeben?**

Kurzregel, bevor irgendein Detail gelesen wird:

```
┌──────────────────────────────────────────────────────────────┐
│  Venue-Antwort leer ([])  →  KERZEN, KEIN FEHLER            │
│  Netzwerk/API/TLS/Schema  →  MarketDataFetchError WERFEN    │
│  Stale-Cache gewollt      →  getCandlesWithFallback()       │
│                            (explizit, stale markiert)        │
│  Scanner/Sync-Aufrufer    →  DATA_UNAVAILABLE / Readiness    │
│                               ERROR, NIE min-candles         │
└──────────────────────────────────────────────────────────────┘
```

Der Grundsatz ist bewusst streng: **Ein leeres Array ist ausschließlich die
nachweisliche Venue-Antwort „keine Bars für dieses Symbol/Timeframe“.** Es ist
niemals „Abruf fehlgeschlagen“. Andernfalls wären HTTP 429, HTTP 500, DNS-,
TLS- und Schema-Fehler im Scanner nicht von „0 Kerzen vorhanden“
unterscheidbar und würden als `min-candles`-Ablehnung erscheinen.

---

## 1. Fehler-Taxonomie (`MarketDataErrorReason`)

Die tatsächlich implementierte Taxonomie ist bewusst feiner als die
generischen Klassen des Tickets. Die Zuordnung zu den gewünschten
Oberklassen:

| Implementiert (`reason`) | Ticket-Oberklasse | Auslöser | `retryable` |
| --- | --- | --- | :---: |
| `RATE_LIMITED` | `RATE_LIMITED` → `SERVER_ERROR` | HTTP 429, Venue-Limit (`code=10001`) | **ja** |
| `UPSTREAM_5XX` | `SERVER_ERROR` | HTTP 5xx (`500/502/503/…`) | **ja** |
| `UNAUTHORIZED` | `SERVER_ERROR` / Konfiguration | HTTP 401/403 im Public-Pfad | nein |
| `NOT_FOUND` | `INVALID_SYMBOL` / unbekanntes Symbol | HTTP 404/410, Yahoo `chart.error` | nein |
| `INVALID_SYMBOL` | `INVALID_SYMBOL` | Symbolformat verletzt die Whitelist | nein |
| `SCHEMA_MISMATCH` | `SCHEMA_ERROR` | JSON-Parse, unerwartetes Response-Schema, Zod | nein |
| `TIMEOUT` | `NETWORK_ERROR` | Abort/Timeout-Timer | **ja** |
| `NETWORK` | `NETWORK_ERROR` | `ENOTFOUND`, `ECONNREFUSED`, `ECONNRESET`, `EAI_AGAIN` | **ja** |
| `TLS` | `TLS_ERROR` | `ERR_TLS_*`, Zertifikat/Hostname | nein |
| `ABORTED` | `NETWORK_ERROR` / Abbruch | expliziter Abbruch (nicht Timeout) | nein |
| `UNKNOWN` | `UNKNOWN` | alles andere | nein |

`classifyMarketDataError(err)` liest dabei HTTP-Status (inkl.
`BitunixApiError.httpStatus`), die `.cause`-Kette (undici), bekannte
Node-Codes in Messages und JSON-Parse-Signaturen. Die Klassifikation ist
**nicht nur kosmetisch** — sie entscheidet, ob ein Fehler als transient
(Retry sinnvoll) oder permanent (Instrument-Konfigurationsfehler) behandelt
wird.

---

## 2. Entscheidungsbaum: Wann wird was getan?

```
Hat die Venue eine GÜLTIGE Antwort geliefert?
├── JA: Sind Bars vorhanden?
│   ├── JA  → Kerzen cachen und zurückgeben (source „live“).
│   └── NEIN→ [] cachen und zurückgeben. DAS IST KEIN FEHLER.
│              („keine Bars“ = DATA_UNAVAILABLE? Nein — nur „Min-Candles“-
│               WARNUNG, Readiness WARMING, behebbar per market-sync.)
└── NEIN (Fetch/HTTP/Netz/TLS/Schema):  → MarketDataFetchError WERFEN
    │
    ├── Darf der Aufrufer bewusst degradieren?
    │   ├── NEIN  → Exception weiterreichen. Der Aufrufer entscheidet
    │   │           DATA_UNAVAILABLE / Abbruch / Readiness ERROR.
    │   └── JA   → getCandlesWithFallback():
    │               ├── Frischer/kein Cache      → Exception.
    │               └── Stale-Cache vorhanden    → { candles, source:"cache",
    │               stale:true, ageMs, error } MIT Log:
    │               „using stale cache due to fetch error: <reason>“.
    │               Der Fehler bleibt im Ergebnis (error) sichtbar.
    │
    └── Ist der Fehler transient (RATE_LIMITED/UPSTREAM_5XX/TIMEOUT/NETWORK)?
        → Netzlauf darf 1× mit Backoff (250 ms) wiederholen.
          KEIN unbegrenzter Retry. 429 → Token-Bucket / Backoff greift.
          systematisches Rate-Limiting darf keinen Retry-Sturm auslösen.
```

### Entscheidungen im Detail

| Situation | Verhalten in `getCandles()` | Verhalten im Aufrufer |
| --- | --- | --- |
| Venue liefert `[]` | `[]` **cachen und zurückgeben** | `min-candles`/`WARMING` (behebbar, kein Fehler) |
| HTTP 429 | `MarketDataFetchError` werfen, Metrik + Log | Sync: `SyncResult.errors`, Instrument isoliert, Lauf weiter; Scanner: `data-unavailable`, Readiness `ERROR` |
| HTTP 5xx | `MarketDataFetchError` werfen | wie oben |
| DNS/`ECONNREFUSED` | `MarketDataFetchError` werfen | wie oben |
| TLS | `MarketDataFetchError` werfen | nicht-retryable: sofort prüfen (Zertifikat/Deployment) |
| JSON-Parse / Schema | `MarketDataFetchError` (`SCHEMA_MISMATCH`) | Venue-API hat sich geändert → Adapter anpassen |
| Ungültiges Symbol | `MarketDataFetchError` (`INVALID_SYMBOL`) | Instrument-Konfigurationsfehler → Registry prüfen |
| Cache vorhanden + Fehler | `getCandles()` wirft IMMER | nur UI/Preview über `getCandlesWithFallback()` |

---

## 3. Behandlung im Sync-Service (`MarketDataSyncService`)

1. **Pro Instrument isoliert:** Fehler landen in `SyncResult.errors`
   (`stage`, `instrumentId`, `symbol`, `timeframe`, `message`, **`reason`**,
   `retryable`, `httpStatus`). Ein einzelner 429/5xx/Netz-Fehler bricht den
   Sync **nicht** global ab — die übrigen Instrumente/Timeframes laufen
   weiter.
2. **Klassifikation beim Abfangen:** `MarketDataSyncService` klassifiziert
   das Fehlerobjekt direkt (`BitunixApiError.httpStatus`), damit die Ursache
   auch nach Serialisierung erhalten bleibt. `SyncError.reason` ist die
   Quelle der Wahrheit für `data/market-data-errors.json`.
3. **Manifest:** `saveMarketDataErrors()` persistiert nur echte
   Fetch-/Infrastrukturfehler (`reason` gesetzt, `stage != "upsert"`).
   Datenqualitäts-Warnungen ohne Fehlerobjekt werden bewusst **nicht** in
   das Manifest aufgenommen und lösen beim Scanner kein `data-unavailable`
   aus.
4. **Zähler-Log:** `market_sync_fetch_failures` zählt nur aggregiert
   (`venue`, `count`, `byStage`) — keine Symbole, keine URLs, keine Secrets.

---

## 4. Behandlung im Scanner / Operations Center

| Klasse | Sync/Manifest | Scanner-Readiness | `min-candles`? | Operations Center |
| --- | --- | --- | :---: | --- |
| `RATE_LIMITED` | Fehler isoliert, Manifest `RATE_LIMITED` | **ERROR** | nein | „Request-Budget zu aggressiv; Token-Bucket/Backoff prüfen“ |
| `UPSTREAM_5XX` | Fehler isoliert, Manifest `UPSTREAM_5XX` | **ERROR** | nein | „Venue-Problem; Venue-Status prüfen“ |
| `NETWORK` / `TIMEOUT` | Fehler isoliert | **ERROR** | nein | „Netz/Latenz/Proxy“ |
| `TLS` | Fehler isoliert | **ERROR** | nein | „Zertifikat/Hostname; Deployment prüfen (MitM?)“ |
| `SCHEMA_MISMATCH` | Fehler isoliert | **ERROR** | nein | „Venue-API geändert; Adapter/Normalisierung anpassen“ |
| `INVALID_SYMBOL` / `NOT_FOUND` | Fehler isoliert | **ERROR** | nein | „Instrument-Konfiguration; aus Registry prüfen/entfernen“ |
| `UNKNOWN` | Fehler isoliert | **ERROR** | nein | „Log/Doku analysieren“ |

Wichtig: Der Scanner verwandelt diese Zustände **niemals** in `min-candles`.
Betroffene Instrumente werden mit `data-unavailable` abgelehnt
(`dataQuality: true`) und die Readiness wird `ERROR`. Das ist der Unterschied
zwischen „Infrastruktur kaputt“ und „Historie fehlt“ (behebbar, `WARMING`).

---

## 5. Logging & Telemetrie

- **Strukturiertes Log:** `market_data_fetch_failed` enthält
  `venue`, `symbol`, `timeframe`, `reason`, `httpStatus`, `retryable` und ein
  explizites `message`-Feld:
  `[market-data] FETCH FAILED venue=… symbol=… timeframe=… reason=… — this is
  an infrastructure/API error, NOT an indication of missing market history.
  See docs/ERROR_HANDLING_MARKETDATA.md`.
- **Metrik:** `market_data_fetch_failures_total{venue,timeframe,reason}`.
  `symbol` ist bewusst **kein** Label (Kardinalität/Speicher-DoS bei 50 k
  Instrumenten × 11 Timeframes); das Symbol steht im Log.
- **Stale-Cache-Log:** expliziter Event `market_data_cache_fallback_used` mit
  `ageMs` und `reason`.

### Sicherheits-Audit

- `cause: unknown` wird vor Log/JSON **sanitized**: `toJSON()` enthält nur
  `{ name, code }`, keinen Stacktrace, keine Message, keine Header.
- Log-Felder laufen durch `redactSecrets`, Einzeilen-Normalisierung und
  512-Zeichen-Kappe.
- Volle URLs/Query-Strings werden nie geloggt; `fetchJson` nennt nur den Host.
- `SyncError.message` läuft durch `sanitizeSyncErrorMessage` (URLs/Secrets
  redigiert).
- 429 → begrenzter Retry + Token-Bucket/Backoff; kein Retry-Sturm bei
  systematischem Rate-Limiting.
