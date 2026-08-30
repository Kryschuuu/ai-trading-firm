# Capability-SSoT und Instrument-Projektion

**Stand:** v1.26.4 · **Modul:** `src/capabilities/` · **SSoT:** `src/brokers/capabilities.ts`

Dieses Dokument definiert die einzige Laufzeit-Wahrheit für Venue- und
Instrument-Fähigkeiten. Der statische Universe-Seed enthält ausschließlich
adapter-unabhängige Instrumentdaten. `liveAvailable` und `liveTradable` werden
nie im Seed persistiert, sondern zur Laufzeit aus der Capability-Matrix
projiziert.

## Begriffe

| Feld | Ebene | Bedeutung |
| --- | --- | --- |
| `discovery` | Adapter/Venue | Kann der Adapter Instrumente automatisch entdecken? |
| `marketData` | Adapter/Venue | Kann der Adapter Live-Marktdaten liefern: Ticker, Candles, Orderbook? |
| `trading` | Adapter/Venue | Kann der Adapter tatsächlich Orders ausführen? |
| `liveAvailable` | Instrument/API, abgeleitet | Projektion aus `marketData`: `true`, wenn die Venue über den Adapter Live-Marktdaten für Instrumentflächen liefern kann. |
| `liveTradable` | Instrument/API, abgeleitet | Projektion aus `trading`: `true`, wenn die Venue über den Adapter Order-Ausführung unterstützt. |

## Projektionsregel

Die einzige Projektionsstelle ist:

```ts
resolveInstrumentCapabilities(venue, capabilityMatrix)
```

Regel:

```ts
liveAvailable = capabilityMatrix[venue]?.marketData === true
liveTradable  = capabilityMatrix[venue]?.trading === true
```

Unbekannte Venues sind fail-closed:

```ts
{ liveAvailable: false, liveTradable: false }
```

## Sicherheitsrelevanz

Eine UI oder API, die `liveAvailable: true` für einen Stub-Adapter ausgibt, kann
Nutzer zu einem Live-Handelsversuch verleiten, der fehlschlägt oder unerwartet
läuft. Deshalb gilt:

- Der Seed (`src/universe/seed.ts`, `data/universe/instruments.ndjson`) darf
  keine `liveAvailable`-/`liveTradable`-Felder enthalten.
- Registry, Persistenz und API normalisieren/projizieren diese Felder aus der
  Capability-Matrix.
- Live-Trading-Gate und tatsächliche Order-Freigabe bleiben separat und werden
  durch diesen Anzeige-/Projektionsfix nicht geöffnet.

## Aktuelle Stub-Venues

Solange die Matrix für `BINANCE`, `KRAKEN`, `ALPACA` und `IBKR` jeweils
`marketData: false` und `trading: false` ausweist, projizieren alle
entsprechenden Seed-Instrumente:

```json
{ "liveAvailable": false, "liveTradable": false }
```

`BITUNIX` bleibt die produktivere Integration: `discovery`, `marketData` und
`trading` sind auf Adapter-Ebene `true`; die reale Ausführung ist dennoch durch
das Live-Trading-Gate gesperrt, bis alle Gate-Bedingungen erfüllt sind.
