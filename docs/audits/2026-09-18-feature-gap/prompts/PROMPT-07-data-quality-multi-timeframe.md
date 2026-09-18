# PROMPT-07 — Datenqualitäts-Layer & Multi-Timeframe-Konsistenz (GAP-07)

> **Finding:** [GAP-07](../findings/GAP-07-data-quality-multi-timeframe.md) ·
> **Reihenfolge:** Schritt 6 ·
> **Voraussetzungen:** keine harten ·
> **Erwartete Größenordnung:** 1 PR, Minor-Version (feat)

## Session-Prompt

```text
# Mission: Qualitätsprüfung für Kerzenserien + deterministische
# Multi-TF-Aggregation (GAP-07)

Du arbeitest als Senior-Engineer im Repository „ai-trading-firm“ (Node.js
20+/TypeScript strict, Next.js 16, Drizzle + PostgreSQL, node:test,
Paper-Trading only). Stand: Die Fehler-Taxonomie (MDERR) existiert
(src/marketdata/dataErrors.ts) mit strukturierten Logs/Metriken/Manifest;
leere Kerzen gelten seit v1.40.0 als DATA_UNAVAILABLE (nicht stiller
Erfolg); der Historical Store ist timeframe-dimensioniert
(instrumentId+timeframe+ts). Es fehlen: Gap-Detection, Outlier-Filter,
Plausibilitätsregeln, 1h→4h/1d-Aggregation, Zweitquellen-Cross-Check.
Grundprinzip dieser Session: Qualitätsbefunde werden SICHTBAR klassifiziert
(MDERR-Stil) — gespeicherte Historie wird nie still verändert, und echte
Flash-Moves dürfen nicht weggefiltert werden.

## Schritt 1 — Ist-Stand verifizieren (Pflicht)

Lies vollständig: src/marketdata/dataErrors.ts (Taxonomie + IDs),
src/marketdata/sync.ts (Schreibpfad), src/marketdata/syncStatus.ts +
dataErrors.ts (resolveRuntimePath-Muster), src/lib/marketdata/
historicalStore.ts (Lesepfad, Zeitmaske), src/marketdata/types.ts
(Kerzen-Schema v2), docs/OBSERVABILITY.md + docs/HISTORY.md,
tests/marketdata* + test/marketdata/** (Testmuster). Abweichung → Rest-Delta,
im PR dokumentieren.

## Schritt 2 — Delta umsetzen

D1 QUALITÄTSPRÜFUNG (neu src/marketdata/quality.ts):
   - validateCandleSeries(series, {expectedIntervalMs}) → Befunde mit
     neuen MDERR-Klassen (Taxonomie erweitern, IDs dokumentiert):
     GAP (fehlende Intervalle), OUTLIER (Wick/Körper > MARKETDATA_OUTLIER_ATR_MULT
     × ATR, Default 25, Bounds [5, 200] — bewusst großzügig, echte Flash-
     Moves müssen durchkommen; Grenzfall wird getestet), INVALID (OHLC
     <= 0, high < low, close außerhalb [low, high]), DUPLICATE (ts doppelt).
   - Befunde NICHT still löschen: Report je Instrument
     (data/marketdata/quality-report.json via resolveRuntimePath) + Log +
     Metrik (telemetry-Counter je Klasse).
   - Verdrahtung: (a) Schreibpfad (sync.ts) — Befunde landen im Sync-Report/
     Fehler-Manifest; (b) Lesepfad — Modus MARKETDATA_QUALITY_MODE:
     „log“ (Default: nur sichtbar machen) | „strict“ (INVALID-Fenster
     behandeln wie DATA_UNAVAILABLE → bestehende Stale-Fallback-Kette,
     fail-closed). Historie-Dateien werden NIE mutiert.
D2 STALE-GUARD je Instrument/Timeframe: Schwellen je TF konfigurierbar
   (MARKETDATA_STALE_1H_HOURS Default 26, Bounds [2, 168]; sinngemäß 4h/1d),
   Ausweis im Sync-Status (syncStatus.ts), damit Ops-Center/Scanner gut
   degradieren.
D3 MULTI-TF-AGGREGATION (neu src/marketdata/aggregate.ts):
   - 1h → 4h/1d deterministisch: UTC-Anker (4h: 00/04/08/12/16/20 UTC;
     1d: 00:00 UTC), OHLCV-Korrektheit, Konsistenz-Check
     (high >= max(highs), low <= min(lows)).
   - Unvollständige letzte Kerze wird NIEMALS aggregiert (wird als partial
     markiert/ausgeschlossen — Test!).
   - Optional per Flag MARKET_SYNC_AGGREGATE (Default off) im Sync-CLI
     nutzbar; Zeitmaske bleibt gewahrt (nur abgeschlossene Intervalle ≤ t).
D4 ZWEITQUELLEN-CROSS-CHECK: Nur Interface + Vertrag (optionale Methode am
   Adapter-Registry-Muster) + Flag MARKETDATA_CROSSCHECK (Default off —
   Rate-Limits!). Wenn on: Abweichung > MARKETDATA_CROSSCHECK_TOLERANCE_PCT
   (Default 1, Bounds [0.1, 10]) → MDERR-Befund + Alert-Log. KEINE echte
   neue Venue-Anbindung in diesem PR (Scope-Disziplin).

## Grundregeln (Baseline der Serie, verbindlich)

Paper-only · Fail-closed (strict-Modus) bei sichtbar gemachtem Befund ·
keine neuen Runtime-Dependencies · Schwellen mit Bounds + Default + Eintrag
in .env.example UND CONFIGURATION.md · keine Secrets · keine Mutation
gespeicherter Historie durch den Qualitäts-Layer · Determinismus ·
Pflicht-Checks: npm run typecheck && npm run lint && npm test &&
npm run docs:validate — 0 Failures (Ausnahme ENV-01) · CHANGELOG +
Versions-Bump (package.json, Status-Header, docs/README.md) · nur dieses
Delta; Neben-Bugs in „Offene Punkte“.

## Schritt 3 — Tests (neu test/marketdata/quality.test.ts + aggregate.test.ts,
Pfad nach Nachbar-Muster)

- GAP an erwarteter Position erkannt (Intervallgrenzen exakt).
- INVALID-Fälle (high<low, OHLC<=0) erkannt; strict-Modus →
  DATA_UNAVAILABLE-Fallback greift; log-Modus schreibt nur Report.
- Outlier: künstlicher Wick jenseits der Schwelle wird markiert; ein
  realistischer Flash-Move UNTERHALB der Schwelle NICHT (Grenzwert-Test:
  genau ATR_MULT → kein Befund).
- Aggregation: 4h-Anker korrekt (00/04/… UTC), OHLCV konsolidiert, high/low-
  Envelope korrekt, unvollständige Schlusskerze ausgeschlossen, zwei Läufe →
  byte-identisches Ergebnis (Determinismus).
- Stale-Guard: Fake-Clock über Schwelle → Status deprecated/stale gesetzt.
- Keine Mutation der Eingabeserie (Objekt-Freeze-Vergleich).

## Schritt 4 — Docs & Meta

- docs/MARKET_DATA_PIPELINE.md: Sektion „Qualitäts-Layer & Aggregation“
  (Klassen, Flags, Report-Pfad, strict/log-Politik).
- docs/OBSERVABILITY.md: neue MDERR-Klassen in die Taxonomie-Tabelle.
- CONFIGURATION.md + .env.example: neue Flags. CHANGELOG (feat, Minor-Bump)
  + Status-Header + docs/README.md. TRACKING.md pflegen; Finding „Umsetzung“
  ergänzen.

## Abnahme (Definition of Done)

[ ] Ist-Stand verifiziert; D1–D4 umgesetzt und je getestet
[ ] Gespeicherte Historie bleibt unangetastet (Test belegt)
[ ] Flash-Move-Schutz (Grenzwert-Test) existiert
[ ] Flags in .env.example + CONFIGURATION.md; Defaults log/off
[ ] typecheck + lint + npm test + docs:validate grün (Zahlen im PR)
[ ] CHANGELOG/Version + TRACKING.md + Finding aktualisiert
[ ] PR-Beschreibung vollständig
```
