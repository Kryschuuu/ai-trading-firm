# Security — Übersicht & Härtung

> **Zweck:** Zentrale Anlaufstelle für Security-Themen — aggregiert offene Critical/High Findings aus allen Audits, beschreibt Security-Modell, Auth, RBAC, Rate-Limiting und Härtungsmaßnahmen.

## Security-Modell (Kurzfassung)

**Prinzip:** Die KI schlägt vor — der Code entscheidet. Alle Sicherheitsgrenzen liegen außerhalb der Agentenlogik, in kompiliertem Code.

**Schichten:**

1. **Engine-Validierung** — Rolle darf handeln? Kill-Switch aus? Kurs vorhanden?
2. **Guardrails** (`riskGuard.ts`) — max. 25% Position, Stop-Loss Pflicht, kein Short ohne Flag
3. **Kill-Switch** — globaler Circuit-Breaker, DB-persistent, Disarm stärker als Arm (ADMIN + Nonce + CSRF)
4. **Broker-Schleuse** — prüft alles nochmal, unabhängig von Schicht 2+3
5. **Auth & RBAC** — `AUTH_MODE=local-open | token-required`, `FIRM_ADMIN_TOKEN`, `FIRM_API_TOKEN`, `FIRM_VIEWER_TOKEN`, Permissions `firm.read`, `live.gate`, `broker.credentials`
6. **Rate-Limit-Identität** — `src/lib/clientIp.ts` als einzige Quelle, `TRUSTED_PROXY_IPS` + `x-verified-ip`, `x-forwarded-for` nur hinter verifiziertem Proxy, globaler Deckel + exponentieller Backoff

## Dokumente

| Dokument | Zweck |
|----------|-------|
| [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) | Security-Audit 2026-08-25 (v1.4.0) — Findings, Fixes, Peer-Review |
| [../audits/README.md](../audits/README.md) | Zentrale Audit-Verwaltung — alle Audits chronologisch |
| [../audits/2026-09-03-peer-review/](../audits/2026-09-03-peer-review/) | Peer-Review-Audit Sep 2026 — H1-H10, C1-C4, B1-B2, S1-S2, W1-W2 (CLOSED) |
| [../audits/2026-09-05-security-review-gpt01/](../audits/2026-09-05-security-review-gpt01/) | Security-Audit GPT_01 — SEC-01 FIXED v1.36.27; SEC-02 FIXED v1.36.31; SEC-03 FIXED v1.36.28; SEC-10 FIXED v1.36.29; SEC-04 FIXED v1.36.30; SEC-07 FIXED v1.36.32; übrige Findings OPEN |

## Critical/High Findings (aggregierter Status)

> Quelle: `docs/audits/*/remediation/TRACKING.md` — hier nur aggregierte Sicht, Details in jeweiligen Audit-Ordnern.

Derzeit enthält die aggregierte Sicht **keine offenen Critical- oder High-Findings**.
Offene Medium-/Low-Themen bleiben im jeweiligen Audit-Tracking erfasst und sind
kein Freigabesignal für Live-Trading.

**SEC-02 ist seit v1.36.31 FIXED:** [sensible Dashboard-Reads](../audits/2026-09-05-security-review-gpt01/findings/SEC-02-unauthenticated-get-apis.md) verlangen `firm.read` und werden `private, no-store` ausgeliefert.

**SEC-01 ist seit v1.36.27 FIXED:** [Session-Autorisierung](../audits/2026-09-05-security-review-gpt01/findings/SEC-01-privilege-escalation.md).
Upgrade einschließlich unabhängigem `FIRM_SESSION_SECRET`, Neustart aller Instanzen
und erneutem Login erforderlich. Andere offene Findings bleiben unverändert relevant.

**SEC-03 ist seit v1.36.28 FIXED:** [Framework-/Decoder-Update](../audits/2026-09-05-security-review-gpt01/findings/SEC-03-vulnerable-next.md).
Alle Linux-/Windows-Instanzen aus dem neuen Lockfile installieren und frisch ausrollen.

**SEC-04 ist seit v1.36.30 FIXED:** [ws-Pin und WS-Härtung](../audits/2026-09-05-security-review-gpt01/findings/SEC-04-vulnerable-ws.md).

**SEC-07 ist seit v1.36.32 FIXED:** [Env-Credential-Fallback nur explizit Dev/Test](../audits/2026-09-05-security-review-gpt01/findings/SEC-07-env-credential-fallback.md) — in Produktion kein stiller Fallback auf `BITUNIX_API_KEY`/`ALPACA_API_KEY` mehr; fehlender Datensatz = null, Store-Fehler = HARD FAIL. Env nur mit `BROKER_ALLOW_ENV_FALLBACK=true` und `NODE_ENV!=production`.
Alle Instanzen mit `npm ci` neu installieren und sämtliche Prozesse neu starten.

Alle Findings aus 2026-09-03 sind FIXED (siehe [dort](../audits/2026-09-03-peer-review/remediation/SUMMARY.md)).

## Sensible Dashboard-Read-APIs (SEC-02)

**v1.36.31:** Die folgenden Read-Endpunkte sind nicht öffentlich: `/api/firm`,
`/api/firm/log`, `/api/firm/report`, `/api/firm/rules`, `/api/providers` und
`/api/routing`. Sie prüfen vor jeder Datenbank-, Router- oder Providerarbeit die
bestehende Permission `firm.read`.

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

**v1.36.28:** Next.js ist exakt auf **16.3.4** gepinnt. Der Mindestfix der
Advisories ist 16.3.3; dieses Release nutzt bewusst den stabilen Folgepatch
mit wieder aktivierter AVIF-Unterstützung und **sharp 0.35.4**, passenden
libvips-Paketen **1.3.3** sowie **libheif 1.23.2**. Die gesamte Kette ist relevant,
nicht allein die Versionsnummer von Next.js. v1.36.27 lieferte Next.js 16.3.1 aus.

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

## Auth-Modus (v1.36.13+)

- `NODE_ENV=production` ohne Token ⇒ Boot-Verweigerung `AUTH_NOT_CONFIGURED` (kein offener Zugang)
- Produktion mit Tokens benötigt zusätzlich einen unabhängigen Session-Key:
  `SESSION_SECRET_REQUIRED` / `SESSION_SECRET_INVALID` verweigert den Boot (SEC-01).
- `AUTH_MODE=local-open` — bewusster Opt-in für Single-User ohne Token (Dev-Default)
- `AUTH_MODE=token-required` — erzwingt Credential auch in Dev
- Sensible Dashboard-Reads in SEC-02 verlangen zusätzlich `firm.read`; die
  Permission wird nach Header-/Session-Authentifizierung serverseitig bestimmt.
- Wirksamer Modus: `curl -s localhost:3369/api/auth/me | jq .authMode`

## Rate-Limit-Identität (v1.36.14+)

- `x-forwarded-for` nur wenn `TRUSTED_PROXY_IPS` konfiguriert und Socket-Peer darin liegt (rightmost-untrusted)
- `x-verified-ip` — Header für Reverse Proxy (`proxy_set_header X-Verified-IP $remote_addr`)
- `x-real-ip` nie als Identität
- Credential-Brute-Force: 5/min pro Identität + 20/min global + exponentieller Backoff ab 3. Fehlversuch

## Kill-Switch (v1.36.15+)

- **Arm** (`POST /api/firm/kill {arm:true}`) — Operator (`guardWrite`)
- **Disarm** (`{arm:false, nonce}`) — ADMIN (`live.gate`) + CSRF + single-use Nonce (≤60s) aus `GET /api/firm/kill/challenge`

## Audit-Trail (v1.36.18+)

- Zwei Klassen in `src/lib/auditSink.ts`: `security` (Retry + Spool `data/audit-spool/`) und `telemetry` (best-effort)
- Fail-closed wo Mutation vermeidbar: Credential-Store, Kill-Switch-Disarm, Proposal-Freigabe ohne durablen Beleg ⇒ 503
- Lücken sichtbar: CRITICAL im Journal, `audit_missed_total` Metrik, `/api/health → audit`

## Session-Cookie (v1.36.27+, SEC-01)

- `firmToken` nicht mehr in `localStorage` — stattdessen `firm_session` HttpOnly, Secure, SameSite=Strict, 15min + `firm_csrf` Double-Submit
- Stateless HMAC-Session in `src/lib/authSession.ts`, ausschließlich mit unabhängigem
  `FIRM_SESSION_SECRET` (mindestens 32 Zeichen; separat `openssl rand -hex 32`).
  Kein Login-Token/Token-Hash, kein Fallback. Ohne gültigen Schlüssel Login HTTP 503,
  auch in Dev; `local-open` stellt keine Sessions aus.
- Schema v2 ohne Berechtigungs-Snapshot: serverseitige Rollen-/Permission-Ableitung
  pro Request, Credential-Bindung via keyed `authEpoch`. Rotation, Entfernung oder
  Neueinrichtung eines Tokens invalidiert alle bisherigen Sessions, sobald die neue
  Konfiguration im Prozess aktiv ist. Alle Instanzen konsistent neu starten.
- Alte v1-Cookies werden verworfen; neuer Login erforderlich. TTL bleibt 15 Minuten,
  Produktion verlangt HTTPS. Individuelles Logout/Revoke bleibt Teil des offenen
  Restumfangs von SEC-08.
- Tests: `npm run test:security:auth`; automatisch Teil von `security:live-gate`.
- [Konfiguration und Upgrade](../../CONFIGURATION.md#session-sicherheit-sec-01-v13627).

## Verwandte Dokumente

- [ARCHITECTURE.md](../ARCHITECTURE.md) — Security-Kapitel
- [FRONTEND_CONTROL_PLANE.md](../FRONTEND_CONTROL_PLANE.md) — Control Plane Auth
- [LIVE_TRADING.md](../LIVE_TRADING.md) — Live-Gate + Kill-Switch
- [CONFIGURATION.md](../../CONFIGURATION.md) — Env-Flags inkl. `AUTH_MODE`, `TRUSTED_PROXY_IPS`
