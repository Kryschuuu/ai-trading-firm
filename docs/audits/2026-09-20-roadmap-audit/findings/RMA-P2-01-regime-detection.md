# RMA-P2-01: Regime-Erkennung

- **Antwort:** Ja (Delta aus PROMPT-P2-01 umgesetzt)
- **Tracking-Status:** `FIXED`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **0 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P2-01`](../prompts/PROMPT-P2-01-regime-detection.md)
- **PR:** [#159](https://github.com/Kryschuuu/ai-trading-firm/pull/159)
- **Commit:** `2cd5aed`
- **Fix-Version:** `v1.61.0`

## Verifizierte Fundstellen

- `src/lib/marketRegime.ts::classifyMarketRegime()` — OHLCV-basierte Trend-/Range-/Volatilitätsklassifikation.
- `src/lib/marketRegime.ts::MarketRegimeStateMachine` — Hysterese.
- `src/lib/marketRegime.ts::applyRegimeGate()` — produktive Risikodämpfung.
- `src/lib/marketRegime.ts::collectRegimeHistoryArtifact()` — Verlaufsartefakt.
- **NEU (v1.61.0):** `src/lib/regimeFeatures.ts` (Feature-Vertrag `regime-features@1`), `src/lib/regimeFamilyInputs.ts` (PIT-Live-Loader), `classifyMarketRegimeMultidim()`/`resolveRegimeGateForExecution()` in `marketRegime.ts`, `src/lib/regimeSnapshotStore.ts` + `src/lib/regimeEvaluation.ts`, `scripts/regime-eval.ts` (`npm run regime:eval`), Migration `drizzle/2026-09-22_regime_snapshots.sql`.

## Bewertung und Abgrenzung

Deterministische OHLCV-Regime inklusive CRASH, HIGH_VOL, TREND_UP, TREND_DOWN und RANGE sind produktiv verdrahtet und bleiben der bewährte Degraded-/Legacy-Pfad. Seit v1.61.0 fließen zusätzlich versionierte Preis-, Volatilitäts-, Liquiditäts-, Perp- und optionale Makro-Familien ein — point-in-time-sicher, mit Confidence, Coverage, Top-Treibern, bounded Persistenz und regimebezogener OOS-Auswertung.

## Konkretes Delta (umgesetzt)

- Liquiditäts-/Spread-, Perp- und Makromerkmale mit explizitem Missingness-Handling (keine Nullsubstitution; `MISSING`/`STALE`/`DISABLED` sichtbar).
- Confidence + Coverage statt nur harter Klasse (Klasse bleibt bestätigt; Confidence bei `UNKNOWN` ist `null`, nie still 0).
- Versioniertes Feature-/Modellartefakt mit as-of-Zeitpunkt (`regime-features@1`/`regime-rules@1`, `asOf`/`computedAt` getrennt, Snapshot-Zeilen + Artefakt-Schema v2).
- Historische Stabilitäts-/Transitions-/Coverage-Analyse und regimebezogene OOS-Auswertung (`npm run regime:eval`).

## Akzeptanzkriterien für `FIXED`

- [x] Regime ist für denselben As-of-Datenstand reproduzierbar — `tests/regimeMultidim.test.ts` (Determinismus/Golden, byte-identischer Snapshot-Hash).
- [x] fehlende Featurefamilien können kein implizit bullisches Signal erzeugen — Coverage-↓ ohne Klassen-/Gate-Erhöhung; Vote-Richtung ausschließlich → `HIGH_VOL`; Coverage < `REGIME_MIN_COVERAGE` blockiert Boosts; NEG-Pfade-Tests.
- [x] Hysterese und Confidence sind getrennt testbar — `confirmedRegime` vs. `rawRegime`/`confidence` getrennt (Flapping-/Bestätigungs-Tests).
- [x] Backtest und Live verwenden dieselbe Feature-/Klassifikationsversion — gemeinsame `regime-rules@1`/`regime-features@1`, PIT-Maske schließt später verfügbare Makro-/Perp-Daten strukturell aus (Test „Backtest-Maske“).

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1` — **in diesem Repo nicht auflösbar** (bekannte Abweichung, s. RMA-P2-02/PR #157-Notiz); Umsetzung auf v1.60.0 mit minimalem Scope, Abweichung im PR #159 dokumentiert.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Testevidenz: `tests/regimeMultidim.test.ts` (37), `tests/regimeSnapshot.db.test.ts` (7, eingebettete Postgres), `tests/marketRegime.test.ts` (42); Gesamtlauf `npm test` → 3032 Tests, 2996 pass / 0 fail / 36 Skip (Umgebungs-DB-Skips); `typecheck`/`lint`/`docs:validate` grün.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
