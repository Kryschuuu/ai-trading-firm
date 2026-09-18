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

## Umsetzung (v1.43.0, 2026-09-18)

Umgesetzt in PR #137, Branch `arena/01a0b4c1-ai-trading-firm` (PROMPT-03). Ist-Stand
vorab verifiziert — er entsprach exakt dem Audit: `positions` referenziert
Mission/Rule, aber **keine** Verknüpfung zur Entscheidungskette, keine
MAE/MFE, keine Auswertung, keine Rückführung.

- **D1 Journal-Verknüpfung:** Neue **append-only** Tabelle `trade_journal`
  (kein Eingriff in bestehende Tabellen) + `journal_agent_weights`
  (append-only Migration `drizzle/2026-09-18_trade_journal.sql`).
  - Schreibweg (a) **Eröffnung** in allen drei Pfaden (Engine EXECUTOR,
    genehmigtes Proposal, Mikro-Executor-Regel): `decision_snapshot` =
    unveränderliches Foto (Attribution `PROPOSAL`/`RULE`/`UNKNOWN`, Stimmen
    der Mission im 6h-Fenster, Proposer, Regime, `rationale_hash`). Fehlende
    Kette → `attribution: "UNKNOWN"` — **sichtbare Lücke, nie geraten**
    (fail-closed).
  - Schreibweg (b) **Close** (Monitor SL/TP, Emergency-Flatten): PnL,
    MAE/MFE, `holding_minutes`, `exit_reason`, `quality`. Fehlende Zeile wird
    mit UNKNOWN-Snapshot nachgetragen (Backfill).
  - Robustheit: Journal-Fehler bricht den Handelspfad **nie** ab
    (`JOURNAL_WRITE_FAILED` CRITICAL im Audit-Log).
- **D2 MAE/MFE:** `src/lib/journalMetrics.ts` (rein, injizierbare Kerzen):
  Zeitmaske Intervallstart ∈ [Eröffnung, Close], einheitliches P&L-Vorzeichen
  (LONG+SHORT), **Kerzenlücke ⇒ `CANDLE_GAP` (null, nie geschätzt)**, leeres
  Fenster ⇒ `NO_DATA`. Kerzen aus dem Historical Store
  (`JOURNAL_CANDLES_TIMEFRAME`, Default 1h).
- **D3 Auswertung:** `src/lib/journalAnalytics.ts` — Trefferquote/Erwartungswert
  je Agent × Regime × Symbolgruppe mit **Beta-Prior-Glättung α=β=2**
  (dokumentierte Konstante `JOURNAL_BETA_PRIOR`) + **Mindest-Stichprobe**
  `JOURNAL_MIN_TRADES` (Default 20, Bounds [5,200]); darunter
  `insufficient-sample`, **niemals als Faktor**. Read-API
  `GET /api/firm/journal` (SEC-02, `firm.read`, no-store) + Zyklus-Artefakt
  `journal-summary.json`/`journal-feedback.json`.
- **D4 Begrenzte Rückführung:** `JOURNAL_FEEDBACK_MODE` = **off (Default,
  nur Auswertung, Entscheidungspfad byte-identisch)** | monitor (Vorschläge
  als `JOURNAL_WEIGHT_PROPOSED` + Artefakt) | enforce (Persistenz in
  `journal_agent_weights` + Approver-/Portfolio-Prompt-Kontext).
  Schutzschalen: Bounds [0.5, 1.5], **max Δ je Zyklus** (Default 0.1),
  Bayes-Glättung FIRST, revisionssicher im Audit-Log
  (`journal-weight:AGENT:REGIME:x→y`).
- **Tests:** `tests/tradeJournal.test.ts` (21 Tests) deckt jede Anforderung
  ab: E2E-Attribution (engine-open→snapshot, close→metrics), manuelle
  Position→UNKNOWN-Snapshot ohne Fehler, MAE/MFE-Handreferenzen LONG+SHORT,
  Lücken→null+Flag, Glättung (2/3 nahe Prior, n≥MIN empirisch,
  insufficient-sample), Bounds/maxDelta (Clamp, Multi-Zyklus, Audit),
  Modi off/monitor/enforce lassen den Entscheidungspfad unverändert
  (bestehende Tests grün).
- **Docs:** `docs/HANDBUCH.md` §20, `CONFIGURATION.md` + `.env.example`
  (sechs `JOURNAL_*`-Flags, Default off), CHANGELOG 1.43.0.

**Offene Punkte (bewusst nicht in diesem Release):** echte Qualitätsbewegung
aus den MAE/MFE-Flags (z. B. Degradierung bei vielen `CANDLE_GAP`);
Lernraten-Anpassung über mehrere Regime-Generationen.
