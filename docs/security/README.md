# Security — Übersicht & Härtung

> **Status-Header:** **Bestandsdokument** · **Stand:** nicht datiert · **Code-Version:** v0.17.5 (Beta) · Vollabgleich offen — [DC-06](../audits/2026-10-06-docs-code-audit/findings/DC-06-symbol-und-pfad-drift.md)

> **Zweck:** Zentrale Anlaufstelle für Security-Themen — aggregiert offene Critical/High Findings aus allen Audits, beschreibt Security-Modell, Auth, RBAC, Rate-Limiting und Härtungsmaßnahmen.

## Security-Modell (Kurzfassung)

**Prinzip:** Die KI schlägt vor — der Code entscheidet. Alle Sicherheitsgrenzen liegen außerhalb der Agentenlogik, in kompiliertem Code.

**Schichten:**

1. **Engine-Validierung** — Rolle darf handeln? Kill-Switch aus? Kurs vorhanden?
2. **Guardrails** (`riskGuard.ts`) — max. 25% Position, Stop-Loss Pflicht, kein Short ohne Flag
3. **Kill-Switch** — globaler Circuit-Breaker, DB-persistent, Disarm stärker als Arm (ADMIN + Nonce + CSRF)
4. **Broker-Schleuse** — prüft alles nochmal, unabhängig von Schicht 2+3
5. **Auth & RBAC** — `AUTH_MODE=local-open | token-required`, `FIRM_ADMIN_TOKEN`, `FIRM_API_TOKEN`, `FIRM_VIEWER_TOKEN`, Permissions `firm.read`, `strategy.rules.*`, `live.gate`, `broker.credentials`
6. **Rate-Limit-Identität** — `src/lib/clientIp.ts` als einzige Quelle, `TRUSTED_PROXY_IPS` + `x-verified-ip`, `x-forwarded-for` nur hinter verifiziertem Proxy, globaler Deckel + exponentieller Backoff

## Dokumente

| Dokument | Zweck |
|----------|-------|
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | Security-Audit 2026-08-25 (v1.4.0) — Findings, Fixes, Peer-Review |
| [../audits/README.md](../audits/README.md) | Zentrale Audit-Verwaltung — alle Audits chronologisch |
| [../audits/2026-09-03-peer-review/](../audits/2026-09-03-peer-review/) | Peer-Review-Audit Sep 2026 — H1-H10, C1-C4, B1-B2, S1-S2, W1-W2 (CLOSED) |
| [../audits/2026-09-05-security-review-gpt01/](../audits/2026-09-05-security-review-gpt01/) | Security-Audit GPT_01 — SEC-01 FIXED v1.36.27; SEC-02 FIXED v1.36.31; SEC-03 FIXED v1.36.28; SEC-10 FIXED v1.36.29; SEC-04 FIXED v1.36.30; SEC-05 FIXED v1.36.33 (ergänzt v1.36.34); SEC-06 FIXED v1.36.34; SEC-07 FIXED v1.36.32; SEC-08 FIXED v1.36.35; SEC-09 FIXED v1.36.36 |
| [../audits/2026-09-08-arena-prompts/](../audits/2026-09-08-arena-prompts/) | Arena-Review-Serie (Prompts) — RESTORE-01: Restore des Firmenzustands pro Aufrufer (MEDIUM, Verfügbarkeit) | RESTORE-01 FIXED v1.36.37 (Closed) |
| [../audits/2026-10-27-arch-security-audit/](../audits/2026-10-27-arch-security-audit/) | Architektur-, Security-, Performance- & Code-Qualitäts-Audit (`v0.17.2`) — 15 Findings (`ASA-01`…`ASA-07` FIXED; `ASA-08`…`ASA-15`: 2 HIGH, 4 MEDIUM, 2 LOW `OPEN`) + 10 Remediation-Prompts |

## Critical/High Findings (aggregierter Status)

> Quelle: `docs/audits/*/remediation/TRACKING.md` — hier nur aggregierte Sicht, Details in jeweiligen Audit-Ordnern.

Im [Architektur- & Security-Audit 2026-10-27](../audits/2026-10-27-arch-security-audit/README.md) sind derzeit **0 CRITICAL- und 0 HIGH-Findings** als `OPEN` erfasst (6 offene Befunde: 4 `MEDIUM`, 2 `LOW`) und in [10 kopierfertigen Remediation-Prompts](../audits/2026-10-27-arch-security-audit/prompts/README.md) zur Abarbeitung vorbereitet ([Tracking](../audits/2026-10-27-arch-security-audit/remediation/TRACKING.md)). **`ASA-01` ist FIXED:** [Multi-Prozess-Split-Brain für Kill-Switch, `PaperBroker` und `realizedPnl`](../audits/2026-10-27-arch-security-audit/findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md) (`src/lib/killSwitchDb.ts`, `src/lib/brokerHydration.ts`, `src/lib/monitor.ts`). **`ASA-02` ist FIXED:** [Rollen-Spoofing, Vier-Augen-Bypass & Live-Kill-AuthZ](../audits/2026-10-27-arch-security-audit/findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) — `resolveAuth().principal` als einzige Rollen-/Identitätsquelle, kryptographisches 2-Principal-Vier-Augen-Verfahren mit 15-Minuten-TTL (`local-open` fail-closed), `firm.kill` für `arm` sowie Admin + CSRF + Einmal-Nonce für `clear` (`GET /api/live/kill`). Regression: `tests/asa02.lifecycleAndLiveKillAuthz.test.ts`. **`ASA-03` ist FIXED:** `fetchPositionsStrict()` verhindert Fail-Open-Positionsabfragen, der Notfall-Close sendet `DELETE /v2/positions?cancel_orders=true` bedingungslos und `verifyFlat()` propagiert Fehler; `Retry-After` und `client_order_id`-Retry-Idempotenz sind gehärtet. Regression: `tests/asa03.alpacaFailClosed.test.ts`. **`ASA-04` ist FIXED:** Cooldown-/Tageszähler-Synchronisierung, prozesslokaler Burst-Lock, dynamisches Feed-Abonnement und korrekte Audit-Version; Details und Betriebsgrenzen im [Finding](../audits/2026-10-27-arch-security-audit/findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md). Regression: `tests/asa04.microExecutorConcurrency.test.ts`. Alle früheren Critical/High-Findings aus September/Oktober 2026 (`SEC-01`…`SEC-10`, `DC-01`, `DC-02`) bleiben behoben. **`ASA-05` und `ASA-07` sind FIXED (v0.17.3):** Route-weites RBAC, passende Permissions inkl. `firm.config`/`broker.test`, private no-store Reads, zentrale Session-CSRF-/Write-Rate-Limits, Logout-Härtung und 5xx-Redaction. Regression: `tests/asa05.apiGuardsAndCsrf.test.ts` + `tests/sec02.unauthenticatedGetApis.test.ts`. **`ASA-06` ist FIXED:** [`/api/portfolio/*`-DoS & `LiveGateAudit`-Kettensplit](../audits/2026-10-27-arch-security-audit/findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md) — `firm.read`/`firm.write` + CSRF + Rate-Limit auf allen drei Portfolio-Endpunkten, `maxIterations` ≤ 2.000 (Default 400) und `maxAdjustmentRounds` ≤ 10 mit `400` bei Überschreitung, asynchrone Audit-Datei-Senke (`node:fs/promises`, atomarer Snapshot) sowie eine Lock-Datei-gestützte `LiveGateAudit.append()`-Synchronisation über Prozesse mit `(size, mtimeMs, ctimeMs, ino)`-Cache für `verifyAuditChain()`. Regression: `tests/asa06.portfolioLimitsAndAuditSync.test.ts`.
**`ASA-09` ist FIXED (v0.17.5):** [`HistoricalStore`-Voll-Scan, UTF-8-Chunk-Split & Lost Updates](../audits/2026-10-27-arch-security-audit/findings/ASA-09-historical-store-oom-utf8-lost-update.md) — Kerzen liegen partitioniert pro `(instrumentId, timeframe)` unter `data/history/series/<encodedKey>.ndjson` (bijektive, Path-Traversal-freie Percent-Kodierung; `instrumentId` wird nie roh in Pfade interpoliert), `query()` liest nur noch die eine Serie-Datei, der Zeilenleser dekodiert UTF-8-verlustfrei über `StringDecoder`, das Schreiben läuft gebündelt in 64-KiB-Puffern mit `fsync`+`rename` und kollisionsfreien Temp-Namen, und alle mutierenden Operationen samt der verlustfreien Auto-Migration bestehender `candles.ndjson`-Bestände (Backup `candles.ndjson.migrated-*`) stehen unter der Cross-Prozess-Dateisperre `.store.lock`. Regression: `tests/asa09.historicalStoreSafety.test.ts`.
**SEC-02 ist seit v1.36.31 FIXED:** [sensible Dashboard-Reads](../audits/2026-09-05-security-review-gpt01/findings/SEC-02-unauthenticated-get-apis.md) verlangen `firm.read` und werden `private, no-store` ausgeliefert.

**SEC-01 ist seit v1.36.27 FIXED:** [Session-Autorisierung](../audits/2026-09-05-security-review-gpt01/findings/SEC-01-privilege-escalation.md).
Upgrade einschließlich unabhängigem `FIRM_SESSION_SECRET`, Neustart aller Instanzen
und erneutem Login erforderlich. Andere offene Findings bleiben unverändert relevant.

**SEC-03 ist seit v1.36.28 FIXED:** [Framework-/Decoder-Update](../audits/2026-09-05-security-review-gpt01/findings/SEC-03-vulnerable-next.md).
Alle Linux-/Windows-Instanzen aus dem neuen Lockfile installieren und frisch ausrollen.

**SEC-04 ist seit v1.36.30 FIXED:** [ws-Pin und WS-Härtung](../audits/2026-09-05-security-review-gpt01/findings/SEC-04-vulnerable-ws.md).

**SEC-05 ist seit v1.36.33 FIXED, in v1.36.34 ergänzt:** [Rule-Audit-Attribution serverseitig](../audits/2026-09-05-security-review-gpt01/findings/SEC-05-rule-actor-attribution.md) — der Akteur stammt aus dem authentifizierten Credential, die API-Herkunft ist serverseitig `MANUAL`. Auch `RULE_CREATED` trägt jetzt den verifizierten Ersteller. Client-gelieferte Attributionsfelder werden mit 400 abgelehnt.

**SEC-06 ist seit v1.36.34 FIXED:** [Rule-Lifecycle-Autorisierung](../audits/2026-09-05-security-review-gpt01/findings/SEC-06-rule-lifecycle-authz.md) — eigene Permissions für operative Pflege und administrative Governance.

**SEC-07 ist seit v1.36.32 FIXED:** [Env-Credential-Fallback nur explizit Dev/Test](../audits/2026-09-05-security-review-gpt01/findings/SEC-07-env-credential-fallback.md) — in Produktion kein stiller Fallback auf `BITUNIX_API_KEY`/`ALPACA_API_KEY` mehr; fehlender Datensatz = null, Store-Fehler = HARD FAIL. Env nur mit `BROKER_ALLOW_ENV_FALLBACK=true` und `NODE_ENV!=production`.
Alle Instanzen mit `npm ci` neu installieren und sämtliche Prozesse neu starten.

**SEC-08 ist seit v1.36.35 FIXED:** [sofortige Session-Revocation & Logout](../audits/2026-09-05-security-review-gpt01/findings/SEC-08-session-revocation.md) — serverseitige Revocation-Registry, `POST /api/auth/logout` und globale Epochen-Invalidierung (Details unten, Abschnitt Session-Cookie & Revocation).

**SEC-09 ist seit v1.36.36 FIXED:** [Secret-Memory-Hygiene](../audits/2026-09-05-security-review-gpt01/findings/SEC-09-secret-memory-hygiene.md) — ehrliche JS-String-Grenze (`zeroize()` deckt Krypto-/Key-Buffer ab, keine Strings), Referenz-Verwurf nach der Probe und betriebliche Dump-Härtung (Details unten, Abschnitt Secret-Memory-Hygiene).

Alle Findings aus 2026-09-03 sind FIXED (siehe [dort](../audits/2026-09-03-peer-review/remediation/SUMMARY.md)).

## Rule-Governance (SEC-06)

**v1.36.34; betroffen bis einschließlich v1.36.33.** Die Rule-APIs verwenden die
zentrale RBAC-Auflösung für `POST /api/firm/rules` und
`POST /api/firm/rules/[id]`, nicht den Legacy-`guardWrite`. Alle Prüfungen erfolgen
vor Rule-Lookups, Upserts und Lifecycle-Mutationen; eine abgewiesene Freigabe
hinterlässt insbesondere keinen neuen Draft.

| Aktion | Permission | Viewer | Operator | Admin |
|--------|------------|--------|----------|-------|
| Regeln lesen | `firm.read` | ja | ja | ja |
| Draft anlegen/versionieren, ACTIVE pausieren, DRAFT ablehnen | `strategy.rules.write` | nein | ja | ja |
| Aktivieren (auch direkt beim Anlegen) | `strategy.rules.activate` | nein | nein | ja |
| Rollback | `strategy.rules.rollback` | nein | nein | ja |
| Archivieren | `strategy.rules.archive` | nein | nein | ja |
| Makro-Zyklus manuell starten | `strategy.rules.activate` | nein | nein | ja |

**Schreibpfade mit Guard (Stand 2026-10-06):** `POST /api/firm/proposals/[id]/approve`
verlangt `firm.write` **und** den CSRF-Header `x-csrf-token` — der Guard läuft
vor jedem DB-Zugriff (DC-01, `tests/proposalApprove.auth.test.ts`). Der
aufgelöste Actor steht zusätzlich als `authenticatedActor` in beiden
Audit-Stufen und in der Antwort.

Diese beiden Rule-Endpunkte verlangen zusätzlich zur jeweiligen Freigabe
`strategy.rules.write`. Die Rollenmatrix gewährt dies jedem Admin. `reject`
betrifft ausschließlich DRAFTs, `pause` ausschließlich ACTIVE-Regeln; bisherige
Statuskonflikte bleiben HTTP 409. Unbekannte Aktionen und ungültige JSON-Formate
werden ohne Datenzugriff mit 400 abgewiesen; Regel-Spezifikationen werden weiter
per Whitelist geprüft (422 bei inhaltlichen Fehlern). `activate` ist optional,
aber falls angegeben zwingend ein Boolean. Das Schreib-Rate-Limit bleibt aktiv
(429 mit `Retry-After`).

### Credentials und Betriebsmodi

- Header (`x-admin-token`, `x-firm-token`, `x-viewer-token`), Bearer und signierte
  `firm_session` verwenden dieselben aktuellen serverseitigen Rechte. Ein
  Admin-Token funktioniert auch als `x-firm-token`, selbst wenn ein separater
  Operator-Token konfiguriert ist. Fehlende Rechte: 403 `FORBIDDEN`; fehlende oder
  ungültige Authentifizierung gemäß zentralem RBAC 401, mit konfiguriertem
  Admin-Token 403.
- **Multi-Role benötigt verschiedene Admin-/Operator-Credentials.** Ohne
  `FIRM_ADMIN_TOKEN` erbt der Operator unverändert die effektive Admin-Rolle
  (Single-Admin-Kompatibilität). `local-open` ist ein bewusster lokaler
  Admin-Modus, niemals eine Rollentrennung; ohne Credentials bleibt
  `token-required` geschlossen.
- Der **manuelle** Makro-Start ist immer administrativ, auch wenn gerade
  `REQUIRE_HUMAN_APPROVAL=true` gesetzt ist. Der interne Scheduler bleibt ein
  vertrauenswürdiger Systemakteur und respektiert die bestehende serverseitige
  Approval-Policy. Wer jede automatische Aktivierung verhindern will, setzt
  `REQUIRE_HUMAN_APPROVAL=true`; die neue RBAC-Matrix ersetzt diese Policy nicht.

### Audit-Attribution (SEC-05-Nachprüfung)

`by`, `actor` und `sourceRole` sind weder auf Top-Level noch in `rule` zulässige
Attributionsfelder der Rule-Requests (400 `ACTOR_NOT_CLIENT_CONTROLLED`).
API-Spezifikationen haben immer `sourceRole=MANUAL` und `sourceMode=MANUAL`.
Erstellung und Lifecycle-Aktionen tragen den serverseitig verifizierten Akteur;
interne Erzeuger nennen explizit ihren Systemakteur. Fehlende Authentifizierung
wird niemals als Admin-Attribution interpretiert. Die Audit-Anzeige zeigt den
Ersteller getrennt von der Herkunftsrolle. Vorhandene historische Einträge
werden nicht nachträglich umgeschrieben.

### Upgrade und Prüfung

Mit `npm ci` installieren, `npm run build` ausführen und alle App-Instanzen neu
starten. Keine neue Abhängigkeit oder Schema-Migration. Eigene Integrationen
müssen für administrative Regelaktionen und den manuellen Makro-Start ein
Admin-Credential verwenden; normale Draft-Pflege bleibt Operator-tauglich.

`npm run test:security:auth` prüft SEC-05/SEC-06 verbindlich in CI: Rollenmatrix,
Header/Bearer/Sessions, fehlende Rechte ohne Datenzugriff, gültige Mutationen
mit Audit, ungültige Eingaben, Rate-Limit und Single-Admin-Kompatibilität.

## Sensible Dashboard-Read-APIs (SEC-02)

**v1.36.31:** Die folgenden Read-Endpunkte sind nicht öffentlich: `/api/firm`,
`/api/firm/log`, `/api/firm/report`, `/api/firm/rules`, `/api/providers` und
`/api/routing`. Sie prüfen vor jeder Datenbank-, Router- oder Providerarbeit die
bestehende Permission `firm.read`.

**Nachtrag (v0.13.0):** `GET /api/firm/equity` (Equity-Kurve inkl.
Drawdown-Kennzahlen und Trade-Markern) gehört derselben Klasse an und prüft
`firm.read` ebenfalls **vor** dem ersten DB-Zugriff; die Antwort ist
`private, no-store`. Die Kurve war zuvor ohne Autorisierung lesbar — Portfolio-
und P&L-Daten sind aber genauso sensibel wie der Report.

### Berechtigung und Browser-Kompatibilität

- **Viewer, Operator und Admin** besitzen `firm.read`; ein vorhandenes Header-
  Credential oder die gültige signierte `firm_session` genügt.
- Das Dashboard verwendet weiterhin seine HttpOnly-Session im Same-Origin-
  Kontext. Es muss und darf keinen Token im Browser speichern.
- In `token-required` erhalten nicht authentifizierte Requests eine
  Autorisierungsablehnung. `AUTH_MODE=local-open` bleibt ausschließlich ein
  bewusster lokaler Single-User-Modus; Netzwerkzugriff darauf muss unabhängig
  begrenzt werden.
- Erfolgreiche Antworten senden `Cache-Control: private, no-store`; ein
  geteiltes Proxy-/Browser-Cache darf sie daher nicht für einen anderen Aufrufer
  wiederverwenden.

### Ausrollen und Prüfen

1. Geprüften Release **v1.36.31 oder neuer** auf **allen** App-Instanzen
   ausrollen und die Prozesse neu starten. Keine Datenmigration und keine neue
   Umgebungsvariable sind erforderlich.
2. Direkte CLI-/Integrationsclients für die sechs Endpunkte mit einem bestehenden
   Viewer-, Operator- oder Admin-Credential konfigurieren. Browser-Nutzer melden
   sich wie bisher über `/api/auth/login` an.
3. Vor der Freigabe ausführen:

   ```bash
   npm ci
   npm run test:security:auth
   npm run typecheck
   npm run lint
   npm run build
   ```

   Der Security-Test enthält die SEC-02-Regressionen für anonyme und
   manipulierte Anfragen, Viewer-Credentials und Browser-Sessions. Ein Upgrade
   schützt nur Instanzen, die den neuen Build tatsächlich ausführen.

## Next.js-Upgrade (SEC-03)

**v1.36.28:** Next.js ist exakt gepinnt; der damalige Mindestfix der Advisories war
16.3.4, nach den Folge-Advisories vom 2026-10-27 liegt der Gate-Floor bei **16.4.1**
und **aktuell im Lockfile: 16.4.3** (`package.json`, Stand 2026-10-27). Das Release
nutzt die gepatchte AVIF-/SVG-Bildverarbeitung mit **sharp 0.35.5**, passenden
libvips-Paketen **1.3.4** (Floor 1.3.3) sowie **libheif 1.23.2**. Die gesamte Kette
ist relevant, nicht allein die Versionsnummer von Next.js. v1.36.27 lieferte
Next.js 16.3.1 aus.

### Ausrollen

1. Geprüften Release **v1.36.28 oder neuer** in einem frischen Release-Verzeichnis
   vorbereiten. Keine alten `.next`-Builds oder Image-/ISR-Caches übernehmen.
   `.env`, Datenbank und fachliche persistente Daten erhalten, nicht löschen.
2. Mit Node 22 (wie CI) installieren und prüfen:

   ```bash
   npm ci
   npm run test:security:next
   npm audit
   npm run build
   ```

   **Jeder Schritt muss erfolgreich sein; bei Fehlern nicht deployen.**
   `test:security:next` funktioniert auch in PowerShell. Auth-/Live-Gate-Suite,
   Typecheck, Lint, Doku-Validierung und Produktions-Build werden zusätzlich durch
   GitHub Actions geprüft. Ein grünes `npm audit` allein ersetzt das Gate nicht.
3. Erst danach auf den neuen Build umschalten und **sämtliche App-Prozesse neu
   starten**. Alte Instanzen aus dem Load-Balancer nehmen; kein gemischter
   Alt-/Neubetrieb. Auch Windows, Linux und Installationen ohne Image-UI upgraden.
4. Health-/Versionsanzeige gegen `package.json` prüfen. Nicht auf einen bekannten
   verwundbaren Release zurückrollen. SEC-01-Session-Konfiguration bleibt Pflicht.

### Wartung und Grenzen

- Das Gate prüft exakten stabilen Pin, Root-/Lockfile-Konsistenz, alle relevanten
  nativen Plattformpakete, die tatsächlich von Next aufgelöste Installation und
  die geladene libheif-Version. Alte/fehlende Libraries oder Lockfile-Drift lassen
  die Prüfung fehlschlagen, auch bei eigenen/globalen libvips-Builds.
- Dependency-Updates immer inklusive Lockfile reviewen, mit `npm ci` installieren
  und auf beiden CI-Plattformen prüfen. Kein automatisches `next@latest` ohne
  Review und keine Overrides auf ältere Decoder. Der Versions-Floor ist ein
  gezielter SEC-03-Regressionsschutz, keine Garantie gegen künftige Advisories.
- `security-live-gate` verlangt die Windows-Regression und führt dieselbe Suite
  unter Linux aus; ein fehlgeschlagener Windows-Lauf verhindert den grünen
  Required Check und den Security-Suite-Stamp.
- Bei Verdacht auf bereits erfolgte Kompromittierung Instanz isolieren, aus
  vertrauenswürdigem Release neu aufbauen und erreichbare Credentials rotieren.
  Ein Dependency-Update beseitigt keinen bereits erfolgten Einbruch.

## ws-Upgrade (SEC-04)

**v1.36.30:** Die WebSocket-Bibliothek `ws` ist exakt auf **8.21.3** gepinnt
(Mindestfix der Advisories: **8.21.0**). Bis v1.36.29 stand im Manifest die Range
`^8.18.0` — sie ließ jederzeit eine verwundbare Installation zu, unabhängig davon,
was gerade im Lockfile stand. `ws` ist die einzige Bibliothek, die im Betrieb eine
dauerhafte Verbindung zu einem externen Netzwerk-Peer hält (Bitunix-Public-WS).

### Was der Fix umfasst

- Exakter Pin in `package.json` plus npm-`overrides`: Auch jede transitive oder
  verschachtelte `ws`-Kopie wird auf die geprüfte Version gezwungen.
- **Fail-closed-Guard:** Der Bitunix-WS-Client liest vor jedem Verbindungsaufbau
  die Version des tatsächlich installierten `ws`-Pakets. Ist sie älter als der
  Floor oder nicht eindeutig lesbar, entsteht kein Socket, sondern der Fehler
  `BITUNIX_DISABLED`. Ein Downgrade am Deployment fällt damit sofort auf.
- **Ressourcen-Kappen:** 1 MiB Obergrenze je Nachricht (inklusive aller Fragmente),
  keine Nachrichten-Kompression, verpflichtende UTF-8-Validierung, keine Redirects
  (die SSRF-Host-Allowlist bleibt wirksam), begrenzter Handshake.

### Ausrollen

1. Geprüften Release **v1.36.30 oder neuer** in einem frischen Release-Verzeichnis
   vorbereiten. `.env`, Datenbank und persistente Daten bleiben unverändert.
2. Mit Node 22 (wie CI) installieren und prüfen:

   ```bash
   npm ci
   npm ls ws --all
   npm run test:security:ws
   npm audit
   ```

   **Jeder Schritt muss erfolgreich sein; bei Fehlern nicht deployen.** `npm ci`
   ist Pflicht — ein `npm install` auf einem alten Lockfile kann eine
   verwundbare Version stehen lassen.
3. Danach neu bauen und **alle** App-Prozesse neu starten. Ein laufender Prozess
   behält die alte Bibliothek im Speicher; ein Dateiaustausch allein wirkt nicht.
4. Version gegen `package.json` prüfen und nicht auf einen älteren Release
   zurückrollen.

### Wartung und Grenzen

- Der Versions-Floor steht als eine Konstante in `src/brokers/bitunix/ws.ts` und
  wird von Laufzeit-Guard und Dependency-Gate gemeinsam benutzt. Beim Anheben des
  Pins darf er mitwachsen, nie sinken.
- `npm ls ws --all` und `npm run test:security:ws` laufen verbindlich im Job
  `security-live-gate` und zusätzlich verkettet vor der Live-Gate-Suite.
- Ein grünes `npm audit` allein ist kein Nachweis: Es kennt nur veröffentlichte
  Advisories. Der Pin ist ein gezielter SEC-04-Regressionsschutz, keine Garantie
  gegen künftige Schwachstellen.
- Die Kappen schützen den eigenen Prozess vor einem böswilligen oder
  übernommenen Endpunkt; sie ersetzen kein Update der Bibliothek.

## Dependency-Floors (Nachträge 2026-10-06 & 2026-10-27)

**Anhebung ohne eigene Finding-Nummer**, ausgelöst durch neue Upstream-Advisories,
die den fail-closed Schritt `npm audit --audit-level=high --omit=dev` im Workflow
`security-live-gate` rot werden ließen:

| Paket | Vorher | Jetzt | Advisory | Weg |
|-------|--------|-------|----------|-----|
| `sharp` (optionalDependency von `next`) | 0.35.4 | **0.35.5** | GHSA-wq5f-xc86-pv6w / CVE-2026-96889 (librsvg über den AVIF-Pfad) | `overrides` in `package.json` (2026-10-06) |
| `source-map-js` (transitiv über `postcss`/`next`) | 1.2.1 | **1.2.2** | GHSA-68fv-2mgg-jv7q (Event-Loop-DoS über indizierte Source-Map-Sektionen) | `overrides` in `package.json` (2026-10-06) |
| `next` & `eslint-config-next` | 16.3.8 | **16.4.3** (Floor **16.4.1**) | GHSA-2464-fhr4-w9xw (Image Optimization SVG RCE), GHSA-p3m5-59mp-jv5r (Server Actions DoS), GHSA-673q-mjm6-r5xr (`use cache` TypedArray RCE) | Exakter Pin in `package.json` + Lockfile-Update (2026-10-27) |

- Der SEC-03-Gate-Floor in `tests/sec03.nextDependencies.test.ts` wurde auf
  `next >= 16.4.1`, `sharp >= 0.35.5` **und** `source-map-js >= 1.2.2` angehoben — gleiches Prinzip
  wie SEC-04: Der Gate-Floor darf nie weicher sein als das Advisory. Die
  `@img/sharp-libvips-*`-Binaries liegen mit dem Sprung bei 1.3.4 (Floor 1.3.3).
- **Konsistenz-Detail:** Parallel zum Override wurde der Install-Script-Eintrag in
  `allowScripts` (`package.json`) von `sharp@0.35.4` auf `sharp@0.35.5` gehoben —
  er zeigte sonst auf eine Version, die im Lockfile nicht mehr vorkommt. Kein
  Skript bzw. Test wertet das Feld aus (Stand 2026-10-06), es ist damit aber
  wieder deckungsgleich mit der installierten Version.
- **Bekannt und bewusst offen (nicht blockierend, `--audit-level=high`):**
  `postcss-selector-parser < 7.1.6` (moderat; `@tailwindcss/typography@0.5.20`
  pinnt exakt `6.0.10`, der Fix wäre ein Major-Sprung und würde den CSS-Pfad
  riskanter machen als das Advisory) und `braces` (hoch, **ohne verfügbare
  Fix-Version**, nur im Dev-Lint-Pfad `eslint-config-next → @next/eslint-plugin-next
  → fast-glob → micromatch`). Beide werden erneut geprüft, sobald der jeweilige
  Upstream ein Update veröffentlicht; `npm audit fix --force` schlägt für beide
  einen **Downgrade** vor und ist deshalb keine Option.

## Auth-Modus (v1.36.13+)

- `NODE_ENV=production` ohne Token ⇒ Boot-Verweigerung `AUTH_NOT_CONFIGURED` (kein offener Zugang)
- Produktion mit Tokens benötigt zusätzlich einen unabhängigen Session-Key:
  `SESSION_SECRET_REQUIRED` / `SESSION_SECRET_INVALID` verweigert den Boot (SEC-01).
- `AUTH_MODE=local-open` — bewusster Opt-in für Single-User ohne Token (Dev-Default)
- `AUTH_MODE=token-required` — erzwingt Credential auch in Dev
- Sensible Dashboard-Reads in SEC-02 verlangen zusätzlich `firm.read`; die
  Permission wird nach Header-/Session-Authentifizierung serverseitig bestimmt.
- Wirksamer Modus: `curl -s localhost:3369/api/auth/me | jq .authMode`

**ASA-08 ist FIXED (v0.17.4):** Fetch-Proxy-IPs verlangen zusätzlich ein
konstantzeitlich geprüftes `TRUSTED_PROXY_SECRET` / `X-Proxy-Secret`; Socket-CIDRs
bleiben maßgeblich. Produktion/systemd binden Loopback, CLI und Instrumentation
verweigern CIDR-only-Starts. Regressionen und Upgrade:
[Finding](../audits/2026-10-27-arch-security-audit/findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md),
[Konfiguration](../../CONFIGURATION.md#rate-limit-identität-trusted_proxy_ips-c2-v13614).
`npm run test:security:asa08` ist Bestandteil von `security:live-gate`.

## Rate-Limit-Identität (v1.36.14+, gehärtet v0.17.4 / ASA-08)

- `x-forwarded-for` nur wenn `TRUSTED_PROXY_IPS` konfiguriert und Socket-Peer darin liegt (rightmost-untrusted)
- `x-verified-ip` — Proxy muss ihn überschreiben; ohne Socket nur mit gültigem `TRUSTED_PROXY_SECRET` + passendem `x-proxy-secret`, niemals allein wegen CIDRs oder `HOSTNAME`
- `x-real-ip` nie als Identität
- Credential-Brute-Force: 5/min pro Identität + 20/min global + exponentieller Backoff ab 3. Fehlversuch

## Kill-Switch (v1.36.15+)

- **Arm** (`POST /api/firm/kill {arm:true}`) — Operator (`guardWrite`)
- **Disarm** (`{arm:false, nonce}`) — ADMIN (`live.gate`) + CSRF + single-use Nonce (≤60s) aus `GET /api/firm/kill/challenge`

## Audit-Trail (v1.36.18+)

- Zwei Klassen in `src/lib/auditSink.ts`: `security` (Retry + Spool `data/audit-spool/`) und `telemetry` (best-effort)
- Fail-closed wo Mutation vermeidbar: Credential-Store, Kill-Switch-Disarm, Proposal-Freigabe ohne durablen Beleg ⇒ 503
- Lücken sichtbar: CRITICAL im Journal, `audit_missed_total` Metrik, `/api/health → audit`

## Session-Cookie & Revocation (v1.36.27 / v1.36.35, SEC-01 / SEC-08)

- `firmToken` nicht mehr in `localStorage` — stattdessen `firm_session` HttpOnly, Secure, SameSite=Strict + `firm_csrf`
  Double-Submit. Seit **v1.39.0 ohne `Max-Age`** (Browser-Session-Cookie, endet
  mit dem Fenster-Schließen): autorisiert wird über `exp` (Idle, Default 900 s)
  und `maxExp` (absolut, Default 86 400 s, hart bei 7 d) im signierten Payload —
  nie über das Cookie-Alter. Verlängern ausschließlich über
  `POST /api/auth/refresh` mit Double-Submit-Header `x-csrf-token` (der
  API-Token allein verlängert nichts); `iat`/`maxExp` bleiben dabei fix, der
  globale Notfallschnitt wirkt weiter. `FIRM_SESSION_GRACE_S` heilt eine
  abgelaufene Idle-Frist **nur** dort — `readSession()` und jede Guard-Route
  bleiben bei `exp` hart. `GET /api/auth/status` meldet secret-frei, ob Firm-
  Tokens eingetragen sind und wie lange die eigene Sitzung läuft
- Stateless HMAC-Session in `src/lib/authSession.ts`, ausschließlich mit unabhängigem
  `FIRM_SESSION_SECRET` (mindestens 32 Zeichen; separat `openssl rand -hex 32`).
  Kein Login-Token/Token-Hash, kein Fallback. Ohne gültigen Schlüssel Login HTTP 503,
  auch in Dev; `local-open` stellt keine Sessions aus.
- Schema v3 (`SESSION_PAYLOAD_VERSION = 3`) ohne Berechtigungs-Snapshot, dafür mit
  `iat` (Anmeldung), `exp` (Idle) und `maxExp` (absolute Grenze); v2 wird nicht mehr
  akzeptiert — nach dem Upgrade ist einmalige Neu-Anmeldung nötig.
  Serverseitige Rollen-/Permission-Ableitung
  pro Request, Credential-Bindung via keyed `authEpoch`. Rotation, Entfernung oder
  Neueinrichtung eines Tokens invalidiert alle bisherigen Sessions, sobald die neue
  Konfiguration im Prozess aktiv ist. Alle Instanzen konsistent neu starten.
- **Sofortige Session-Revocation & Logout (SEC-08, v1.36.35):** Serverseitige
  Revocation-Registry (`state.revokedSessions`) und Logout-Endpunkt (`POST /api/auth/logout`).
  Sessions werden bei Logout oder gezielter Revocation sofort für ungültig erklärt.
  Admins können via `{"all": true}` eine globale Epochen-Revocation auslösen.
- **Deterministischer Epochen-Schnitt:** Der globale Cutoff ist streng monoton und neue
  Sessions werden strikt nach ihm datiert (`iat > cutoff`). Logins in derselben Millisekunde
  wie der Cut bleiben gültig, Altsessions sind sofort tot; ein rückwärts springender Takt
  hebt keinen Cut auf (kein Fail-Open) und sperrt keine Neuanmeldung aus.
  Abgelaufene Einträge werden automatisch bereinigt (`pruneRevokedSessions`).
- Tests: `npm run test:security:auth`; automatisch Teil von `security:live-gate`.
- [Konfiguration und Upgrade](../../CONFIGURATION.md#session-sicherheit-sec-01-v13627).

## Secret-Memory-Hygiene (SEC-09)

**v1.36.36; betroffen bis einschließlich v1.36.35.** Der Secret-Store der
Broker Control Plane (`src/brokers/control-plane/secretStore.ts`) behauptete,
es entstünden „keine langlebigen Strings“. Das war falsch: Der Parse-Pfad
(`Buffer.toString` → `JSON.parse` → `CredentialPayload`) erzeugt
unveränderliche JS-Strings im Heap, die nicht deterministisch gelöscht werden
können. `zeroize()` deckt ausschließlich Krypto-/Key-Buffer (IV, Tag,
Ciphertext, Key, Plaintext-Buffer) ab — niemals Strings. Es gibt keinen
Remote-Angriffspfad; relevant sind Heap-Dumps, Crash-/Core-Dumps, Debugging,
Process Compromise und forensischer Speicherzugriff.

### Was seit v1.36.36 gilt

- **Ehrliche Grenze im Code:** Alle Kommentare und die Control-Plane-Doku
  ([Memory-Hygiene](../FRONTEND_CONTROL_PLANE.md)) sagen klar, dass
  entschlüsselte Credentials transient als JS-Strings existieren.
- **Referenz-Verwurf statt Placebo:** `disposeCredential()` überschreibt die
  Credential-Felder mit `""`, damit der GC die Originale früh einsammelt —
  und erzeugt bewusst keine zusätzlichen Secret-Kopien mehr.
- **Kurzlebigkeit:** `get()` liefert je Aufruf eine frische Kopie, die nur
  für die read-only Probe gehalten wird. Credentials werden nie gecacht,
  geloggt, persistiert oder an das Frontend gegeben.

### Betriebliche Pflichtmaßnahmen (Produktion)

- **Kein Inspector:** Node nie mit `--inspect`/`--inspect-brk`/`--inspect-port`
  starten; Port 9229 weder öffnen noch publishen. Debug-Zugang nur auf
  isolierten Dev-Hosts ohne echte Credentials.
- **Keine Heap-Snapshots:** `--heap-prof`/`--cpu-prof` aus lassen, keine
  `v8.getHeapSnapshot`-Pfade und keine Diagnose-Endpoints in Produktion.
- **Core-Dumps deaktivieren:** `ulimit -c 0` für den App-Prozess (systemd:
  `LimitCORE=0`); kein Core-Sammeln (apport/systemd-coredump) auf App-Hosts.
  Swap/Hibernation-Files auf Secret-Hosts vermeiden oder verschlüsseln.
- **Least Privilege:** Kein `CAP_SYS_PTRACE`, kein lesender Zugriff auf
  `/proc/<pid>/mem` außer für root; Dumps/Artefakte aus Staging mit echten
  Secrets wie Credentials behandeln.
- **Bei Dump-Verdacht:** Betroffene Venue-Credentials rotieren (neu speichern
  oder löschen + neu anlegen), Prozesse neu starten, Dump-Artefakt sicher
  löschen.

### Ausrollen und Prüfen

Geprüften Release **v1.36.36 oder neuer** ausrollen und alle Prozesse neu
starten. Keine Datenmigration, keine neue Umgebungsvariable. Regressionen in
`tests/sec09.secretMemoryHygiene.test.ts` (8 Fälle: Referenz-Verwurf,
Buffer-Hygiene, kein Credential-Caching, Docs-as-Code-Scan der
Nullungs-Versprechen, Betriebs-Hinweise) laufen im vollen `npm test`.

## Verwandte Dokumente

- [ARCHITECTURE.md](../ARCHITECTURE.md) — Security-Kapitel
- [FRONTEND_CONTROL_PLANE.md](../FRONTEND_CONTROL_PLANE.md) — Control Plane Auth
- [LIVE_TRADING.md](../LIVE_TRADING.md) — Live-Gate + Kill-Switch
- [CONFIGURATION.md](../../CONFIGURATION.md) — Env-Flags inkl. `AUTH_MODE`, `TRUSTED_PROXY_IPS`
