# Audit-Remediation-Plan — Senior Peer-Review (2026-09-03)

Dieses Verzeichnis enthält **pro Befund einen einzelnen, self-contained Arena-Prompt** plus
eine Validierung gegen den aktuellen `main`-Stand. Ziel: jeder Bug lässt sich einzeln abarbeiten
(`arena/01a0647e-ai-trading-firm` → PR), sofern die Behauptung valide ist.

> **Wichtig — Validierung zuerst.** Der aktuelle Code ist bereits mehrfach gepatcht.
> H1 ist z. B. bereits in **v1.36.2** gefixt. Jeder Prompt trägt daher einen
> **Status (validiert)**, der angibt, ob der Befund im aktuellen Code noch zutrifft.

## Validierungsübersicht (Stand 2026-09-03, main @ a29e956)

| ID | Bereich | Severity | Status im Code | Prompt |
|----|---------|----------|----------------|--------|
| H1 | Handelslogik | CRITICAL | ✅ **Bereits gefixt** (v1.36.2) | [H1](./H1-risk-notional.md) |
| H2 | Handelslogik | CRITICAL | ⚠️ **Teilweise** (Singleton weg, aber keine verteilte Atomarität) | [H2](./H2-atomicity.md) |
| H3 | Handelslogik | CRITICAL | ✅ Gefixt (v1.36.4) | [H3](./H3-order-status.md) |
| H4 | Handelslogik/Broker | CRITICAL | ✅ Gefixt (v1.36.5) | [H4](./H4-idempotency.md) |
| H5 | Handelslogik | CRITICAL | ✅ Valide | [H5](./H5-pipeline-trading.md) |
| H6 | Handelslogik | CRITICAL | ✅ Valide | [H6](./H6-approval-chain.md) |
| H7 | Handelslogik/Control | HIGH | ✅ Valide (architektonisch) | [H7](./H7-live-kill.md) |
| H8 | Brokers/Venues | HIGH | ✅ Valide | [H8](./H8-bitunix-equity.md) |
| H9 | Handelslogik | HIGH | ✅ Valide | [H9](./H9-finite-guardrails.md) |
| H10 | Handelslogik | HIGH | ✅ Valide | [H10](./H10-adaptive-failopen.md) |
| W1 | Workshop | HIGH | ✅ Valide | [W1](./W1-localstorage.md) |
| W2 | Workshop | MEDIUM | ✅ Valide | [W2](./W2-prompt-versioning.md) |
| C1 | Control Panel | HIGH | ✅ Valide | [C1](./C1-open-mode.md) |
| C2 | Control Panel | MED/HIGH | ✅ Valide | [C2](./C2-forwarded-ip.md) |
| C3 | Control Panel | HIGH | ✅ Valide | [C3](./C3-kill-disarm.md) |
| C4 | Control Panel | MEDIUM | ✅ Valide | [C4](./C4-control-state-persistence.md) |
| B1 | Brokers/Venues | HIGH | ✅ Valide | [B1](./B1-sl-tp-geometry.md) |
| B2 | Brokers/Venues | MEDIUM | ✅ Valide | [B2](./B2-side-fallback.md) |
| S1 | Sonstiges | MEDIUM | ✅ Valide | [S1](./S1-audit-reliability.md) |
| S2 | Sonstiges | MEDIUM | ✅ Valide (architektonisch) | [S2](./S2-singleton-consistency.md) |

## Wie man die Prompts ausführt

Jede `.md`-Datei enthält oben einen **kopierbaren `Arena-Prompt`**-Block. Dieser ist so formuliert,
dass er direkt als Task an Arena (bzw. einen Coding-Agenten) übergeben werden kann. Er beschreibt:

1. **Ort** (Datei + Symptom)
2. **Beweis** (konkreter Code-Auszug, der das Problem zeigt)
3. **Fix-Spezifikation** (was konkret zu ändern ist, inkl. Code-Skizze)
4. **Akzeptanzkriterien / Tests**
5. **Changelog-Blurb** + Versions-Hinweis

## Versionierung

Die Remediation wird unter Version **1.36.3** getrackt (PATCH: Security-Audit-Plan + Fixes).
Siehe `CHANGELOG.md` und `docs/CHANGELOG.md` (`[1.36.3]`). Jeder einzelne Fix ist als eigener
Commit/Optional-eigener-PR denkbar; dieser Plan bündelt sie als nachvollziehbares Tracking-Dokument.

## Reihenfolge der Abarbeitung (Empfehlung)

1. **Fail-closed-Härtung (CRITICAL):** H3, H4, H5, H6, H9
2. **Broker/Venue-Korrektheit:** H8, B1, B2
3. **Control-Plane-Sicherheit:** C1, C2, C3, C4, S1
4. **Architektur/Live-Bereitschaft:** H2, H7, H10, S2
5. **Workshop:** W1, W2

Jeder Schritt ist unabhängig; H1 entfällt (bereits gefixt).
