# Forecast-Ledger & Kalibrierung (RMA-P3-01, v1.55.0)

Agenten-Analysen werden als **unveränderliche Forecast-Verträge** erfasst,
**Point-in-Time aufgelöst** und mit **Brier-Score, Brier Skill Score, Log Loss,
Reliability-Bins und Expected Calibration Error** bewertet — vollständig
**unabhängig vom Trade-Journal**: Eine Prognose zählt auch dann, wenn nie ein
Trade daraus entstand, und umgekehrt.

- Code: `src/forecasts/` (Capture, Ledger, Resolver, Scoring, Service, API-Ports)
- Migration: `drizzle/2026-09-20_forecast_ledger.sql` (append-only, idempotent)
- API: `/api/firm/forecasts*` (4 Endpunkte, `firm.read`/`firm.write`)
- Audit-Events: `FORECAST_RECORDED`, `FORECAST_CAPTURE_FAILED`,
  `FORECAST_RESOLVED`, `FORECAST_VOID`, `FORECAST_RE_RESOLUTION`
- Betrieb: Resolver-Kadenz in `src/instrumentation.ts` (§6)

---

## 1. Der Forecast-Vertrag (immutable)

Jede Analyse einer erfassten Rolle wird zu einem eingefrorenen Vertrag
(`src/forecasts/types.ts`, `src/forecasts/capture.ts`). Pflichtfelder:

| Feld | Bedeutung |
|------|-----------|
| `forecastId` | UUID, vom Ledger vergeben |
| `agentRole`, `promptVersion`, `model` | Urheber der Prognose (Segmentierdimensionen) |
| `targetKind` | `CLOSE_DIRECTION` (einziger Typ in v1) |
| `entityId`, `symbol` | Zielobjekt, z. B. `PAPER:BTC` (Paper-Entität — niemals Instrument-/Order-IDs als Labels) |
| `categories` / `probabilities` | geschlossene Kategorienliste `["DOWN","UP"]` + Wahrscheinlichkeitsvektor; Summe muss ≤ 1e-6 um 1 liegen |
| `targetCategory` | Binär-Referenz: `UP` („Ereignis eingetreten“) |
| `horizonId` | `4h` (240 min), `24h` (1440 min), `72h` (4320 min) — geschlossene Liste |
| `asOf` | Erfassungszeitpunkt (Zeitpunkt der Analyse) |
| `referenceTime` / Referenzkurs | Schlusszeit + Schlusskurs der letzten **vor `asOf` geschlossenen** 1h-Kerze |
| `resolvesAt` | `referenceTime + Horizont`; Auflösung gegen den Schlusskurs dieser Kerze |
| `availabilityDeadline` | `resolvesAt + 2 h` Settling-Frist: bis hierhin dürfen Outcome-Kerzen eintreffen |
| `regime` | Markt-Regime zum Erfassungszeitpunkt (Segmentierdimension) |
| `policyVersion` | `fp1` — die Regelversion der Auflösung (Zeitsemantik, Abbildung, VOID-Regeln) |
| `contractVersion` | `1` — Schema-/Semantikversion des Vertrags |

**Erfassung (Policy `fp1`):** Rollen `TECHNICAL_ANALYST` (4h),
`SWING_RESEARCHER`/`SCOUT`/`DILIGENCE` (72h). Aus Richtung + Konfidenz der
Analyse wird ein Wahrscheinlichkeitsvektor abgeleitet:
`p(UP) = clamp(0.5 ± Konfidenz/2, 0.01 … 0.99)`; eine nicht-positive oder
fehlende Konfidenz ergibt die **uninformierte** Prognose `0.5/0.5` — niemals
wird „kein Wert“ als `0` interpretiert. Fehlt die Referenzkerze, entsteht
**kein** Forecast (`NO_REFERENCE_DATA`, fail-closed).

**Zeitsemantik (drei getrennte Achsen):**

1. **Ereigniszeit:** Kerzen-Schlusszeiten (`referenceTime`, `resolvesAt`).
2. **Verfügbarkeitszeit:** `fetchedAt` jeder gespeicherten Kerze — der Resolver
   liest **ausschließlich** Kerzen mit `fetchedAt <= availabilityDeadline`
   (Point-in-Time, kein Look-ahead durch nachträglich reparierte Historie).
3. **Berechnungszeit:** `createdAt`/`resolvedAt` der Ledger-Zeilen +
   Run-Manifeste (`forecast_resolution_runs`).

**Idempotenz:** natürlicher Schlüssel `fk1:<sha256>` über Vertrags- und
Inhaltsfelder (`src/forecasts/hashes.ts`). Retries, Neustarts oder doppelte
Analysezyklen schreiben keinen zweiten Forecast (`ON CONFLICT DO NOTHING` +
Bestandslookup).

---

## 2. Persistenz (append-only, vier Tabellen)

Migration `drizzle/2026-09-20_forecast_ledger.sql` — idempotent
(`IF NOT EXISTS` + bewachte `ALTER TABLE … ADD CONSTRAINT`-Blöcke), wiederholtes
Ausführen ist sicher.

| Tabelle | Inhalt | Schlüssel |
|---------|--------|-----------|
| `forecasts` | Verträge (immutable nach Insert) | `idempotency_key` unique |
| `forecast_resolutions` | Auflösungen, **eine Zeile je Version** | `(forecast_id, resolution_version)` unique; Outcome-Hash `fo1:<sha256>` |
| `forecast_resolution_runs` | Run-Manifeste des Resolvers (Zeitpunkt, Zähler, Wasserstand, Code-Version) | append-only |
| `forecast_resolver_cursors` | monotoner Resolver-Cursor (`id = 'resolution'`) | PK |

Nachträgliche Updates/Deletes sind durch Design ausgeschlossen: Korrekturen
erzeugen immer **neue Zeilen** (Resolution-Version `n+1`), niemals Mutationen.
Indizes bedienen genau die begrenzten Abfragemuster (Deadline-Scan des
Resolvers, Segment-Filter der Score-API).

---

## 3. Auflösung (Resolver, idempotent & begrenzt)

`src/forecasts/resolver.ts` + `runForecastResolverJob` (`src/forecasts/service.ts`):

1. **Feed:** der Kerzen-Store wird mit frischen Kerzen beliefert (Verfügbarkeit
   `fetchedAt = jetzt` — die Quelle der Wahrheit für „wann war das Datum da“).
2. **Auswahl:** nur Forecasts mit `resolvesAt <= jetzt < availabilityDeadline`
   und ohne Resolution (begrenzt, Default-Batch 250).
3. **Bewertung (rein, `evaluateForecast`):**
   - Referenzkerze: `closeTimeMs === referenceTime`; Outcome-Kerze:
     `closeTimeMs === resolvesAt`; beide müssen die PIT-Filterung überstehen.
   - `close(outcome) > close(reference)` ⇒ `UP` (1), sonst `DOWN` (0).
     Ein exakter Gleichstand ist per Policy `fp1` dokumentiert `DOWN`.
   - fehlende Kerze bis Deadline ⇒ **`VOID(MISSING_DATA)`**, nicht-finiter oder
     nicht-positiver Kurs ⇒ `VOID(INVALID_DATA)`, Volumen 0 im gesamten
     Auflösungsfenster ⇒ `VOID(TRADING_HALT)` — niemals wird geraten.
4. **Schreiben:** append-only in Transaktion mit Zeilensperre; identischer
   Outcome-Hash ⇒ no-op (`created: false`), abweichend ⇒ neue Version.
5. **Cursor & Manifest:** Wasserstand (`GREATEST(alter, neuer Wert)`), Run-Zeile
   mit Zählern, Truncated-Markierung und `lagMs`; Audit-Events je Zustand.

Der Cursor rückt **nur** vor, wenn der Batch nicht am Limit abgeschnitten
wurde — so geht bei Abbruch/Neustart nichts verloren, und Wiederholungen setzen
exakt am Wasserstand auf (Restart-/Retry-Sicherheit). Ein zweiter gleichzeitiger
Lauf wird abgewiesen (`RESOLVER_BUSY`, 409).

**Kadenz:** `instrumentation.ts` startet den Job alle
`FORECAST_RESOLVER_INTERVAL_MIN` (Default 15, Bounds 5…1440; `0` = aus) —
zusätzlich manuell über die API auslösbar.

**Operator-Pfad (Datenkorrektur, Corporate Action):**
`reResolveForecast` bewertet mit der aktuellen Store-Lage neu
(Verfügbarkeitsgrenze = jetzt); nur bei abweichendem Outcome-Hash entsteht eine
neue Resolution-Version. `voidForecastByOperator` hängt eine begründete
VOID-Zeile an (`CORPORATE_ACTION`, `DATA_CORRECTION`, …). Gründe sind eine
**geschlossene Liste** (`FORECAST_VOID_REASONS`), jede Aktion schreibt ein
WARN-Audit-Event mit Akteur. So wird eine spätere Marktdaten-Korrektur zur
**versionierten Re-Resolution statt stiller Mutation** — frühere Versionen
bleiben samt ihrer Scorebasis nachvollziehbar.

---

## 4. Metriken (Formeln, Einheiten, Unsicherheit)

`src/forecasts/scoring.ts` (rein) + `src/forecasts/metrics.ts` (Berichte).
Metrikversion `fm1`. **Nur `RESOLVED`-Zeilen gehen in Scores ein**; `VOID` und
`PENDING` zählen nie als korrekt oder als 0, erscheinen aber in Coverage und
Zählern.

| Metrik | Formel | Einheit/Bereich |
|--------|--------|-----------------|
| **Brier Score** (binär) | `mean((p − y)²)` mit `p = P(UP)`, `y = 1{UP}` | [0, 1], kleiner = besser; 0 = perfekt |
| **Brier Score** (kategorial) | `mean(Σ_k (p_k − 1{k})²)` | [0, 2] |
| **Brier Skill Score** | `1 − BS / BS_ref`, Referenz = Segment-Klimatologie (beobachtete Basisrate); bei degenerierter Referenz `null` | (−∞, 1]; ≤ 0 ⇒ nicht besser als die Basisrate |
| **Log Loss** | `−mean(log p_treffer)`, Klemmung ε = 1e-6 gegen `log(0)` | [0, ∞), kleiner = besser |
| **Reliability Bins** | 10 Bins, Index `min(⌊p·k⌋, k−1)` — exakt p=0 und p=1 landen im ersten/letzten Bin; je Bin: Count, mittlere Prognose, beobachtete Rate | — |
| **Wilson-95-Intervall** je Bin | exakt an den Rändern (0/n und n/n), `z = 1.959963984540054`; `n = 0 ⇒ null` | Anteile [0, 1] |
| **ECE** | count-gewichtete mittlere Abweichung `|Ø Prognose − beobachtete Rate|` | [0, 1] |
| **Coverage** | `(resolved + void) / due` (`due` = fällig laut `availabilityDeadline`); `due = 0 ⇒ null` statt NaN | Anteil [0, 1] |
| **Sample Count** | `resolvedCount` je Segment; darunter ⇒ `status: "insufficient-sample"` (Default-Mindeststichprobe 30, `FORECAST_MIN_SAMPLE`) | — |

Referenzwerte: perfekte Prognosen ⇒ Brier 0 / Log Loss 0; die uninformierte
Konstante 0.5 ⇒ Brier 0.25 bei beliebiger Basisrate; sichere, aber falsche
Prognose (p=1, y=0) ⇒ Brier 1, Log Loss → groß (ε-Klemmung). Diese Fixpunkte
sind als Test-Fixtures in `tests/forecastScoring.test.ts` verankert.

**Keine High-Cardinality-Labels:** Forecast-/Resolution-/Instrument-IDs
erscheinen in Antworten und Audit, aber nie als Metrik-Label
(Kardinalitätsregel von `src/lib/telemetry.ts`).

---

## 5. Segmentierung & API

Alle Abfragen sind bounded (harte Limits in `FORECAST_LIMITS`, Truncated wird
laut markiert). Segmentierdimensionen: `agent` (Rolle), `promptVersion`,
`horizon` (`4h|24h|72h`), `entity` (z. B. `PAPER:BTC`), `regime`, Zeitraum
(`from`/`to` über `asOf`). Alle Antworten tragen `Cache-Control: private, no-store`.

### `GET /api/firm/forecasts` — Liste + Betriebsstatus (`firm.read`)

```
GET /api/firm/forecasts?agent=TECHNICAL_ANALYST&entity=PAPER:BTC&horizon=4h
    &regime=NORMAL&promptVersion=3&from=2026-09-01T00:00:00Z&to=…&limit=1..200
```

Liefert Forecasts mit Wirksstatus (`PENDING`/`RESOLVED`/`VOID`), jüngster
Resolution und `operations`-Block: `enabled`, `watermarkDeadline` (Cursor),
`overdue` (ältester überfälliger Forecast + `lagMs`) — die
Staleness-/Lag-Beobachtung des Resolvers.

### `GET /api/firm/forecasts/scores` — Scorebericht (`firm.read`)

```
GET /api/firm/forecasts/scores?agent=…&promptVersion=3&horizon=4h&entity=…
    &regime=…&from=…&to=…&minSample=5..1000&limit=1..20000
```

Antwort: `overall` + `segments` (deterministisch sortiert) mit Brier, BSS,
Log Loss, Reliability-Bins (+Wilson), ECE, Sample Count, Coverage und
`status: "ok" | "insufficient-sample"`. `TOO_MANY_SEGMENTS` (400), wenn die
Filter mehr als 500 Segmente aufspannen.

### `POST /api/firm/forecasts/resolve` — manueller Resolver-Lauf (`firm.write`)

```
POST /api/firm/forecasts/resolve    { "limit"?: 1..250 }
```

Identische Logik zum Scheduler; idempotent. `503 FORECAST_LEDGER_DISABLED`
(Rollback-Pfad), `409 RESOLVER_BUSY`, sonst `runId`, `counts`, `watermarkDeadline`, `lagMs`.

### `POST /api/firm/forecasts/resolutions` — Operator-Eingriff (`firm.write`)

```
POST /api/firm/forecasts/resolutions
{
  "forecastId": "<uuid>",
  "action": "RE_RESOLVE" | "VOID",
  "reason": "DATA_CORRECTION" | "CORPORATE_ACTION" | "TRADING_HALT" |
            "INVALID_DATA" | "MISSING_DATA",
  "note"?: "<= 500 Zeichen"
}
```

`RE_RESOLVE` erzeugt nur bei abweichendem Outcome-Hash eine neue Version;
`VOID` hängt eine begründete VOID-Zeile an. Wiederholungen mit identischem
Inhalt sind no-ops. Unbekannter Forecast ⇒ `404`; ungültige Eingaben ⇒ `400`
(geschlossene Listen, siehe Fehlercodes unten).

### Fehlercodes (400er auszugsweise)

`INVALID_HORIZON`, `INVALID_PROMPT_VERSION`, `INVALID_LIMIT`,
`INVALID_MIN_SAMPLE`, `INVALID_DATE`, `INVALID_JSON`, `INVALID_BODY`,
`TOO_MANY_SEGMENTS` — plus 503er `FORECAST_LEDGER_UNAVAILABLE`/
`FORECAST_LEDGER_DISABLED` und `409 RESOLVER_BUSY`.

---

## 6. Migration, Deployment, Rollback

**Migration:** `psql "$DATABASE_URL" -f drizzle/2026-09-20_forecast_ledger.sql`
— rein additiv (4 neue Tabellen), idempotent, keine Änderung bestehender
Tabellen. Bestehende Default-Pfade (Paper/Backtest) bleiben unberührt; der
Capture-Hook hängt sich hinter die Analyse und bricht den Analysezyklus auch bei
Ledger-Störungen nie ab (laut protokollierter Skip).

**Deployment-Reihenfolge:**

1. Migration ausführen (idempotent, jederzeit vor dem Code-Update möglich).
2. Code deployen; Instanzen neu starten.
3. `GET /api/firm/forecasts` (leere Liste + `operations.enabled: true`) und
   einen manuellen `POST /api/firm/forecasts/resolve` zur Verifikation nutzen.

**Rollback (absteigend in der Eingriffsstärke):**

1. **Feature-Flag:** `FORECAST_LEDGER_ENABLED=false` + Neustart — Capture-Hook
   und Resolver pausieren, APIs antworten `503 DISABLED`; das System verhält
   sich wie vor v1.55.0. Daten bleiben erhalten.
2. **Scheduler aus:** `FORECAST_RESOLVER_INTERVAL_MIN=0` deaktiviert nur die
   automatische Auflösung (manuelle Auflösung bleibt möglich).
3. **Tabellen entfernen:** erst nach Verifikation und nur, wenn keine
   produktiven Scores mehr benötigt werden:
   `DROP TABLE IF EXISTS forecast_resolver_cursors, forecast_resolution_runs, forecast_resolutions, forecasts CASCADE;`
   Die Migration selbst wird **nie** verändert (Append-only-Regel).

---

## 7. Env-Flags

| Flag | Default | Bounds | Wirkung |
|------|---------|--------|---------|
| `FORECAST_LEDGER_ENABLED` | `true` | — | Master-Schalter Capture + APIs (siehe §6) |
| `FORECAST_RESOLVER_INTERVAL_MIN` | `15` | 5…1440 (0 = aus) | Resolver-Kadenz in Minuten |
| `FORECAST_MIN_SAMPLE` | `30` | 5…1000 | Mindeststichprobe für `status: "ok"` |

Details: [CONFIGURATION.md](../CONFIGURATION.md#forecast-ledger--kalibrierung-rma-p3-01-v1550).

---

## 8. Audit & Observability

- **Audit-Events** (Katalog in `src/lib/auditView.ts`): `FORECAST_RECORDED`
  (INFO), `FORECAST_RESOLVED` (INFO), `FORECAST_VOID` /
  `FORECAST_RE_RESOLUTION` / `FORECAST_CAPTURE_FAILED` (WARN) — jeweils mit
  Forecast-ID, Resolution-Version, Outcome-Hash bzw. Fehlercode.
- **Metriken** (`src/lib/telemetry.ts`, Abschnitt `forecasts`): bounded Labels
  (`result`, `reason`, `mode`) für Captures, Queries, Resolver-Läufe.
- **Betriebsblick:** `operations` in der Listen-API liefert Cursor-Wasserstand,
  ältesten überfälligen Forecast und `lagMs` (Auflösungsverzug).

---

## 9. Abgrenzung (bewusst nicht enthalten)

- **Keine** rückwirkende Erfindung „exakter“ Forecasts aus Freitext-Historie —
  Bewertung beginnt mit der ersten real erfassten Analyse.
- **Keine** automatische Agenten-Gewichtung aus Scores; dafür ist eine
  getrennte Policy/Richtlinienkette zuständig (PROMPT-00-Rule 4: keine
  Umgehung von Risk-Ceilings/Authority-Chains durch neue Scores).
- **Kein** Ausschluss unbequemer aufgelöster Forecasts zur Score-Schönung —
  VOID/PENDING bleiben in der Coverage sichtbar, Resolutionen sind append-only.

---

## 10. Tests

| Befehl | Abdeckung |
|--------|-----------|
| `node --import tsx --test tests/forecastScoring.test.ts tests/forecastCapture.test.ts tests/forecastResolver.test.ts tests/forecastService.test.ts tests/forecastApi.test.ts` | Reine Logik: Brier-Fixtures (perfekt/uninformiert/sicher-falsch), PIT-Auflösung, VOID-Pfade, Idempotenz, E2E Capture→Resolve→Score, API-Validierung |
| `node --import tsx --test tests/forecastLedger.db.test.ts` | Eingebettetes Postgres: Migration zweifach (Idempotenz), Append-only-Roundtrip, Idempotenz-/Restart-Verhalten, Re-Resolution |
| `npm test` | Gesamtregression (inkl. Bestands-Suiten) |
