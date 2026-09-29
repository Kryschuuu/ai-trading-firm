# STX-17 — INFO: Validator-Agent passt verlustfrei ins bestehende Evidence-Modell

- **ID:** STX-17
- **Severity:** INFO
- **Bereich:** Strategy-Lifecycle / Validierung
- **Quelle:** Ausbaudokument §3.1–3.7
- **Status:** OPEN (bestätigend)

## Befund

**Das Ausbaudokument ist hier korrekt und der Plan ist ohne Schema-Änderung umsetzbar.**

Die Trennung „Agent interpretiert, Code entscheidet" ist institutionell verankert:

- `evaluatePromotionGate` / `evaluateBacktestGate` / `evaluatePaperGate` (`policies.ts`) —
  deterministische Gates, `failClosed`
- `recordEvidence({...})` (`service.ts:276`) — nimmt externe Evidenz mit
  `content_hash` + `idempotency_key`
- `checkAndDegrade` — Drift-getriebene Degradation
- `devilsAdvocate` — dasselbe Muster bereits für den Makro-Zyklus
  (`shadowMode`, `humanReviewThreshold`, `scaleDownThreshold`)

Das im Dokument vorgeschlagene Ergebnismodell ist **exakt** das DB-Vokabular:

```ts
// Ausbaudokument §3.2
result: "PASS" | "FAIL" | "INCONCLUSIVE";
```
```sql
CHECK ("result" IN ('PASS','FAIL','INCONCLUSIVE'))   -- strategy_lifecycle_evidence
```

Und `evidenceHash` ↔ `content_hash`, `assumptions` ↔ `detail jsonb`, `metrics` ↔ `metrics jsonb`.

## Empfehlung

Prompts 06-01…06-05 bauen **ausschließlich** auf diesen vorhandenen Verträgen auf.
Kein neuer Evidenz-Typ, keine neue Ergebnisspalte.

## Akzeptanzkriterien

- [ ] `StrategyValidationReport.result` ist typseitig an
      `LifecycleEvidenceKind`-Ergebnisse gebunden
- [ ] Kein Weg, auf dem ein LLM direkt einen Lifecycle-Transition auslöst
