# Capability-SSoT und Instrument-Projektion

**Stand:** v1.28.1 · **Modul:** `src/universe/capabilityProjection.ts` · **SSoT:** `src/brokers/capabilities.ts`

Dieses Dokument definiert die einzige Laufzeit-Wahrheit für Venue-Fähigkeiten und
die Instrument-Verfügbarkeit. Der Universe-Seed enthält **statische** Instrumentdaten
plus die fachliche Produktentscheidung `liveTradable`. `liveAvailable` wird **nie**
im Seed persistiert, sondern zur Laufzeit projiziert.

Die ältere Fassade `resolveInstrumentCapabilities()` (v1.26.4) delegiert an denselben
Projektor und bleibt nur für bestehende Importe.

## Begriffe

| Feld | Ebene | Bedeutung |
| --- | --- | --- |
| `discovery` | Adapter/Venue | Kann der Adapter Instrumente automatisch entdecken? |
| `marketData` | Adapter/Venue | Kann der Adapter Live-Marktdaten liefern: Ticker, Candles, Orderbook? |
| `trading` | Adapter/Venue | Kann der Adapter tatsächlich Orders ausführen? |
| `live` | Adapter/Venue | Kann der Adapter-CODE Live-Orders serialisieren? (keine Freigabe) |
| `liveTradable` | Instrument, Stammdaten | Fachlich für Live-Handel vorgesehen. Sagt **nichts** darüber aus, ob ein funktionsfähiger Adapter existiert. PAPER = false, reale Venues = true. |
| `liveAvailable` | Instrument/API, Laufzeit | Technisch **jetzt** live handelbar. Konjunktion aus fünf Bedingungen. Niemals ein Seed-Wert. |

`liveAvailable=true` bedeutet **nicht** „Live-Trading ist aktiviert“ als
Betriebsschalter — Orders laufen weiter durch den Live-Gate-Enforcer.

## Projektionsregel (CAP-008)

Die einzige Schreibstelle für `liveAvailable` ist:

```ts
projectInstrumentAvailability(instrument, context)
```

`liveAvailable` ist genau dann `true`, wenn **alle** gelten (fail-closed):

1. `instrument.liveTradable === true`
2. `capabilities[venue].trading === true`
3. registrierter Nicht-Stub-Adapter **und** `capabilities[venue].live === true`
4. `${venue}_ENABLED` via `venueEnabledFromEnv` (Feature-Flag)
5. `evaluateLiveOrder(venue, { audit: false }).allowed === true`

Sonst `liveAvailable=false` und `reasons[]` enthält nur symbolische Codes
(`NOT_LIVE_TRADABLE`, `ADAPTER_STUB`, `CAPABILITY_LIVE_FALSE`,
`FEATURE_FLAG_UNSET`, `LIVE_GATE_CLOSED`, …) — keine Secrets, keine Env-Werte.

Unbekannte Venues sind fail-closed:

```ts
{ liveAvailable: false, liveTradable: <Stammdaten>, reasons: [CAPABILITY_MISSING, …] }
```

## Sicherheitsrelevanz

Eine UI oder API, die `liveAvailable: true` für einen Stub-Adapter ausgibt, kann
Nutzer zu einem Live-Handelsversuch verleiten. Deshalb gilt:

- Der Seed (`src/universe/seed.ts`) **darf kein** `liveAvailable` enthalten
  (Schema-Fehler). `liveTradable` ist erlaubt und wird persistiert.
- Registry, Persistenz und API schreiben `liveAvailable` ausschließlich über den
  Projektor. Alte NDJSON-Werte werden ignoriert.
- Startup: jedes Venue mit `capabilities.trading=true` braucht einen echten
  (Nicht-Stub-)Adapter (`assertTradingVenuesHaveRealAdapters`).
- Live-Trading-Gate und tatsächliche Order-Freigabe bleiben separat; dieser
  Projektor öffnet keine Orders.

## Aktuelle Stub-Venues

Solange die Matrix für `BINANCE`, `KRAKEN`, `ALPACA` und `IBKR` jeweils
`trading: false` / `live: false` ausweist und der Factory-Pfad ein Stub ist,
projizieren alle entsprechenden Seed-Instrumente:

```json
{ "liveAvailable": false, "liveTradable": true }
```

`liveTradable=true` ist hier die Produktabsicht, nicht die technische
Verfügbarkeit.

`BITUNIX` ist die produktivere Integration: `discovery`, `marketData`,
`trading` und `live` sind auf Adapter-Ebene `true`; `liveAvailable` bleibt
trotzdem `false`, bis Feature-Flag und Live-Gate offen sind.

`PAPER` ist fachlich nicht live-handelbar (`liveTradable=false`,
`capabilities.live=false`).
