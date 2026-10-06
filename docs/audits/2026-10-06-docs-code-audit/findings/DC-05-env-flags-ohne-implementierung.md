# DC-05 — Dokumentierte Env-Flags ohne Implementierung / `.env.example` lückenhaft

- **ID:** DC-05
- **Severity:** MEDIUM (Betriebsirreführung)
- **Bereich:** Konfiguration / Betrieb
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Env-Mengenabgleich (`process.env`-Reads vs. Doku)
- **Status:** ☐ **OPEN**
- **Prompt:** [`../prompts/PROMPT-DC-05-env-flags-entscheiden.md`](../prompts/PROMPT-DC-05-env-flags-entscheiden.md)
- **Datei(en):** `docs/architecture/PIPELINE_MAP.md`, `architecture/DB_SCHEMA.md`, `LLM_ROUTING.md`, `EQUITY_CURVE.md`, `.env.example`, `CONFIGURATION.md`, `src/cycle/artifacts.ts`, `src/routing/policy.ts`, `src/lib/riskGuard.ts`

## Teil A — dokumentiert, aber im Code nie gelesen

| Flag | Dokumentiert in | Realität im Code |
|------|-----------------|------------------|
| `CYCLE_RETENTION_DAYS` | `architecture/PIPELINE_MAP.md:207`, `architecture/DB_SCHEMA.md:337` | `pruneArtifacts()` (`src/cycle/artifacts.ts:386`) hat **harte** Defaults (30 Tage / 12 Wochen aus dem Header-Kommentar) und wird produktiv **nie aufgerufen** — nur Definition + Tests (`tests/cycle.artifacts.test.ts`) |
| `CYCLE_RETENTION_WEEKS` | `PIPELINE_MAP.md:208`, `DB_SCHEMA.md:338` | s. o. |
| `ROUTING_POLICY_VERSION` | `LLM_ROUTING.md:483` | Keine Env-Lesestelle; die Version kommt aus `DEFAULT_POLICY_VERSION = "1.0.0"` (`src/routing/policy.ts:38`) |
| `RISK_MAX_EQUITY_DRAWDOWN_PCT` | `EQUITY_CURVE.md:135-137` („harte Risiko-Limits") | Keine Env-Lesestelle; wirksam: `DEFAULT_LIMITS.maxEquityDrawdownPct = 0.15` und der unveränderliche Deckel `[0.03, 0.5]` (`src/lib/riskGuard.ts:57,76,96`), Label in `riskConfigService.ts:55` |

Zusätzlich ist ein Name falsch: `MICRO_FEED_TYPE`
(`PIPELINE_MAP.md:402`, „`binance` | `simulator` | `sequence`") existiert nicht —
der Code liest **`MICRO_FEED`** (`scripts/micro-executor.ts:40`); die Werte des
Flags heißen `binance`/`sim` (`HANDBUCH.md:1645` verwendet korrekt
`MICRO_FEED=sim`), `simulator`/`sequence` sind die Namen der Feed-**Klassen**
(`src/lib/microExecutor.ts:1901,1994`) — drei Namensräume, nur einer ist real.

## Teil B — im Code gelesen, aber nirgends dokumentiert/ausgewiesen

In `.env.example` (251 Keys inkl. Kommentare) fehlen u. a.:
`SCANNER_ARTIFACTS_DIR`, `CYCLE_ARTIFACTS_DIR`, `SCANNER_CONFIG_FILE`,
`UNIVERSE_POLICY_FILE`, `UNIVERSE_AUDIT_DB`, `PORTFOLIO_AUDIT[_DIR|_DB]`,
`WATCHDOG_HEALTH_URL`, `WATCHDOG_TIMEOUT_MS`, `ALPACA_TIMEOUT_MS`,
`FORECAST_RESOLVER_INTERVAL_MIN`, `START_MICRO`, `MICRO_SEED_CANDLES`,
`MICRO_SIM_INTERVAL_MS`, `NODE_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`, `PORT`.
Ein Teil ist in Fachdokumenten beschrieben, ein Teil (`WATCHDOG_TIMEOUT_MS`,
`ALPACA_TIMEOUT_MS`, `START_MICRO`, `MICRO_SEED_CANDLES`,
`MICRO_SIM_INTERVAL_MS`) in **keiner** aktiven Doku.

## Ursache

Der CI-Check „Env-Flags==Code" (`scripts/docs-validate.ts:389-420`) prüft
**Doku → Code** mit einem breiten Token-Regex auf den *Quelltext* (nicht auf
`process.env`-Reads) und einer Suffix-Whitelist
(`_URL|_KEY|_TOKEN|_ENABLED|_DIR|_MS|_CTX|_PORT|_BASE|_PATH|_DATA|_AUDIT|_MODEL|_PROVIDER|_BUDGET|_FLAG`).
`_DAYS`, `_WEEKS`, `_VERSION`, `_PCT`, `_TYPE`, `_HEALTH_URL` (im Code als
String vorkommend) fallen durch. Die **Gegenrichtung** (Code → Doku) wird gar
nicht geprüft.

## Wirkung

Ein Betreiber setzt ein dokumentiertes Flag (`CYCLE_RETENTION_DAYS`) und
erreicht nichts — ohne Fehlermeldung. Umgekehrt bleiben wirksame Stellschrauben
(`WATCHDOG_TIMEOUT_MS`) unentdeckt. Beides untergräbt die Zusage
„Konfiguration ist dokumentiert" (`CONFIGURATION.md` als SSoT).

## Lösungsvorschlag (Prompt DC-05)

Pro Flag **entscheiden** (je eine Zeile im Prompt-Output dokumentieren):

1. **Implementieren**, wenn es fachlich gewollt ist:
   - `CYCLE_RETENTION_DAYS`/`_WEEKS`: `pruneArtifacts()` an die Dokumentation
     anschließen (Env mit den bisherigen Defaults 30/12, Clamping über
     `envInt`) **und** im Cycle aufrufen (z. B. am Ende des Daily-/Weekly-Laufs) —
     inkl. Test, dass ein Lauf Dateien älter als die Frist entfernt.
   - `ROUTING_POLICY_VERSION`: als Override einführen oder dokumentierte
     Konstante bleiben lassen.
   - `RISK_MAX_EQUITY_DRAWDOWN_PCT`: `EQUITY_CURVE.md` korrigieren (Code-Deckel
     nennen) **oder** Env-Override mit Clamping in `[0.03, 0.5]` ergänzen.
2. **Streichen**, wenn es Alt-Doku ist (dann aus beiden Dokumenten entfernen).
3. `MICRO_FEED_TYPE` → `MICRO_FEED` korrigieren, Werteliste auf reale Werte
   (`binance`/`sim`) + Klassen-Namen verweisen.
4. `.env.example` und `CONFIGURATION.md` auf den echten Read-Bestand bringen
   (Teil B) — die vollständige Liste erzeugt DC-09 (`env-inventory.md`).

## Verifikation nach Umsetzung

```bash
# A) Jedes dokumentierte Flag muss einen echten Read haben:
for f in CYCLE_RETENTION_DAYS CYCLE_RETENTION_WEEKS ROUTING_POLICY_VERSION RISK_MAX_EQUITY_DRAWDOWN_PCT
do echo -n "$f: "; grep -rn "$f" src scripts --include='*.ts' | wc -l; done
# Erwartung: >0 (implementiert) oder Flag aus der Doku entfernt.

# B) Kein Flag in .env.example ohne Read und umgekehrt (Check aus DC-08):
node --import tsx scripts/docs-validate.ts   # nach DC-08: zusätzlicher Check
```
