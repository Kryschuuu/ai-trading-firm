# ASA-08 — Verifikation v0.17.4

**Stand:** 2026-10-28 · **Status:** FIXED ·
[Finding](../findings/ASA-08-trusted-proxy-x-verified-ip-0000-bypass.md) ·
[Tracking](TRACKING.md)

## Sicherheitsvertrag

- Fetch-Peer unbekannt: gültige CIDRs **und** korrektes Shared Secret nötig,
  sonst gemeinsamer `local`-Bucket. `HOSTNAME` ist kein Bind-Nachweis.
- Echter Socket-Peer: CIDR-Match ist maßgeblich; ein Secret überstimmt keinen Miss.
- XFF bleibt socket-only; `x-real-ip` bleibt ignoriert. Ungültige CIDRs erlauben
  keinen impliziten Loopback-Fallback.
- CLI-Boot-Guard und Instrumentation verlangen bei gesetzten CIDRs ein gültiges
  Secret, auch auf Loopback; Builds benötigen keine Laufzeit-Secrets.
- Startskript und systemd binden explizit Loopback. `PORT`-Override bleibt erhalten.
- Das Shared Secret besteht aus unabhängigen Zufallsbytes, keine Login-/Session-Credentials,
  kein Logging/Reflektieren; geschützter Proxy-Upstream. Kein Replay-Schutz nach
  Secret-Verlust; Rotation in App und Proxy gemeinsam.

## Lokal ausgeführte Gates

| Prüfung | Ergebnis |
| --- | --- |
| `npx tsx --test tests/asa08.clientIpProxyTrust.test.ts tests/clientIp*.test.ts tests/authBootGuard*.test.ts` | 38 Tests bestanden, keine Skips |
| `npm run typecheck` | bestanden |
| `npm run lint` | bestanden |
| `npm run docs:inventories && npm run docs:inventories:check` | bestanden; neues Flag im Env-Inventar |
| `npm run docs:validate` | alle 14 Checks bestanden (L1–L4, Secrets, Links, Version, CI) |
| `BROKER_CONTRACTS_REQUIRE_DB=true npm test` | 4.893 Tests: 4.857 bestanden, 36 bestehende DB-abhängige Skips, keine Fehler; Embedded-PostgreSQL-Broker-Contracts verpflichtend |
| `npm run security:live-gate` | alle Teilsuiten bestanden, inkl. ASA-08; Live-Gate: 103 Tests, **97,75 %** Zeilendeckung (Tor ≥ 95 %) |
| `npm run ci:sync:check` | beide Workflow-Spiegel, SHA-Pins und Dependabot-Invarianten bestanden |
| `npm audit --audit-level=high --omit=dev` und `npm audit --audit-level=high` | Exit 0, keine High/Critical; Moderate-Restbefund unten |
| `npm ls ws --all` | ausschließlich gepinnte `ws@8.21.3` |
| `node --import tsx scripts/scan-live-gate-secrets.ts` | 31 Dateien, keine Funde |
| `npm run build` | erfolgreich; zwei bestehende Tracing-Warnungen unten |
| `npm run scan:secrets` | Frontend-Bundle ohne Secret-Muster |

## Echter Produktionsprozess (Next.js 16.4.3)

Nach dem Build wurde `npm run start` mit temporären, zufällig erzeugten
Auth-/Session-/Proxy-Secrets gestartet und anschließend wieder beendet.
Keine Secrets oder Build-/Testdaten werden versioniert.

- Authentisierter `GET /api/auth/me` mit gespoofter IP, ohne/falschem Proxy-Secret:
  `local`; mit passendem Secret wird `198.51.100.42` übernommen. Keine Secret-Werte in Antwort/Log.
- Echter `POST /api/auth/login`: 20 falsche Credentials mit 20 unterschiedlichen
  `X-Verified-IP`-Werten → HTTP 401; Versuche 21/22 → HTTP 429.
- Der **Next-Prozessgruppe gehörende** Listener wurde über Socket-Inodes in
  `/proc` als ausschließlich `127.0.0.1:3369` nachgewiesen. Arena legt zusätzlich
  einen separaten Preview-Relay auf der Sandbox-Netzschnittstelle an; deshalb ist
  ein externer Verbindungsversuch hier kein Nachweis für das App-Binding.
  Die LAN-Negativprobe ist im Zieldeployment nach `docs/INSTALL.md` zu wiederholen.

## Unveränderte Resthinweise (nicht ASA-08)

- Dependency-Audit: `postcss-selector-parser <6.1.5`
  ([GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)),
  über `@tailwindcss/typography`: npm zählt **2 Moderate-Pakete**. Kein blindes
  `npm audit fix --force`/Downgrade; separates Dependency-Review erforderlich.
- Build: dynamisches Dateisystem-Tracing in `src/cycle/ports.ts` und
  `src/live-gate/audit.ts`; außerdem erwarteter fehlgeschlagener DB-LISTEN ohne
  laufende App-Datenbank. Keine neue Node-/Edge-Warnung durch Proxy-Authentisierung.
- Live-Trading bleibt deaktiviert; keine echten Broker-Orders und keine
  Datenbankmigration. CI-Suite-Stamps erzeugt weiterhin nur der bestehende Workflow.
