# GAP-03 — Trade-Journal mit Agenten-Attribution & Feedback-Loop

**Nutzen:** ★★★★★ · **Aufwand (Co-Audit):** 🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧🔧
**Kategorie:** Lernschleife · **Prompt:** [`PROMPT-03`](../prompts/PROMPT-03-trade-journal-attribution.md)

## Befund (Co-Audit)

Das Multi-Agenten-System wird erst *lernfähig*, wenn je Trade nachvollziehbar
ist, welche Agenten wie gestimmt haben — und Agenten mit schlechter Treffer-
quote je Regime automatisch runtergewichtet werden. Contra: kleine Stichproben
→ Rauschen als Signal; Mindest-Trade-Anzahl + Bayes-Glättung nötig.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `positions` trägt `missionId`, `ruleId`, `exitReason`; `proposals`,
  `agentMessages` („institutionelles Gedächtnis“), `audit_log`,
  `equity_snapshots` existieren als Rohdaten.
- **Aber:** keine Verknüpfung Position ↔ Agenten-Stimmen/Confidence/Regime,
  keine MAE/MFE-Haltedauer-Auswertung nach Close, keine Auswertung
  „welcher Agent hat recht, wann?“, keine Gewichts-Rückführung in
  Approver/Portfolio.

## Delta

1. Journal-Verknüpfung (View oder append-only Tabelle) Position-Lifecycle ↔
   Entscheidungskette (Proposals, Stimmen, Confidence, Regime, Begründung).
2. Nach Close: PnL, MAE/MFE (aus Kerzen, Zeitmaske ≤ Exit), Haltedauer,
   Exit-Reason.
3. Auswertung Trefferquote/ER je Agent × Regime × Symbol-Gruppe mit
   Mindest-Stichprobe + Beta-Prior-Glättung.
4. Rückführung als *begrenztes* Gewichtungs-Delta (Bounds, max Δ je Zyklus,
   Flag-gated, Default monitor-only) in Approver-/Portfolio-Kontext.

## Akzeptanzkriterien (kurz)

Attributions-Verknüpfungstest, MAE/MFE-Test, Glättungs-/Mindest-Stichproben-
Test, Bounds-Test auf Gewichte, Migration append-only (bestehende Tests grün).
