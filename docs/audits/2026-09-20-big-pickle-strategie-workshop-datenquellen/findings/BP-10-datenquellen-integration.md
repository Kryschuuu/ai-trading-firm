# BP-10: Datenquellen-Evaluation und Key-basierte Integration ungeregelt

- **Antwort:** Offen
- **Tracking-Status:** `OPEN`
- **Severity:** `LOW`
- **Quick Estimate Restaufwand:** **4–8 PT**
- **Umsetzungs-Prompt:** [`PROMPT-BP-10`](../prompts/PROMPT-BP-10-datenquellen-integration.md)

## Verifizierte Fundstellen

- Verdrahtete Quellen (Stand `v1.51.3`): Binance-Feed (Krypto) und Yahoo-Feed
  (Non-Krypto) im Echtzeitpfad, Bitunix `MarketDataAdapter` im Historik-Sync,
  RSS-Nachrichten (CoinDesk/Cointelegraph/Finviz, Headlines).
- Keine Key-basierte Quelle (Alpha Vantage, Polygon, Finnhub, Twelve Data …)
  ist im Code vorgesehen; `src/lib/marketdata/config.ts` kennt keine
  entsprechenden Env-Flags.
- Repository-Regel (AGENTS.md): Secrets/Tokens werden nie committet; neue
  Quellen mit Keys müssen dem entsprechenden Env-/Config-Muster folgen
  (`.env`, `CONFIGURATION.md`).

## Bewertung und Abgrenzung

Für EQUITIES/INDICES/FX existiert keine Langzeit-Historik außer der (hier
erst in BP-08 angebundenen) Yahoo-Fähigkeit; Fundamentals, Orderbuchtiefe und
Wirtschaftskalender fehlen vollständig. Bevor bezahlte Quellen eingebaut
werden, braucht es eine dokumentierte Evaluation (Kosten, Lizenz, Coverage,
Rate Limits, WS-Fähigkeit) und eine **erste** konkrete Integration als
Referenz — Preis/Leistung ist bei Polygon.io, Alpha Vantage, Finnhub und
Twelve Data deutlich unterschiedlich. TradingView bietet kein nutzbares
öffentliches Daten-API (nur Enterprise), IEX Cloud ist faktisch eingestellt —
beide daher explizit abzuraten.

## Konkretes Delta

- `docs/DATENQUELLEN_EVALUATION.md` mit Bewertungsraster und klarer
  Kaufempfehlung (EOD-Historik: Polygon; Fundamentals/Kalender: Finnhub;
  kostengünstig: Twelve Data/Alpha Vantage).
- Erste Integration: Polygon-EOD-`MarketFeed` hinter `POLYGON_ENABLED=true` +
  `POLYGON_API_KEY` (Env, nie committen), Host in der SSRF-Allowlist,
  Keyless-Skip + Tests.

## Akzeptanzkriterien für `FIXED`

- [ ] Evaluationsdokument mit Raster, Preisen, Abraten (TradingView/IEX Cloud)
      und Empfehlung liegt unter `docs/`.
- [ ] Polygon-Pfad ist env-gated; ohne Key/Flag vollständig inaktiv (kein
      stiller Netzverkehr).
- [ ] Formats-, Fehler- und SSRF-Pfadtests grün; `CONFIGURATION.md` aktualisiert.
- [ ] Pflichtgates grün.

## Review-Evidenz

- Audit-Basis: Commit `7d8b07b`, Produktversion `v1.51.3`.
- Methode: Feed-/Config-Registry-Prüfung.