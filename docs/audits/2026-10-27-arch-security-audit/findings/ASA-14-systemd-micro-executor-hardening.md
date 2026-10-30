# ASA-14 — `deploy/micro-executor.service` fehlt jegliches `systemd`-Sandboxing und weicht bei Pfaden/User von der Haupt-Unit ab

- **ID:** ASA-14
- **Severity:** LOW
- **Bereich:** Sicherheit / Betrieb (Deployment)
- **Status:** FIXED (v0.17.7, 2026-10-30)
- **Datei(en):** `deploy/micro-executor.service:7-24`, `deploy/ai-trading-firm.service:1-40`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md`](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md)

## Umsetzung (2026-10-30)

Beide Units nutzen `atf:atf`, `/opt/ai-trading-firm`, dieselbe `.env` und
identische Basis-Sandbox samt `data`/`.runtime` als writable paths;
`RuntimeMaxSec=0` entfällt. Die nötige Verzeichnis-/Rechtevorbereitung und der
Upgrade-Pfad stehen in `docs/INSTALL.md` Kapitel 7. Regression:
`tests/asa13_14_15.architectureOpsAlerts.test.ts`.

Die folgende Beschreibung und der technische Nachweis dokumentieren den
**historischen Prüfstand 2026-10-27**, nicht den aktuellen Code.

## Beschreibung

Die `systemd`-Unit `deploy/micro-executor.service` läuft ohne jede Prozess- oder Dateisystem-Härtung und verwendet andere Benutzer-, Pfad- und `EnvironmentFile`-Konventionen als `deploy/ai-trading-firm.service`.

## Technischer Nachweis

- `deploy/ai-trading-firm.service` setzt `User=atf`, `WorkingDirectory=/opt/ai-trading-firm` sowie `NoNewPrivileges=true`, `PrivateTmp=true` und `ProtectSystem=strict`.
- `deploy/micro-executor.service:7-24` setzt dagegen `User=trader`, `WorkingDirectory=/path/to/ai-trading-firm`, `RuntimeMaxSec=0` und keinerlei Sandboxing-Direktiven (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem`, `ProtectHome`, `ReadWritePaths`, `RestrictSUIDSGID`, `LockPersonality`).

## Konkreter Lösungsvorschlag

- Benutzer (`User=atf`, `Group=atf`), Arbeitsverzeichnis (`/opt/ai-trading-firm`) und `EnvironmentFile=/opt/ai-trading-firm/.env` an `deploy/ai-trading-firm.service` angleichen.
- `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, `ProtectHome=true`, `RestrictSUIDSGID=true` und `ReadWritePaths=/opt/ai-trading-firm/data /opt/ai-trading-firm/.runtime` ergänzen; unnötiges `RuntimeMaxSec=0` entfernen.

## Akzeptanzkriterien / Verifikation

- [x] Beide Units unter `deploy/` nutzen konsistente Pfade/Benutzer und identische `systemd`-Basis-Sandboxing-Direktiven; ein statischer Deployment-Unit-Test prüft diese Invarianten.
