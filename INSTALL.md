# Installation — Übersicht

> **Status:** Kanonische Installationsanleitung ist jetzt in [`docs/INSTALL.md`](docs/INSTALL.md) (CachyOS, Variante A/B, Schritt für Schritt).  
> **Flag-Referenz:** Alle Env-Flags mit sicheren Defaults stehen in [`CONFIGURATION.md`](CONFIGURATION.md).  
> **Windows:** [`docs/INSTALL-WINDOWS.md`](docs/INSTALL-WINDOWS.md)  
> **Code-Version:** v1.36.26

Diese Datei ist ein kurzer Einstieg — Details in den verlinkten Dokumenten.

## Schnellstart (CachyOS, empfohlen)

```bash
git clone https://github.com/Kryschuuu/ai-trading-firm.git
cd ai-trading-firm
./scripts/setup-cachyos.sh --variant a     # Variante A: alles auf einem Rechner
```

Das Skript installiert Node/PostgreSQL, legt Rolle und Datenbank an, schreibt `.env` inkl. `FIRM_API_TOKEN` (Recht `600`), spielt das Schema ein, seedet das Markt-Universum (354 Instrumente), aktiviert Short-Selling, baut die App und führt 18 Validierungs-Checks aus. Idempotent, wiederholbar.

**Optionen:** `--dry-run`, `--non-interactive`, `--no-shorts`, `--sync-markets`, `--skip-build`, `--min-pass 18`, `--help`.  
**Log:** `data/setup/setup-<Zeitstempel>.log`.

Siehe [docs/INSTALL.md](docs/INSTALL.md) für vollständige Anleitung (Kapitel 0–8, Varianten A/B, Troubleshooting).

## Manuell / anderes System

```bash
cp .env.example .env        # Pflicht-Flags setzen (DATABASE_URL)
npm ci
npx drizzle-kit push        # Schema einspielen
npm run universe:seed:markets
npm run universe:seed
npm run build
npm run start               # http://0.0.0.0:3369
./scripts/validate-setup.sh
```

Details: [CONFIGURATION.md](CONFIGURATION.md) (Flag-Tabelle), [docs/HANDBUCH.md](docs/HANDBUCH.md) (Bedienung), [docs/SETUP_BUGS.md](docs/SETUP_BUGS.md) (Befunde).

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
