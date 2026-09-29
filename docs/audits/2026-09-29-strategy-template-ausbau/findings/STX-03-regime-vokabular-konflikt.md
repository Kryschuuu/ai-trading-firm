# STX-03 — Regime-Vokabular-Konflikt (7er-Taxonomie vs. bestehendes 5+1)

- **ID:** STX-03
- **Severity:** HIGH
- **Bereich:** Architektur / Domänenmodell
- **Quelle:** Ausbaudokument §3.6
- **Status:** IN ARBEIT — entschieden mit [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2) (00-03, `v0.6.1`); Aggregator in 06-04
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
- Klassifikator: `classifyMarketRegimeMultidim` (`marketRegime.ts:803`)
- Gate: `REGIME_GATE_MODE` `off|monitor|enforce`, `regimeGateFactor` (`:989`)
- Persistenz: Tabelle `regime_snapshots` + `src/lib/regimeSnapshotStore.ts`
- Auswertung: `evaluateRegimeStability`, `evaluateRegimeOos` (`regimeEvaluation.ts`)

Hinweis (korrigiert mit [ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2)): `evaluateRegimeOos` misst **Markt**-Forward-Returns je bestätigtem
Regime (`RegimeEvalRow.forwardReturnPct`) — nicht die Leistung einer Strategie. Es liefert Vokabular
(`REGIME_EVAL_LABELS`) und Zeilenformat; die Auswertung „Strategie je Regime“ fehlt noch und entsteht als
Aggregator in 06-04. `UNKNOWN` weist `evaluateRegimeOos` als eigenen Mess-Bucket aus.

## Remediation

1. **Ablehnen** der 7er-Taxonomie.
2. Strategie-Per-Regime-Auswertung über `regime_snapshots` und das Zeilenformat/Vokabular von
   `regimeEvaluation.ts` realisieren (neuer Aggregator in 06-04, **kein** neues Vokabular;
   `evaluateRegimeOos` bleibt unverändert).
3. `UNKNOWN` ist fail-closed auszuschließen, nie als eigene Regime-Leistung zu zählen.

## Akzeptanzkriterien

- [x] Entscheidung schriftlich fixiert ([ADR-009](../../../roadmap/DECISIONS.md#adr-009-regime-vokabular-adr-e2), `v0.6.1`); Vokabular, `regime_snapshots`-CHECK und das `evaluateRegimeOos`-Ist-Verhalten in `tests/adrVocabulary.test.ts` festgehalten
- [ ] Kein zweites Regime-Vokabular im Repo (die `VolatilityRegime`-Typen sind Volatilitäts-Stufen, kein Markt-Regime)
- [ ] Verwender der Regime-Labels außerhalb von `marketRegime.ts` (künftig 06-04 im Evidenz-`detail`) nutzen dieselben Labels — `src/strategyLifecycle/` kennt heute kein Regime
- [ ] Test: der Aggregator (06-04) schließt `UNKNOWN` aus und zählt es nie als „Regime ohne Edge“

## Versions-Hinweis

Minor (reiner Auswertungs-Aggregator).
