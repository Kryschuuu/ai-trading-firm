# STX-02 — `StrategyClass` existiert bereits; Template würde sie duplizieren

- **ID:** STX-02
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §1.2, §15 (nicht erwähnt)
- **Status:** OPEN
- **Datei(en):** `src/lib/marketRegime.ts`, `src/lib/signalDecay.ts`

## Beschreibung

Das Dokument behandelt „welche Strategieklasse ist das?" als Neuland und schlägt
`StrategyTemplate.scope`/`id` als Träger vor. Diese Abstraktion existiert bereits, ist
sogar **durchgeschaltet bis zur Order-Ausführung**.

## Beweis

```ts
// src/lib/marketRegime.ts:86
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

Ein `StrategyTemplate` ohne `class`-Feld erzeugt Regeln, die im Regime-Gate und im
Decay-Pfad auf `"unclassified"` fallen — d. h. **stille Abschwächung** der Risiko-Logik.

## Remediation

1. `StrategyTemplate.class: StrategyClassKey` als **Pflichtfeld**, typisiert gegen
   `STRATEGY_CLASS_KEYS` (kein eigener Union-Typ).
2. Der Compiler setzt `strategyClass` aus dem Template in den Backtest-/Runtime-Kontext.
3. Kein neuer Klassen-Vokabular-Typ im Template-Modul.

## Akzeptanzkriterien

- [ ] Jedes Template deklariert eine Klasse aus `STRATEGY_CLASS_KEYS`
- [ ] Test: Compiler setzt `strategyClass` durch bis `regimeGateFactor`
- [ ] Kein zweites Klassen-Enum im Repo

## Versions-Hinweis

Minor.
