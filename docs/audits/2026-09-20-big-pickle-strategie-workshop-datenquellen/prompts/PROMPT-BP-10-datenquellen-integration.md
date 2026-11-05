# PROMPT-BP-10 — Datenquellen-Evaluation und env-gated Polygon-Integration

## Auftrag

Erstelle im Repository `Kryschuuu/ai-trading-firm` eine **Datenquellen-
Evaluation** unter `docs/` und implementiere die **erste** bezahlte/Key-basierte
Quelle (Polygon.io EOD-Historik) als env-gated `MarketFeed`-Erweiterung. Der
Prompt ist eigenständig; Audit-Basis war `7d8b07b` (`v1.51.3`). Bei Abweichung
adaptiere minimal und dokumentiere sie.

Zugehöriger Befund: [`../findings/BP-10-datenquellen-integration.md`](../findings/BP-10-datenquellen-integration.md)
Priorität/Schwere: **LOW**
Schätzung des Restaufwands: **4–8 PT**

## Verifizierter Ausgangszustand

- Verdrahtete Quellen: Binance-Feed (Krypto), Yahoo-Feed (Non-Krypto;
  Historik-Fähigkeit erst in BP-08 aktiviert), Bitunix `MarketDataAdapter`
  (Historik-Sync), RSS-Nachrichten (CoinDesk/Cointelegraph/Finviz).
- Key-basierte Quellen: **keine** vorgesehen; `src/lib/marketdata/config.ts`
  kennt keine entsprechenden Env-Flags.
- Repository-Regel: Secrets werden nie committet; neue Env-Flags gehören in
  `CONFIGURATION.md`; SSRF-Hosts in `PAPER_FEED_ALLOWED_HOSTS`.

## Zielzustand

`docs/DATENQUELLEN_EVALUATION.md` dokumentiert ein Bewertungsraster und eine
klare Empfehlung (EOD-Historik: Polygon.io; Fundamentals/Kalender: Finnhub;
Budgetfrei: Twelve Data/Alpha Vantage; Abraten: TradingView ohne Enterprise,
IEX Cloud eingestellt). Ein Polygon-EOD-`MarketFeed` funktioniert hinter
`POLYGON_ENABLED=true` + `POLYGON_API_KEY` vollständig inaktiv ohne diese Flags.

## Vor Beginn gezielt prüfen

- `src/lib/marketdata/feeds/*` (Binance/Yahoo als Referenzmuster)
- `src/lib/marketdata/config.ts` (`ENV`-Registry, Allowlist)
- `src/marketdata/adapters/`, `registerAdapters.ts`
- `docs/MARKET_DATA_PIPELINE.md`, `docs/CONFIGURATION.md`
- bestehende Feed-Tests

## Verbindlicher Implementierungsumfang

1. **Evaluationsdokument** `docs/DATENQUELLEN_EVALUATION.md`:
   anbieten Polygon.io, Alpha Vantage, Finnhub, Twelve Data (ggf. Alpaca,
   EODHD) mit Raster (Kosten, Lizenz, Coverage, Rate Limits, WS-Fähigkeit,
   Historik-Tiefe); **explizit** TradingView (kein nutzbares öffentliches
   Daten-API ohne Enterprise) und IEX Cloud (faktisch eingestellt) abraten;
   Empfehlung mit Begründung.
2. **Polygon-EOD-Feed:** `src/lib/marketdata/feeds/polygon.ts` als
   `MarketFeed` (EOD-AGGREGATES, Delta: `prev`/`aggs`), Host in der
   Allowlist, Keyless-/Disabled-Skip (kein stiller Netzverkehr ohne Flag).
3. **Config:** Env-Registry um `POLYGON_ENABLED`, `POLYGON_API_KEY` erweitern,
   `CONFIGURATION.md` aktualisieren; Zugangspfad nur über Env/Config.
4. **Tests:** Keyless-Skip, Format-/Fehlerpfad, SSRF-Allowlist, Reverse-1:
   keine Sekret-Leaks in Logs/Fehlern.

## Explizit nicht Teil dieses Changes

- kein Rollout-Flow für die restlichen Anbieter (nur Evaluation + Referenz)
- keine Änderung an Binance/Yahoo/Bitunix-Verhalten
- kein Fundamentals-/Kalender-Feature selbst (dokumentiert als Empfehlung;
  Umsetzung eigener Prompt später)

## Produktions- und Sicherheitsregeln

- Env-only Secrets; nie Code-/Config-Keys; 0 Treffer in Logs/Fehlermeldungen.
- Disabled ⇒ gar kein Netzverkehr (Test: no-op bei fehlender Flag).
- Host in der dokumentierten SSRF-Allowlist; Fallback-Fehlerpfad nutzen.
- Externe Daten bleiben Daten; Datenqualitäts-/Fehler-Pipeline
  (`dataErrors`, `quality`) wiederverwenden.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] ohne `POLYGON_ENABLED`/Key: Feed inaktiv, 0 Requests (Test-Fixture)
- [ ] Format-/Fehlerpfad der Polygon-Antwort getestet (fixture-basiert)
- [ ] Host-Allowlist-Check greift (nicht zugelassener Host → Fehler)
- [ ] kein Key/Secret erscheint in Logs oder Fehlertexten
- [ ] bestehende Feed-Tests grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Evaluationsdokument liegt unter `docs/` und ist im Docs-Index verlinkt.
- [ ] Polygon-Pfad ist env-gated, ohne Flag komplett inaktiv.
- [ ] Abraten-Aussagen (TradingView/IEX Cloud) sind begründet und datiert.

## Dokumentation, Versionierung und Tracking

1. `docs/DATENQUELLEN_EVALUATION.md`, `CONFIGURATION.md`,
   `MARKET_DATA_PIPELINE.md` aktualisieren; Docs-Index pflegen.
2. Root-`CHANGELOG.md` aktualisieren.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, Evaluationsergebnis, env-gated Integration, Konfigurations-
hinweise, ausgeführte Tests mit Ergebnis, verbleibende Risiken sowie
Commit-/PR-Link.