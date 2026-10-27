# ASA-10 — Deterministischer LLM-Fallback eröffnet bei Modell-Ausfall blind `LONG`-Trades; Drawdown-Alerts vergleichen `0..1` mit `5/10/20`

- **ID:** ASA-10
- **Severity:** MEDIUM
- **Bereich:** Code-Qualität / Handelslogik
- **Status:** OPEN
- **Datei(en):** `src/lib/ollama.ts:305-372`, `src/lib/monitor.ts:554`, `src/lib/monitor.ts:865-910`
- **Session-Prompt:** [`../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md`](../prompts/PROMPT-ASA-P2-09-fallback-hold-equity-alerts-db-indexes-memory.md)

## Beschreibung

Zwei fachlogische Fehler im Risiko- und Ausführungspfad:
1. Fällt Ollama aus (Netzwerkfehler, Timeout, OOM), liefert `fallbackReason()` im Produktionscode `SIGNAL: BUY`, `VERDICT: APPROVE` und `ACTION: TRADE / DIRECTION: LONG / ALLOCATION_PCT: 8` — ein Infrastruktur-Ausfall löst damit aktive Käufe statt eines sicheren `HOLD` aus.
2. `checkEquityAlerts()` vergleicht `broker.drawdownPct` (`0..1`) direkt mit Prozent-Schwellen `[5, 10, 20]` und liest einen bereits überschriebenen `peak`-Wert, sodass weder Drawdown- noch New-Equity-High-Alerts jemals feuern können.

## Technischer Nachweis

1. In `src/lib/ollama.ts:305-372` fängt `ask()` jeden Verbindungs-/HTTP-Fehler ab und ruft `fallbackReason(agent, prompt)` auf, das standardmäßig eine vollständige `LONG`-Kaufempfehlung inkl. Risk-Freigabe synthetisiert.
2. In `src/lib/broker.ts:357` ist `drawdownPct` als `(peakEquity - equity) / peakEquity` (`0..1`) definiert. In `src/lib/monitor.ts:868-895` prüft `checkEquityAlerts` jedoch `dd >= threshold` gegen `DRAWDOWN_THRESHOLDS = [5, 10, 20]`.
3. In `src/lib/monitor.ts:554` überschreibt `recordEquitySnapshot` `getEquityAlertState().peak = broker.peakEquity`, **bevor** in Zeile 557 `checkEquityAlerts(equity)` aufgerufen wird (`equity > state.peak` ist damit stets `false`).

## Konkreter Lösungsvorschlag

- `fallbackReason()` standardmäßig Fail-Closed auf `SIGNAL: NEUTRAL`, `VERDICT: REJECT (LLM unavailable)` und `ACTION: HOLD` umstellen (ein synthetischer Trade-Fallback darf allenfalls in expliziten Offline-Demo-Tests per dediziertem Parameter aktiv sein).
- In `src/lib/monitor.ts` `const prevPeak = getEquityAlertState().peak` vor `recordEquitySnapshot` sichern bzw. die Peak-Aktualisierung ausschließlich in `checkEquityAlerts` vornehmen und `const ddPct = broker.drawdownPct * 100` gegen `[5, 10, 20]` vergleichen.

## Akzeptanzkriterien / Verifikation

- [ ] Schlägt der Ollama-Aufruf fehl, endet der Pipeline-Lauf deterministisch mit `ACTION: HOLD` und eröffnet keine neue Position.
- [ ] Bei 6 %, 11 % und 21 % Drawdown (`broker.drawdownPct = 0.06 / 0.11 / 0.21`) werden die entsprechenden Drawdown-Alerts ausgelöst; bei neuem Equity-Hoch feuert der New-High-Alert genau einmal pro neuem Hoch.
