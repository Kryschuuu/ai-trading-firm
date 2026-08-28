# Peer-Review: Bitunix-Ausführungs-Refactor (Paper ⇄ Live)

**Datum:** 2026-08-28
**Reviewer-Rolle:** Senior Backend Engineer — TypeScript, Broker-Integration,
Systemarchitektur
**Branch:** `arena/01a04a4f-ai-trading-firm`
**Betroffene Version:** v1.20.0
**Scope:** `src/brokers/bitunix/**`, `src/contracts/broker.ts`,
`src/universe/**`, `src/brokers/capabilities.ts`, Doku, Tests

---

## 1. Befunde (Review-Input)

Der Bitunix-Adapter (Task 07) wies nach der Live-Gate-Integration (Task 11)
drei funktionale bzw. semantische Fehler auf:

1. **Live-Modus handelte weiterhin über das Paper-Ledger.**
   In `src/brokers/bitunix/adapter.ts` wurde der Live-Gate geprüft und
   durchgelassen, aber danach kam `return this.paper.submit(req, ticker)` —
   nie `BitunixPrivateClient.placeSerializedOrder`. Der Private Client war
   implementiert, wurde aber im Live-Pfad nie aufgerufen.
   Sobald alle Gates tatsächlich freigegeben wären, hätte das System weiter
   lokal simuliert statt real gehandelt.
2. **`getAccount()` / `getPositions()` im Live-Modus lieferten Paper-Daten.**
   Dasselbe Muster (`this.paper.getAccount` / `this.paper.listPositions`).
   Ein Live-System darf niemals lokale Paper-Positionen als Live-Broker-Daten
   zurückgeben — gefährlicher als ein kosmetischer Fehler.
3. **`liveAvailable` ist semantisch mehrdeutig.**
   Drei Konzepte waren vermischt: (a) Broker kann Live-Orders serialisieren
   (`adapterCapabilities.live`), (b) Instrument kann live gehandelt werden
   (Instrument-Fähigkeit), (c) Live-Trading ist aktuell freigegeben
   (`venueControl.liveEnabled` / `liveGate.state`).

---

## 2. Umsetzung (Korrektur)

### 2.1 `ExecutionPort` — Paper und Broker getrennt

Neu: `src/brokers/bitunix/execution.ts` definiert einen Ausführungs-Port mit
**zwei Implementierungen derselben Schnittstelle**:

```
ExecutionMode
 ├── paper / backtest ─► PaperExecutionEngine    (lokales Ledger, 0 Private-Calls)
 └── live              ─► BrokerExecutionEngine   (echte Venue-API, signiert)
                            └── LiveGate (Task 11) → BitunixPrivateClient
```

- `PaperExecutionEngine` umhüllt `BitunixPaperLedger`.
- `BrokerExecutionEngine` umhüllt `BitunixPrivateClient` (`placeSerializedOrder`,
  `getAccount`, `getPositions`).

Der Adapter (`src/brokers/bitunix/adapter.ts`) wählt die Engine anhand des
Modus. Live-Methoden prüfen zuerst das zentrale Live-Gate (Task 11) und
delegieren danach **ausschließlich** an die Broker-Engine. Der Live-Pfad
berührt das Paper-Ledger nie mehr.

### 2.2 Semantik-Trennung der Live-Konzepte

- `adapterCapabilities.live` — Adapter kann Live-Orders serialisieren.
- `instrumentCapabilities.liveTradable` — **neu** auf `MarketInstrument`:
  Instrument ist beim Broker live-handelbar.
- `venueControl.liveEnabled` — globale Freigabe der Control Plane.
- `liveGate.state` — persistierter Gate-Zustand; öffnet erst die Ausführung.
- `liveAvailable` bleibt als abwärtskompatibler Spiegel (deprecated), von der
  Normalisierung aus `liveTradable` synchron gehalten.

Bitunix-Mapping: `liveTradable=true`, `liveAvailable=false`.

### 2.3 Keine Breaking Changes

- Paper/backtest: unverändert `PaperExecutionEngine` (Modus B, 0 Private-Calls).
- testnet: unverändert `NotSupportedCapabilityError`.
- live ohne bestandene Gate-Prüfung: unverändert `LiveTradingGateError`
  (kein stiller Fallback).

---

## 3. Reviewer-Checkliste & Ergebnis

| Prüfpunkt | Status |
| --- | --- |
| Live-`placeOrder` ruft Broker-Engine (Private-Client), nicht Paper | ✅ belegt durch Test „Live-Gate OFFEN …“ |
| Live-`getAccount`/`getPositions` liefern echte Venue-Daten, nie Paper | ✅ belegt (equity=99999 aus Fake-Private-Client) |
| Paper-Modus handelt gegen Paper-Ledger | ✅ belegt (ExecutionPort-Separation) |
| Gate geschlossen ⇒ `LiveTradingGateError` vor jedem Broker-Zugriff | ✅ belegt (auch ohne Credentials) |
| Vier Live-Konzepte klar getrennt | ✅ belegt (Semantik-Trennung) |
| Kein Breaking Change für Paper/Testnet | ✅ 330 Tests grün (universe, marketdata, broker, bitunix, liveGate, scanner.service) |
| Typecheck / Lint | ✅ `tsc --noEmit` 0 Fehler; `eslint .` 0 Fehler (1 vorbestehende Warning in `ws.ts`) |

Tests: `tests/bitunix.adapter.test.ts` (3 neue Tests), `tests/bitunix.unit.test.ts`
(Assertion liveTradable), `tests/fixtures/**`, `data/universe/instruments.ndjson`
liveTradable-Spalte.

---

## 4. Doku-Aktualisierungen

- `docs/BITUNIX.md` — §5 Ausführung (ExecutionPort) & Live-Gate, §9 Mapping-Semantik.
- `docs/BROKER_ARCHITECTURE.md` — §2.1 ExecutionPort, §3.1 vier Live-Konzepte.
- `docs/LIVE_TRADING.md` — Hinweis auf Broker-Engine nach Gate.
- `docs/PAPER_TRADING.md` — Trennung Paper ⇄ Live.
- `docs/MARKET_UNIVERSE.md` — `liveTradable` im Feldkatalog, Defaults.
- `CHANGELOG.md` / `docs/CHANGELOG.md` — Release 1.20.0.
- `package.json` — Version 1.20.0.

---

## 5. Verifikation

```bash
npm run typecheck
npm run lint
DATABASE_URL=postgresql://test:test@0.0.0.0:5432/test STARTING_EQUITY=10000 \
  node --import tsx --test 'tests/bitunix.*.test.ts' 'tests/universe.*.test.ts' \
  'tests/broker*.test.ts' 'tests/marketdata.*.test.ts' \
  'tests/scanner.service.test.ts' 'tests/liveGate.*.test.ts'
# 330 Tests, 0 Fehler
```

---

## 6. Restrisiko / Ausblick

- Der synchrone Fill-Preis einer Live-Order ist 0 (Fills werden asynchron über
  Positions/Status abgeglichen). Ein späterer Order-Status-Poll ist
  wünschenswert, aber außerhalb dieses Refactors.
- `liveTradable` ist neu am Instrument-Contract; bestehende Konsumenten lesen
  weiter `liveAvailable` (kompatibel), sollten aber auf `liveTradable`
  migrieren (deprecated).
