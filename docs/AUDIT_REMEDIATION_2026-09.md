# Audit-Remediation-Plan — Senior Peer-Review (2026-09-03)

**Quelle:** Senior Peer-Review Audit über `riskGuard`, `engine`, `broker`, Portfolio-Risk-Guard,
Workshop/API, Auth/RBAC, Control Plane sowie die Bitunix-Ausführungs-, Signatur-, HTTP- und
Secret-Store-Schicht.
**Scope:** Kernpfade des aktuellen `main`-Standes (validiert gegen `a29e956`).
**Fazit des Audits:** Paper-Trading brauchbare Schutzarchitektur, aber relevante Inkonsistenzen;
**Live-Trading nicht freigabefähig.**

> Dieses Dokument bündelt den **Remediation-Plan**. Jeder Befund hat eine eigene, self-contained
> Arena-Prompt-Datei unter [`audit-remediation/`](../audit-remediation/) (`README.md` = Index).
> Die Prompts sind so formuliert, dass sie direkt als Task an Arena (bzw. einen Coding-Agenten)
> übergeben werden können — inkl. Ort, Beweis, Fix-Spezifikation, Akzeptanzkriterien und
> Changelog-Blurb.

## Validierung (wichtig: Code ist bereits mehrfach gepatcht)

Vor der Planung wurde jeder Befund gegen den **aktuellen** Code geprüft. Ergebnis: **H1 ist bereits
in v1.36.2 gefixt** (serverseitige `estimatedNotional`-Berechnung), **H3 in v1.36.4** und **H4 in
v1.36.5** (Order-Idempotenz). H2 ist teilweise adressiert (Singleton entfernt, aber keine verteilte
Atomarität). **H5 ist in v1.36.6 gefixt** (Proposal-only-Phasen; nur der Executor führt eine genehmigte Proposal aus). **H6 ist in v1.36.7 gefixt** (echte Approval-Chain; Executor führt nur noch server-validierte APPROVED Proposals aus; menschliche Freigabe via Endpoint). **H9 ist in v1.36.8 gefixt** (Guardrail-Numerik fail-closed: `requireFinitePositive` wirft `RiskValidationError` bei NaN/Infinity/≤0; negatives Equity wird blockiert statt geklemmt; alle Caller lehnen mit `INVALID_EQUITY`/`INVALID_LEVERAGE`/`INVALID_NOTIONAL` ab). Die übrigen Befunde bleiben wie ausgewiesen valide.

| ID | Bereich | Severity | Status (validiert) | Prompt |
|----|---------|----------|--------------------|--------|
| H1 | Handelslogik | CRITICAL | ✅ bereits gefixt (v1.36.2) | [H1](../audit-remediation/H1-risk-notional.md) |
| H2 | Handelslogik | CRITICAL | ⚠️ teilweise (keine verteilte Atomarität) | [H2](../audit-remediation/H2-atomicity.md) |
| H3 | Handelslogik | CRITICAL | ✅ gefixt (v1.36.4) | [H3](../audit-remediation/H3-order-status.md) |
| H4 | Handelslogik/Broker | CRITICAL | ✅ gefixt (v1.36.5) | [H4](../audit-remediation/H4-idempotency.md) |
| H5 | Handelslogik | CRITICAL | ✅ gefixt (v1.36.6) | [H5](../audit-remediation/H5-pipeline-trading.md) |
| H6 | Handelslogik | CRITICAL | ✅ gefixt (v1.36.7) | [H6](../audit-remediation/H6-approval-chain.md) |
| H7 | Handelslogik/Control | HIGH | ✅ valide (arch.) | [H7](../audit-remediation/H7-live-kill.md) |
| H8 | Brokers/Venues | HIGH | ✅ valide | [H8](../audit-remediation/H8-bitunix-equity.md) |
| H9 | Handelslogik | HIGH | ✅ gefixt (v1.36.8) | [H9](../audit-remediation/H9-finite-guardrails.md) |
| H10 | Handelslogik | HIGH | ✅ valide | [H10](../audit-remediation/H10-adaptive-failopen.md) |
| W1 | Workshop | HIGH | ✅ valide | [W1](../audit-remediation/W1-localstorage.md) |
| W2 | Workshop | MEDIUM | ✅ valide | [W2](../audit-remediation/W2-prompt-versioning.md) |
| C1 | Control Panel | HIGH | ✅ valide | [C1](../audit-remediation/C1-open-mode.md) |
| C2 | Control Panel | MED/HIGH | ✅ valide | [C2](../audit-remediation/C2-forwarded-ip.md) |
| C3 | Control Panel | HIGH | ✅ valide | [C3](../audit-remediation/C3-kill-disarm.md) |
| C4 | Control Panel | MEDIUM | ✅ valide | [C4](../audit-remediation/C4-control-state-persistence.md) |
| B1 | Brokers/Venues | HIGH | ✅ valide | [B1](../audit-remediation/B1-sl-tp-geometry.md) |
| B2 | Brokers/Venues | MEDIUM | ✅ valide | [B2](../audit-remediation/B2-side-fallback.md) |
| S1 | Sonstiges | MEDIUM | ✅ valide | [S1](../audit-remediation/S1-audit-reliability.md) |
| S2 | Sonstiges | MEDIUM | ✅ valide (arch.) | [S2](../audit-remediation/S2-singleton-consistency.md) |

## Empfohlene Abarbeitungsreihenfolge

1. **Fail-closed-Härtung (CRITICAL):** H3, H4, H5, H6, H9
2. **Broker/Venue-Korrektheit:** H8, B1, B2
3. **Control-Plane-Sicherheit:** C1, C2, C3, C4, S1
4. **Architektur/Live-Bereitschaft:** H2, H7, H10, S2
5. **Workshop:** W1, W2

Jeder Schritt ist unabhängig; H1 entfällt (bereits gefixt). Stand 2026-09-03 sind aus der
Fail-closed-Gruppe H3 (v1.36.4), H4 (v1.36.5), H5 (v1.36.6), H6 (v1.36.7) und H9 (v1.36.8)
abgeschlossen.

## Versionierung

Tracking als PATCH-Serie (Security-Audit-Plan + Fixes): H1=v1.36.2, H3=v1.36.4, H4=v1.36.5,
H5=v1.36.6, H6=v1.36.7, **H9=v1.36.8**. Siehe `CHANGELOG.md` und
`docs/CHANGELOG.md` (`[1.36.8]`).

## Verwandte Dokumente

- [`docs/SECURITY_AUDIT.md`](SECURITY_AUDIT.md) — vorheriges Security-Audit (2026-08-25, v1.4.0)
- [`audit-remediation/README.md`](../audit-remediation/README.md) — Prompt-Index + Validierung
- `CHANGELOG.md` / `docs/CHANGELOG.md` — `[1.36.8]`-Eintrag
