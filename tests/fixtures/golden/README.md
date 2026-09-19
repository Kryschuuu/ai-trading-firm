# Golden-Dataset für Prompt-Evals (GAP-08)

Synthetische Fixtures für `npm run eval:prompts` — **nur in `tests/`**,
keine echten Marktdaten, keine Secrets. Jede Datei beschreibt EINE
historische (erfundene, aber realistische) Situation:

```json
{
  "id": "research-valid-long",
  "step": "research | macro",
  "description": "…",
  "candles": [{ "time": "…", "open": 1, "high": 2, "low": 0.9, "close": 1.1 }],
  "providerResponse": { "…": "rohe Provider-Antwort (JSON)" },
  "expect": { "schemaValid": true, "plausible": true, "codes": [] }
}
```

## Pflege-HowTo

1. **Nach jedem Prompt-Edit:** `npm run eval:prompts` — Exit ≠ 0 heißt
   Regression (Erwartung vs. tatsächliche Schema-/Plausibilitäts-Bewertung).
2. **Neue Fixture anlegen:** Datei unter `<step>/<id>.json` ablegen —
   `research/` für Setup-Outputs, `macro/` für Makro-Outputs. IDs müssen
   innerhalb des Datasets eindeutig sein.
3. **Erwartung (`expect`) bewusst setzen:** `schemaValid` + `plausible` +
   sortierte Befund-Codes (`PRICE_RANGE`, `MONOTONICITY`,
   `RATIONALE_MISSING`, `HALLUCINATED_PRICE`).
4. **Kerzen sind Single-Instrument-Referenz:** Sie gelten für alle
   Entscheidungen der Fixture (Eval-Vereinfachung — im Betrieb kommen die
   Kerzen je Instrument aus dem HistoricalStore).
5. **Determinismus wahren:** Keine Zeitstempel-Logik in Erwartungen, keine
   Netzabhängigkeit — zwei Offline-Läufe müssen byte-identische Reports
   liefern (der Harness-Test prüft das per Hash).
6. **Provider-Modus ist ein Rauchtest:** `npm run eval:prompts -- --provider`
   fragt den konfigurierten Provider (kostet Tokens!) und prüft nur
   Schema+Plausibilität — kein Golden-Vergleich, da LLM-Output variiert.
