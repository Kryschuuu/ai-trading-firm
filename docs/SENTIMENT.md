# Kalibrierbare strukturierte Sentiment-Outputs (RMA-P2-05)

## 1. Übersicht und Motivation

Finanznachrichten und Marktkommentare wurden im News-Analysten (`NEWS_ANALYST`, Hubble)
ursprünglich nur als grobe Freitext- bzw. Dreistufen-Einschätzung (`BULLISH`, `BEARISH`,
`NEUTRAL`) mit einer unkalibrierten Konfidenzzahl erfasst. Diese Form wies wesentliche
Defizite für einen quantitativen Handelsprozess auf:

1. **Fehlende Zeit- und Horizontsemantik:** Es war nicht definiert, für welchen
   Zeithorizont (z. B. 4h, 24h oder 72h) eine Einschätzung Gültigkeit besaß.
2. **Schein-Neutralität bei Datenmangel:** Fehlende Nachrichten wurden still als
   neutrales 0.5 bzw. `NEUTRAL` mit Konfidenz 0 verbucht. Datenmangel und ausgeglichene
   Informationslage waren ununterscheidbar.
3. **Syndikationsverzerrung:** Dieselbe Agenturmeldung über mehrere RSS-Feeds
   (z. B. CoinDesk, Cointelegraph, Finviz) blähte die Quellenanzahl künstlich auf.
4. **Fehlende Outcome-Kopplung:** Sentiment-Outputs konnten nicht ohne Heuristik
   über Proper Scoring Rules (Brier Score, Log-Loss aus P3.1) kalibriert werden.

Mit RMA-P2-05 (v1.64.0) wird Sentiment zu einem strikt validierten **Forecast-Envelope**
(`StructuredSentimentForecast`) mit deterministischer Idempotenz, Syndikationsschutz,
echter Enthaltungssemantik (`ABSTAIN`) und Point-in-Time-Garantien ausgebaut.

## 2. Kernsemantik und Architektur

### 2.1 Trennung von Wahrscheinlichkeit und Unsicherheit

Die direktionale Wahrscheinlichkeit wird strikt von der Quellenabdeckung getrennt:

- **`probability`** $\in [0.01, 0.99]$: Direktionale Wahrscheinlichkeit für das Eintreffen
  des Ziel-Events (UP). Bei Status `ABSTAIN` ist dieser Wert zwingend `null` (nie stilles 0.5).
- **`coverage`** $\in [0, 1]$: Numerisches Maß für die Quellenabdeckung und Datenfrische.
  Fehlende Quellen führen zu `coverage = 0`.
- **`confidence`** $\in [0, 1]$: Modellkonfidenz der direktionalen Aussage (0 bei Enthaltung).

### 2.2 NEUTRAL versus ABSTAIN

Die Unterscheidung zwischen Enthaltung und neutraler Einschätzung ist fail-closed implementiert:

| Eigenschaft | Status `ACTIVE` (Richtung `NEUTRAL`) | Status `ABSTAIN` (Enthaltung) |
| :--- | :--- | :--- |
| **Bedeutung** | Valide Quellen liegen vor; Nachrichtenlage ist ausgewogen. | Keine, veraltete oder unlesbare Quellen vorhanden. |
| **`direction`** | `"NEUTRAL"` | `null` |
| **`probability`** | `0.50` | `null` |
| **`abstain`** | `false` | `true` |
| **`abstainReason`** | `null` | `"NO_SOURCES"`, `"STALE_SOURCES"`, etc. |
| **`coverage`** | $> 0$ (typisch $\ge 0.33$) | `0` |
| **Legacy-Feld `sentiment`** | `"NEUTRAL"` | `"NEUTRAL"` (Kompatibilität) |

### 2.3 Syndikations-Deduplikation

Zur Verhinderung künstlich erhöhter Konfidenz durch syndizierte Presse- und Wire-Meldungen
durchlaufen alle eingehenden Schlagzeilen vor der Agenten-Auswertung einen
Deduplikationsfilter (`deduplicateNewsSources`):

1. **Bereinigung:** Entfernung von Feed-Zusätzen (`[CoinDesk]`, `(Reuters)`, etc.),
   Interpunktion und Whitespace.
2. **Content-Hash:** SHA-256-Fingerprint des normalisierten Titels.
3. **Paraphrasen-Erkennung:** Token-Jaccard-Ähnlichkeit ($\ge 0.80$) innerhalb eines
   rollierenden 24h-Zeitfensters.
4. **Zählung:** Mehrfach gemeldete Stories erhöhen `syndicationCount`, werden jedoch
   als genau **eine** Quelle (`sourceCount = 1`) gewertet.

### 2.4 Zeitsemantik (Point-in-Time, kein Look-ahead)

- **`sourceEventTime`**: Veröffentlichungszeitpunkt der maßgeblichen Nachricht (Ereigniszeit).
  Quellen mit Zeitstempel nach `asOf` werden strikt verworfen.
- **`asOf`**: Analyse- und Generierungszeitpunkt (`generated_at`).
- **`validUntil`**: Schlusszeit des Auswertungsfensters (`resolves_at = asOf + horizon`).
- **Keine Preisspeicherung:** Beim Erzeugen eines Sentiment-Forecasts wird **weder ein
  Referenzkurs noch ein Marktpreis oder späteres Outcome** gespeichert. Die Auflösung
  erfolgt später zeitgetrennt über den P3.1-Ledger-Pfad.

### 2.5 Multi-Entity-Nachrichten

Schlagzeilen, die mehrere Instrumente erwähnen (z. B. *"Ethereum and Solana rally"*),
werden allen erkannten Ticker-Symbolen zugeordnet. Jedes Instrument erhält einen
vollkommen eigenständigen Sentiment-Forecast mit eigener kanonischer `entityId`
und eigener `forecastId`.

## 3. Datenbank-Schema (`sentiment_forecasts`)

Die Tabelle `sentiment_forecasts` ist append-only aufgebaut:

```sql
CREATE TABLE IF NOT EXISTS "sentiment_forecasts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "forecast_id" text NOT NULL UNIQUE,       -- sf1:<sha256>
  "entity_id" text NOT NULL,                -- z. B. BINANCE:BTCUSDT
  "symbol" text NOT NULL,                   -- z. B. BTC
  "direction" text,                         -- BULLISH | BEARISH | NEUTRAL | NULL
  "status" text NOT NULL,                   -- ACTIVE | ABSTAIN
  "probability" numeric,                    -- 0.01..0.99 | NULL
  "confidence" numeric NOT NULL,            -- 0..1
  "abstain" boolean NOT NULL DEFAULT false,
  "abstain_reason" text,                    -- NO_SOURCES | STALE_SOURCES | ...
  "horizon" text NOT NULL,                  -- 4h | 24h | 72h
  "horizon_minutes" integer NOT NULL,       -- 240 | 1440 | 4320
  "event_type" text NOT NULL,               -- MACRO | EARNINGS | ...
  "source_count" integer NOT NULL,
  "raw_source_count" integer NOT NULL,
  "coverage" numeric NOT NULL,              -- 0..1
  "source_event_time" timestamptz,
  "source_earliest_at" timestamptz,
  "source_latest_at" timestamptz,
  "as_of" timestamptz NOT NULL,
  "valid_until" timestamptz NOT NULL,
  "prompt_version" integer NOT NULL,
  "model" text NOT NULL,
  "schema_version" text NOT NULL,
  "source_deduplication_hash" text NOT NULL,-- sd1:<sha256>
  "content_hash" text NOT NULL,             -- sc1:<sha256>
  "ledger_forecast_id" text,                -- Optionaler Link zu P3.1
  "summary" text NOT NULL,
  "risk_flags" jsonb NOT NULL,
  "impact_score" numeric NOT NULL,
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
```

### Idempotenz und Constraints

- **`forecast_id`** (`sf1:<sha256>`): Deterministischer Hash über Schemagrundlage,
  Modell, As-of-Zeit, Entität und deduplizierte Quellenlage.
- **`ON CONFLICT (forecast_id) DO NOTHING`**: Wiederholte Ausführungen oder Restarts
  erzeugen keine doppelten Zeilen.
- **CHECK-Constraints**: Erzwingen auf DB-Ebene, dass `valid_until > as_of`,
  Wahrscheinlichkeiten in $[0.01, 0.99]$ liegen und bei `ABSTAIN` zwingend
  `probability IS NULL` und `direction IS NULL` gelten.

## 4. API-Schnittstelle

### `GET /api/analysis/sentiment`

Liefert persistierte Sentiment-Forecasts mit Filterung und strikter Obergrenze.

- **Query-Parameter:**
  - `entityId`: Kanonische ID (optional, max. 64 Zeichen)
  - `status`: `ACTIVE` | `ABSTAIN` (optional)
  - `horizon`: `4h` | `24h` | `72h` (optional)
  - `from`: ISO-8601-Startzeitpunkt (optional)
  - `to`: ISO-8601-Endzeitpunkt (optional)
  - `limit`: Ganzzahl 1..200 (Default: 50)
- **Header:** `Cache-Control: no-store`

## 5. Rollback und Konfiguration

Die Persistenz strukturierter Sentiment-Outputs kann im Fehlerfall unterbrechungsfrei
deaktiviert werden:

```bash
# In .env oder Deployment-Umgebung:
STRUCTURED_SENTIMENT_ENABLED=false
```

Bei gesetztem Flag `STRUCTURED_SENTIMENT_ENABLED=false` werden keine Schreibvorgänge
in `sentiment_forecasts` ausgeführt; der Zyklus und die bestehenden Berichte laufen
unterbrechungsfrei im Speicher weiter.
