# Task 11 — Live Trading Gate: Implementierungsplan

**Ziel:** Eine zentrale, auditierte State-Machine als EINZIGEN Weg, Live-Trading
jemals freizuschalten. Dieser Task **aktiviert kein Live** — nach Merge bleibt
Live OFF (kein State-File, alle Flags false, Suite-Stamp nur aus CI).

## 1. Zustands-/Check-Tabelle (kanonisch)

| # | Von → Nach | Bedingung (automatisch geprüft) | Prüfer |
| --- | --- | --- | --- |
| 1 | DISCONNECTED → CONNECTED | Verbindungstest des Venue-Adapters (healthCheck, lokal) | Check `connectivity` (BrokerGatePort) |
| 2 | CONNECTED → MARKET_DATA_OK | Read-Only-Market-Data-Check (ein Public-Ticker des Venues) | Check `marketData` |
| 3 | MARKET_DATA_OK → ACCOUNT_READ_OK | Read-Only-Account-Read (Control-Plane-Probe, status-only) | Check `accountRead` |
| 4 | ACCOUNT_READ_OK → ORDER_TEST_OK | Testnet-/Test-Order-Prüfung — NUR simuliert/Mock, nie echte Order | Check `orderTest` (Default: fail-closed, kein Testnet dokumentiert) |
| 5 | ORDER_TEST_OK → PAPER_APPROVED | Paper-Kriterien: ≥ `LIVE_GATE_PAPER_MIN_ORDERS` (Default 50) fehlerfreie Paper-Orders | Check `paperCriteria` |
| 6 | PAPER_APPROVED → LIVE_PENDING | Admin-Antrag: Zweck + Grund (Pflichtfeld) → startet Cooldown-Timer | Policy im Service |
| 7 | LIVE_PENDING → HUMAN_APPROVED | Human Gate: Admin-Aktion + `confirm:true` + Grund + Approver; Cooldown `LIVE_GATE_COOLDOWN_MS` (Default 24 h) abgelaufen; 4-Augen (`LIVE_GATE_FOUR_EYES=true`: zwei versch. Approver) | Policy im Service |
| 8 | HUMAN_APPROVED → LIVE_ENABLED | `confirm:true` + Grund + Flags (LIVE_TRADING_ENABLED, `{VENUE}_ENABLED`, `{VENUE}_LIVE_ENABLED`) + Capability `live` + Security-Suite-Stamp gültig + Control-Plane-Venue aktiv | Enforcer-Prerequisites |

Explizite Downgrade-Aktionen (keine Matrix-Übergänge): `disable` (→ DISCONNECTED,
Admin, Grund pflicht) und `kill` (jeder Zustand → DISCONNECTED + persistente
Sperrdatei). Disconnect-Fehlerpfade: Checks fehlgeschlagen → Zustand bleibt,
Transition wird als DENIED auditiert; Crash → halboffene Transition wird als
ABORTED auditiert (Zustand bleibt beim `from`).

## 2. Architektur / Module

```
src/live-gate/
  config.ts       Env-Flags + Policy-Version (alles fail-closed)
  states.ts       9 Zustände, 8 legalen Übergänge (Matrix), LiveGateError
  audit.ts        Append-only-NDJSON + Hash-Kette (sha256 über kanonisches JSON,
                  jeder Eintrag enthält Hash des Vorgängers) + Ring + DB best-effort
  store.ts        Per-Venue-State-File, atomar (tmp+fsync+rename), Crash-Recovery
  checks.ts       Interface TransitionCheck + BrokerGatePort (venue-agnostisch)
                  + Default-Port (read-only, offline-sicher, fail-closed)
  enforcer.ts     SINGLE POINT OF ENFORCEMENT: evaluate/assertLiveOrderAllowed
  service.ts      LiveGateService: transition/disable/kill/clearKill/history
  suite.ts        Security-Suite-Stamp (data/live-gate/security-suite.json, CI-Artefakt)
  controlPlaneBridge.ts  registriert Venue-Readiness (Control-Plane aktiv) beim Enforcer
  index.ts        Runtime-Singleton (je Data-Dir) + Test-Resets
```

## 3. Enforcement-Integrationspunkte (Single Point)

1. `src/brokers/factory.ts` — `getBroker(venue, "live")` ruft Enforcer statt
   blind `LiveTradingGateError` (Verhalten default identisch: deny).
2. `src/brokers/bitunix/gates.ts` — `assertLiveOrderAllowed` delegiert an den
   Enforcer (ersetzt `TODO(task-11)`-Stubs); Adapter-Rest live-Pfade unverändert.
3. `src/brokers/control-plane/states.ts` — `readGateState(venue)` liest den
   Enforcer-Entscheid (`liveEnabled` bleibt Anzeige, kein Schalter).
4. `src/auth/ops.ts` — Live-Chip-/Ops-Payload aus der Machine (aggregiert).

Erlaubt ist eine Live-Order NUR wenn ALLES gilt: State=LIVE_ENABLED ∧
LIVE_TRADING_ENABLED=true ∧ `{VENUE}_ENABLED` ∧ `{VENUE}_LIVE_ENABLED ∧
(REQUIRE_HUMAN_APPROVAL=false ∨ State ≥ HUMAN_APPROVED) ∧ Suite-Stamp gültig ∧
Control-Plane-Venue aktiv ∧ kein Kill (Memory/Datei). Bei jedem Zweifel: deny +
Audit. PAPER kann nie live (Capability false).

## 4. Persistenz-Design

- `data/live-gate/venue-{VENUE}.json` — State + pendingTransition (Intent) +
  livePendingAt (Cooldown) + pendingApproval (4-Augen) + killed-Marker +
  History-Zähler + Audit-Head (Hash) für Truncation-Erkennung.
- `data/live-gate/audit-log.ndjson` — Hash-Kette (Genesis prevHash=0^64).
- `data/live-gate/kill-switch.json` — NDJSON-Failsafe-Sperrdatei (wirkt auch bei
  DB-Ausfall; wird VOR dem State-Reset geschrieben).
- `data/live-gate/security-suite.json` — CI-Stamp ({passed, runId, sha, at}).
- Alles atomar (tmp+fsync+rename), Lese-Fehler → fail-safe DISCONNECTED +
  Crash-Recovery-Audit. `LIVE_GATE_DATA_DIR` übersteuerbar (Tests/Deploy).

## 5. API / CLI / CI

- `GET /api/live/state` (Zustand je Venue, Flags, Suite, Kill, Audit-Head).
- `POST /api/live/transition` (Permission `live.gate`, CSRF, Rate-Limit 5/min).
- `POST /api/live/kill` (Admin + Confirm-Phrase `KILL` serverseitig; `action:"clear"` + `CLEAR_KILL`).
- CLI: `npm run live:kill -- --venue=BITunix [--scope=all] [--reason=…] [--clear]`.
- CI: `.github/workflows/security-live-gate.yml` → Typecheck, Lint,
  `npm run security:live-gate` (Matrix-/Kill-Drill-/Red-Team-/E2E-Tests +
  Coverage-Tor ≥ 95 % Zeilen auf `src/live-gate/**`), Secret-Scan, Suite-Stamp.
  Merge-Blockade über Required-Check `security-live-gate` (Branch Protection).

## 6. Abweichungen von der Aufgabenstellung

- Branch heißt `arena/01a0498d-ai-trading-firm` (Arena-Session-Zweig), Funktion
  und PR-Titel entsprechen `feature/task-11-live-trading-gate`.
- `docs/ARENA_TASKS.md` existierte nicht → wird mit Task-Statusliste neu angelegt.
- Human-Gate-Approver: 4-Augen über benannte Approver-Strings (ein Admin-Token
  im RBAC-Kern → echte Zwei-Personen-Enforcement braucht task-12-Rollen).
