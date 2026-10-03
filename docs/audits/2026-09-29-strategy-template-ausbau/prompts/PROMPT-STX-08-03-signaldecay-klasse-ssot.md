# STX-08-03 — Strategie-Klassen in `signalDecay*` aus der SSoT ableiten

- **Phase:** 8 · **Paket:** eigenständig · **Finding:** [STX-02](../findings/STX-02-strategyclass-duplikat.md) (Restpunkt) / Altlast 1 (OP-6)
- **Risiko:** gering (typ- und wachstumssichernd, kein Verhalten)

## Zweck

[ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)
legt fest: Eine neue Strategieklasse darf **nur per neuem ADR** entstehen. Heute
müsste sie an mindestens fünf Stellen gleichzeitig eingetragen werden, sonst
fällt sie still auf `unclassified` zurück. Dieser Prompt macht die Liste
ableitbar, damit ein ADR ausreicht.

## Kontext

Single Source of Truth ist `src/lib/marketRegime.ts:133`:

```ts
export const STRATEGY_CLASSES: readonly StrategyClass[] = ["mean-reversion", "trend", "breakout"];
```

Davon unabhängig stehen die Klassen als **Literale** in:

| Fundort | Zeile | Form |
|---|---|---|
| `src/lib/signalDecay.ts` | `107-111` | `STRATEGY_CLASS_KEYS = ["mean-reversion","trend","breakout","unclassified"]` |
| `src/lib/signalDecay.ts` | `433` | `isStrategyClassKey()` — vier `===`-Vergleiche |
| `src/lib/signalDecay.ts` | `1545-1546` | lokale Closure `classOf()` — vier Literale + `mean_reversion`-Alias |
| `src/lib/signalDecayRuntime.ts` | `494` | vier `===`-Vergleiche |

`src/lib/signalDecay.ts:86` importiert bereits `type { StrategyClass } from "./marketRegime"` —
der Importweg existiert also.

Der vierte Fall (`src/strategies/service.ts`) ist bereits behoben: der Service
liest `STRATEGY_CLASSES`, gedeckt durch `tests/adrVocabulary.test.ts`.

**Zwei Stellen sind bewusst keine Klasse-Literale und bleiben:**
- `DEFAULT_CLASS_POLICIES` (`signalDecay.ts:361-…`) — ein Objekt **mit**
  Klassenschlüsseln; es muss je Klasse einen Eintrag haben.
- `SIGNAL_DECAY_CLASS_*`-Env-Zuordnung (`signalDecay.ts:643`) — Env-Namen sind
  Konfiguration, kein Vokabular.

## Auftrag

1. Leite in `src/lib/signalDecay.ts` `STRATEGY_CLASS_KEYS` ab:
   ```ts
   export const STRATEGY_CLASS_KEYS: readonly StrategyClassKey[] = [...STRATEGY_CLASSES, "unclassified"];
   ```
   Der **exportierte Typ** `StrategyClassKey` und die Reihenfolge
   (`mean-reversion`, `trend`, `breakout`, `unclassified`) bleiben identisch —
   `tests/adrVocabulary.test.ts:202` prüft genau diese Reihenfolge.
2. Ersetze die Literalvergleiche in `isStrategyClassKey()`
   (`signalDecay.ts:433`) und in `signalDecayRuntime.ts:494` durch einen
   Lookup gegen `STRATEGY_CLASS_KEYS`.
3. Ersetze die Literalvergleiche in der lokalen Closure `classOf()`
   (`signalDecay.ts:1545`) ebenfalls. Der Alias `mean_reversion` → `mean-reversion`
   (Zeile 1493 und 1546) bleibt — er ist ein Token-Format, kein Vokabular.
4. Erweitere `tests/adrVocabulary.test.ts` um einen Wächter, der in
   `src/lib/signalDecay.ts` und `src/lib/signalDecayRuntime.ts` **keine**
   Klassennamen als Vergleichsliterale mehr findet (Quelltext-Muster wie im
   bestehenden Wächter für `src/strategies/`).

## Randbedingungen — nicht anfassen

- **Keine** neue Klasse, kein `momentum`, kein `unclassified` als Klasse
  (ADR-008).
- **Keine** Änderung an `DEFAULT_CLASS_POLICIES`-Inhalten, an Env-Namen, an
  Schwellen oder an der Decay-Logik.
- **Keine** Änderung an `src/lib/marketRegime.ts` — die SSoT bleibt, wie sie ist.
- **Keine** DB-Änderung: die CHECKs `positions_strategy_class_check` und
  `signal_decay_events_class_check` (`drizzle/2026-09-22_signal_decay.sql`)
  sind **append-only** und bleiben unangetastet. Sie im PR-Text als
  verbleibende, dokumentierte Literalstelle nennen.
- **Kein** Refactoring über die genannten vier Fundorte hinaus.

## Abnahmekriterien

- [ ] `STRATEGY_CLASS_KEYS` ist aus `STRATEGY_CLASSES` abgeleitet, Reihenfolge
      und exportierter Typ unverändert
- [ ] `isStrategyClassKey`, `classKey`, `classOf` und
      `signalDecayRuntime`-Validierung enthalten keine Klassennamen mehr
- [ ] Neuer Quelltext-Wächter in `tests/adrVocabulary.test.ts` grün — und rot,
      wenn ein Literal zurückkommt (Negativprobe im PR-Text zeigen)
- [ ] Bestehende Wächter `tests/adrVocabulary.test.ts:200-212` unverändert grün
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] Altlast 1 in [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
      aktualisiert: DB-CHECKs bleiben als einzige dokumentierte Literalstelle

## Tests

```bash
npm test -- tests/adrVocabulary.test.ts tests/strategyLifecycle.test.ts
npm run typecheck && npm run lint
```

Zusätzlich eine Negativprobe: kurz ein fünftes Literal einführen und zeigen,
dass der neue Wächter rot wird; danach zurücknehmen.
