# Audit: Senior Peer-Review — 2026-09-03

**Quelle:** Senior Peer-Review Audit über `riskGuard`, `engine`, `broker`, Portfolio-Risk-Guard, Workshop/API, Auth/RBAC, Control Plane sowie die Bitunix-Ausführungs-, Signatur-, HTTP- und Secret-Store-Schicht.  
**Scope:** Kernpfade des aktuellen `main`-Standes (validiert gegen `a29e956`; Nachträge bis `v1.36.24`).  
**Venue-Referenz (B2):** Bitunix definiert `side` in `get_pending_positions` als `LONG`/`SHORT` (<https://www.bitunix.com/api-docs/futures/position/get_pending_positions.html>).  
**Fazit des Audits:** Paper-Trading brauchbare Schutzarchitektur, aber relevante Inkonsistenzen; **Live-Trading nicht freigabefähig.**  
**Datum:** 2026-09-03  
**Status:** CLOSED — alle Findings gefixt (v1.36.2 bis v1.36.24)  
**Branch:** `main` (Fixes bis `v1.36.24`)

> **Migration:** Diese Datei ist die konsolidierte Version von `docs/AUDIT_REMEDIATION_2026-09.md` und `audit-remediation/README.md`. Die Einzelfindings liegen jetzt in `findings/`. Der alte Ordner `audit-remediation/` im Root ist deprecated und wird entfernt — neue Struktur siehe `docs/audits/README.md`.

## Severity-Übersicht

| Severity | Anzahl | Offen | Gefixt |
|----------|--------|-------|--------|
| CRITICAL | 6 | 0 | 6 (H1-H6) |
| HIGH | 10 | 0 | 10 (H7-H10, B1, C1-C3, W1, S1) |
| MEDIUM | 5 | 0 | 5 (B2, C4, S2, W2, S1) |
| LOW | 0 | 0 | 0 |

## Findings-Index

| ID | Bereich | Severity | Status | Fix-Version | Datei |
|----|---------|----------|--------|-------------|-------|
| H1 | Handelslogik | CRITICAL | ✅ FIXED | v1.36.2 | [H1](./findings/H1-risk-notional.md) |
| H2 | Handelslogik | CRITICAL | ✅ FIXED | v1.36.19 | [H2](./findings/H2-atomicity.md) |
| H3 | Handelslogik | CRITICAL | ✅ FIXED | v1.36.4 | [H3](./findings/H3-order-status.md) |
| H4 | Handelslogik/Broker | CRITICAL | ✅ FIXED | v1.36.5 | [H4](./findings/H4-idempotency.md) |
| H5 | Handelslogik | CRITICAL | ✅ FIXED | v1.36.6 | [H5](./findings/H5-pipeline-trading.md) |
| H6 | Handelslogik | CRITICAL | ✅ FIXED | v1.36.7 | [H6](./findings/H6-approval-chain.md) |
| H7 | Handelslogik/Control | HIGH | ✅ FIXED | v1.36.20 | [H7](./findings/H7-live-kill.md) |
| H8 | Brokers/Venues | HIGH | ✅ FIXED | v1.36.10 | [H8](./findings/H8-bitunix-equity.md) |
| H9 | Handelslogik | HIGH | ✅ FIXED | v1.36.8 | [H9](./findings/H9-finite-guardrails.md) |
| H10 | Handelslogik | HIGH | ✅ FIXED | v1.36.21 | [H10](./findings/H10-adaptive-failopen.md) |
| W1 | Workshop | HIGH | ✅ FIXED | v1.36.23 | [W1](./findings/W1-localstorage.md) |
| W2 | Workshop | MEDIUM | ✅ FIXED | v1.36.24 | [W2](./findings/W2-prompt-versioning.md) |
| C1 | Control Panel | HIGH | ✅ FIXED | v1.36.13 | [C1](./findings/C1-open-mode.md) |
| C2 | Control Panel | MED/HIGH | ✅ FIXED | v1.36.14 | [C2](./findings/C2-forwarded-ip.md) |
| C3 | Control Panel | HIGH | ✅ FIXED | v1.36.15 | [C3](./findings/C3-kill-disarm.md) |
| C4 | Control Panel | MEDIUM | ✅ FIXED | v1.36.16 | [C4](./findings/C4-control-state-persistence.md) |
| B1 | Brokers/Venues | HIGH | ✅ FIXED | v1.36.11 | [B1](./findings/B1-sl-tp-geometry.md) |
| B2 | Brokers/Venues | MEDIUM | ✅ FIXED | v1.36.12 | [B2](./findings/B2-side-fallback.md) |
| S1 | Sonstiges | MEDIUM | ✅ FIXED | v1.36.18 | [S1](./findings/S1-audit-reliability.md) |
| S2 | Sonstiges | MEDIUM | ✅ FIXED | v1.36.22 | [S2](./findings/S2-singleton-consistency.md) |

Siehe `remediation/SUMMARY.md` für detaillierten Verlauf und `findings/` für Arena-Prompts.

## Validierung (wichtig: Code ist bereits mehrfach gepatcht)

Vor der Planung wurde jeder Befund gegen den aktuellen Code geprüft. Alle Befunde sind inzwischen gefixt — Details siehe Original-Report in `report.md` und Einzelfindings.

- **H1** v1.36.2: serverseitige `estimatedNotional`-Berechnung
- **H3** v1.36.4, **H4** v1.36.5: Order-Idempotenz
- **H2** v1.36.19: verteilte Atomarität via `order_intents` + `pg_advisory_xact_lock`
- **H7** v1.36.20: Kill-Switch/Flatten venue-bewusst
- **H5** v1.36.6: Proposal-only-Phasen
- **H6** v1.36.7: echte Approval-Chain
- **H9** v1.36.8: Guardrail-Numerik fail-closed
- **H8** v1.36.10: kanonische `BrokerAccount`-Zerlegung
- **B1** v1.36.11: Bitunix-SL/TP-Geometrie
- **B2** v1.36.12: Bitunix-Positionsseite validiert
- **C1** v1.36.13: Auth-Modus `AUTH_MODE`
- **C2** v1.36.14: Rate-Limit-Identität `src/lib/clientIp.ts`
- **C3** v1.36.15: Kill-Switch-Disarm stärker als Arm
- **C4** v1.36.16: Control-Plane-Zustand persistiert
- **S1** v1.36.18: klassifizierte Audit-Senke `auditSink.ts`
- **H10** v1.36.21: adaptives Risk fail-closed `UNKNOWN`
- **S2** v1.36.22: zentrale `stateRegistry`
- **W1** v1.36.23: Session-Cookie statt localStorage
- **W2** v1.36.24: Prompt-Editor mit Optimistic-Lock

## Empfohlene Abarbeitungsreihenfolge (historisch)

1. **Fail-closed-Härtung (CRITICAL):** H3, H4, H5, H6, H9 — ✅ alle gefixt
2. **Broker/Venue-Korrektheit:** H8, B1, B2 — ✅ gefixt
3. **Control-Plane-Sicherheit:** C1-C4, S1 — ✅ gefixt
4. **Architektur/Live-Bereitschaft:** H2, H7, H10, S2 — ✅ gefixt
5. **Workshop:** W1, W2 — ✅ gefixt

## Versionierung

Tracking als PATCH-Serie: H1=v1.36.2, H3=v1.36.4, H4=v1.36.5, H5=v1.36.6, H6=v1.36.7, H9=v1.36.8, H8=v1.36.10, B1=v1.36.11, B2=v1.36.12, C1=v1.36.13, C2=v1.36.14, C3=v1.36.15, C4=v1.36.16, S1=v1.36.18, H2=v1.36.19, H7=v1.36.20, H10=v1.36.21, S2=v1.36.22, W1=v1.36.23, W2=v1.36.24.

## Verwandte Dokumente

- Original-Report: [report.md](./report.md)
- Security-Audit: [../../security/SECURITY_AUDIT.md](../../security/SECURITY_AUDIT.md)
- Peer-Reviews: [../../peer-reviews/](../../peer-reviews/)
- Changelog: [../../../CHANGELOG.md](../../../CHANGELOG.md)
