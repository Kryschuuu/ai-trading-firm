# ASA-15 — Synchrone Datei-I/O in `FileAlertSink` und unvalidierte Ziel-URLs (`http://`, Loopback, Link-Local) in `WebhookAlertSink`

- **ID:** ASA-15
- **Severity:** LOW
- **Bereich:** Sicherheit / Performance
- **Status:** FIXED (v0.17.7, 2026-10-30)
- **Datei(en):** `src/lib/alerts.ts:264-335`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md`](../prompts/PROMPT-ASA-P2-10-state-registry-dashboard-split-systemd-alerts.md)

## Umsetzung (2026-10-30)

Datei-Alerts verwenden asynchrones `mkdir` mit pro Instanz gecachtem Promise und
serialisiertes `appendFile` (inklusive Recovery). Webhooks erzwingen HTTPS,
prüfen sämtliche DNS-Antworten auf öffentliche Adressen und pinnen die geprüfte
Adresse für die Verbindung; TLS-Hostname bleibt erhalten und Redirects sind
verboten. Nur explizite Loopback-Tests können die Ausnahme aktivieren.
Regression: `tests/asa13_14_15.architectureOpsAlerts.test.ts`,
`tests/alerts.fileRecovery.test.ts` und `tests/alerts*.test.ts`.

Die folgende Beschreibung und der technische Nachweis dokumentieren den
**historischen Prüfstand 2026-10-27**, nicht den aktuellen Code.

## Beschreibung

`FileAlertSink` blockiert bei jedem Alert den Node.js-Event-Loop mit synchroner Datei-I/O, und `WebhookAlertSink` sendet POST-Requests ohne Schema- oder Zielnetz-Prüfung auch an unverschlüsselte `http://`-Endpunkte sowie interne Loopback-/Link-Local-/Cloud-Metadaten-Adressen.

## Technischer Nachweis

1. `FileAlertSink.emit()` (`src/lib/alerts.ts:276-281`) ruft pro Ereignis `mkdirSync(dirname(this.filePath), { recursive: true })` und `appendFileSync(this.filePath, ...)` auf, obwohl `AlertSink.emit` bereits `Promise<void>` zurückgibt.
2. `WebhookAlertSink` (`src/lib/alerts.ts:300-335`) reicht `this.url` ungeprüft an `fetch()` weiter (inkl. `http://169.254.169.254/...` oder `http://127.0.0.1:11434/...`) und setzt `redirect: "manual"` nicht, sodass ein externer HTTPS-Endpunkt per 302-Redirect auf eine interne Adresse umleiten kann.

## Konkreter Lösungsvorschlag

- `FileAlertSink.emit()` auf `mkdir` (einmalig pro Pfad gecacht) + `appendFile` aus `node:fs/promises` umstellen.
- In `WebhookAlertSink` die URL beim Konstruieren und vor dem Versand prüfen: nur `https:` zulassen (außer ein expliziter Test-Parameter `allowInsecureLocal?: boolean` wird in Unit-Tests übergeben), Hostnamen/IPs gegen Loopback (`127.0.0.0/8`, `::1`, `localhost`), Link-Local (`169.254.0.0/16`, `fe80::/10`) und RFC1918 sperren sowie `redirect: "error"` beim `fetch()` setzen.

## Akzeptanzkriterien / Verifikation

- [x] `FileAlertSink` verwendet keine synchronen `fs`-Aufrufe mehr.
- [x] `WebhookAlertSink` lehnt `http://`-URLs, Loopback-/Metadaten-Ziele und HTTP-Redirects standardmäßig deterministisch ab (abgesichert durch Unit-Tests).
