# Broker-Architektur: Ausführbares Capability-Modell (Task 02)

**Stand:** v1.16.0 · **Scope:** `src/contracts/broker.ts`, `src/brokers/**`
(inkl. `control-plane/` seit Task 08), `src/lib/broker.ts`
(Registry-Projektion), `src/lib/engine.ts` (Factory-Nutzung),
`GET /api/brokers`, `GET /api/brokers/{venue}/health`,
`/api/brokers/{venue}/(credentials|status|test|discover)` (Task 08).

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

| Capability | PAPER | ALPACA | IBKR | BINANCE | KRAKEN | DYDX | BITUNIX |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `discovery` | ✅ | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ✅ |
| `marketData` | ✅ | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ✅ |
| `trading` | ✅ (simuliert) | ❌ (Soll: ✅ testnet→live) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ✅ (Paper; Live gesperrt) |
| `paper` | ✅ | ❌ (Soll: ✅, Venue bietet Paper-API) | ❌ (Soll: ✅) | ❌ | ❌ | ❌ (Venue ohne Paper) | ✅ (Modus B, echte Kurse) |
| `testnet` | ❌ | ❌ | ❌ | ❌ (Soll: ✅, Venue hat Testnet) | ❌ (Soll: ✅, Futures-Demo) | ❌ | ❌ (kein dokumentiertes Testnet) |
| `live` | ❌ (simuliert, nie live) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) | ❌ (Soll: nach Gate-Task) | ✅ Capability / ❌ Ausführung (LGTE bis task-11) |
| `instrumentTypes.spot` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `instrumentTypes.perpetual` | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `instrumentTypes.future` | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `instrumentTypes.option` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `stopAtVenue` (SL/TP am Order-Aufruf) | ❌ (SL/TP intern via Monitor) | ❌ (Soll: ✅ Bracket-Orders) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ❌ (Soll: ✅) | ✅ (`slPrice`/`tpPrice` im Place-Order) |

`stopAtVenue` ist für **Bitunix** wahr: Perpetuals mit Funding brauchen Stops,
die am Venue platziert werden, nicht nur lokal überwacht. Der Paper-Pfad merkt
SL/TP am Fill an, sendet sie aber nicht (keine Private-API). Details:
[BITUNIX.md](BITUNIX.md).

---

## 4. Factory-Fluss

```
getBroker(venue, mode = "paper")                     src/brokers/factory.ts
  │
  ├─ 1) Whitelist-Validierung (7 Venues, Groß/Trim)
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
         BITUNIX: BitunixBrokerAdapter (Paper gegen Public-Kurse)
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
("Registry-Projektion") bezeugt die Spiegelung für alle 7 Venues.
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
`tests/brokerFactory.test.ts`: 21 Einträge für die 21 nicht-Paper-Aufrufe
der 28er-Matrix, paper-Modus **ohne** Eintrag, alle Live-Ablehnungen auditiert.

---

## 7. API (read-only)

| Endpunkt | Antwort |
| --- | --- |
| `GET /api/brokers` | 7 Venues: `id`, `label`, `assets`, `capabilities`, `paperAvailable`/`liveAvailable` (Projektion), `executionModes`, `health` (lokal); `remoteHealthCheck.enabled` (Default false) |
| `GET /api/brokers/{venue}/health` | `health` (lokal bzw. remote je Flag), `capabilities`, `executionModes`, `remoteHealthCheck` |

Kein API-Token (konsistent mit den übrigen GET-Endpunkten), Fehler-Contract
`{ ok:false, error, message }` mit redigierter Meldung
(`publicErrorMessage`), 404 `UNKNOWN_VENUE` für fremde Venues.

---

## 8. Health-Checks & Remote-Flag

- **Lokal (Default):** PAPER → `online` (in-process, deterministisch);
  BITUNIX → `offline` solange `BITUNIX_ENABLED` nicht `"true"` (sonst `online`,
  Remote optional Public-Tickers); Stubs → `offline` + Grund `implemented:false`
  (ehrliche Ist-Lage — der Stub behauptet nicht, erreichbar zu sein).
- **Remote (nur `BROKER_HEALTHCHECK_REMOTE=true`):** read-only,
  credential-frei, 4 s Timeout. Implementiert: Binance Public `ping`,
  Kraken Public `Time`, Bitunix Public `tickers`. **Bewusst NICHT** implementiert
  (melden `degraded` mit Grund): ALPACA (`CREDENTIALS_REQUIRED`), IBKR
  (`GATEWAY_REQUIRED`), DYDX (`REMOTE_CHECK_NOT_IMPLEMENTED`) — kein Venue ohne
  verifizierten read-only Public-Endpunkt wird gecallt; ohne Credentials wird
  **nie** ein Request gestellt (getestet).
- Fehler werden redigiert zurückgeliefert (kein Host-/Credential-Leak).

---

## 9. Control Plane (Task 08): Credentials, Status, Zustandsebenen

Die Broker Control Plane (`src/brokers/control-plane/`) verwaltet
Broker-Credentials und liefert dem Frontend ausschließlich Status.
Details: [FRONTEND_CONTROL_PLANE.md](FRONTEND_CONTROL_PLANE.md).

- **Secret-Store:** AES-256-GCM mit **AAD = Venue-ID**, Schlüssel nur aus
  Env/KMS (`SECRET_STORE_KEY`, KMS-Hook vorbereitet). Backends: DB
  (`broker_credentials`, verschlüsselte Envelopes) → Datei-Fallback →
  Memory (Tests). Task-07-Bridge `createVenueBackedNamedStore` bedient das
  task-07-`SecretStore`-Interface.
- **API (status-only):** `POST/DELETE /api/brokers/{venue}/credentials`,
  `GET /api/brokers/{venue}/status`, `POST …/test`, `POST …/discover`.
  Antworten enthalten NIE Secrets, keinen `keyHint`, keine Maskierung.
- **Zustandsmodell:** 6 Ebenen (connection, marketDiscovery, permissions,
  paper, testnet, live) × off/pending/active/error; Übergänge nur über
  `save|test|discover|disable`, Missbrauch → 409/422.
  **Live bleibt immer off** — `liveEnabled` kommt ausschließlich aus der
  Gate-Service-Meldung (`readGateState()`), bis task-11 hart `false`.
- **Sicherheit:** Admin-Guard (RBAC-Platzhalter, TODO(task-10)), CSRF
  (`x-csrf-token`), Credential-Rate-Limit (5/min/IP), Audit je Ereignis
  (`BROKER_CONTROL_PLANE`), Response-/Bundle-Secret-Scanner in CI.

## 10. Ausbaupfad (Folge-Tasks)

| Task | Inhalt |
| --- | --- |
| Adapter-Ausbau (03+) | Venue-Adapter ersetzen die Stubs: Discovery (TODO(task-02/07)), Marktdaten, Trading; Capabilities schrittweise auf true — Gating/Factory/Audit bleiben unverändert |
| Control Plane (Task 08) | **umgesetzt:** Credential-Manager + verschlüsselter Secret-Store + „Brokers & Venues"-UI; Live bleibt LGTE. Doku: [FRONTEND_CONTROL_PLANE.md](FRONTEND_CONTROL_PLANE.md) |
| RBAC-Zentralisierung (Task 10) | Session-/Rollensystem ersetzt den minimalen Admin-Guard der Control Plane (`TODO(task-10)` in `src/brokers/control-plane/guard.ts`) |
| Live-Trading-Gate | State-Machine + Hard-Gates; öffnet `mode="live"` **erst** nach Freigabe; `LiveTradingGateError` wird dann durch die Gate-Prüfung ersetzt; ab dann liefert `readGateState()` der Control Plane die echte Live-Anzeige |
| Bitunix-Adapter (Task 07) | **umgesetzt:** `src/brokers/bitunix/`, `stopAtVenue: true`, Paper-Modus B; Live bleibt LGTE bis task-11. Doku: [BITUNIX.md](BITUNIX.md) |

## 11. Verweise

- Contracts: `src/contracts/broker.ts` · Factory: `src/brokers/factory.ts`
- Capability-SSoT: `src/brokers/capabilities.ts` · Audit: `src/brokers/audit.ts`
- Control Plane: `src/brokers/control-plane/` · `docs/FRONTEND_CONTROL_PLANE.md`
- Security: `docs/SECURITY_AUDIT.md` (Kapitel "Security Audit — Task 02" / Task 07 / Task 08)
- Universum: `docs/MARKET_UNIVERSE.md` (Task 01) · `MarketInstrument`-Contract: `src/universe/types.ts`
- Bitunix: `docs/BITUNIX.md`
