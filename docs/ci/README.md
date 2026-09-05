# CI-Workflows — Quelle & Installation

> **Zweck:** Diese Dateien sind die **Quelle** der GitHub-Actions-Workflows. Der Arena-Bot darf keine Dateien unter `.github/workflows/` schreiben (GitHub-Beschränkung), deshalb liegt die Quelle hier in `docs/ci/` und der Repository-Owner kopiert sie einmalig nach `.github/workflows/`.

## Workflows

| Datei | Zweck | Ziel in `.github/workflows/` |
|-------|-------|-------------------------------|
| `docs-validate.workflow.yml` | Docs-as-Code-Wächter: Schema, Links, Lint, Secrets, Konsistenz (Task 12) | `main.yml` |
| `security-live-gate.workflow.yml` | Live-Gate Security-Suite: ≥95% Coverage, Enforcer, Kill-Switch | `main-security-live-gatte.yml` |

## Installation (einmalig durch Owner)

```bash
cp docs/ci/docs-validate.workflow.yml .github/workflows/main.yml
cp docs/ci/security-live-gate.workflow.yml .github/workflows/main-security-live-gatte.yml
# Danach Branch-Protection: Required Status Checks `docs-validate` + `security-live-gate`
```

## Warum hier und nicht nur in `.github/`?

- Arena-Agents arbeiten auf Branch `arena/*` und dürfen `.github/workflows/` nicht ändern (GitHub schützt Workflow-Dateien vor Bots).
- Die Quelle in `docs/ci/` ist versioniert, dokumentiert und wird von `docs-validate` geprüft.
- Nach Merge in `main` kopiert der Owner die Dateien — dokumentiert in [LIVE_TRADING.md](../LIVE_TRADING.md) §CI und [SECURITY_AUDIT.md](../security/SECURITY_AUDIT.md).

## CI-Jobs

### docs-validate

- Help-Schema (`docs/help/*.help.json` vs `help.schema.json`)
- Link-Check (0 tote Links/Anker in `docs/`)
- Markdown-Lint (Code-Fences, ATX-Header, Trailing-Whitespace)
- Secret-Scan (keine Keys/Tokens)
- Konsistenz: Env-Flags (`CONFIGURATION.md`, `INSTALL.md`) == Code, API-Routen == Code, Live-Gate-States == `LIVE_TRADING.md`

Ausführen: `npm run docs:validate`

### security-live-gate

- Live-Gate-Suite mit ≥95% Coverage
- Enforcer, Kill-Switch, RBAC, Rate-Limit, Audit-Sink

Ausführen: `npm run security:live-gate`

## Verwandte Dokumente

- [ARCHITECTURE.md](../ARCHITECTURE.md) §13 — Docs-as-Code-Pflege
- [DOCS_SYNC_AUDIT.md](../DOCS_SYNC_AUDIT.md) — Audit aller Doku-Behauptungen
- [LIVE_TRADING.md](../LIVE_TRADING.md) §CI — Live-Gate CI
