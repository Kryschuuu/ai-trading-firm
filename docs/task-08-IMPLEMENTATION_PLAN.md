# Implementierungsplan — Task 08: Broker Control Plane (v1.16.0)

**Datenfluss (verbindlich):** Frontend (masked form) → `POST /api/brokers/{venue}/credentials` → AES-256-GCM SecretStore → Broker-Adapter. Frontend erhält NUR Status (`connected`, `permissions[]`, `liveEnabled: false`), niemals Secrets.

## 1. API-Schema (alle Credential-Endpoints admin-guarded, CSRF, Rate-Limit 5/min/IP)

| Endpoint | Methode | Request | Antwort (status-only) |
| --- | --- | --- | --- |
| `/api/brokers/{venue}/credentials` | POST | `{ apiKey, apiSecret }` (einmalig, max. 512 Zeichen je Feld) | `{ ok, venue, configured, connected, permissions[], liveEnabled, probe:{state, at} }` — kein Echo, kein keyHint |
| `/api/brokers/{venue}/credentials` | DELETE | — | `{ ok, venue, configured:false, connected:false, permissions:[], liveEnabled:false }` |
| `/api/brokers/{venue}/status` | GET | — | `{ ok, venue, configured, connected, permissions[], liveEnabled, discovery:{state,count,lastSync}, health, layers:{connection, marketDiscovery, permissions, paper, testnet, live} }` |
| `/api/brokers/{venue}/test` | POST | — | `{ ok, venue, connected, permissions[], health, liveEnabled }` (healthCheck + read-only Probe) |

Fehler-Contract: `{ ok:false, error, message }` — message SAFE (redigiert, ohne Secret-Inhalte). 409/422 bei Zustands-Missbrauch (`ALREADY_CONFIGURED`, `NOT_CONFIGURED`, `LIVE_LOCKED`).

## 2. Secret-Store-Design (`src/brokers/control-plane/`)

- **Interface** `VenueSecretStore`: `put(venue, credential) / get(venue) / delete(venue) / exists(venue)`.
- **AES-256-GCM**: Key aus `SECRET_STORE_KEY` (hex/base64, 32 Byte) via `KmsClient`-Hook (Env-Default; AWS-KMS vorbereitet, markiert). Pro `put`: frischer 12-Byte-IV, **AAD = `venue-id`** (Auth-Tag bindet Datensatz an Venue), Envelope `{v, alg, iv, tag, ct}` (Base64) → Storage. Entschlüsselung prüft Auth-Tag; Buffer nach Nutzung genullt (`zeroize`).
- **Storage-Backends**: `db` (Tabelle `broker_credentials`, Drizzle) → Fallback `file` (`data/secrets/*.enc`, gitignored) → `memory` (nur Tests). DB-Ausfall wirft nie (Audit-Warn + Fallback).
- **Task-07-Kompatibilität**: Bridge `createVenueBackedNamedStore("BITUNIX")` implementiert das task-07-`SecretStore.get(name)`-Interface (Mapping `BITUNIX_API_KEY`/`BITUNIX_API_SECRET` auf entschlüsselte Felder, Env-Fallback bleibt).

## 3. Zustandsmaschinen-Light + Probe (`states.ts`, `probe.ts`, `service.ts`)

- `VenueControlState`: 6 Ebenen (connection, marketDiscovery, permissions, paper, testnet, live) × `off|pending|active|error`. Übergänge NUR über Aktionen `save|test|discover|disable`; sonst 409/422.
- **Live-Ebene**: immer `off`, reason `LIVE_GATE_LOCKED (task-11)`; `liveEnabled` kommt ausschließlich aus `readGateState()` (= `false`, TODO(task-11)). Kein Flag setzbar.
- **Permission-Probe** nach Speichern: read-only (PAPER: echter `getAccount()`; andere Venues: lokaler Mock-API-Client — kein Netzwerk, da Adapter-Stubs/kein Testnet; READ wenn Credential-Format gültig, TRADE nur wenn `capabilities.trading`). Fehler → Ebene `error` mit SAFE-Meldung.
- **Audit**: jedes Ereignis (saved/changed/deleted/test/probe/state-change) → Ring + `audit_log` (`BROKER_CONTROL_PLANE`, actor=admin, venue, action, result, at) — ohne Secrets.

## 4. Sicherheits-Guards (`guard.ts`)

RBAC (minimal, TODO(task-10)): `FIRM_ADMIN_TOKEN` gesetzt → `x-admin-token` Pflicht (timing-safe), sonst 403; ungesetzt → Fallback auf bestehenden `FIRM_API_TOKEN`-Guard, sonst lokaler Offen-Betrieb. CSRF: Mutating-Endpoints verlangen `x-csrf-token` (Wert = Admin-/API-Token bzw. `local`), sonst 403 `CSRF_INVALID`. Rate-Limit: eigener Bucket `BROKER_CREDENTIAL_RATE_LIMIT` (Default 5/min/IP) → 429.

## 5. Frontend „Brokers & Venues" (neuer Tab im FirmDashboard)

- `src/components/control-plane/`: `BrokersPanel` (Karten-Grid), `BrokerCard` (Status-LED, Markets-Count, Futures/Spot-Flags, Buttons Connect/Test/Settings, 6 Zustands-Chips), `CredentialForm` (masked: `type="password"`, `autoComplete="new-password"`, `noValidate`, Submit-Feedback, State nach Submit geleert, kein localStorage), `SettingsPanel` (read-only Flags, `liveEnabled` mit deutlichem „gesperrt"), `ConfirmDialog` (Löschen).
- Daten: `GET /api/brokers` + `GET /api/brokers/{venue}/status` (Promise.all). Loading-/Error-/Empty-States. XSS-sicher: nur JSX, kein `innerHTML`/`dangerouslySetInnerHTML` mit Fremddaten. CSP-freundlich (keine Inline-Scripts).

## 6. Tests & Doku

- `tests/secretStore.test.ts` (Roundtrip, falscher Key, Tampering→Auth-Tag, AAD-Bindung, Zeroize), `tests/controlPlane.states.test.ts`, `tests/controlPlane.api.test.ts` (RBAC 403, CSRF 403, 429, Status-only-Contract), `tests/controlPlane.integration.test.ts` (Connect-Flow + Audit), `tests/controlPlane.security.test.ts` (Response-Scanner + Bundle-Scanner, Ergebnis leer), `tests/controlPlane.e2e.test.ts` (Voll-Flow). Coverage-Ziel ≥ 90 % (`test:coverage:control-plane`).
- Docs: NEU `docs/FRONTEND_CONTROL_PLANE.md`; UPDATE `BROKER_ARCHITECTURE.md`, `CHANGELOG.md` (1.16.0), `SECURITY_AUDIT.md` (Kapitel Task 08), `.env.example`; help-JSON erweitert.

**Abweichung (Session):** Arbeit erfolgt auf dem Arena-Branch `arena/01a04561-ai-trading-firm` (sessiongebunden) statt `feature/task-08-broker-control-plane`; PR wird von diesem Branch geöffnet.
