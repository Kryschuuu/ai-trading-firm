# CI-Workflows — Quelle & Installation

> **Zweck:** Diese Dateien spiegeln die GitHub-Actions-Workflows unter `.github/workflows/`. Beide Kopien werden zusammen gepflegt — der Spiegel-Sync-Schritt im Job `docs-validate` erzwingt, dass sie byte-identisch bleiben. Workflow-Änderungen benötigen entsprechende GitHub-Schreibrechte; fehlen diese der verwendeten Verbindung, muss der Repository-Owner die Quelle übernehmen.

## Workflows

| Datei | Zweck | Ziel in `.github/workflows/` |
|-------|-------|-------------------------------|
| `docs-validate.workflow.yml` | Docs-as-Code-Wächter: Spiegel-Sync, Schema, Links, Lint, Secrets, Konsistenz (Task 12) | `main.yml` |
| `security-live-gate.workflow.yml` | Next-Regressionen Linux/Windows, Build, Dependency-Audit, Auth und Live-Gate ≥95% Coverage | `security-live-gate.yml` |

## Installation (einmalig durch Owner)

```bash
cp docs/ci/docs-validate.workflow.yml .github/workflows/main.yml
cp docs/ci/security-live-gate.workflow.yml .github/workflows/security-live-gate.yml
# Alt-Datei aus früherer Installation entfernen (Rename, siehe Changelog 1.36.29):
git rm .github/workflows/main-security-live-gatte.yml 2>/dev/null || true
# Danach Branch-Protection: Required Status Checks `docs-validate` + `security-live-gate`
```

Dazu `.github/dependabot.yml` (liegt bei, muss nicht kopiert werden): hält die
auf immutable Commit-SHAs gepinnten Actions aktuell (Audit SEC-10). Bei jedem
Actions-Update-PR vor dem Merge die `docs/ci/`-Kopien synchronisieren — der
Spiegel-Sync-Schritt im Job `docs-validate` rotet sonst bewusst.

## Trigger und Pre-PR-Prüfung

- Beide Workflows starten bei `push` auf `main` und `arena/**`, bei `pull_request`
  und manuell per `workflow_dispatch`. Damit lassen sich Änderungen auf dem
  Arbeitsbranch prüfen, **bevor** ein PR erstellt wird (Security-Release-Workflow).
- Beide Workflows nutzen `concurrency` (eine Gruppe je Ref): Bei Folge-Pushes auf
  denselben Branch/PR wird nur der neueste Lauf zu Ende geführt — der Required
  Check bezieht sich immer auf den aktuellen Head-SHA.
- Vor PR-Erstellung müssen beide Läufe für den aktuellen Head-SHA `success` melden;
  frühere Runs auf `main` oder nur lokale Prüfungen ersetzen das nicht.
- Die Quelle in `docs/ci/` ist versioniert und wird vom Spiegel-Sync-Schritt des
  Jobs `docs-validate` geprüft (vorher nur dokumentiert, jetzt erzwungen).
  Wenn eine GitHub-Verbindung Workflow-Dateien nicht schreiben darf, muss der
  Owner die beiden Kopien synchronisieren. Ohne aktiven Branch-Trigger ist eine
  GitHub-Prüfung vor PR-Erstellung nicht möglich.

## CI-Jobs

### docs-validate

- Spiegel-Sync: `docs/ci/*.workflow.yml` == `.github/workflows/`-Kopien (byte-identisch)
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
- Dependency-Audit: `npm audit --audit-level=high` schlägt fail-closed bei
  hohen/kritischen Advisories in den installierten Abhängigkeiten an
  (inkl. Dev — Build-Tools fließen in die Bundles ein).
- SEC-01/Auth-Regressionen vor der Live-Gate-Suite (`npm run test:security:auth`):
  Session-Vertrauensgrenze, RBAC, Login/CSRF, Credential-Änderungen, Setup/Boot
- Live-Gate-Suite mit ≥95% Coverage
- Enforcer, Kill-Switch, RBAC, Rate-Limit, Audit-Sink

Ausführen: `npm run security:live-gate`

### Bekannte Lücke: Unit-Tests (`npm test`)

Die reguläre Unit-Suite läuft bewusst **nicht** als Required Check: Auf `main`
schlagen aktuell 5 Docs-Konsistenz-Tests fehl (veraltete Erwartungen nach der
CHANGELOG-Konsolidierung `docs/CHANGELOG.md` → Root und der Migration der
Security-Audit-Kapitel; siehe `tests/docsVersioning.test.ts`,
`tests/portfolio.architecture.test.ts`). Erst wenn diese Tests repariert sind,
sollte `npm test` als zusätzlicher Job ergänzt werden — ein dauerhaft roter
oder still übergangener Check wäre schlechter als die dokumentierte Lücke.

## Verwandte Dokumente

- [ARCHITECTURE.md](../ARCHITECTURE.md) §13 — Docs-as-Code-Pflege
- [DOCS_SYNC_AUDIT.md](../DOCS_SYNC_AUDIT.md) — Audit aller Doku-Behauptungen
- [LIVE_TRADING.md](../LIVE_TRADING.md) §CI — Live-Gate CI
- [SEC-10-Github-Actions-Pinning](../audits/2026-09-05-security-review-gpt01/findings/SEC-10-github-actions-pinning.md) — Supply-Chain-Hardening der Workflows
