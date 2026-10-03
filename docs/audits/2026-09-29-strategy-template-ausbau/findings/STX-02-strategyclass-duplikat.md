# STX-02 — `StrategyClass` existiert bereits; Template würde sie duplizieren

- **ID:** STX-02
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §1.2, §15 (nicht erwähnt)
- **Status:** FIXED — Abgleich 2026-10-03: [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1) (00-03, `v0.6.1`) + Umsetzung 03-01/03-02/03-09 bestätigt; Restpunkt mit 08-03 (`v0.10.9`, 2026-10-03) abgeschlossen
- **Datei(en):** `src/lib/marketRegime.ts`, `src/lib/signalDecay.ts`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — von `IN ARBEIT` hochgestuft
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- Alle sechs Templates deklarieren `class` aus `STRATEGY_CLASS_KEYS`: `trend` (`ema-adx-trend.ts:427`, `macd-momentum.ts:470`, `vwap-pullback.ts:258`), `breakout` (`bollinger-squeeze.ts:328`, `donchian-breakout.ts:370`), `mean-reversion` (`rsi-mean-reversion.ts:638`) — **keines** `unclassified`
- `src/strategies/compiler.ts:633` — `return { ok: true, spec, strategyClass: template.class, … }`; `strategyClass` ist immer `template.class`, kein Aufrufer-Parameter (`compiler.ts:34`)
- Kein zweites Klassen-Enum in `src/strategies/`: `grep` findet nur Template-Slugs und Klassenzuweisungen, keine eigene Union
- Tests: `tests/strategies.templates.test.ts:472-478` (Klasse aus `STRATEGY_CLASS_KEYS`, nie `unclassified`), `:518-530` (`regimeGateFactor` für **alle** Regimes endlich und in `[0, 2]`), `:561` (`CompileResult.strategyClass === template.class`); `tests/adrVocabulary.test.ts:200-212` (genau eine Quelle je Liste) — ausgeführt, **grün**
- **Restpunkt — mit [08-03](../prompts/PROMPT-STX-08-03-signaldecay-klasse-ssot.md) (`v0.10.9`, 2026-10-03) abgeschlossen:** `STRATEGY_CLASS_KEYS` wird in `src/lib/signalDecay.ts` aus `STRATEGY_CLASSES` abgeleitet (`[...STRATEGY_CLASSES, "unclassified"]`); `isStrategyClassKey()`, die lokale Closure `classOf()` und `metricClass()` in `src/lib/signalDecayRuntime.ts` prüfen über einen Lookup. Ein Quelltext-Wächter in `tests/adrVocabulary.test.ts` verbietet Klassennamen als Vergleichs-/Listenliteral in beiden Dateien und baut sein Muster aus der SSoT. Einzig verbleibende dokumentierte Literalstelle sind die append-only DB-CHECKs `positions_strategy_class_check` und `signal_decay_events_class_check` (`drizzle/2026-09-22_signal_decay.sql`, unangetastet)

## Beschreibung

Das Dokument behandelt „welche Strategieklasse ist das?" als Neuland und schlägt
`StrategyTemplate.scope`/`id` als Träger vor. Diese Abstraktion existiert bereits, ist
sogar **durchgeschaltet bis zur Order-Ausführung**.

## Beweis

```ts
// src/lib/marketRegime.ts:91
export type StrategyClass = "mean-reversion" | "trend" | "breakout";

// src/lib/signalDecay.ts:102-112
export type StrategyClassKey = StrategyClass | "unclassified";
export const STRATEGY_CLASS_KEYS: readonly StrategyClassKey[] = [
  "mean-reversion", "trend", "breakout", "unclassified",
];
```

Wirkt bereits auf:
- `regimeGateFactor(regime, strategyClass, cfg)` (`marketRegime.ts:989`)
- `resolveRegimeGateForExecution(symbol, strategyClass)` (`microExecutor.ts:779`)
- `DEFAULT_CLASS_POLICIES` (Decay-Schwellen je Klasse, `signalDecay.ts:361`)

Ein `StrategyTemplate` ohne `class`-Feld erzeugt Regeln, die im Regime-Gate (dort heißt „keine Klasse“
`null`, Faktor 1) und im Decay-Pfad (`"unclassified"`, Policy default-off) ihre Klassen-Logik verlieren —
d. h. **stille Abschwächung** der Risiko-Logik.

Präzisierung ([ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1)): Regeln tragen heute **keine**
Klasse; zur Laufzeit wird sie aus dem *Mission*-Template abgeleitet (`strategyClassOfTemplate`,
Namens-Heuristik). Der Backtest wendet kein Regime-Gate an — nur die Decay-Policy nutzt dort die Klasse.

## Remediation

1. `StrategyTemplate.class: StrategyClassKey` als **Pflichtfeld**, typisiert gegen
   `STRATEGY_CLASS_KEYS` (kein eigener Union-Typ); `unclassified` ist ein Fehler, keine neue Klasse.
2. Der Compiler gibt `strategyClass` im `CompileResult` zurück (Backtest-/Decay-Kontext). Die Live-Wirkung
   bleibt bei der Mission-Ableitung — `RuleSpec`/`trade_rules` tragen weiterhin keine Klasse.
3. Kein neuer Klassen-Vokabular-Typ im Template-Modul.

## Akzeptanzkriterien

- [x] Entscheidung schriftlich fixiert ([ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1), `v0.6.1`); Kontrakt-Invariante und Guard für `src/strategies/` in `tests/adrVocabulary.test.ts`
- [ ] Jedes Template deklariert eine Klasse aus `STRATEGY_CLASS_KEYS` (ohne `unclassified`)
- [ ] Test: `CompileResult.strategyClass` ist für alle Templates eine Klasse aus `STRATEGY_CLASSES`, und `regimeGateFactor(regime, strategyClass)` liefert für alle fünf Regimes einen definierten Faktor
- [x] Kein zweites Klassen-Enum in `src/strategies/`; die früheren Literal-Listen in `signalDecay*.ts` sind mit 08-03 (`v0.10.9`) aus der SSoT abgeleitet und durch `tests/adrVocabulary.test.ts` bewacht ([ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1))

## Versions-Hinweis

Minor.
