# STX-15 — Faktenkorrektur: 14 aktive Scanner-Faktoren, nicht „15+"

- **ID:** STX-15
- **Severity:** LOW
- **Bereich:** Doku
- **Quelle:** Ausbaudokument §0 („15+ Faktoren")
- **Status:** FIXED — bestätigt im Abgleich 2026-10-03 (00-02, `v0.6.1`)
- **Datei(en):** `src/scanner/scanner.config.json`, `src/scanner/factors/`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — Zahlen nachgezählt und bestätigt
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `src/scanner/scanner.config.json` → **14** Faktoren, exakt: `liquidity, spread, atr, volatility, momentum, trend, volumeRatio, rsi, drawdown, correlation, news, funding, openInterest, execution`
- `src/scanner/factors/` → 17 `.ts`-Dateien, davon `helpers.ts` und `index.ts` ⇒ 15 Faktormodule; `crossSectionalMomentum` ist der nicht aktivierte, optionale Faktor
- SSoT bleibt Config + `npm run scanner:regenerate-config`

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
