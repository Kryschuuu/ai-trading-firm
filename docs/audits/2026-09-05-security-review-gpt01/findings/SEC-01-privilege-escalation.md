# SEC-01 — Privilege Escalation über signierte Session

- **ID:** SEC-01
- **Severity:** CRITICAL
- **Bereich:** AuthN / AuthZ / Session
- **Quelle:** Security Review-GPT_01.md, Kapitel SEC-01 — Privilege Escalation über signierte Session
- **Status:** FIXED (2026-09-06)
- **Fix-Version:** 1.36.27
- **Betroffene Versionen:** 1.36.23–1.36.26
- **Datei(en):** `src/lib/authSession.ts`, `src/app/api/auth/login/route.ts`, `src/auth/resolve.ts`, `src/lib/apiAuth.ts`, `src/auth/authMode.ts`, `src/auth/permissions.ts`; zugehörige Boot-/Setup-Skripte, Tests und Konfigurationsdokumentation
- **Fix-Commit:** [3dfede1](https://github.com/Kryschuuu/ai-trading-firm/commit/3dfede16ced729f1583e37305690df95a569e16e)
- **Red-Test-Commit:** [e4b883f](https://github.com/Kryschuuu/ai-trading-firm/commit/e4b883faf8e95c0a39392525d488c6ea7e57a166)

> Beschreibung und PoC unten dokumentieren den ursprünglichen verwundbaren Stand.
> Die Behebung und deren Grenzen sind unter „Implementierter Fix“ festgehalten.

## Beschreibung

Der kritischste Befund steckt in `authSession.ts`.

Der Session-Signaturschlüssel ist optional unabhängig konfigurierbar (`FIRM_SESSION_SECRET`). Fehlt dieser, wird der HMAC-Schlüssel **deterministisch aus den konfigurierten Auth-Tokens** abgeleitet (Tokens aneinandergereiht, SHA-256).

`verifySessionToken()` prüft HMAC, Payload-Schema, Ablauf und dass Permissions aus der erlaubten Permission-Liste stammen — **aber nicht**, dass die `permissions` zur behaupteten Rolle gehören. `effectiveRole` wird nicht erneut aus der aktuellen Auth-Konfiguration abgeleitet.

`sessionActor()` übernimmt Rolle, Elevation und Permissions 1:1 aus dem Cookie-Payload.

Die Login-Route akzeptiert ausdrücklich auch Viewer-Credentials und stellt daraus eine signierte Session aus. Kennt der Viewer sein eigenes Token **und** fehlt `FIRM_SESSION_SECRET`, kennt er das Material für `sessionSecret()`.

Ein gültig signiertes, aber vom Viewer selbst erzeugtes Admin-Payload wird als Autorität akzeptiert.

## Beweis / PoC

Angenommen:

```env
FIRM_VIEWER_TOKEN=<redacted>
FIRM_SESSION_SECRET=
FIRM_ADMIN_TOKEN=
FIRM_API_TOKEN=
```

Der Viewer kennt den HMAC-Schlüssel. Ein Payload der Form

```json
{
  "role": "admin",
  "effectiveRole": "admin",
  "permissions": [
    "firm.read",
    "firm.write",
    "firm.kill",
    "firm.config",
    "broker.credentials",
    "routing.modes.write",
    "live.gate"
  ]
}
```

wird akzeptiert, sofern HMAC und Schema stimmen. Es fehlt die Relation: `role=admin` muss von einem tatsächlich adminberechtigten Credential stammen.

```ts
// src/lib/authSession.ts — sessionSecret() fällt auf Token-Material zurück
const override = (env.FIRM_SESSION_SECRET ?? "").trim();
if (override) return override;
const material = [env[ADMIN_TOKEN_FLAG], env[OPERATOR_TOKEN_FLAG], env[VIEWER_TOKEN_FLAG]]
  .filter((s): s is string => typeof s === "string" && s.length > 0)
  .join("\x00");

// sessionActor() vertraut dem Cookie
permissions: payload.permissions
```

Auswirkungen bei dieser Konfiguration: Viewer kann potentiell `firm.write`, `firm.kill`, `firm.config`, `broker.credentials`, `routing.modes.write`, `live.gate` erlangen.

## Remediation (aus Audit + eigene Bewertung)

1. In Produktion `FIRM_SESSION_SECRET` **verpflichtend** machen und als unabhängiges Secret behandeln.
2. `sessionActor()` darf keine frei im Cookie gespeicherten Permissions als Autorität betrachten. Beim Verifizieren:
   ```ts
   const expectedPermissions = permissionsForRole(payload.effectiveRole);
   if (!samePermissionSet(payload.permissions, expectedPermissions)) {
     return null;
   }
   ```
3. Noch robuster: `role`, `effectiveRole`, `elevated`, Permissions serverseitig neu ableiten — nicht als Session-Autorität behandeln.
4. Session sollte `authEpoch` / Credential-Version enthalten, damit Rotation/Revocation greift (siehe SEC-08).

## Akzeptanzkriterien / Tests

- [x] Pflicht-Test: nur `FIRM_VIEWER_TOKEN` gesetzt → Viewer darf niemals eine gültige Session mit `firm.write` oder `live.gate` erzeugen
- [x] `verifySessionToken` / `sessionActor` lehnt Permissions ab, die nicht zur Rolle gehören
- [x] Produktion ohne `FIRM_SESSION_SECRET` startet nicht bzw. stellt keine Sessions aus
- [x] `FIRM_SESSION_SECRET` ist unabhängig von Viewer-/Operator-/Admin-Tokens
- [x] Regression: gültige Admin-/Operator-Sessions funktionieren weiterhin

## Implementierter Fix (v1.36.27)

- **Unabhängige Signierung:** kein aus Auth-Tokens abgeleiteter Fallback mehr,
  auch nicht in Dev. Der gemeinsame Konfigurationsprüfer lehnt fehlende, zu kurze
  oder als Login-Token wiederverwendete Schlüssel ab. Produktion im Token-Betrieb
  verweigert den Start; der Login-Pfad liefert unabhängig davon HTTP 503 ohne Cookie.
  `local-open` stellt niemals Sessions aus und wird nicht aus einem fehlenden Key
  abgeleitet. Setup erzeugt fehlende Schlüssel separat und erhält vorhandene Werte.
- **Kein Berechtigungs-Snapshot:** Schema v2 speichert nur Credential-Selektor,
  gebundene Konfigurationsversion (`authEpoch`), CSRF-Wert und Zeitgrenzen. Alte
  Cookies und zusätzliche Autorisierungsfelder werden verworfen. Alle Rechte,
  Elevation und Audit-ID kommen aus demselben serverseitigen Rollen-Builder wie
  beim Header-Login; `resolveAuth` und `checkApiToken` akzeptieren nur diese Projektion.
- **Aktuelle Credential-Bindung:** die keyed, domain-separated Version bindet
  den Selektor an die aktuelle Token-Konfiguration, ohne Tokens oder unkeyed
  Token-Hashes im Cookie abzulegen. Fehlendes Credential, Rotation/Entfernung eines
  Tokens, geänderte Admin-Konfiguration oder Rollendegradierung invalidieren alte
  Sessions. Ein fremder Credential-Selektor kann die Bindung nicht übernehmen.
- **Fail-closed Grenzen:** striktes Schema, erlaubte Credential-IDs, TTL-Obergrenze,
  exakte Ablaufgrenze, begrenzte Cookie-Größe und Ablehnung mehrdeutiger Cookies.
  Login authentifiziert ausschließlich das eingereichte Token; bestehende Cookies
  oder mitgesendete Rollenfelder stellen keine neue Session-Autorität dar.
- **Kompatibilität:** Admin, Operator und die bestehende explizite Single-Admin-
  Policy funktionieren weiterhin. Header-Authentifizierung, 15-Minuten-TTL,
  HttpOnly/Secure/SameSite und session-gebundenes CSRF bleiben erhalten.
  Keine neuen Abhängigkeiten und kein neuer Session-Store.

### Deployment / verbleibende Grenzen

Vor dem Upgrade einen unabhängigen `FIRM_SESSION_SECRET` konfigurieren
(empfohlen separat `openssl rand -hex 32`, mindestens 32 Zeichen). Alle Instanzen
mit gleicher Auth-Konfiguration auf v1.36.27 neu starten; kein gemischter Altbetrieb.
**Erneuter Login ist erforderlich.** Produktion verlangt weiterhin HTTPS für
Browser-Sessions. Anleitung: [CONFIGURATION.md](../../../../CONFIGURATION.md#session-sicherheit-sec-01-v13627).

Revocation greift, sobald die neue Konfiguration im jeweiligen Prozess aktiv ist;
bei mehreren Instanzen ist sie überall auszurollen. Frühere Credentials/Keys nicht
wiederverwenden. Individuelles Logout/Explizit-Revoke bleibt Restumfang von
[SEC-08](SEC-08-session-revocation.md), nicht Teil dieses Fixes. Andere Findings
werden durch die Behebung von SEC-01 nicht automatisch geschlossen.

### Validierung

- **Vor Fix:** 14/14 neue Security-Regressionen auf unverändertem Anwendungscode
  rot (Red-Test-Commit oben), einschließlich der beiden Autorisierungspfade.
- **Nach Fix:** `npm run test:security:auth` — **101/101 grün**, keine Skips;
  Session-Modul separat gemessen: **98,55 % Zeilendeckung**. Enthält echte
  Login-/API-Guard-Aufrufe, Rollenmatrix, Credential-Wechsel, CSRF und Boot-/Setup-
  Kindprozesse. Windows-Installer hier per Verdrahtungstest, nicht nativ ausgeführt.
- `npm run typecheck`, `npm run lint`, `npm run docs:validate` und
  `node --import tsx scripts/scan-live-gate-secrets.ts` lokal erfolgreich.
- `npm run security:live-gate`: Auth-Suite plus **78/78 Live-Gate-Tests**;
  Live-Gate-Zeilendeckung **95,68 %** (bestehendes CI-Tor ≥95 %).
- `npm run build` erfolgreich; drei Tracing-Warnungen in unveränderten Modulen
  (`auditSink.ts`, `docsCatalog.ts`).
- Gesamtlauf `npm test`: **1810 Tests**, 1798 bestanden, 7 infrastrukturbasierte
  Skips, 5 Fehler in bestehenden Doku-Pfadtests. Dieselben fünf Fehler auf dem
  Ausgangscommit `f2c895e` reproduziert (`docsVersioning`, `portfolio.architecture`,
  `task10.architecture`); keine SEC-01-Regression und kein sachfremdes Refactoring.

## Changelog-Blurb

```
SEC-01 (CRITICAL): Privilege Escalation — Session-HMAC unabhängig vom Viewer-Token; Permissions serverseitig neu ableiten
```

## Versions-Hinweis

PATCH, Security-Fix — vor Live-Trading zwingend.
