# Strategy-Lifecycle mit Backtest↔Paper↔Live-Driftgates (RMA-P1-05, v1.73.0)

Evidenzbasierte Promotion und automatische Degradation zwischen **Backtest →
Paper → Live**: eine zentrale 9-Zustands-State-Machine mit immutabler
Evidence, versionierten Promotion-Gates, Drift-Vergleich über Segmente
(Performance/Risk/Execution/Data Quality), automatischer Degradationsleiter
und Order-Gate-Integration vor Live-Orders — feature-geflaggt
(`STRATEGY_LIFECYCLE_MODE`, Default `off`).

- Finding: [`docs/audits/2026-09-20-roadmap-audit/findings/RMA-P1-05-lifecycle-drift.md`](audits/2026-09-20-roadmap-audit/findings/RMA-P1-05-lifecycle-drift.md)
- Kern (pure, deterministisch): `src/strategyLifecycle/`
- Persistenz: `strategy_lifecycle_states|evidence|transitions`
  (`drizzle/2026-09-23_strategy_lifecycle.sql`)
- API: `GET|POST /api/firm/lifecycle` (Status, Evidence, Transitions, Override)
- Order-Gate: `LIFECYCLE_GATE_DENY` in `src/execution/gates.ts` nach `liveGate`

---

## 1. Ziel & Grenzen

**Ziel:** Keine Strategieversion erreicht oder bleibt in LIVE ohne frische,
hash-verifizierte Backtest-/Paper-Evidenz; messbarer Drift degradiert
automatisch (Risiko senken → begrenzen → pausieren) — idempotent und auditiert.

**Ausdrücklich NICHT Bestandteil:**

- Kein Entfernen der bestehenden Rule-Lifecycle (`tradeRules` bleibt SSoT für
  Aktivierung/Pause/Rollback von Regeln).
- Kein selbstlernendes Online-Modell (keine Auto-Gewichtung, kein Auto-Promote
  nach „genug Live-Daten“ ohne Evidenz und Audit).
- Kein Aufweichen bestehender Broker-/Kill-Switch-/Risk-Ceilings: der
  Lifecycle-Gate ist eine **zusätzliche** UND-Bedingung und skaliert nur ≤ 1.
- Kein DRAFT→LIVE-Sprung, auch nicht per Operator-Override.

## 2. Betriebsmodi (Feature-Flag `STRATEGY_LIFECYCLE_MODE`)

| Modus | Gates bewerten | Live-Orders blockieren | Persistenz | Verwendung |
| --- | --- | --- | --- | --- |
| `off` (Default) | nein | nein | Lesbar, Schreibpfade nur ensure/Evidence auf Anfrage | Rollback, Default |
| `monitor` | ja + Audit | nein (`LIFECYCLE_MONITOR_ALLOW`) | ja | Pilot in Paper |
| `enforce` | ja + Audit | **ja** (`LIFECYCLE_GATE_DENY`) | ja | kontrollierter Live-Rollout |

Unbekannter Wert ⇒ `off` + Warnung (nie still `enforce`).

Zusätzliche Flags: `STRATEGY_LIFECYCLE_RECOVERY_COOLDOWN_MS` (Default 6 h,
Bounds [0, 30 d]), `STRATEGY_LIFECYCLE_MIN_RISK_FACTOR` (Default 0.25,
Bounds [0.05, 1]).

**Rollout-Pfad:** Migration anwenden → `monitor` in Paper → Evidenz/Drift
beobachten → `enforce` für Live-Schlüssel → bei Problemen `monitor`/`off`
(keine Datenbereinigung, Zeilen bleiben lesbar).

## 3. Zustände & zentrale Transitions-Tabelle

Zustaende (geschlossene Menge):

`DRAFT` · `BACKTEST_PENDING` · `BACKTEST_PASSED` · `PAPER` · `LIVE_LIMITED` ·
`LIVE` · `DEGRADED` · `PAUSED` · `REJECTED`

Kernregeln (vollständig in `src/strategyLifecycle/states.ts`):

- **Kein DRAFT→LIVE** (und kein BACKTEST_*→LIVE): Promotion läuft immer über
  BACKTEST_PENDING/PASSED → PAPER → LIVE_LIMITED → LIVE.
- Jede Kante hat: erlaubte Rollen, Triggers, optionale Evidence-Pflicht und
  Ziel-Risk-Scale (hart ≤ 1).
- Degradationskanten: `* → DEGRADED`/`PAUSED` (risk ≤ 0.5, Cooldown).
- Recovery: `DEGRADED→LIVE_LIMITED` und `PAUSED→PAPER` erfordern Cooldown
  **und** frische Recovery-/Policy-Evidenz; **kein** automatisches
  Re-Promotion (immer Operator/Recovery-Trigger + Audit).

Idempotenz: Transition-Key `slt1:<sha256>` über
`strategyKey|version|from|to|nonce(reason+evidence)` — parallele Retries
schreiben genau eine Zeile und genau einen Zustand (optimistisches Lock
`state_seq`, `seq_after = seq_before + 1`).

## 4. Immutable Evidence

Tabelle `strategy_lifecycle_evidence` — kein lockeres JSON:

- Pflichtfelder: `kind`, `result` (PASS/FAIL/INCONCLUSIVE), `code_version`,
  `policy_version`, `event_time` ≤ `available_at` ≤ `computed_at`,
  `content_hash` (`sle1:`), `idempotency_key` (`slei1:` UNIQUE).
- Optionale FK: `backtest_run_id` → `backtest_runs` (WF-Run).
- `metrics`/`sample_size`/`window_*`: geschlossene Map `number|null` —
  **`null` ≠ `0`** (fehlend wird nie als erfüllt gewertet).
- Kind: `BACKTEST_RUN`, `PAPER_WINDOW`, `RECONCILIATION`,
  `EXECUTION_QUALITY`, `DRIFT`, `RECOVERY`, `OVERRIDE`, `DATA_QUALITY`.

Promotion-Gates (`src/strategyLifecycle/policies.ts`, `slp1:`) fordern je
Stufe frische, ausreichend große Fenster (Mindest-Trades/-Dauer, OOS-Metriken,
Drawdown, Data-Quality, Paper-Reconciliation, Execution-Quality). Fehlende
oder stale Evidenz **blockiert** die Promotion (`EVIDENCE_REQUIRED`).

## 5. Drift-Vergleich & Degradationsleiter

`src/strategyLifecycle/drift.ts` (`sld1:`-Policy): Baseline- vs.
Current-Fenster je Metrik mit Absolut-/Relativ-Toleranz und Confidence;
Segmente **Performance**, **Risk**, **Execution**, **Data Quality**.

- Fail-closed: fehlende/stale/zu-kleine Stichprobe ⇒ `INCONCLUSIVE` mit
  empfohlenem Scale-down — **nie** „OK“.
- `checkAndDegrade` wendet die Leiter an: risk scale-down →
  `LIVE_LIMITED`/`DEGRADED` → `PAUSE`; Aktion idempotent (gleicher Zielzustand
  kein Flapping, kein zweites DEGRADED-Audit).
- Faktor wirkt in `riskGuard.applyStrategyLifecycleScale` multiplikativ ≤ 1;
  `PAUSED` vetoit neue Einstiege (`strategy-lifecycle-pause`) — bestehende
  Ceilings/Kill-Switches bleiben unverändert.

## 6. Order-Gate-Integration

Vor jedem Live-Submit (Erstsubmit, Reprice, Fallback) prüft
`evaluateSubmitGates` **nach** `liveGate` den Lifecycle-Gate:

- `mode=enforce` + Deny-Grund (`STATE_NOT_FOUND`, `STRATEGY_REQUIRED`,
  `PAUSED`, `DEGRADED`, `DRAFT`, `COOLDOWN_ACTIVE`, `STALE_EVIDENCE`, …) ⇒
  Ablehnung mit `LIFECYCLE_GATE_DENY`.
- Race-Safety: Zustands-/Seq-Check läuft transaktional/optimistisch im
  Service; parallele Degradation + Order ⇒ genau eine Gewinner-Transaktion.
- Der Gate ersetzt nie Broker-Admission, Kill-Switch, Live-Gate oder
  Risk-Ceilings — er addiert eine Bedingung.

## 7. Operations-API & Observability

- `GET /api/firm/lifecycle` (`firm.read`): State, Evidence, Transitions,
  Gate-Status — klassifizierte 404/503.
- `POST /api/firm/lifecycle`: `ensure` | `evidence` | `transition` |
  `override` — CSRF, Rate-Limit, RBAC (`strategy.rules.write` / `.activate`
  / `live.gate`), Four-Eyes (`approvedBy` ≠ Actor), 400/403/404/422/429/503.
- Operator-Override: `reason` + `actor` + `ttlMs` + Four-Eyes; Audit-Pflicht.
- Telemetrie (`strategyLifecycle.*`): bounded Labels (`action`, `segment`,
  `mode`, `outcome`) — **keine** Strategy-Keys/IDs als Labels.
- Audit-Codes (9): `STRATEGY_LIFECYCLE_BOOTSTRAPPED`, `_EVIDENCE_RECORDED`,
  `_TRANSITION`, `_TRANSITION_DENIED`, `_PROMOTED`, `_DEGRADED`,
  `_PROMOTION_BLOCKED`, `_DRIFT_OBSERVED`, `_ORDER_DENIED`.

## 8. Migration & Rollback

- Migration: `drizzle/2026-09-23_strategy_lifecycle.sql` — append-only,
  idempotent (doppelt ausführbar), Bootstrap leer (`ensureLifecycleDraft`).
- Rollback (rein additiv):

```sql
DROP TABLE IF EXISTS strategy_lifecycle_transitions;
DROP TABLE IF EXISTS strategy_lifecycle_evidence;
DROP TABLE IF EXISTS strategy_lifecycle_states;
```

Danach `STRATEGY_LIFECYCLE_MODE=off` (Default) — der Faktor fällt auf neutral.

## 9. Tests

- `tests/strategyLifecycle.test.ts` — Unit: vollständige Transitions-Tabelle
  (erlaubt/verboten), DRAFT→LIVE, Evidence-/Gate-/Drift-/Order-Gate-/Risk-
  Guard-Pfade, Key-Stabilität.
- `tests/strategyLifecycle.db.test.ts` — eingebettetes Postgres: Migration
  2× idempotent, CHECK-Constraints, Roundtrip ensure→Evidence→Promotion,
  parallele Transitions (genau 1 Zeile), Degradation idempotent, Recovery-
  Cooldown, Order-Gate nach Degradation.
