# STX-08 — Alpaca hat keinen WebSocket; Leader-Adapter-Annahme trifft nicht zu

- **ID:** STX-08
- **Severity:** MEDIUM
- **Bereich:** Broker / Copy-Trading
- **Quelle:** Ausbaudokument §2.3, §2.8
- **Status:** OPEN — bestätigt im Abgleich 2026-10-03 (kein Alpaca-WebSocket; bewusst eigener Adapter-Audit)
- **Datei(en):** `src/brokers/alpaca/`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☐` **OPEN** — Befund unverändert gültig
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `grep -rniE "wss://|websocket" src/brokers/alpaca/` → **0 Treffer** (16 Dateien, REST-only)
- `src/brokers/bitunix/ws.ts` existiert — Bitunix-first bleibt richtig, Phase 7 ist darüber abgeschlossen (07-01…07-03)
- Konsequenz: Alpaca als Copy-Leader bleibt außerhalb dieser Roadmap; ein Leader-Adapter hätte einen eigenen WS-Client mit Reconnect/Heartbeat/Backfill zur Voraussetzung

## Beschreibung

§2.3/§2.8 behandelt den Alpaca-Adapter als nahezu fertig und empfiehlt, den
`trade_updates`-WS-Stream für den Leader zu nutzen. Im Repo existiert **kein** WebSocket
für Alpaca.

## Beweis

```
$ ls src/brokers/alpaca/
adapter.ts  audit.ts  config.ts  errors.ts  execution.ts  gates.ts  http.ts
index.ts    mapping.ts orders.ts  paper.ts  privateClient.ts  publicClient.ts
redactor.ts secrets.ts  types.ts

$ ls src/brokers/bitunix/ | grep ws
ws.ts
```

```
$ grep -rn "wss://|WebSocket|websocket" src/brokers/alpaca/   # → 0 Treffer
```

Der Adapter ist REST-only. `clientOrderId`-Idempotenz existiert
(`orders.ts:97 clientOrderIdFor`, `execution.ts:241-244 buildClientOrderId`) — dieser Teil
der Dokumenteintschätzung ist korrekt.

## Remediation

1. Copy-Roadmap: **Bitunix zuerst** (`ws.ts` existiert), Alpaca **später** und als
   eigener Adapter-Audit (neuer `ws.ts` mit Reconnect/Heartbeat/Backfill — nicht trivial).
2. Polling ist **kein** Ersatz: `getOrderUpdates` ist paginiert, `events/orders/status`
   hat Sekundenlatenz, und Polling-Raten kollidieren mit den Rate-Limit-Budgets des
   Adapters (`http.ts:158-252` hat bereits Retry-/Idempotenz-Logik für genau solche Fälle).
3. Kopplung an `trading` als **Feature-Flag** mit eigener Kill-Switch-Stufe.

## Akzeptanzkriterien

- [ ] Kopplung nur mit WS-Quelle; kein stilles Polling
- [ ] Ohne WS-Provider keine Leader-Subscription (fail-closed, kein „letzter bekannter Stand")
- [ ] Alpaca-Adapter-Audit als **eigener** Track, nicht Teil der Copy-Roadmap

## Versions-Hinweis

N/A (Befund, keine Änderung).
