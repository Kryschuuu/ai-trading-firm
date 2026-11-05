# PROMPT-BP-02 — Technical-Analyst-Step nutzt berechnete Indikatoren

## Auftrag

Stelle den Daily-Cycle-Schritt **04-technical-analyst** im Repository
`Kryschuuu/ai-trading-firm` von LLM-geschätzten auf **berechnete** Indikatoren
um. Der Prompt ist eigenständig: prüfe zuerst Branch, Arbeitsbaum und aktuellen
Code; Audit-Basis war Commit `7d8b07b` (`v1.51.3`). Bei Abweichung adaptiere
minimal und vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/BP-02-technical-analyst-berechnete-daten.md`](../findings/BP-02-technical-analyst-berechnete-daten.md)
Priorität/Schwere: **HIGH**
Schätzung des Restaufwands: **2–4 PT**
Abhängigkeit: **PROMPT-BP-01** (nutzt ggf. die neuen Snapshot-Felder); kann
aber schon vor BP-01 umgesetzt werden — dann ohne die neuen Felder.

## Verifizierter Ausgangszustand

- `src/cycle/steps/technicalStep.ts:75-102` fordert im Prompt „RSI and ATR
  estimates“; der deterministische Fallback liefert `rsi: 50`,
  `keyLevels: { support: 0, resistance: 0 }`.
- `src/cycle/steps/researchStep.ts:138-139` reicht die Analysen als
  „Technical context“ an den Research-Agenten.
- Deterministische Quelle vorhanden: `buildSnapshotFromCandles()` in
  `src/lib/ruleEngine.ts:566` (RSI, ATR, EMAs, Trend aus Kerzen);
  `src/lib/indicators.ts` liefert ATR/ADX/BBW/StdDev.
- Der Makro-Zyklus (`macroCycle.ts`) nutzt bereits echte Snapshots — der
  Tageszyklus ist die Ausnahme.

## Zielzustand

Der Technical-Analyst erhält je Instrument einen **berechneten** Kontext
(Snapshot-Werte + deterministische Key-Level und ATR-Band) und bewertet diesen
analytisch — ohne Aufforderung, Kennzahlen zu raten. Fallback-Zahlen sind real
berechnet (neutrale Level aus rolling High/Low, ATR-Band), nie `0`/`50`-Platzhalter.

## Vor Beginn gezielt prüfen

- `src/cycle/steps/technicalStep.ts`
- `src/cycle/steps/researchStep.ts`
- `src/lib/ruleEngine.ts` (`buildSnapshotFromCandles`, `RuleSnapshot`)
- `src/cycle/schemas.ts` (`TechnicalStepOutput`, Validierung)
- zugehörige Tests (nur lesend bestätigen, dass der Step deterministisch ist)

## Verbindlicher Implementierungsumfang

1. **Kontextaufbau:** `buildSnapshotFromCandles()` je Instrument (Candles aus
   dem HistoricalStore, `DEFAULT_ANALYSIS_TIMEFRAME`); Ergebnis als
   `technical context`-Block an den Agenten geben — markiert als
   `(computed, not estimates)`.
2. **Key-Level deterministisch:** Rolling-High/-Low (Fenster 20), Support/
   Resistance aus diesen; optional ATR-Band je 1× / 2× ATR als
   Stop-/Ziel-Orientierung. Keine Modellschätzung für Zahlenwerte.
3. **Fallback reparieren:** keine `{support: 0, resistance: 0}`- oder `rsi: 50`-
   Platzhalter; bei fehlenden Kerzen `referenceMissing`-Status nutzen (Fail-soft,
   konsistent mit dem Plausibilitätspfad GAP-08).
4. **Prompt-Text:** „estimates“-Aufforderung entfernen; Einheiten und Herkunft
   der Werte explizit benennen.
5. **Research-Step:** Kontext-Format unverändert durchreichen; keine
   Schema-Brüche.

## Explizit nicht Teil dieses Changes

- keine neue Regime-/Konfluenzlogik (RMA-P2-01/P2-03 bleiben außen vor)
- keine RSI/ATR-Neuberechnung an dritter Stelle — einzige Quelle:
  `indicators.ts`/`buildSnapshotFromCandles`
- kein Umbau der Schema-Validierung des Steps

## Produktions- und Sicherheitsregeln

- Echter End-to-End-Pfad: Store → Snapshot → Prompt-Kontext → Artefakt;
  keine Mock-only-Lösung.
- Fehlende/stale Daten fail-closed: niemals `0`/`50` als neutrale Zahl in die
  Analyse einschleusen; `referenceMissing` sichtbar ausweisen.
- Externe Daten bleiben Daten (keine Prompt-Instruktionen); Anti-Injection-
  Zeilen im Step unangetastet lassen.
- Bounded Metriken; keine High-Cardinality-Labels.
- Keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] gleiche Kerzen ⇒ byte-stabile Kontext-Snapshots inkl. Artefakt
- [ ] kein „estimates“-/Raten-Auftrag mehr im erzeugten System-Prompt
- [ ] Fallback nullfrei (keine 0/50-Platzhalter bei fehlenden Kerzen)
- [ ] Support/Resistance ergeben sich aus rolling High/Low (Handbeleg)
- [ ] bestehende Cycle-Tests und GAP-08-Plausibilitätslogik grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Research-Artefakt (`07-research.json`) zeigt berechnete statt geratener
      Kennzahlen (kein „estimates“-Bezug).
- [ ] Referenzen auf RSI/Signal im Code bleiben konsistent zu
      `indicators.ts` (Einheit testen).
- [ ] kein Verhaltensbruch der Step-Validierung und Plausibilitätsregeln.

## Dokumentation, Versionierung und Tracking

1. Kommentare/Doku des Steps und `docs/DAILY_CYCLE.md` (bzw. zuständige
   Dokumentation) aktualisieren.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, End-to-End-Verhalten, Kompatibilitätshinweise, ausgeführte
Tests mit Ergebnis, verbleibende Risiken sowie Commit-/PR-Link.