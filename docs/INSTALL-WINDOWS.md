# Windows-Installation (PowerShell, Schritt für Schritt)

Diese Anleitung installiert das Projekt **von Grund auf** auf Windows 10/11. Der
Ablauf ist wiederholbar und schützt eine vorhandene `.env` durch ein Backup. Das
System bleibt dabei strikt im Paper-Trading: `LIVE_TRADING_ENABLED=false`,
`BITUNIX_ENABLED=false` und `REQUIRE_HUMAN_APPROVAL=true` werden gesetzt.

> **Kein echtes Geld:** Das Projekt ist für Paper-Trading ausgelegt. Keine Broker-
> Schlüssel eintragen und Live-Trading nicht aktivieren.

## 1. Voraussetzungen

* Windows 10 (1809 oder neuer) bzw. Windows 11, 64 Bit
* Internetzugang und ein Windows-Benutzer mit Rechten, Software zu installieren
* PowerShell 5.1 (Windows PowerShell) oder PowerShell 7
* mindestens 8 GB RAM (für Ollama/LLM besser 16 GB), etwa 10 GB freier Speicher
* `winget` / **App Installer** aus dem Microsoft Store. Fehlt `winget`, siehe
  [Workaround A](#workaround-a-winget-fehlt).

Die Datenbank läuft lokal auf `127.0.0.1:5432`; sie muss nicht im LAN geöffnet
werden. Ollama ist optional. Ein Cloud-Provider wird nicht automatisch aktiviert.

## 2. Ein-Befehl-Installation aus dem Nichts

Öffne PowerShell **nicht** zwingend als Administrator und führe diese eine Zeile
aus. Sie installiert Git, klont das Repository und startet den interaktiven
Installer:

```powershell
winget install --id Git.Git --exact --accept-source-agreements --accept-package-agreements; if (-not (Test-Path "$HOME\ai-trading-firm\.git")) { git clone https://github.com/Kryschuuu/ai-trading-firm.git "$HOME\ai-trading-firm" }; Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force; Set-Location "$HOME\ai-trading-firm"; & .\scripts\setup-windows.ps1
```

Beantworte anschließend die Fragen:

1. **Paper-Trading bestätigen:** `J` wählen.
2. **PostgreSQL-superuser Passwort:** das beim PostgreSQL-Installer vergebene
   Passwort für `postgres` eingeben.
3. **Datenbankpasswort:** ein neues Passwort mit mindestens 12 Zeichen für
   `trader` eingeben. Es wird URL-kodiert in `.env` gespeichert.
4. **Ollama:** `J`, wenn lokale KI gewünscht ist. Das Skript lädt anschließend
   das Standardmodell; bei schwacher Hardware `N` wählen.
5. Eine erfolgreiche Installation endet mit `INSTALLATION ERFOLGREICH`.

Die Eingaben werden nicht ins Log geschrieben. Das Log liegt unter
`data\setup\setup-windows-<Zeitstempel>.log`; die `.env` ist von Git ignoriert.

## 3. Was das Script erledigt

`scripts/setup-windows.ps1` führt diese Schritte mit klaren Fehlern und Fix-
Hinweisen aus:

1. `winget`, Windows-Version, Node.js **>= 20** und npm prüfen.
2. Git und Node.js LTS nachinstallieren; den PATH nach der Installation neu lesen.
3. PostgreSQL 17 nachinstallieren, den Windows-Dienst starten und den Port prüfen.
4. Rolle `trader` und Datenbank `trading_firm` idempotent anlegen.
5. `.env` mit Paper-/Sicherheitsdefaults, API-Token, unabhängigem `FIRM_SESSION_SECRET` und lokalem `DATABASE_URL`
   schreiben. Eine vorhandene Datei wird vorher als `.env.bak-<Zeitstempel>` gesichert.
6. `npm ci`, `npx drizzle-kit push` und beide Universe-Seeds ausführen (354
   kuratierte Marktinstrumente plus Basis-Universum).
7. Optional Ollama installieren und das Modell laden.
8. `npm run typecheck`, `npm run lint`, `npm run build` und einen Health-Check
   auf `/api/health` ausführen.

Der Installer startet die App nur kurz für den Health-Check und beendet sie danach.
**SEC-01 / v1.36.27:** Produktion mit Tokens benötigt zusätzlich einen unabhängigen
Session-Schlüssel (mindestens 32 Zeichen). Der Installer ergänzt einen fehlenden
`FIRM_SESSION_SECRET` auch mit `-KeepExistingEnv`, überschreibt aber keine vorhandenen
Werte. Bei manuellem Upgrade einen eigenen Zufallswert erzeugen (Node ist vorhanden):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Den Wert nur in `.env` als `FIRM_SESSION_SECRET` speichern, nicht als Login-Token
nutzen oder in Logs/Tickets kopieren. Bestehende leere/ungültige Einträge ausdrücklich
korrigieren. Fehlende/ungültige Werte verweigern den Start und Browser-Login
(`SESSION_SECRET_REQUIRED` / `SESSION_SECRET_INVALID`). Alle App-Prozesse nach dem
Upgrade neu starten; alte Cookies erfordern neuen Login. Browser-Login in Produktion
benötigt HTTPS. Details: [CONFIGURATION.md](../CONFIGURATION.md#session-sicherheit-sec-01-v13627).

Für den normalen Betrieb:

```powershell
Set-Location "$HOME\ai-trading-firm"
npm run start
# Browser: http://127.0.0.1:3369
```

> Hinweis: Das Projekt nutzt im `package.json` für `dev`/`start` POSIX-Variablen-
> syntax. Der Installer umgeht das beim Health-Check korrekt mit
> `npx next start -H 127.0.0.1 -p 3369`. Für einen anderen Port direkt verwenden:
> `npx next start -H 127.0.0.1 -p 3370`.

## 4. Wiederholen, Optionen und sichere Reparatur

Ein erneuter Lauf ist sicher. Für eine vorhandene, bewusst beizubehaltende
Konfiguration (bestehende Werte bleiben erhalten, ein fehlender Session-Key wird ergänzt):

```powershell
.\scripts\setup-windows.ps1 -KeepExistingEnv
```

Nützliche Varianten:

```powershell
# Schnelllauf ohne Ollama, Build/Health aber weiterhin prüfen
.\scripts\setup-windows.ps1 -SkipOllama

# CI-/Automationsmodus: keine Fragen (Secrets müssen Parameter sein)
.\scripts\setup-windows.ps1 -NonInteractive -SkipOllama `
  -DbPassword "<mindestens-12-Zeichen>" `
  -PostgresSuperPassword "<postgres-passwort>"

# Nur Abhängigkeiten/DB/Seed, wenn Build lokal nicht möglich ist
.\scripts\setup-windows.ps1 -SkipBuild -SkipValidation
```

Passwörter als Parameter können in der PowerShell-History auftauchen. Für
produktive Rechner deshalb interaktiv eingeben oder die Parameter aus einem
sicheren Secret-Management übergeben.

## 5. Fehlerbehebung und Weitergehen

Das Script bricht bei einem kritischen Fehler ab und nennt den nächsten Befehl.
Zusätzlich gilt:

| Meldung/Symptom | Ursache | Fix, dann weiter |
|---|---|---|
| `winget` fehlt | App Installer fehlt oder ist veraltet | [Workaround A](#workaround-a-winget-fehlt), danach Script erneut starten |
| `git/node/psql` fehlt nach Installation | PATH wurde in der alten Shell geladen | PowerShell schließen, neu öffnen, `cd $HOME\ai-trading-firm`, Script erneut starten |
| `Access is denied` / Execution Policy | lokale Policy blockiert Skripte | `Set-ExecutionPolicy -Scope Process Bypass -Force`, danach `& .\scripts\setup-windows.ps1` |
| PostgreSQL-Dienst nicht gefunden | Installer wurde abgebrochen oder Dienst deaktiviert | Apps → PostgreSQL → **Repair**; Dienst `postgresql-x64-17` starten, Script erneut |
| `password authentication failed for user postgres` | falsches Superuser-Passwort | Installer-Passwort verwenden; falls vergessen, PostgreSQL reparieren/zurücksetzen (Workaround B) |
| `port 5432 is already in use` | andere PostgreSQL-Instanz läuft | `Get-NetTCPConnection -LocalPort 5432`; vorhandene Instanz verwenden oder mit `-DbPort 5433` konfigurieren und `.env` neu erzeugen |
| `npm ci`/`EAI_AGAIN`/TLS | Proxy, DNS oder npm-Cache | `npm cache verify`; Proxy mit `npm config set proxy <URL>` setzen; danach Script erneut |
| `drizzle-kit push` / `ECONNREFUSED` | DB läuft nicht oder `.env` zeigt falschen Port | `Get-Service postgresql*`; `Start-Service postgresql-x64-17`; `.env` prüfen, Script erneut |
| Ollama-Modell schlägt fehl | Ollama läuft noch nicht, Modellname nicht verfügbar | `ollama serve` in einem zweiten Fenster, dann `ollama pull qwen2.5:3b-instruct-q4_K_M`; alternativ `-SkipOllama` |
| Build/Typecheck/Lint schlägt fehl | Abhängigkeit, Node-Version oder echter Codefehler | `node --version` (>=20), `npm ci`, denselben Befehl ausführen; Log und konkrete Fehlermeldung prüfen |
| Health-Check nicht erreichbar | Port belegt, DB-Schema fehlt oder `.env` ungültig | `Get-Content data\setup\next-start-stderr.log`; `npx next start -H 127.0.0.1 -p 3369` manuell testen |

### Workaround A: winget fehlt

1. Installiere **App Installer** aus dem Microsoft Store oder aktualisiere
   Windows. In einer neuen PowerShell `winget --version` testen.
2. Falls der Store gesperrt ist, installiere manuell: Git von
   `https://git-scm.com/download/win`, Node.js LTS von `https://nodejs.org`
   und PostgreSQL 17 von `https://www.postgresql.org/download/windows/`.
3. Prüfe danach `git --version`, `node --version`, `npm --version` und
   `psql --version`, öffne eine neue PowerShell und starte das Script erneut.

### Workaround B: PostgreSQL-Passwort vergessen

Nicht die Datenbankdateien löschen. Sichere zuerst das Projekt und die `.env`.
Nutze den offiziellen PostgreSQL-Installer **Repair** bzw. die dokumentierte
Passwort-Recovery für die installierte Major-Version. Danach den Installer mit
`-PostgresSuperPassword` erneut starten. Das Script löscht weder Cluster noch
Datenbank automatisch.

### Workaround C: App manuell diagnostizieren

```powershell
Get-Service postgresql*
Test-NetConnection 127.0.0.1 -Port 5432
Get-Content .env
npx drizzle-kit push
npx next start -H 127.0.0.1 -p 3369
# in einer zweiten PowerShell:
Invoke-WebRequest http://127.0.0.1:3369/api/health
```

Secrets aus `.env` niemals in Tickets, Screenshots oder Chat kopieren.

## 6. Tests und Abnahme

Nach einem erfolgreichen Setup zusätzlich:

```powershell
npm run typecheck
npm run lint
npm run build
npm run docs:validate
```

`npm test` verwendet im Repository POSIX-Umgebungsvariablen und ist daher in
PowerShell nicht direkt portabel. Für die vollständige Testsuite in Git Bash:

```bash
DATABASE_URL=postgresql://test:test@127.0.0.1:5432/test STARTING_EQUITY=10000 npm test
```

Das Windows-Setup selbst testet TypeScript, Lint, Build und Health; kein Test
aktiviert Live-Orders. Vor Änderungen: `git status`, nach Änderungen: Tests,
Changelog und Versionsnummer prüfen.
