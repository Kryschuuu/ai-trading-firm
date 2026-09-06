# SEC-04 — `ws` erlaubt mehrere aktuell verwundbare Versionen

- **ID:** SEC-04
- **Severity:** HIGH
- **Bereich:** Dependencies / Supply Chain
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-04 — `ws` erlaubt mehrere aktuell verwundbare Versionen
- **Status:** FIXED (2026-09-06)
- **Fix-Version:** 1.36.30
- **Betroffener Projektstand:** bis einschließlich v1.36.29 (`ws: ^8.18.0`); jede Installation, die außerhalb des Lockfiles aufgelöst wurde, zusätzlich prüfen
- **Datei(en):** `package.json`, `package-lock.json`, `src/brokers/bitunix/ws.ts`, `tests/sec04.wsDependency.test.ts`, `tests/sec04.wsRuntime.test.ts`, Security-Workflow und dessen Quelle unter `docs/ci/`; zugehörige Release-/Upgrade-Dokumentation
- **Fix-Commit:** [a131479](https://github.com/Kryschuuu/ai-trading-firm/commit/a1314793862d1a51e2664aac0a304aa0b46805a0)
- **Red-Test-Commit:** [52d5949](https://github.com/Kryschuuu/ai-trading-firm/commit/52d594922b0a12c0aca0906c478a371289ddf377)
- **Peer-Review-Patch:** TBD

## Beschreibung

`package.json` verwendet `ws: ^8.18.0` und damit eine Range, die mehrere verwundbare Versionen einschließt. Das Projekt führt `ws` als direkte Dependency (u. a. Bitunix-WebSocket).

### CVE-2026-48779

- betroffen: `>= 8.0.0 < 8.21.0`
- behoben: `8.21.0`
- Angriff: Netzwerk-Peer, keine Authentifizierung; durch extrem viele kleine WebSocket-Fragmente kann Speicher erschöpft und der Prozess beendet werden
- CVSS 7.5 ([GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p))

### CVE-2026-45736

- betroffen: `>= 8.0.0 < 8.20.1`
- behoben: `8.20.1`
- mögliche Offenlegung nicht initialisierten Speichers über eine bestimmte `websocket.close()`-Nutzung ([GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx))

Die exakte im Lockfile installierte `ws`-Version behandelt das Review als **Dependency-Risiko**, nicht als bereits bewiesene Laufzeit-Exploitation. Da `ws` direkt geführt wird, sollte das unmittelbar bereinigt werden.

## Root Cause (eigene Analyse vor dem Fix)

Root Cause ist **nicht** die zufällig installierte Datei, sondern die
**Deklaration im Manifest**: `^8.18.0` erlaubt jede 8.x-Version und damit
dauerhaft auch die verwundbaren Stände `< 8.21.0`. Das Lockfile löste zum
Prüfzeitpunkt zwar bereits `8.21.3` auf — es ist aber nur eine Momentaufnahme:

- `npm install`, `npm update`, ein regeneriertes oder aufgelöstes Lockfile,
  ein automatisiertes Dependency-Update oder eine Installation ohne Lockfile
  darf jederzeit wieder auf eine verwundbare Version fallen. Das Manifest ist
  der verbindliche Vertrag, nicht das Lockfile.
- Eine **transitive** Abhängigkeit konnte eine eigene, verschachtelte
  `ws`-Kopie mitbringen. Diese wäre weder vom direkten Pin noch von einem
  Blick in `npm ls ws` (ohne `--all`) erfasst worden.
- Es fehlte **jede durchsetzende Grenze**: kein Test, kein CI-Gate, keine
  Laufzeitprüfung. Ein Downgrade wäre still geblieben.

### Angriffsfläche und Vertrauensgrenzen

- `ws` ist die einzige Bibliothek des Projekts, die im Betrieb eine dauerhafte
  Verbindung zu einem **externen Netzwerk-Peer** hält: der öffentliche
  Bitunix-Market-Data-Stream (`src/brokers/bitunix/ws.ts`, Reconnect/Resubscribe).
  Der Datenpfad liegt vor jeder Auth-/RBAC-Prüfung — Login, CSRF und Rollen
  schützen ihn nicht.
- Der Angreifer muss dafür nicht die Venue kompromittieren: Es genügt eine
  Position im Netzwerkpfad (TLS-Terminierung, Proxy, DNS/Routing) oder eine
  manipulierte `BITUNIX_WS_URL`, die noch auf der Host-Allowlist liegt.
- **Vektor 1 (CVE-2026-48779):** Der Peer sendet eine nie beendete Nachricht aus
  sehr vielen kleinen Fragmenten. Der Client puffert sie, bis der Prozess an
  der Speichergrenze stirbt. Für eine Trading-Anwendung ist das nicht nur ein
  Ausfall, sondern der Verlust von Marktsicht bei offenen Positionen.
- **Vektor 2 (CVE-2026-45736):** Bestimmte `close()`-Nutzung kann nicht
  initialisierten Speicher preisgeben. Der Adapter ruft `close()` bewusst ohne
  Code/Reason-Argument auf; das ist ein glücklicher Umstand des aktuellen
  Codes, keine erzwungene Eigenschaft — daher zusätzlich testgesichert.
- **Vektor 3 (Downgrade nach dem Deployment):** Wer eine Instanz nach dem
  Ausrollen mit `npm install`/`npm update` „nachpflegt“, konnte die verwundbare
  Bibliothek zurückholen, ohne dass irgendetwas fehlschlug.
- Der Reconnect-Automatismus verstärkt Vektor 1: Nach einem Abbruch verbindet
  sich der Client erneut und kann erneut geflutet werden.

## Beweis am Ausgangsstand

```json
"ws": "^8.18.0"
```

```bash
npm ls ws
npm audit --json
# Erwartet: >= 8.21.0
# Range ^8.18.0 schließt <8.21.0 ein
```

Die neuen Regressionen waren vor dem Fix rot (**14 von 16**): fehlender exakter
Pin, fehlender Override, fehlender Laufzeit-Guard, fehlende Payload-Kappe,
fehlende CI-Verdrahtung. Es wurden keine echten Credentials und kein Zugriff auf
eine echte Venue benutzt; die Fragment-Flut läuft gegen einen lokalen Testserver.

## Implementierter Fix (v1.36.30)

1. **Exakter Pin statt Range:** `"ws": "8.21.3"` in `package.json`, Lockfile
   regeneriert (Registry-Artefakt mit SHA-512-Integrität). Der Mindestfix der
   Advisories ist 8.21.0; ausgeliefert wird der aktuelle stabile Patch.
2. **Transitive Kopien geschlossen:** npm-`overrides`-Eintrag `"ws": "8.21.3"`.
   Auch eine fremde Abhängigkeit kann keine verwundbare, verschachtelte Kopie
   mehr in den Baum ziehen.
3. **Fail-closed-Guard zur Laufzeit** (`src/brokers/bitunix/ws.ts`):
   `openHardenedWs()` liest die Version des tatsächlich installierten Pakets und
   öffnet nur bei exakter stabiler Version ≥ `MIN_WS_VERSION` einen Socket. Bei
   älterem, unklarem oder unlesbarem Stand: `BitunixApiError("disabled")`, kein
   Verbindungsversuch. Damit ist auch ein nachträgliches Downgrade abgedeckt.
4. **Harte Ressourcen-Grenzen am Client:** `maxPayload` 1 MiB (gilt für die
   Summe aller Fragmente einer Nachricht, zwei Größenordnungen unter dem
   Bibliotheks-Default), `perMessageDeflate: false`, `skipUTF8Validation: false`,
   `followRedirects: false` (sonst wäre die SSRF-Host-Allowlist umgehbar),
   `handshakeTimeout` 10 s. Defense in Depth, unabhängig von der Version.
5. **Verbindliches Gate:** `npm run test:security:ws` ist in
   `npm run security:live-gate` verkettet und läuft zusammen mit
   `npm ls ws --all` im Job `security-live-gate` vor Build und Suite.
   Workflow-Quelle in `docs/ci/` und ausgeführte Kopie bleiben byte-identisch.

Keine neue Abhängigkeit, kein neues Architekturmuster, keine Änderung an
Trading-Logik, Auth oder API-Verträgen.

## Regressionen und Validierung

- **Rot vor Fix:** 14/16 der neuen SEC-04-Tests scheiterten.
- **Grün nach Fix:** 16/16 ohne Skips.
- `tests/sec04.wsDependency.test.ts` — Versions-Gate lehnt Ranges, Tags, Aliase,
  Prereleases und Downgrades ab; exakter Pin, Override == Pin, Lockfile-Root-Spec,
  jeder (auch verschachtelte/aliased) Lockfile-Eintrag inklusive Registry-Quelle
  und SHA-512-Integrität, die tatsächlich aufgelöste Installation, Major-Linie der
  Typen sowie die verbindliche Skript-/Workflow-Verdrahtung.
- `tests/sec04.wsRuntime.test.ts` — Angreifersicht: Guard lehnt jede verwundbare
  oder unklare Version ab (kein Socket wird konstruiert), gehärtete Optionen
  werden an `ws` durchgereicht, `stop()` schließt ohne Reason-Argument, und eine
  **echte Fragment-Flut** roh geschriebener WebSocket-Frames gegen den echten
  `ws`-Client wird gekappt statt gepuffert (Verbindung schließt, kein
  Ticker-State, kein Nutzdaten-Ingest).
- Gegenprobe (Mutationstest): Wird die Payload-Kappe entfernt, schlägt der
  Fragment-Flut-Test fehl — der Test misst die Härtung, nicht sich selbst.
- `tests/bitunix.ws.test.ts` bleibt unverändert grün (4/4).
- `npm ci`, `npm ls ws --all` (`ws@8.21.3 overridden`), `npm audit`
  (**0 Vulnerabilities**), `npm run typecheck`, `npm run lint` und
  `npm run docs:validate` erfolgreich. Ein grünes `npm audit` allein genügt
  ausdrücklich nicht als Sicherheitsnachweis.
- Die Baseline-Suite (`npm test`) hatte bereits vor dieser Änderung bekannte
  Fehler in sachfremden Doku-Pfadtests; sie werden hier weder kaschiert noch
  durch Refactoring berührt.

## Akzeptanzkriterien / Tests

- [x] Aufgelöste `ws`-Version ≥ 8.21.0 (ausgeliefert: 8.21.3)
- [x] `package.json` lässt keine Version `<8.21.0` zu (exakter Pin + Override)
- [x] `npm audit` ohne High/Critical für `ws`
- [x] Bitunix-WS-Tests grün
- [x] Changelog mit CVE-Referenzen
- [x] Regressionen vor dem Fix rot, nach dem Fix grün
- [x] `npm ls ws` / `npm audit` als CI-Check erzwungen
- [x] Laufzeit-Downgrade-Pfad geschlossen (Fail-closed-Guard)

## Changelog-Blurb

```
SEC-04 (HIGH): ws auf >=8.21.0 aktualisiert (CVE-2026-48779, CVE-2026-45736)
```

## Deployment und verbleibende Grenzen

[Upgrade-Runbook](../../../security/README.md#ws-upgrade-sec-04): mit `npm ci`
aus dem geprüften Lockfile installieren, `npm ls ws --all` und
`npm run test:security:ws` ausführen, neu bauen und **alle** Prozesse neu
starten. Ein laufender Prozess behält die alte Bibliothek im Speicher; ein
Manifest-Update allein schützt bestehende Installationen nicht.

Der Versions-Floor ist ein gezielter SEC-04-Regressionsschutz und kein Beweis
der Fehlerfreiheit künftiger Releases; Advisories weiter beobachten. Die
Ressourcen-Kappen begrenzen den Schaden eines böswilligen Endpunkts, ersetzen
aber kein Update. Andere Findings, insbesondere SEC-02 und SEC-07, bleiben offen.

## Versions-Hinweis

PATCH, Security-Dependency-Fix — v1.36.30, sofort auf allen Instanzen ausrollen.
