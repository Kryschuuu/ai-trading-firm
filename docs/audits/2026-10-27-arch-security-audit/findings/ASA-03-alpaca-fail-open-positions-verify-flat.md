# ASA-03 — Alpaca-Live-Adapter war bei Positionsabfragen Fail-Open

- **ID:** ASA-03
- **Severity:** CRITICAL
- **Bereich:** Sicherheit / Live-Execution-Zuverlässigkeit
- **Status:** FIXED
- **Behoben am:** 2026-10-27
- **Datei(en):** `src/brokers/alpaca/execution.ts`, `src/brokers/alpaca/privateClient.ts`, `src/brokers/alpaca/http.ts`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md`](../prompts/PROMPT-ASA-P0-03-alpaca-failclosed-and-429-backoff.md)

## Ursprünglicher Befund

`AlpacaExecutionAdapter.safeGetPositions()` schluckte Netzwerk-, Timeout-, Rate-Limit- (`429`) und API-Fehler und gab stattdessen `[]` zurück. Dadurch arbeiteten Konto-Risikoprüfung, Notfall-Glattstellung (`closeAllPositions`) und Glattstellungs-Verifikation (`verifyFlat`) im Fehlerfall **Fail-Open**.

### Technischer Nachweis

1. `safeGetPositions()` fing alle Fehler ab und gab ein leeres Array zurück.
2. `getAccount()` setzte `openPositions: 0` und meldete bei API-Störung keine offene Exposure.
3. `closeAllPositions()` übersprang `DELETE /v2/positions`, wenn der Vorab-GET fehlschlug oder fälschlich `[]` lieferte.
4. `verifyFlat()` wertete ein leeres Fallback-Array als `true` („glattgestellt“).
5. `AlpacaHttp.request()` wertete `Retry-After` nicht aus und schützte mehrdeutige POST-Wiederholungen nicht zuverlässig anhand eines Alpaca-Idempotenzschlüssels im Request-Body.

## Behobene Maßnahmen

- `safeGetPositions()` wurde vollständig entfernt. `fetchPositionsStrict()` propagiert Broker- und HTTP-Fehler unverändert und lehnt ungültige Positionslisten bzw. ungültige offene Positionsdatensätze als `BrokerError` ab. `getAccount()` und `listPositions()` verwenden ausschließlich diesen strikten Snapshot.
- `closeAllPositions()` storniert Orders best-effort und auditiert Cancel-Fehler, liest einen optionalen Vorab-Snapshot nur für den Bericht und sendet **immer** `DELETE /v2/positions?cancel_orders=true`. Auch bei HTTP `207 Multi-Status` oder leerer Antwort entscheidet allein der anschließende strikte Positions-GET über den Zustand. Fehler der Nachkontrolle werden geworfen; gemeldet werden nur nachkontrolliert verschwundene Positionen.
- `verifyFlat()` nutzt denselben strikten Positionsabruf und wirft bei Fehlern konsistent mit dem Bitunix-Adapter, statt `true` vorzutäuschen.
- `AlpacaHttp` respektiert `Retry-After` bei `429` (und `503`) als Delta-Sekunden einschließlich Dezimalwerten oder als HTTP-Datum. Der Wert und der exponentielle Backoff sind über `maxRetryDelayMs` gedeckelt und per `AlpacaHttp`-Option konfigurierbar. Eine explizite `429`-Ablehnung bleibt retry-fähig; mehrdeutige Netzwerk-, Timeout- und `5xx`-Fehler werden nur für `GET`, `DELETE` oder `POST` mit nicht-leerem `client_order_id` im JSON-Body wiederholt. Der private Alpaca-Client sendet diesen Schlüssel daher im Body mit.

## Verifikation

- [x] `GET /v2/positions` mit HTTP `503` oder `429`: `getPositions()`, `getAccount()` und `verifyFlat()` melden keinen falschen Flat-Zustand; die Fehler bleiben `BrokerError`.
- [x] Fehlgeschlagener Vorab-GET blockiert `DELETE /v2/positions?cancel_orders=true` nicht; `207` und eine leere Antwort werden anschließend strikt verifiziert.
- [x] Ein fehlgeschlagener Nachher-GET lässt `closeAllPositions()` mit `BrokerError` scheitern.
- [x] `Retry-After: 1`, Dezimal-Sekunden und HTTP-Datum werden getestet; ein ungeschlüsselter POST wird bei Timeout nicht blind erneut gesendet, ein POST mit `client_order_id` darf kontrolliert wiederholt werden.
- [x] Regression: `tests/asa03.alpacaFailClosed.test.ts`, bestehende Alpaca-Tests und `tests/brokerContracts.test.ts`.
