# LLM-Modell-Routing — der MODEL_ROUTER (Task 09)

**Stand:** 2026-08-28 · **Modul:** `src/routing/**` · **API:** `/api/providers`,
`/api/routing`, `/api/routing/modes` · **Version:** `1.17.0`
**Status:** Governance-Baustein 9 von 12 — Modellwahl ist keine Agentenentscheidung mehr.

---

## 1. Zielbild

Die Plattform nutzt mehrere LLM-Provider (Ollama lokal, OpenAI-kompatibel,
Google Gemini, Anthropic Claude — siehe [PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md)).
Ohne Governance könnte **jeder Agent selbst** das große, teure Cloud-Modell wählen:
Kostenexplosion, unkontrollierter Datenabfluss, nicht reproduzierbare Entscheidungen.

> **Der MODEL_ROUTER ist eine Systemrolle — kein Trading-Agent.**
> Er bekommt ausschließlich strukturierte Metadaten und entscheidet deterministisch.
> Ein Agent darf eine Höherstufung **beantragen**, nie selbst vollziehen.

```text
                    ┌───────────────────────────────────────────────┐
   Agent (Runtime)  │  9 strukturierte Inputs (KEIN Freitext!)      │
   RESEARCH, TECHN… │  task · complexity · risk · latency · budget  │
                    │  providerHealth · capabilities · cost · ctx   │
                    └───────────────────────┬───────────────────────┘
                                            │  resolve(context)
                                            ▼
                        ┌───────────────────────────────────────┐
                        │  MODEL_ROUTER  (src/routing/router.ts)│
                        │  · Policy (versioniert, validiert)    │
                        │  · Provider-Registry (Health/Quota)   │
                        │  · Budget-Deckel (Provider/Agent/Tag) │
                        │  · Audit-Sink (Datei + audit_log)     │
                        └───────┬───────────────────────┬───────┘
                                │                       │
              RoutingDecision   │                       │  audit_log
     MODEL_A │ MODEL_B │ MODEL_C│                       │  (MODEL_ROUTING)
             │ CLOUD   │ FALLBACK                       ▼
                                ▼
                 routeChat() → chatLlm(Kette: Ziel + Fallbacks)
```

**Kern-Eigenschaften**

| Eigenschaft | Umsetzung |
| --- | --- |
| Kein Agenten-Selbstwechsel | Einziger Weg: `router.resolve()` / `router.requestEscalation()` |
| Determinismus | gleiche Inputs ⇒ gleiche Entscheidung; keine Zufallswerte, injizierte Uhr, feste Reihenfolgen |
| Harte Budget-Deckel | Token/Kosten je Provider, Agent und Tag; Überschreitung ⇒ Zwangsfallback auf lokal |
| Vollständiges Audit | JEDER Wechsel (inkl. Fallback und **denied**) landet in `audit_log` |
| Decoupling | Router kennt keine Marktdaten; Provider-Details nur in der Registry |
| Injection-Resistenz | Freitext wird beim Normalisieren verworfen — nur 9 Whitelist-Felder wirken |

---

## 2. Die 9 Routing-Inputs

`RoutingContext` (`src/routing/types.ts`) — alles andere wird von
`toRoutingContext()` **weggeworfen**:

| # | Input | Typ | Wirkung |
| --- | --- | --- | --- |
| 1 | `task` | Whitelist-ID | Klassen-Untergrenze je Aufgabe (z. B. `weekly_report` ⇒ groß) |
| 2 | `complexity` | `low \| medium \| high \| critical` | Komplexitäts-Floor (Policy `complexityFloor`) |
| 3 | `risk` | `low \| medium \| high` | Risiko-Floor (Kapitalwirkung, `riskFloor`) |
| 4 | `latencyRequirementMs` | Zahl (0 = egal) | Provider mit `latencyEma` über der Anforderung wird übersprungen |
| 5 | `tokenBudget` | Zahl | muss ins Kontextfenster passen; Grundlage der Kostenschätzung |
| 6 | `providerHealth` | `{ ollama: online… }` | überschreibt die Registry-Sicht (Tests, Runtime-Signale) |
| 7 | `requiredCapabilities` | `json`, `schema`, `long-context`, … | Provider ohne Fähigkeit wird übersprungen |
| 8 | `maxCostUsd` | Zahl | Kostendeckel je Aufruf (schließt Cloud aus, wenn zu teuer) |
| 9 | `contextSize` | Zahl (Tokens) | Kontextbedarf vs. `contextSize` des Providers |

Kontext-Metadaten (Autorität bleibt beim Router): `agent`, `confidence`,
`currentModel`, `currentClass`.

**Aufgaben-Whitelist (`taskOverrides`)**

| Klasse | Aufgaben |
| --- | --- |
| **MODEL_A** (lokal klein) | `json_classification`, `market_ranking`, `summarization`, `technical_analysis_standard`, `news_categorization`, `simple_risk_decision` |
| **MODEL_B** (lokal mittel) | `research` |
| **MODEL_C** (groß) | `technical_news_synthesis`, `market_selection`, `portfolio_analysis`, `complex_research`, `regime_analysis`, `conflicting_evidence`, `strategy_development`, `weekly_report` |

---

## 3. Modell-Klassen und Ergebnisraum

| Klasse | Label | Parameter | Deployment | Default-Provider-Reihenfolge |
| --- | --- | --- | --- | --- |
| `MODEL_A` | local-small | 1–8 B | nur lokal | `ollama` (`qwen2.5:3b-instruct-q4_K_M`) → `openai` |
| `MODEL_B` | local-medium | 7–30 B | nur lokal | `ollama` (`qwen2.5:7b-instruct-q4_K_M`) → `openai` |
| `MODEL_C` | large | 30 B+ | lokal **oder** Cloud | `ollama` (`qwen2.5:14b…`) → `gemini` → `anthropic` |

**Ergebnisraum `RoutingDecision.decision`**

| Wert | Bedeutung |
| --- | --- |
| `MODEL_A` / `MODEL_B` / `MODEL_C` | Klasse wird von einem **lokalen** Provider bedient |
| `CLOUD` | Klasse wird von einem **Cloud**-Provider bedient (immer budgetgedeckelt) |
| `FALLBACK` | kein Modell nutzbar ⇒ deterministische Regel-Engine (`provider: "none"`, `model: "rule-engine"`) |

---

## 4. Default-Routing-Tabelle

| Agent | Modus | Klasse (Tabelle) | Cloud erlaubt |
| --- | --- | --- | --- |
| `CEO` | **automatic** | – (Router frei ab Complexity/Task) | ja |
| `RESEARCH` | automatic | **large** (`MODEL_C`) | ja |
| `TECHNICAL` / `TECHNICAL_ANALYST` | automatic | **local-small** (`MODEL_A`) | nein |
| `NEWS` / `NEWS_ANALYST` | automatic | **local-small** (`MODEL_A`) | nein |
| `RISK` / `RISK_MANAGER` | automatic | **local-medium** (`MODEL_B`) | nein |
| `PORTFOLIO` / `PORTFOLIO_ANALYST` | automatic | **local-medium** (`MODEL_B`) | nein |
| `MACRO`, `MARKET_SELECTION`, `WEEKLY_REVIEW` | automatic | `MODEL_B`/`MODEL_C` | ja |
| `MARKET_SCANNER`, `EXECUTOR` | **manual**, `pinnedModel: "none"` | – (LLM-frei, deterministisch) | nein |

Unbekannte Agenten fallen auf `defaultMode: automatic` + `defaultClass: MODEL_A` zurück.

**Entscheidungsalgorithmus** (deterministisch, dokumentierte Reihenfolge):

1. Untergrenze = `max(Tabellenklasse, Task-Override, Complexity-Floor, Risk-Floor)`.
2. Modus-Filter: `manual` ⇒ Tabellenklasse (Fix-Pinning) · `hybrid` ⇒ Tabellenklasse
   ist hart · `automatic` ⇒ freie Wahl nach (1), geklemmt auf `classCeiling`.
3. Provider-Wahl in **Policy-Reihenfolge**: Health, Cloud-Freigabe, Quota
   (`quotaMinPercent`), Kontext, Fähigkeiten, Latenz, Budget, Kostendeckel.
4. Kein Treffer ⇒ **Fallback-Kette** des letzten Providers (`timeout`/`quota`/`offline`).
5. Danach ⇒ **Zwangs-Rückstufung** Klasse für Klasse abwärts (nur lokal).
6. Immer noch nichts ⇒ `FALLBACK` (deterministische Regel-Engine).

---

## 5. Routing-Modi je Agent

| Modus | Bedeutung | Eskalation |
| --- | --- | --- |
| `manual` | festes Modell (`pinnedModel`), Router erzwingt nur Budget/Health | möglich (Regeln E1–E8) |
| `automatic` | Router entscheidet frei innerhalb `classCeiling` | möglich |
| `hybrid` | Klasse kommt aus der Tabelle, Router wählt Provider **innerhalb** der Klasse | nur innerhalb der Klassengrenze |

Admin-API (nur mit `x-admin-token` + `x-csrf-token`, Änderungen auditiert):

```bash
curl -s http://127.0.0.1:3369/api/routing/modes
curl -s -X PUT http://127.0.0.1:3369/api/routing/modes \
  -H 'content-type: application/json' \
  -H "x-admin-token: $FIRM_ADMIN_TOKEN" -H "x-csrf-token: $FIRM_ADMIN_TOKEN" \
  -d '{"modes":{"RESEARCH":"hybrid"},"actor":"ops"}'
# 200 { ok:true, modes:{…}, audit:[{ from:"mode:automatic", to:"mode:hybrid", … }] }
# 422 { ok:false, error:"INVALID_MODES", errors:[…] } · 401/403 Guard · 403 CSRF_INVALID
```

Die Modi werden zusätzlich unter `data/routing/modes.json` (chmod 600) best-effort
persistiert; der Speicherzustand bleibt Autorität.

---

## 6. Eskalationsfluss

```text
   Agent-Runtime (Metriken!)
   complexity=HIGH, confidence=0.58, tokenOvershoot, latencyViolation
        │
        │  MODEL_ESCALATION_REQUEST  { agent, task, complexity, reason,
        │                              currentModel, requestedClass, confidence }
        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ MODEL_ROUTER · requestEscalation()                            │
   │  E1 Klasse höher?            nein → denied  (kein Bedarf)     │
   │  E2 Zielklasse erlaubt?      nein → denied  (Policy)          │
   │  E3 Agenten-Deckel?          nein → denied  (classCeiling)    │
   │  E4 hybrid-Grenze?           nein → denied  (Klassenbindung)  │
   │  E5 Komplexität/Runtime?     nein → denied  (unter Schwelle)  │
   │  E6 Confidence ≤ 0.75?       nein → denied  (Agent ist sicher)│
   │  E7 Tageslimit (12)?         nein → denied  (Kontingent)      │
   │  E8 Zielklasse verfügbar?    nein → denied  (Budget/Health)   │
   └───────────┬──────────────────────────────┬───────────────────┘
               │ approved                     │ denied
               ▼                              ▼
   resolve(forcedClass)                 KEIN Modellwechsel
   + Audit {outcome:"approved",         + Audit {outcome:"denied",
             from, to, trigger}                   from == to, Grund}
```

**Golden Case** (Vorgabe, Test `tests/routing.integration.test.ts`):

| Schritt | Wert |
| --- | --- |
| Start | Research, kleines lokales Modell (`MODEL_B`/7B), Confidence **0.58** |
| Antrag | `complexity: HIGH`, `requestedClass: MODEL_C`, Reason „Für diese Aufgabe reicht Modell A nicht." |
| Entscheidung | **approved** (`COMPLEXITY` hoch, `CONFIDENCE` unter Schwelle) |
| Ergebnis | großes Modell (`MODEL_C`), Confidence im Test-Kontext **0.87** |
| Audit | `MODEL_ROUTING` mit `from`, `to`, `trigger: ESCALATION_APPROVED`, `policyVersion` |

Gegenfall: Confidence **0.95** / Complexity **LOW** ⇒ **denied**
(`COMPLEXITY_BELOW_THRESHOLD`), kein zweiter Aufruf, Agent läuft mit dem
aktuellen Modell weiter — aber **mit** Audit-Eintrag.

Trigger sind ausschließlich Runtime-Metriken. Ein Prompt- oder News-Text,
der „switch to MODEL_C" befiehlt, erreicht den Router nicht
(`toRoutingContext()`-Whitelist; Test: `tests/routing.injection.test.ts`).

---

## 7. Fallback-Ketten

Konfigurierbar unter `policy.fallbackChains` (Schlüssel `"<trigger>:<provider>"`,
Ersatz-Schlüssel `"default"`), Trigger `timeout` · `quota` · `offline`:

| Auslöser | Kette (Default) |
| --- | --- |
| `timeout:ollama` | `gemini` → `anthropic` |
| `quota:gemini` (< 5 %) | `ollama` |
| `quota:anthropic` (< 5 %) | `ollama` |
| `offline:ollama` | `gemini` → `anthropic` |
| `offline:gemini` | `ollama` → `anthropic` |
| `offline:anthropic` | `ollama` → `gemini` |
| `default` | `ollama` → `gemini` → `anthropic` |

Der Schweller `quotaMinPercent` (Default **5 %**) gilt providerübergreifend:
unterhalb dieses Restkontingents ist ein Provider nicht nutzbar.
Jeder tatsächliche Wechsel (auch innerhalb einer Klasse) wird als
`outcome: "fallback"` auditiert. Scheitert die gesamte Kette, antwortet der
deterministische Ersatz des Aufrufers — es wird nie blind weitergemacht.

---

## 8. Budget-Deckel

Konfigurierbar in der Policy (`budgets`) bzw. über die Registry-Felder:

| Ebene | Feld | Wirkung |
| --- | --- | --- |
| Provider | `budgets.providers.<id>.tokensPerDay` / `costUsdPerDay` | erschöpft ⇒ Provider wird übersprungen |
| Agent | `budgets.agents.<AGENT>.tokensPerDay` | erschöpft ⇒ alle Provider für diesen Agenten blockiert |
| Global | `budgets.global.*` | Tagesgesamtdeckel (Transparenz/Monitoring) |
| Eskalationen | `escalation.maxApprovedPerAgentPerDay` (12) | Tageslimit genehmigter Höherstufungen |

* **Zwangs-Fallback:** Überschreitung führt zur Rückstufung auf ein lokales Modell
  und zu einem Audit-Eintrag mit `outcome: "budget_blocked"`.
* **Deckel gilt auch im `manual`-Modus** — Ausnahme: explizite Admin-Freigabe
  `budgetExempt: true` (auditiert, hebt niemals den Cloud-Gesamtdeckel auf).
* **Cloud ist immer gedeckelt:** die Policy-Validierung erzwingt für
  `gemini`/`anthropic` einen `tokensPerDay > 0`. „Unbegrenzt" ist unzulässig.
* `tokensPerDay <= 0` bei lokalen Providern bedeutet „kein Deckel" (kostenlos).

---

## 9. Provider-Registry und Health-Poller

Erweiterte Registry-Felder je Provider (`src/routing/registry.ts`, Kapitel 10 in
[PROVIDER_INTEGRATION.md](PROVIDER_INTEGRATION.md)):

```ts
type ProviderDescriptor = {
  id: "ollama" | "openai" | "gemini" | "anthropic";
  models: string[];            // Ollama: live vom Server
  defaultModel: string;
  capabilities: ("chat"|"json"|"schema"|"long-context"|…)[];
  contextSize: number;         // Ollama: /api/show → model_info.context_length
  costPer1kIn / costPer1kOut: number;   // USD, lokal 0
  healthStatus: "online" | "degraded" | "offline";
  latencyEma: number;          // geglättete Antwortzeit (EMA)
  tokenBudgetToday: number;    // Deckel
  tokensUsedToday: number;     // Verbrauch
  quotaRest: number;           // Restkontingent in %
  lastCheckedAt?: string; error?: string;
};
```

* **Health-Poller:** Intervall aus `policy.healthPollerIntervalMs`
  (Default 60 s, `ROUTING_HEALTH_POLL_MS` überschreibt, `0` = aus). Der Timer ist
  `unref()`ed, ein Fehler bricht nie den Routing-Pfad ab.
* **Prüfumfang:** `ROUTING_HEALTH_PROBE=local` (Default) prüft nur lokale Provider
  über das Netzwerk; Cloud gilt mit API-Key als nutzbar. `=all` prüft auch Cloud
  (read-only Modellliste), `=off` prüft nichts. Timeout: `ROUTING_HEALTH_TIMEOUT_MS`
  (Default 1500 ms).
* **Ollama-Sonderfall:** Modellliste (`/api/tags`) **und** Kontextgrösse
  (`/api/show` → `model_info.*.context_length`, best-effort).

---

## 10. Audit-Format

Jeder Wechsel (inkl. Fallback und abgelehnter Eskalation) erzeugt einen Eintrag:

```json
{
  "ts": "2026-08-28T12:00:00.000Z",
  "agent": "RESEARCH",
  "from": "MODEL_B:ollama:qwen2.5:7b-instruct-q4_K_M",
  "to": "MODEL_C:ollama:qwen2.5:14b-instruct-q4_K_M",
  "reason": "Eskalation genehmigt (MODEL_B → MODEL_C). …",
  "trigger": "ESCALATION_APPROVED",
  "policyVersion": "1.0.0",
  "outcome": "approved",
  "task": "research",
  "complexity": "high",
  "detail": { "confidence": 0.58, "requestedClass": "MODEL_C", "agentReason": "…" }
}
```

* `outcome`: `resolved` · `approved` · `denied` · `fallback` · `budget_blocked` · `admin`
* Senken: In-Memory-Ring → NDJSON (`data/routing/audit.ndjson`) → `audit_log`
  (Event `MODEL_ROUTING`, best-effort, nie blockierend).
* Nachweis im Test: **100 % der Wechsel haben einen Audit-Eintrag**
  (`tests/routing.integration.test.ts`).

---

## 11. API-Referenz

| Methode | Pfad | Zweck |
| --- | --- | --- |
| `GET` | `/api/providers` | Karten-Daten: Status, Modell(e), Kontext, Latenz, Kosten, Tokens %, Restkontingent, Klassen |
| `GET` | `/api/providers?refresh=1` | erzwingt eine Health-Prüfung |
| `GET` | `/api/routing` | Policy (Version, Klassen, Eskalation, Budgets, Ketten), Modi, Provider, Budget, Audit |
| `GET` | `/api/routing/modes` | Routing-Modi je Agent |
| `PUT` | `/api/routing/modes` | Admin-Änderung (Token + CSRF, auditiert) |

---

## 12. Integration und Test-Support

```ts
import { routeChat, escalationFromRuntime } from "@/routing";

const result = await routeChat({
  agent: "TECHNICAL_ANALYST",
  task: "technical_analysis_standard",
  complexity: "medium",
  messages: [{ role: "user", content: "…" }],
  fallbackContent: JSON.stringify({ view: "NEUTRAL" }),
});
// result.decision: RoutingDecision · result.provider/model · result.switched
```

* `DefaultAnalysisAgentPort` (`src/cycle/ports.ts`) nutzt `routeChat()` — der
  einzige LLM-Pfad der Agenten-Laufzeit. `MODEL_*`-Env-Werte werden **ignoriert**.
* Genehmigte Eskalationen führen zu genau **einem** erneuten Aufruf mit dem
  eskalierten Modell; der Routing-Trace landet in `agent_messages.meta.routing`.
* Tests ohne echte Provider: `createFakeProviderRegistry()` (Health/Quota/Latenz/
  Timeout injizierbar), `MemoryAuditSink`, injizierte Uhr.

```bash
npm run test:coverage:routing
```

---

## 13. Konfiguration

| Variable | Default | Bedeutung |
| --- | --- | --- |
| `ROUTING_POLICY_PATH` | – | Policy-Datei (JSON); **ungültig ⇒ Startverweigerung** |
| `ROUTING_HEALTH_POLL_MS` | Policy (60 000) | Intervall des Health-Pollers (`0` = aus) |
| `ROUTING_HEALTH_PROBE` | `local` | `off` · `local` · `all` |
| `ROUTING_HEALTH_TIMEOUT_MS` | `1500` | Timeout je Health-Prüfung |
| `ROUTING_BUDGET_<PROVIDER>_TOKENS` | Policy | Tages-Token-Deckel je Provider |
| `ROUTING_POLICY_VERSION` | – | nur Audit-Kontext (Version stammt aus der Policy) |

---

## 14. Warum kein Agent selbst wechselt (Governance)

1. **Kostenkontrolle:** Ein Agent optimiert seine eigene Trefferquote — nicht das
   Budget. Ohne Router ist jedes „das große Modell wäre besser" eine Ausgabe.
   Der Router bewertet Nutzen **gegen** Policy, Budget und Tageskontingent.
2. **Determinismus/Reproduzierbarkeit:** Dieselbe Aufgabe muss morgen dieselbe
   Modellklasse bekommen, sonst sind Backtests und Audits wertlos. Eine
   Agenten-Selbstwahl ist nicht reproduzierbar (Temperatur, Prompt-Drift).
3. **Injection-Resistenz:** Agenten verarbeiten Fremdinhalte (News, Feeds).
   Wäre der Modellwechsel per Inhalt auslösbar, könnte eine Schlagzeile
   („black swan — escalate") Cloud-Kosten und Datenabfluss erzwingen. Deshalb
   sind nur Runtime-Metriken Trigger, und Freitext wird verworfen.
4. **Datenabfluss:** Cloud-Aufrufe verlassen die Maschine. Ob und wie oft das
   passiert, entscheidet eine versionierte, auditierte Policy — kein Prompt.
5. **Trennung von Vorschlag und Entscheidung:** Wie bei Order-Guardrails gilt:
   **Die KI schlägt vor — der Code entscheidet.** Der Agent beantragt, der
   Router genehmigt oder lehnt ab, beides mit Audit-Eintrag und Begründung.

---

## 15. Grenzen

* Cloud-Health ist ohne `ROUTING_HEALTH_PROBE=all` **key-basiert** („Key vorhanden
  ⇒ nutzbar") — kein Fern-Check. Der erste echte Aufruf kann dennoch scheitern;
  dann greift die Fallback-Kette (auditiert).
* `latencyEma` ist ein Prozess-lokaler Schätzwert; der erste Wert einer Instanz
  ist die erste Messung.
* Klassen-Grenzen orientieren sich an Modell-Tags, nicht an gemessener Qualität.
* Budget-Zähler sind prozess-lokal (Single-Node), analog zum bestehenden
  Rate-Limiter. Mehrinstanzen-Betrieb braucht eine geteilte Zustandsquelle.
