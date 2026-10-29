# CI-Workflows — Quelle, Synchronisation & Betrieb

> **Status-Header:** **Bestandsdokument** · **Stand:** 2026-10-27 · **Code-Version:** v0.17.6 (Beta) · Symbol-/Pfadabgleich erledigt (DC-06) · CI-Wächter, Spiegel-Sync & Dependabot gehärtet

> **Zweck:** Diese Dateien spiegeln die GitHub-Actions-Workflows unter `.github/workflows/`. Beide Kopien werden zusammen gepflegt — sowohl lokal über `npm run docs:validate` / `npm run ci:sync:check` als auch in CI über den Vorab-Spiegel-Sync-Schritt und `scripts/sync-ci-workflows.ts` wird erzwungen, dass sie byte-identisch bleiben. Workflow-Änderungen benötigen entsprechende GitHub-Schreibrechte (`workflows`-Scope); fehlen diese einer Verbindung, pflegt der Repository-Owner den Spiegel über `npm run ci:sync`.

## Workflows

| Datei | Zweck | Ziel in `.github/workflows/` |
|-------|-------|-------------------------------|
| `docs-validate.workflow.yml` | Required Check `docs-validate`: Vorab-Spiegel-Sync, CI-/SEC-10-/Dependabot-Invarianten, Typecheck, Gesamttestsuite, Docs-as-Code inkl. L1–L4 (DC-08) und Inventar-Drift-Gate (DC-09) | `main.yml` |
| `security-live-gate.workflow.yml` | Next-Regressionen Linux/Windows, Build, zweistufiges fail-closed Dependency-Audit, Auth, Secret-Scan und Live-Gate ≥95% Coverage | `security-live-gate.yml` |

## Synchronisation & Installation

```bash
# Kanonische Richtung (docs/ci/*.workflow.yml -> .github/workflows/*.yml):
npm run ci:sync

# Gegenrichtung (.github/workflows/*.yml -> docs/ci/*.workflow.yml):
npm run ci:sync -- --from=github

# Reiner Prüfmodus (läuft auch automatisch in `npm run docs:validate` und CI):
npm run ci:sync:check

# Einmalige Ersteinrichtung der Branch-Protection durch den Repo-Owner:
# Required Status Checks auf `main`: `docs-validate` + `security-live-gate`
```

### Dauerhafte Dependabot-Synchronisation (`.github/dependabot.yml`)

`.github/dependabot.yml` hält die auf immutable Commit-SHAs gepinnten Actions
aktuell (Audit SEC-10). Damit Dependabot-PRs nicht am Spiegel-Sync scheitern
(früherer Defekt bei `directory: /`, siehe PR #243), nutzt die Konfiguration:

- **`directories: ["/", "/docs/ci"]`** — Dependabot scannt sowohl
  `.github/workflows/*.yml` als auch `docs/ci/*.workflow.yml`.
- **`groups.actions` (`applies-to: version-updates`) und `groups.actions-security`
  (`applies-to: security-updates`)** — sowohl wöchentliche Versions-Updates als
  auch kurzfristige Security-Updates werden über beide Verzeichnisse hinweg in
  **einem gemeinsamen PR** gebündelt, sodass alle vier Dateien atomar denselben
  SHA + Tag-Kommentar erhalten.
- **`scripts/sync-ci-workflows.ts` (`checkCiWorkflows`, `syncCiWorkflows`)**
  prüft diese Invarianten (Byte-Gleichheit, keine verwaisten Workflow-Dateien,
  40-stellige SHA-Pins mit `# vX.Y.Z`-Kommentar, Multi-Directory-Dependabot)
  bereits lokal in `npm run docs:validate`.

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
- Die Quelle in `docs/ci/` ist versioniert und wird direkt nach `Checkout` per
  `diff -u` (mit expliziter `::error::`-Annotation) sowie nach `npm ci` über
  `npm run ci:sync:check -- --gha` geprüft. Wenn eine GitHub-Verbindung
  Workflow-Dateien nicht schreiben darf, synchronisiert der Owner per
  `npm run ci:sync`.

## CI-Jobs

### docs-validate

- **Vorab-Spiegel-Sync (vor Node/npm):** `diff -u` direkt nach `Checkout` bricht
  bei Spiegel-Drift in <1 s mit klarer GitHub-Annotation ab, ohne erst
  `npm ci` abzuwarten.
- **CI-Workflow-Invarianten (`npm run ci:sync:check -- --gha`):** Byte-Parität,
  Spiegel-Vollständigkeit (keine ungespiegelten `.yml`/`.yaml`-Dateien),
  SEC-10-SHA-Pinning (40-Hex-SHA + `# vX.Y.Z`) und Dependabot-Abdeckung beider
  Verzeichnisse.
- **Typecheck:** `npm run typecheck`.
- **Gesamttestsuite:** `npm test`; `tests/brokerContracts.test.ts` startet ein eigenes
  temporäres Embedded-PostgreSQL und verlangt in CI (über
  `BROKER_CONTRACTS_REQUIRE_DB=true`) einen erfolgreichen DB-Start. Die beiden
  PAPER-Tests skippen nur bei nicht startbarer optionaler Infrastruktur in
  lokalen Offline-Läufen; Schema-/Query-Fehler sind immer echte Testfehler.
- **Generierte Inventare:** `npm run docs:inventories:check` (DC-09) — Drift in
  `docs/generated/` (Routen, Env-Flags, Schema) bricht den Job.
- **`npm run docs:validate`** (alle Checks deterministisch/offline):
  - Help-Schema, relative Links/Anker, Viewer-Auflösung, Markdown-Lint und Secret-Scan.
  - CI-Workflow-Spiegel, SEC-10-Pins und Dependabot-Konfiguration.
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
- **Dependency-Audit in zwei fail-closed-Stufen:**
  - **Stufe 1 — Auslieferungspfad (`npm audit --audit-level=high --omit=dev`):**
    Produktions-Abhängigkeiten müssen frei von hohen/kritischen Advisories sein
    und werden separat zuerst geprüft, damit ein Laufzeit-Fund im CI-Log sofort
    erkennbar ist.
  - **Stufe 2 — Gesamtbaum inkl. Dev (`npm audit --audit-level=high`):**
    Auch Dev- und Build-Abhängigkeiten (esbuild, tailwind, postcss, eslint) sind
    ab `high`/`critical` strikt blockierend (ohne `continue-on-error`). Die
    frühere temporäre Ausnahme für `braces@3.0.3` ist mit
    `eslint-config-next@16.4.3` entfallen und entfernt.
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
- Secret-Scan (`scripts/scan-live-gate-secrets.ts`) über Live-Gate-Code, -Tests,
  beide Workflow-Paare (`docs/ci/` und `.github/workflows/`) sowie
  `.github/dependabot.yml`.
- Live-Gate-Suite mit ≥95% Coverage (Enforcer, Kill-Switch, RBAC, Rate-Limit, Audit-Sink).
  **Messbarkeit:** alle Coverage-Skripte in `package.json` nutzen
  `--enable-source-maps`, sonst zählt V8 die `tsx`-Transform-Zeilen statt der
  TypeScript-Quellen und erzeugt Phantom-Fehlzeilen (ASA-02-Folgefix, PR #247).
  `npm run docs:validate` prüft diese Invariante (`TS-Coverage==Source-Maps`),
  die Schwelle von 95% bleibt unangetastet. Neue Gate-Zweige gehören in eine
  `tests/liveGate.*.test.ts` (siehe `tests/liveGate.fourEyes.test.ts`).
- ASA-02-HTTP-Regressionen über `npm run test:security:asa02` (12 Tests,
  `tests/asa02.lifecycleAndLiveKillAuthz.test.ts`) im selben Required Check.
- Suite-Stamp-Erzeugung per Step-`env` (keine Inline-Template-Interpolation im
  Shell-Skript) und Upload als Artefakt (`actions/upload-artifact` v7.0.2).

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
