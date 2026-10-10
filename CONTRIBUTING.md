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
- Zwei Header-Arten mit getrennter Bedeutung — siehe Abschnitt
  „Zwei Header-Arten“ unten. Die `Code-Version` wird über
  `scripts/bump-docs-version.ts` synchron gehalten, nicht von Hand.

## Pflicht-Checks (vor jedem PR)

Lokal ausführen und **grün** haben — die CI
([`.github/workflows/`](.github/workflows/), Quelle: [`docs/ci/`](docs/ci/README.md))
prüft das mindestens bei `docs-validate`:

```bash
npm ci
npm run typecheck        # tsc --noEmit (strict)
npm run lint             # ESLint
npm test                 # node:test-Gesamtsuite; brokerContracts startet temporäres Embedded-PostgreSQL
npm run docs:validate    # Links/Schema/Secrets + L1–L4; L2 Code→Doku-Warnungen sind nicht blockierend
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

## Generierte Dokumente

Mengenverzeichnisse werden **erzeugt, nicht gepflegt** — sonst driften sie (Befunde
DC-04/DC-05/DC-07: 15 von 67 Tabellen dokumentiert, Flags ohne Read, falsche Header).

- **Nie per Hand editieren.** Jede generierte Datei trägt die Kopfzeile
  „GENERIERT — nicht editieren (`npm run docs:inventories`)“.
- Änderungen laufen über Code bzw. Generator: Routen/Guards in `src/app/api/**`,
  Env-Reads in `src/**`, Tabellen in `src/db/schema.ts`. Danach
  `npm run docs:inventories` ausführen und das **Generat mitcommitten**.
- Generierte Dateien:
  - `docs/generated/route-inventory.md` — Routen, HTTP-Methoden, Guard-Klasse
  - `docs/generated/env-inventory.md` — `process.env`-Reads vs. `.env.example` vs. `CONFIGURATION.md`
  - `docs/generated/schema-inventory.md` — `pgTable`-Definitionen und Migrationen
  - `docs/STRATEGY_TEMPLATES.md` — Strategie-Katalog (`npm run docs:templates`)
- `npm run docs:inventories:check` (Pflicht-Schritt im CI-Job `docs-validate`) schlägt
  fehl, sobald ein Generat vom Code abweicht. Schreibende Routen ohne Guard müssen
  gesichtet sein (`REVIEWED_UNGUARDED_WRITES` in `scripts/gen-docs-inventories.ts`,
  mit Begründung) — sonst bricht der Check ebenfalls.
- Das Stand-Datum wird nur über `--stand YYYY-MM-DD` gesetzt; ohne Angabe bleibt die
  Ausgabe byte-stabil.

## Zwei Header-Arten

Dokumente tragen zwei unterschiedliche Versionsangaben. Sie dürfen nicht vermischt werden.

| Header | Bedeutung | Geprüft | Pflege |
|--------|-----------|---------|--------|
| `Code-Version` | Stand des Moduls, den das Dokument beschreibt | CI (`docs:validate`, L3) gegen `package.json` | `npm run docs:bump-version` (Release-Schritt) |
| `Dokument-Version` | eigene Vokabular-/Format-/Schema-Version (z. B. `PORTFOLIO_CONFIG_VERSION = 1`, `Schema v2`) | **nicht** — unabhängig von `package.json` | von Hand, nur bei Format-Änderung |

- Eine Zeile darf beide Angaben nennen (z. B. Bestandsdokumente mit Schema-Version);
  das Bump-Skript ersetzt dann ausschließlich die `Code-Version`.
- `archive/`, `audits/`, `peer-reviews/` und `generated/` sind vom Bump ausgenommen —
  dort bleiben historische Stände erhalten.
- Nur eine Version ist die Wahrheit für den Betrieb: `package.json` (siehe `VERSION.md`).

## Release-Ablauf (Doku-Teil)

Vor dem Release-Commit, in dieser Reihenfolge:

```bash
npm run docs:inventories && node --import tsx scripts/bump-docs-version.ts --write
npm run docs:validate && npm run docs:inventories:check    # muss grün sein
```

Vorab optional `node --import tsx scripts/bump-docs-version.ts --dry-run`: es listet
genau die `Code-Version`-Header, die sich ändern würden. Danach den Release-Commit mit
`package.json`, `CHANGELOG.md` (Abschnitt `## [x.y.z]`) und den geänderten Dokumenten
erstellen. Das Skript ruft kein `git` auf.

Hinweis: Nach dem Bump trägt auch ein Bestandsdokument die neue Code-Version, dessen
Inhalt noch nicht gegen den Code geprüft wurde. Der Vermerk „Vollabgleich offen“ im
Header bleibt deshalb stehen — er ist der Hinweis auf ungeprüften Inhalt.

## Tests

- Framework: **Node-eigener `node:test`** + `assert/strict` (kein
  Drittanbieter-Framework).
- DB-gegatete Tests folgen der Repo-Konvention: **ping → skip**, wenn optionale
  PostgreSQL-Infrastruktur lokal nicht startbar ist (`embedded-postgres`).
  `tests/brokerContracts.test.ts` startet für die zwei PAPER-Ausführungspfade
  eine isolierte temporäre DB; der Required CI-Job setzt
  `BROKER_CONTRACTS_REQUIRE_DB=true`, damit dort ein DB-Startup-Ausfall fehlschlägt.
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
