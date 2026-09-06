# LLM-Provider-Integration

Die Agenten der Trading-Firma sprechen **nicht** direkt mit einem Modellserver,
sondern mit einer abstrakten Schnittstelle (`src/lib/llmProvider.ts`). Darunter
liegen vier austauschbare Provider-Adapter — Wechsel ist reine `.env`-Konfiguration.

> **WICHTIG (seit v1.17.0, Task 09):** Die *Modellwahl* treffen die Agenten **nicht**
> selbst. Sie läuft über den **MODEL_ROUTER** (`src/routing/**`), einer Systemrolle
> mit versionierter Policy, Budget-Deckeln und Audit-Pflicht. Details:
> **[LLM_ROUTING.md](LLM_ROUTING.md)**. Dieses Dokument beschreibt die
> Transportschicht darunter — Provider, Registry-Felder, Health, Budgets, Kosten.

```
Agent (engine.ts)                Standardisierter Call               Adapter
┌──────────────┐   LlmChatRequest   ┌───────────────────────┐
│  localReason │ ─────────────────► │  chatLlm(req)        │
└──────────────┘   {model,          │   ├─ ollama    (local)│
        │          messages,        │   ├─ openai    (kompat)│
        ▼          temperature,     │   ├─ gemini    (cloud)│
   LlmChatResult   maxTokens,       │   └─ anthropic (cloud)│
   {content,       json, schema,    └──────────┬────────────┘
    usage,         timeoutMs}                   │ Retry: withRetry()
    latencyMs,                                  │ Backoff + Jitter
    costUsd}                                    ▼
                                    LLM_FALLBACK_PROVIDERS → nächster Adapter
                                    sonst: deterministische Regel-Engine
```

## 1. Provider & Konfiguration

| Provider | Env-Auswahl | Basis-URL (Default) | Key | Modell |
| --- | --- | --- | --- | --- |
| **Ollama** | `LLM_PROVIDER=ollama` | `OLLAMA_BASE_URL` → `http://127.0.0.1:11434` | — | Agenten-Modell aus DB, Tag-Resolution |
| **OpenAI-kompatibel** | `LLM_PROVIDER=openai` | `LLM_BASE_URL` → `http://127.0.0.1:8080/v1` | `LLM_API_KEY` (optional) | `LLM_MODEL` oder erstes angebotenes Modell |
| **Google Gemini** | `LLM_PROVIDER=gemini` | `GEMINI_BASE_URL` → `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` | `LLM_MODEL` (z. B. `gemini-2.0-flash`) |
| **Anthropic Claude** | `LLM_PROVIDER=anthropic` | `ANTHROPIC_BASE_URL` → `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `LLM_MODEL` (z. B. `claude-3-5-haiku-latest`) |

**Fallback-Kette:**

```bash
LLM_PROVIDER=ollama                # primärer Provider
LLM_FALLBACK_PROVIDERS=gemini,anthropic   # optional (kommagetrennt)
```

Scheitert der primäre Provider nach allen Retries (oder ist er nicht erreichbar),
werden die Fallbacks in Reihenfolge probiert. Erst wenn **alle** scheitern, antwortet
die deterministische Regel-Engine — es wird nie blind gehandelt.

## 2. Standardisierte API-Calls

Jeder Provider wird auf dieselbe Request/Response-Form abgebildet:

```ts
type LlmChatRequest = {
  model: string;
  messages: { role: "system"|"user"|"assistant"; content: string }[];
  temperature?: number;      // Standard: 0.2
  maxTokens?: number;        // Standard: LLM_MAX_TOKENS (512)
  json?: boolean;            // strukturierte Ausgabe erzwingen, wo möglich
  schema?: object;           // JSON-Schema (Ollama format / OpenAI json_schema / Gemini responseSchema)
  timeoutMs?: number;        // Standard: LLM_TIMEOUT_MS
};

type LlmChatResult = {
  content: string;
  provider: string;
  model: string;
  usage: { promptTokens?; completionTokens?; totalTokens? };
  latencyMs: number;
  attempt: number;
  costUsd?: number;
};
```

Provider-Mapping:

| Anforderung | Ollama | OpenAI | Gemini | Anthropic |
| --- | --- | --- | --- | --- |
| System-Prompt | in `messages` | in `messages` | `systemInstruction` | `system` (eigenes Feld) |
| Token-Limit | `options.num_predict` | `max_tokens` | `generationConfig.maxOutputTokens` | `max_tokens` (Pflicht) |
| JSON erzwingen | `format` (Schema) | `response_format` (json_schema/object) | `responseMimeType` + `responseSchema` | Prompt-Anweisung (kein API-Switch) |
| Assistant-Rolle | `assistant` | `assistant` | `model` | `assistant` |

## 3. Fehlerbehandlung & Retries

```bash
LLM_MAX_ATTEMPTS=2     # Versuche pro Provider (1–5, Standard 2)
LLM_TIMEOUT_MS=180000  # Abbruch pro Aufruf
```

* **Retryable:** Netzwerkfehler (Refused, Timeout, DNS), HTTP **429**, HTTP **5xx**.
* **Kein Retry:** 4xx (Konfigurations-/Programmierfehler) und Parse-Fehler.
* **Backoff:** `baseMs · 2^(attempt−1)` + Jitter, Kappung bei 8 s.
* Fehlerdetails landen als `console.warn` im Journal; der letzte Fehler wird bei
  Totalausfall geworfen und von `localReason` in einen Regel-Engine-Fallback
  übersetzt (auditierbar über `agent_messages.meta.source = "fallback"`).

## 4. Cost-/Performance-Trade-offs

| Hebel | Env | Wirkung |
| --- | --- | --- |
| Antwortlänge | `LLM_MAX_TOKENS` (512) | klein = schneller & billiger; zu klein = abgeschnittene Entscheidungen |
| Ansatz | `LLM_MAX_ATTEMPTS` | 1 = schnellste Fehlerreaktion, 5 = robusteste Cloud-Fallbacks |
| Provider-Reihenfolge | `LLM_FALLBACK_PROVIDERS` | lokal zuerst (0 €), Cloud nur als Notnetz |
| Referenztarife | `LLM_COST_*_PER_MTOK` | Override der Schätzpreise |
| Kontext | `OLLAMA_NUM_CTX` | mehr Kontext = mehr RAM/Latenz; 4096 (A) bzw. 8192 (B) |

**Kostenrechnung** (`estimateCostUsd`): `(promptTokens/1M)·inputPreis + (completionTokens/1M)·outputPreis`.
Defaults: Ollama = 0 €; OpenAI ≈ $0.15/$0.60 (gpt-4o-mini-Klasse); Gemini ≈ $0.125/$0.50
(Flash-Klasse); Anthropic ≈ $0.80/$4.00 (Haiku-Klasse). **Das ist eine Schätzung** —
laufende Tarife prüfen; die Werte sind keine Abrechnung.

Token-Verbrauch und Kosten je Agenten-Aufruf werden in `agent_messages.meta`
(`usage`, `costUsd`) und Audit-Log (`AGENT_DECISION`) protokolliert.

## 4b. Provider-Registry, Health und Budget (Task 09)

Seit v1.17.0 führt `src/routing/registry.ts` eine **Provider-Registry** mit
Laufzeitzustand. Der Router trifft seine Entscheidungen ausschliesslich auf diesen
Karten — Provider-Details (URLs, Keys, Modell-Tags) bleiben in
`src/lib/llmProvider.ts`.

```ts
type ProviderDescriptor = {
  id: "ollama" | "openai" | "gemini" | "anthropic";
  label: string;
  deployment: "local" | "cloud";
  models: string[];              // Ollama: live vom Server (/api/tags)
  defaultModel: string;
  capabilities: ("chat"|"json"|"schema"|"long-context"|"tools"|"vision"|"embedding")[];
  contextSize: number;           // Ollama: /api/show → model_info.context_length
  costPer1kIn: number;           // USD je 1k Input-Tokens (lokal: 0)
  costPer1kOut: number;          // USD je 1k Output-Tokens (lokal: 0)
  healthStatus: "online" | "degraded" | "offline";
  latencyEma: number;            // geglättete Antwortzeit (EMA, ms)
  tokenBudgetToday: number;      // Tages-Deckel in Tokens
  tokensUsedToday: number;       // Verbrauch heute
  quotaRest: number;             // Restkontingent des Anbieters in % (0–100)
  lastCheckedAt?: string; error?: string;   // Fehlertext ist redigiert, nie Keys
};
```

| Aspekt | Umsetzung |
| --- | --- |
| **Health-Poller** | Intervall `policy.healthPollerIntervalMs` (Default 60 s, `ROUTING_HEALTH_POLL_MS`, `0` = aus); Timer ist `unref()`ed; Fehler brechen nie den Routing-Pfad |
| **Prüfumfang** | `ROUTING_HEALTH_PROBE=local` (Default): nur lokale Provider remote; Cloud gilt mit Key als nutzbar. `=all` prüft auch Cloud (read-only Modellliste), `=off` prüft nichts |
| **Timeout** | `ROUTING_HEALTH_TIMEOUT_MS` (Default 1500 ms) je Prüfung |
| **Ollama-Sonderfall** | Modellliste **und** Kontextgrösse werden gelesen (`/api/tags`, `/api/show`) |
| **Budget** | `tokenBudgetToday` (Deckel) vs. `tokensUsedToday`; `quotaRest` leitet sich ab. Erschöpfter Deckel ⇒ Zwangsrückstufung auf lokale Provider + Audit (`budget_blocked`) |
| **Kosten** | `costPer1kIn/Out` aus `LLM_COST_*_PER_MTOK` (siehe Kapitel 4) |
| **Tests** | `createFakeProviderRegistry()` — Health/Quota/Latenz/Timeout injizierbar, kein Netzwerk |

Karten-Daten für das Operations Center: **`GET /api/providers`** (Status, Modell,
Modelle, Kontext, Latenz, Kosten, Tokens %, Restkontingent, Klassen). Seit SEC-02
(v1.36.31) verlangt dieser Endpoint `firm.read` (Viewer, Operator oder Admin;
Header-Credential oder gültige Browser-Session) und liefert `private, no-store`.

## 5. Einen neuen Provider hinzufügen

1. `LlmProviderName` um den Namen erweitern (`src/lib/llmProvider.ts`) **und**
   `ProviderId` in `src/routing/types.ts` (Router kennt sonst den Provider nicht).
2. Adapter in `createLlmClient` implementieren — Pflicht: `chat()`, optional `listModels()`.
3. Request-Builder + Response-Parser als **reine Funktionen** mit Unit-Tests.
4. URL/Key in `providerConfigFromEnv` + `DEFAULT_BASE_URLS`/`API_KEY_ENV` registrieren.
5. Startkarte in `buildProviderDescriptor()` (`src/routing/registry.ts`) ergänzen:
   Kontextgrösse, Kosten, Capabilities, Default-Modell.
6. Policy ergänzen: `classes.*.providers`, `budgets.providers.<id>` (**Cloud braucht
   zwingend einen Deckel > 0**) und `fallbackChains`.
7. `.env.example` + diese Datei ergänzen; `tests/llmProvider.test.ts` und
   `tests/routing.registry.test.ts` erweitern.

## 6. Sicherheit

* **Keys nie im Repo**: nur `.env` (`chmod 600`), `.env.example` bleibt ohne Werte.
* **Cloud = Datenabfluss**: System-Prompts, Marktdaten und Agentenentscheidungen
  verlassen die Maschine. Nur für Paper-Trading und mit bewusster Entscheidung.
* **Symbol-Whitelist** gilt providerunabhängig: Modell-Output kann keine URLs/Queries
  des LLM-Adapters beeinflussen.
* **Base-URL-Sanitizer** (v1.4.0): nur `http`/`https`, keine Userinfo in der URL.
  `file:`, `gopher:` und `http://user:pass@host` fallen auf den Default zurück.
* **Gemini-Key im Header** (`x-goog-api-key`), niemals als `?key=` — sonst landet
  der Schlüssel in Access-Logs, Proxies und Fehlermeldungen.
* **LLM_MODEL** gilt für OpenAI-kompatibel, Gemini und Anthropic (nicht Ollama:
  dort entscheidet der Agenten-Tag / die installierte Modellfamilie).
* Retry-Zähler pro Aufruf begrenzt Kosten-Shock bei Ausfällen.
* Logs/Health redaktieren Connection-Strings und Keys (`redactSecrets`).
* **Budget-Deckel (v1.17.0):** Token-/Kostenbudgets je Provider, Agent und Tag
  werden im Router durchgesetzt (`src/routing/budget.ts`). Cloud ist **immer**
  gedeckelt — die Policy-Validierung lehnt Cloud-Provider ohne Deckel ab.
* **Kein Agenten-Selbstwechsel (v1.17.0):** `MODEL_*`-Environment-Werte legen nur
  noch Registry-Defaults fest; die Modellwahl je Aufgabe trifft ausschliesslich
  der Router. Änderungen an Routing-Modi laufen über `PUT /api/routing/modes`
  (Admin-Token + CSRF + Audit).
* **Provider/Modell-Overrides (v1.22.0):** Administratoren können pro Agent
  einen expliziten Provider + Modell festlegen (`overrides` in
  `PUT /api/routing/modes`), der vor der Policy-Auswertung greift. Overrides
  werden best-effort unter `data/routing/overrides.json` (chmod 600)
  persistiert, beim Fehlschlag (offline/Quota/Kontext) greift der konfigurierte
  `fallbackMode`. Details: [LLM_ROUTING.md § 5](LLM_ROUTING.md#5-routing-modi-je-agent).
