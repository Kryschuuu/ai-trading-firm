# Findings — 2026-09-03 Peer-Review

Alle Einzelfindings dieses Audits — ein File pro Befund, self-contained Arena-Prompt.

| ID | Bereich | Severity | Status | Datei |
|----|---------|----------|--------|-------|
| H1 | Handelslogik | CRITICAL | FIXED v1.36.2 | [H1](./H1-risk-notional.md) |
| H2 | Handelslogik | CRITICAL | FIXED v1.36.19 | [H2](./H2-atomicity.md) |
| H3 | Handelslogik | CRITICAL | FIXED v1.36.4 | [H3](./H3-order-status.md) |
| H4 | Handelslogik/Broker | CRITICAL | FIXED v1.36.5 | [H4](./H4-idempotency.md) |
| H5 | Handelslogik | CRITICAL | FIXED v1.36.6 | [H5](./H5-pipeline-trading.md) |
| H6 | Handelslogik | CRITICAL | FIXED v1.36.7 | [H6](./H6-approval-chain.md) |
| H7 | Handelslogik/Control | HIGH | FIXED v1.36.20 | [H7](./H7-live-kill.md) |
| H8 | Brokers/Venues | HIGH | FIXED v1.36.10 | [H8](./H8-bitunix-equity.md) |
| H9 | Handelslogik | HIGH | FIXED v1.36.8 | [H9](./H9-finite-guardrails.md) |
| H10 | Handelslogik | HIGH | FIXED v1.36.21 | [H10](./H10-adaptive-failopen.md) |
| W1 | Workshop | HIGH | FIXED v1.36.23 | [W1](./W1-localstorage.md) |
| W2 | Workshop | MEDIUM | FIXED v1.36.24 | [W2](./W2-prompt-versioning.md) |
| C1 | Control Panel | HIGH | FIXED v1.36.13 | [C1](./C1-open-mode.md) |
| C2 | Control Panel | MED/HIGH | FIXED v1.36.14 | [C2](./C2-forwarded-ip.md) |
| C3 | Control Panel | HIGH | FIXED v1.36.15 | [C3](./C3-kill-disarm.md) |
| C4 | Control Panel | MEDIUM | FIXED v1.36.16 | [C4](./C4-control-state-persistence.md) |
| B1 | Brokers/Venues | HIGH | FIXED v1.36.11 | [B1](./B1-sl-tp-geometry.md) |
| B2 | Brokers/Venues | MEDIUM | FIXED v1.36.12 | [B2](./B2-side-fallback.md) |
| S1 | Sonstiges | MEDIUM | FIXED v1.36.18 | [S1](./S1-audit-reliability.md) |
| S2 | Sonstiges | MEDIUM | FIXED v1.36.22 | [S2](./S2-singleton-consistency.md) |

Siehe [../README.md](../README.md) für Gesamtübersicht und [../remediation/SUMMARY.md](../remediation/SUMMARY.md) für Remediation-Verlauf.
