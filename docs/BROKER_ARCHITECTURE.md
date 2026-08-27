# Broker-Architektur: Ausführbares Capability-Modell (Task 02)

**Stand:** v1.10.0 · **Scope:** `src/contracts/broker.ts`, `src/brokers/**`,
`src/lib/broker.ts` (Registry-Projektion), `src/lib/engine.ts` (Factory-Nutzung),
`GET /api/brokers`, `GET /api/brokers/{venue}/health`.

Dieses Dokument ist der verbindliche Vertrag für alle Broker-Adapter der
Plattform. Es ersetzt die reine Capability-Dokumentation der alten
`BROKER_REGISTRY`: Die Flags sind jetzt **ausführbar** (Gating),
**projiziert** (Registry = Ableitung) und **auditiert**.

---

## 1. Die vier harten Regeln

1. **Decoupling:** Broker-spezifische Details (REST-Formate, Auth, Symbole)
   existieren ausschließlich im jeweiligen Adapter. Der Kern (engine, risk,
   agents, API) kennt nur `BrokerAdapter` aus `src/contracts/broker.ts`.
2. **Execution Modes als erstklassiges Konzept** — feste Semantik (s. §2),
   kein implizites Verhalten.
3. **Fail-Safe:** `getBroker(venue, "live")` wirft standardmäßig **IMMER**
   `LiveTradingGateError`. Es gibt keinen stillschweigenden Fallback auf
   Paper. Der Live-Pfad wird erst durch den Live-Trading-Gate-Task
   (State-Machine + Hard-Gates) geöffnet.
4. **Kein Netzwerkverkehr zu echten Brokern** in dieser Stufe — ausnahme:
   read-only Health-Checks hinter `BROKER_HEALTHCHECK_REMOTE` (Default OFF).
5. **Audit:** Jeder Factory-Aufruf mit `mode != "paper"` landet im Audit-Log
   (venue, mode, Ergebnis, UTC-Zeitstempel).

---

## 2. Execution-Mode-Tabelle

| Modus | Kurs | Order | Verwendet |
| --- | --- | --- | --- |
| `backtest` | historisch | **simuliert** | Regel-Backtests, Strategie-Validierung |
| `paper` | real (Rezeit, Fallback statisch) | **simuliert** | Betrieb heute (Standard der Firma) |
| `testnet` | real (Testnet) | **Broker-Order** | geplante Adapter-Ausbau-Stufe |
| `live` | real | **reale Order** | **hart gesperrt** (Live-Gate-Task) |

Gating: `backtest`/`paper` verlangen `capabilities.paper` (simulierte Order),
`testnet` verlangt `capabilities.testnet`, `live` wird **vor** jeder
Capability-Prüfung durch `LiveTradingGateError` gestoppt (Tabelle in
`src/brokers/capabilities.ts` → `REQUIRED_CAPABILITY_BY_MODE`).

---

## 3. Capability-Matrix (Ist / Soll)

Die Flags beschreiben, was der **Adapter-Code dieses Repos** aktuell
ausführt — nicht, was der Broker-Anbieter bewirbt (Venue-Angebote bleiben
als Doku in `BROKER_REGISTRY`: `label`, `assets`, `paperApi`, `note`).

| Capability | PAPER | ALPACA | IBKR | BINANCE | KRAKEN | DYDX |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| `discovery` | ✅ | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) |
| `marketData` | ✅ | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) |
| `trading` | ✅ (simuliert) | ❌ (Soll: ✅ testnet→live) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) |
| `paper` | ✅ | ❌ (Soll: ✅, Venue bietet Paper-API) | ❌ (Soll: ✅) | ❌ | ❌ | ❌ (Venue ohne Paper) |
| `testnet` | ❌ | ❌ | ❌ | ❌ (Soll: ✅, Venue hat Testnet) | ❌ (Soll: ✅, Futures-Demo) | ❌ |
| `live` | ❌ (simuliert, nie live) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) |
| `instrumentTypes.spot` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `instrumentTypes.perpetual` | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `instrumentTypes.future` | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| `instrumentTypes.option` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `stopAtVenue` (SL/TP am Order-Aufruf) | ❌ (SL/TP intern via Monitor) | ❌ (Soll: ✅ Bracket-Orders) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (**Soll: ✅ — wichtig für Bitunix**) |

`stopAtVenue` ist der Ausbaupfad für den späteren **Bitunix-Adapter**:
Perpetuals mit Funding brauchen Stops, die am Venue platziert werden, nicht
nur lokal überwacht. Das Flag ist Teil des Contracts, damit der neue Adapter
von Anfang an kompatibel ist.

---

## 4. Factory-Fluss

```
getBroker(venue, mode = "paper")                     src/brokers/factory.ts
  │
  ├─ 1) Whitelist-Validierung (6 Venues, Groß/Trim)
  │      └─ unbekannt → UnknownVenueError  ──► Audit (DENIED, UNKNOWN_VENUE)
  │
  ├─ 2) mode === "live"?
  │      └─ JA → LiveTradingGateError (IMMER)  ──► Audit (DENIED, LIVE_TRADING_GATE)
  │
  ├─ 3) Capability-Gating: REQUIRED_CAPABILITY_BY_MODE[mode]
  │      └─ fehlt → NotSupportedCapabilityError  ──► Audit (DENIED, NOT_SUPPORTED_CAPABILITY)
  │
  └─ 4) OK → Adapter aus Cache (je venue:mode) oder frisch erzeugen
         PAPER: teilt den Prozess-Singleton-Ledger (paperBrokerLedger())
         ──► Audit (OK) nur bei mode != "paper"
```

**Singleton-Semantik:** Der PAPER-Ledger (`PaperBroker`) ist prozessweit
einzig. `backtest`- und `paper`-Instanzen desselben Venues teilen ihn — es
entsteht nie eine zweite, unhydratierte Buchhaltung. Die Engine
hydratiert denselben Ledger aus PostgreSQL (offene Positionen, Cash-Hint,
Kill-Switch) — unverändert aus v1.1.0/v1.5.2.

**Registry-Projektion:** `BROKER_REGISTRY` (src/lib/broker.ts) leitet
`paperAvailable = capabilities.paper` und `liveAvailable = capabilities.live`
über `projectCapabilityFlags()` ab. **Single Source of Truth = Adapter**;
die Registry ist eine Projektion. `tests/brokerFactory.test.ts`
("Registry-Projektion") bezeugt die Spiegelung für alle 6 Venues.
Das alte Feld `paperApi` bleibt als **Venue-Angebot** (Vendor-Fakt, Doku) —
es ist kein Ausführungsversprechen.

---

## 5. Fehlerklassen (`src/contracts/broker.ts`)

| Klasse | Code | Trigger | Verhalten |
| --- | --- | --- | --- |
| `LiveTradingGateError` | `LIVE_TRADING_GATE` | `mode === "live"` (jedes Venue) | wird immer geworfen; laut, auditierbar; **kein Fallback** |
| `NotSupportedCapabilityError` | `NOT_SUPPORTED_CAPABILITY` | fehlende Capability (Factory) oder capability=false (Adapter-Methode) | enthält Venue, Capability, Methode, optionalen Hinweis |
| `UnknownVenueError` | `UNKNOWN_VENUE` | Venue außerhalb der Whitelist | Input-Validierung; Fremd-Input wird auf 40 Zeichen gekürzt |

Alle drei erben von `BrokerError` (maschinenlesbarer `code`-Feld). Die
Meldungen enthalten bewusst **keine** Credentials, Connection-Strings oder
Infrastruktur-Details (Security-Regel, getestet in der Contract-Suite).

**Adapter-Methoden und Capability:** `discoverInstruments` → `discovery`,
`getTicker`/`getCandles` → `marketData`, `getAccount`/`placeOrder`/
`getPositions` → `trading`. Werfen bei capability=false deterministisch.
Stubs markieren offene Entwicklung mit `TODO(task-02/07)` + Verweis auf
den Contract in der Meldung.

---

## 6. Audit (Regel 5)

`src/brokers/audit.ts`, zweistufig (Muster des Universe-Audits):

1. **In-Memory-Ring** (200 Einträge) — immer verfügbar, deterministisch
   testbar, überlebt DB-Ausfall.
2. **`audit_log`** (Event `BROKER_FACTORY`, best-effort via Drizzle) —
   DB-Ausfall bricht den Factory-Pfad **nie** ab (Fail-Safe).

Eintrag: `{ venue, mode, outcome: OK|DENIED, capability, errorCode, at }` —
nur diese Felder (keine Order-Daten, keine Kurse). Geprüft in
`tests/brokerFactory.test.ts`: 18 Einträge für die 18 nicht-Paper-Aufrufe
der Matrix, paper-Modus **ohne** Eintrag, alle Live-Ablehnungen auditiert.

---

## 7. API (read-only)

| Endpunkt | Antwort |
| --- | --- |
| `GET /api/brokers` | 6 Venues: `id`, `label`, `assets`, `capabilities`, `paperAvailable`/`liveAvailable` (Projektion), `executionModes`, `health` (lokal); `remoteHealthCheck.enabled` (Default false) |
| `GET /api/brokers/{venue}/health` | `health` (lokal bzw. remote je Flag), `capabilities`, `executionModes`, `remoteHealthCheck` |

Kein API-Token (konsistent mit den übrigen GET-Endpunkten), Fehler-Contract
`{ ok:false, error, message }` mit redigierter Meldung
(`publicErrorMessage`), 404 `UNKNOWN_VENUE` für fremde Venues.

---

## 8. Health-Checks & Remote-Flag

- **Lokal (Default):** PAPER → `online` (in-process, deterministisch);
  Stubs → `offline` + Grund `implemented:false` (ehrliche Ist-Lage — der
  Stub behauptet nicht, erreichbar zu sein).
- **Remote (nur `BROKER_HEALTHCHECK_REMOTE=true`):** read-only,
  credential-frei, 4 s Timeout. Implementiert: Binance Public `ping`,
  Kraken Public `Time`. **Bewusst NICHT** implementiert (melden `degraded`
  mit Grund): ALPACA (`CREDENTIALS_REQUIRED`), IBKR (`GATEWAY_REQUIRED`),
  DYDX (`REMOTE_CHECK_NOT_IMPLEMENTED`) — kein Venue ohne verifizierten
  read-only Public-Endpunkt wird gecallt; ohne Credentials wird **nie**
  ein Request gestellt (getestet).
- Fehler werden redigiert zurückgeliefert (kein Host-/Credential-Leak).

---

## 9. Ausbaupfad (Folge-Tasks)

| Task | Inhalt |
| --- | --- |
| Adapter-Ausbau (03+) | Venue-Adapter ersetzen die Stubs: Discovery (TODO(task-02/07)), Marktdaten, Trading; Capabilities schrittweise auf true — Gating/Factory/Audit bleiben unverändert |
| Live-Trading-Gate | State-Machine + Hard-Gates; öffnet `mode="live"` **erst** nach Freigabe; `LiveTradingGateError` wird dann durch die Gate-Prüfung ersetzt |
| Bitunix-Adapter | nutzt `stopAtVenue: true` (SL/TP am Order-Aufruf) + `perpetual: true`; neue Venue = neuer Capability-Eintrag + Adapter |

## 10. Verweise

- Contracts: `src/contracts/broker.ts` · Factory: `src/brokers/factory.ts`
- Capability-SSoT: `src/brokers/capabilities.ts` · Audit: `src/brokers/audit.ts`
- Security: `docs/SECURITY_AUDIT.md` (Kapitel "Security Audit — Task 02")
- Universum: `docs/MARKET_UNIVERSE.md` (Task 01) · `MarketInstrument`-Contract: `src/universe/types.ts`
