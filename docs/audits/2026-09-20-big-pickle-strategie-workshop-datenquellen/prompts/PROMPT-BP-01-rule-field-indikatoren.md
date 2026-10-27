# PROMPT-BP-01 — Regel-Engine: ADX, BB-Bandbreite und MACD als Regel-Felder

## Auftrag

Implementiere die Erweiterung der Regel-Bedingungsschicht um die Indikatoren
**ADX(14)**, **Bollinger-Bandbreite** und **MACD** produktionsreif im Repository
`Kryschuuu/ai-trading-firm`. Der Prompt ist eigenständig: prüfe zuerst den
aktuellen Branch und Code; Audit-Basis war Commit `7d8b07b` (`v1.51.3`). Wenn
der aktuelle Stand abweicht, übernimm die Absicht mit minimalem Scope und
vermerke die Abweichung im PR.

Zugehöriger Befund: [`../findings/BP-01-rule-field-indikatoren.md`](../findings/BP-01-rule-field-indikatoren.md)
Priorität/Schwere: **HIGH**
Schätzung des Restaufwands: **3–5 PT**

## Verifizierter Ausgangszustand

- `src/lib/indicators.ts` implementiert bereits `ema()`, `rsi()`, `atrPct()`,
  `adx()` (:109), `bollingerBandWidthPct()` (:54), `returnStdDevPct()` (:79);
  `macd()` fehlt.
- `src/lib/ruleEngine.ts:45-59` (`RULE_FIELDS`, Whitelist),
  `:125-141` (`RuleSnapshot`), `:566` (`buildSnapshotFromCandles`),
  `:156-171` (`RULE_CEILINGS`), `:783-840` (`RULE_LLM_SCHEMA`, Feld-Enum
  automatisch aus `Object.keys(RULE_FIELDS)`).
- `src/lib/adaptiveRisk.ts:507-508` und `src/lib/marketRegime.ts:368` nutzen
  ADX/BBW/StdDev bereits für das Firmen-Volatilitätsregime.
- Bedingungen liegen in `trade_rules.condition` (`jsonb`) — **keine** Migration
  nötig. `signature`-Hash deckt Feldänderungen automatisch ab.

## Zielzustand

Eine Regel kann deterministische Bedingungen auf `adx14`, `bbWidthPct`,
`macdHist` und `macdSignal` formulieren (alle Operatoren `lt/lte/gt/gte/eq/
between/in`), geklemmt an harte Code-Ceilings, mit identischer Semantik in
Snapshot, LLM-Schema und Makro-Prompt.

## Vor Beginn gezielt prüfen

- `src/lib/indicators.ts`
- `src/lib/ruleEngine.ts` (Feldsatz, Snapshot, `buildSnapshotFromCandles`,
  `RULE_CEILINGS`, `RULE_LLM_SCHEMA`; `MIN_CANDLES`-Konstante)
- `src/lib/macroCycle.ts` (Prompt-/Schema-Zeilen zu Regel-Feldern)
- `tests/indicators.test.ts`, `tests/ruleEngine*.test.ts`, `tests/macroCycle*`
  (oder aktuell äquivalente Pfade)

Suche zusätzlich nach allen Call Sites und Vergleichstests. Pfade dürfen seit
dem Audit verschoben worden sein; implementiere nicht parallel zu bereits
vorhandener äquivalenter Logik.

## Verbindlicher Implementierungsumfang

1. **`macd()`** in `indicators.ts`: EMA-Diff (12/26), Signal-EMA (9),
   Histogramm; Ausgabe als Objekt; Hand-rechenbare Signaturen.
2. **`RULE_FIELDS`** um `adx14`, `bbWidthPct`, `macdHist`, `macdSignal`
   erweitern (alle `"number"`); `RuleSnapshot` entsprechend.
3. **`buildSnapshotFromCandles()`** berechnet die neuen Felder look-ahead-frei
   (nur bereits geschlossene Kerzen; Warmup-Grenzen dokumentieren).
4. **`RULE_CEILINGS`** um plausible Bounds ergänzen (z. B. ADX 0–100, BBW in
   %, MACD-Größenordnung als offene Grenzen mit `finiteNumber`-Klemmung) und
   in Code-Kommentaren Einheiten/Semantik festhalten (BBW = Prozent der SMA,
   wie `indicators.ts` definiert).
5. **`RULE_LLM_SCHEMA`**: Unit-/Semantik-Beschreibungen für die neuen Felder
   ergänzen (Enum propagiert automatisch); Makro-Zyklus-Prompt-Zeilen um die
   neuen Felder und ihre Einheiten ergänzen.
6. **Doku:** `docs/BACKTESTING.md` bzw. zuständige Regel-Doku-Abschnitte um die
   neuen Felder erweitern.

## Explizit nicht Teil dieses Changes

- keine Änderung an `RuleAction`/Stops (siehe PROMPT-BP-07)
- keine neue Indikatoren-Bibliothek; keine Orderbuch-/Fundus-Indikatoren
- keine Änderung des Technical-Analyst-Step (siehe PROMPT-BP-02)

## Produktions- und Sicherheitsregeln

- Implementiere einen echten End-to-End-Pfad: Feld → Klemmung → Snapshot →
  Evaluator → LLM-Schema. Keine Mock-only-Lösung.
- `null`-Rückgaben (z. B. wenige Kerzen) bleiben `null`; sie werden in der
  Bedingungsauswertung nicht als `0` behandelt (fail-closed).
- Risk-Ceilings, Kill-Switches und die `RULE_ALLOWED_SIDE = "LONG"`-Grenze
  unangetastet lassen.
- Keine Secrets, keinen unredigierten Provider-Payload; externe Daten bleiben
  Daten.
- Keine TODOs, `any`-Fluchten oder still geschluckten Fehler.

## Pflicht-Tests

- [ ] `macd()`-Handrechnung gegen eine bekannte kleine Serie (Golden Values)
- [ ] neue Felder kompilieren und evaluieren inkl. `between`/`in`
- [ ] Felder sind außerhalb ihrer `RULE_CEILINGS`-Bounds geklemmt (sanitizePath)
- [ ] `buildSnapshotFromCandles` mit < Warmup liefert `null`, nie `0`
- [ ] `RULE_LLM_SCHEMA` enthält die neuen Felder; Makro-Prompt-Test grün
- [ ] Determinismus: identische Kerzen ⇒ identischer Snapshot/Werte
- [ ] relevante bestehende Regressionstests grün

Führe vor Abschluss mindestens aus:

```bash
npm run typecheck
npm run lint
npm test
npm run docs:validate
```

## Akzeptanzkriterien

- [ ] Regel „`adx14 > 20`“, „`bbWidthPct between 1.5 and 4`“ und
      „`macdHist > 0 && ema9 > ema21`“ sind auf einem Dummy-Snapshot
      evaluierbar und liefern erwartete Ergebnisse.
- [ ] Einheiten und Semantik stehen in Code-Kommentar und Doku.
- [ ] kein Verhaltensbruch bestehender Regeln (Kompatibilitätstest).
- [ ] kein Secret/Artefakt im Diff.

## Dokumentation, Versionierung und Tracking

1. Betroffene READMEs, API-/Code-Dokumentation und Kommentare aktualisieren.
2. Root-`CHANGELOG.md` pflegen; `docs/CHANGELOG.md` bleibt nur Stub/Pointer.
3. `package.json`/`package-lock.json` nach SemVer konsistent erhöhen.
4. Finding + `../remediation/TRACKING.md` erst bei belegter DoD mit PR, Commit,
   Tests und Fix-Version auf `FIXED` setzen.
5. Aussagekräftig committen, `arena/*`-Branch pushen, PR mit Risiko-/Test-/
   Rollback-Hinweisen öffnen.

## Erwartete Abschlussmeldung

Kurze Liste der geänderten Dateien, das implementierte End-to-End-Verhalten,
Migrations-/Kompatibilitätshinweise, ausgeführte Tests mit Ergebnis,
verbleibende Risiken sowie Commit- und PR-Link. Behaupte nichts als fertig,
das nicht durch Code und Tests belegt ist.