# PROMPT-ASA-P2-10 — `stateRegistry` konsolidieren, `FirmDashboard` entkoppeln, `systemd` & Alert-Sinks härten

- **Befunde:** [`../findings/ASA-13-state-registry-drift-dashboard-god-component.md`](../findings/ASA-13-state-registry-drift-dashboard-god-component.md) (`MEDIUM`), [`../findings/ASA-14-systemd-micro-executor-hardening.md`](../findings/ASA-14-systemd-micro-executor-hardening.md) (`LOW`) & [`../findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md`](../findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md) (`LOW`)
- **Tracking:** [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
- **Anwendung:** Den folgenden Block vollständig in eine frische Coding-Session kopieren.

```text
Du arbeitest im Repository `ai-trading-firm` (TypeScript, Next.js 16 / React 19, `systemd`-Deployment).

AUFGABE: Behebe die verbleibenden Architektur-, UI- und Betriebs-Befunde `ASA-13` (34 verstreute `globalThis.__*`-Singletons außerhalb von `stateRegistry.ts` + Polling-Jitter & Monolith in `src/components/FirmDashboard.tsx`), `ASA-14` (fehlendes `systemd`-Sandboxing & Pfad-/User-Abweichung in `deploy/micro-executor.service`) und `ASA-15` (synchrone Datei-I/O in `FileAlertSink` + fehlender SSRF-/HTTPS-Schutz in `WebhookAlertSink`).

KONTEXT & IST-ZUSTAND (lies diese Dateien zuerst komplett):
1. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-13-state-registry-drift-dashboard-god-component.md`
2. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-14-systemd-micro-executor-hardening.md`
3. `docs/audits/2026-10-27-arch-security-audit/findings/ASA-15-alert-sinks-sync-io-webhook-ssrf.md`
4. `src/lib/stateRegistry.ts` und Ausgabe von `grep -rn "globalThis" src/`
5. `src/components/FirmDashboard.tsx` (insb. Polling-Effekt um Zeile 380–405 sowie Sektionsgrenzen)
6. `deploy/ai-trading-firm.service` und `deploy/micro-executor.service`
7. `src/lib/alerts.ts` (Zeilen 260–345) und bestehende Tests `tests/stateRegistry*.test.ts`, `tests/alerts*.test.ts`

VERBINDLICHE UMSETZUNGSSCHRITTE:
1. `ASA-13` (Teil A) — Prozess-Singletons über `src/lib/stateRegistry.ts` konsolidieren:
   - Sichte alle `globalThis.__*`-Zugriffe unter `src/`.
   - Binde alle fachlichen In-Memory-Caches/Singletons (Rate-Limit-Buckets, Nonce-Stores, Session-Caches, Live-Gate-/Executor-/Alert-Singletons usw.) sauber über `registerState(...)` (bzw. einen typsicheren Helper `getOrCreateRegisteredState(name, factory, resetFn)` in `src/lib/stateRegistry.ts`) an, sodass `resetAllRegisteredState()` in Tests deterministisch reinen Tisch macht.
   - Langlebige Infrastruktur-Ressourcen wie der PostgreSQL-Pool (`src/db/index.ts`), die bei einem fachlichen State-Reset nicht geschlossen werden dürfen, werden entweder als `scope: "infra"` markiert (`resetAllRegisteredState` lässt `infra` in Ruhe) oder in einer kleinen, explizit begründeten Allowlist im neuen Architektur-Wächtertest geführt.

2. `ASA-13` (Teil B) — `FirmDashboard.tsx` Polling-Stabilisierung & modulare Aufteilung:
   - Behebe den Polling-Bug in `src/components/FirmDashboard.tsx`: Berechne `const hasActiveMission = useMemo(() => data.missions.some((m) => m.status === "ACTIVE"), [data.missions]);`, hänge den Intervall-`useEffect` nur an `[load, hasActiveMission]` (nicht an das Array `data.missions`!) und pausiere Hintergrund-Polls, solange `document.visibilityState === "hidden"` ist (mit sofortigem Refresh beim Zurückwechseln auf `"visible"`).
   - Extrahiere mindestens 3 klar abgegrenzte, wiederverwendbare Sub-Module unter `src/components/firm/` (z. B. Polling-Hook `useFirmPolling.ts` + eigenständige Darstellungs-Sektionen/Modals), ohne Props, CSS-Klassen, Texte oder Bedienverhalten des Dashboards zu verändern (`npm run build` muss fehlerfrei kompilieren!).

3. `ASA-14` — `deploy/micro-executor.service` härten & angleichen:
   - Gleiche `User=atf`, `Group=atf`, `WorkingDirectory=/opt/ai-trading-firm` und `EnvironmentFile=/opt/ai-trading-firm/.env` an `deploy/ai-trading-firm.service` an, entferne `RuntimeMaxSec=0` und ergänze dieselben Härtungsdirektiven (`NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `RestrictSUIDSGID=true`, `ReadWritePaths=/opt/ai-trading-firm/data /opt/ai-trading-firm/.runtime`).
   - Prüfe per `grep -rn "micro-executor.service" docs/`, ob ein Handbuchtext einen alten Pfad zitiert, und halte die Dokumentation konsistent.

4. `ASA-15` — Asynchroner `FileAlertSink` & SSRF-geschützter `WebhookAlertSink` (`src/lib/alerts.ts`):
   - Stelle `FileAlertSink.emit()` von `mkdirSync`/`appendFileSync` auf `mkdir` (einmalig pro Instanz gecachtes Promise) + `appendFile` aus `node:fs/promises` um.
   - Härte `WebhookAlertSink`:
     a) Erlaube standardmäßig ausschließlich `https:`-URLs (optionales Konstruktor-Flag `allowInsecureLocal?: boolean` nur für explizite lokale Loopback-Unit-Tests).
     b) Blockiere ohne `allowInsecureLocal` zuverlässig `localhost`, `.local`, IPv4-Loopback (`127.0.0.0/8`), Link-Local / Cloud-Metadata (`169.254.0.0/16`), RFC1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), `0.0.0.0/8` sowie IPv6-Loopback/Unique-Local/Link-Local (`::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:...`) — inklusive DNS-Rebinding-Schutz via `dns.lookup(..., { all: true })` vor dem Versand!
     c) Setze `redirect: "error"` beim `fetch()`-Aufruf, damit kein `https:`-Ziel per `302` auf `http://169.254.169.254` weiterleiten kann.

5. Audit-Abschluss dokumentieren:
   - Setze `ASA-13`, `ASA-14` und `ASA-15` in ihren Finding-Dateien, `docs/audits/2026-10-27-arch-security-audit/README.md` und `remediation/TRACKING.md` auf `FIXED` (sind zu diesem Zeitpunkt auch `ASA-01..ASA-12` `FIXED`, kann der Gesamtstatus des Audits auf `CLOSED` gesetzt werden).

PFLICHT-TESTS & VERIFIKATION:
1. Erstelle `tests/asa13_14_15.architectureOpsAlerts.test.ts`:
   - Statischer Wächtertest: Kein `src/**`-Modul außerhalb von `src/lib/stateRegistry.ts` (und der minimalen `infra`-Allowlist) greift direkt auf neue unregistrierte `globalThis.__*`-Felder zu.
   - Statischer Test für `deploy/micro-executor.service`: Prüft `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `User=atf` und Abwesenheit von `/path/to/` sowie `RuntimeMaxSec=0`.
   - Unit-Tests für `FileAlertSink` (asynchrones Schreiben mehrerer Alerts) und `WebhookAlertSink` (blockiert `http://`, `https://127.0.0.1`, `https://169.254.169.254`, `https://[::ffff:127.0.0.1]` und Redirects; erlaubt verifizierte öffentliche `https://`-Ziele bzw. Test-Loopback nur mit `allowInsecureLocal: true`).
2. Führe aus und halte alles grün:
   - `npx tsx --test tests/asa13_14_15.architectureOpsAlerts.test.ts tests/alerts*.test.ts tests/stateRegistry*.test.ts`
   - `npm run typecheck`
   - `npm run lint`
   - `npm run build`
   - `npm run docs:validate`
   - `npm test`
```
