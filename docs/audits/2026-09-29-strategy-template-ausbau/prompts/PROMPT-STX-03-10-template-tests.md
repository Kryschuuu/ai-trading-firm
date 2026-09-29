# STX-03-10 — Template-Vertragstests + Katalog-Vollständigkeit

- **Phase:** 3 · **Paket:** 03-09 · **Finding:** STX-18
- **Risiko:** niedrig · **Abschluss der Phase 3**

## Zweck

Die fünf/sechs Templates sind jetzt kompilierbar. Dieser Prompt macht daraus einen
**abgesicherten Vertrag**: ein Template, das seine eigenen Zusagen bricht (unzulässige
Felder, Bounds-Verletzungen, Deckungsgleichheit mit der Engine), fällt durch.

## Auftrag

Lege `tests/strategies.templates.test.ts` an. Teste für **jedes** Template im Katalog:

### 1. Strukturelle Invarianten (über `validateTemplate`)
- `validateTemplate(t)` ⇒ `[]`
- alle `params` erfüllen `min ≤ default ≤ max` und `default/step ∈ ℤ ∪ Toleranz`
- `requiredFields ⊆ RULE_FIELDS`; jedes `mapsTo ∈ RULE_FIELDS`
- `class ∈ STRATEGY_CLASS_KEYS` und `≠ "unclassified"`
- `supportedTimeframes ⊆ SUPPORTED_TIMEFRAMES`; nicht leer; keine Duplikate
- jedes `expectedRegimes` ist ein gültiges `MarketRegimeLabel`
- jede `assumptions.id` eindeutig; mindestens eine `critical: true` **pro** Template

### 2. Compiler-Parität
- `compileTemplate` mit Defaults ⇒ `{ok:true}` **ohne** `clamped`
- derselbe Aufruf zweimal ⇒ identischer `fingerprint`
- `symbol` wird **nicht** aus dem Template übernommen
- `sourceRole` ist `"RESEARCH"`

### 3. Snapshot-Kompatibilität (der eigentliche Wert)
Für jedes Template, über alle `supportedTimeframes`:
- laufe `backtestRule(spec, fixtureCandles)` mit einem **deterministischen** Fixture
- beweise: bei `null`-Snapshot-Feldern (zu wenig Historie) bleibt die Regel
  **inert** — `backtestRule` darf keinen Entry erzeugen
- beweise: das Template erzeugt **mindestens einen** Entry auf einer Fixture, die
  seinen Bedingungen entspricht (sonst ist es ein totes Template)

### 4. Negativ-Fixtures je Template
- Bedingung um 1 Feld gekürzt ⇒ **kein** Entry (wirkt die Bedingung?)
- Schwellwert auf den Extremwert ⇒ **kein** Entry (greift die Grenze?)
- Feld auf `null` gesetzt (wo das Feld `null` sein kann) ⇒ **kein** Entry
  *(fail-closed — der wichtigste Einzelfall)*

### 5. Katalog-Integrität
- `STRATEGY_TEMPLATES` enthält genau die 6 erwarteten IDs, keine Duplikate
- `assertTemplatesValid()` läuft beim Modul-Import ohne Fehler
- `getTemplate("nicht-vorhanden")` ⇒ `null` (nicht `throw`)
- `templateByField("bbZScore")` ⇒ genau `["bollinger-squeeze"]`
- `templateByField("donchianBreakoutPct")` ⇒ genau `["donchian-breakout"]`

### 6. **Parität Engine ↔ Cache** (Regression aus Phase 2 festnageln)
- Für je ein Bollinger- und ein Donchian-Template: identische Fixture-Kerzen
  → `buildSnapshotFromCandles` und `snapshotFromCache(buildIndicatorCache(...))`
  liefern **exakt gleiche** Werte für die neuen Felder.
- *(Wenn dieser Test rot ist, ist 02-02/02-03 unvollständig — nicht mit Toleranz
  glätten, sondern als Folge-Prompt melden.)*

### 7. Zeitrahmen-Disziplin
- Für jedes Template: wenn es `vwapPct` in `requiredFields` hat, enthält
  `supportedTimeframes` **kein** `1d` (STX-01)

## Akzeptanzkriterien

- [ ] `tests/strategies.templates.test.ts` grün, deckt **alle 6** Templates ab
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] **Kein Produktivcode** in diesem Prompt geändert (außer Fehlerkorrekturen, die
      du dann im Commit explizit nennst)
- [ ] `docs/STRATEGY_TEMPLATES.md` (neu, kurz): Tabelle aller 6 Templates mit
      Klasse, Timeframes, Parametern, Annahmen — **aus dem Code generiert** oder
      explizit als `docs:validate`-geprüfter Verweis
- [ ] `CHANGELOG.md` ergänzt

## Abschluss-Gate Phase 3 → 4

Erst wenn diese Tests grün sind, gilt:
> 6 versionierte Strategie-Artefakte existieren, kompilieren über den
> unveränderten Sicherheitspfad und sind gegen die Engine vertraglich abgesichert.

Dann folgt 04-01 (Persistenz). **Ohne 04-01 bleibt jede Version nur ein
Katalogeintrag im Code — rekonstruierbar ist sie dann immer noch nicht.**

## Gesperrt

- Keine Änderung an `ruleEngine.ts`, `sanitizeRuleSpec`, `indicators.ts`,
  `indicatorCache.ts` — **außer** einem echten Paritätsfehler, der dann als
  eigener Prompt gemeldet wird.
- Keine neuen Templates in diesem Prompt.
- Keine DB, kein Netzwerk in den Tests (Fixtures aus `tests/`, Muster
  `tests/backtest.unit.test.ts`).
