# STX-07-01 — Copy-Domänenmodell, Symbol-Mapping, Sizing *(rein, keine IO)*

- **Phase:** 7 · **Paket:** 00-02 · **Findings:** STX-09, STX-16
- **Risiko:** niedrig für den Code — **hoch** organisatorisch (STX-16)
- **Unabhängig von Phase 1–6**

## Zweck

Der **normalized trade event**, das Symbol-Mapping und die drei Sizing-Modi — alles rein,
ohne IO. Das ist der Teil, der fachlich stimmen muss; alles Weitere ist Verdrahtung.

## Kontext

Kernpunkt aus der Analyse, der übernommen werden muss: *„Copy Trading kopiert nicht
die Order 1:1. Es kopiert eine **Handlungsabsicht** und berechnet daraus eine neue
Follower-Order."* Daraus folgt die Normalisierung auf
`action: OPEN | INCREASE | DECREASE | CLOSE` statt auf eine Order-Übertragung.

**Vorbedingung:** STX-16. `README.md` positioniert die Firma als Paper-Trading,
„nicht produktionsreif, educational purposes only". Deshalb ist
`copyMode: "SIMULATE_ONLY"` ein **Enum mit genau einem Wert** — kein Env-Flag, kein
Schalter, kein Live-Pfad in dieser Roadmap.

## Auftrag

### 1. `src/copy/types.ts` (rein)

```ts
export type CopyMode = "SIMULATE_ONLY";   // genau ein Wert (STX-16)

export interface NormalizedLeaderTrade {
  eventId: string;                 // stabil, vom Leader-Adapter vergeben
  leaderVenue: BrokerVenueId;
  leaderAccount: string;
  symbol: string;                  // **normalisiert**, Venue-übergreifend (SSoT)
  side: "LONG" | "SHORT";
  action: "OPEN" | "INCREASE" | "DECREASE" | "CLOSE";
  quantity: number;                // Leader-Basiseinheiten
  notional: number;                // Leader-Quote-Währung
  entryPrice: number | null;       // null = unbekannt, nie 0
  leverage: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Eventzeit des Leaders (ms) — NICHT die Empfangszeit. */
  occurredAt: number;
  /** Partial-Fill-Anteil [0,1] dieses Ereignisses. */
  fillRatio: number;
}

export type SizingMode = "FIXED_AMOUNT" | "FIXED_RATIO" | "EQUITY_RATIO";
export type LeveragePolicy = "FOLLOW_LEADER" | "CAP" | "IGNORE" | "RISK_NORMALIZED";

export interface FollowerOrderIntent {
  sourceEventId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  action: NormalizedLeaderTrade["action"];
  quantity: number;
  notional: number;
  /** Herleitung, für Audit/UI — `sizingMode` + Input-Felder. */
  sizing: { mode: SizingMode; leaderNotional: number | null;
            leaderEquity: number | null; followerEquity: number | null;
            multiplier: number; leverageApplied: number | null };
  createdAt: number;
}
```

### 2. `src/copy/mapping.ts`

- **Nutze die SSoT: `tryNormalizeVenueSymbol` aus `@/symbols/normalize`.**
  `BTC/USD`, `BTCUSDT`, `BTCUSDT-P`, `BTC/USDT` sind **nicht** dieselben Symbole auf
  derselben Venue, aber dieselbe **Venue-übergreifende** ID. Ein `String.replace` ist
  verboten.
- `mapLeaderSymbol(venue, raw): SymbolMapping` ⇒
  `{ ok: true, instrumentId, venue, resolved } | { ok: false, reason }`
- **Unauflösbar ⇒ `{ok:false}` mit Grund. Kein Fallback**, kein „nächstbestes Symbol".
  Eine falsche Zuordnung ist schlimmer als eine ausgelassene.

### 3. `src/copy/sizing.ts`

```ts
export function computeFollowerNotional(input: SizingInput): SizingResult
```

| Modus | Formel | Anmerkung |
|---|---|---|
| `FIXED_AMOUNT` | `fixedAmount` | für Follower mit **konstanter** Größe |
| `FIXED_RATIO` | `leaderNotional × ratio` | einfach, aber skaliert **nicht** mit dem Follower |
| `EQUITY_RATIO` | `followerEquity × (leaderNotional / leaderEquity) × multiplier` | die interessanteste Variante |

**Fail-closed-Regeln:**
- `leaderEquity <= 0` ⇒ `{ok:false}` (kein Undefined-Divisor)
- `leaderNotional <= 0` bei `OPEN` ⇒ `{ok:false}`
- `CLOSE` ⇒ Notional = **0**, aber die **Intent existiert** (Position muss zugeteilt
  werden). Modelle das explizit, statt `CLOSE` zu verwerfen.
- `EQUITY_RATIO` braucht `leaderEquity` **explizit vom Adapter**. Fehlt es ⇒
  `{ok:false}` — **nicht** still auf `FIXED_RATIO` zurückfallen. Ein stiller
  Moduswechsel ist die Art von Fehler, die niemand findet.

**Leverage:** `applyLeveragePolicy(policy, leaderLeverage, followerCap)` ⇒
`{ leverage, adjusted: boolean, reason }`. Bei `FOLLOW_LEADER` und
`followerLeverage > cap` ⇒ **clampen** und `adjusted: true` mit Grund — nicht ablehnen.

### 4. Tests `tests/copy.domain.test.ts` (reine Funktionen, keine DB)

- `EQUITY_RATIO`: 100 000 Leader-Equity, 10 000 Position ⇒ 10 %; Follower 1 000 ⇒ 100
- `leaderEquity: 0` ⇒ `{ok:false}`
- `CLOSE` ⇒ Intent mit `notional: 0`
- `EQUITY_RATIO` ohne `leaderEquity` ⇒ `{ok:false}`, **kein** Fallback
- `FOLLOW_LEADER` mit Leader 10× und Follower-Cap 3× ⇒ 3, `adjusted: true`
- Mapping: alle 4 Schreibweisen ⇒ **dieselbe** `instrumentId`, verschiedene
  `venue`-Auflösung
- Mapping eines unbekannten Symbols ⇒ `{ok:false}` mit Grund

## Akzeptanzkriterien

- [ ] **Kein** IO, keine DB, kein Netz in `types/mapping/sizing`
- [ ] Kein `String.replace` für Symbole — nur `src/symbols/normalize.ts`
- [ ] `CopyMode` hat **genau einen** Wert
- [ ] Jeder `{ok:false}`-Pfad hat einen **benannten** Grund
- [ ] Kein stiller Moduswechsel
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Gesperrt

- **Keine** Policy-Engine, **keine** Tabellen, **kein** Leader-Adapter (07-02, 07-03).
- **Kein** Scraping, **keine** UI-Automation, **keine** Fremdplattform-Integration.
- **Kein** Live-Pfad. Nur `SIMULATE_ONLY`.
- Keine Änderung an `src/symbols/`, `src/brokers/`, `src/executionQuality/`.
