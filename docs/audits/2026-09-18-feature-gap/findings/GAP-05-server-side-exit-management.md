# GAP-05 — Server-seitiges Exit-Management (SL/TP/Trailing, OCO/Bracket, Time-Stop)

**Nutzen:** ★★★★★ · **Aufwand (Co-Audit):** 🔧🔧🔧 · **Aufwand (verifiziert):** 🔧🔧
**Kategorie:** Schutz · **Prompt:** [`PROMPT-05`](../prompts/PROMPT-05-server-side-exit-management.md)

## Befund (Co-Audit)

Der wichtigste Schutz gegen Tail-Risk; Exits dürfen nie von LLM-Latenz oder
Provider-Ausfall abhängen. Contra: Stop-Hunting bei zu engen Stops; Order-Typ-
Mapping (Conditional, Reduce-Only) korrekt halten.

## Verifizierter Ist-Stand (2026-09-18, v1.40.0)

- `src/lib/monitor.ts` `tick()`: serverseitiger Watcher, prüft je offener
  Position SL/TP unabhängig von LLM-Turns; `stopsTriggered` im Ergebnis;
  `exitReason`-Taxonomie (STOP_LOSS | TAKE_PROFIT | MANUAL_FLATTEN |
  AGENT_CLOSE | RULE_EXECUTION) in `positions`.
- **Aber:** kein Trailing-Stop, kein Time-Stop (max. Haltedauer), OCO-
  Exklusivität (genau ein Exit bei parallelen Ticks) nicht explizit belegt,
  Stop-Parametrisierung (Trailing-Activation/Return) nicht konfigurierbar.

## Delta

1. Trailing-Stop (Activation-Gewinn %, Rückgabeweg %), Zustand crash-safe in
   der DB (kein Memory-Only), Update im Monitor-Tick.
2. Time-Stop (max. Haltedauer je Position, konfigurierbar, Default aus),
   neue `exitReason`-Werte dokumentiert.
3. OCO/Bracket-Semantik: SL/TP komplementär, **genau ein** Exit auch bei
   Race (idempotente Ticks), Audit je Trigger.
4. Alle Schwellen über Konfiguration mit Bounds; Live-Gate/Order-Mapping
   wird nicht angetastet (Paper-only-Fokus).

## Akzeptanzkriterien (kurz)

Trailing-Aktivierung/Nachzug/Restart-Persistenz-Tests, Time-Stop-Test,
Race-Test (2 parallele Ticks → genau 1 Exit), Audit-Assertions.
