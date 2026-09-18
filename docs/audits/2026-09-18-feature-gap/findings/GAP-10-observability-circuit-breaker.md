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
