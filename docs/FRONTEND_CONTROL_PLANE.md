# Broker Control Plane — Frontend & Credential-Manager (Task 08)

**Stand:** v1.16.0 · **Scope:** `src/brokers/control-plane/**`,
`src/app/api/brokers/{venue}/(credentials|status|test|discover)`,
`src/components/control-plane/**`, `src/lib/controlPlane.ts`,
`src/app/brokers/page.tsx`, Dashboard-Tab „Brokers & Venues".

Dieses Dokument beschreibt den verbindlichen Datenfluss, die API, das
Zustandsmodell und das Sicherheitskonzept der Broker Control Plane.

---

## 1. Datenfluss (verbindlich)

```
┌───────────────┐   masked credential form   ┌──────────────────────────────┐
│   Frontend    │ ──────────────────────────▶ │        Backend (CP)         │
│ BrokersPanel  │   POST /api/brokers/{venue}/│ 1. Validierung (Format)      │
│ CredentialForm│        credentials          │ 2. AES-256-GCM (AAD=venue)  │
│ (type=password│ ◀─────────────────────────  │ 3. read-only Permission-Probe│
│  no client    │   Status-Objekt ONLY        │ 4. Zustandsmaschine (6 Ebenen)│
│  storage!)    │   {configured, connected,   │ 5. Audit (Ring + audit_log)  │
│               │    permissions[],           └──────┬───────────────┬───────┘
│               │    liveEnabled:false}             │               │
└───────────────┘                                    ▼               ▼
                                        ┌──────────────────┐  ┌──────────────┐
                                        │ Encrypted        │  │ Adapter-     │
                                        │ Secret Store     │  │ Contract     │
                                        │ (DB/File/Memory) │  │ healthCheck  │
                                        │ niemals Klartext │  │ capabilities │
                                        └──────────────────┘  └──────────────┘
                                                                      │
                              audit_log (actor, venue, Aktion,        │
                              Ergebnis, timestamp) ◀──────────────────┘
```

**Unveränderliche Regeln des Flusses:**

1. Das Secret fließt **einmalig** Form → Store. Danach existiert nur die
   verschlüsselte Referenz (Envelope). Es gibt keinen Lesepfad zurück ins
   Frontend — der Endpunkt `GET …/status` kennt kein `secret`-Feld.
2. Das Frontend erhält **nur Status**, z. B.
   `{ "connected": true, "permissions": ["READ", "TRADE"], "liveEnabled": false }`.
3. Das Secret erscheint **niemals** in: API-Responses, Frontend-Bundle,
   Sourcemaps, LocalStorage/SessionStorage, URL-Parametern, Logs, Audit.
4. **Live bleibt überall OFF.** `liveEnabled` ist die reine Anzeige der
   Gate-Service-Meldung (`readGateState(venue)`) — seit Task 11 die Projektion
   des zentralen Live-Gate-Enforcers (persistierte State-Machine, Default
   `false`). Es gibt keinen Schalter, keine Env, keinen Endpoint der UI, der
   das ändert; der **Live-Chip zeigt den Gate-Zustand** (LiveGatePanel im
   Brokers-Tab: `GET /api/live/state` — Zustand je Venue, Flags, Suite-Stamp,
   Kill-Status, Audit-Kettenkopf). Einzige UI-Mutation: der Kill-Switch
   (Confirm-Dialog mit Phrase `KILL`, serverseitig geprüft).

---

## 2. API-Referenz

Alle Credential-/Connection-Endpoints sind **admin-guarded** (RBAC-Platzhalter,
RBAC Task 10), **CSRF-geschützt** und **rate-limitiert** — seit v1.36.14
dreistufig: 5 Credential-Versuche/min **pro Client-Identität**, zusätzlich ein
globales, IP-unabhängiges Limit (20/min) und ein exponentieller Backoff ab dem
3. Fehlversuch. Die Identität stammt aus `src/lib/clientIp.ts` und ist ohne
`TRUSTED_PROXY_IPS`/`x-verified-ip` nicht client-setzbar (Befund C2).
GET-Endpoints bleiben lesbar (konsistent mit den übrigen Broker-Endpoints).

### `POST /api/brokers/{venue}/credentials`
Nimmt das Secret **einmalig** entgegen, validiert, verschlüsselt
(AES-256-GCM, AAD = Venue-ID), führt die read-only Probe aus und antwortet
status-only.

Request: `{ "apiKey": "…", "apiSecret": "…" }` (je 16–512 Zeichen, keine
Steuerzeichen — Validierung im Backend).

Antwort 200:
```json
{
  "ok": true, "venue": "BITUNIX", "configured": true, "connected": true,
  "permissions": ["READ", "TRADE"], "liveEnabled": false,
  "probe": { "state": "ok", "at": "…", "errorCode": null, "message": null },
  "layers": { "connection": { "state": "active", "at": "…", "detail": "READ_ONLY_PROBE_OK" }, "…": "…" }
}
```
Kein Echo des Secrets, **kein `keyHint`** (empfohlen: gar nicht — so umgesetzt),
keine Maskierungs-Replik (`****`). Fehler 403/404/409/422/429/503 mit
`{ ok:false, error, message }` (message SAFE/redigiert).

### `DELETE /api/brokers/{venue}/credentials`
Löscht die verschlüsselte Referenz und setzt alle Ebenen zurück.
Antwort: `{ ok, venue, configured:false, connected:false, permissions:[], liveEnabled:false }`.
409 `NOT_CONFIGURED`, wenn nichts hinterlegt ist.

### `GET /api/brokers/{venue}/status`
```json
{
  "ok": true, "venue": "BITUNIX",
  "configured": true, "connected": true,
  "permissions": ["READ", "TRADE"],
  "liveEnabled": false, "liveReason": "LIVE_GATE_LOCKED … (task-11)",
  "discovery": { "state": "active", "count": 42, "lastSync": "…" },
  "health": { "status": "online", "latencyMs": 0, "details": { "…": "…" } },
  "layers": {
    "connection":      { "state": "active", "at": "…", "detail": "READ_ONLY_PROBE_OK" },
    "marketDiscovery": { "state": "pending", "at": "…", "detail": "bereit fuer discover" },
    "permissions":     { "state": "active", "at": "…", "detail": "permissions=[READ,TRADE]" },
    "paper":           { "state": "active", "at": "…", "detail": "PAPER_MODE_AVAILABLE" },
    "testnet":         { "state": "off", "at": "…", "detail": "NOT_SUPPORTED_CAPABILITY:testnet" },
    "live":            { "state": "off", "at": "…", "detail": "LIVE_GATE_LOCKED …" }
  },
  "updatedAt": "…"
}
```

### `POST /api/brokers/{venue}/test`
Verbindungstest: `healthCheck` + read-only Account-Probe → `permissions[]`.
409 `NO_CREDENTIALS`, wenn keine Zugangsdaten hinterlegt sind (PAPER
ausgenommen: interner Simulator, Test ohne Credentials).

### `POST /api/brokers/{venue}/discover`
Definierte Aktion „discover": nur nach aktiver Verbindung und nur bei
`capabilities.discovery=true` (sonst 409/422). PAPER nutzt die lokale
Universe-Registry (offline); echte Venue-Discovery folgt mit den
Adapter-Aufgaben → bis dahin 422 `DISCOVERY_NOT_IMPLEMENTED`.

---

## 3. Zustandsmodell (6 Ebenen × 4 Zustände)

Pro Venue existiert **genau ein** Zustandsobjekt (`VenueControlState`):

| Ebene | off | pending | active | error |
| --- | --- | --- | --- | --- |
| `connection` | keine Verbindung | — | Verbindung aktiv (Probe OK) | Probe/Test fehlgeschlagen |
| `marketDiscovery` | keine Discovery | bereit für `discover` | Discovery gelaufen (count/lastSync) | Discovery fehlgeschlagen |
| `permissions` | keine Rechte | — | `permissions[]` aus Probe | — |
| `paper` | nicht verfügbar (Capability) | wartet auf Verbindung | Paper-Modus verfügbar | Verbindungsfehler |
| `testnet` | nicht verfügbar (Capability) | wartet auf Verbindung | Testnet verfügbar | — |
| `live` | **immer off** (Gate-Sperre) | — | **nie** | — |

**Übergänge ausschließlich über definierte Aktionen:**
`save` (Speichern + Probe), `test` (Verbindungstest), `discover`
(Market Discovery), `disable` (Trennen + Zurücksetzen). Jeder andere
Übergang ist Missbrauch → `StateTransitionError` → **409/422** mit klarem
Fehlercode (`ALREADY_CONNECTED`, `NOT_CONFIGURED`, `CONNECTION_REQUIRED`, …).

**Live-Regel (hart):** Es gibt kein „live = true"-Flag. Die Live-Ebene ist
immer `off` und `liveEnabled` immer `false` — einzige Quelle ist
`readGateState()` (Gate-Service-Meldung), die bis zum Live-Trading-Gate-Task
(task-11) hart gesperrt bleibt. Getestet in
`tests/controlPlane.states.test.ts` (u. a. „readGateState: IMMER false").

---

## 4. Secret-Store (AES-256-GCM)

- **Interface** `VenueSecretStore`: `put(venue, credential)` /
  `get(venue)` / `delete(venue)` / `exists(venue)`
  (`src/brokers/control-plane/secretStore.ts`).
- **Verschlüsselung:** AES-256-GCM, frischer 12-Byte-IV je `put`,
  **AAD = Venue-ID** (Auth-Tag bindet den Datensatz an die Venue — ein
  Datensatz einer anderen Venue schlägt bei der Entschlüsselung fehl),
  16-Byte-Auth-Tag. Envelope `{v, alg, iv, tag, ct}` (Base64) → Storage.
- **Key:** ausschließlich aus Env/KMS — `SECRET_STORE_KEY` (Hex/Base64,
  32 Byte; nie im Repo). KMS-Hook (`KmsClient.resolveKey`) vorbereitet:
  `SECRET_STORE_KMS_ENDPOINT` gesetzt → fail-safe Abbruch
  (`KMS_NOT_IMPLEMENTED`), nie stiller Env-Fallback.
- **Storage-Backends:** `db` (Tabelle `broker_credentials`, Default mit
  Fallback) → `file` (`data/secrets/*.enc`, chmod 600, gitignored) →
  `memory` (nur Tests). Fehlt `SECRET_STORE_KEY` → 503
  `SECRET_STORE_UNAVAILABLE` (fail-closed).
- **Task-07-Kompatibilität:** `createVenueBackedNamedStore("BITUNIX", …)`
  bildet die entschlüsselten Felder auf das task-07-Interface
  `SecretStore.get(name)` (`BITUNIX_API_KEY`/`BITUNIX_API_SECRET`) ab;
  Env-Fallback bleibt erhalten.
- **Memory-Hygiene:** Krypto-Pfad über Buffer; `zeroize()` nach Nutzung;
  Probe arbeitet mit dem transienten Wert und verwirft ihn danach
  (`disposeCredential`). JS-Strings sind unveränderlich — die Grenze ist
  dokumentiert; die Werte werden nie länger als den Request gehalten.

---

## 5. Permission-Probe (read-only)

Nach dem Speichern (und bei jedem Test) läuft **ein** read-only Check:

- **PAPER:** echte Probe gegen den Paper-Ledger (`getAccount()`,
  in-process) → `READ`, `TRADE`.
- **Andere Venues (Unabhängigkeitsklausel):** lokaler Mock-Adapter
  (`MockVenueApiClient`, deterministisch, **kein Netzwerk** — Adapter-Stubs
  existieren noch nicht bzw. haben kein Testnet). Regelwerk: gültiges
  Credential-Format → `READ`; `TRADE` genau dann, wenn
  `capabilities.trading` (Single Source of Truth); `apiKey === apiSecret` →
  401-Simulation (typische Fehlkonfiguration). Echte venue-spezifische
  Probes landen mit den Adapter-Aufgaben (task-03+).
- **Fehler →** Ebene `connection` = `error` mit SAFE-Meldung (z. B.
  „Die Venue hat die Zugangsdaten abgelehnt (401, read-only Probe).") —
  niemals Secret-Inhalte oder Infrastruktur-Details.

---

## 6. Sicherheitskonzept

| Ebene | Mechanismus | Nachweis |
| --- | --- | --- |
| **RBAC** | Alle Credential-/Connection-Operationen nur mit Permission `broker.credentials` (Admin; Operator nur im Single-Admin-Modell). `FIRM_ADMIN_TOKEN` gesetzt → Header `x-admin-token` (oder `x-firm-token` mit gleichem Wert), sonst **403 FORBIDDEN**; Fallback `FIRM_API_TOKEN` (401); gar kein Token → Offen-Betrieb **nur** bei wirksamem `AUTH_MODE=local-open` (Dev-Default bzw. ausdrücklicher Opt-in), sonst 401 `AUTH_NOT_CONFIGURED` — und in Produktion verweigert der Boot-Guard den Start. Timing-sicherer Vergleich. Kern: `src/auth/` (Modus: `src/auth/authMode.ts`). | `tests/controlPlane.api.test.ts` (RBAC), `tests/rbac.test.ts` |
| **CSRF** | Alle mutierenden Control-Plane-Endpoints verlangen den Custom-Header `x-csrf-token` (Wert = Admin-/Operator-Token bzw. `local`), sonst **403 CSRF_INVALID**. Cross-Site-Formulare können Custom-Header nicht setzen; die API nutzt keine Cookies (kein SameSite-Angriffsvektor). | `tests/controlPlane.api.test.ts` (CSRF) |
| **Rate-Limit (Identität)** | Eigener Sliding-Window-Bucket `BROKER_CREDENTIAL_RATE_LIMIT` (Default **5/min**, 0 = aus) auf allen Credential-Endpoints → **429** + `Retry-After`. Bucket-Schlüssel ist seit C2/v1.36.14 die geteilte `resolveClientIp()`-Auflösung: `x-verified-ip` nur bei Proxy-Vertrauen, `x-forwarded-for` nur hinter verifiziertem `TRUSTED_PROXY_IPS`-Peer (rightmost-untrusted), `x-real-ip` nie — sonst Socket-Adresse bzw. `local`. | `tests/clientIp.test.ts`, `tests/controlPlane.api.test.ts` (Rate-Limit) |
| **Rate-Limit (global)** | `BROKER_CREDENTIAL_GLOBAL_RATE_LIMIT` (Default **20/min**, 0 = aus): fester Bucket `global`, bewusst **ohne** Request-Identität — deckelt verteiltes Raten (Proxy-Wechsel, NAT, Botnet). Betrifft nur Credential-Endpoints, nie `/api/live/kill`. | `tests/controlPlane.bruteforce.test.ts` |
| **Backoff** | Exponentielle Sperre ab dem 3. fehlgeschlagenen Credential-Versuch (2 s → 4 s → 8 s … max. 15 min), gemeldet von der Route (422 Validierung bzw. von der Venue abgelehnte Probe); Reset nach 15 min Ruhe oder Erfolg. 429-Code `CREDENTIAL_BACKOFF`. | `tests/controlPlane.bruteforce.test.ts` |
| **Response-Contract** | Credential-Endpoints antworten ausschließlich mit Status-Objekten (`configured`, `connected`, `permissions[]`, `liveEnabled`, Ebenen) — kein `secret`, kein `keyHint`, keine Maskierungs-Replik. Contract-Test mit Response-Scanner erzwingt das. | `tests/controlPlane.security.test.ts` (Response-Scanner) |
| **Bundle-Scanner** | `scripts/scan-secrets.ts` scannt `.next/static` (gebaute Frontend-Bundles) auf Secret-Muster (API-Key-/Secret-Formate, Länge/Entropie-Heuristik) — Ergebnis muss leer sein. CI: `npm run build && npm run scan:secrets`. | `npm run scan:secrets`, Test „Bundle" |
| **Audit** | JEDES Ereignis (Credential gespeichert/geändert/gelöscht, Verbindungstest, Permission-Probe, Zustandswechsel) → Ring + `audit_log` (`BROKER_CONTROL_PLANE`): actor, venue, Aktion, Ergebnis, timestamp — **ohne Secrets**. | `tests/controlPlane.integration.test.ts` (Audit) |
| **XSS/CSP** | Nur JSX-Rendering, kein `dangerouslySetInnerHTML`/`innerHTML` in der Control-Plane-UI; keine Inline-Scripts; kompatibel mit der bestehenden CSP (`script-src 'self' 'unsafe-inline'`). | `tests/controlPlane.security.test.ts` (Frontend-Statik) |
| **Live-Gate** | `liveEnabled` ausschließlich aus `readGateState()` (= false bis task-11); keine Env, kein Endpoint, kein Flag kann Live setzen. | `tests/controlPlane.states.test.ts`, E2E |

---

## 7. Warum das Secret nie anzeigbar ist

1. **Kein Lesepfad:** Es existiert kein Endpoint und keine Funktion, die ein
   gespeichertes Secret zurückliefert. `get(venue)` dient ausschließlich
   Backend-internen, read-only Probes und liefert eine frische Kopie, die
   nach der Probe verworfen/genullt wird.
2. **Verschlüsselung at rest:** Gespeichert wird nur das AES-256-GCM-Envelope
   (IV + Ciphertext + Auth-Tag); der Schlüssel lebt in Env/KMS. Ein
   Datenbank- oder Datei-Dump allein ist wertlos.
3. **AAD-Bindung:** Der Auth-Tag bindet den Datensatz an die Venue — selbst
   ein umgehängter oder manipulierter Datensatz wird bei der
   Entschlüsselung abgewiesen.
4. **Status-only-Vertrag:** Die API kennt kein `secret`-Feld, kein
   `keyHint`, keine Maskierung. Der Response-Scanner (Test in CI) schlägt
   an, falls jemals ein Secret-Muster in einer Antwort auftaucht.
5. **Frontend-Statik:** Die Formularfelder sind `type="password"` mit
   `autoComplete="new-password"`; der State wird nach dem Submit geleert;
   es gibt keinen Client-Speicher für Credentials und keinen Anzeige-Pfad.
   Das Bundle wird zusätzlich auf Secret-Muster gescannt.
6. **Löschen statt Anzeigen:** Der einzige sichtbare „Zugriff" ist das
   Löschen der Referenz (mit Bestätigungsdialog + Audit-Eintrag).

---

## 8. Frontend-Struktur

```
src/app/brokers/page.tsx               eigenstaendige Seite /brokers
src/components/control-plane/
  BrokersPanel.tsx    Grid, Loading/Error/Empty-States, Refresh
  BrokerCard.tsx      Status-LED, Maerkte, Spot/Perpetual/Futures-Flags,
                      Buttons [Verbinden] [Test] [Einstellungen], 6 Chips
  StateChip.tsx       off/pending/active/error je Ebene
  CredentialForm.tsx  masked form (type=password, new-password, noValidate)
  SettingsPanel.tsx   read-only Flags + liveEnabled-"gesperrt" + Loeschen
  ConfirmDialog.tsx   Bestaetigung vor Credential-Loeschen
src/lib/controlPlane.ts                Client-Contract + CSRF-Helper
```

Dashboard-Integration: neuer Tab „🌐 Brokers & Venues" im FirmDashboard.

---

## 9. Tests & Abweichungen (RECON-Dokumentation)

- **Unit:** `tests/secretStore.test.ts` (Roundtrip, Wrong-Key, Tampering →
  Auth-Tag, AAD-Bindung, Buffer-Nullung, Backends, Task-07-Bridge),
  `tests/controlPlane.states.test.ts` (Übergänge + Missbrauch 409/422).
- **Contract/Security:** `tests/controlPlane.security.test.ts` (Response-
  Scanner über ALLE Broker-API-Responses, Bundle-Scanner, CSRF, RBAC,
  Rate-Limit, Frontend-Statik, Scanner-Unit).
- **API:** `tests/controlPlane.api.test.ts` · **Integration:**
  `tests/controlPlane.integration.test.ts` (Connect-Flow, Zustandsübergänge,
  Audit je Aktion) · **E2E:** `tests/controlPlane.e2e.test.ts` (Connect →
  Test → Status sichtbar → Disconnect/Delete; Secret maskiert; Live off).
- Coverage: `npm run test:coverage:controlplane` (Ziel ≥ 90 %).

**Dokumentierte Abweichungen:**

1. **Branch:** Session-Branch `arena/01a04561-ai-trading-firm` statt
   `feature/task-08-broker-control-plane` (Arena-Session-Bindung; PR wird
   von diesem Branch geöffnet).
2. **E2E-Werkzeug:** repo-konform über die Route-Handler statt Playwright
   (keine Browser-Abhängigkeit im Repo; CI-fähig ohne Playwright-Download).
   Der Flow entspricht 1:1 dem geforderten Ablauf.
3. **Permission-Probe:** lokaler Mock-Adapter für noch nicht implementierte
   Venue-Adapter (Unabhängigkeitsklausel) — PAPER wird real geprobt.
4. **Live:** ohne task-11 stets `liveEnabled:false` — wie gefordert.
5. **Sandbox-Hinweis:** Tests laufen ohne PostgreSQL; das DB-Backend des
   Secret-Stores ist lazy und fällt auf das Datei-Backend zurück
   (betrieblich identisch, Fail-Safe by design).
