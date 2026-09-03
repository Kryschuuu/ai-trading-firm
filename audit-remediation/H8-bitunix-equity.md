# H8 — Bitunix-Equity ist potenziell falsch aus available + uPnL berechnet

- **Severity:** HIGH
- **Bereich:** Brokers & Venues
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/brokers/bitunix/privateClient.ts` (`getAccount` L110‑123),
  `src/contracts/broker.ts` (`BrokerAccount`)

## Arena-Prompt (kopierbar)

```
TASK: Compute Bitunix account equity from the correct venue fields, not available + uPnL.

PROBLEM: getAccount() does `equity = available + crossUnrealizedPNL + isolationUnrealizedPNL`
and `cash = available`. For a futures account, `available` is free margin/cash, not total equity;
with open/isolated positions this yields a wrong risk denominator for maxPositionPct, sizing,
drawdown.

DO:
1. Extend BrokerAccount (src/contracts/broker.ts) with canonical fields:
     walletBalance, availableCash, usedMargin, maintenanceMargin, unrealizedPnl, equity
2. In getAccount(), read the real Bitunix fields from the row (walletBalance, available,
   usedMargin/maintenanceMargin if present, crossUnrealizedPNL, isolationUnrealizedPNL) and map:
     equity        = walletBalance + realizedPnl + unrealizedPnl
     availableCash = available
     usedMargin    = usedMargin ?? 0
     unrealizedPnl = crossUnrealizedPNL + isolationUnrealizedPNL
   Fallback only when a field is genuinely absent; never synthesize equity from available alone.
3. Keep `cash` = availableCash (used by the cash guard) and `equity` = the computed total.
4. Document the mapping in docs/BITUNIX.md.

ACCEPTANCE: For a position with usedMargin>0, equity != available. Unit test with a mocked row
asserts equity = walletBalance + uPnL and cash = available.
```

## Beweis (aktueller Code)

`src/brokers/bitunix/privateClient.ts` L110‑123:

```ts
const available = Number(row?.available ?? 0);
const upnl = Number(row?.crossUnrealizedPNL ?? 0) + Number(row?.isolationUnrealizedPNL ?? 0);
const equity = (Number.isFinite(available) ? available : 0) + (Number.isFinite(upnl) ? upnl : 0);
return { equity, cash: Number.isFinite(available) ? available : 0, openPositions: 0, ... };
```

## Fix-Spezifikation

Venue-spezifisch auf kanonische Größen abbilden: `equity = walletBalance + realizedPnl + unrealizedPnl`;
`getrennte` Erfassung von equity/availableCash/usedMargin/maintenanceMargin/unrealizedPnl (siehe Audit H8).

## Akzeptanzkriterien / Tests

- [ ] `equity` = `walletBalance + uPnL`, nicht nur `available + uPnL`.
- [ ] `cash` bleibt das freie Margin (`available`).
- [ ] Mock-Test mit `usedMargin>0` belegt korrekte Trennung.

## Changelog-Blurb

`H8 (HIGH): Bitunix-Equity falsch (available+uPnL) — kanonische Abbildung walletBalance/usedMargin/
uPnL; Risk-Guard nutzt echte Equity.`

## Versions-Hinweis

PATCH (`1.36.3`) — Datenkorrektur, `BrokerAccount`-Typ-Erweiterung (abwärtskompatibel).
