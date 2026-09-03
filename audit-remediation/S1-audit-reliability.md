# S1 — Audit ist teilweise Best-Effort und kann trotz erfolgreicher Mutation fehlen

- **Severity:** MEDIUM
- **Bereich:** Sonstiges
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/brokers/bitunix/audit.ts` (L46 `/* best-effort */`), `src/app/api/firm/agents/route.ts` (L63 `// Audit-Fehler darf … nicht reißen`)

## Arena-Prompt (kopierbar)

```
TASK: Make security-relevant audit writes reliable (not silently best-effort).

PROBLEM: Several audit calls are wrapped in try/catch that swallow errors ("best-effort"), so a
successful security mutation (e.g. credential save, prompt update, kill-switch) can occur WITHOUT a
corresponding audit record. For a trading system the audit trail must be durable.

DO:
1. Distinguish two classes:
   - Non-security audit (optional telemetry): keep best-effort, but RECORD a local warning/metric on
     failure (never fully silent).
   - Security-critical audit (auth, kill-switch, credential ops, order rejections, proposal approvals):
     do NOT swallow. On failure, either (a) retry with backoff, or (b) fail the operation (fail-closed)
     so the mutation does not happen without an audit entry.
2. In src/brokers/bitunix/audit.ts, remove the bare `/* best-effort */` swallow for the private-call
   ring; add a persistent fallback (append to DB audit_log with at-least-once semantics) and a process
   metric.
3. In src/app/api/firm/agents/route.ts, the AGENT_PROMPT_UPDATED audit should be security-class: if it
   fails, still save the prompt but raise an alert (log CRITICAL + increment a missed-audit counter);
   document the trade-off explicitly.
4. Add a test that forces the audit insert to throw and asserts the security operation is either rolled
   back or flagged.

ACCEPTANCE: Security audits are never silently dropped; best-effort paths at least log a warning/metric;
a forced audit failure surfaces (alert/metric/rollback), not silence.
```

## Beweis (aktueller Code)

`src/brokers/bitunix/audit.ts` L44‑47:

```ts
} catch {
  /* best-effort */
}
```

`src/app/api/firm/agents/route.ts` L61‑64:

```ts
} catch {
  // Audit-Fehler darf die gespeicherte Prompt-Änderung nicht reißen.
}
```

## Fix-Spezifikation

Sicherheitsrelevante Audits: niemals still best-effort; bei Fehler Retry oder fail-closed + Warnung/Metrik
(siehe Audit S1).

## Akzeptanzkriterien / Tests

- [ ] Sicherheits-Audits werden bei Schreibfehler nicht still ignoriert.
- [ ] Best-effort-Pfade loggen zumindest Warnung/Metrik.
- [ ] Test: erzwungener Audit-Fehler → Operation rollbackt oder wird markiert.

## Changelog-Blurb

`S1 (MEDIUM): Audit teils best-effort — sicherheitsrelevante Audits jetzt zuverlässig (Retry/fail-closed
+ Warnung), keine stillen Lücken mehr.`

## Versions-Hinweis

PATCH (`1.36.3`) — Observability/Härtung, kein Schema-Bruch.
