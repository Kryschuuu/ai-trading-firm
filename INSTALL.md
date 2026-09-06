# Installation — Übersicht

> **Status:** Kanonische Installationsanleitung ist jetzt in [`docs/INSTALL.md`](docs/INSTALL.md) (CachyOS, Variante A/B, Schritt für Schritt).  
> **Flag-Referenz:** Alle Env-Flags mit sicheren Defaults stehen in [`CONFIGURATION.md`](CONFIGURATION.md).  
> **Windows:** [`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md)  
> **Code-Version:** v1.36.31

Diese Datei ist ein kurzer Einstieg — Details in den verlinkten Dokumenten.

## Schnellstart (CachyOS, empfohlen)

```bash
git clone https://github.com/Kryschuuu/ai-trading-firm.git
cd ai-trading-firm
./scripts/setup-cachyos.sh --variant a     # Variante A: alles auf einem Rechner
```

Das Skript installiert Node/PostgreSQL, legt Rolle und Datenbank an, schreibt `.env` inkl. `FIRM_API_TOKEN` und separat erzeugtem `FIRM_SESSION_SECRET` (Recht `600`), spielt das Schema ein, seedet das Markt-Universum (354 Instrumente), aktiviert Short-Selling, baut die App und führt 18 Validierungs-Checks aus. Idempotent, wiederholbar.

**Optionen:** `--dry-run`, `--non-interactive`, `--no-shorts`, `--sync-markets`, `--skip-build`, `--min-pass 18`, `--help`.  
**Log:** `data/setup/setup-<Zeitstempel>.log`.

Siehe [docs/INSTALL.md](docs/INSTALL.md) für vollständige Anleitung (Kapitel 0–8, Varianten A/B, Troubleshooting).

## Manuell / anderes System

```bash
cp .env.example .env        # Pflicht-Flags setzen (DATABASE_URL)
umask 077
printf 'FIRM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'FIRM_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
chmod 600 .env
npm ci
npx drizzle-kit push        # Schema einspielen
npm run universe:seed:markets
npm run universe:seed
npm run build
npm run start               # http://0.0.0.0:3369
./scripts/validate-setup.sh
```

Details: [CONFIGURATION.md](CONFIGURATION.md) (Flag-Tabelle), [docs/HANDBUCH.md](docs/HANDBUCH.md) (Bedienung), [docs/SETUP_BUGS.md](docs/SETUP_BUGS.md) (Befunde).

## Produktions-Sicherheit / Upgrade auf v1.36.31

**SEC-02:** Die sensitiven Dashboard-Reads für Firmenstatus, Protokoll, Report,
Regeln, Provider und Routing verlangen `firm.read` und antworten mit
`Cache-Control: private, no-store`. Alle Instanzen ausrollen und neu starten;
direkte Clients senden für diese sechs GET-Endpunkte ein vorhandenes Viewer-,
Operator- oder Admin-Credential. Browser verwenden ihre signierte HttpOnly-
Session automatisch. [Upgrade-Runbook](docs/security/README.md#sensible-dashboard-read-apis-sec-02).

**SEC-04:** Die WebSocket-Bibliothek `ws` ist exakt auf 8.21.3 gepinnt; ältere
Stände sind verwundbar. Ausschließlich mit `npm ci` aus dem Lockfile
installieren, danach `npm ls ws --all` und `npm run test:security:ws` ausführen
und alle Prozesse neu starten. [Upgrade-Runbook](docs/security/README.md#ws-upgrade-sec-04).

**SEC-03:** Next.js 16.3.4 und die native Decoder-Kette müssen gemeinsam aus dem
Lockfile installiert werden. Vor Deployment `npm ci`,
`npm run test:security:next` und einen frischen Build ausführen; alle Instanzen
neu starten. [Vollständiges Upgrade-Runbook](docs/security/README.md#nextjs-upgrade-sec-03).
Die folgenden Session-Anforderungen aus v1.36.27 gelten weiterhin.

`NODE_ENV=production` benötigt im Token-Betrieb ein unabhängiges
`FIRM_SESSION_SECRET` (mindestens 32 zufällige Zeichen, empfohlen separat
`openssl rand -hex 32`). Der Installer ergänzt fehlende Schlüssel; bestehende
Werte niemals durch Login-Tokens ersetzen. Fehlende/ungültige Schlüssel verweigern
den Start (`SESSION_SECRET_REQUIRED` / `SESSION_SECRET_INVALID`).
`AUTH_MODE=local-open` ist nur für bewusst offenen Lokalbetrieb ohne Tokens gedacht,
nicht als Reparatur einer fehlerhaften Produktionskonfiguration.

Beim Upgrade von Versionen vor v1.36.27 alle Instanzen mit der neuen Konfiguration
neu starten und erneut anmelden; deren alte Session-Cookies werden nicht übernommen. Browser-Login in Produktion
benötigt HTTPS. Vorab: `NODE_ENV=production npm run boot:guard` (liest `.env`,
Prozess-Env hat Vorrang). Details: [CONFIGURATION.md](CONFIGURATION.md#session-sicherheit-sec-01-v13627).

## Voraussetzungen

- **CachyOS** (Arch-basiert) — Setup-Skript zielt auf CachyOS/Arch
- **Node.js ≥ 20**, npm
- **PostgreSQL**
- Optional: Ollama oder anderer LLM-Provider

## Weiterführende Docs

- [docs/README.md](docs/README.md) — Doku-Index
- [CONFIGURATION.md](CONFIGURATION.md) — Env-Flags
- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) — Windows
- [docs/HANDBUCH.md](docs/HANDBUCH.md) — Bedienung
