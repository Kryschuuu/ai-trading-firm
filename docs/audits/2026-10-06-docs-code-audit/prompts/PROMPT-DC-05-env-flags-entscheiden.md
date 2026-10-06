# PROMPT DC-05 — Env-Flags: implementieren oder streichen

```text
TASK: Bring die dokumentierten Env-Flags und den echten Lese-Bestand des Codes
in Übereinstimmung.

BEFUND (Audit docs/audits/2026-10-06-docs-code-audit/findings/DC-05-env-flags-ohne-implementierung.md):
Vier dokumentierte Flags werden im Code NIE gelesen:
  - CYCLE_RETENTION_DAYS / CYCLE_RETENTION_WEEKS
    (docs/architecture/PIPELINE_MAP.md:207-208, architecture/DB_SCHEMA.md:337-338)
    pruneArtifacts() in src/cycle/artifacts.ts hat harte Defaults (30 Tage/12
    Wochen) und wird produktiv NIRGENDS aufgerufen.
  - ROUTING_POLICY_VERSION (docs/LLM_ROUTING.md:483)
    real: DEFAULT_POLICY_VERSION = "1.0.0" in src/routing/policy.ts:38.
  - RISK_MAX_EQUITY_DRAWDOWN_PCT (docs/EQUITY_CURVE.md:135-137, "harte Grenze")
    real: DEFAULT_LIMITS.maxEquityDrawdownPct = 0.15, Deckel [0.03, 0.5]
    in src/lib/riskGuard.ts:57,76,96.
Außerdem falscher Name: MICRO_FEED_TYPE (PIPELINE_MAP.md:402) existiert nicht,
der Code liest MICRO_FEED (scripts/micro-executor.ts:40), Werte binance|sim.
Und: .env.example (251 Keys) fehlen gelesene Variablen (SCANNER_ARTIFACTS_DIR,
CYCLE_ARTIFACTS_DIR, SCANNER_CONFIG_FILE, UNIVERSE_POLICY_FILE, UNIVERSE_AUDIT_DB,
PORTFOLIO_AUDIT[_DIR|_DB], WATCHDOG_HEALTH_URL, WATCHDOG_TIMEOUT_MS,
ALPACA_TIMEOUT_MS, FORECAST_RESOLVER_INTERVAL_MIN, START_MICRO, MICRO_SEED_CANDLES,
MICRO_SIM_INTERVAL_MS); WATCHDOG_TIMEOUT_MS, ALPACA_TIMEOUT_MS, START_MICRO,
MICRO_SEED_CANDLES und MICRO_SIM_INTERVAL_MS stehen in KEINER Doku.

DO (pro Flag GENAU EINE Entscheidung, Ergebnis als Tabelle im Prompt-Output):
1. CYCLE_RETENTION_DAYS / CYCLE_RETENTION_WEEKS -> IMPLEMENTIEREN (empfohlen):
   - envInt("CYCLE_RETENTION_DAYS", 30, 1, 3650) / ("CYCLE_RETENTION_WEEKS", 12, 1, 520)
     in src/cycle/artifacts.ts (Default-Werte beibehalten, damit die Tests weiter gelten).
   - pruneArtifacts() im Cycle-Lauf aufrufen (Daily- und/oder Weekly-Abschluss;
     Stelle begründen). Test ergänzen: alter Artefaktordner wird entfernt,
     junger bleibt.
   - Doku-Tabellen in DB_SCHEMA.md/PIPELINE_MAP.md auf die realen Defaults
     verweisen lassen (Werte bleiben 30/12).
2. ROUTING_POLICY_VERSION -> ENTSCHEIDEN: entweder echten Env-Override einführen
   (Fallback DEFAULT_POLICY_VERSION, Audit-Eintrag muss die wirksame Version
   nennen) ODER Flag aus LLM_ROUTING.md entfernen und dort die Konstante als
   Quelle nennen. Nicht beides halb.
3. RISK_MAX_EQUITY_DRAWDOWN_PCT -> ENTSCHEIDEN: entweder Env-Override mit
   Clamping in [0.03, 0.5] via envNumber (dokumentiert, dass der Code-Deckel
   hart bleibt) ODER EQUITY_CURVE.md auf den realen Mechanismus umstellen
   (DEFAULT_LIMITS + LIMIT_CEILINGS, kein Env-Flag).
4. MICRO_FEED_TYPE -> in PIPELINE_MAP.md auf MICRO_FEED korrigieren; Werte
   binance|sim nennen und auf die Feed-KLASSEN simulator/sequence
   (src/lib/microExecutor.ts) verweisen.
5. .env.example + CONFIGURATION.md: die in der Liste fehlenden, real gelesenen
   Variablen ergänzen (Kommentar mit Default [min,max]); für die fünf komplett
   undokumentierten je einen Satz in CONFIGURATION.md aufnehmen.

AKZEPTANZ:
- `grep -rn "<FLAG>" src scripts` findet für jedes als "implementiert"
  entschiedene Flag einen echten Read; für "gestrichen" entschiedene Flags
  existiert das Flag weder in docs/ noch in CONFIGURATION.md.
- Kein Flag wird doppelt interpretiert (eine Semantik pro Flag).
- `npm run typecheck`, `npm run lint`, `npm run docs:validate` grün;
  neue/angepasste Tests grün.
- Prompt-Output enthält die Entscheidungstabelle Flag -> Entscheidung ->
  Fundstelle -> Verifikationskommando.
```

## Hinweise für die ausführende Session

- Reihenfolge nach DC-04 ausführen (Header zuerst), damit die Doku-Korrekturen
  gleich auf aktuellem Stand landen.
- Bei `pruneArtifacts()` daran denken, dass die Funktion neben Zeitfenstern auch
  Pfade kennt (`SCANNER_ARTIFACTS_DIR`/`CYCLE_ARTIFACTS_DIR`) — nicht die
  falsche Wurzel löschen. Im Zweifel Test, der beide Wurzeln prüft.
- Kein Flag einführen, das nur „für später" dokumentiert ist; Doku ist kein
  Backlog (gilt auch für DC-05 Teil B).
