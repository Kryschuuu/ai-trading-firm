# Changelog — Autonome KI-Trading-Firma

Alle für Nutzer sichtbaren Änderungen werden hier dokumentiert. Das Format folgt
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionierung folgt
[SemVer](https://semver.org/lang/de/).

## Versionierungsrichtlinie

| Versionsstelle | Bedeutung | Beispiel |
| --- | --- | --- |
| **MAJOR** (1.x.y) | Breaking Changes: DB-Schema-Brüche, entfernte Env-Variablen, neue Pflichtkonfiguration | 2.0.0 |
| **MINOR** (x.1.y) | Neue Features (z. B. Provider), abwärtskompatibel | 1.2.0 |
| **PATCH** (x.y.1) | Bugfixes und Sicherheits-Fixes, abwärtskompatibel | 1.1.1 |

* Die Version steht in `package.json` (`"version"`) und wird von `/api/health`
  (`"version"`) und `/api/firm` (`"version"`) ausgeliefert.
* Empfohlene Deploy-Kette: `git pull` → `npm ci` → `npx drizzle-kit push` →
  `npm run build` → `sudo systemctl restart ai-trading-firm`.
* Migrationshinweise stehen in der jeweils betroffenen Release-Sektion.

---

## [1.3.0] — 2026-08-24 (aktuell)

### Added
- **LLM-Provider-Abstraktion** (`src/lib/llmProvider.ts`) mit vier konfigurierbaren
  Providern hinter EINEM Interface:
  - `ollama` — nativer Ollama-Server (Standard)
  - `openai` — jeder OpenAI-kompatible Endpunkt (llama.cpp, LM Studio, vLLM, LocalAI, Cloud)
  - `gemini` — Google Gemini (`GEMINI_API_KEY`, `GEMINI_BASE_URL`)
  - `anthropic` — Anthropic Claude (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
- **Provider-Fallback-Kette** `LLM_FALLBACK_PROVIDERS` (kommagetrennt): scheitert der
  primäre Provider, werden die nächsten der Kette probiert, bevor die Regel-Engine greift.
- **Standardisierte API-Calls**: `LlmChatRequest {model, messages, temperature, maxTokens, json, schema, timeoutMs}` → `LlmChatResult {content, usage, latencyMs, costUsd}`.
- **Fehlerbehandlung & Retries**: `withRetry()` mit exponentiellem Backoff + Jitter;
  Retry nur bei Netzwerkfehlern, HTTP 429 und 5xx; `LLM_MAX_ATTEMPTS` (Standard 2).
- **Kosten-/Performance-Trade-offs**:
  - `LLM_MAX_TOKENS` (Standard 512) begrenzt jede Antwort (`num_predict`/`max_tokens`/`maxOutputTokens`).
  - `estimateCostUsd()` schätzt Kosten je Aufruf (Referenztarife + `LLM_COST_*`-Overrides, lokal = 0).
  - Token-Verbrauch (`usage`) wird in `agent_messages.meta` protokolliert.
- **Versions-Reporting**: `/api/health` und `/api/firm` liefern jetzt `version` aus `package.json`.
- **Dokumente umstrukturiert**: alle Markdown-Dateien liegen unter `docs/`
  (`docs/README.md`, `docs/INSTALL.md`, `docs/HANDBUCH.md`, `docs/CHANGELOG.md`,
  `docs/SECURITY_AUDIT.md`, `docs/PROVIDER_INTEGRATION.md`).
- Neue Tests: `tests/llmProvider.test.ts` (Builder, Parser, Retry, Backoff, Kosten,
  Fallback-Kette), `tests/broker.test.ts` (Hydration, Guardrails, Validierung),
  `tests/security.test.ts` (Symbol-Whitelist, Injection-Versuche, parseDecision-Robustheit).

### Changed
- `package.json`: Name `ai-trading-firm`, Version `1.3.0`, `engines.node >= 20`, License MIT.
- `.env.example`: neue Sektionen „Cloud-Provider", „Retries", „Kosten", „Scheduler".
- `src/lib/ollama.ts` ist jetzt die Kompatibilitäts- und Orchestrierungsschicht über
  `llmProvider.ts`; öffentliche Funktionen (`getOllamaStatus`, `localReason`,
  `fallbackReason`, `DECISION_SCHEMA`) bleiben stabil.
- `scripts/setup-cachyos.sh` erwartet jetzt **9** Tabellen (inkl. `equity_snapshots`).

### Fixed
- Siehe [1.1.0] (alle Bugfixes sind in 1.3.0 enthalten).

---

## [1.1.0] — 2026-08-24 (Security- & Stabilitäts-Release)

### Fixed (hoch)
- **P&L-Verlust nach Neustart** (`engine.getBroker` + `PaperBroker.hydrate`):
  Der Cash-Stand wurde aus `STARTING_EQUITY − Einstiegs-Notional` rekonstruiert.
  Realisierte Gewinne/Verluste geschlossener Trades gingen bei jedem Prozess-Neustart
  verloren (Depot zeigte wieder 10.000 € statt z. B. 10.200 €).
  **Fix:** letzter persistenter Cash-Wert aus `equity_snapshots` wird als `cashHint`
  übernommen; Fallback nur bei leerer/frischer DB.

### Fixed (mittel)
- **Tagesverlust-Fenster in `engine.ts`** nutzte Server-Localtime statt
  `Europe/Berlin` — inkonsistent zu `monitor.tick()` und `equity.realizedPnlToday()`
  (systemd läuft oft mit UTC). **Fix:** `startOfBerlinDay()`.
- **GET `/api/firm/tick` mutierte Zustand** (Kurse, SL/TP → Positionen schließen).
  Browser-Prefetches/Monitore lösten dort Handel aus. **Fix:** GET → HTTP 405.
- **Race Conditions**: `monitor.tick()` und `runPipeline()` hatten keinen
  Single-Flight-Schutz — überlappende Zyklen erzeugten doppelte Snapshots,
  Vorschläge und Audit-Einträge. **Fix:** Promise-Lock (Tick) bzw. Guard
  (`PIPELINE_ALREADY_RUNNING` → HTTP 409).
- **Symbol-Validierung**: Modell-/DB-Symbole flossen ungeprüft in externe URLs
  (Binance-Query), Prompts und JSONB. **Fix:** `sanitizeSymbol()`-Whitelist
  (`^[A-Z0-9]{1,12}([.=][A-Z0-9]{1,5})?$`) in `marketData`, `broker.submit` und
  `engine.runAgentTurn`; Binance-URLs zusätzlich `encodeURIComponent`.
- **Security-Header fehlten** (`next.config.ts`): jetzt CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy` in Produktion (Dev bleibt offen für HMR).
- **`checkSchema()` kannte `equity_snapshots` nicht** → Healthcheck meldete
  „schemaReady" obwohl die Equity-Kurve/Snapshots fehlten; Setup-Skript prüfte 8 statt 9 Tabellen.

### Fixed (niedrig)
- `/api/firm/log?limit=NaN|-5` → SQL-Fehler 500. **Fix:** Limit auf 1–200 geklemmt.
- `stopLossPct: "abc"`/`NaN` → Order wurde mit NaN kalkuliert und pauschal geblockt.
  **Fix:** nicht-zahlfähige Werte gelten als „keine Angabe" → ATR-/Default-Fallback.
- `riskScore` aus Modell-Output ohne Zahlenvalidierung konnte Insert in `numeric`
  sprengen. **Fix:** Normalisierung auf [0,1].
- `scripts/drizzle.config.json` (veraltet, hardcodierte DB-Zugangsdaten) entfernt —
  das Projekt nutzt `drizzle.config.ts` mit `DATABASE_URL` aus `.env`.
- `scripts/smoke-test.sh` prüfte das Feld `status`/`SCHEMA_MISSING`, das die API nie
  liefert (toter Setup-Zweig). **Fix:** `schemaReady === false`.
- Scheduler-Analysten-Slot nutzte Server-Stunde statt Berliner Zeit → Doppelstart-
  Schutz griff auf UTC-Servern unzuverlässig. **Fix:** `Europe/Berlin`-Schlüssel.
- Lint: 10 Fehler in `FirmDashboard.tsx`/`docs/page.tsx` (unescaped entities,
  setState im Effekt) behoben — `npm run lint` ist jetzt fehlerfrei.
- `tsconfig.tsbuildinfo` aus dem Repo entfernt und per `.gitignore` ausgeschlossen.

### Security (geprüft, keine Änderung nötig)
- `npm audit`: **0 Schwachstellen** (Stand des Release).
- API-Token-Vergleich: `crypto.timingSafeEqual` ✓
- Keine `eval`/`child_process`/`exec`, keine `dangerouslySetInnerHTML` ✓
- `parseDecision`-Prototype-Pollution-Test (neu) ✓
- SQL: ausschließlich parametrisierte Queries via Drizzle ✓

### Tests
- 63 Unit-Tests, alle grün (`npm test`).
- Neu: Broker-Hydration (Neustart-Fix), Symbol-Injection, parseDecision-Robustheit,
  Provider-Builder/Parser, Retry/Backoff, Kosten, Fallback-Kette, KILL-Marker.

### Anmerkung Migration
Kein Schema-Bruch: `equity_snapshots` existierte bereits; geändert wurde nur die
Prüfung. Bei Alt-Installationen einfach `npx drizzle-kit push` erneut ausführen.

---

## [1.0.0] — 2026-08 (Ausgangsstand beim Audit)

Baseline: Archiv-Repository mit Engine, Paper-Broker, Ollama/OpenAI-Client,
Guardrails, Monitor, Analysten, Dashboard und erster Test-Suite (26 Tests).

---

## Offen / bewusst nicht gemacht (Backlog)

| Thema | Grund |
| --- | --- |
| Rate-Limiting der API (Localhost-only) | Auslieferungszustand lauscht nur auf 127.0.0.1; bei LAN-Exposition `FIRM_API_TOKEN` setzen |
| Auto-Upgrade der Abhängigkeiten | Versions-Pins sind bewusst stabil; `npm audit` als Teil des Deploy-Checks |
| Live-Broker-Adapter (Alpaca/ccxt) | bewusst außerhalb des Paper-only-Scopes (Handbuch Kapitel 8) |
| Persistente Scheduler-Locks über Prozesse hinweg | aktuell prozess-lokal (Single-Node-Betrieb); Multi-Node bräuchte DB-Locks |
