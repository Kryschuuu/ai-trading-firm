# STX-13 — OpenCode-Zen-Free-Tier rotiert; nicht als harte Routing-Klasse führen

- **ID:** STX-13
- **Severity:** LOW
- **Bereich:** Routing / LLM
- **Quelle:** Ausbaudokument §3.8, §14
- **Status:** OPEN
- **Datei(en):** `src/routing/`, `src/lib/llmProvider.ts`

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
3. Der Validator-Agent darf bei Provider-Ausfall `INCONCLUSIVE` liefern, **nicht** `FAIL`
   und **nicht** `PASS`. Das ist die eigentliche Absicherung.
4. `big-pickle` als Default ist aktuell gültig, sollte aber als **konfigurierbar** bleiben
   (ist es: `OPENCODE_MODEL`).

## Akzeptanzkriterien

- [ ] `LOCAL_FREE`-Pfad funktioniert vollständig ohne Cloud-Credentials (bestehender Test)
- [ ] Provider-Ausfall ⇒ `INCONCLUSIVE`, nie `FAIL`
- [ ] Keine Free-Modell-Liste im Code, die als garantie dokumentiert wird

## Versions-Hinweis

N/A (Doku/Einordnung).
