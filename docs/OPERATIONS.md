# Operations — Runbooks: „Funnel ist leer“ & „Auto-Breaker hat ausgelöst“

> **Status-Header:** **Bestandsdokument** · **Stand:** 2026-09-18 · **Code-Version:** v0.17.7 (Beta) · Vollabgleich offen — [DC-06](audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md) ·
> Ausbaustand zum Stand: Implementiert (OPS-011; §4 ergänzt durch GAP-10) · Module
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

## 5. Vollautomatischer Betrieb (systemd-User-Units)

Drei Units halten die Firma ohne manuellen Eingriff am Laufen. Alle lesen
`EnvironmentFile=.env`, arbeiten im Projektverzeichnis und schreiben ins
Journal (`journalctl --user -u <unit> -f`).

| Unit | Typ | Takt | Aufgabe |
| --- | --- | --- | --- |
| `ai-trading-firm.service` | Dienst | dauerhaft | Next.js-App inkl. Scheduler (Tick, Analysten, Makro, Recon) |
| `ai-trading-firm-micro.service` | Dienst | dauerhaft | LLM-freier Micro-Executor: WebSocket-Ticks → `trade_rules` (ACTIVE) → Paper-Broker |
| `ai-trading-firm-market-sync.timer` | Timer | stündlich | `npm run market:sync -- --venue=BITUNIX --max-instruments=800` (öffentliche Endpunkte, keine Keys) |
| `ai-trading-firm-pipeline.timer` | Timer | alle 4 h | `scripts/auto-pipeline.sh`: LLM-Pipeline für je `MAX_MISSIONS` ACTIVE-Missionen, rotierend (`Nice=10`, idle-I/O) |

### Missions-Pipeline (`scripts/auto-pipeline.sh`)

Der Scheduler startet **keine** Missions-Pipeline — Proposals entstehen nur
über `POST /api/firm/run {missionId, pipeline:true}`. Das Skript übernimmt
diesen Teil: Es liest die ACTIVE-Missionen, filtert auf handelbare Symbole
(`BTC, ETH, SOL, XRP, BNB, ADA, DOGE, AVAX, LINK, DOT`) bzw. Segmente
(`CRYPTO`, `ALL`, `LIQUID`) und startet pro Aufruf `MAX_MISSIONS` Läufe
(Default 3). Der Cursor in `data/auto-pipeline-cursor.json` rotiert weiter,
damit die lokale LLM-Instanz nicht dauerhaft ausgelastet wird.

```bash
MAX_MISSIONS=1 PIPELINE_TIMEOUT_S=1500 bash scripts/auto-pipeline.sh   # Einzellauf
systemctl --user list-timers 'ai-trading-firm-*'                        # nächste Läufe
```

Ist bereits eine Pipeline im Prozess aktiv, antwortet die API mit `409`
(`PIPELINE_ALREADY_RUNNING`); das Skript protokolliert das und fährt fort.

### Grenzen

* **Paper-only:** Die Pipeline handelt ausschließlich im Paper-Modus. Der
  Live-Gate bleibt unabhängig davon geschlossen (`LIVE_TRADING.md`).
* **Regeln brauchen `ACTIVE`:** Der Micro-Executor lädt nur
  `trade_rules.status = 'ACTIVE'`; DRAFT-Regeln werden ignoriert. Regeln
  entstehen über den Makro-Zyklus oder `POST /api/firm/rules` (mit
  `activate: true`).
* **Timeframe ≤ 1h:** Der Micro-Executor führt nur Regeln aus, deren
  Timeframe nicht länger als das Ausführungsintervall ist (Default `1h`).
* **Kill-Switch bleibt autoritativ:** Ein engagierter Brecher stoppt beide
  Prozesse sofort; die Timer laufen weiter, handeln aber nicht.

### Aktive Risiko-Konfiguration (Paper)

| Einstellung | Wert | Begründung |
| --- | --- | --- |
| `maxConcurrentPositions` (DB `risk_config`) | `8` | 8 × 0,5 % Risiko = 4 % maximaler Gleichzeitverlust, unter dem Tageslimit von 5 % |
| `RISK_CLUSTER_LIMITS_MODE` | `enforce` | Mit 60/60 Symbolen frischer 1h-Historie ist der Guardrail belastbar; er verhindert, dass alle Slots in denselben hochkorrelierten Block gehen |
| `RISK_CORR_THRESHOLD` | `0.8` | Bei `0.7` verkettet Single-Linkage 37 von 60 Symbolen zu **einem** Cluster — der Guardrail hätte dann nur noch 4 Positionen insgesamt erlaubt. Bei `0.8` bleibt ein 14er-Block |
| `RISK_MAX_PER_CLUSTER` | `4` | Lässt die vollen 8 Slots zu, erzwingt aber Streuung über die weniger korrelierten Namen |
| `RISK_TIME_STOP_HOURS` | `48` | Hängende Positionen geben ihren Slot zurück, ohne auf SL/TP zu warten |
| `RISK_TRAILING_ENABLED` | `true` | Ab 1 % Gewinn bewaffnet der Monitor einen Ratchet-Stop; Vektor-Backtest (Trend: EV −0,49 vs −0,55 %/Trade bei fixer TP) und Literatur (ATR/Chandelier-Trailing) sprechen gegen den rein fixen TP-Ausstieg |
| `RISK_TRAILING_ACTIVATION_PCT` | `1.0` | Bewaffnung erst ab 1 % Gewinn — vorher bleibt der fixe SL/TP unangetastet |
| `RISK_TRAILING_RETURN_PCT` | `2.0` | 2 % Rückgabeweg statt Code-Default 0,5 %: bei 0,5 % riss der Ratchet im normalen Rauschen zu früh, der Backtest-Vorteil verschwand |
| `MICRO_BLOCKED_BACKOFF_MS` | `60000` | Eine dauerhaft geblockte Regel pausiert nach jedem Fehlversuch — sonst gewinnt sie jeden freien Slot und flutet das Journal |
| `ROUTING_DISABLED_PROVIDERS` | `ollama` | Auf dieser CPU-Box liefert das lokale 3b-Modell nicht einmal 8 Tokens in 90 s; der Makro-Zyklus nutzt den deterministischen Fallback |

Der Cluster-Guardrail wertet den **append-only HistoricalStore** aus (1h, 90
Kerzen ≈ 3,75 Tage). Sind die Daten älter als 24 h oder fehlt eine Serie,
lehnt `enforce` konservativ ab (`cluster-exposure:correlation-stale`) — das
ist gewollt, aber ein Signal für einen hängenden `market-sync`-Timer.

## Verwandte Dokumente

* [`OPERATIONS_CENTER.md`](OPERATIONS_CENTER.md) — Diagnose-Walkthrough und API-Vertrag des Operations Centers
* [`MARKET_DATA_PIPELINE.md`](MARKET_DATA_PIPELINE.md) — Discovery, Enrichment, Backfill, Readiness (§6)
* [`OBSERVABILITY.md`](OBSERVABILITY.md) — Marktdaten-Fehler, Firmen-Metriken, Auto-Circuit-Breaker, Alerts und Heartbeat (§9–12)
* [`ERROR_HANDLING_MARKETDATA.md`](ERROR_HANDLING_MARKETDATA.md) — Fehlertaxonomie und Behandlung
