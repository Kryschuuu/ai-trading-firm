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

## [1.5.0] — 2026-08-25 (aktuell)

**Workshop: Handbuch-Kapitel 5 und 6 ohne Terminal.** Neuer Dashboard-Reiter
🛠 Workshop mit vier Schritten (Mission anlegen → Agent ausführen → Prompt
iterieren → Trefferquote messen), dazu die passenden API-Routen. Kein
Schema-Bruch, keine neuen Pflicht-Env-Variablen. Nach `git pull`:
`npm ci && npm run build` und Dienst neu starten.

### Added
- **Reiter „🛠 Workshop“** (`src/components/workshop/`):
  - **1 · Mission anlegen/bearbeiten** (5.1–5.3): Formular mit Titel, Ziel,
    Symbol-Autocomplete (aus `GET /api/firm/missions` → Broker-Liste),
    Risikobudget % und max. Position %; Nachschlagkasten mit Faustregel
    („nicht per SQL prüfbar → zu vage“) und der Schlecht/Besser-Tabelle aus 5.2.
  - **2 · Agent ausführen** (6.2): Agent + Mission wählen, ein Turn; Ergebnis
    formatiert (`type`/`side`/`stopLossPct`/`riskScore`/`reason` mit
    Hover-Erklärungen), Guardrail-Kette aufklappbar, Rohdaten-Anzeige; rechts
    die letzten 3 Agenten-Nachrichten mit Quelle und Latenz.
  - **3 · Prompt iterieren** (6.3): `system_prompt`-Editor mit sofortiger
    Wirkung (DB, kein Neubau), JSON-Sollformat + vollständiges Beispiel,
    Feld-Hilfen zu `type`/`side`/`stopLossPct`/`riskScore`, „Beispiel an Prompt
    anhängen“-Knopf, grünes Speicher-Bestätigungsfeld. Bewusst **ohne**
    Guardrail-Regler (weiche vs. harte Schicht).
  - **4 · Trefferquote** (6.4): sequenzielle Testschleife (1–20 Läufe, Standard
    10) mit Live-Balken (TRADE / HOLD / HOLD·kaputtes JSON / ERROR / ANDERE),
    automatischen Debug-Tipps ab 2 JSON-Fällen bzw. 20 % Anteil, Fehlerliste
    mit Sprung ins Protokoll-Tab; Stop-Knopf; sauberes 429-Handling.
- **Hover-/Tastatur-Hilfe überall**: `InfoTip`-Komponente (i-Symbol) auf jedem
  Feld und Fachbegriff — Tooltip bei Hover UND Focus, `title`-Fallback,
  `aria-label` + sr-only-Text für Screen Reader.
- **API-Routen**: `GET/POST/PUT /api/firm/missions` und `PUT /api/firm/agents`
  (nur `system_prompt`). Budgets werden gegen `LIMIT_CEILINGS` validiert (90 %
  Risiko → 400 statt Broker-Block), Symbole gegen die Paper-Broker-Liste,
  Prompts auf Länge; Audit-Einträge `MISSION_CREATED`/`MISSION_UPDATED`/
  `AGENT_PROMPT_UPDATED`.
- **`src/lib/workshop.ts`**: reine Validierungs-/Klassifikationslogik
  (`validateMissionInput`, `validatePromptInput`, `classifyTurnOutcome`,
  `aggregateOutcomes`), von Routen und Tests geteilt.
- **Typsicherheit**: `src/lib/types.ts` (AgentRow, MissionRow, TurnResultDto,
  Response-Interfaces) — `FirmData.agents/missions` typisiert statt `any`.
- **`src/lib/apiClient.ts`**: geteilter `apiFetch` (Token-Header) +
  `readJson`-Fehlerwrapper für aussagekräftige API-Fehlermeldungen.
- `GET /api/firm/log` liefert jetzt auch `content` (Kurzform der Nachricht) —
  Grundlage für die „letzten 3 Nachrichten“-Anzeige.
- Neue Tests: `tests/workshop.test.ts` (Validierungs-Edge-Cases: leere
  Eingaben, 90-%-Budget, unbekannte Symbole, Prompt-Grenzen, Warnungen;
  Klassifikation TRADE/HOLD/INVALID_JSON/ERROR; Aggregation inkl. Tipps-
    Schwelle und Division durch 0).

### Changed
- `package.json` Version **1.5.0**.
- Handbuch 2.3/4.1/5.1–5.3/6.1–6.4: UI-Weg jeweils vorangestellt, Terminal als
  Alternative belassen; API-Tabelle um die Workshop-Routen ergänzt.

### Security
- Missions-/Prompt-Endpunkte hängen am bestehenden `guardWrite` (Token +
  Rate-Limit); DB-Fehler werden als 503 mit redaktierter Meldung
  (`publicErrorMessage`) zurückgegeben statt als undurchsichtiger 500-Crash.
- Missions-Budgets werden **serverseitig** gegen die Code-Deckel geprüft —
  die UI ist nur Anzeige, nicht Kontrollinstanz.

---

## [1.4.0] — 2026-08-25

Security-Härtung, Provider-Korrektheit und Scheduler-Fix. Kein Schema-Bruch,
keine neuen Pflicht-Env-Variablen. Nach `git pull`: `npm ci && npm run build`
und Dienst neu starten.

### Added
- **Schreib-Rate-Limit** für POST/PUT (`guardWrite`): Standard 60 Anfragen / 60 s,
  abschaltbar via `FIRM_RATE_LIMIT=0`. Antwort 429 + `Retry-After`.
- **Secret-Redaktion** (`src/lib/secrets.ts`): Connection-Strings, Bearer-Tokens
  und API-Keys werden aus Health-Fehlern, LLM-Logs und öffentlichen Error-Strings
  entfernt.
- **`extractJsonObject()`**: sicherer JSON-Extractor für Analysten-Payloads
  (view/thesis/recommendation), ohne Prototype-Pollution.
- **`envInt()`**: NaN-feste Env-Zahlen mit Clamp — `TICK_INTERVAL_MS=abc` startet
  den Scheduler nicht mehr mit `setInterval(NaN)`.
- Neue Tests: `tests/hardening.test.ts` (Secrets, Token, Rate-Limit, Intervalle,
  parseDecision-Allowlist, Broker-Reject) plus Erweiterungen in `llmProvider.test.ts`.

### Changed
- `package.json` Version **1.4.0**.
- Gemini-Auth: Key ausschließlich im Header `x-goog-api-key` (nicht mehr als
  Query-Parameter — Keys gehören nicht in Access-Logs/Referrer).
- `LLM_MODEL` gilt jetzt für Gemini **und** Anthropic, nicht nur OpenAI-kompatibel.
- Ollama `keep_alive` ist Top-Level (API-konform); Usage (`prompt_eval_count` /
  `eval_count`) wird geparst.
- Token-Limit der Builder folgt `req.maxTokens` (nicht dem bei Client-Erzeugung
  eingefrorenen Wert).
- `parseDecision` kopiert nur Allowlist-Felder (`type/symbol/side/stopLossPct/reason/riskScore`).
- Audit-Log-Filter (`level`/`event`) und Equity-`range` sind gewhitelistet.
- Agenten-Meta speichert `provider`, `usage`, `costUsd`.

### Fixed
- **Gemini-API-Key in der URL** (High): Query `?key=` entfernte den Key in Logs.
- **Gemini-Modellliste** `models/gemini-…` wurde 1:1 in den Pfad gesetzt →
  `/models/models/…`. Prefix wird jetzt gestrippt.
- **Anthropic `listModels`** las `models[].name` statt `data[].id` → leere Liste.
- **Retry-`attempt`** war immer 1, weil `client.chat` den Zähler verwarf.
- **Analysten-Intervall**: `ANALYST_INTERVAL_MIN` wurde nur geloggt; der Slot-Key
  `HH:MM` ließ die Analysten **jede Minute** laufen. Jetzt echter Abstand
  (Default 30 min, Minimum 10).
- **Broker-Cash nach Slippage**: Prüfung gegen Pre-Slippage-Notional konnte das
  Konto um 0,1 % negativ machen. Jetzt Fill-Kosten.
- **`reject()` crashte** bei nicht-string `symbol` (`toUpperCase` auf Number).
- **`hydrate()`** übernahm unsanitized DB-Symbole in die Position-Map.
- **Kerzen-Intervalle und Yahoo-Screener-IDs** ohne Whitelist (URL-Injection).
- **Health-500** konnte `DATABASE_URL` in `error` durchreichen.
- **Provider-Base-URL**: `file:` / Userinfo (`user:pass@host`) werden abgelehnt.

### Security
- Timing-sicherer Token-Vergleich mit Längen-Padding (kein Length-Oracle).
- `npm audit`: Ziel 0 Vulnerabilities (siehe SECURITY_AUDIT.md).

### Tests
- Bisherige 67 Tests bleiben; neu ~25 Härte-/Provider-Tests. `npm test` muss
  vollständig grün sein.

### Anmerkung Migration
Kein DB-Schema-Change. `.env` optional um `FIRM_RATE_LIMIT` ergänzen.
Wer Gemini nutzt: Header-Auth ist transparent, keine Key-Änderung nötig.

---

## [1.3.0] — 2026-08-24

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
| Multi-Node Rate-Limit / Scheduler-Locks | v1.4.0 limiter ist prozess-lokal; Cluster bräuchte Redis/DB |
| Auto-Upgrade der Abhängigkeiten | Versions-Pins sind bewusst stabil; `npm audit` als Teil des Deploy-Checks |
| Live-Broker-Adapter (Alpaca/ccxt) | bewusst außerhalb des Paper-only-Scopes (Handbuch Kapitel 8) |
| Persistente Scheduler-Locks über Prozesse hinweg | aktuell prozess-lokal (Single-Node-Betrieb); Multi-Node bräuchte DB-Locks |
