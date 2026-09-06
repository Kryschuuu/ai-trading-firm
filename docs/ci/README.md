# CI-Workflows — Quelle & Installation

> **Zweck:** Diese Dateien spiegeln die GitHub-Actions-Workflows unter `.github/workflows/`. Beide Kopien werden zusammen gepflegt. Workflow-Änderungen benötigen entsprechende GitHub-Schreibrechte; fehlen diese der verwendeten Verbindung, muss der Repository-Owner die Quelle übernehmen.

## Workflows

| Datei | Zweck | Ziel in `.github/workflows/` |
|-------|-------|-------------------------------|
| `docs-validate.workflow.yml` | Docs-as-Code-Wächter: Schema, Links, Lint, Secrets, Konsistenz (Task 12) | `main.yml` |
| `security-live-gate.workflow.yml` | Next-Regressionen Linux/Windows, Build, Auth und Live-Gate ≥95% Coverage | `main-security-live-gatte.yml` |

## Installation (einmalig durch Owner)

```bash
cp docs/ci/docs-validate.workflow.yml .github/workflows/main.yml
cp docs/ci/security-live-gate.workflow.yml .github/workflows/main-security-live-gatte.yml
# Danach Branch-Protection: Required Status Checks `docs-validate` + `security-live-gate`
```

## Trigger und Pre-PR-Prüfung

- Beide Workflows starten bei `push` auf `main` und `arena/**` sowie bei `pull_request`.
  Damit lassen sich Änderungen auf dem Arbeitsbranch prüfen, **bevor** ein PR
  erstellt wird (Security-Release-Workflow).
- Vor PR-Erstellung müssen beide Läufe für den aktuellen Head-SHA `success` melden;
  frühere Runs auf `main` oder nur lokale Prüfungen ersetzen das nicht.
- Die Quelle in `docs/ci/` ist versioniert und wird von `docs-validate` geprüft.
  Wenn eine GitHub-Verbindung Workflow-Dateien nicht schreiben darf, muss der
  Owner die beiden Kopien synchronisieren. Ohne aktiven Branch-Trigger ist eine
  GitHub-Prüfung vor PR-Erstellung nicht möglich.


## CI-Jobs

### docs-validate

- Help-Schema (`docs/help/*.help.json` vs `help.schema.json`)
- Link-Check (0 tote Links/Anker in `docs/`)
- Markdown-Lint (Code-Fences, ATX-Header, Trailing-Whitespace)
- Secret-Scan (keine Keys/Tokens)
- Konsistenz: Env-Flags (`CONFIGURATION.md`, `INSTALL.md`) == Code, API-Routen == Code, Live-Gate-States == `LIVE_TRADING.md`

Ausführen: `npm run docs:validate`

### security-live-gate

- SEC-03: Job `security-next-windows` prüft die installierte Next-/Decoder-Kette
  und die Framework-Grenzen nativ unter Windows (`npm run test:security:next`).
- Der Required Check `security-live-gate` hängt von diesem Job ab, führt dieselbe
  Next-Suite unter Linux aus und prüft zusätzlich den Produktions-Build.
  Kein Suite-Stamp bei fehlgeschlagener Windows-Regression. Ein expliziter
  Fail-Closed-Schritt macht den Required Check bei fehlgeschlagenem/ausgelassenem
  Windows-Job rot; ein lediglich übersprungener abhängiger Job genügt nicht.
- SEC-01/Auth-Regressionen vor der Live-Gate-Suite (`npm run test:security:auth`):
  Session-Vertrauensgrenze, RBAC, Login/CSRF, Credential-Änderungen, Setup/Boot
- Live-Gate-Suite mit ≥95% Coverage
- Enforcer, Kill-Switch, RBAC, Rate-Limit, Audit-Sink

Ausführen: `npm run security:live-gate`

## Verwandte Dokumente

- [ARCHITECTURE.md](../ARCHITECTURE.md) §13 — Docs-as-Code-Pflege
- [DOCS_SYNC_AUDIT.md](../DOCS_SYNC_AUDIT.md) — Audit aller Doku-Behauptungen
- [LIVE_TRADING.md](../LIVE_TRADING.md) §CI — Live-Gate CI
