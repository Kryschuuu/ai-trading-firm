# DC-05 — Dokumentierte Env-Flags ohne Implementierung / `.env.example` lückenhaft

- **ID:** DC-05
- **Severity:** MEDIUM (Betriebsirreführung)
- **Bereich:** Konfiguration / Betrieb
- **Quelle:** Docs↔Code-Audit `v0.17.2`, Env-Mengenabgleich (`process.env`-Reads vs. Doku)
- **Status:** ☑ **FIXED** (2026-10-09, diese Session)
- **Prompt:** [`../prompts/PROMPT-DC-05-env-flags-entscheiden.md`](../prompts/PROMPT-DC-05-env-flags-entscheiden.md)
- **Datei(en):** `src/cycle/artifacts.ts`, `src/cycle/service.ts`, `tests/cycle.artifacts.test.ts`, `tests/cycle.engine.test.ts`, `docs/architecture/PIPELINE_MAP.md`, `architecture/DB_SCHEMA.md`, `LLM_ROUTING.md`, `EQUITY_CURVE.md`, `.env.example`, `CONFIGURATION.md`

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

## Umsetzung (2026-10-09)

Pro Flag genau eine Entscheidung — kein Flag wird doppelt interpretiert:

| Flag | Entscheidung | Fundstelle | Verifikationskommando |
|------|--------------|-----------|------------------------|
| `CYCLE_RETENTION_DAYS` | **IMPLEMENTIEREN** | `envInt("CYCLE_RETENTION_DAYS", 30, 1, 3650)` in `src/cycle/artifacts.ts` (`pruneArtifacts`, Default `DEFAULT_RETENTION_DAYS = 30`); produktiver Aufruf am Abschluss jedes Daily-Laufs via `pruneCycleArtifacts()` in `src/cycle/service.ts` | `grep -rn "CYCLE_RETENTION_DAYS" src scripts` → Read in `artifacts.ts`; `node --import tsx --test tests/cycle.artifacts.test.ts` (Env-Override, Defaults, Clamp) grün |
| `CYCLE_RETENTION_WEEKS` | **IMPLEMENTIEREN** | `envInt("CYCLE_RETENTION_WEEKS", 12, 1, 520)` in `src/cycle/artifacts.ts` (`pruneArtifacts`, Default `DEFAULT_RETENTION_WEEKS = 12`); Aufruf am Weekly-Abschluss in `src/cycle/service.ts` | `grep -rn "CYCLE_RETENTION_WEEKS" src scripts` → Read in `artifacts.ts`; Test s. o. |
| `ROUTING_POLICY_VERSION` | **STREICHEN** | Flag aus `docs/LLM_ROUTING.md` §13 entfernt; Quelle genannt: `DEFAULT_POLICY_VERSION = "1.0.0"` (`src/routing/policy.ts`) bzw. Pflichtfeld `version` der Policy-Datei unter `ROUTING_POLICY_PATH` | `grep -rn "ROUTING_POLICY_VERSION" docs/LLM_ROUTING.md CONFIGURATION.md` → 0 Treffer (nur Audit-Historie in `docs/audits/` + Audit-Bericht) |
| `RISK_MAX_EQUITY_DRAWDOWN_PCT` | **STREICHEN** | `docs/EQUITY_CURVE.md` §3 nennt den realen Mechanismus: `DEFAULT_LIMITS.maxEquityDrawdownPct` (Default 0.15) + `LIMIT_CEILINGS` [0.03, 0.5] (`src/lib/riskGuard.ts`), Laufzeit-Tuning via `risk_config`/Dashboard, Not-Halt via `killSwitch.pull` (`src/lib/engine.ts`) | `grep -rn "RISK_MAX_EQUITY_DRAWDOWN_PCT" docs/EQUITY_CURVE.md CONFIGURATION.md` → 0 Treffer (nur Audit-Historie) |
| `MICRO_FEED_TYPE` | **KORRIGIEREN** → `MICRO_FEED` | `docs/architecture/PIPELINE_MAP.md` Stufe 10: Werte `binance` \| `sim` (Read in `scripts/micro-executor.ts:40`), Verweis auf die Feed-Klassen `simulator`/`sequence` (`src/lib/microExecutor.ts`) | `grep -rn "MICRO_FEED_TYPE" docs/architecture/` → 0 Treffer (nur Audit-Historie) |

**Begründungen:**

- `CYCLE_RETENTION_DAYS`/`_WEEKS` implementieren: fachlich gewollt (Doku verspricht
  Retention), Defaults 30/12 bleiben, damit die bestehenden Tests weiter gelten.
  `pruneArtifacts()` läuft am Abschluss jedes Daily- **und** Weekly-Laufs
  (best-effort — ein Prune-Fehler darf den Zyklus nicht abbrechen): der Daily-Lauf
  deckt den täglichen Wachstumspfad ab, der Weekly-Lauf stellt sicher, dass auch
  reine Weekly-Betriebe die Retention durchsetzen. Stelle: `src/cycle/service.ts`
  (`pruneCycleArtifacts()`), nach dem Schreiben der Artefakte.
- `ROUTING_POLICY_VERSION` streichen: Die Version beschreibt den Inhalt der Policy
  (SemVer, schema-validiert) und ist über `ROUTING_POLICY_PATH` (eigenes
  `version`-Feld) bereits änderbar. Ein Env-Override wäre eine zweite Quelle für
  dieselbe Angabe und würde die Audit-Version vom Policy-Inhalt entkoppeln.
- `RISK_MAX_EQUITY_DRAWDOWN_PCT` streichen: `riskGuard` hält alle 12 Limits
  code-seitig mit Laufzeit-Tuning aus `risk_config`/Dashboard innerhalb der
  `LIMIT_CEILINGS` (Sandbox-Design, siehe Header-Kommentar). Ein Env-Override für
  ein einzelnes Limit wäre ein redundanter zweiter Pfad und würde die einheitliche
  Behandlung aller Limits aufbrechen.
- `MICRO_FEED_TYPE` korrigieren: Der Code liest `MICRO_FEED` mit den Werten
  `binance`/`sim`; `simulator`/`sequence` sind die Namen der Feed-Klassen
  (`SimulatedFeed`/`SequenceFeed`) — drei Namensräume, nur einer ist das Flag.

**Teil B (`.env.example` + `CONFIGURATION.md`):** die 13 real gelesenen Variablen
ergänzt (`SCANNER_ARTIFACTS_DIR`, `CYCLE_ARTIFACTS_DIR`, `SCANNER_CONFIG_FILE`,
`UNIVERSE_POLICY_FILE`, `UNIVERSE_AUDIT_DB`, `PORTFOLIO_AUDIT_DIR`,
`PORTFOLIO_AUDIT_DB`, `WATCHDOG_HEALTH_URL`, `WATCHDOG_TIMEOUT_MS`,
`ALPACA_TIMEOUT_MS`, `FORECAST_RESOLVER_INTERVAL_MIN`, `START_MICRO`,
`MICRO_SEED_CANDLES`, `MICRO_SIM_INTERVAL_MS`) — in `.env.example` mit Kommentar
(Default + Bounds), in `CONFIGURATION.md` als Tabellenzeilen; die fünf bisher
komplett undokumentierten (`WATCHDOG_TIMEOUT_MS`, `ALPACA_TIMEOUT_MS`,
`START_MICRO`, `MICRO_SEED_CANDLES`, `MICRO_SIM_INTERVAL_MS`) mit je einem Satz.
Neu implementierte Flags (`CYCLE_RETENTION_DAYS`/`_WEEKS`) ebenfalls in beiden
aufgenommen. `FORECAST_RESOLVER_INTERVAL_MIN` war in `CONFIGURATION.md` bereits
vorhanden (nur `.env.example` fehlte).

**Verifikation (2026-10-09):**

- `grep -rn "CYCLE_RETENTION_DAYS\|CYCLE_RETENTION_WEEKS" src scripts` → Read in
  `src/cycle/artifacts.ts`.
- `grep -rn "ROUTING_POLICY_VERSION\|RISK_MAX_EQUITY_DRAWDOWN_PCT" docs/LLM_ROUTING.md docs/EQUITY_CURVE.md CONFIGURATION.md` → 0 Treffer.
- `npm run typecheck`, `npm run lint`, `npm run docs:validate` grün.
- `node --import tsx --test tests/cycle.*.test.ts` → 85/85 grün (3 neue Tests in
  `tests/cycle.artifacts.test.ts`; `tests/cycle.engine.test.ts` isoliert die
  Artefakt-Ablage gegen echte Artefakte).
