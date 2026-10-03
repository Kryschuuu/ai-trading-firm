# STX-10 — Feature Store ist ein 3-Feature-Slice, kein „zentraler Feature-Layer"

- **ID:** STX-10
- **Severity:** MEDIUM
- **Bereich:** Architektur / Features
- **Quelle:** Ausbaudokument §4.8
- **Status:** FIXED — Abgleich 2026-10-03: Einordnung dokumentiert (00-02) **und** optionaler Slice 02-04 umgesetzt (`7995822` PR #189)
- **Datei(en):** `src/features/`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — von `IN ARBEIT` hochgestuft
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `src/features/definitions.ts:42-46` — `RULE_FEATURE_IDS = { bbZScore: "rule.bb_zscore", priceVsUpperBbPct: "rule.price_vs_upper_bb_pct", donchianBreakoutPct: "rule.donchian_breakout_pct" }`; Definitionen `:210-266` mit `computeKey` `rule.*@1`
- `src/features/compute.ts:382-384` — drei Executors registriert; Implementierungen `:301`, `:323`, `:342`
- Paritätstest `tests/ruleFeatureStoreParity.test.ts` vorhanden und **grün** (ausgeführt)
- Die drei `scanner.*`-Features (`FEATURE_IDS`, `definitions.ts:35`) bleiben unverändert — der Store ist weiter ein Slice, jetzt mit `rule.*`-Anteil

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
