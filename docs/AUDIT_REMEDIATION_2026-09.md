# Audit-Remediation-Plan — Senior Peer-Review (2026-09-03)

**Quelle:** Senior Peer-Review Audit über `riskGuard`, `engine`, `broker`, Portfolio-Risk-Guard,
Workshop/API, Auth/RBAC, Control Plane sowie die Bitunix-Ausführungs-, Signatur-, HTTP- und
Secret-Store-Schicht.
**Scope:** Kernpfade des aktuellen `main`-Standes (validiert gegen `a29e956`; Nachträge bis
`v1.36.14`).
**Venue-Referenz (B2):** Bitunix definiert `side` in `get_pending_positions` als
`LONG`/`SHORT`
(<https://www.bitunix.com/api-docs/futures/position/get_pending_positions.html>).
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
Atomarität). **H5 ist in v1.36.6 gefixt** (Proposal-only-Phasen; nur der Executor führt eine genehmigte Proposal aus). **H6 ist in v1.36.7 gefixt** (echte Approval-Chain; Executor führt nur noch server-validierte APPROVED Proposals aus; menschliche Freigabe via Endpoint). **H9 ist in v1.36.8 gefixt** (Guardrail-Numerik fail-closed: `requireFinitePositive` wirft `RiskValidationError` bei NaN/Infinity/≤0; negatives Equity wird blockiert statt geklemmt; alle Caller lehnen mit `INVALID_EQUITY`/`INVALID_LEVERAGE`/`INVALID_NOTIONAL` ab). **H8 ist in v1.36.10 gefixt** (kanonische `BrokerAccount`-Zerlegung walletBalance/availableCash/usedMargin/maintenanceMargin/unrealizedPnl; Bitunix-Equity = `walletBalance + realizedPnl + unrealizedPnl` statt `available + uPnL`). **B1 ist in v1.36.11 gefixt** (Bitunix-SL/TP-Geometrie: `serializePlaceOrder` lehnt semantisch falsche Stop/Take-Staffelung relativ zum Entry ab). **B2 ist in v1.36.12 gefixt** (Bitunix-Positionsseite: `getPositions` validiert `side` auf `LONG`/`SHORT` und verwirft den Rest — Zähler + Warnung statt stiller `LONG`-Default; `qty<=0`-Zeilen scheiden vorher aus). **C1 ist in v.1.36.13 gefixt** (Auth-Modus `AUTH_MODE = local-open | token-required` in `src/auth/authMode.ts`; Produktion ohne Token verweigert den Start über den Boot-Guard in `src/instrumentation.ts` mit `ConfigurationError: AUTH_NOT_CONFIGURED`; `checkApiToken`/`resolveAuth` fragen denselben Modus ab, und wo nur ein Admin-/Viewer-Token existiert, entscheidet die Permission `firm.write` statt „offen“). **C2 ist in v1.36.14 gefixt** (Rate-Limit-Identität: `src/lib/clientIp.ts` als einzige Quelle für Firm- und Credential-Limiter — `TRUSTED_PROXY_IPS` + proxy-gesetztes `x-verified-ip`, `x-forwarded-for` nur hinter verifiziertem Trusted-Proxy-Peer und rightmost-untrusted, `x-real-ip` nie; ohne Vertrauen Socket-Adresse bzw. Konstante `local`. Dazu globaler IP-unabhängiger Credential-Deckel `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT` (20/min) und exponentieller Backoff ab dem 3. Fehlversuch (2 s → 15 min) — Kill-Switch bewusst ausgenommen; Diagnose über `GET /api/auth/me → rateLimitIdentity`). Die übrigen Befunde bleiben wie ausgewiesen valide.

| ID | Bereich | Severity | Status (validiert) | Prompt |
|----|---------|----------|--------------------|--------|
| H1 | Handelslogik | CRITICAL | ✅ bereits gefixt (v1.36.2) | [H1](../audit-remediation/H1-risk-notional.md) |
| H2 | Handelslogik | CRITICAL | ⚠️ teilweise (keine verteilte Atomarität) | [H2](../audit-remediation/H2-atomicity.md) |
| H3 | Handelslogik | CRITICAL | ✅ gefixt (v1.36.4) | [H3](../audit-remediation/H3-order-status.md) |
| H4 | Handelslogik/Broker | CRITICAL | ✅ gefixt (v1.36.5) | [H4](../audit-remediation/H4-idempotency.md) |
| H5 | Handelslogik | CRITICAL | ✅ gefixt (v1.36.6) | [H5](../audit-remediation/H5-pipeline-trading.md) |
| H6 | Handelslogik | CRITICAL | ✅ gefixt (v1.36.7) | [H6](../audit-remediation/H6-approval-chain.md) |
| H7 | Handelslogik/Control | HIGH | ✅ valide (arch.) | [H7](../audit-remediation/H7-live-kill.md) |
| H8 | Brokers/Venues | HIGH | ✅ gefixt (v1.36.10) | [H8](../audit-remediation/H8-bitunix-equity.md) |
| H9 | Handelslogik | HIGH | ✅ gefixt (v1.36.8) | [H9](../audit-remediation/H9-finite-guardrails.md) |
| H10 | Handelslogik | HIGH | ✅ valide | [H10](../audit-remediation/H10-adaptive-failopen.md) |
| W1 | Workshop | HIGH | ✅ valide | [W1](../audit-remediation/W1-localstorage.md) |
| W2 | Workshop | MEDIUM | ✅ valide | [W2](../audit-remediation/W2-prompt-versioning.md) |
| C1 | Control Panel | HIGH | ✅ **gefixt v.1.36.13** | [C1](../audit-remediation/C1-open-mode.md) |
| C2 | Control Panel | MED/HIGH | ✅ **gefixt v.1.36.14** | [C2](../audit-remediation/C2-forwarded-ip.md) |
| C3 | Control Panel | HIGH | ✅ valide | [C3](../audit-remediation/C3-kill-disarm.md) |
| C4 | Control Panel | MEDIUM | ✅ valide | [C4](../audit-remediation/C4-control-state-persistence.md) |
| B1 | Brokers/Venues | HIGH | ✅ gefixt (v1.36.11) | [B1](../audit-remediation/B1-sl-tp-geometry.md) |
| B2 | Brokers/Venues | MEDIUM | ✅ gefixt (v1.36.12) | [B2](../audit-remediation/B2-side-fallback.md) |
| S1 | Sonstiges | MEDIUM | ✅ valide | [S1](../audit-remediation/S1-audit-reliability.md) |
| S2 | Sonstiges | MEDIUM | ✅ valide (arch.) | [S2](../audit-remediation/S2-singleton-consistency.md) |

## Empfohlene Abarbeitungsreihenfolge

1. **Fail-closed-Härtung (CRITICAL):** H3, H4, H5, H6, H9
2. **Broker/Venue-Korrektheit:** H8 ✅ gefixt (v1.36.10) — B1 ✅ gefixt (v1.36.11) — B2 ✅ gefixt (v1.36.12)
3. **Control-Plane-Sicherheit:** C1 ✅ **gefixt v.1.36.13** — C2 ✅ **gefixt v.1.36.14** — C3, C4, S1
4. **Architektur/Live-Bereitschaft:** H2, H7, H10, S2
5. **Workshop:** W1, W2

Jeder Schritt ist unabhängig; H1 entfällt (bereits gefixt). Stand 2026-09-03 sind aus der
Fail-closed-Gruppe H3 (v1.36.4), H4 (v1.36.5), H5 (v1.36.6), H6 (v1.36.7) und H9 (v1.36.8)
abgeschlossen; aus der Broker/Venue-Korrektheit sind **H8 (v1.36.10)**, **B1 (v1.36.11)** und
**B2 (v1.36.12)** abgeschlossen; aus der Control-Plane-Sicherheit sind **C1 (v1.36.13)** —
**gefixt v.1.36.13** — und **C2 (v1.36.14)** — **gefixt v.1.36.14** — abgeschlossen
(C3, C4, S1 offen).

## Versionierung

Tracking als PATCH-Serie (Security-Audit-Plan + Fixes): H1=v1.36.2, H3=v1.36.4, H4=v1.36.5,
H5=v1.36.6, H6=v1.36.7, H9=v1.36.8, **H8=v1.36.10**, **B1=v1.36.11**, **B2=v1.36.12**,
**C1=v1.36.13**, **C2=v1.36.14**. Siehe `CHANGELOG.md` und `docs/CHANGELOG.md` (`[1.36.14]`). Die
Versions-Hinweise der einzelnen Befunde nennen teils noch ältere Nummern (C1 und C2 ursprünglich
`1.36.3`) — maßgeblich ist die Serie oben.

## Verwandte Dokumente

- [`docs/SECURITY_AUDIT.md`](SECURITY_AUDIT.md) — vorheriges Security-Audit (2026-08-25, v1.4.0)
- [`audit-remediation/README.md`](../audit-remediation/README.md) — Prompt-Index + Validierung
- `CHANGELOG.md` / `docs/CHANGELOG.md` — `[1.36.14]`-Eintrag
