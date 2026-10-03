# STX-08-05 — `LOCAL_FREE`-Endpunkt absichern

- **Phase:** 8 · **Paket:** eigenständig · **Finding:** [STX-21](../findings/STX-21-localfree-cloud-endpoint.md) · Bezug: [STX-13](../findings/STX-13-opencode-free-tier.md)
- **Risiko:** gering (begrenzter Pfad, Default-Verhalten bleibt)

## Zweck

`LOCAL_FREE` verspricht einen lokalen, cloud-freien Pfad für den Validator-Agenten.
Die Provider-Liste dahinter enthält aber `openai` — einen
OpenAI-**kompatiblen** Provider, dessen Endpunkt über `LLM_BASE_URL` frei
konfigurierbar ist. Der Filter vor dem Aufruf prüft Toggles, nicht Endpunkte.
Damit ist „lokal" eine Default-Konfiguration und keine durchgesetzte Garantie.

## Kontext

```ts
// src/strategies/validator/agent.ts:44-45
const LOCAL_FREE_PROVIDERS: LlmProviderName[] = ["ollama", "openai"];
const OPENCODE_FREE_PROVIDER_ORDER: LlmProviderName[] = ["opencode", ...LOCAL_FREE_PROVIDERS];

// src/strategies/validator/agent.ts:423-431 — einziger Filter
function allowedProviderOrder(config, env): LlmProviderName[] {
  const candidates = config.routingPolicy === "OPENCODE_FREE"
    ? (env.OPENCODE_API_KEY?.trim() ? OPENCODE_FREE_PROVIDER_ORDER : LOCAL_FREE_PROVIDERS)
    : LOCAL_FREE_PROVIDERS;
  return filterEnabledProviders(candidates, env);   // prüft nur Toggles
}
```

```ts
// src/lib/llmProvider.ts:150 / :210
openai: "http://127.0.0.1:8080/v1",   // Default
: "LLM_BASE_URL";                     // überschreibbar
```

`providerToggleSpec` (`src/routing/providerToggles.ts:73-84`) klassifiziert
`openai` bereits als „(lokal)" — die Erwartung ist also im Code angelegt, nur
nicht durchgesetzt.

**Kein Datenabfluss im Default-Betrieb.** Ohne `LLM_BASE_URL` bleibt der Pfad
lokal. Es geht um die Garantie, nicht um einen Vorfall.

## Auftrag

1. Ergänze eine reine Hilfsfunktion, die einen Basis-URL als **lokal**
   klassifiziert: Loopback (`127.0.0.0/8`, `::1`) und `localhost`. Kein DNS-Lookup,
   keine Auflösung — nur die literale Host-Prüfung, deterministisch testbar.
2. Wende sie in `allowedProviderOrder()` an: Ein Provider, dessen **effektiver**
   Endpunkt (Env-Override, sonst Default aus `DEFAULT_BASE_URLS`) nicht lokal
   ist, fällt unter `LOCAL_FREE` aus der Liste.
3. Der Ausschluss ist **sichtbar**, nicht still: Zähler
   `validator_agent_provider_excluded_total{policy,provider}` mit geschlossenen
   Labels (bestehendes Muster `telemetry.validatorAgent.runs`), keine
   Freitext-URLs im Label.
4. Leere Liste ⇒ weiter `{ unavailable: true }`
   (`agent.ts:544-545`) — niemals ein Ausweichen auf einen Cloud-Provider und
   niemals ein Verändern von `result`.
5. Doku: Modulkopf `agent.ts` und
   [`../../../STRATEGY_VALIDATION.md`](../../../STRATEGY_VALIDATION.md) Teil 5
   sagen ausdrücklich, was `LOCAL_FREE` garantiert und dass `LLM_BASE_URL` den
   Endpunkt bestimmt.
6. **Alternative** (falls die Härtung unerwünscht ist): Policy umbenennen in
   etwas, das keine Lokalität verspricht, und dieselbe Doku-Pflicht erfüllen.
   Dann entfallen Punkt 1–3. Die Wahl ist im PR-Text zu begründen.

## Randbedingungen — nicht anfassen

- `result`, `gates[]`, `assumptions` und der deterministische Report bleiben
  unangetastet — der Agent erklärt, er entscheidet nicht
  ([STX-17](../findings/STX-17-info-validator-agent-kompatibel.md)).
- `OPENCODE_FREE` bleibt opt-in und Best-Effort; seine Reihenfolge
  (`opencode` → lokale Fallbacks) bleibt.
- **Kein** neuer Routing-Typ, keine Änderung an `src/routing/policy.ts`.
- **Keine** Änderung an `DEFAULT_BASE_URLS`, `API_KEY_ENV` oder der
  Provider-Liste in `src/lib/llmProvider.ts`.
- **Keine** Free-Modell-Liste, die als Garantie dokumentiert wird (STX-13).
- **Kein** Schreibpfad zu `strategy_lifecycle_transitions`, kein
  `requestTransition`.

## Abnahmekriterien

- [ ] Unter `LOCAL_FREE` wird nachweislich kein Endpunkt außerhalb von
      Loopback/`localhost` angefragt (Test mit gesetztem `LLM_BASE_URL` auf eine
      Cloud-URL: Provider fällt aus, Zähler zählt, `unavailable` bei leerer Liste)
- [ ] Bestehender Test `LOCAL_FREE läuft ohne Cloud-Credentials …`
      (`tests/strategyValidation.agent.test.ts:143`) bleibt **unverändert** grün
- [ ] Bestehender Test `LOCAL_FREE durchläuft den echten Ollama-Client ohne
      Cloud-Schlüssel` (`:186`) bleibt grün
- [ ] `{ unavailable: true }` bleibt die einzige Antwort bei Ausfall; `result`
      wird nie verändert
- [ ] Telemetrie-Labels geschlossen; keine URL, kein Modellname, kein Freitext
- [ ] `npm run typecheck && npm run lint && npm test` grün
- [ ] [STX-21](../findings/STX-21-localfree-cloud-endpoint.md) auf `FIXED`
      (oder `WONTFIX` mit Begründung, falls umbenannt wurde)

## Tests

```bash
npm test -- tests/strategyValidation.agent.test.ts
npm run typecheck && npm run lint
```

Neu mindestens:
1. `LLM_BASE_URL=https://api.openai.com/v1` unter `LOCAL_FREE` ⇒ `openai`
   ausgeschlossen, Zähler `excluded{provider="openai"}`, kein Request dorthin
2. `LLM_BASE_URL=http://127.0.0.1:9999/v1` ⇒ `openai` bleibt nutzbar
3. alle Provider ausgeschlossen ⇒ `{ unavailable: true }`, `result` unverändert
