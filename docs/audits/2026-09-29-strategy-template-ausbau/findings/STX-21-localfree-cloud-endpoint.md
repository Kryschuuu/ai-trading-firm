# STX-21 — `LOCAL_FREE` garantiert „lokal" nur per Default-Konfiguration

- **ID:** STX-21
- **Severity:** LOW
- **Bereich:** Routing / LLM · Datenschutz
- **Quelle:** eigener Befund im Abgleich [2026-10-03](../remediation/RECONCILE-2026-10-03.md)
- **Status:** **FIXED** (08-05, `v0.11.1`, 2026-10-03)
- **Fix-Version:** `v0.11.1`
- **Datei(en):** `src/strategies/validator/agent.ts`, `src/routing/localEndpoint.ts` (neu), `src/lib/telemetry.ts`, `src/lib/llmProvider.ts` (unverändert), `src/routing/providerToggles.ts` (unverändert)

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

- [x] `LOCAL_FREE` sendet **nachweislich** nur an Endpunkte, die als lokal
      klassifiziert sind — die Policy trägt weiter den Namen der Zusage
- [x] Ein konfigurierter Cloud-Endpunkt unter `LOCAL_FREE` ist kein stiller
      Erfolg: er wird ausgesondert **und** mit Zähler dokumentiert
- [x] Bestehender Test `LOCAL_FREE läuft ohne Cloud-Credentials …` bleibt grün
- [x] `{ unavailable: true }` bleibt die einzige Antwort bei
      Provider-/Schema-Ausfall; `result` wird nie verändert (STX-13)
- [x] `npm run typecheck && npm run lint && npm test` grün

## Versions-Hinweis

Patch bei Weg 1, sofern kein Verhalten im Default-Betrieb kippt; sonst Minor.

## Abschluss 2026-10-03 (08-05, `v0.11.1`)

**Gewählter Weg:** 1 — **Durchsetzen** (keine Umbenennung). Begründung: Der
Name `LOCAL_FREE` ist als Zusage brauchbar, sobald der Endpunkt geprüft wird;
eine Umbenennung hätte die Garantie nur gestrichen und `OPENCODE_FREE` (STX-13)
bleibt als Cloud-Opt-in ohnehin der einzige Weg zu einem Cloud-Provider.

**Umsetzung**

- Neu: `src/routing/localEndpoint.ts` — reine, deterministische Klassifikation
  eines Basis-URLs (`isLocalEndpointBaseUrl()`, `isLocalHostLiteral()`): Loopback
  `127.0.0.0/8`, IPv6 `::1` (inkl. IPv4-gemappter Form), `localhost`/`*.localhost`
  sowie die reservierten, öffentlich nicht auflösbaren Namensräume `.test` und
  `.invalid` (RFC 6761). Kein DNS-Lookup, keine Auflösung, kein Netzwerkzugriff.
- `allowedProviderOrder()` (`src/strategies/validator/agent.ts`) prüft jeden
  lokalen Kandidaten (`ollama`, `openai`) gegen seinen **effektiven** Basis-URL
  (`providerConfigFromEnv()`, also Env-Override `OLLAMA_BASE_URL`/`LLM_BASE_URL`
  oder Default aus `DEFAULT_BASE_URLS`) und entfernt nicht-lokale Einträge.
- Sichtbarkeit: `validator_agent_provider_excluded_total{policy,provider}` in
  `src/lib/telemetry.ts` (Labels geschlossen: `LOCAL_FREE`/`OPENCODE_FREE` und
  `LlmProviderName`); Exposition über `prometheusMetrics()`.
- Keine Änderung an `result`, `gates[]`, `assumptions` oder dem Report; leere
  Liste ⇒ weiterhin `{ unavailable: true }` (`agent.ts`, Provider-Schleife).
- `OPENCODE_FREE` bleibt Cloud-Opt-in und Best-Effort; nur seine **lokalen
  Fallbacks** unterliegen der Endpunkt-Prüfung.
- `DEFAULT_BASE_URLS`, `API_KEY_ENV` und die Provider-Liste in
  `src/lib/llmProvider.ts` sowie `src/routing/policy.ts` sind unverändert.

**Entscheidung/Abweichung:** Die Prompt-Skizze nennt Loopback und `localhost`.
Zusätzlich gelten die RFC-6761-Namensräume `.test`/`.invalid` als lokal („nicht
öffentlich auflösbar"). Ohne diese Ausnahme würde die bestehende, gemockte
Testreihe `LOCAL_FREE durchläuft den echten Ollama-Client …`
(`tests/strategyValidation.agent.test.ts:186`, `http://ollama.test:11434`) unter
der neuen Regel gesperrt. Eine `.test`-Domain kann per Standard nie auf einen
öffentlichen Cloud-Endpunkt zeigen; die Aussage „kein öffentlich erreichbarer
Endpunkt" bleibt gewahrt. Intra-/Container-Kurznamen (`http://ollama:11434`)
oder private Netze (`192.168.x.x`) gelten bewusst **nicht** als lokal
(fail-closed, sichtbar am Zähler).

**Nachweise**

- `tests/routing.localEndpoint.test.ts` — 6 Tests: Loopback-IPv4/-IPv6,
  `localhost`, `.test`/`.invalid`, Cloud-Domains, private Netze, Credentials,
  Fremdschemata, Unparsebares.
- `tests/strategyValidation.agent.test.ts` (neu, 13 Tests) — u. a.
  `LLM_BASE_URL=https://api.openai.com/v1` ⇒ `openai` fällt aus, Zähler
  `excluded{policy="LOCAL_FREE",provider="openai"} 1`, kein Request an
  `api.openai.com` (Fetch-Spy weist jeden nicht-lokalen Host zurück);
  `LLM_BASE_URL=http://127.0.0.1:9999/v1` ⇒ `openai` bleibt nutzbar; sind
  `ollama` und `openai` ausgeschlossen ⇒ `{ unavailable: true }`, kein
  Modellaufruf, Report byte-identisch; Toggle-Sperre zählt nicht als Ausschluss.
  Die Bestandstests `LOCAL_FREE läuft ohne Cloud-Credentials …` (`:143`) und
  `LOCAL_FREE durchläuft den echten Ollama-Client ohne Cloud-Schlüssel` (`:186`)
  bleiben unverändert und grün.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run docs:validate` grün.

