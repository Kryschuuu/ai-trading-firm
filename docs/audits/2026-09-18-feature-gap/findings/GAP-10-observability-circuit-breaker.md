# GAP-10 — Observability & automatische Circuit-Breaker

**Nutzen:** ★★★★ · **Aufwand (Co-Audit):** 🔧🔧 · **Aufwand (verifiziert):** 🔧🔧
**Kategorie:** Betrieb · **Prompt:** [`PROMPT-10`](../prompts/PROMPT-10-observability-circuit-breaker.md)

## Befund (Co-Audit)

Der Kill-Switch ist heute manuell — bei einem Bug um 3 Uhr nachts hilft nur
ein Automat. Metriken machen Performance-Drift sichtbar, bevor sie teuer wird.
Contra: Alert-Fatigue; der Watchdog ist selbst ein Single Point of Failure und
muss getrennt laufen.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/lib/telemetry.ts`: LabelCounter + `prometheusMetrics()` — aktuell nur
  Marktdaten-Fehler; Ops-Center (`/api/ops`) aggregiert 10 echte Sektionen;
  `riskGuard` kennt `maxEquityDrawdownPct`/`dailyLossLimitPct` als Order-Pfad-
  Grenzen; `/api/health` existiert.
- **Aber:** keine Firmen-Metriken (Equity/Drawdown/Fill-Rate/Rejects/
  LLM-Latenz) im Metrik-Endpunkt, **kein automatischer** Kill-Switch bei
  Limit-Bruch (Grenzen blockieren nur neue Orders), kein Alerting, kein
  Heartbeat/Stale-Alarm für den Monitor-Tick.

## Delta

1. `prometheusMetrics()` um Firmen-Metriken erweitern — ausschließlich aus
   bestehenden Stores (DB/PaperBroker/Telemetrie), keine Geschäftslogik-
   änderung, keine Secrets in Labels.
2. **Auto-Circuit-Breaker:** Verletzung von Tages-/Equity-Drawdown-Limit oder
   N Verluste in Folge → bestehende Kill-Switch-Infrastruktur ENGAGE (Audit
   mit Auslöser+Kennzahl); Re-Arm weiterhin ausschließlich über den
   manuellen Disarm-Pfad (Challenge-Nonce bleibt unverändert!).
3. Alert-Adapter-Interface + Log-/Datei-Implementierung; optionale
   Telegram/Webhook-Anbindung nur über Secret-Store (nie Klartext-Env im
   Log), Default aus.
4. Heartbeat: `/api/health` meldet Monitor-Staleness (`lastTickAt`);
   dokumentierte Runbook-Ergänzung; getrennter Watchdog-Prozess nur als
   optionales Skript (`scripts/watchdog.ts`, alarm-first, kein Auto-Restart).

## Akzeptanzkriterien (kurz)

Metrik-Snapshot-Tests, Breaker-Trigger-Test (simulierter Drawdown → Kill-Switch
ENGAGE + Audit), Re-Arm-Verweigerung ohne Challenge, Heartbeat-Stale-Test,
Alert-Fatigue-Schutz (Debounce/Hysterese) getestet.

## Umsetzung (v1.45.0, 2026-09-18)

- **D1 Firmen-Metriken:** `prometheusMetrics()` (`src/lib/telemetry.ts`) ist
  jetzt `async` und liest ausschließlich **bestehende** Stores: Paper-Ledger
  (Equity, `drawdownPct` — dieselbe Rechnung wie der Brecher —, offene
  Positionen, `realizedPnlToday()`), Fallback jüngster
  `equity_snapshots`-Eintrag, plus In-Memory-Counter aus `src/lib/broker.ts`
  (Fills/Rejects, `classifyRejectReason`) und `src/routing/adapter.ts`
  (LLM-Aufrufe/Latenz, an der Stelle gemessen, an der die Latenz ohnehin
  anfällt). Neue Reihen: `firm_equity`, `firm_drawdown_pct`,
  `firm_open_positions`, `firm_realized_pnl_today`,
  `firm_metric_source{source}`, `firm_order_fills_total{kind,reason}`,
  `firm_order_rejects_total{reason}`, `llm_calls_total{provider,outcome}`,
  `llm_latency_ms_sum{provider}`. Labels sind ausschließlich klassifizierte
  Codes (`metricLabel()`-Whitelist; Rohgründe wie
  `POSITION_ALREADY_OPEN:SOL` werden auf die Code-Klasse geschnitten), keine
  Secrets/PII. Nicht lesbarer Firmenzustand ⇒ betroffene Metriken
  **weggelassen** + `# HELP … degraded: <grund>` (bewusst kein erfundener
  0-Wert), nie Throw/Hang. **Rest-Delta:** weiterhin kein
  HTTP-Scrape-Endpoint (Exposition nur über die Funktion).
- **D2 Auto-Circuit-Breaker:** `src/lib/circuitBreaker.ts` — Auslöser in der
  Priorität Drawdown (`drawdownPct >= maxEquityDrawdownPct`) → Tagesverlust
  (`dailyLossPct >= dailyLossLimitPct`) → Verlustserie
  (`RISK_MAX_CONSECUTIVE_LOSSES`, Default 5, Bounds [2, 50], Clamp mit
  Warnung). Flag `AUTO_CIRCUIT_BREAKER` Default **on**; unbekannter Wert ⇒
  Default + Warnung (kein stilles Abschalten). Aktion über den **bestehenden**
  Kill-Switch-Pfad: `killSwitch.pull(reason)`, `kill_switches`-Zeile
  (`triggeredBy = AUTO_CIRCUIT_BREAKER`, best effort), `KILL_SWITCH`-Audit
  (CRITICAL) mit fixiertem Auslösewert (`metric`, `value`, `limit`,
  `triggeredAt`, `drawdownPct`, `dailyLossPct`, `consecutiveLosses`) —
  Audit-Lücke wird gemeldet (`flagMissedAudit`), blockiert den Engage aber
  nicht (die sichere Richtung zu verweigern wäre gefährlicher) —, Alert
  `circuit-breaker:<metrik>` (critical). Grund stabil maschinenlesbar:
  `auto-circuit-breaker:<metrik>:<wert>` (Dezimalanteil 4 Nachkommastellen
  bzw. Ganzzahl). **Latching:** Latch wird synchron vor dem ersten `await`
  gesetzt; weitere Ticks ändern nichts; fällt erst, wenn der Mensch über den
  unveränderten Disarm-Pfad (Admin `live.gate` + CSRF + single-use Nonce
  ≤ 60 s) entschärft hat. Keine Auto-Re-Arm-Logik, keine Hysterese, kein
  Timer; Triggerwert im Audit fixiert. Nicht lesbare Verlustserie ⇒ **kein**
  Serien-Trigger. `checkCircuitBreaker()` wirft nie; Probleme stehen in
  `errors`. Abweichung zum Ist-Stand: der Tagesverlust-Auto-Pull existierte
  bereits inline im Monitor-Tick und ist jetzt der zentrale Schritt 3
  (`TickResult.circuitBreaker`); der Drawdown-Auto-Pull im Engine-Zyklus
  (`src/lib/engine.ts`, l. ~516) bleibt **unverändert** → beide Pfade können
  denselben Kill-Switch ziehen (harmlos, aber zwei Gründe im Audit) —
  bewusst als Rest-Delta dokumentiert, um D2 ohne Engine-Umbau zu liefern.
- **D3 Alert-Adapter:** `src/lib/alerts.ts` — `AlertSink`-Interface,
  `LogAlertSink` (strukturiert/redigiert im `logger.ts`-Muster),
  `FileAlertSink` (append-only NDJSON `data/alerts.ndjson` über
  `resolveRuntimePath()`, Modus 0600) und optionaler `WebhookAlertSink`
  (Default aus; Credential ausschließlich aus dem Secret-Store über
  `ALERT_WEBHOOK_URL_SECRET_NAME`, Feld `apiKey`, Timeout 5 s; Nicht-OK →
  `webhook: HTTP <status>`, URL/Token nie in der Meldung). Debounce:
  identischer `alert.code` höchstens einmal je `ALERT_DEBOUNCE_MINUTES`
  (Default 30, Bounds [1, 1440]); unterdrückte Alarme werden gezählt und als
  `meta.suppressedSinceLast` ausgewiesen. `AlertDispatcher.emit()` wirft nie.
- **D4 Heartbeat:** `src/lib/heartbeat.ts` + `/api/health`
  (`monitorLastTickAt`, `monitorAgeMs`, `stale`, `staleAfterMs`; Statuscode
  bleibt 200, DB-frei lesbar): `stale = Alter > HEALTH_STALE_AFTER_MS`
  (Default 300 000, Bounds [30 000, 3 600 000]); nie getickt ⇒ stale.
  `scripts/watchdog.ts` (`npm run watchdog`) ist **alarm-first**: ein Lauf,
  kein Daemon, kein Auto-Restart/Kill; Quellen `http` (Default
  `http://127.0.0.1:$PORT/api/health`) und `inprocess`; Alerts
  `heartbeat-stale`, `heartbeat-health-unreachable`,
  `heartbeat-health-unreadable`; Exit 0/1/2.
- **Tests:** `tests/telemetry.firm.test.ts` (6), `tests/circuitBreaker.test.ts`
  (12, inkl. D2 (a)–(e), Priorität, NaN-Serie, Audit-Lücke, Source-Scan
  „kein Disarm im Modul“, Route verlangt Nonce — mit CSRF-Header `x-csrf-token` (lokaler Beispielwert `local`),
  weil der CSRF-Guard **vor** der Nonce-Prüfung greift),
  `tests/alertSink.test.ts` (8, inkl. Debounce/`suppressedSinceLast`,
  Sink-Fehler, Secret-Store-Mock) und `tests/health.heartbeat.test.ts`
  (5, Fake-Clock-Grenzen `>`-Semantik, `HEALTH_STALE_AFTER_MS`-Clamp,
  Health-Payload). Bestehende Suiten (`liveGate.*`, `disarmChallenge`,
  `auditView`, `monitor.exits`, `broker`, `auditReliability`) unverändert
  grün — der Disarm-Vertrag wurde nicht angetastet.
- **Docs/Meta:** `docs/OBSERVABILITY.md` (Status-Header + §9–12),
  `docs/OPERATIONS.md` (Runbook „Auto-Breaker hat ausgelöst“, Status-Header),
  `CONFIGURATION.md` + `.env.example` (neue Flags mit Defaults/Bounds),
  `CHANGELOG.md` 1.45.0 (Verhaltensänderung explizit), `docs/README.md`,
  diese Tabelle (`remediation/TRACKING.md`).
- **Offene Punkte (bewusst nicht in diesem Release):** `/api/metrics`-Read
  mit `firm.read` (Kontodaten = sensibler Read) statt Funktions-Exposition;
  Hysterese/Cooldown für den Brecher (heute bewusst Latching ohne Hysterese);
  Alert-Zustellung jenseits von Log/Datei/Webhook (Telegram/E-Mail);
  Zusammenführung des Engine-Drawdown-Pulls mit dem zentralen Brecher.
