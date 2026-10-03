# STX-17 — INFO: Validator-Agent passt verlustfrei ins bestehende Evidence-Modell

- **ID:** STX-17
- **Severity:** INFO
- **Bereich:** Strategy-Lifecycle / Validierung
- **Quelle:** Ausbaudokument §3.1–3.7
- **Status:** CLOSED (bestätigend) — bestätigt im Abgleich 2026-10-03 (06-01…06-04, `v0.10.3`; 06-05 nutzt denselben Vertrag)

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED/CLOSED** — unverändert bestätigt
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `src/strategies/validator/report.ts:117` — `VALIDATION_RESULTS = ["PASS","FAIL","INCONCLUSIVE"]`; `:130-135` `assertValidationResult()`; `:929` Prüfung im Bauweg
- `src/strategies/validator/persist.ts:30` — `import { recordEvidence } from "@/strategyLifecycle";`; Modulkopf `:18-20` — kein `requestTransition`, kein Import dieser Funktion
- Statischer Wächter ausgeführt und grün: `tests/strategyValidation.report.test.ts:540-545` (kein `requestTransition(`-Aufruf in der Validator-Domäne)
- **Nicht verifizierbar:** `tests/strategyValidation.persist.test.ts` (PostgreSQL fehlt) — Evidence-Idempotenz laufzeitseitig ungeprüft

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

- [x] `StrategyValidationReport.result` ist typseitig an
      `LifecycleEvidenceKind`-Ergebnisse gebunden — `VALIDATION_RESULTS = ["PASS", "FAIL", "INCONCLUSIVE"]`
      (`src/strategies/validator/report.ts`), laufzeitseitig über `assertValidationResult()`
      abgesichert; `writeValidationEvidence()` schreibt über `recordEvidence()` in
      `strategy_lifecycle_evidence` (CHECK `result IN ('PASS','FAIL','INCONCLUSIVE')`, `v0.10.3`)
- [x] Kein Weg, auf dem ein LLM direkt einen Lifecycle-Transition auslöst — kein
      `requestTransition(`-Aufruf in `src/strategies/validator/**` (statischer
      Quelltext-Wächter in `tests/strategyValidation.report.test.ts`); 06-05 darf
      ausschließlich `detail jsonb` ergänzen

## Nachweis (06-04, `v0.10.3`)

`report.ts` und `persist.ts` bestätigen den Befund praktisch: Der Report trägt
`result`, `metrics`, `assumptions` und die Hashfelder, die `recordEvidence()`
erwartet; die Evidenz-Zeile `kind = "BACKTEST_RUN"` entsteht ohne Schema-Änderung
über den bestehenden Schreibpfad, und `strategy_lifecycle_transitions` bleibt
durch den Validator leer (Test `strategyValidation.persist.test.ts`).
