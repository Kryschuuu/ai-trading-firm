# STX-02-04 — Feature-Store-Slice `rule.*` *(optional)*

- **Phase:** 2 · **Paket:** 02-02, 02-03 · **Finding:** STX-10
- **Risiko:** mittel · **Status: OPTIONAL — blockiert nichts in Phase 3–7**

## Zweck

Der Feature Store (`src/features/*`) ist heute auf **drei** Features beschränkt
(`scanner.rsi`, `scanner.atr`, `scanner.atr_band`) und wird in der Analyse als
„zentraler Feature-Layer" bezeichnet — das ist eine Größenordnungs-Unterschätzung.
Dieser Prompt materialisiert **optional** die neuen Regelfeatures in den Store, damit
Scanner/Regeln/Backtest später aus **einer** Quelle lesen können.

**Wenn Phase 3–6 ohne diesen Slice auskommt, ist das ein gültiges Ergebnis.** Bitte
dann mit einem leeren PR-Protokoll „deferred" schließen, nicht mit einer halben Lösung.

## Kontext

Die Store-Konventionen sind streng und dürfen nicht aufgeweicht werden:
- `FeatureDefinition` mit `version`, `owner`, `configHash` ⇒ Konfigurationsänderung
  erzeugt eine **neue** Definitionsversion, nie eine Umschreibung
- PIT-Regeln: `calculatedAsOf ≤ availableAt ≤ asOf`; `computedAt` ist **kein**
  Zulässigkeitskriterium
- fail-closed: nicht berechenbar ⇒ Wert mit Grund, **nie** 0
- `tests/featureStore.test.ts` erzwingt Deckungsgleichheit mit den Scanner-Defaults —
  driftende Defaults sind ein **Testfehler**, kein Semantikwechsel

## Auftrag

1. Lege `rule.bb_zscore`, `rule.price_vs_upper_bb_pct`, `rule.donchian_breakout_pct` als
   `FeatureDefinitionInput` an (Schema `namespace.name`, `owner: "rule"`).
2. `src/features/compute.ts`: Exekutoren, die **dieselben** `src/lib/indicators.ts`-Funktionen
   aufrufen. **Keine zweite Formel-Implementierung.**
3. `src/features/materialize.ts` anbinden; Backfill nur mit
   `AvailabilityPolicy: "ingested"` (fail-closed, Produktionsdefault).
4. **Parität festschreiben** — das ist der eigentliche Punkt dieses Prompts:
   - `npm run features:parity` (bestehendes Skript) deckt **keine** `rule.*`-Features ab
   - ergänze einen Paritätstest: für N Fixture-`(instrument, timeframe)` gilt
     `featureValue == RuleSnapshot-Feld` **exakt** (nicht toleranzbehaftet)
   - bei Abweichung: **nicht** glätten, sondern den Test rot lassen und die Ursache melden
5. Bestehende Consumer (`src/scanner`, `src/cycle`, `src/backtest`) **nicht** umstellen —
   der Store bleibt ein **zusätzlicher** Lesepfad.

## Akzeptanzkriterien

- [ ] Drei `rule.*`-Definitionen mit vollständiger Semantik-Doku (Muster `definitions.ts`)
- [ ] Paritätstest über mindestens 3 Timeframes, **exakte** Gleichheit
- [ ] PIT-Invarianten getestet (`availableAt > asOf` ⇒ ausgeschlossen)
- [ ] Scanner-/Backtest-Verhalten **unverändert**
- [ ] `npm run typecheck && npm run lint && npm test && npm run features:parity` grün
- [ ] Doku: `docs/FEATURE_STORE.md` um den Slice `rule.*` ergänzt

## Gesperrt

- **Kein Umbau** des Stores — keine bestehende Definition angefasst.
- **Keine** Umstellung von Scanner oder Backtest auf den Store.
- Keine Felder ohne Fail-closed-Verhalten.
- Wenn der Paritätstest rot bleibt: **nicht** mit Toleranz zureden, sondern als
  Folge-Prompt melden.
