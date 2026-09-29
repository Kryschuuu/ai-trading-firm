# STX-03 — Regime-Vokabular-Konflikt (7er-Taxonomie vs. bestehendes 5+1)

- **ID:** STX-03
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §3.6
- **Status:** OPEN
- **Datei(en):** `src/lib/marketRegime.ts`, `src/lib/regimeEvaluation.ts`, `drizzle/2026-09-22_regime_snapshots.sql`

## Beschreibung

§3.6 schlägt Regime-Validierung über `bull / bear / sideways / high-vol / low-vol /
high-volume / low-volume` vor. Diese Taxonomie existiert nicht — und sie **widerspricht**
der bestehenden, die durch Klassifikator, Gate, Drift und Persistenz geht.

## Beweis

```ts
// src/lib/marketRegime.ts:85-88
export type MarketRegime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL" | "CRASH";
export type MarketRegimeLabel = MarketRegime | "UNKNOWN";
```

Bereits vorhanden und *wired*:
- Klassifikator: `classifyMultidim` (`marketRegime.ts:807`)
- Gate: `REGIME_GATE_MODE` `off|monitor|enforce`, `regimeGateFactor` (`:989`)
- Persistenz: Tabelle `regime_snapshots` + `src/lib/regimeSnapshotStore.ts`
- Auswertung: `evaluateRegimeStability`, `evaluateRegimeOos` (`regimeEvaluation.ts`)

Hinweis: `evaluateRegimeOos` misst bereits **regimebezogene OOS-Kennzahlen** — genau das,
was §3.6 fordert, nur mit dem vorhandenen Vokabular.

## Remediation

1. **Ablehnen** der 7er-Taxonomie.
2. Strategie-Per-Regime-Auswertung über `regime_snapshots` + `evaluateRegimeOos`
   realisieren (neuer Aggregator, **kein** neues Vokabular).
3. `UNKNOWN` ist fail-closed auszuschließen, nie als eigene Regime-Leistung zu zählen.

## Akzeptanzkriterien

- [ ] Kein zweites Regime-Vokabular im Repo
- [ ] `STRATEGY_LIFECYCLE`/`drift.ts` nutzt dieselben Labels wie `marketRegime.ts`
- [ ] Test: `evaluateRegimeOos` schließt `UNKNOWN` aus

## Versions-Hinweis

Minor (reiner Auswertungs-Aggregator).
