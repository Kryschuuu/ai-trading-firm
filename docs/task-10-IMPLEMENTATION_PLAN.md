# Task 10 — Implementierungsplan: Operations Center + RBAC

**Stand:** 2026-08-28 · **Release-Ziel:** v1.18.0 (Phase 1)
**Branch:** `arena/01a0495b-ai-trading-firm` (Session fest; Arbeit und PR nur hier)

**Diese Inkrement (Phase 1, analog Tasks 03–08):** RBAC-Kern + leerer
Operations-Center-Tab + vier Dokumentations-/Code-Drifts. **Kein** Task 11
(Live-Gate), **kein** Task 12, **kein** Zusammenziehen der Modul-Widgets.

---

## 1. RECON (Pfadmapping)

| Erwartung | Realität | Entscheidung |
| --- | --- | --- |
| Zentrale Rollen | `src/lib/apiAuth.ts` kennt nur `FIRM_API_TOKEN` (Operator-Schreibschutz). Control Plane hat einen Token-Platzhalter (`TODO(task-10)`). | Neues Modul `src/auth/` ist Single Source of Truth. `checkAdminGuard` wird zur Fassade über `requirePermission("broker.credentials")`. HTTP-Status 401/403 der bestehenden Tests bleibt bytekompatibel. |
| Sessions | Keine. Dashboard speichert `firmToken` in `localStorage`. | Phase 1: Token-Header (`x-admin-token` / `x-firm-token` / `x-viewer-token` / `Authorization: Bearer`). Sessions sind Phase 4. |
| Operations Center | `docs/help/*.help.json` existieren, Dashboard rendert sie nicht. Kein `/api/ops`, kein Tab. | Leerer Tab + Stub `GET /api/ops` (Module als Karten, Live immer `false`). Hilfe-JSON-Wiring = Phase 2. |
| Live-Gate | `LiveTradingGateError` hart; `readGateState()` immer false. | Permission `live.gate` existiert im Katalog, wird **keiner** Rolle gewährt. Anzeige „gesperrt bis Task 11“. |
| Bitunix-Secrets | `src/brokers/bitunix/secrets.ts` noch `TODO(task-08)`, Default `EnvSecretStore`. Task-08-Bridge `createVenueBackedNamedStore` existiert. | Default-Store = Venue-backed Named Store + Env-Fallback. `EnvSecretStore` bleibt für Tests/DI. |
| HANDBUCH Kap. 8 | Beschreibt das statische Kursbuch als Auslieferungszustand (seit Task 03 falsch). | Neu schreiben: Default Paper-Modus B, Control Plane, Bitunix, Live gesperrt. |
| HANDBUCH 19.4 | „Bis zum Einbau des Model-Routers (Task 09)“ | Task 09 ist v1.17.0 — Eskalation läuft über `requestEscalation()`. Legacy-Pfad `localReason()` bleibt als RT-01 dokumentiert. |
| Architecture-Tab | LangGraph / AutoGen / CrewAI / „Pickleball“ — Entwurf, nicht Ist-Stand. | Ersetzen durch Ist-Architektur (Makro/Mikro, 12-Aufgaben-Programm, Paper, Broker, Router, RBAC, Live-Gate). |

**Nicht in Phase 1:** Firm-Schreib-APIs auf `requirePermission` umstellen
(bleiben `guardWrite` / `FIRM_API_TOKEN`). Widget-Aggregation Universe /
Scanner / Portfolio / Cycle / Routing. Session-Cookies.

---

## 2. Rollen & Rechte (Phase 1)

| Permission | viewer | operator | admin | Bemerkung |
| --- | :---: | :---: | :---: | --- |
| `firm.read` | ✓ | ✓ | ✓ | GET-Status |
| `ops.view` | ✓ | ✓ | ✓ | Operations Center |
| `broker.status` | ✓ | ✓ | ✓ | GET `/api/brokers*` |
| `routing.read` | ✓ | ✓ | ✓ | GET `/api/routing`, `/api/providers` |
| `firm.write` | — | ✓ | ✓ | run / seed / tick |
| `firm.kill` | — | ✓ | ✓ | Kill-Switch |
| `firm.config` | — | ✓ | ✓ | Risk-Config |
| `broker.test` | — | ✓ | ✓ | Connection-Test (kein Secret-Write) |
| `broker.credentials` | — | — | ✓ | PUT/DELETE Credentials, Discover |
| `routing.modes.write` | — | — | ✓ | `PUT /api/routing/modes` |
| `live.gate` | — | — | — | **niemals** bis Task 11 |

**Token-Abbildung**

| Env | Header | Rolle |
| --- | --- | --- |
| `FIRM_ADMIN_TOKEN` | `x-admin-token` oder `x-firm-token` (gleicher Wert) | `admin` |
| `FIRM_API_TOKEN` | `x-firm-token` | `operator` |
| `FIRM_VIEWER_TOKEN` | `x-viewer-token` (oder `x-firm-token`) | `viewer` |
| keines gesetzt | — | `admin` / Quelle `local-open` (Single-User, 127.0.0.1) |

**Single-Admin-Elevation:** Ist `FIRM_ADMIN_TOKEN` ungesetzt, erbt ein
authentifizierter Operator die Admin-Rechte (bestehendes Control-Plane-
Verhalten, Tests 401/200 unverändert). `effectiveRole` macht das sichtbar.

**Statuscodes (Kompatibilität)**

- Admin-Token konfiguriert, kein Treffer → **403 FORBIDDEN**
- Nur Operator-/Viewer-Token konfiguriert, kein Treffer → **401 UNAUTHORIZED**
- Authentifiziert, Permission fehlt → **403 FORBIDDEN**

Vergleich timing-safe (`tokenEquals` aus `apiAuth.ts`). GET bleibt ohne Token
ladbar (Dashboard-Status), ausser `/api/auth/me` (401 wenn Tokens gesetzt und
kein Treffer).

---

## 3. Module Phase 1

| Datei | Verantwortung |
| --- | --- |
| `src/auth/types.ts` | Rollen, Permissions, Actor |
| `src/auth/permissions.ts` | Katalog + Matrix + `hasPermission` |
| `src/auth/resolve.ts` | `resolveActor` / `requirePermission` / Denial |
| `src/auth/ops.ts` | Stub-Payload für `/api/ops` (`liveEnabled: false`) |
| `src/auth/index.ts` | öffentliche API |
| `src/app/api/auth/me/route.ts` | GET Actor (keine Token-Werte) |
| `src/app/api/ops/route.ts` | GET Cockpit-Hülle |
| `src/components/ops/OperationsCenterPanel.tsx` | leerer Tab: Rolle, Live-Chip, Modul-Karten |
| Tests | `tests/rbac.test.ts`, `tests/ops.api.test.ts`, `tests/task10.architecture.test.ts` |

**Verdrahtung bestehender Guards**

- `src/brokers/control-plane/guard.ts` → `requirePermission("broker.credentials")`
- `PUT /api/routing/modes` bleibt hinter `checkAdminGuard` (jetzt RBAC)
- Control-Plane-Routen übergeben `actor.auditId` statt hart `"admin"`
- `apiFetch` sendet den gespeicherten Token auch auf GET (für `/api/auth/me`)

---

## 4. Drift-Fixes (verbindlich in Phase 1)

1. **HANDBUCH Kap. 8** — Default ist Paper-Modus B (`broker-market-data`):
   echte Kurse, lokale Simulation. Statisches Buch nur
   `PAPER_STATIC_FALLBACK=true`. Credentials über Control Plane
   (AES-256-GCM). Bitunix = 7. Venue. Live = `LiveTradingGateError`.
2. **HANDBUCH 19.4 Punkt 4** — MODEL_ROUTER ist v1.17.0. Eskalation nur über
   `requestEscalation()`. Legacy `localReason()` = RT-01, nicht „bis Task 09“.
3. **Dashboard Architecture-Tab** — Ist-Stand, kein LangGraph/AutoGen.
4. **`src/brokers/bitunix/secrets.ts`** — Default-Store über
   `createVenueBackedNamedStore`; Env bleibt Fallback. `TODO(task-08)` weg.

---

## 5. Phasen 2–4 (Plan, nicht dieser PR)

| Phase | Inhalt | Voraussetzung |
| --- | --- | --- |
| 2 | 3-Ebenen-Hilfe (`docs/help/*.help.json`) im Ops-Tab als Tooltip | Phase 1 Tab existiert |
| 3 | Read-only Kacheln: Universe / Scanner / Portfolio / Cycle / Routing / Brokers (bestehende GET-APIs aggregieren) | Phase 1 `/api/ops` |
| 4 | Sessions, restliche Schreib-APIs auf Permission-Guards, Audit `AUTH_DENIED` | Rollen im Cockpit sichtbar |

Task 11 (Live-Gate) startet **erst**, wenn Rollen existieren und das Cockpit
den Gate-Status zeigen kann — das ist Phase 1.

---

## 6. Tests & DoD Phase 1

- Permission-Matrix + `live.gate` niemals true
- `resolveActor`: local-open / admin / operator / viewer / Elevation
- 403 vs 401 wie Control-Plane-Bestand
- `GET /api/auth/me` ohne Token-Echo; Secret-Scanner leer
- `GET /api/ops` → `liveEnabled: false` auch bei gesetzten Live-Flags
- Control-Plane- und Routing-API-Bestand grün (964+ neue)
- Architekturtest: kein LangGraph/AutoGen im Dashboard; kein
  `TODO(task-08)` in Bitunix-Secrets; HANDBUCH Kap. 8 / 19.4 aktualisiert
- `npm test` / `typecheck` / `lint` grün; Live bleibt `LiveTradingGateError`

---

## 7. Dokumentation

- Dieses File · CHANGELOG 1.18.0 · SECURITY_AUDIT Task 10 · HANDBUCH 2.3/8/19.4
- `.env.example` (`FIRM_VIEWER_TOKEN`, RBAC-Sektion, Bitunix-Secrets)
- `docs/BITUNIX.md` Secrets-Zeile · `docs/help/ops.help.json` ·
  `docs/help/brokers.help.json` `controlPlane.rbac` · README-Version
