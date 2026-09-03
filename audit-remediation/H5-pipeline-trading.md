# H5 — Die Pipeline kann vor Approver/Risk/Executor tatsächlich handeln

- **Severity:** CRITICAL
- **Bereich:** Handelslogik
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/lib/engine.ts` (`runAgentTurn` L510, `runPipeline` L778‑794)

## Arena-Prompt (kopierbar)

```
TASK: Stop the pipeline from executing trades before the EXECUTOR/approval stage.

PROBLEM: runAgentTurn allows BOTH "EXECUTOR" and "RESEARCH" to call broker.submit. The
pipeline runs every agent as a full runAgentTurn, so a RESEARCH TRADE executes immediately and
the loop breaks on EXECUTED before RISK_MANAGER/APPROVER/EXECUTOR ever run.

DO:
1. In runAgentTurn, change the trading-allowed set so ONLY "EXECUTOR" may submit to the broker.
   RESEARCH/CEO/BACKTEST/RISK_MANAGER/APPROVER that emit a TRADE must instead create a
   PROPOSAL (insert into `proposals` with status APPROVED if !requireApproval, PENDING if
   requireApproval) and return status "PROPOSED" (do NOT call broker.submit).
2. Refactor runPipeline so phases are explicit and separated:
     CEO -> RESEARCH -> BACKTEST -> RISK_MANAGER -> APPROVER -> EXECUTOR -> BROKER
   Each non-EXECUTOR phase runs runAgentTurn in a "proposal-only" mode (no submit). The
   EXECUTOR phase loads the latest APPROVED proposal for the mission and executes it via
   executeApprovedProposal(proposalId) (see H6). Remove the `if (result.status === "EXECUTED"
   || result.status === "KILLED") break;` early-exit that currently lets RESEARCH short-circuit.
3. Add a guard: if any non-EXECUTOR phase somehow reaches broker.submit, reject with
   ROLE_NOT_ALLOWED_TO_TRADE and audit it.

ACCEPTANCE: A RESEARCH TRADE never touches the broker; the EXECUTOR executes ONLY an approved
proposal. Add a test: pipeline with a RESEARCH agent that returns TRADE results in 0 broker
submits and 1 proposal row; only EXECUTOR phase produces a fill.
```

## Beweis (aktueller Code)

`src/lib/engine.ts` L510:

```ts
if (agent.role !== "EXECUTOR" && agent.role !== "RESEARCH") {
  ... return BLOCKED, ROLE_NOT_ALLOWED_TO_TRADE ...
}
```

`runPipeline` L778‑794: `const order = ["CEO","RESEARCH","BACKTEST","RISK_MANAGER","APPROVER","EXECUTOR"];`
und `if (result.status === "EXECUTED" || result.status === "KILLED") break;`.

## Fix-Spezifikation

Agenten-Phasen und Ausführung trennen (siehe Audit H5-Fix-Skizze). Nur EXECUTOR darf
`execute(proposalId)`; Research erzeugt nur `Proposal`.

## Akzeptanzkriterien / Tests

- [ ] RESEARCH/andere Rollen → kein `broker.submit`, nur Proposal.
- [ ] Pipeline bricht nicht mehr vorzeitig durch RESEARCH-EXECUTED ab.
- [ ] EXECUTOR führt ausschließlich genehmigte Proposal aus.

## Changelog-Blurb

`H5 (CRITICAL): Pipeline handelte vor Approver/Risk/Executor — Rollen/Trading getrennt; nur
EXECUTOR submitted, alle anderen erzeugen nur Proposals.`

## Versions-Hinweis

PATCH (`1.36.3`) — Verhaltenskorrektur ohne Schema-Änderung.
