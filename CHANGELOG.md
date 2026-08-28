# Changelog — Autonome KI-Trading-Firma

> **Status-Header (Task 12):** Konsolidierter Überblick · **2026-08-28** ·
> Code-Version **1.19.0**. Vollständige, detaillierte Einträge je Release stehen
> in [`docs/CHANGELOG.md`](docs/CHANGELOG.md) (Keep a Changelog + SemVer).
> Diese Datei ist der konsolidierte, task-zugeordnete Überblick.

## Versionierung

| Stelle | Bedeutung |
| --- | --- |
| **MAJOR** (1.x.y) | Breaking Changes: DB-Schema-Brüche, entfernte Env-Variablen, neue Pflichtkonfiguration |
| **MINOR** (x.1.y) | Neue Features (z. B. Provider), abwärtskompatibel |
| **PATCH** (x.y.1) | Bugfixes und Sicherheits-Fixes |

Die Version steht in `package.json` und wird von `/api/health` und `/api/firm`
ausgeliefert.

## [1.19.0] — 2026-08-28 · Task 11 (Live-Trading-Gate)

- Auditierte Live-Trading-State-Machine: 9 Zustände, exakt 8 legale Übergänge.
- Single-Point-Enforcer vor jeder Venue-Order; Human-Gate mit 24 h Cooldown und
  4-Augen-Modus; Kill-Switch mit persistenter Failsafe-Datei.
- Append-only Audit mit SHA-256-Hash-Kette; merge-blockierender CI-Job
  `security-live-gate` (Coverage ≥ 95 %).
- **Aktiviert KEIN Live-Trading** — Default bleibt DISCONNECTED/off.

## [1.18.0] — 2026-08-28 · Task 10 (Operations Center + RBAC)

- Rollen `viewer` / `operator` / `admin`; Ops-Tab; Doku-Drift-Fixes.
- 3-Ebenen-Hilfe (`docs/help/*.help.json`) als Tooltip-Grundlage.

## [1.17.0] — 2026-08-28 · Task 09 (Model-Router)

- `MODEL_ROUTER` mit 9 Routing-Inputs, Default-Tabelle
  (CEO→automatic, Research→large, Technical→local-small, News→local-small,
  Risk→local-medium, Portfolio→local-medium), Eskalationsfluss, Budgets, Audit.

## [1.16.0] — 2026-08-28 · Task 08 (Broker Control Plane)

- Credential-Secret-Store mit Verschlüsselung, Health-Checks, Red-Team-Checks,
  Audit-Katalog-UI.

## [1.15.0] — 2026-08-27 · Task 07 (Bitunix-Adapter)

- Bitunix als 7. Venue: Public REST/WS, Signing, Paper-Modus B; Live bleibt
  gesperrt.

## [1.14.0–1.12.0] — 2026-08-27 · Tasks 05–06 (Portfolio-Analytics, Cycle)

- Portfolio-Analytics mit Formelkatalog, drei Optimizer-Modi und Risk-Guard-
  Kette; Daily/Weekly-Agent-Cycle mit CORE/ROTATION/DISCOVERY/EXCLUDED.

## [1.11.0–1.9.0] — 2026-08-27 · Tasks 03–04 (Paper-Trading, Scanner)

- Broker-unabhängige Paper-Market-Data (Modi A/B/C) mit deterministischem
  Fill-Simulator; deterministischer Markt-Scanner mit Score-Gewichten
  (25/15/15/10/10/10/5/5/5) und Trichter (10.000→2.000→500→100 + 20–40 Deep).

## [1.8.0–1.6.0] — 2026-08-26/27 · Tasks 01–02 (Universe, Broker-Modell)

- Instrument-Registry (Market Universe) mit Normalisierung; Broker-Capability-
  Modell mit Execution Modes `backtest/paper/testnet/live` und Adapter-Vertrag.

## [1.0.0–1.5.x] — 2026-08 (Ausgangsstand)

- Next.js + Drizzle + PostgreSQL, 6-Agenten-Pipeline, LLM-Provider-Schicht,
  Security-Härtung (Secret-Store, Guard, Audit-View). Ausführliche Einträge:
  `docs/CHANGELOG.md`.

## Unreleased — Task 12 (Dokumentation)

- Vollständige, code-synchronisierte Docs (15/15 Zieldateien mit Status-Header),
  Root-Docs (`README.md`, `INSTALL.md`, dieser Changelog).
- Hilfe-Systematik: `docs/help/help.schema.json` + alle `*.help.json` schema-valid.
- CI-Job `docs-validate` (Schema, Link-Check, Markdown-Lint, Secret-Scan, Konsistenz).
- Audit-Report `docs/DOCS_SYNC_AUDIT.md`; Task-Tracker `docs/ARENA_TASKS.md`
  (Tasks 1–12); SECURITY_AUDIT-Kapitel Task 12.
