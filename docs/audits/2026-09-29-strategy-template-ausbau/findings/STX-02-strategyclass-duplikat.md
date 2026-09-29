# STX-02 — `StrategyClass` existiert bereits; Template würde sie duplizieren

- **ID:** STX-02
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §1.2, §15 (nicht erwähnt)
- **Status:** IN ARBEIT — entschieden mit [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1) (00-03, `v0.6.1`); Umsetzung in 03-01, 03-02, 03-09
- **Datei(en):** `src/lib/marketRegime.ts`, `src/lib/signalDecay.ts`

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
- [ ] Kein zweites Klassen-Enum in `src/strategies/` (bestehende Literal-Listen in `signalDecay*.ts` sind dokumentierte Altlast, [ADR-008](../../../roadmap/DECISIONS.md#adr-008-strategie-klassifikation-adr-e1))

## Versions-Hinweis

Minor.
