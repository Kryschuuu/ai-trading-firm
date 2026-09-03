# C4 — Control-Plane-State ist nur im Prozessspeicher

- **Severity:** MEDIUM
- **Bereich:** Control Panel
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/brokers/control-plane/service.ts` (`stateMap()` L134‑138, `readState`/`writeState`)

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

## Beweis (aktueller Code)

`src/brokers/control-plane/service.ts` L134‑141:

```ts
const G = globalThis as typeof globalThis & { __controlPlaneStates?: Map<string, VenueControlState>; };
function stateMap(): Map<string, VenueControlState> {
  return (G.__controlPlaneStates ??= new Map());
}
function readState(venue) {
  let state = stateMap().get(venue);
  if (!state) { state = createInitialControlState(venue); map.set(venue, state); }
  return state;
}
```

## Fix-Spezifikation

`configured`/`lastProbe`/`connectionState`/`permissions`/`lastError`/`discovery` in DB-Tabelle
persistieren; In-Memory nur als Cache (siehe Audit C4).

## Akzeptanzkriterien / Tests

- [ ] `venue_control_state`-Tabelle existiert; `writeState` upsertet.
- [ ] Nach Map-Reset liefert `readState` den persistierten Zustand.
- [ ] `getStatus` zeigt nach Restart den letzten bekannten Zustand.

## Changelog-Blurb

`C4 (MEDIUM): Control-Plane-State nur im RAM — persistiert jetzt in venue_control_state; Neustart
zeigt letzten bekannten Zustand statt INITIAL.`

## Versions-Hinweis

PATCH (`1.36.3`) — additive DB-Tabelle, abwärtskompatibel.
