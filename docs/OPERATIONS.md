# Operations — Runbooks: „Funnel ist leer“ & „Auto-Breaker hat ausgelöst“

> **Status-Header:** **Implementiert** (OPS-011; §4 ergänzt durch GAP-10) ·
> **2026-09-18** · Code-Version **1.45.0** · Module
> `src/ops/collectMarketData.ts`, `src/marketdata/syncStatus.ts`,
> `src/components/ops/MarketDataPanel.tsx`, `src/lib/circuitBreaker.ts`,
> `src/lib/alerts.ts`, `src/lib/heartbeat.ts`, `scripts/watchdog.ts` ·
> Endpunkte `GET /api/ops`, `GET /api/health` (read-only)

Dieses Dokument enthält zwei Runbooks: **§1–3** beantworten die häufigste
Betriebsfrage des Scanners (`„Funnel ist leer“`), **§4** den Ablauf nach einem
automatischen Not-Halt (`„Auto-Breaker hat ausgelöst“`, v1.45.0).

Das erste Runbook beantwortet die häufigste Betriebsfrage des Scanners:
**„Der Funnel zeigt sechs Nullen — was jetzt?“** Seit v1.33.0 zeigt das
Operations Center dafür die Sektion **„Market Data“ oberhalb des Funnels**
(Payload-Feld `marketData`, Typ `MarketDataOpsSnapshot`). Sie unterscheidet
die drei Fälle, die vorher ununterscheidbar waren:

1. **„Wir haben keine Kerzen geladen“** → `WARMING` (Warmup, behebbar per Sync)
2. **„Der Ticker-/Depth-Abruf ist ausgefallen“** → `ERROR` (Infrastruktur)
3. **„Der Markt bietet aktuell nichts Geeignetes“** → `READY` (fachlich korrekt)

Der Funnel selbst bleibt unverändert erhalten; bei `WARMING`/`ERROR` erklärt
das Panel explizit, dass dessen Nullen datenbedingt sind.

---

## 1. Entscheidungsbaum

Lies die Zeile `Scanner-ready` der Market-Data-Sektion und folge dem Baum von
oben nach unten — der **erste** zutreffende Ast ist der dominierende Blocker
(dieselbe Reihenfolge implementiert `buildReadinessHint()` in
`src/ops/collectMarketData.ts`):

```text
Scanner-ready = NO?
│
├─ Fehler-Counter > 0 (Status ERROR)?
│    → Venue-Incident: Market-Data-Abrufe schlagen fehl (z. B. RATE_LIMITED,
│      UPSTREAM_5XX, TIMEOUT). Der leere Funnel ist ein Infrastrukturproblem,
│      keine Marktbewertung.
│      Nächster Schritt: Venue-Status und Request-Budget prüfen
│      (docs/OBSERVABILITY.md, docs/ERROR_HANDLING_MARKETDATA.md);
│      danach Sync wiederholen. Ein fehlerfreier Lauf löscht das
│      Fehler-Manifest (data/market-data-errors.json).
│
├─ Candles 0 / 61 (keine Kerzenhistorie, Status WARMING)?
│    → Sync ausführen:  npm run market:sync -- --venue=BITUNIX
│      Benötigt werden 61 Kerzen je Instrument (dynamisch aus dem Faktorsatz:
│      EMA50 + Momentum-Lookback 60 + 1 Referenzkerze, requiredWarmupCandles()).
│
├─ Spread-ready = 0 bei vorhandenen Kerzen (Status WARMING)?
│    → Depth-Abruf prüfen: der Spread stammt aus dem Orderbook
│      (/market/depth) — der Ticker-Endpoint liefert ihn nicht. Ohne Spread
│      lehnt der Scanner mit rule=max-spread ab (Datenqualität, nicht
│      Marktqualität). Siehe docs/MARKET_DATA_PIPELINE.md §3.
│
├─ Warming > 0 (Teil-Warmup, Status WARMING)?
│    → „Worst offenders“ aufklappen: die Tabelle nennt die Instrumente mit
│      den wenigsten Kerzen. Sync erneut ausführen; einzelne Symbole gezielt:
│      npm run market:sync -- --venue=BITUNIX --symbols=BTCUSDT
│
└─ Scanner-ready = YES (Status READY) und trotzdem Eligible 0?
     → Fachliche Bewertung: Datenbasis vollständig — ein leerer Funnel ist
       hier eine echte Aussage der Eignungsfilter (Markt/Kosten). Details je
       Instrument: Ablehnungs-Diagnose (eligibilityDiagnostics) in der
       Market-Data-Karte bzw. docs/OPERATIONS_CENTER.md §3.
```

## 2. Die Sektion „Market Data“ im Detail

```text
Market Data                        Nach erfolgreichem Sync
────────────                       ────────────
Registry        26                 Registry        42
Discovered      26                 Discovered      42
Data-ready       0                 Data-ready      42
Warming         26                 Warming          0
Candles       0 / 61               Candles      42 / 61
Ticker-ready     0                 Ticker-ready    42
Spread-ready     0                 Spread-ready    42
Scanner-ready   NO                 Scanner-ready  YES
```

| Zeile | Herkunft | Sollwert |
| --- | --- | --- |
| `Registry` | Instrument-Registry (`registry.size`) | > 0 (Seed/Discovery) |
| `Discovered` | `lastSeen` ≤ 24 h | = Registry |
| `Data-ready` | Instrumente mit ≥ `requiredCandles` Kerzen im Scanner-Timeframe (`data/history`) | = Registry |
| `Warming` | `Registry − Data-ready` | 0 |
| `Candles X/Y` | X = Instrumente mit vollständiger Historie, Y = benötigte Kerzen **je Instrument** (`requiredWarmupCandles()`) | X = Registry |
| `Ticker-ready` | `volume24h ≠ null` (Ticker-Enrichment) | = Registry |
| `Spread-ready` | `spread ≠ null` (Orderbook-/depth-Enrichment) | = Registry |
| `Scanner-ready` | `YES` ⇔ Status `READY` (alles vollständig) | YES |

Dazu zeigt das Panel:

* **Letzter Sync je Venue** — Zeitpunkt, `degraded`-Flag und Fehlerzähler
  nach Ursache (geschlossene MDERR-006-Taxonomie). Quelle:
  `data/market-sync-status.json`, geschrieben vom Sync-CLI
  (`src/marketdata/syncStatus.ts`). Nie gesynct = `lastSyncAt: null`.
* **Worst offenders** (ausklappbar) — bis zu 10 Instrumente mit den
  wenigsten Kerzen, deterministisch sortiert.
* **Hinweistext** — genau ein handlungsleitender Satz je dominierendem
  Blocker (`buildReadinessHint()`), zentral implementiert statt in der UI
  verstreut.

## 3. Sicherheits- und Betriebsgrenzen

* **Read-only:** `GET /api/ops` liest nur; es gibt **keinen** Endpoint, der
  einen Sync auslöst. Ein Sync läuft ausschließlich über die CLIs
  (`npm run market:sync`, `npm run scan -- --sync-first`).
* **Keine Secrets:** Der Snapshot enthält Zähler, ISO-Zeitstempel,
  Instrument-IDs und klassifizierte Fehler-Ursachen — keine Credentials,
  keine Env-Variablen, keine internen Dateipfade, keine Stacktraces, keine
  rohen Upstream-Messages.
* **Gekappte Antwort:** `venues` und `worstOffenders` sind auf je 10
  Einträge begrenzt; der persistierte Sync-Status validiert Venue-Namen und
  die geschlossene `reason`-Aufzählung beim Laden.
* **Fail-soft:** Schlägt die Aggregation fehl, steht `marketData: null` im
  Payload — Funnel und übrige Sektionen bleiben lesbar.

## 4. Runbook: „Auto-Breaker hat ausgelöst“ (GAP-10, v1.45.0)

### Symptom

* Das Dashboard zeigt den **Kill-Switch als scharf** (`killSwitchArmed: true`
  in `GET /api/firm/kill` bzw. roter Status in der Control Plane), obwohl
  niemand ihn manuell gezogen hat.
* Ein Alert `circuit-breaker:<metrik>` (severity `critical`) steht in
  `data/alerts.ndjson` bzw. im Log (Event `alert`).
* Im Audit-Log steht ein `KILL_SWITCH`-Eintrag (CRITICAL, Security-Klasse)
  mit maschinenlesbarem Grund `auto-circuit-breaker:<metrik>:<wert>`.

**Das ist kein Fehler, sondern die letzte Verteidigungslinie.** Der Brecher
hat eine harte Grenze reißen sehen und alle **neuen** Orders gesperrt. Offene
Positionen werden nicht automatisch glattgestellt (bewusst: kein Marktverkauf
auf Verdacht) — der Mensch entscheidet.

### Schritt 1 — Ursache am Audit ablesen (nichts verändern)

Der Audit-Eintrag fixiert den Auslösewert im Moment des Auslösens
(`metric`, `value`, `limit`, `triggeredAt`, `drawdownPct`, `dailyLossPct`,
`consecutiveLosses`) — spätere Kurse verändern das Bild nicht mehr.

| Metrik im Grund | Bedeutung | Typische Ursache |
| --- | --- | --- |
| `drawdown` | Equity-Drawdown ≥ Risiko-Limit `maxEquityDrawdownPct` (Default 15 %, Dashboard „Drawdown-Kill-Schwelle“) | Verlustserie, Marktbewegung, Datenfehler |
| `dailyLoss` | Tagesverlust ≥ Risiko-Limit `dailyLossLimitPct` (Default 5 % des Startkapitals, Dashboard „Tagesverlust-Limit“) | ein schlechter Handelstag |
| `consecutiveLosses` | `RISK_MAX_CONSECUTIVE_LOSSES` Verlust-Closes in Folge (Default 5) | Strategie/Regime passt nicht |

Beispiel:

```text
reason:           auto-circuit-breaker:drawdown:0.1834
trigger:          drawdown
value / limit:    0.1834 / 0.1500
```

### Schritt 2 — Prüfen, ob die Firma überhaupt noch tickt

Beides ist unabhängig vom Not-Halt:

```bash
curl -s http://127.0.0.1:3369/api/health | jq '{stale, monitorLastTickAt, monitorAgeMs}'
npm run watchdog            # exit 0 = gesund, 1 = Alarm, 2 = Bedienfehler
```

`stale: true` heißt: Der Monitor-Tick ist überfällig (`HEALTH_STALE_AFTER_MS`,
Default 5 min). Dann zuerst den Prozess/die Datenbank prüfen — **der Watchdog
startet nichts neu und entschärft nichts**; er alarmiert nur.

### Schritt 3 — Bewusst entscheiden

* **Lage verstanden, Grenze war korrekt:** Not-Halt bleibt scharf, bis die
  Ursache behoben ist (Positionen prüfen, Strategie/Zyklus anpassen). Der
  Brecher ist **latching**: Ein erneuter Tick ändert nichts, es gibt keinen
  Auto-Re-Arm.
* **Fehlauslösung (z. B. Datenfehler) belegt:** Not-Halt manuell entschärfen
  (Schritt 4) und danach die Ursache beheben.
* **Brecher soll vorübergehend aus (nur Fehlersuche!):**
  `AUTO_CIRCUIT_BREAKER=off` + Neustart. Das ist ein bewusster, im CHANGELOG
  dokumentierter Betriebsentscheid — die harten Grenzen blockieren dann nur
  noch **neue** Orders, ein Bruch schaltet nichts mehr ab.

### Schritt 4 — Manuell entschärfen (der einzige Weg zurück)

Der Disarm-Pfad ist absichtlich unbequem (Befund C3) und **unverändert**:

1. Admin-Session/Permission `live.gate` + CSRF-Header `x-csrf-token`
   (bei Token-Betrieb der Wert aus `FIRM_ADMIN_TOKEN`/`FIRM_API_TOKEN`,
   im lokalen Betrieb `local`).
2. `GET /api/firm/kill/challenge` → `{ nonce, expiresAt }` (≤ 60 s gültig,
   **single-use**).
3. `POST /api/firm/kill` mit `{ "arm": false, "nonce": "<nonce>" }`.

```bash
# CSRF-Wert: bei Token-Betrieb aus FIRM_ADMIN_TOKEN/FIRM_API_TOKEN,
# im lokalen Betrieb der Beispielwert (Umgebungsvariable setzen):
CSRF=${CSRF:-local}
NONCE=$(curl -s -H "x-csrf-token: $CSRF" http://127.0.0.1:3369/api/firm/kill/challenge | jq -r .nonce)
curl -s -X POST -H "x-csrf-token: $CSRF" -H "content-type: application/json" \
  -d "{\"arm\":false,\"nonce\":\"$NONCE\"}" http://127.0.0.1:3369/api/firm/kill
```

Fehlercodes: `NONCE_REQUIRED`, `NONCE_EXPIRED`, `NONCE_REUSED`,
`CSRF_INVALID` — jeder Fall lässt den Not-Halt **scharf** (fail-closed). Der
Disarm selbst wird mit `stage=PRECHECK`/`stage=APPLIED` auditiert; ist kein
Auditbeleg schreibbar, bleibt der Not-Halt aktiv (503). Danach fällt der
Brecher-Latch und darf bei einem erneuten Bruch wieder auslösen.

### Was der Brecher nicht tut

* **Kein Auto-Re-Arm, kein Timer, keine Hysterese:** Einmal ENGAGE bleibt
  ENGAGE, bis ein Mensch entschärft.
* **Kein Flatten:** Er sperrt Orders, er verkauft nichts.
* **Kein Auto-Restart:** Der Watchdog alarmiert nur (alarm-first).
* **Keine Secrets im Alert:** Alerts enthalten Code, Severity, Meldung und
  klassifizierte Metadaten — keine Tokens, URLs oder Kontodaten.

## Verwandte Dokumente

* [`OPERATIONS_CENTER.md`](OPERATIONS_CENTER.md) — Diagnose-Walkthrough und API-Vertrag des Operations Centers
* [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) — Discovery, Enrichment, Backfill, Readiness (§6)
* [`OBSERVABILITY.md`](OBSERVABILITY.md) — Marktdaten-Fehler, Firmen-Metriken, Auto-Circuit-Breaker, Alerts und Heartbeat (§9–12)
* [`ERROR_HANDLING_MARKETDATA.md`](ERROR_HANDLING_MARKETDATA.md) — Fehlertaxonomie und Behandlung
