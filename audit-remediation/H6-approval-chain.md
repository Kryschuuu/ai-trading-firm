# H6 — Approver genehmigt nicht die konkrete Order; Executor kann neue Entscheidung generieren

- **Severity:** CRITICAL
- **Bereich:** Handelslogik
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/lib/engine.ts` (`runAgentTurn` L660‑703, `runPipeline`)

## Arena-Prompt (kopierbar)

```
TASK: Make the executor execute ONLY a server-validated, approved proposal (no model re-decision).

PROBLEM: A TRADE inserts a proposal, but the Approver/Executor are run as generic agent turns.
The Executor can generate a BRAND-NEW decision (different symbol/side/SL/TP than the proposal),
so there is no real approval chain.

DO:
1. Add executeApprovedProposal(proposalId: string): load the proposal row; require
   `proposal.status === "APPROVED"` (server-side, fail-closed). If PENDING -> REJECT
   (needs human approval). If not found -> REJECT.
2. The Executor phase (runPipeline) calls executeApprovedProposal(latestApprovedProposalIdForMission)
   and uses STRICTLY proposal.proposedDetail (symbol/side/qty/stopLoss/takeProfit) — never calls
   localReason()/parseDecision() to invent a new order.
3. Ensure the proposal's proposedDetail is the single source of truth: copy it verbatim into the
   order passed to broker.submit. Add an audit entry recording proposalId -> fill.
4. If REQUIRE_HUMAN_APPROVAL=true, the proposal must be set to APPROVED by an explicit human
   approval endpoint (not by an agent turn). Add/verify that endpoint flips PENDING->APPROVED and
   records the approver actor.

ACCEPTANCE: Executor cannot change order parameters; any attempt to execute a PENDING/unknown
proposal is rejected; audit links fill to proposalId. Test: feed Executor a proposal BUY BTC sl5%
and a hostile model output SELL ETH — assert the executed fill is BUY BTC per proposal.
```

## Beweis (aktueller Code)

`src/lib/engine.ts` L670‑703: Proposal wird mit `proposedDetail: { ...order }` angelegt, Status
`requireApproval ? "PENDING" : "APPROVED"`. Danach (L688‑703) wird bei `!requireApproval` sofort
`broker.submit(order)` mit dem *lokal* aus dem Modelloutput gebauten `order` ausgeführt — der
Approver-Agent wird nicht zwingend mit dieser Proposal konfrontiert, und der Executor kann eine
neue Entscheidung treffen.

## Fix-Spezifikation

`executeApprovedProposal(proposalId)` + serverseitige `status === "APPROVED"`-Prüfung;
Orderparameter stammen zwingend aus `proposedDetail` (siehe Audit H6-Fix-Skizze).

## Akzeptanzkriterien / Tests

- [ ] Executor nutzt nur `proposal.proposedDetail`.
- [ ] PENDING-Proposal → hart abgelehnt (kein Trade ohne Freigabe).
- [ ] Audit verknüpft Fill mit `proposalId`.

## Changelog-Blurb

`H6 (CRITICAL): Keine echte Approval-Chain — Executor führt nur noch server-validierte, APPROVED
Proposals aus; Orderparameter kommen zwingend aus proposedDetail.`

## Versions-Hinweis

PATCH (`1.36.3`) — Logik-Korrektur, kein Schema-Bruch (bestehende `proposals`-Tabelle).
