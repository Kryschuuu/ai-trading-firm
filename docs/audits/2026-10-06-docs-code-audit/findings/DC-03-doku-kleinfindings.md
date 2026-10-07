# DC-03 — Doku-Kleinfindings (Sammelbefund, behoben)

- **ID:** DC-03
- **Severity:** MEDIUM (Summe vieler Irreführungen; jede einzeln LOW)
- **Bereich:** Doku-Wahrheit (Zahlen, Versionen, API-Felder, Index)
- **Entdeckt:** 2026-10-06, Docs↔Code-Audit `v0.17.2`
- **Status:** ☑ **FIXED** (2026-10-06, diese Session)
- **Datei(en):** siehe Tabelle (alle Änderungen dieses Befunds berühren nur `docs/`/Root-Doku, kein Produktverhalten)

## Beschreibung

Zwölf Einzelabweichungen, die alle dasselbe Muster haben: eine Zahl, ein Name
oder ein Verweis in der Doku entspricht nicht (mehr) dem Code. Jede für sich
klein, in Summe aber genau die Art von Drift, die einen „Ist-Zustand" nicht mehr
belastbar macht. Sie sind in dieser Session behoben, weil sie jeweils
punktuelle, verifizierbare Korrekturen ohne Folgewirkung sind (Gegenteil von
DC-04…DC-09, die Struktur-/Inventarcharakter haben).

## Einzelbefunde und Fixes

| # | Befund | Fundstelle | Vorher | Nachher (Fix) |
|---|--------|-----------|--------|---------------|
| 1 | Feature-Store-Zahl | `architecture/STRATEGY_STACK.md` (Zweck, Tabelle, Detailabsatz) | „Feature Store = 3 Features" | „6 Features in zwei Slices (`scanner.*` + `rule.*`)" + Fundstellen/Tests |
| 2 | API-Feld existiert nicht | `PORTFOLIO_ANALYTICS.md:80,339`, `PIPELINE_MAP.md:345` | `allowShortSelling` als Konfigfeld/curl-Beispiel | Feld entfernt; Klarstellung: API kennt nur `minWeight`/`maxWeight`/`lower`/`upper`, long-only ist in `resolveBounds` erzwungen (`longOnly = true`), Fremdfeld wird ignoriert |
| 3 | Scanner-Config-Version | `architecture/PIPELINE_MAP.md:158` | „Default: intern `version: 1`" | „`version: 2`" + Verweis auf `DEFAULT_SCANNER_CONFIG` und die ausgelieferte JSON |
| 4 | Candle-Limit | `architecture/DB_SCHEMA.md:336` | „Max. 5.000 Kerzen" | „Max. **100.000** Kerzen (`MAX_CANDLES_PER_SERIES`/`DEFAULT_MAX_BARS_PER_SERIES`)" — deckungsgleich mit `HISTORY.md` und Code |
| 5 | Tabellenzahl/Scope | `architecture/DB_SCHEMA.md:7` | „alle 15 Drizzle-Tabellen" (klingt vollständig) | „die ursprünglichen 15 Tabellen (Stand 2026-09-18) … SSoT ist `src/db/schema.ts` mit inzwischen 67 `pgTable`-Definitionen" + Verweis auf DC-07 |
| 6 | Testzahl | `VERSION.md:443` | „4.719 bestanden" | „4.722 bestanden" (reproduzierter Lauf: 4760 Tests/4722 pass/2 fail/36 skip) — deckungsgleich mit `CHANGELOG.md:46` |
| 7 | Test-Suite-Zusage | `CONTRIBUTING.md:35`, `docs/ci/README.md:95-101` | „DB-gegatete Tests überspringen sich ohne PostgreSQL" (Absolutaussage) | präzisiert: **Ausnahme** `tests/brokerContracts.test.ts` (2 PAPER-Contract-Tests scheitern ohne DB statt zu skippen; mit Embedded PostgreSQL 42/42) — mit Verweis auf DC-08 |
| 8 | Versionszeile Fuß | `docs/README.md` (Abschnitt „Version") | `` `v0.2.0 (Beta)` `` | `` `v0.17.2 (Beta)` `` |
| 9 | Audit-Index widersprüchlich | `docs/README.md:302`, `audits/README.md:53` | Baumdiagramme „OPEN v1.2.2" vs. Prosa „v1.2.5" | Baumdiagramme auf **v1.2.5** vereinheitlicht + neuer Audit-Zyklus im Baum |
| 10 | Phasenzahl | `BETA_STATUS.md:129` | „Alle sieben Phasen" (Tabelle listet 0–7 = acht) | „Alle acht Phasen (0–7)" |
| 11 | Undokumentierte Route | `HANDBUCH.md` API-Tabelle | `GET /api/firm/execution-quality` fehlte | Zeile mit Parametern (`from`,`to`,`asOf`), RBAC `firm.read` und `private, no-store` ergänzt |
| 12 | Index-/Header-Lücken | `docs/README.md`, `DAILY_WEEKLY_RESEARCH.md`, `SYMBOLS.md`, `SETUP_PG_TROUBLESHOOTING.md` | 3 `PEER_REVIEW_*`-Stubs ungelistet; 3 Dokumente ohne Status-Header | Stub-Absatz + Audit-Tabellenzeile + Bericht-Link ergänzt; Status-Header (Bestandsdokument, Code-Version 0.17.2) ergänzt |

Zusätzlich in diesem Befund mitbehoben: `docs/security/README.md` führt den in
DC-01 abgesicherten Approve-Pfad jetzt explizit in der Guard-Aufzählung
(Schreibpfade mit `firm.write` + CSRF).

## Verifikation

- `npm run docs:validate`: grün (9 Checks, 10 Hilfe-Dateien, 1.429 aufgelöste
  App-Links; Link-/App-Link-, Markdown-, Secret-, Env-, Routen-, State- und
  Versions-Check).
- Stichproben-Kommandos (in `remediation/TRACKING.md` dokumentiert):
  `grep -c pgTable src/db/schema.ts` → 67; `grep -rn allowShortSelling src` → 0;
  `grep -n "version" src/scanner/scanner.config.json` → 2;
  `grep -c DEFAULT_MAX_BARS_PER_SERIES src/lib/marketdata/limits.ts`.

## Restrisiko

Die Korrekturen beheben die *Fundstellen*, nicht die Ursache — dieselben Zahlen
können beim nächsten Modulumbau erneut driften. Genau dafür existieren DC-04
(Versions-Header), DC-07 (Schema-Inventar) und DC-08 (CI-Wächter).
