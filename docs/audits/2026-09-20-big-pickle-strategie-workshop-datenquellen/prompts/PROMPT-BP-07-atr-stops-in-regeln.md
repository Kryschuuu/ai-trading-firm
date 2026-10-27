# PROMPT-BP-07 — ATR-basierter Stop als Regel-Feld (`atrStopK`)

## Auftrag

Ergänze in der Regel-Sprache des Repositories `Kryschuuu/ai-trading-firm` das
optionale Action-Feld **`atrStopK`** (Stop-Distanz als `k` × ATR), sodass Regeln
adaptive Stops ausdrücken können, ohne auf feste Prozentwerte angewiesen zu
sein. Der Prompt ist eigenständig; Audit-Basis war `7d8b07b` (`v1.51.3`). Bei
Abweichung adaptiere minimal und dokumentiere sie.

Zugehöriger Befund: [`../findings/BP-07-atr-stops-in-regeln.md`](../findings/BP-07-atr-stops-in-regeln.md)
Priorität/Schwere: **MEDIUM**
Schätzung des Restaufwands: **2–3 PT**
Hinweis: `RULE_FIELDS`/`RuleAction`-Modul wird auch von PROMPT-BP-01 berührt —
bei zeitgleicher Umsetzung im selben PR koordinieren.

## Verifizierter Ausgangszustand

- `src/lib/ruleEngine.ts:89-96` — `RuleAction` mit Pflicht `stopLossPct`
  (Klemmung `:358`, Default 5); kein ATR-Feld.
- `src/lib/positionSizing.ts` — Fallback-Stop via `RISK_ATR_STOP_MULT`
  (Bounds [0.5, 6]) existiert im Sizing, ist aber pro Regel nicht einstellbar.
- `src/lib/riskGuard.ts` — `RiskLimits.atrStopMultiplier` vorhanden.
- `src/db/schema.ts:117` — `trade_rules.action` ist `jsonb` ⇒ **keine**
  Migration; `signature`-Hash (`:121`) deckt neue Action-Felder automatisch ab.

## Zielzustand

Eine Regel kann alternativ zu `stopLossPct` ein `atrStopK` (Bounds [0.5, 6])
tragen; die Stop-Distanz entsteht aus `k × ATR%` des aktuellen Snapshots. Bei
beiden Feldern gewinnt explizit gesetztes `stopLossPct` (dokumentierter
Vorrang). Sizing berechnet die Positionsgröße auf Basis der ATR-Distanz über
dieselbe `riskAdjustedSize()`-Logik.

## Vor Beginn gezielt prüfen

- `src/lib/ruleEngine.ts` (`RuleAction`, `RuleSpec`, `sanitizeRuleSpec`,
  `RULE_CEILINGS`, `RULE_LLM_SCHEMA`)
- `src/lib/positionSizing.ts` (ATR-Fallback, `riskAdjustedSize`)
- `src/lib/riskGuard.ts` (`atrStopMultiplier`-Semantik)
- `src/cycle/schemas.ts` (Trade-Setup-Schema, falls Setup-Export betroffen)
- Tests: `tests/ruleEngine*.test.ts`, Sizing-Tests

## Verbindlicher Implementierungsumfang

1. **Feld:** `RuleAction.atrStopK?: number` (optional), Klemmung gegen neue
   `RULE_CEILINGS.atrStopK = [0.5, 6]`; `sanitizeRuleSpec` validiert und
   normalisiert.
2. **Vorrang-Semantik:** ist `stopLossPct` gesetzt, gewinnt es; sonst wird der
   Stop zur Evaluation als `atrStopK × atrPct` (aus `RuleSnapshot`) bestimmt;
   fehlender `atrPct` ⇒ Regel kann nicht feuern (fail-closed).
3. **Sizing:** `positionSizing.ts` bekommt einen atrStopK-Pfad vor dem
   dokumentierten Fallback; Einheitengleichheit mit `riskAdjustedSize`
   sicherstellen.
4. **LLM-Schema:** `atrStopK` mit Bounds und Vorrangregel beschreiben;
   Makro-Zyklus-Prompt-Zeilen ergänzen.
5. **Doku:** Regel-/Sizing-Doku-Abschnitte aktualisieren.

## Explizit nicht Teil dieses Changes

- keine Änderung an Exit-Semantik/`decideExit()` (siehe PROMPT-BP-05)
- keine neuen Indikatoren (siehe PROMPT-BP-01)
- kein Zwang auf ATR-Stops — fester `stopLossPct` bleibt voll unterstützt

## Produktions- und Sicherheitsregeln

- Regelwerte bleiben hinter `RULE_CEILINGS`; fail-closed bei fehlendem
  `atrPct` (kein Ersatzwert `0`/Default).
- Abwärtskompatibilität: alte Regeln ohne `atrStopK` byte-identisch
  (signature + Verhalten).
- Keine Secrets; keine TODOs, `any`-Fluchten, still geschluckten Fehler.

## Pflicht-Tests

- [ ] `atrStopK` geklemmt (0.4 → 0.5, 7 → 6) und validiert
- [ ] Vorrang: bei beiden Feldern gewinnt `stopLossPct` (Handtest)
- [ ] fehlender `atrPct` ⇒ „kann nicht feuern“, nie stiller 0-Wert
- [ ] Sizing: PosGröße bei ATR-Stop über `riskAdjustedSize` (Formel-Golden)
- [ ] DB-Roundtrip `action` (jsonb) und `signature`-Stabilität
- [ ] alte Regeln ohne Feld unverändert (Kompatibilität)
- [ ] relevante bestehende Tests grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Regel mit `atrStopK: 2` evaluiert identischen Stop wie `2 × atrPct`.
- [ ] Bounds/Vorrang stehen in Code-Kommentar, LLM-Schema und Doku.
- [ ] kein Verhaltensbruch der `stopLossPct`-Pfade.

## Dokumentation, Versionierung und Tracking

1. Regel-/Sizing-Doku und `docs/BACKTESTING.md`-Verweise aktualisieren.
2. Root-`CHANGELOG.md` pflegen.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD auf `FIXED`.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR öffnen.

## Erwartete Abschlussmeldung

Geänderte Dateien, implementierte ATR-Stop-Semantik, Kompatibilitätshinweise,
ausgeführte Tests mit Ergebnis, verbleibende Risiken sowie Commit-/PR-Link.