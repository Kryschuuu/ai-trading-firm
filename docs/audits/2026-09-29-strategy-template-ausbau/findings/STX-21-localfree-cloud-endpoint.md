# STX-21 — `LOCAL_FREE` garantiert „lokal" nur per Default-Konfiguration

- **ID:** STX-21
- **Severity:** LOW
- **Bereich:** Routing / LLM · Datenschutz
- **Quelle:** eigener Befund im Abgleich [2026-10-03](../remediation/RECONCILE-2026-10-03.md)
- **Status:** OPEN
- **Fix-Version:** —
- **Datei(en):** `src/strategies/validator/agent.ts`, `src/lib/llmProvider.ts`, `src/routing/providerToggles.ts`

## Beschreibung

[STX-13](STX-13-opencode-free-tier.md) verlangt: *„`LOCAL_FREE` (Ollama) bleibt
die **einzige** harte Garantie"* und als Abnahmekriterium *„`LOCAL_FREE`-Pfad
funktioniert vollständig ohne Cloud-Credentials"*. Beides ist umgesetzt — der
Pfad läuft ohne Cloud-Schlüssel, und der Test
`tests/strategyValidation.agent.test.ts:143` belegt es.

Der Abgleich zeigt aber eine Lücke zwischen **Name** und **Garantie**: Die
Provider-Liste hinter `LOCAL_FREE` ist nicht auf Ollama beschränkt, und der
zweite Eintrag ist ein OpenAI-**kompatibler** Provider, dessen Endpunkt frei
konfigurierbar ist. „Lokal" ist damit eine Default-Konfiguration, keine
durchgesetzte Eigenschaft.

## Beweis

```ts
// src/strategies/validator/agent.ts:44-45
const LOCAL_FREE_PROVIDERS: LlmProviderName[] = ["ollama", "openai"];
const OPENCODE_FREE_PROVIDER_ORDER: LlmProviderName[] = ["opencode", ...LOCAL_FREE_PROVIDERS];
```

```ts
// src/lib/llmProvider.ts:150 — Default-Basis-URL für `openai`
openai: "http://127.0.0.1:8080/v1",
// src/lib/llmProvider.ts:210 — aber überschreibbar
: "LLM_BASE_URL";
```

Der einzige Filter vor dem Aufruf prüft **Toggles**, nicht Endpunkte:

```ts
// src/routing/providerToggles.ts:105-110
export function filterEnabledProviders<T extends string>(ids, env = process.env): T[] {
  return ids.filter((id) => isProviderEnabled(id, env));   // Runtime-Flag / ROUTING_DISABLED_PROVIDERS
}
```

Setzt eine Installation `LLM_BASE_URL` auf eine Cloud-URL und `LLM_API_KEY`,
sendet `LOCAL_FREE` denselben Report an diesen Endpunkt — unter einem
Policy-Namen, der das Gegenteil verspricht. `providerToggleSpec`
(`src/routing/providerToggles.ts:73-84`) klassifiziert `openai` ausdrücklich als
„(lokal)", was die Erwartung zusätzlich festigt.

**Kein Datenabfluss im Default-Betrieb.** Ohne `LLM_BASE_URL` bleibt der Pfad
lokal; der Befund betrifft die **Garantie**, nicht einen konkreten Vorfall.

## Remediation

Zwei zulässige Wege, **einer** genügt:

1. **Durchsetzen:** `LOCAL_FREE` akzeptiert nur Endpunkte auf Loopback/privatem
   Bereich; ein anderer Endpunkt fällt aus der Liste (sichtbar per Telemetrie,
   kein stiller Wechsel).
2. **Umbenennen/Präzisieren:** Die Policy heißt, was sie tut
   (z. B. `NO_PAID_CLOUD`), und Doku + Modulkopf sagen ausdrücklich, dass
   `LLM_BASE_URL` den Endpunkt bestimmt.

Weg 1 ist die stärkere Zusage und passt zu STX-13. Prompt:
[PROMPT-STX-08-05](../prompts/PROMPT-STX-08-05-localfree-endpoint-haertung.md).

## Akzeptanzkriterien

- [ ] `LOCAL_FREE` sendet **nachweislich** nur an Endpunkte, die als lokal
      klassifiziert sind — oder die Policy trägt einen Namen, der keine
      Lokalität verspricht
- [ ] Ein konfigurierter Cloud-Endpunkt unter `LOCAL_FREE` ist kein stiller
      Erfolg: entweder ausgesondert (mit Zähler) oder dokumentiert
- [ ] Bestehender Test `LOCAL_FREE läuft ohne Cloud-Credentials …` bleibt grün
- [ ] `{ unavailable: true }` bleibt die einzige Antwort bei
      Provider-/Schema-Ausfall; `result` wird nie verändert (STX-13)
- [ ] `npm run typecheck && npm run lint && npm test` grün

## Versions-Hinweis

Patch bei Weg 1, sofern kein Verhalten im Default-Betrieb kippt; sonst Minor.
