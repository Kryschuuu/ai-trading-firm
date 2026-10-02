# Copy-Trading — Domänenmodell (STX-07-01)

**Phase 7 · Paket 00-02 · Findings STX-09, STX-16**

Reines, IO-freies Domänenmodell des Copy-Tradings. Es beschreibt die
fachliche Form — alles Weitere (Policy-Engine, Tabellen, Leader-Adapter) ist
bewusst gesperrt (07-02, 07-03).

> **STX-16 (organisatorisch, hoch):** Die Firma ist Paper-Trading
> („nicht produktionsreif, educational purposes only"). Deshalb ist
> `CopyMode = "SIMULATE_ONLY"` ein **Enum mit genau einem Wert** — kein
> Env-Flag, kein Schalter, kein Live-Pfad in dieser Roadmap.

## Kernpunkt: Handlungsabsicht, nicht Order

Copy Trading kopiert **nicht** die Order 1:1. Es kopiert eine
**Handlungsabsicht** und berechnet daraus eine neue Follower-Order. Deshalb
normalisieren wir auf

```
action: OPEN | INCREASE | DECREASE | CLOSE
```

und nicht auf eine Order-Übertragung. Der `NormalizedLeaderTrade` ist diese
normalisierte Absicht; der `FollowerOrderIntent` die daraus berechnete
Follower-Order.

## Module (`src/copy/`)

| Datei | Inhalt | IO? |
| --- | --- | --- |
| `types.ts` | `CopyMode`, `NormalizedLeaderTrade`, `SizingMode`, `LeveragePolicy`, `FollowerOrderIntent`, `COPY_MODES` | nein |
| `mapping.ts` | `mapLeaderSymbol`, `toCrossVenueId` (SSoT-gestützt) | nein |
| `sizing.ts` | `computeFollowerNotional`, `applyLeveragePolicy` | nein |

## Symbol-Mapping (cross-venue, SSoT)

`mapLeaderSymbol(venue, raw)` nutzt **ausschließlich** die SSoT
`tryNormalizeVenueSymbol` aus `@/symbols/normalize` für die venue-aware
Kanonisierung. Es gibt **kein** `String.replace` auf den Roh-Input.

`BTC/USD`, `BTCUSDT`, `BTC-PERP` (und weitere native Schreibweisen) sind nicht
dasselbe Symbol auf derselben Venue, aber **dieselbe venue-übergreifende ID**.
Diese wird abgeleitet, indem die SSoT das Symbol kanonisiert und wir die
Quote-Leg-Äquivalenz anwenden: USD-gepegte Stablecoins (`USDT`, `USDC`,
`BUSD`, `TUSD`, `FDUSD`, `DAI`, `USDP`, `USDE`, `PYUSD`) ≡ `USD`. Das ist ein
Währungs-Äquivalenz-Lookup auf der bereits kanonisierten Form — kein Raten.

- `instrumentId` (Rückgabe) = venue-übergreifende ID, z. B. `BTC/USD`.
- `venue` = Venue, auf der der Leader handelte.
- `resolved` = vollständige SSoT-Auflösung (native Schreibweise, kanonisches
  Paar, Asset-Klasse) — darüber unterscheiden sich die Venue-Auflösungen.

**Unauflösbar ⇒ `{ok:false}` mit Grund. Kein Fallback, kein
„nächstbestes Symbol".** Eine falsche Zuordnung ist schlimmer als eine
ausgelassene.

> Hinweis: Der SSoT erkennt als Perp-Marker nur `PERP`/`SWAP` (z. B.
> `BTC-PERP`). Die im Ticket genannte Bybit-Stil-Schreibweise `BTCUSDT-P` ist
> keine vom SSoT unterstützte Form; die perpetual-Variante wird in den Tests
> durch die unterstützte Form `BTC-PERP` (DYDX) repräsentiert — der
> cross-venue-Kern (gleiche ID, andere Venue-Auflösung) bleibt identisch.

## Sizing — fail-closed

`computeFollowerNotional(input)`:

| Modus | Formel | Anmerkung |
| --- | --- | --- |
| `FIXED_AMOUNT` | `fixedAmount` | konstante Follower-Größe |
| `FIXED_RATIO` | `leaderNotional × ratio` | skaliert nicht mit dem Follower |
| `EQUITY_RATIO` | `followerEquity × (leaderNotional / leaderEquity) × multiplier` | risikoproportional |

Fail-closed-Regeln (jeder nicht auflösbare Zustand ⇒ `{ok:false}` mit
**benanntem** Grund):

- `leaderEquity <= 0` (EQUITY_RATIO) ⇒ `{ok:false}` (kein Undefined-Divisor).
- `leaderNotional <= 0` bei `OPEN` ⇒ `{ok:false}`.
- `CLOSE` ⇒ Notional = **0**, aber der Intent **existiert** (Position wird
  zugeteilt). Nicht still verwerfen.
- `EQUITY_RATIO` ohne `leaderEquity` ⇒ `{ok:false}` — **nicht** still auf
  `FIXED_RATIO` zurückfallen. Ein stiller Moduswechsel ist die Art von Fehler,
  die niemand findet.

## Hebel-Politik

`applyLeveragePolicy(policy, leaderLeverage, followerCap)`:

- `FOLLOW_LEADER`: übernimmt den Leader-Hebel; `leaderLeverage > cap` ⇒
  **klemmen** auf `cap` (nicht ablehnen), `adjusted: true` mit Grund.
- `CAP`: zwingend der Follower-Cap.
- `IGNORE`: kein Hebel (`null`).
- `RISK_NORMALIZED`: risikonormalisiert — klemmt den Leader-Hebel auf den
  Follower-Risiko-Cap (fail-closed; ohne Cap kein Klemmen).

## Tests

`tests/copy.domain.test.ts` (rein, keine DB) deckt:

- EQUITY_RATIO-Prozentrechnung (100k/10k → 10 %; Follower 1k → 100),
- `leaderEquity: 0`/`null` ⇒ `{ok:false}`,
- `CLOSE` ⇒ Intent mit `notional: 0`,
- EQUITY_RATIO ohne `leaderEquity` ⇒ `{ok:false}`, **kein** Fallback,
- FOLLOW_LEADER mit Leader 10×, Cap 3× ⇒ 3, `adjusted: true`,
- Mapping der vier Schreibweisen ⇒ dieselbe `instrumentId`, verschiedene
  Venue-Auflösung,
- unauflösbares Symbol ⇒ `{ok:false}` mit Grund.

## Gesperrt (dieser Ticket-Schritt)

Keine Policy-Engine, keine Tabellen, kein Leader-Adapter (07-02, 07-03).
Kein Scraping, keine UI-Automation, keine Fremdplattform-Integration.
Kein Live-Pfad — nur `SIMULATE_ONLY`. Keine Änderung an `src/symbols/`,
`src/brokers/`, `src/executionQuality/`.
