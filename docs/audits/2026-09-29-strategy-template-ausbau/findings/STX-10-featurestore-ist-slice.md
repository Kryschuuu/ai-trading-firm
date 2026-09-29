# STX-10 — Feature Store ist ein 3-Feature-Slice, kein „zentraler Feature-Layer"

- **ID:** STX-10
- **Severity:** MEDIUM
- **Bereich:** Architektur / Features
- **Quelle:** Ausbaudokument §4.8
- **Status:** OPEN
- **Datei(en):** `src/features/`

## Beschreibung

§4.8: *„Das Repository besitzt bereits einen Feature Store mit Point-in-Time-Regeln. Das
sollte zum **zentralen Feature-Layer** werden."* Der Store ist vorhanden und PIT-korrekt —
aber er umfasst **drei** Features.

## Beweis

```ts
// src/features/definitions.ts
export const FEATURE_IDS = {
  rsi: "scanner.rsi",
  atr: "scanner.atr",
  atrBand: "scanner.atr_band",
} as const;
```

Der Modulkopf nennt den Rollout ausdrücklich: *„genau zwei bestehende, deterministische
Scanner-Features (RSI, ATR) plus ein abgeleitetes Enum-Feature … Bestehende Consumer
(Scanner, Weekly, Backtest) bleiben vollständig unberührt — der Feature Store ist ein
**zusätzlicher** Lesepfad, kein Umbau."*

Damit existiert **keine** `rule.*`-Feature, und die 22 `RULE_FIELDS` liegen weiterhin
ausschließlich im `RuleSnapshot`-Pfad.

## Remediation

Der Feature Store ist **nicht** Voraussetzung für die Template-Arbeit — die Templates
brauchen `RULE_FIELDS`, nicht den Store. Umgekehrt gilt: wenn später ein
Feature-Materialisierungspfad für Regelfeatures kommt, muss er **paritätstestbar** gegen
`buildSnapshotFromCandles` sein.

Muster dafür existiert: `scripts/feature-materialize.ts --parity`,
`tests/featureStore.test.ts`, `tests/backtest.step.nosynthetic.test.ts`.

## Akzeptanzkriterien

- [ ] Prompt 02-04 ist **optional** und blockiert 03-01…03-10 nicht
- [ ] Falls umgesetzt: Paritätslauf gegen `buildSnapshotFromCandles` ist Teil des PR

## Versions-Hinweis

N/A (Einordnung, keine Änderung).
