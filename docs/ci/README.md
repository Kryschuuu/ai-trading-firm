# CI-Workflows — Quelle & Installation

> **Status-Header:** **Bestandsdokument** · **Stand:** 2026-10-10 · **Code-Version:** v0.17.2 (Beta) · Symbol-/Pfadabgleich erledigt (DC-06) · CI-Wächter nach DC-08 erweitert

> **Zweck:** Diese Dateien spiegeln die GitHub-Actions-Workflows unter `.github/workflows/`. Beide Kopien werden zusammen gepflegt — der Spiegel-Sync-Schritt im Job `docs-validate` erzwingt, dass sie byte-identisch bleiben. Workflow-Änderungen benötigen entsprechende GitHub-Schreibrechte; fehlen diese der verwendeten Verbindung, muss der Repository-Owner die Quelle übernehmen.

## Workflows

| Datei | Zweck | Ziel in `.github/workflows/` |
|-------|-------|-------------------------------|
| `docs-validate.workflow.yml` | Required Check `docs-validate`: Typecheck, Gesamttestsuite, Spiegel-Sync, Docs-as-Code inkl. L1–L4 (DC-08) | `main.yml` |
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

**Branch-Protection:** Als erforderliche Status-Checks sind exakt
`docs-validate` und `security-live-gate` einzutragen. Die komplette
`npm test`-Suite ist ein Schritt **innerhalb** des Required Checks
`docs-validate`, kein separater Check-Name.

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

- Typecheck: `npm run typecheck`.
- Gesamttestsuite: `npm test`; `tests/brokerContracts.test.ts` startet ein eigenes
  temporäres Embedded-PostgreSQL und verlangt in CI (über
  `BROKER_CONTRACTS_REQUIRE_DB=true`) einen erfolgreichen DB-Start. Die beiden
  PAPER-Tests skippen nur bei nicht startbarer optionaler Infrastruktur in
  lokalen Offline-Läufen; Schema-/Query-Fehler sind immer echte Testfehler.
- Spiegel-Sync: `docs/ci/*.workflow.yml` == `.github/workflows/`-Kopien (byte-identisch).
- `npm run docs:validate` (alle Checks deterministisch/offline):
  - Help-Schema, relative Links/Anker, Viewer-Auflösung, Markdown-Lint und Secret-Scan.
  - **L1 (blocking):** Jedes dokumentierte Env-Flag muss einen statisch
    auflösbaren Code-Read haben (AST inkl. Helpern, Konstanten, Barrels und
    dynamischem `env[name]`; suffix-basierte Nicht-Runtime-Whitelist nur mit
    begründeter Ausnahme).
  - **L2 (non-blocking):** Code→Doku-Drift bei Env-Reads und API-Routen wird als
    begrenzte Warnung ausgegeben, nie als Merge-Blockade.
  - **L3 (blocking):** aktive `Code-Version`-Header gegen `package.json`;
    `Dokument-Version` bleibt unabhängig. Archive/Audits/Peer-Reviews sind historisch.
  - **L4 (blocking):** konkrete dokumentierte `src/**`-/`scripts/**`-Pfade und
    benannte Exporte müssen existieren; begründete Altpfade sind whitelisted.
  - Doku-Routen gegen registrierte API-Routen und Live-Gate-States gegen
    `LIVE_TRADING.md`.

Der Workflow-Job heißt `docs-validate`; genau dieser Name ist als Required
Status Check in der Branch-Protection einzutragen. `npm test` ist Teil dieses
Checks, kein separater Branch-Protection-Check.

### security-live-gate

- SEC-03: Job `security-next-windows` prüft die installierte Next-/Decoder-Kette
  und die Framework-Grenzen nativ unter Windows (`npm run test:security:next`).
- Der Required Check `security-live-gate` hängt von diesem Job ab, führt dieselbe
  Next-Suite unter Linux aus und prüft zusätzlich den Produktions-Build.
  Kein Suite-Stamp bei fehlgeschlagener Windows-Regression. Ein expliziter
  Fail-Closed-Schritt macht den Required Check bei fehlgeschlagenem/ausgelassenem
  Windows-Job rot; ein lediglich übersprungener abhängiger Job genügt nicht.
- Dependency-Audit in zwei Stufen:
  - **Auslieferungspfad (fail-closed ab high):** `npm audit --audit-level=high --omit=dev`.
    Alles, was ausgeliefert wird, muss frei von hohen/kritischen Advisories sein.
    Der ursprüngliche Grund für die Dev-Abdeckung — Build-Tools (esbuild, tailwind,
    postcss) fließen in die Bundles ein — bleibt unberührt, denn all das sind
    Produktions- bzw. Build-Transitiv-Abhängigkeiten, keine Lint-Werkzeuge.
  - **Gesamtbaum inkl. Dev (protokolliert, nicht blockierend):** der vollständige
    Audit läuft weiter und wird ausgegeben (`continue-on-error: true`). Nicht
    blockierend ist genau eine Kette, und nur, weil kein Fix existiert:
    `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` →
    `micromatch` → `braces@3.0.3` (GHSA-vfj7-8cjw-p6xm, `<= 3.0.3`; jeder Knoten
    `dev: true`, `braces` fließt in kein Bundle). Der einzige npm-Vorschlag wäre
    ein Major-Downgrade von `eslint-config-next`, der dessen Peer-Dep
    `eslint >= 9` verletzt und `npm run lint` bricht. Sobald npm ein gepatchtes
    `braces` veröffentlicht, gehört die Ausnahme entfernt, nicht verlängert.
- SEC-04: `npm ls ws --all` + `npm run test:security:ws` vor Build und Suite —
  exakter `ws`-Pin, Override für transitive Kopien, jeder Lockfile-Eintrag, die
  installierte Auflösung sowie Laufzeit-Guard und Payload-Kappe des
  Bitunix-WS-Clients.
- SEC-01/SEC-02/Auth-Regressionen vor der Live-Gate-Suite (`npm run test:security:auth`):
  Session-Vertrauensgrenze, geschützte Reads, RBAC, Login/CSRF, Credential-Änderungen, Setup/Boot
- SEC-05/SEC-06 im selben verpflichtenden Auth-Gate: 17 bestehende Attributions-
  und 72 neue Rule-Governance-/Nachprüfungstests, inklusive Header/Bearer/Session,
  positiver Mutations-/Audit-Pfade, verweigerter Zugriffe vor Persistenz und
  administrativem Makro-Einstieg. Keine Datenbank-/LLM-Verbindung, kein Skip.
- Live-Gate-Suite mit ≥95% Coverage
- Enforcer, Kill-Switch, RBAC, Rate-Limit, Audit-Sink

Ausführen: `npm run security:live-gate`

### Gesamttestsuite (`npm test`, Teil des Required Checks)

`npm test` läuft als Schritt im Workflow-Job `docs-validate`; es ist kein
separater Required-Check-Name. Andere Datenbank-Suites folgen ihrem
`embedded-postgres`-Skip-Vertrag. `tests/brokerContracts.test.ts` startet selbst
ein temporäres Embedded-PostgreSQL und baut ein isoliertes Minimal-Schema für
den echten PAPER-Adapterpfad auf. Wenn Embedded-PostgreSQL lokal nicht
startbar ist, werden ausschließlich die beiden DB-abhängigen PAPER-Probes
übersprungen; Schema-/Query-Fehler skippen nie. CI setzt
`BROKER_CONTRACTS_REQUIRE_DB=true`, daher wird ein fehlgeschlagener DB-Start
blockierend. Bei verfügbarer DB müssen alle 42 Contract-Tests bestehen (42/42).

## Verwandte Dokumente

- [ARCHITECTURE.md](../ARCHITECTURE.md) §13 — Docs-as-Code-Pflege
- [DOCS_SYNC_AUDIT.md](../DOCS_SYNC_AUDIT.md) — Audit aller Doku-Behauptungen
- [LIVE_TRADING.md](../LIVE_TRADING.md) §CI — Live-Gate CI
- [SEC-10-Github-Actions-Pinning](../audits/2026-09-05-security-review-gpt01/findings/SEC-10-github-actions-pinning.md) — Supply-Chain-Hardening der Workflows
