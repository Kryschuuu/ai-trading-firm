# H10 — Adaptives Risk-System kann bei Fehler explizit auf Basisrisiko zurückfallen

- **Severity:** HIGH
- **Bereich:** Handelslogik
- **Status (validiert):** ✅ **Valide.**
- **Datei(en):** `src/lib/engine.ts` L314‑329, `src/lib/adaptiveRisk.ts` (fail-open Kommentare L242/303/421/556),
  `src/lib/riskGuard.ts` (`AdaptiveRegime` = "NORMAL"|"ELEVATED"|"EXTREME"|"PERSISTED")

## Arena-Prompt (kopierbar)

```
TASK: Stop the adaptive risk layer from silently failing OPEN; introduce an explicit UNKNOWN state.

PROBLEM: When ensureAdaptiveRiskFresh() errors, the engine keeps the last/known state and the
code comments say "Basis-Limit aktiv (Fail-Open)". For a system whose security model is
"adaptive regime => risk reduction", an unknown regime must NOT default to NORMAL/full risk.

DO:
1. Extend AdaptiveRegime (src/lib/riskGuard.ts) with "UNKNOWN":
     export type AdaptiveRegime = "NORMAL" | "ELEVATED" | "EXTREME" | "PERSISTED" | "UNKNOWN";
2. In adaptiveRisk.ts, when assessment is missing/errored/stale beyond ADAPTIVE_STATE_MAX_AGE_MS,
   return state { regime: "UNKNOWN", factor: <most-conservative e.g. floor>, reason: "..." }.
   Do NOT silently fall back to NORMAL.
3. In engine.ts runAgentTurn, change the adaptive check so UNKNOWN blocks NEW positions:
     const canOpen = adaptiveState && adaptiveState.regime !== "EXTREME"
                     && adaptiveState.regime !== "UNKNOWN";
   and reflect it in the trace ("ADAPTIVES-RISIKO", ok=false on UNKNOWN/EXTREME).
4. Keep PERSISTED factor semantics; treat UNKNOWN as "no new positions" (like EXTREME) but with a
   distinct reason so operators can see the assessment failed.

ACCEPTANCE: Force ensureAdaptiveRiskFresh to throw / return stale data; assert runAgentTurn blocks
new trades and the trace shows regime UNKNOWN. Unit test the UNKNOWN mapping.
```

## Beweis (aktueller Code)

`src/lib/adaptiveRisk.ts` L303: `? "Keine Indikator-Daten verfügbar — Fail-Open, Basis-Limit bleibt aktiv"`.
`src/lib/engine.ts` L329: `adaptiveState ? adaptiveState.regime !== "EXTREME" : true` — `UNKNOWN`
würde (sobald eingeführt) fälschlich als erlaubt durchgehen, wenn nicht explizit behandelt.

## Fix-Spezifikation

Drei Zustände explizit: `NORMAL` / `REDUCED_RISK`(ELEVATED/PERSISTED) / `RISK_STATE_UNKNOWN`;
`UNKNOWN → no new positions` (siehe Audit H10).

## Akzeptanzkriterien / Tests

- [ ] Fehlende/fehlerhafte Bewertung → `regime: "UNKNOWN"`.
- [ ] `UNKNOWN` blockiert Neupositionen (wie `EXTREME`).
- [ ] Trace macht den UNKNOWN-Grund sichtbar.

## Changelog-Blurb

`H10 (HIGH): Adaptives Risk fail-open — expliziter UNKNOWN-State; unbekannte Bewertung blockiert
Neupositionen statt still auf Basisrisiko zurückzufallen.`

## Versions-Hinweis

PATCH (`1.36.3`) — Verhaltens-Härtung, Typ-Erweiterung (abwärtskompatibel).
