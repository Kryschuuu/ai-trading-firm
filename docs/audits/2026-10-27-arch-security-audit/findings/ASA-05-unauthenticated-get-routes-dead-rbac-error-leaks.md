# ASA-05 — Unauthentifizierte sensitive GET-Routen (SEC-02-Lücken), 7 tote RBAC-Permissions und ungefilterte `e.message`-Leaks

- **ID:** ASA-05
- **Severity:** HIGH
- **Bereich:** Sicherheit (Zugriffskontrolle & Informationsabfluss)
- **Status:** FIXED — 2026-10-28
- **Datei(en):** `src/auth/permissions.ts:14-36`, `src/app/api/ops/route.ts:39-57`, `src/app/api/firm/config/route.ts:32-44,89`, `src/app/api/firm/missions/route.ts:17-50`, `src/app/api/firm/macro/route.ts:24-30`, `src/app/api/firm/micro/route.ts:26-35`, `src/app/api/firm/devils-advocate/route.ts:20-35`, `src/app/api/firm/risk/signal-decay/route.ts:35-55`, `src/app/api/live/state/route.ts:27-44`, `src/app/api/brokers/[venue]/test/route.ts:25`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md`](../prompts/PROMPT-ASA-P1-05-api-rbac-sec02-csrf-error-redaction.md)

## Beschreibung

Mindestens 15 fachlich und sicherheitsrelevante GET-Routen sind ohne Authentifizierung abrufbar, die Hälfte der in `src/auth/permissions.ts` definierten RBAC-Permissions wird im gesamten Projekt nie aufgerufen, und rund 25 API-Handler geben ungefilterte interne Fehlermeldungen (`e.message`) zurück.

## Technischer Nachweis

1. **Offene GET-Endpunkte (laut `docs/generated/route-inventory.md` Guard = `keiner`):** u. a. `GET /api/ops` (kompletter System-, Security- und Venue-Snapshot), `GET /api/firm/config`, `GET /api/firm/missions`, `GET /api/firm/macro`, `GET /api/firm/micro`, `GET /api/firm/devils-advocate`, `GET /api/firm/risk/{signal-decay,volatility,volatility-targeting,drawdown-scaling}`, `GET /api/firm/execution/{policy,twap}`, `GET /api/firm/backtests`, `GET /api/firm/montecarlo/[id]`, `GET /api/live/state`, `GET /api/brokers`, `GET /api/brokers/[venue]/{health,test}`, `GET /api/ops/toggles`, `GET /api/routing/modes`.
2. **7 unbenutzte Permissions (`src/auth/permissions.ts:14-36`):** `firm.config`, `firm.kill`, `ops.view`, `broker.status`, `broker.test`, `routing.read`, `routing.modes.write` haben 0 Aufrufer in `src/app/api/**`. Dadurch kann ein `operator` z. B. `PUT /api/firm/config` ausführen (`firm.write` statt `firm.config`), während er `POST /api/brokers/[venue]/test` nicht ausführen darf (`broker.credentials` statt `broker.test`).
3. **Interne Fehler-Leaks:** Zahlreiche `catch (e)`-Blöcke liefern `{ error: e instanceof Error ? e.message : String(e) }` statt `publicErrorMessage(e)` aus `src/lib/httpError.ts`.

## Konkreter Lösungsvorschlag

- Jede Route außerhalb der expliziten Public-Allowlist (`GET /api/health`, `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`) mit `requirePermission(req, "<passende-permission>")` schützen und `Cache-Control: private, no-store` setzen:
  - `/api/ops` (`GET`) → `ops.view`
  - `/api/firm/config` (`GET`: `firm.read`, `PUT`: `firm.config`)
  - `/api/firm/**` (`GET`) → `firm.read`
  - `/api/brokers`, `/api/brokers/[venue]/health`, `/api/brokers/[venue]/credentials` (`GET`) → `broker.status`
  - `/api/brokers/[venue]/test` (`GET`/`POST`) → `broker.test`
  - `/api/routing/modes` (`GET`: `routing.read`, `PUT`: `routing.modes.write`)
  - `/api/live/state`, `/api/live/kill` (`GET`) → `firm.read`
- `publicErrorMessage(e)` in allen 500-Pfaden einsetzen.
- Nach Anpassung `npm run docs:inventories` ausführen, damit `docs/generated/route-inventory.md` den gehärteten Stand dokumentiert.

## Akzeptanzkriterien / Verifikation

- [x] Keine der aktuell 15 Permissions in `src/auth/permissions.ts` ist unbenutzt (statischer Test prüft, dass jede Permission mindestens eine Route oder einen delegierten Route-Guard erreicht).
- [x] Statischer + Laufzeit-Test über alle `src/app/api/**/route.ts` bestätigt: Jede nicht explizit allowlistete GET/POST/PUT/PATCH/DELETE-Methode gibt ohne Credentials bei aktivem Auth-Modus `401` zurück.
- [x] Ein Operator erhält bei `PUT /api/firm/config` `403` und bei `POST /api/brokers/[venue]/test` Zugriff (`!= 403`).
- [x] Keine API-Route sendet bei unerwarteten Exceptions ungefilterte DB-/FS-Fehlermeldungen an den Client.

## Umsetzung (2026-10-28)

- Alle API-Routen außerhalb der dokumentierten Public-Allowlist prüfen Auth/RBAC; geschützte GETs liefern `Cache-Control: private, no-store`. Docs-Viewer, Health und Auth-Status bleiben absichtlich öffentlich. `/api/brokers/[venue]/test` nutzt `broker.test`, Broker-Lesewege `broker.status`; Routing, Ops, Firm-Konfiguration und Kill verwenden ihre jeweiligen Permissions. `firm.config` ist Admin-only.
- `ALL_PERMISSIONS` wird im statischen Regressionstest gegen sämtliche Route-Handler geprüft. Unerwartete 5xx-Antworten verwenden `publicErrorMessage`; fachliche 4xx-Validierungsfehler bleiben erhalten.
- Regression: `tests/asa05.apiGuardsAndCsrf.test.ts` und `tests/sec02.unauthenticatedGetApis.test.ts`.
