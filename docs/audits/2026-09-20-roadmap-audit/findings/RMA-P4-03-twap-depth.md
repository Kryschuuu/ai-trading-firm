# RMA-P4-03: TWAP und Depth-aware Execution

- **Antwort:** Ja
- **Tracking-Status:** `FIXED`
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

- [x] Summe der Child-Zielmengen entspricht nach Rundung exakt der Parent-Menge
- [x] kein Slice verletzt Venue-Minimum, Notional- oder Participation-Cap
- [x] stale/fehlende Depth pausiert oder nutzt expliziten sicheren Fallback
- [x] Scheduler-Restart dupliziert keine bereits bestätigte Child Order

## Review-Evidenz

- Audit-Basis: Commit `df3163e`, Produktversion `v1.51.1`. Umsetzung auf `v1.70.0` (`7284564`) → Fix `v1.71.0`, weil P4.2 dort bereits existiert. Der P4.2-Pfad bekommt nur `cancelOpen`; Kinder laufen darüber, ohne Market-Chase.
- Fix: Commit `624e3fe`, [PR #169](https://github.com/Kryschuuu/ai-trading-firm/pull/169).
- Tests: `tests/twap.plan.test.ts` (21), `tests/twap.scheduler.test.ts` (8: Summe, Participation, stale/missing/future, Volumen null/0, Seed, Restart/Dual-Worker, Deadline/Kill ohne Market, Disconnect, Status aus Zeilen), `tests/twap.db.test.ts` (6: Migration idempotent, Roundtrip, Lease, append-only, NULL bleibt NULL, Restart ohne zweiten Submit, Port 55449). `npx tsc --noEmit`, `npm run lint`, `npm run docs:validate` grün. Voller `npm test` nicht gelaufen.
- Methode: statische Pfad-/Symbolprüfung, Schema- und Testabgleich; keine reine
  Dokumentationsbehauptung als Implementierungsbeleg.
- Tracking: [`../remediation/TRACKING.md`](../remediation/TRACKING.md)
