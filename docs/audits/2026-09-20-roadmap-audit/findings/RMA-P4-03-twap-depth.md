# RMA-P4-03: TWAP und Depth-aware Execution

- **Antwort:** Nein
- **Tracking-Status:** `OPEN`
- **Severity:** `MEDIUM`
- **Quick Estimate Restaufwand:** **5–8 PT**
- **Umsetzungs-Prompt:** [`PROMPT-P4-03`](../prompts/PROMPT-P4-03-twap-depth.md)

## Verifizierte Fundstellen

- `src/contracts/broker.ts::BrokerAdapter.getOrderBook()` — Orderbuchabfrage.
- `src/marketdata/sync.ts::MarketDataAdapter.getOrderBook()` — Snapshot im Datenpfad.
- `src/brokers/*/execution.ts` — Einzelorder-Ausführung.
- Repository-Suche nach TWAP, Child Order, Participation und Impact Scheduler ergab keinen produktiven Pfad.

## Bewertung und Abgrenzung

Orderbuchtiefe kann gelesen werden. Es fehlt die algorithmische Ebene, die einen Parent-Auftrag in zeit-/depth-gesteuerte Child Orders zerlegt und nach Restart fortsetzt.

## Konkretes Delta

- Parent-/Child-Order-Datenmodell und persistente Scheduler-Zustände
- deterministischer TWAP-Plan mit Jitter-Seed, Mindestlos und Rundung
- Depth-/Spread-/Participation-Gates und Size-Impact-Schätzung
- Pause, Cancel, Resume, Deadline und Kill-Switch-Integration
- Execution-Quality-Vergleich gegen Sofortausführung

## Akzeptanzkriterien für `FIXED`

- [ ] Summe der Child-Zielmengen entspricht nach Rundung exakt der Parent-Menge
- [ ] kein Slice verletzt Venue-Minimum, Notional- oder Participation-Cap
- [ ] stale/fehlende Depth pausiert oder nutzt expliziten sicheren Fallback
- [ ] Scheduler-Restart dupliziert keine bereits bestätigte Child Order

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
