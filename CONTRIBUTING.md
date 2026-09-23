# CONTRIBUTING — Autonome KI-Trading-Firma (Beta)

> ## ⚠️ BETA-PHASE (v0.x.x)
>
> Dieses Projekt ist **Beta** und **nicht produktionsreif**: es dient
> Bildungszwecken und privater Nutzung **auf eigene Gefahr**. Der Autor lehnt
> jegliche Haftung für finanzielle Verluste, technische Fehler, Datenverlust
> oder Schäden ab. Trading beinhalten erhebliche Risiken. Wer Beiträge
> einreicht, bestätigt damit, dass er/sie das Projekt **nicht** für produktives
> Trading nutzt und die Bedingungen in [`README.md`](README.md) akzeptiert.

Danke für dein Interesse! Dieses Repo hat strenge, aber bewährte Konventionen —
die meisten davon kommen aus Sicherheits-Audits ([`docs/security/`](docs/security/README.md))
und müssen in jedem Beitrag eingehalten bleiben.

## Versions- und Status-Konvention

- Das Projekt wird als **v0.x.x (Beta)** versioniert; die einzige
  Versions-Quelle ist `package.json` (zur Laufzeit via `src/lib/version.ts`).
  Legacy-Referenzen `v1.x.x` in alten Audits/Docs sind **nicht** öffentlich
  (Zuordnung: [`CHANGELOG.md`](CHANGELOG.md) § Versions-Zuordnung).
- Status-Header jeder Doku-Datei (`> **Status-Header:** … Code-Version …`)
  aktualisieren, wenn sich das Modul ändert.

## Pflicht-Checks (vor jedem PR)

Lokal ausführen und **grün** haben — die CI
([`.github/workflows/`](.github/workflows/), Quelle: [`docs/ci/`](docs/ci/README.md))
prüft das mindestens bei `docs-validate`:

```bash
npm ci
npm run typecheck        # tsc --noEmit (strict)
npm run lint             # ESLint
npm test                 # node:test-Suite (DB-gegatete Tests springen ohne Postgres)
npm run docs:validate    # Doku-Link-/Schema-/Konsistenz-/Secret-Checks
```

Für Sicherheits-Änderungen zusätzlich: `npm run security:live-gate`
(CI-Pflicht im `security-live-gate`-Workflow).

## Code-Konventionen (aus den Audits abgeleitet)

1. **Fail-closed statt stiller Fallback:** Fehlende/ungültige Daten werden
   abgelehnt oder sichtbar `null` gemeldet — nie still durch `0` ersetzt
   (`null ≠ 0`). Ein unbekannter Modus fällt auf den sicheren Default.
2. **Paper-only bleibt erzwungen:** `src/live-gate/` ist die einzige
   Freigabeschicht für Live-Pfade. Beiträge dürfen keine Umgehung von
   Live-Gate, Kill-Switch oder Risk-Ceilings einführen; Risikofaktoren wirken
   nur senkend (hart ≤ 1).
3. **Keine neuen Runtime-Dependencies** ohne explizite Absprache im
   Issue/PR (Supply-Chain-Härtung, gepinnte Versionen, `npm ci` aus
   geprüfendem Lockfile).
4. **Determinismus:** Mathematik-Pfade (Scanner, Risk, Backtest) sind
   uhr- und zufallsfrei (Zeit/PRNG injiziert), reproduzierbar
   (gleiche Eingabe ⇒ byte-identisches Ergebnis), mit Idempotenz-Keys für
   alle Persistenz-Pfade.
5. **Zeitsemantik:** `event_time` / `available_at` / `computed_at` getrennt
   halten; kein Look-ahead (keine Daten mit `available_at > asOf`).
6. **Audit-Trail:** Jede sicherheitsrelevante Mutation wird in `audit_log`
   belegt (Klasse `security` = at-least-once über
   [`src/lib/auditSink.ts`](src/lib/auditSink.ts)); neue Audit-Events
   **immer** im Katalog [`src/lib/auditView.ts`](src/lib/auditView.ts)
   beschreiben (Test prüft Vollständigkeit).
7. **Telemetrie:** Metrik-Labels nur aus geschlossenen Mengen
   (klassifizierte Codes) — nie Instrument-/Order-/User-IDs, keine
   Secrets/PII in Labels, Logs, Audit-Details oder Metriken.
8. **Migrations:** append-only + idempotent (`IF NOT EXISTS`,
   `ON CONFLICT DO NOTHING`), im Ordner `drizzle/`, mit Rollback-Hinweis in
   der Modul-Doku. Bestehende Tabellen/Spalten nie still ändern.
9. **Konfiguration:** Neues Verhalten hinter Env-Flags mit Bounds-Clamp und
   sicherem Default (Rollout-Modi `off`/`monitor`/`enforce` bzw.
   `off`/`monitor`/`active`); Flag-Tabelle in [`CONFIGURATION.md`](CONFIGURATION.md)
   und `.env.example` pflegen (der Konsistenz-Check in `docs:validate`
   vergleicht Flag-Namen mit dem Code).

## Doku-Pflichten (Docs-as-Code)

- **Docs und Code ändern sich im selben PR** — nie auseinander mergen.
- Neue Modul-/Feature-Dokumentation unter [`docs/`](docs/README.md) mit
  Status-Header (Datum, Code-Version, Modul, Migration/CLI).
- Relativer Link-Check läuft in der CI: tote Links brechen den Build.
- `docs/help/*.help.json` (3-Ebenen-Hilfe) gegen `help.schema.json` valid.
- API-Routen, die du änderst, müssen mit den Doku-Angaben
  (`docs:validate` vergleicht `src/app/api` mit den Docs) konsistent bleiben.
- Änderungen im [`CHANGELOG.md`](CHANGELOG.md) dokumentieren (Keep a
  Changelog; `[Unreleased]` zuerst, dann beim Release die Version).

## Tests

- Framework: **Node-eigener `node:test`** + `assert/strict` (kein
  Drittanbieter-Framework).
- DB-gegatete Tests folgen der Repo-Konvention: **ping → skip**, wenn keine
  PostgreSQL erreichbar ist (`embedded-postgres` für die DB-Suites).
- Neue Logik ⇒ neue Tests (Unit, Golden-Fixture für deterministische
  Pfade, negative Pfade für Fail-closed-Zweige).
- Testdateien gehören nach [`tests/`](tests/) (ein einziges
  Testverzeichnis; die frühere Aufteilung `test/` wurde am 2026-09-23
  zusammengeführt). Modul-Tests, die eng am Code hängen (z. B.
  `src/marketdata/__tests__/`), dürfen am Ort bleiben.

## Vorgehensweise

1. Fork + Arbeitsbranch (`arena/…` bzw. eigener Name), `main` als Basis.
2. Änderung + Tests + Doku + Changelog im selben PR.
3. Pflicht-Checks grün (s. o.); bei Sicherheits-Relevanz `security:live-gate`.
4. PR mit Zusammenfassung: **Was & Warum**, welche Audit-Regeln beachtet
   wurden, Rollback-Weg (Flag/Migration), geänderte Doku-Header.
5. Review-Kriterien der Maintainer: Fail-closed-Garantien, Determinismus,
   Audit-Beleg, Doku-Sync, keine neuen Dependencies.

## Lizenz & Teilnahme

Beiträge werden unter **GPL-3.0-only** (siehe [`LICENSE`](LICENSE))
veröffentlicht. Mit jedem Beitrag bestätigst du, dass deine Änderungen unter
dieser Lizenz verfügbar gestellt werden dürfen.
