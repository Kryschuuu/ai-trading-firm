# RMA-P4-02: Post-Only + Timeout + Market-Fallback

- **Antwort:** Teilweise
- **Tracking-Status:** `PARTIAL`
- **Severity:** `HIGH`
- **Quick Estimate Restaufwand:** **3–5 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P4-02`](../prompts/PROMPT-P4-02-post-only-fallback.md)

## Verifizierte Fundstellen

- `src/contracts/broker.ts::BrokerOrderRequest` — gemeinsamer Ordervertrag.
- `src/brokers/bitunix/orders.ts` — Venue-Serialisierung von Ordertypen.
- `src/brokers/alpaca/orders.ts` — Limit-/Market-Orderaufbau.
- `src/brokers/*/execution.ts` — Platzierung ohne gemeinsame TTL-/Fallback-State-Machine.

## Bewertung und Abgrenzung

Limit- und Marketorders sind verfügbar; venueabhängige Parameter können serialisiert werden. Eine koordinierte Policy aus Maker-Versuch, Timeout, Cancel-Bestätigung und optionalem Taker-Fallback fehlt.

## Konkretes Delta

- gemeinsamer ExecutionPolicy-Vertrag mit Post-Only, TTL, Repricing und Fallback-Bounds
- persistente Zustandsmaschine für ACK, REJECT, PARTIAL, CANCEL_PENDING, CANCELLED und FALLBACK
- Idempotency über Netzwerkfehler und Prozessrestart
- Remaining-Quantity-Berechnung nach Partial Fill
- Notional-, Spread-, Slippage- und Kill-Switch-Gates vor Market-Fallback

## Akzeptanzkriterien für `FIXED`

- [ ] Fallback kann niemals mehr als die offene Restmenge handeln
- [ ] keine Marketorder vor bestätigtem Cancel oder venue-sicherem Replace
- [ ] Post-Only-Reject ist explizit von sonstigen Rejects unterscheidbar
- [ ] Restart setzt eine Order idempotent aus persistiertem Zustand fort

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
