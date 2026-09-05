# SEC-04 — `ws` erlaubt mehrere aktuell verwundbare Versionen

- **ID:** SEC-04
- **Severity:** HIGH
- **Bereich:** Dependencies / Supply Chain
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-04 — `ws` erlaubt mehrere aktuell verwundbare Versionen
- **Status:** OPEN
- **Fix-Version:** -
- **Datei(en):** `package.json`, `package-lock.json`, `src/brokers/bitunix/ws.ts`
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

## Beweis

```json
"ws": "^8.18.0"
```

```bash
npm ls ws
npm audit --json
# Erwartet: >= 8.21.0
# Range ^8.18.0 schließt <8.21.0 ein
```

## Remediation (aus Audit + eigene Bewertung)

Mindestens:

```json
"ws": "^8.21.0"
```

Lockfile regenerieren. Noch besser: aktuelles gepatchtes Release und danach

```bash
npm ls ws
npm audit
```

als CI-Check erzwingen. WebSocket-Tests (`tests/bitunix.ws.test.ts`) müssen grün bleiben.

## Akzeptanzkriterien / Tests

- [ ] Aufgelöste `ws`-Version ≥ 8.21.0
- [ ] `package.json` lässt keine Version `<8.21.0` zu
- [ ] `npm audit` ohne High/Critical für `ws`
- [ ] Bitunix-WS-Tests grün
- [ ] Changelog mit CVE-Referenzen

## Changelog-Blurb

```
SEC-04 (HIGH): ws auf >=8.21.0 aktualisiert (CVE-2026-48779, CVE-2026-45736)
```

## Versions-Hinweis

PATCH, Dependency-Fix — sofort.
