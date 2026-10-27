# ASA-13 — 34 verstreute `globalThis`-Singletons umgehen `stateRegistry.ts`; `FirmDashboard.tsx` (1.934 Zeilen) triggert unnötige Polling-Resets

- **ID:** ASA-13
- **Severity:** MEDIUM
- **Bereich:** Architektur & Wartbarkeit
- **Status:** OPEN
- **Datei(en):** `src/lib/stateRegistry.ts:1-95`, `src/components/FirmDashboard.tsx:1-1934` (insb. Zeilen `386-395`)
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md`](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md)

## Beschreibung

1. `src/lib/stateRegistry.ts` verwaltet nur 4 Singletons, während 34 weitere Module im Repo eigene ungetrackte `globalThis.__*`-Variablen anlegen. Dadurch greift `resetAllRegisteredState()` in Tests und beim Debugging nur auf einen Bruchteil des tatsächlichen Prozesszustands.
2. `src/components/FirmDashboard.tsx` bündelt auf 1.934 Zeilen über 30 State-Slices und hängt im Polling-`useEffect` (Zeile 386–395) direkt von `data.missions` (Array-Referenz) ab, wodurch das `setInterval` nach jedem einzelnen Poll zerstört und neu angelegt wird — selbst bei ausgeblendetem Browser-Tab.

## Technischer Nachweis

1. Ein Grep nach `globalThis.__` bzw. `(globalThis as` über `src/` findet 34 Module außerhalb von `stateRegistry.ts` (darunter `live-gate/service.ts`, `microExecutor.ts`, `authSession.ts`, `killSwitchNonce.ts`, `loginRateLimit.ts`, `brokers/control-plane/guard.ts`, `db/index.ts`).
2. In `src/components/FirmDashboard.tsx:386-390`:
   `const hasActive = data.missions.some((m) => m.status === "ACTIVE");` steht **innerhalb** des `useEffect`, während das Dependency-Array `[load, data.missions]` lautet. Jeder Fetch erzeugt ein neues `missions`-Array und triggert `clearInterval` + `setInterval`.

## Konkreter Lösungsvorschlag

- Alle rücksetzbaren In-Memory-Singletons über `registerState(...)` an `stateRegistry.ts` anbinden (langlebige Infrastruktur-Handles wie `dbPool` explizit als `infra` kennzeichnen oder dokumentiert ausnehmen) und durch einen statischen Architektur-Test absichern.
- In `FirmDashboard.tsx`:
  - `const hasActiveMission = useMemo(() => data.missions.some((m) => m.status === "ACTIVE"), [data.missions]);` berechnen, Effekt nur von `[load, hasActiveMission]` abhängig machen und bei `document.visibilityState === "hidden"` pausieren.
  - Eigenständige Sub-Komponenten/Hooks (z. B. `useFirmDashboardPolling`, Missions-/Micro-/Risk-Sektionen) in `src/components/firm/` extrahieren.

## Akzeptanzkriterien / Verifikation

- [ ] Statischer Test stellt sicher, dass keine neuen unregistrierten `globalThis.__*`-Singletons außerhalb von `stateRegistry.ts` (bzw. expliziter Infrastruktur-Allowlist) entstehen.
- [ ] Der Polling-Timer in `FirmDashboard` wird bei unverändertem `hasActiveMission`-Bool nicht mehr bei jedem Response-Objekt neu registriert und pausiert bei verstecktem Tab.
