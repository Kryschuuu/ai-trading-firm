# Vollständiger Audit-Bericht — Architektur, Sicherheit, Performance & Code-Qualität

- **Audit-Zyklus:** [`README.md`](README.md)
- **Datum:** 2026-10-27
- **Prüfbasis:** `main` @ `123a876c8d2bb74d8741907b34523fb789e16bcf` (`v0.17.2`)
- **Rolle:** Principal Software Architect & Senior Security Engineer
- **Remediation-Prompts:** [`prompts/README.md`](prompts/README.md) · **Tracking:** [`remediation/TRACKING.md`](remediation/TRACKING.md)

---

## Vorbemerkung & Positivbefunde (Verifizierte saubere Module)

Das Repository weist in zahlreichen Sicherheits- und Infrastruktur-Kernbereichen bereits eine durchdachte, produktionsnahe Umsetzung auf. Um keine Scheinprobleme zu konstruieren, sind die sauber verifizierten Bereiche vorab dokumentiert:

- **Kryptographie & Secret-Handling (`src/lib/tokenCompare.ts`, `src/brokers/control-plane/secretStore.ts`):** Konstante Zeitvergleiche über SHA-256-normalisiertes `timingSafeEqual` (kein Längen-Timing-Leak); AES-256-GCM mit zufälliger 96-Bit-IV, expliziter 128-Bit-Auth-Tag-Längenprüfung und strikter Hex-Key-Validierung.
- **Session-Kryptographie & API-Client (`src/lib/authSession.ts:1-515`, `src/lib/apiClient.ts`):** Sauber signierte HMAC-SHA256-Session-Tokens, `HttpOnly`, `SameSite=Strict`, `Path=/api` sowie ein Browser-Fetch-Wrapper mit automatischem Double-Submit-CSRF-Header und Race-freiem Refresh-Mutex.
- **Append-Only-Ledger & Advisory-Locks (`src/execution/store.ts`, `src/execution/twap/store.ts`, `src/copy/store.ts`, `src/executionQuality/store.ts`):** Saubere Transaktionskapselung mit `pg_advisory_xact_lock` und DB-seitigen Immutability-Triggern.
- **PG-Notification-Listener & Strategie-Compiler (`src/lib/tradeRulesNotificationListener.ts`, `src/strategies/compiler.ts`, `src/lib/engine.ts:144-169`):** Dedizierter `pg.Client` mit exponentiellem Reconnect-Backoff + Polling-Fallback; AST-basierter Strategie-Compiler ohne `eval`/`new Function`; Prozess-übergreifender `pg_try_advisory_lock` für die Makro-Pipeline.
- **Docs-Viewer, XSS-Schutz & Bitunix-Signierung (`src/lib/docsCatalog.ts`, `src/components/docs/DocsMarkdown.tsx`, `src/app/layout.tsx`, `src/brokers/bitunix/signing.ts`, `src/brokers/bitunix/http.ts`):** Strikte Path-Traversal-Abwehr (`..`-Verbot), sicheres Link-/Bild-Protokoll-Whitelisting ohne `rehype-raw`, CSP-kompatible Theme-Initialisierung per `data-theme`-Attribut und saubere SHA-256-Signaturkette mit Response-Größenlimit (8 MiB).

Die nachfolgenden **15 Befunde (`ASA-01` … `ASA-15`)** adressieren ausschließlich substanzielle Architektur-, Sicherheits-, Konsistenz- und Skalierungsdefizite.

---

## Kritische Befunde (`CRITICAL`)

### Befund ASA-01 — Multi-Prozess-Split-Brain: `PaperBroker`, Kill-Switch und `realizedPnl` divergieren zwischen Web-Server und `micro-executor`

- **Kategorie:** Architektur & Modularität / Datenkonsistenz
- **Schweregrad:** Kritisch
- **Betroffene Datei(en) & Zeilen:** `deploy/micro-executor.service:7-20`, `src/lib/brokerHydration.ts:116-142`, `src/lib/broker.ts:460-605`, `src/lib/microExecutor.ts:840-905`, `src/lib/monitor.ts:716-750`, `src/app/api/firm/kill/route.ts:52-78`, `src/live-gate/enforcer.ts:183-245`
- **Problembeschreibung:** Das Deployment betreibt zwei getrennte OS-Prozesse (`ai-trading-firm.service` für Next.js/Monitor und `micro-executor.service` für den Echtzeit-Regel-Daemon). Trotzdem liegen `paperBroker` (`globalThis.__paperBroker`), `firmKillSwitchArmed` (`globalThis.__firmKillSwitchArmed`) und der `LiveGateService` ausschließlich im jeweiligen Prozess-RAM. `ensurePaperBrokerHydrated()` läuft pro Prozess genau einmal beim Kaltstart (`hydratedOnce = true`). Daraus folgen drei reale Produktionsfehler:
  1. **Kill-Switch greift prozessübergreifend nicht für Orders:** `POST /api/firm/kill` schreibt zwar in `kill_switches` und ruft `armKillSwitch()` im Web-Prozess auf, aber weder `paperBroker.submitAtomic()` (`src/lib/broker.ts:468`) noch `evaluateLiveOrder()` (`src/live-gate/enforcer.ts:183`) lesen die DB-Tabelle `kill_switches`. In `src/lib/microExecutor.ts:856` wurde die frühere DB-Kill-Switch-Abfrage vor `submitAtomic` entfernt — der `micro-executor` eröffnet nach Auslösen des Not-Aus im Dashboard ungehindert weiter Positionen.
  2. **Systematischer `realizedPnl = 0`-Bug:** Eröffnet der `micro-executor` eine Position, schreibt er sie zwar in `positions`, der RAM-`paperBroker` des Next.js-Prozesses kennt sie aber nicht. Greift anschließend der Monitor im Web-Prozess (`applyExit`, `src/lib/monitor.ts:718-727`) bei SL/TP, liefert `broker.close(pos.symbol, exitPrice)` `null` zurück. Der Fallback `const realized = closed ? closed.realizedPnl : 0` verbucht die geschlossene Position dauerhaft mit **`realizedPnl = 0`** in PostgreSQL und korrumpiert Cash/Equity.
  3. **Divergierende Risikolimits:** Exposure-, Positionsanzahl- und Cash-Prüfungen in `submitAtomic` rechnen im jeweils veralteten lokalen RAM-Bestand statt gegen den gemeinsamen DB-Zustand.
- **Konkreter Lösungsvorschlag:**
  - `kill_switches` als autoritative Quelle vor jeder Order prüfen (oder per PostgreSQL `LISTEN/NOTIFY` auf Kanal `firm_control_changed` synchronisieren + Fail-Closed-DB-Read in `submitAtomic` und `evaluateLiveOrder`).
  - Vor `submitAtomic` und `applyExit` unter `withAccountLock` den offenen Positions- und Kontostand aus PostgreSQL rehydrieren bzw. `realizedPnl` deterministisch aus `pos.side`, `pos.entryPrice`, `exitPrice`, `pos.quantity` und Gebührenmodell berechnen, falls die Position nicht im lokalen RAM lag.
  - Details & Umsetzungspatch: [`findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md`](findings/ASA-01-multiprocess-split-brain-kill-switch-pnl.md) · Prompt: [`PROMPT-ASA-P0-01`](prompts/PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md).

---

### Befund ASA-02 — Rollen-Spoofing per `x-admin-token`, umgehbares Vier-Augen-Prinzip und gebrochene Kill-Switch-Autorisierung

> **Status 2026-10-27: `FIXED`.** Umsetzung und Verifikation (12 Regressionstests) im
> [Finding](findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) und im
> [Tracking](remediation/TRACKING.md). Die folgende Problembeschreibung ist der
> historische Audit-Befund.

- **Kategorie:** Sicherheit (Autorisierung & Governance)
- **Schweregrad:** Kritisch
- **Betroffene Datei(en) & Zeilen:** `src/app/api/firm/lifecycle/route.ts:165-174`, `src/app/api/firm/lifecycle/route.ts:290-323`, `src/app/api/live/kill/route.ts:27-45`, `src/live-gate/service.ts:318-347`, `src/auth/permissions.ts:21-24`
- **Problembeschreibung:** An den sicherheitskritischsten Governance-Übergängen (Live-Promotion und Live-Kill-Switch) klaffen drei Autorisierungslücken:
  1. **Admin-Escalation durch beliebigen Header (`lifecycle/route.ts:165-174`):** Nach `guardWrite(req)` (das lediglich Operator-Rechte über `FIRM_API_TOKEN` prüft) bestimmt `actorRoleFromRequest(req)` die Rolle über `if (req.headers.get("x-admin-token")) return "admin";` — **ohne den Headerwert jemals gegen `ADMIN_API_TOKEN` zu prüfen**. Jeder Operator (und im `local-open`-Modus jeder Aufrufer) erlangt durch Senden von `x-admin-token: <dummy>` sofort Admin-Rechte und darf Strategien nach `LIVE_CONSTRAINED` / `LIVE_SCALED` promoten sowie `OVERRIDE`-Aktionen ausführen.
  2. **Vier-Augen-Prinzip rein kosmetisch (`lifecycle/route.ts:290-323`, `live-gate/service.ts:318-347`):** Sowohl bei Live-Promotions als auch bei `LiveGateService.transition(..., "LIVE")` werden `actor`/`operator` und `approvedBy`/`secondApprover` als ungeprüfte Freitextfelder aus dem JSON-Body gelesen (`approvedBy !== actor`). Eine einzelne Person erfüllt das Vier-Augen-Prinzip mit einem einzigen Request (`{"actor": "alice", "approvedBy": "bob"}`).
  3. **Fehlkonfigurierter Live-Kill-Endpunkt (`api/live/kill/route.ts:27-45`):**
     - `POST /api/live/kill` fordert `requirePermission(req, "live.gate")` (nur `admin`) statt der eigens dafür geschaffenen Permission `"firm.kill"` (`operator` + `admin`, die im gesamten Repo nirgends aufgerufen wird). Ein Operator kann im Notfall den Live-Kill-Switch **nicht** auslösen (`403 Forbidden`).
     - Beim Entschärfen (`action: "clear"`) validiert der Endpunkt überhaupt keine Challenge-Nonce, obwohl `GET /api/live/kill` extra `issueKillNonce()` ausstellt und `consumeKillNonce()` in `src/lib/killSwitchNonce.ts` genau dafür existiert.
- **Konkreter Lösungsvorschlag:**
  - `actorRoleFromRequest` durch `resolveAuth(req)` ersetzen; niemals unvalidierte Header zur Rollenbestimmung auswerten.
  - `POST /api/live/kill` nach Aktion splitten: `arm` benötigt `firm.kill`, `clear` benötigt `live.gate` (Admin) **plus** gültige Einmal-Nonce via `consumeKillNonce(body.nonce)`.
  - Vier-Augen-Freigaben zweistufig über zwei verschiedene kryptographische Principals (`principalKey` / Session-Fingerprint in Request 1 = Antrag, Request 2 = Gegenzeichnung) erzwingen.
  - Details & Umsetzungspatch: [`findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md`](findings/ASA-02-lifecycle-role-spoofing-four-eyes-live-kill.md) · Prompt: [`PROMPT-ASA-P0-02`](prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md).

---

### Befund ASA-03 — Alpaca-Live-Adapter ist bei Positionsabfragen Fail-Open (`safeGetPositions` liefert `[]`, `verifyFlat()` meldet fälschlich `true`)

- **Kategorie:** Sicherheit / Live-Execution-Zuverlässigkeit
- **Schweregrad:** Kritisch
- **Betroffene Datei(en) & Zeilen:** `src/brokers/alpaca/execution.ts:154-175`, `src/brokers/alpaca/execution.ts:269-280`, `src/brokers/alpaca/execution.ts:296-316`, `src/brokers/alpaca/http.ts:201-225`
- **Problembeschreibung:** In `AlpacaExecutionAdapter` fängt `safeGetPositions()` (`src/brokers/alpaca/execution.ts:269-280`) **jeden** HTTP-, Timeout-, 429- oder Deserialisierungsfehler stillschweigend ab und gibt `[]` zurück. Da drei sicherheitskritische Methoden darauf aufbauen, verhält sich der Adapter im Fehlerfall durchgehend **Fail-Open**:
  1. `getAccount()` (Zeile 171) meldet `openPositions: 0`, wodurch Positions- und Exposure-Caps umgangen werden.
  2. `closeAllPositions()` (Zeile 296–305) prüft `if (before.length > 0)` vor `DELETE /v2/positions` — schlägt `GET /v2/positions` wegen Rate-Limit (`429`) oder kurzzeitigem Netzproblem fehl, überspringt der Notfall-Close das Glattstellen real offener Live-Positionen komplett und liefert `closedCount: 0, remainingOpen: 0`.
  3. `verifyFlat()` (Zeile 312–315) berechnet `(await this.getPositions()).length === 0` und meldet bei jedem Netzwerk-/API-Ausfall **`true` („Konto ist garantiert glattgestellt“)**.
  4. Verschärfend ignoriert `AlpacaHttp.request()` (`src/brokers/alpaca/http.ts:206-210`) den `Retry-After`-Header bei HTTP 429 und wiederholt auch nicht-idempotente `POST`-Aufrufe bei Timeout, falls der Caller keine `client_order_id` übergibt.
- **Konkreter Lösungsvorschlag:**
  - `safeGetPositions()` entfernen und durch `fetchPositionsStrict()` ersetzen, das Fehler typisiert wirft (`BrokerError`).
  - `closeAllPositions()` muss `DELETE /v2/positions?cancel_orders=true` **immer** direkt absetzen, auch wenn der optionale Vorab-Snapshot fehlschlug; `verifyFlat()` muss bei Fehlern werfen oder `false` liefern.
  - `AlpacaHttp` wertet `Retry-After` bei `429` aus und beschränkt automatische Retries auf idempotente Methoden (`GET`, `DELETE`) bzw. `POST /v2/orders` mit gesetzter `client_order_id`.
  - Details & Umsetzungspatch: [`findings/ASA-03-alpaca-fail-open-positions-verify-flat.md`](findings/ASA-03-alpaca-fail-open-positions-verify-flat.md) · Prompt: [`PROMPT-ASA-P0-03`](prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md).

---

## Hohe Befunde (`HIGH`)

### Befund ASA-04 — `MicroExecutor` verliert alle 30 s Cooldowns, feuert doppelt bei Tick-Bursts und abonniert neue Symbole zur Laufzeit nicht

- **Kategorie:** Architektur / Handelslogik & Concurrency
- **Schweregrad:** Hoch
- **Betroffene Datei(en) & Zeilen:** `src/lib/microExecutor.ts:537-566`, `src/lib/microExecutor.ts:818-920`, `src/lib/microExecutor.ts:1234-1240`, `src/lib/microExecutor.ts:1490-1509`, `src/lib/microExecutor.ts:1630-1660`, `src/lib/microExecutor.ts:1746-1755`
- **Problembeschreibung:** Im Echtzeit-Ausführungs-Daemon `MicroExecutor` bestehen vier zusammenhängende Laufzeitfehler:
  1. **Cooldown-Reset alle 30 s (`microExecutor.ts:537-566`):** `RuleCache.applySnapshot()` überschreibt alle gecachten Regeln mit `firedAt: 0`. Da `pollTimer` alle `30_000 ms` `refresh("poll")` aufruft (und jeder `NOTIFY` auf `trade_rules_changed` ebenfalls `applySnapshot` triggert), wird selbst ein `cooldownSeconds = 3600` spätestens nach 30 Sekunden gelöscht. Zusätzlich addiert `applySnapshot` `executionsToday = r.executionsToday + (this.ramCounts.get(r.id) ?? 0)`, ohne `ramCounts` nach dem DB-Read zu leeren — Ausführungen werden doppelt gezählt.
  2. **Kein In-Flight-Lock bei Tick-Bursts (`microExecutor.ts:1630-1660`):** `handleTick` ist asynchron, aber `markFired()` erfolgt erst **nach** `await executeOrder(...)` (Zeile 901). Treffen innerhalb der 20–150 ms DB-/Broker-Latenz mehrere WebSocket-Ticks ein, passieren alle Ticks `match()` gleichzeitig und lösen parallele Doppel-Orders für dieselbe Regel aus.
  3. **Kein dynamisches Feed-Abonnement (`microExecutor.ts:1490-1509`, `1746-1755`):** `activeSymbols` und Binance-WebSocket-Streams werden ausschließlich einmalig in `start()` aufgebaut. Zur Laufzeit neu aktivierte Regeln auf neuen `(symbol, timeframe)`-Paaren werden zwar per `NOTIFY` in den `RuleCache` geladen, empfangen aber bis zu einem Daemon-Neustart weder Bar-Warmup noch Ticks.
  4. **Audit-Tippfehler (`microExecutor.ts:1237`):** `version: 1 : 1` protokolliert immer Version `1` statt `rule.version`.
- **Konkreter Lösungsvorschlag:**
  - `firedAt` aus vorherigem Cache-Zustand bzw. `lastExecutedAt` aus der DB übernehmen; `ramCounts` beim Laden konsistenter DB-Zähler zurücksetzen; ein `inFlightRules = new Set<number>()` synchron vor `await executeRule` sperren; neue `(symbol, timeframe)`-Paare dynamisch am Feed registrieren; `version: rule.version` loggen.
  - Details & Umsetzungspatch: [`findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md`](findings/ASA-04-micro-executor-cooldown-burst-runtime-rules.md) · Prompt: [`PROMPT-ASA-P1-04`](prompts/PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md).

---

### Befund ASA-05 — Unauthentifizierte sensitive GET-Routen (SEC-02-Lücken), 7 tote RBAC-Permissions und ungefilterte `e.message`-Leaks

- **Kategorie:** Sicherheit (Zugriffskontrolle & Informationsabfluss)
- **Schweregrad:** Hoch
- **Betroffene Datei(en) & Zeilen:** `src/auth/permissions.ts:14-36`, `src/app/api/ops/route.ts:39-57`, `src/app/api/firm/config/route.ts:32-44,89`, `src/app/api/firm/missions/route.ts:17-50`, `src/app/api/firm/macro/route.ts:24-30`, `src/app/api/firm/micro/route.ts:26-35`, `src/app/api/firm/devils-advocate/route.ts:20-35`, `src/app/api/firm/risk/signal-decay/route.ts:35-55`, `src/app/api/live/state/route.ts:27-44`, `src/app/api/brokers/[venue]/test/route.ts:25`, `tests/sec02.unauthenticatedGetApis.test.ts:1-60`
- **Problembeschreibung:**
  1. **Unauthentifizierte sensitive GET-Endpunkte:** Während `SEC-02` sechs GET-Routen schloss, stehen mindestens 15 weitere sensitive GET-Endpunkte komplett ohne Auth-Prüfung offen — darunter `GET /api/ops` (kompletter Operations-Center-Snapshot inkl. Env-/Security-Konfiguration, Kill-Switch, Venues), `GET /api/firm/config`, `GET /api/firm/missions`, `GET /api/firm/macro`, `GET /api/firm/micro`, `GET /api/firm/devils-advocate`, `GET /api/firm/risk/*`, `GET /api/live/state` und `GET /api/brokers/[venue]/health`.
  2. **Hälfte des RBAC-Modells ist toter Code:** Von 15 Permissions in `src/auth/permissions.ts` werden **7 nirgendwo im Code aufgerufen**: `firm.config`, `firm.kill`, `ops.view`, `broker.status`, `broker.test`, `routing.read`, `routing.modes.write`. Stattdessen prüft `PUT /api/firm/config` nur `firm.write` (Zeile 89 — Operator kann Admin-Risikodeckel überschreiben) und `POST /api/brokers/[venue]/test` verlangt `broker.credentials` (Admin) statt `broker.test` (Operator).
  3. **Rohe interne Fehlermeldungen in ~25 API-Routen:** Trotz `publicErrorMessage(err)` in `src/lib/httpError.ts` geben zahlreiche Routen `String(e)` / `e.message` ungefiltert an den Client zurück (SQL-Fragmente, Dateipfade, interne Hostnamen).
- **Konkreter Lösungsvorschlag:**
  - Alle nicht explizit öffentlichen `/api/**`-Routen mit den passenden Permissions aus `src/auth/permissions.ts` verdrahten (nur `/api/health`, `/api/auth/login`, `/api/auth/refresh`, `/api/auth/status` auf expliziter Public-Allowlist), `Cache-Control: private, no-store` setzen, `publicErrorMessage(err)` flächendeckend nutzen und durch einen statischen Routen-Test absichern.
  - Details & Umsetzungspatch: [`findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md`](findings/ASA-05-unauthenticated-get-routes-dead-rbac-error-leaks.md) · Prompt: [`PROMPT-ASA-P1-05`](prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md).

---

### Befund ASA-06 — Event-Loop-DoS auf `/api/portfolio/optimize` und Prozess-Divergenz in der `LiveGateAudit`-Hash-Kette

- **Kategorie:** Performance & Integrität
- **Schweregrad:** Hoch
- **Betroffene Datei(en) & Zeilen:** `src/app/api/portfolio/optimize/route.ts:68-193`, `parse.ts` unter `src/app/api/portfolio/` (`110-165`), `src/portfolio/optimize.ts:288-347`, `src/app/api/live/state/route.ts:27-35`, `src/live-gate/service.ts:214-230`, `src/live-gate/audit.ts:169-216`
- **Problembeschreibung:**
  1. **Unauthentifizierter CPU- & Sync-I/O-DoS (`/api/portfolio/optimize`):** `POST /api/portfolio/optimize`, `/correlation` und `/metrics` besitzen weder Auth noch Rate-Limit. `optimize/route.ts` erlaubt bis zu `N = 200` Symbole, `maxIterations = 1_000_000` (Zeile 75) und `maxAdjustmentRounds = 50`. Die verschachtelte Projektions- und Kovarianzschleife (`O(rounds * maxIterations * N^2)`) blockiert den einzigen Node.js-Event-Loop für viele Sekunden pro Request und schreibt das Resultat anschließend synchron per `writeFileSync` auf Disk (`writePortfolioSnapshot`, Zeile 135–146).
  2. **Hash-Ketten-Bruch über Prozessgrenzen (`src/live-gate/audit.ts:169-216`):** `LiveGateAudit` liest `this.head` (`seq` + `prevHash`) nur einmal beim ersten Zugriff im Prozess ein und schreibt bei `append()` mit `appendFileSync` weiter, ohne vorher zu prüfen, ob ein zweiter Prozess (z. B. CLI `npm run live:kill` oder `micro-executor`) inzwischen Zeilen angehängt hat. Schreibt erst das CLI (`seq = 12`) und danach der laufende Web-Server (kennt noch `seq = 11`), schreibt der Web-Server eine zweite Zeile mit `seq = 12` und falschem `prevHash`. Ab diesem Moment meldet `verifyAuditChain()` dauerhaft `chainValid: false` und blockiert Live-Gate-Übergänge. Zudem liest und hasht `GET /api/live/state` bei jedem Aufruf die gesamte Datei synchron.
- **Konkreter Lösungsvorschlag:**
  - `/api/portfolio/*` mit `requirePermission(req, "firm.read")` / `"firm.write"` + `checkRateLimit` schützen, `maxIterations <= 2_000` und `maxAdjustmentRounds <= 10` hart deckeln, `writePortfolioSnapshot` asynchronisieren und `scripts/gen-docs-inventories.ts` (`REVIEWED_UNGUARDED_WRITES`) aktualisieren.
  - `LiveGateAudit.append()` per Dateisperre / Tail-Re-Read mit dem aktuellen Dateiende synchronisieren und `verifyAuditChain()` über `(size, mtimeMs)` cachen.
  - Details & Umsetzungspatch: [`findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md`](findings/ASA-06-portfolio-dos-live-gate-audit-chain-split.md) · Prompt: [`PROMPT-ASA-P1-06`](prompts/PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md).

---

### Befund ASA-07 — Fehlender CSRF-Schutz auf zentralen mutierenden Endpunkten (`guardWrite`) sowie fehlende Write-Rate-Limits

- **Kategorie:** Sicherheit (CSRF & Brute-Force / DoS)
- **Schweregrad:** Hoch
- **Betroffene Datei(en) & Zeilen:** `src/lib/apiAuth.ts:174-182`, `src/app/api/firm/route.ts:95-115`, `src/app/api/firm/micro/route.ts:45-90`, `src/app/api/firm/missions/route.ts:55-95`, `src/app/api/firm/lifecycle/route.ts:206`, `src/app/api/ops/toggles/route.ts:28-55`, `src/app/api/routing/modes/route.ts:40-65`, `src/app/api/firm/execution/policy/route.ts:48-75`, `src/app/api/firm/execution/twap/route.ts:50-85`, `src/app/api/auth/logout/route.ts:22-35`
- **Problembeschreibung:**
  1. **Session-Cookie-CSRF auf kritischen Schreibrouten:** `resolveAuth(req)` akzeptiert neben Bearer-Tokens auch das Browser-Session-Cookie (`atf_session`). Zwar nutzt `SameSite=Strict`, doch Subdomain-/Same-Site-Kontexte (z. B. andere lokale Dienste auf Ports derselben Site `http://localhost:*` oder Schwester-Subdomains) senden `SameSite=Strict`-Cookies regulär mit, weil Ports nicht Teil der „Site“ (eTLD+1 + Scheme) sind! Genau deshalb existiert `checkCsrfGuard(req)` — er fehlt jedoch komplett in `guardWrite()` (`src/lib/apiAuth.ts:174-176`) sowie in `POST /api/firm` (Pipeline-Trigger!), `POST/PATCH/DELETE /api/firm/micro` (Trade-Rules!), `POST /api/firm/missions`, `POST /api/firm/lifecycle`, `POST /api/ops/toggles`, `PUT /api/routing/modes`, `PUT /api/firm/execution/policy`, `POST /api/firm/execution/twap` und `POST /api/firm/forecasts/resolve`.
  2. **Fehlende Rate-Limits auf Schreibrouten:** Mehrere DB- und zustandsverändernde Endpunkte (`execution/policy`, `execution/twap`, `forecasts/resolve`, `ops/toggles`, `routing/modes`, `auth/logout`) rufen `checkRateLimit` nicht auf.
- **Konkreter Lösungsvorschlag:**
  - `checkCsrfGuard(req)` zentral in `guardWrite(req)` und einem gemeinsamen Helper `guardMutatingRoute(req, permission, rateLimitOpts)` für alle Session-authentifizierten Mutationen erzwingen (da `apiFetch` im Frontend den `x-csrf-token`-Header bereits bei jedem mutierenden Aufruf mitschickt, entsteht keinerlei UI-Regression).
  - Details & Umsetzungspatch: [`findings/ASA-07-missing-session-csrf-and-write-rate-limits.md`](findings/ASA-07-missing-session-csrf-and-write-rate-limits.md) · Prompt: [`PROMPT-ASA-P1-05`](prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md).

---

### Befund ASA-08 — IP-Spoofing über `X-Verified-IP`, sobald `TRUSTED_PROXY_IPS` gesetzt ist und Next.js auf `0.0.0.0:3369` lauscht

- **Kategorie:** Sicherheit (Netzwerk / Rate-Limit-Bypass)
- **Schweregrad:** Hoch
- **Betroffene Datei(en) & Zeilen:** `src/lib/clientIp.ts:409-425`, `src/lib/clientIp.ts:535-565`, `package.json:13`, `deploy/ai-trading-firm.service:18`
- **Problembeschreibung:** `extractClientIp()` soll Header wie `X-Verified-IP` nur dann akzeptieren, wenn der unmittelbare TCP-Peer in `TRUSTED_PROXY_IPS` steht. In Next.js App Router (`Request` nach Fetch-Standard) existiert jedoch kein Socket-Objekt; `peerIpFromRequest(request)` (`src/lib/clientIp.ts:409-425`) liefert im regulären Laufzeitbetrieb **immer `null`**. In Zeile 546 lautet die Prüfung:
  `const peerTrusted = peerIp !== null ? isIpInCidrs(peerIp, config.trustedProxyCidrs) : null;`
  und direkt darunter: `if (peerTrusted !== false) { ... lese X-Verified-IP ... }`.
  Weil `null !== false` zu `true` auswertet, vertraut der Server jedem beliebigen Client-Header `X-Verified-IP: <zufällige-IP>`, sobald `TRUSTED_PROXY_IPS` konfiguriert ist! Gleichzeitig startet `npm run start` (`package.json:13`) standardmäßig mit `next start -p 3369 -H 0.0.0.0`. Jeder im LAN/VPC erreichbare Client kann direkt Port `3369` ansprechen, pro Request `X-Verified-IP` rotieren und damit Login-Brute-Force-Sperren (`POST /api/auth/login`), IP-Rate-Limits und Audit-IPs komplett aushebeln.
- **Konkreter Lösungsvorschlag:**
  - Standard-Bind in `package.json` und `deploy/ai-trading-firm.service` auf `127.0.0.1` härten (Reverse-Proxy terminiert extern).
  - In `src/lib/clientIp.ts`: Wenn `peerIp === null` ist, darf `X-Verified-IP` / `X-Forwarded-For` nur akzeptiert werden, wenn zusätzlich ein gemeinsames Proxy-Geheimnis (konstanter Zeitvergleich) verifiziert wurde oder der Boot-Guard sicherstellt, dass der Server ausschließlich an Loopback gebunden ist.
  - Details & Umsetzungspatch: [`findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md`](findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md) · Prompt: [`PROMPT-ASA-P1-07`](prompts/PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md).

---

### Befund ASA-09 — `HistoricalStore` parst gesamte NDJSON-Historie pro Query, korrumpiert UTF-8 an 1-MiB-Grenzen und verliert Cross-Prozess-Writes

- **Kategorie:** Performance & Datenintegrität
- **Schweregrad:** Hoch
- **Betroffene Datei(en) & Zeilen:** `src/lib/marketdata/historicalStore.ts:375-425`, `src/lib/marketdata/historicalStore.ts:440-530`, `src/lib/marketdata/historicalStore.ts:555-603`
- **Problembeschreibung:** `HistoricalStore` speichert sämtliche Kerzen aller Symbole und Timeframes in einer einzigen monolithischen Datei `candles.ndjson` und hat vier gravierende Schwächen:
  1. **Voller Datei-Scan bei jedem `query()` / `ingest()` (`historicalStore.ts:440-530`):** Jeder Backtest-, Funnel- oder Regime-Aufruf liest synchron die komplette NDJSON-Datei von Anfang bis Ende und ruft für jede Zeile `JSON.parse` auf. Bei z. B. 50 Symbolen × 100.000 `1m`-Bars (~5 Mio. Zeilen / ~750 MB) dauert jeder einzelne `query()`-Aufruf Sekunden und friert den Event-Loop ein.
  2. **UTF-8-Zeichenspaltung an 1-MiB-Chunk-Grenzen (`readLinesSync`, Zeile 569–585):** `buf.subarray(0, bytesRead).toString("utf8")` dekodiert jeden 1-MiB-Puffer isoliert ohne `StringDecoder`. Fällt ein Multi-Byte-UTF-8-Zeichen auf die Chunk-Grenze, entstehen `U+FFFD`-Zeichen bzw. korrupte Zeilen.
  3. **V8-Max-String-Length-Crash in `writeAll()` (`historicalStore.ts:593-601`):** `bars.map((b) => JSON.stringify(b)).join("\n")` baut den gesamten Dateiinhalt als einen einzigen JS-String im Speicher zusammen — ab ~512 MB wirft V8 `RangeError: Invalid string length` und alle Schreibvorgänge schlagen fehl.
  4. **Lost Updates & Temp-File-Race (`historicalStore.ts:595`):** Temporärdateien heißen `${filePath}.tmp-${process.pid}`. Parallele Aufrufe innerhalb desselben Prozesses überschreiben dieselbe `.tmp`-Datei; parallele `ingest()`-Läufe zwischen CLI-Sync und Web-Server überschreiben sich gegenseitig per Read-Modify-Write ohne Dateisperre.
- **Konkreter Lösungsvorschlag:**
  - `StringDecoder("utf8")` in `readLinesSync` einsetzen; `writeAll` streambar per `writeSync(fd, chunk)` in gebündelten 64-KiB-Puffern mit eindeutiger Temp-Endung (`${process.pid}-${ randomUUID() }`) + Dateisperre schreiben; Ablage pro `(instrumentId, timeframe)` partitionieren (mit transparentem Lese-Fallback auf bestehende `candles.ndjson`).
  - Details & Umsetzungspatch: [`findings/ASA-09-historical-store-oom-utf8-lost-update.md`](findings/ASA-09-historical-store-oom-utf8-lost-update.md) · Prompt: [`PROMPT-ASA-P1-08`](prompts/PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md).

---

## Mittlere Befunde (`MEDIUM`)

### Befund ASA-10 — Deterministischer LLM-Fallback eröffnet bei Modell-Ausfall blind `LONG`-Trades; Drawdown-Alerts vergleichen `0..1` mit `5/10/20`

- **Kategorie:** Code-Qualität / Handelslogik
- **Schweregrad:** Mittel
- **Betroffene Datei(en) & Zeilen:** `src/lib/ollama.ts:305-372`, `src/lib/monitor.ts:554`, `src/lib/monitor.ts:865-910`
- **Problembeschreibung:**
  1. **Fail-Open-Trading bei Ollama-Ausfall (`src/lib/ollama.ts:305-372`):** Ist der lokale Ollama-Server nicht erreichbar, überlastet oder liefert einen Timeout, fällt `ask()` stillschweigend auf `fallbackReason()` zurück. Dieser String-Generator gibt für Technical/Sentiment/Fundamentals `SIGNAL: BUY`, für den Risk-Manager `VERDICT: APPROVE` und für den Portfolio-Manager **`ACTION: TRADE`, `DIRECTION: LONG`, `ALLOCATION_PCT: 8`** zurück! Ein kaputter oder gestoppter LLM-Dienst führt damit nicht zu einem sicheren `HOLD`, sondern zu automatischen `LONG`-Käufen auf dem ersten Symbol.
  2. **Kaputte Einheiten & Peak-Überschreibung in `checkEquityAlerts` (`src/lib/monitor.ts:554, 865-910`):**
     - `broker.drawdownPct` liefert einen Bruch im Intervall `[0, 1]` (z. B. `0.12` für 12 % Drawdown, `src/lib/broker.ts:357`), `checkEquityAlerts` vergleicht diesen Wert aber mit `DRAWDOWN_THRESHOLDS = [5, 10, 20]` (`dd >= threshold`). Selbst bei 99 % Kapitalverlust (`0.99 < 5`) feuert **niemals** ein Drawdown-Alert!
     - Zusätzlich überschreibt Zeile 554 (`recordEquitySnapshot`) bereits vor dem Aufruf von `checkEquityAlerts` (Zeile 557) `getEquityAlertState().peak = broker.peakEquity`, wodurch die New-Equity-High-Erkennung (`equity > state.peak`) niemals auslösen kann.
- **Konkreter Lösungsvorschlag:**
  - `fallbackReason()` standardmäßig Fail-Closed auf `ACTION: HOLD` / `VERDICT: REJECT` setzen (deterministischer Demo-Trade-Modus nur hinter explizitem Test-/Seed-Flag).
  - In `monitor.ts` `previousPeak` vor `recordEquitySnapshot` sichern und `const ddPct = broker.drawdownPct * 100` gegen `[5, 10, 20]` prüfen.
  - Details & Umsetzungspatch: [`findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md`](findings/ASA-10-llm-fallback-blind-long-and-drawdown-alert-units.md) · Prompt: [`PROMPT-ASA-P2-09`](prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md).

---

### Befund ASA-11 — Fehlende Sekundärindizes auf Kerntabellen, unbegrenzte Full-Table-Loads und fehlendes `statement_timeout`

- **Kategorie:** Performance / Datenbank
- **Schweregrad:** Mittel
- **Betroffene Datei(en) & Zeilen:** `src/db/schema.ts:15-175`, `src/db/index.ts:35-60`, `src/lib/signalDecayRuntime.ts:251-273`, `src/app/api/firm/route.ts:45-60`, `src/lib/monitor.ts:318-323, 574-590`
- **Problembeschreibung:**
  1. **Fehlende Indizes auf den ältesten Hochfrequenz-Tabellen (`src/db/schema.ts:15-175`):** Während neuere Tabellen sauber indiziert sind, besitzen die sechs Kerntabellen `positions`, `agent_messages`, `equity_snapshots`, `audit_log`, `missions` und `trade_rules` keinerlei Sekundärindizes (`index(...)`). Jede Dashboard-Abfrage (`ORDER BY created_at DESC LIMIT ...`, `WHERE status = 'open'`, `WHERE active = true`, `WHERE event = ...`) erzwingt bei wachsender Laufzeit serielle Full-Table-Scans + In-Memory-Sorts in PostgreSQL.
  2. **Unbegrenzte Tabellen-Reads in Node.js:** `refreshDecayFromDb()` (`src/lib/signalDecayRuntime.ts:253`) lädt `db.select().from(positions)` **ohne `WHERE` und ohne `LIMIT`** komplett in den Node-Speicher; `GET /api/firm` (`src/app/api/firm/route.ts:47`) lädt ebenfalls ungefiltert sämtliche historischen Zeilen aus `positions`.
  3. **N+1-Einzel-Queries im Monitor (`src/lib/monitor.ts:318-323, 574-590`):** Updates auf `tradeRules` und `forecasts` laufen in seriellen `for (... await db.update ...)`-Schleifen statt gebündelt.
  4. **Pool-Härtung (`src/db/index.ts:35-60`):** Dem `pg.Pool` fehlt `statement_timeout` (hängende Queries können alle 10 Pool-Connections dauerhaft blockieren), und `ensureDbConnection()` wirft `err.message` inkl. möglicher Verbindungsdetails ungefiltert weiter.
- **Konkreter Lösungsvorschlag:**
  - Idempotente SQL-Migration + Drizzle-Schema-Indizes für `positions(status, opened_at DESC)`, `positions(closed_at DESC)`, `audit_log(created_at DESC)`, `audit_log(event, created_at DESC)`, `agent_messages(run_id, created_at DESC)`, `equity_snapshots(recorded_at DESC)`, `missions(status)`, `trade_rules(active, symbol)` anlegen; `LIMIT` + `WHERE status = 'closed'` in `signalDecayRuntime` und `GET /api/firm` ergänzen; `statement_timeout` im Pool konfigurieren.
  - Details & Umsetzungspatch: [`findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md`](findings/ASA-11-core-db-indexes-unbounded-scans-pool-timeout.md) · Prompt: [`PROMPT-ASA-P2-09`](prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md).

---

### Befund ASA-12 — Unbegrenzte In-Memory-Maps, nie aufgerufenes `pruneRevokedSessions()` und nicht persistierte Session-Revocation

- **Kategorie:** Performance / Zuverlässigkeit & Sicherheit
- **Schweregrad:** Mittel
- **Betroffene Datei(en) & Zeilen:** `src/lib/authSession.ts:520-630`, `src/lib/apiAuth.ts:152-170`, `src/brokers/control-plane/guard.ts:75-85`, `src/brokers/bitunix/execution.ts:106, 183, 217-296`
- **Problembeschreibung:**
  1. **Toter Cleanup-Pfad & flüchtige Session-Widerrufe (`src/lib/authSession.ts:520-630`):** `pruneRevokedSessions()` ist exportiert, wird aber im gesamten Produktionscode **nirgends aufgerufen** — `revokedSessions` und `rotatedTokens` wachsen unbegrenzt. Gleichzeitig liegt die Revocation-Liste nur im RAM: Nach einem Service-Restart (`systemctl restart ai-trading-firm`) ist jedes zuvor ausgeloggte Session-Cookie bis zu seinem `exp` (8 Stunden) wieder gültig!
  2. **Unbegrenzte Rate-Limit-Maps (`src/lib/apiAuth.ts:152-170`, `src/brokers/control-plane/guard.ts:75-85`):** Im Gegensatz zu `src/lib/loginRateLimit.ts` (das vorbildlich `MAX_BUCKETS = 10_000` + Sweeping nutzt) besitzen `buckets` in `apiAuth.ts` und `rateBuckets` in `control-plane/guard.ts` weder Größenobergrenze noch abgelaufenes Bucket-Pruning.
  3. **Memory-Leak in `BitunixExecutionAdapter.openOrders` (`src/brokers/bitunix/execution.ts:106, 183, 217-296`):** Jede platzierte Order wird in `this.openOrders` eingetragen, aber weder bei `FILLED`/`CANCELED` in `getOrderStatus()` noch in `cancelAllOrders()` wieder gelöscht.
- **Konkreter Lösungsvorschlag:**
  - `pruneRevokedSessions()` opportunistisch in `revokeSession`/`verifySessionToken` ausführen + Max-Cap erzwingen (optional Revocation-JTI in DB/Runtime-File spiegeln); `buckets` und `rateBuckets` auf `MAX_BUCKETS = 10_000` mit LRU-/TTL-Eviction begrenzen; abgeschlossene Orders in `BitunixExecutionAdapter` aus `this.openOrders` entfernen.
  - Details & Umsetzungspatch: [`findings/ASA-12-unbounded-memory-maps-dead-session-prune.md`](findings/ASA-12-unbounded-memory-maps-dead-session-prune.md) · Prompt: [`PROMPT-ASA-P2-09`](prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md).

---

### Befund ASA-13 — 34 verstreute `globalThis`-Singletons umgehen `stateRegistry.ts`; `FirmDashboard.tsx` (1.934 Zeilen) triggert unnötige Polling-Resets

- **Kategorie:** Architektur & Wartbarkeit
- **Schweregrad:** Mittel
- **Betroffene Datei(en) & Zeilen:** `src/lib/stateRegistry.ts:1-95`, `src/components/FirmDashboard.tsx:1-1934` (insb. Zeilen `386-395`)
- **Problembeschreibung:**
  1. **Unvollständige Singleton-Konsolidierung:** `src/lib/stateRegistry.ts` wurde eingeführt, um ad-hoc `globalThis.__*`-Zustände deterministisch zurücksetzbar und inspizierbar zu machen, registriert bislang aber nur 4 Einträge (`paperBroker`, `monitorState`, `firmKillSwitch`, `adaptiveRisk`), während **34 weitere Dateien** weiterhin eigene ungetrackte `globalThis.__*`-Felder anlegen (`__liveGateServiceSingleton`, `__microExecutorSingleton`, `__authSessionRevoked`, `__atfDbPool`, `__controlPlaneRateBuckets`, `__killSwitchNonces`, u. v. m.). Das erschwert deterministische Test-Resets und verdeckt zustandsbehaftete Abhängigkeiten.
  2. **God-Component & Polling-Jitter (`src/components/FirmDashboard.tsx:386-395`):** `FirmDashboard.tsx` vereint auf 1.934 Zeilen mehr als 30 `useState`-Hooks, Fetching, Modals, Tabs und Rendering. Der Polling-`useEffect` hängt von `[load, data.missions]` ab: Da `data.missions` bei jedem `GET /api/firm`-Poll eine **neue Array-Referenz** erhält, wird das `setInterval` bei jedem einzelnen Poll abgeräumt und neu gestartet; zudem pollt das Dashboard weiter im Hintergrund, wenn der Browser-Tab ausgeblendet (`document.visibilityState === "hidden"`) ist.
- **Konkreter Lösungsvorschlag:**
  - Verbleibende In-Memory-Singletons über `registerState()` in `stateRegistry.ts` führen (geschützt durch einen Architektur-Test gegen neue unregistrierte `globalThis.__`-Zugriffe).
  - In `FirmDashboard.tsx` den Polling-Effekt an das primitive Boolean `hasActiveMission` + `visibilitychange` koppeln und eigenständige Domänen-Panels/Hooks (`useFirmSnapshot`, Tab-Komponenten) extrahieren.
  - Details & Umsetzungspatch: [`findings/ASA-13-state-registry-drift-dashboard-god-component.md`](findings/ASA-13-state-registry-drift-dashboard-god-component.md) · Prompt: [`PROMPT-ASA-P2-10`](prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md).

---

## Niedrige Befunde (`LOW`)

### Befund ASA-14 — `deploy/micro-executor.service` fehlt jegliches `systemd`-Sandboxing und weicht bei Pfaden/User von der Haupt-Unit ab

- **Kategorie:** Sicherheit / Betrieb (Deployment)
- **Schweregrad:** Niedrig
- **Betroffene Datei(en) & Zeilen:** `deploy/micro-executor.service:7-24`, `deploy/ai-trading-firm.service:1-40`
- **Problembeschreibung:** Während `deploy/ai-trading-firm.service` sauber mit `NoNewPrivileges=true`, `PrivateTmp=true` und `ProtectSystem=strict` gehärtet ist, fehlen in `deploy/micro-executor.service` sämtliche `systemd`-Härtungsdirektiven (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem`, `ProtectHome`, `ReadWritePaths`, `RestrictSUIDSGID`). Darüber hinaus nutzt die Unit abweichende Platzhalter (`/path/to/ai-trading-firm`, `User=trader` statt `/opt/ai-trading-firm`, `User=atf`) und `RuntimeMaxSec=0`.
- **Konkreter Lösungsvorschlag:**
  - `deploy/micro-executor.service` an Pfade, Systembenutzer und Sandboxing-Direktiven von `deploy/ai-trading-firm.service` angleichen (`ReadWritePaths=/opt/ai-trading-firm/data /opt/ai-trading-firm/.runtime`).
  - Details & Umsetzungspatch: [`findings/ASA-14-systemd-micro-executor-hardening.md`](findings/ASA-14-systemd-micro-executor-hardening.md) · Prompt: [`PROMPT-ASA-P2-10`](prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md).

---

### Befund ASA-15 — Synchrone Datei-I/O in `FileAlertSink` und unvalidierte Ziel-URLs (`http://`, Loopback, Link-Local) in `WebhookAlertSink`

- **Kategorie:** Sicherheit / Performance
- **Schweregrad:** Niedrig
- **Betroffene Datei(en) & Zeilen:** `src/lib/alerts.ts:264-335`
- **Problembeschreibung:**
  1. `FileAlertSink.emit()` (`src/lib/alerts.ts:276-281`) führt bei jedem Alert synchron `mkdirSync` und `appendFileSync` auf dem Haupt-Event-Loop aus.
  2. `WebhookAlertSink` (`src/lib/alerts.ts:300-335`) akzeptiert jede beliebige URL ohne Schema- oder Zielnetzprüfung — Fehlkonfigurationen erlauben unverschlüsselte `http://`-Webhooks oder SSRF-Aufrufe gegen Cloud-Metadaten-Endpunkte (`169.254.169.254`), Loopback (`127.0.0.1`, `::1`) oder interne Dienste wie Ollama (`127.0.0.1:11434`).
- **Konkreter Lösungsvorschlag:**
  - `FileAlertSink` auf `node:fs/promises` (`mkdir` einmalig gecacht + `appendFile`) umstellen; in `WebhookAlertSink` standardmäßig `https:` erzwingen und Loopback-/Link-Local-/RFC1918-Ziele abweisen (lokales Override nur über explizites Flag für lokale Tests).
  - Details & Umsetzungspatch: [`findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md`](findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md) · Prompt: [`PROMPT-ASA-P2-10`](prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md).

---

## Priorisierungsmatrix

| Priorität | Befunde | Ziel | Prompts |
|-----------|---------|------|---------|
| **P0 — Sofort (Blocker)** | `ASA-01`, `ASA-02`, `ASA-03` | Prozessübergreifender Kill-Switch & korrekte PnL-Buchung, echte Rollen-/Vier-Augen-Prüfung, Fail-Closed im Alpaca-Live-Adapter | [`P0-01`](prompts/PROMPT-ASA-P0-01-multiprocess-ledger-killswitch-pnl.md), [`P0-02`](prompts/PROMPT-ASA-P0-02-lifecycle-authz-foureyes-livekill.md), [`P0-03`](prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md) |
| **P1 — Kurzfristig** | `ASA-04`, `ASA-05`, `ASA-06`, `ASA-07`, `ASA-08`, `ASA-09` | Deterministischer `MicroExecutor`, geschlossene API-Auth/RBAC/CSRF-Decke, DoS-Schutz & stabile Audit-Kette, sicheres Proxy-IP-Handling, skalierbarer `HistoricalStore` | [`P1-04`](prompts/PROMPT-ASA-P1-04-micro-executor-cooldown-burst-hotreload.md), [`P1-05`](prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md), [`P1-06`](prompts/PROMPT-ASA-P1-06-portfolio-dos-and-livegate-audit-sync.md), [`P1-07`](prompts/PROMPT-ASA-P1-07-client-ip-proxy-trust-and-bind-hardening.md), [`P1-08`](prompts/PROMPT-ASA-P1-08-historical-store-partitioning-and-streaming.md) |
| **P2 — Mittelfristig** | `ASA-10`, `ASA-11`, `ASA-12`, `ASA-13`, `ASA-14`, `ASA-15` | Fail-Closed LLM-Fallback, korrekte Drawdown-Alerts, DB-Indizes, beschränkte Caches, zentrale `stateRegistry`, sauberes Dashboard-Polling, gehärtetes `systemd` & SSRF-freier Alert-Sink | [`P2-09`](prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md), [`P2-10`](prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md) |
