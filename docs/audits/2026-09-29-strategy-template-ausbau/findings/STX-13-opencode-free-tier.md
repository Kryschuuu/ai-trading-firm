# STX-13 — OpenCode-Zen-Free-Tier rotiert; nicht als harte Routing-Klasse führen

- **ID:** STX-13
- **Severity:** LOW
- **Bereich:** Routing / LLM
- **Quelle:** Ausbaudokument §3.8, §14
- **Status:** FIXED (06-05, `v0.10.4`; Restpunkt mit 08-05, `v0.11.1`) — bestätigt im Abgleich 2026-10-03; der Restpunkt der Lokalitäts-Garantie wurde als [STX-21](STX-21-localfree-cloud-endpoint.md) erfasst und mit 08-05 (`v0.11.1`) geschlossen
- **Datei(en):** `src/routing/`, `src/lib/llmProvider.ts`

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **FIXED** — Restpunkt ausgegliedert nach STX-21 und dort mit 08-05 (`v0.11.1`, Endpunkt-Prüfung) geschlossen
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `src/strategies/validator/agent.ts:175` — Policy-Flag statt Routing-Typ (`LOCAL_FREE`/`OPENCODE_FREE`); `:427-429` — `OPENCODE_FREE` nur mit `OPENCODE_API_KEY`, sonst lokale Liste
- Ausfall ⇒ `{ unavailable: true }`: `agent.ts:183-184`, `:541`; `result` wird nie verändert
- Keine Free-Modell-Liste als Garantie im Code
- Tests ausgeführt und grün: `tests/strategyValidation.agent.test.ts:143` („läuft ohne Cloud-Credentials"), `:186` („echter Ollama-Client ohne Cloud-Schlüssel"), `:262` (unbekannte Policy ⇒ `LOCAL_FREE`)
- **Restpunkt → [STX-21](STX-21-localfree-cloud-endpoint.md) — mit 08-05 (`v0.11.1`) geschlossen:** `LOCAL_FREE_PROVIDERS` (`agent.ts:44`) enthält `openai`, dessen Endpunkt über `LLM_BASE_URL` konfigurierbar ist (`src/lib/llmProvider.ts:150,210`); `filterEnabledProviders` (`src/routing/providerToggles.ts:105-110`) filtert nur Toggles. Seit 08-05 prüft `allowedProviderOrder()` zusätzlich den **effektiven** Endpunkt gegen `src/routing/localEndpoint.ts` und sondert nicht-lokale Provider sichtbar über `validator_agent_provider_excluded_total{policy,provider}` aus; `{ unavailable: true }` bei leerer Liste bleibt. Die Abnahmekriterien dieses Findings bleiben erfüllt — jetzt auch die **Garantie** „lokal".

## Beschreibung

§14 führt `OPENCODE_FREE` als eine von drei belastbaren Routing-Klassen und nennt eine
konkrete Free-Liste. Die Liste ist **zeitabhängig und rotierend**; eine Quelle weist
zusätzlich darauf hin, dass die Zen-Aktivierung eine Einzahlung erfordern kann.

Bestätigt durch das Dokument selbst: *„OpenCode kennzeichnet die kostenlosen Modelle als
zeitlich begrenzte Free-Angebote."* — dann aber als Planungsgrundlage verwendet.

## Beweis (Repo)

```ts
// src/lib/llmProvider.ts:187
export const OPENCODE_DEFAULT_MODEL = "big-pickle";
// :162
opencode: "OPENCODE_API_KEY",
```

`src/routing/policy.ts` behandelt OpenCode bereits korrekt:

```ts
// Ohne `OPENCODE_API_KEY` ist die Karte `offline` — kein Verhaltenswechsel.
{ provider: "opencode" },
…
"offline:opencode": ["ollama", "gemini"],
```

`providerToggles.ts` dokumentiert: *„Free-Modelle (OpenCode Zen) — `opencode` ist der
Cloud-Provider für OpenCode Zen. Dessen Free-Modelle kosten 0 USD; die Karte wird deshalb
mit `costPer1kIn/Out = 0` … geführt."*

**Der „kostet 0 USD"-Kommentar ist die Fehlerquelle**: Die Modelle sind kostenlos, der
*Zugang* ist es nicht zwingend. Kosten=0 rechtfertigt keine Verfügbarkeitsannahme.

## Remediation

1. `LOCAL_FREE` (Ollama) bleibt die **einzige** harte Garantie.
2. `OPENCODE_FREE` wird kein Routing-Typ, sondern ein **Provider-Feature-Flag** mit
   „best effort"-Semantik — vorhandener Toggle-Mechanismus genügt.
3. Provider-Ausfall liefert `{ unavailable: true }`; der Agent erzeugt daraus weder
   `INCONCLUSIVE` noch `FAIL`/`PASS`. Die deterministische Report-Entscheidung bleibt
   unverändert; das ist die Absicherung gegen ein Urteil aus Nichtwissen.
4. `big-pickle` als Default ist aktuell gültig, sollte aber als **konfigurierbar** bleiben
   (ist es: `OPENCODE_MODEL`).

## Akzeptanzkriterien

- [x] `LOCAL_FREE`-Pfad funktioniert vollständig ohne Cloud-Credentials (Test)
- [x] Provider-Ausfall ⇒ `{ unavailable: true }`; weder `INCONCLUSIVE` noch ein Verdict
- [x] Keine Free-Modell-Liste im Code, die als Garantie dokumentiert wird

## Versions-Hinweis

Umgesetzt mit `v0.10.4` (STX-06-05).
