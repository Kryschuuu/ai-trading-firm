# BP-08: Yahoo-`getCandles()` existiert, füllt den HistoricalStore aber nicht

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-08`](../prompts/PROMPT-BP-08-yahoo-historik.md)

## Verifizierte Fundstellen

- `src/lib/marketdata/feeds/yahoo.ts:106-112` — `getCandles(instrument, interval,
  limit)` mit Range-Mapping (`…m` → `5d`, `1d` → `6mo`, sonst `1mo`) ist
  vollständig implementiert.
- `src/marketdata/sync.ts` / `src/marketdata/adapters/bitunix.ts:53-63` — der
  Historik-Sync kennt **nur** Bitunix als `MarketDataAdapter`; EQUITIES/INDICES/
  FX-Symbole haben damit keine echte Historik im `data/history`.
- `src/lib/marketdata/historicalStore.ts` — Zeitframes 1m–5d, Dedup
  `instrumentId + timeframe + ts`, inkrementeller Sync.

## Bewertung und Abgrenzung

Der Yahoo-Feed ist an den Echtzeitpfad gebunden, seine Nachrichtenfähigkeit
für Historik (`getCandles`) wird im Sync nicht genutzt. Damit fehlen Aktien-/
ETF-/Index-/FX-Symbolen historische Kerzen — exakt die Datenbasis, die
Regel-Backtests für diese Segmente brauchen (BP-03). Es geht um Verdrahtung,
nicht um einen neuen Anbieter: Host bleibt `query1.finance.yahoo.com` in der
SSRF-Allowlist, Fehlerpfade der `dataErrors`-Taxonomie wiederverwenden.

## Konkretes Delta

- Historik-Befüllung für Yahoo-Symbole (EQUITIES/INDICES/FX) in den
  Sync-Prozess integrieren (Yahoo als zusätzliche Sync-Quelle bzw. erweiterter
  Sync-Venue), Range-/Limit-Kappung passend zu `getCandles`.
- Rate-/Fehlerpfad (Fail-soft, Degraded Reason) via `src/marketdata/dataErrors.ts`.

## Akzeptanzkriterien für `FIXED`

- [ ] Yahoo-Historik landet dedupliziert im `HistoricalStore` (1d primär).
- [ ] Range-Mapping (`5m`→`5d`, `1h`→`1mo`, `1d`→`6mo`) in Tests belegt.
- [ ] Fehlerfälle erzeugen `Degraded`-Stati, nie stille `0`-Werte.
- [ ] bestehende Bitunix-Sync-Pfade unverändert (kein Verhaltensbruch).
- [ ] Pflichtgates grün.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: Feed-Interface- und Sync-Venue-Prüfung.