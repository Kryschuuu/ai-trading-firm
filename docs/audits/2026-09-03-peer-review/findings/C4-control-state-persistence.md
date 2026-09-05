# C4 — Control-Plane-State ist nur im Prozessspeicher

- **Severity:** MEDIUM
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **gefixt v.1.36.16** (Tabelle `venue_control_state`; Map ist nur noch Cache).
- **Datei(en):** `src/brokers/control-plane/stateStore.ts` (neu),
  `src/brokers/control-plane/service.ts`, `src/db/schema.ts`, `src/lib/seed.ts`,
  `src/instrumentation.ts`, `drizzle/2026-09-04_c4_venue_control_state.sql` (neu)

## Arena-Prompt (kopierbar)

```
TASK: Persist the venue control-plane state to the database; treat in-memory as cache.

PROBLEM: VenueControlState lives only in G.__controlPlaneStates (a Map). Credentials are persistent,
but after a process restart the state shows INITIAL (configured=true, connected=false) until re-tested
— a consistency gap.

DO:
1. Add a table `venue_control_state` (drizzle) keyed by venue with columns: venue(text pk),
   configured(bool), connected(bool), permissions(jsonb), live_enabled(bool), last_probe(timestamptz),
   connection_state(text), discovery_state(text), discovery_count(int), last_error(text),
   updated_at(timestamptz). Keep it additive (no break).
2. In service.ts, persist on every writeState(): upsert the row. On readState(), if not in the
   in-memory map, load from DB; if DB row absent, return createInitialControlState (and lazily persist).
3. Make readVenueControlStatePublic / getStatus reflect persisted state (so a restart shows the last
   known connection state, not always INITIAL).
4. Add a migration (drizzle-kit generate/push) and a test: set state -> restart map (resetForTests)
   -> readState loads from DB.

ACCEPTANCE: After writeState + process "restart" (map cleared), readState returns the persisted state;
getStatus reflects it. No behaviour change while the map is warm.
```

## Befund (vor v1.36.16)

`src/brokers/control-plane/service.ts` L134‑141:

```ts
const G = globalThis as typeof globalThis & { __controlPlaneStates?: Map<string, VenueControlState>; };
function stateMap(): Map<string, VenueControlState> {
  return (G.__controlPlaneStates ??= new Map());
}
function readState(venue) {
  let state = stateMap().get(venue);
  if (!state) { state = createInitialControlState(venue); map.set(venue, state); }
  return state;                                   // nach Neustart: immer INITIAL
}
function writeState(state) { stateMap().set(state.venue, state); }   // nur RAM
```

Credentials lagen persistent in `broker_credentials`, der Zustand nicht. Nach einem
Neustart zeigte `GET /api/brokers/{venue}/status` `configured=true, connected=false`,
und ein erneutes `POST /credentials` ging durch, obwohl die Verbindung zuvor aktiv war
(`ALREADY_CONNECTED` griff nicht mehr).

## Fix (v1.36.16) — DB ist die Wahrheit, die Map nur Cache

1. **Tabelle `venue_control_state`** (`src/db/schema.ts`, additiv): `venue` text PK,
   `configured`, `connected`, `permissions` jsonb (Rechte-**Namen**), `live_enabled`,
   `last_probe`, `connection_state`, `discovery_state`, `discovery_count`,
   `discovery_last_sync`, `last_error`, `layers` jsonb (vollständiger 6-Ebenen-Snapshot
   für verlustfreie Rehydrierung), `updated_at`. Status-only — nie Secret-Inhalt.
   Migration: `npx drizzle-kit push` oder das idempotente
   `drizzle/2026-09-04_c4_venue_control_state.sql`. `checkSchema()` (`/api/health`)
   und `setup-cachyos.sh` (`REQUIRED_TABLES=14`) kennen die Tabelle.
2. **`src/brokers/control-plane/stateStore.ts`** (neu): `ControlStateRepository`
   (`load/save/all/remove`), `DbControlStateRepository` (Drizzle-Upsert
   `onConflictDoUpdate`), `MemoryControlStateRepository` (Tests + Fail-Safe-Fallback),
   `toPersistedRow()`/`fromPersistedRow()`, Backend-Wahl `resolveControlStateRepository()`
   (Flag `CONTROL_STATE_BACKEND`, `db` Default; ohne erreichbare Tabelle Memory-Fallback +
   **eine** redigierte Log-Warnung — Verhalten wie vor C4, kein Bruch).
3. **`service.ts`:** `writeState()` ist async und **upsertet** bei jeder Aktion
   (save/test/discover/disable, `configured` aus dem Secret-Store). `loadState()` liest
   Cache → DB → Initialzustand (lazy persistiert), Single-Flight je Venue. `getStatus`,
   `saveCredentials`, `testConnection`, `discover`, `deleteCredentials` laufen darüber.
   `readState()` cached kalte Venues nicht mehr (sonst würde nie nachgeladen).
4. **`readVenueControlStatePublic()`** (synchron, Live-Gate-Bridge) liest den Cache; kalt
   stößt es die Hydration an und liefert bis dahin fail-safe `off` (deny).
   **`warmControlPlaneStateCache()`** lädt beim Boot (`src/instrumentation.ts`) und in
   `getControlPlaneService()` alle Zeilen vor. Neu: `loadVenueControlState()` (async).
5. **Live bleibt Enforcer-Projektion:** `live_enabled` in der DB ist nur informativ;
   `fromPersistedRow()` projiziert `liveEnabled`/`liveReason`/Live-Ebene neu aus
   `readGateState()`. Eine manipulierte Zeile schaltet nichts frei.

## Akzeptanzkriterien / Tests

- [x] `venue_control_state`-Tabelle existiert; `writeState` upsertet
      (gegen echte PostgreSQL: `drizzle-kit push` → Tabelle, zweiter Lauf
      `No changes detected`; eine Zeile je Venue nach mehreren Writes).
- [x] Nach Map-Reset liefert `readState` den persistierten Zustand
      (`tests/controlPlane.persistence.test.ts`: `loadVenueControlState`,
      `readVenueControlStatePublic` nach Hydration/Warm-up).
- [x] `getStatus` zeigt nach Restart den letzten bekannten Zustand — identisch zum warmen
      Zustand (`connected`, `permissions`, Ebenen, `updatedAt`); Fehler-, Discovery- und
      disable-Zustände ebenso.
- [x] Kein Verhaltensunterschied bei warmem Cache; `ALREADY_CONNECTED` greift auch nach
      Neustart.
- [x] Zeile ist status-only (Secret-Scanner + Feld-Whitelist); `live_enabled=true` in der
      DB schaltet nichts frei.
- [x] Fail-Safe: kaputtes/fehlendes Repository bricht den Pfad nicht (eine Warnung).
- [x] `npm run typecheck`, `npm run lint`, `npm test` (1702) grün — mit und ohne DB.

## Changelog-Blurb

`C4 (MEDIUM): Control-Plane-State nur im RAM — persistiert jetzt in venue_control_state; Neustart
zeigt letzten bekannten Zustand statt INITIAL.`

## Versions-Hinweis

PATCH **1.36.16** — additive DB-Tabelle, abwärtskompatibel (ursprünglich als `1.36.3`
geplant; maßgeblich ist die Serie in `docs/AUDIT_REMEDIATION_2026-09.md`). Details:
`CHANGELOG.md`, `docs/CHANGELOG.md`.
