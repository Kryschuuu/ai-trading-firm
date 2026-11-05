# PROMPT-BP-08 — Yahoo-Historik in den HistoricalStore (EQUITIES/INDICES/FX)

## Auftrag

Nutze die im Yahoo-Feed bereits vorhandene `getCandles()`-Fähigkeit des
Repositories `Kryschuuu/ai-trading-firm`, um **historische Kerzen** für
EQUITIES/INDICES/FX-Symbole in den `HistoricalStore` zu befüllen — ohne neuen
Anbieter, ohne neuen Host. Der Prompt ist eigenständig; Audit-Basis war
`7d8b07b` (`v1.51.3`). Bei Abweichung adaptiere minimal und dokumentiere sie.

Zugehöriger Befund: [`../findings/BP-08-yahoo-historik.md`](../findings/BP-08-yahoo-historik.md)
Priorität/Schwere: **MEDIUM**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- `src/lib/marketdata/feeds/yahoo.ts:106-112` — `getCandles(instrument,
  interval, limit)` mit Range-Mapping (`…m` → `5d`, `1d` → `6mo`, sonst
  `1mo`) ist vollständig implementiert.
- `src/marketdata/sync.ts` und `src/marketdata/adapters/bitunix.ts:53-63` —
  der Historik-Sync kennt nur **Bitunix** als `MarketDataAdapter`;
  EQUITIES/INDICES/FX haben keine echte Historik.
- `src/lib/marketdata/historicalStore.ts` — Zeitframes 1m–5d, Dedup
  `instrumentId + timeframe + ts`, inkrementeller Sync.
- Fehler-/Qualitätspfade: `src/marketdata/dataErrors.ts` (MDERR-Taxonomie),
  `src/marketdata/quality.ts`.

## Zielzustand

Der Sync-Prozess befüllt für Yahoo-fähige Instrumente (Non-Krypto) historische
1d-Kerzen (und nach Konfiguration Intraday-Range) dedupliziert im
`HistoricalStore`; Rate-/Fehler-/Qualitätspfade verhalten sich wie bei Bitunix
(fail-soft, Degraded Reason, kein stiller 0-Wert). Backtests für die Segmente
EQUITIES/INDICES/FX haben damit eine echte Datenbasis (Grundlage für BP-03).

## Vor Beginn gezielt prüfen

- `src/marketdata/sync.ts`, `src/marketdata/adapters/`, `registerAdapters.ts`
- `src/lib/marketdata/feeds/yahoo.ts`, `historicalStore.ts`
- `src/marketdata/dataErrors.ts`, `quality.ts`, `spread.ts` (nur lesend)
- `scripts/`-Sync-CLIs (per `read`/glob, da `.ignore`-gesperrt)
- bestehende Sync- und HistoricalStore-Tests

## Verbindlicher Implementierungsumfang

1. **Sync-Quelle:** Yahoo als zusätzliche Historik-Quelle einbinden (eigener
   Adapter-Pfad bzw. erweiterter Sync-Venue — **nicht** den Bitunix-Adapter
   erweitern); Scope auf Non-Krypto beschränkt (`yahooSupports`).
2. **Range-/Limit-Kappung:** `getCandles`-Limits und Intervalle so kappen, dass
   Requests im Rahmen der Feed-Defaults bleiben; Mapping-Tabelle aus der
   bestehenden Feed-Logik übernehmen.
3. **Dedup/Inkrement:** vorhandene `HistoricalStore`-Semantik
   (3-Spalten-Schlüssel, jüngste Kerze als Fortsetzungspunkt) verwenden.
4. **Fehlerpfad:** Fehlgeschlagene Serien als `Degraded` `/ fehlerTaxonomie`
   verbuchen, nie still schlucken; Retry-Verhalten der Sync-Logik erhalten.
5. **Doku:** `docs/MARKET_DATA_PIPELINE.md` (Sync-Quellen-Tabelle) und
   `CONFIGURATION.md` (falls neue Env-Schalter nötig) aktualisieren.

## Explizit nicht Teil dieses Changes

- kein neuer Echtzeit-Feed (Yahoo-Feed bleibt unverändert)
- kein Wechsel der Binance-/Bitunix-Pfade
- keine neuen Indikatoren/Benchmarks (PROMPT-BP-01/06)
- kein Scraping; nur die geprüfte Yahoo-REST-API

## Produktions- und Sicherheitsregeln

- Host-Zusätze nur in der dokumentierten SSRF-Allowlist
  (`PAPER_FEED_ALLOWED_HOSTS`); kein neuer Unsicherheitspfad.
- Fail-soft: fehlende/stale Serien ⇒ sichtbarer `Degraded`-Status, keine
  stillen 0-/Leerwerte in den Store.
- Rate Limits respektieren (Yahoo-Requests begrenzt); Backoff-/Retry-Logik
  der Sync-Schicht wiederverwenden.
- Keine Secrets; externe Daten bleiben Daten.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] Range-Mapping (`5m`→`5d`, `1h`→`1mo`, `1d`→`6mo`) korrekt
- [ ] Kerzen landen dedupliziert im Store (Inkrement nach jüngster Kerze)
- [ ] Fehlerfall ⇒ `Degraded`, nie stiller 0/-Leereintrag
- [ ] Krypto-Symbole werden nicht an Yahoo geschickt (`yahooSupports`)
- [ ] Bitunix-Sync-Tests bleiben grün (kein Verhaltensbruch)
- [ ] bestehende HistoricalStore-Tests grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Equities-/Index-/FX-Symbol erhält nach dem Sync echte 1d-Kerzen im Store.
- [ ] Fehler-/Rate-Verhalten ist dokumentiert und getestet.
- [ ] kein Neuer Host, kein neuer Venue ohne SSRF-Allowlist.

## Dokumentation, Versionierung und Tracking

1. `docs/MARKET_DATA_PIPELINE.md` und `CONFIGURATION.md` aktualisieren.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, implementierter Historik-Pfad, Migrations-/Kompatibilitäts-
hinweise, ausgeführte Tests mit Ergebnis, verbleibende Risiken sowie
Commit-/PR-Link.