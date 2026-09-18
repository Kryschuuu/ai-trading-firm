# Arena-Prompt-Serie — Feature-Gap-Remediation (GAP-01…GAP-10)

> **Zweck:** Je Finding dieses Audits ein **einpaste-fähiger Session-Prompt**
> für Arena.ai (Agent Mode). Ein Prompt = eine Arena-Session = ein PR.
> Jeder Prompt ist self-contained (Baseline-Regeln eingebettet), verlangt
> zuerst die Ist-Stand-Verifikation und schreibt Tests, Docs-Sync,
> Changelog und Versions-Bump verbindlich vor.

## Wie benutzen?

1. Neuen Arena-Chat öffnen (Agent Mode, dieses Repository).
2. Den kompletten Block aus `PROMPT-XX-*.md` (Abschnitt „Session-Prompt“)
   **unverändert** einfügen und die Session laufen lassen.
3. Der Agent arbeitet auf dem Session-Branch, macht Tests + Docs + Changelog
   im selben PR und aktualisiert
   [`../remediation/TRACKING.md`](../remediation/TRACKING.md).
4. Review wie jedes andere PR (Security- und Doku-Checks laufen in CI).

## Empfohlene Abarbeitungsreihenfolge

Reihenfolge aus dem Co-Audit (Teil 1, §3), Bestätigung in Teil 2:

| Schritt | Prompt | Kategorie | Warum hier |
|---------|--------|-----------|------------|
| 1 | [PROMPT-02](PROMPT-02-execution-simulation.md) | Ehrlichkeit | Kleinster Aufwand (Delta), größter Effekt auf Aussagekraft aller Paper-Ergebnisse — alles Spätere misst ehrlicher |
| 2 | [PROMPT-05](PROMPT-05-server-side-exit-management.md) | Schutz | Tail-Risk-Schutz baut auf ehrlichen Fills auf |
| 3 | [PROMPT-10](PROMPT-10-observability-circuit-breaker.md) | Betrieb | Auto-Breaker + Metriken absichern, bevor Sizing/Gates drehen |
| 4 | [PROMPT-04](PROMPT-04-vol-sizing-correlation-limits.md) | Rendite/Risiko | Größter Einzelhebel auf risikoadjustierte Rendite |
| 5 | [PROMPT-06](PROMPT-06-regime-gate.md) | Rendite | Gate braucht Korrelations-/Vol-Infrastruktur aus Schritt 4 |
| 6 | [PROMPT-07](PROMPT-07-data-quality-multi-timeframe.md) | Fundament | Saubere Daten vor Lernschleife & Backtesting |
| 7 | [PROMPT-03](PROMPT-03-trade-journal-attribution.md) | Lernschleife | Nutzt Regime + Datenqualität für saubere Attribution |
| 8 | [PROMPT-08](PROMPT-08-llm-validation-eval-harness.md) | Qualität | Eval-Harness vor Backtesting-Regressionen absichern |
| 9 | [PROMPT-01](PROMPT-01-backtesting-walk-forward.md) | Validierung | Größter Brocken; braucht **02** (Kostenmodell) und **07** (Datenqualität) — erst nach Schritt 1 und 6 starten |
| 10 | [PROMPT-09](PROMPT-09-reconciliation-idempotency.md) | Live-Readiness | Erst kritisch, wenn der Live-Pfad aktiviert werden soll; Paper-Invarianz-Selbsttest liefert aber schon vorher Nutzen |

Hartes Abhängigkeits-Minimum: **01 nach 02+07**. Alles andere ist in der
Reihenfolge empfohlen, aber nicht zwingend.

## Regeln für alle Sessions (Auszug)

- Verifikation vor Implementation: jeder Prompt zählt die zu lesenden Dateien;
  existiert etwas bereits, wird nur das Delta umgesetzt und die Abweichung im
  PR dokumentiert.
- Paper-only: der Live-Pfad wird von keinem Prompt angetastet.
- Fail-closed: UNKNOWN/DATA_UNAVAILABLE statt stiller Fallbacks; synthetische
  Daten nur in `tests/`.
- Keine neuen Runtime-Dependencies ohne zwingenden Grund + Begründung im PR.
- EinPR mit Testbericht (Befehle + Ergebniszahlen), Docs-Sync, Changelog,
  Versions-Bump und Aktualisierung von `../remediation/TRACKING.md`.
