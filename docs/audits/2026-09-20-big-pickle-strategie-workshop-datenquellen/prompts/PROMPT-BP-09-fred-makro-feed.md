# PROMPT-BP-09 — FRED-Makro-Feed für Regime-Kontext und Event-Shield

## Auftrag

Baue im Repository `Kryschuuu/ai-trading-firm` einen **FRED-Makro-Reader**
(kostenloser Bundesreserve-Feed, optionaler Key) ein und speise daraus
makroökonomische Kontextzeilen in den Makro-Zyklus sowie (optional) in die
`news-event-shield`-Missionen. Der Prompt ist eigenständig; Audit-Basis war
`7d8b07b` (`v1.51.3`). Bei Abweichung adaptiere minimal und dokumentiere sie.

Zugehöriger Befund: [`../findings/BP-09-fred-makro-feed.md`](../findings/BP-09-fred-makro-feed.md)
Priorität/Schwere: **LOW–MEDIUM**
Schätzung des Restaufwands: **2–4 PT**
Synergie: liefert den Datenpfad; keine neue Regime-Logik (RMA-P2-01 bleibt
separat).

## Verifizierter Ausgangszustand

- `src/lib/marketdata/feeds/` — Architektur für keyless Feeds (Binance/Yahoo)
  mit `httpGetJson`, SSRF-Allowlist (`PAPER_FEED_ALLOWED_HOSTS`), Timeout/
  Retry; Wiederverwendbarer Kanal für einen FRED-Reader.
- `src/lib/marketRegime.ts` — Regime wird ausschließlich aus Kerzen abgeleitet;
  kein Makro-Input.
- `src/cycle/steps/macroStep.ts`, `newsStep.ts` — Prompt-/untrustedData-Pfade
  für den Makro-Zyklus und externe Nachrichten.
- Vorlage `news-event-shield` (Missionen-Katalog) setzt terminkritische Wochen
  voraus, ohne Kalenderdaten zu erhalten.

## Zielzustand

Ein `FredMarketFeed`-Read-Only-Modul liefert zentrale Serien (z. B. CPI,
Leitzins, VIX-Anker, ggf. 10Y-Rendite) als strukturierte Zeitreihen; der
Makro-Zyklus bekommt optional Regime-/Makro-Kontextzeilen (untrustedData),
fehlende/stale Serien schalten sich fail-soft ab (kein Halluzinationsraum).

## Vor Beginn gezielt prüfen

- `src/lib/marketdata/feeds/*`, `src/lib/marketdata/http.ts` (Allowlist)
- `src/cycle/steps/macroStep.ts`, `src/cycle/steps/newsStep.ts`
- `src/lib/news.ts` (Muster für externen Textfluss)
- `src/lib/marketRegime.ts` (nur lesend, Regime-Grenze wahren)
- bestehende Schritt-/Feed-Tests

## Verbindlicher Implementierungsumfang

1. **Reader:** `src/lib/marketdata/feeds/fred.ts` — Serien aus FRED
   (Serien-Katalog als Konstante, `series_id`, Frequenz, Einheiten); Alias
   `api.stlouisfed.org` in `PAPER_FEED_ALLOWED_HOSTS` (Env-Doku nötig); Timeout/
   Retry über `httpGetJson`; optionaler Key aus Env, **nie** aus Code/Log.
2. **Kontext:** Makro-Zyklus-Input um strukturierte Makro-Daten erweitern
   (untrustedData-Pfad, Anti-Injection erhalten); fehlende Serie ⇒
   `referenceMissing`-analoger Status statt Fantasiewert.
3. **Event-Shield-Brücke (optional, getrennt commitbar):** `news-event-shield`-
   Kontext um Veröffentlichungskalender-Eckpunkte reichern — nur wenn der
   Reader stabil läuft (Feature-Flag).
4. **Doku:** `CONFIGURATION.md` (Env/Flags), Feed-Übersicht im
   `MARKET_DATA_PIPELINE.md`.

## Explizit nicht Teil dieses Changes

- keine Regime-Neuerfindung (RMA-P2-01/P2-05 bleiben aus)
- kein kostenpflichtiger Anbieter; FRED keylos/optional
- kein Umbau von `marketRegime.ts`

## Produktions- und Sicherheitsregeln

- Host nur in der dokumentierten SSRF-Allowlist.
- Externe Werte ausschließlich als strukturierte Daten in untrustedData —
  nie als Prompt-Instruktionen (Anti-Injection).
- Fail-soft: fehlende/stale Serie ⇒ sichtbarer Zustand, nie `0`/Default in die
  Analyse.
- Keine Secrets persistieren/loggen; Key nur via Env.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] Serienformat korrekt umgesetzt (Zeitreihe, Einheiten, Frequenz)
- [ ] fehlende Serie ⇒ fail-soft-Status (kein Halluzinationsraum)
- [ ] Anti-Injection-Test: externe Serienwerte landen nur in untrustedData
- [ ] Keyless-Pfad funktioniert (kein stiller Netzverkehr beim Dummy)
- [ ] bestehende Feed-/Cycle-Tests grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] FRED-Serie wird korrekt gelesen und als Kontext im Makro-Schritt genutzt.
- [ ] Fehl-/Stale-Daten sind sichtbar, nie stille 0-Werte.
- [ ] Kein neuer Host ohne Allowlist-Eintrag; Konfiguration dokumentiert.

## Dokumentation, Versionierung und Tracking

1. `CONFIGURATION.md`, `MARKET_DATA_PIPELINE.md` aktualisieren.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, implementierter FRED-Pfad, Konfigurationshinweise,
ausgeführte Tests mit Ergebnis, verbleibende Risiken sowie Commit-/PR-Link.