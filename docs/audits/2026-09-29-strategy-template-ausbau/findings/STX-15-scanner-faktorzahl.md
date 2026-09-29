# STX-15 — Faktenkorrektur: 14 aktive Scanner-Faktoren, nicht „15+"

- **ID:** STX-15
- **Severity:** LOW
- **Bereich:** Doku
- **Quelle:** Ausbaudokument §0 („15+ Faktoren")
- **Status:** FIXED — Faktenkorrektur dokumentiert (00-02, `v0.6.1`, [STRATEGY_STACK.md](../../../architecture/STRATEGY_STACK.md)); Verweis auf `scanner.config.json` statt Dateizahlen
- **Datei(en):** `src/scanner/scanner.config.json`, `src/scanner/factors/`

## Beweis

`src/scanner/factors/` enthält 17 Dateien, davon `helpers.ts` und `index.ts` ⇒ **15
Faktormodule**. Aktiviert in der Config sind **14**:

```
liquidity, spread, atr, volatility, momentum, trend, volumeRatio,
rsi, drawdown, correlation, news, funding, openInterest, execution
```

Nicht aktiviert: `crossSectionalMomentum` (optionaler Faktor, Rang aus
`src/crossSectional/`).

Die SSoT ist die Config + `npm run scanner:regenerate-config` — nicht die Dateiliste,
nicht die Doku.

## Remediation

In künftigen Audits/Dokumenten auf `scanner.config.json` verweisen, nicht auf Dateizahlen.
Die Priorisierungsformel der Candidate Matrix sollte `crossSectionalMomentum` als
**optionalen** Faktor behandeln (`null` ⇒ `unavailable`, nie 0 — bestehende Konvention).

## Akzeptanzkriterien

- [ ] Kein Prompt nimmt „15+" als Eingangsannahme

## Versions-Hinweis

N/A.
