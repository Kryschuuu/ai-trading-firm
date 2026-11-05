# Eigenständige Arena-Umsetzungs-Prompts (Quelle: Big Pickle)

Dieses Verzeichnis enthält **10 produktionsreife, eigenständig ausführbare
Arena-Prompts** — je einen pro Befund aus
[`../README.md`](../README.md). Jeder Prompt wiederholt Repository-Kontext,
verifizierten Ausgangszustand, verbindlichen Scope, Produktions-/Sicherheits-
regeln, Pflicht-Tests, Akzeptanzkriterien sowie Doku-, SemVer-, Tracking-,
Commit- und PR-Pflichten.
[`PROMPT-00-baseline.md`](PROMPT-00-baseline.md) dient als serienweite
Reviewer-Checkliste und wird als Referenz vor Vorlage eines jeden PRs geprüft.

## Benutzung

1. **Genau ein Prompt pro PR** übernehmen (Ausnahme: explizit verknüpfte
   Slices wie BP-03/BP-04, die gemeinsam released werden können).
2. Vor Implementierung den **aktuellen** Code prüfen. Die verifizierte
   Audit-Basis ist `7d8b07b` (`v1.51.3`), nicht zwangsläufig der spätere Stand.
   Bei Abweichung Absicht mit minimalem Scope übernehmen und Abweichung im PR
   vermerken.
3. Auf `arena/*`-Branchen arbeiten (aktivieren die CI-Vorvalidierung).
4. Das zugehörige Finding und
   [`../remediation/TRACKING.md`](../remediation/TRACKING.md) erst bei belegter
   Definition of Done (PR, Commit, Tests, Fix-Version) auf `FIXED` setzen.
5. Bei Scopeänderungen Finding/Prompt versioniert anpassen, statt still vom
   Akzeptanzvertrag abzuweichen.

## Empfohlene Reihenfolge und Abhängigkeiten

| Welle | Prompt | Zweck / Voraussetzung |
|---:|---|---|
| 1 | [BP-01 Regel-Felder](PROMPT-BP-01-rule-field-indikatoren.md) | erweitert `RULE_FIELDS`/`RuleSnapshot` + `macd()` — Basis für Konfluenz-Regeln |
| 1 | [BP-08 Yahoo-Historik](PROMPT-BP-08-yahoo-historik.md) | füllt die Datenbasis für Regel-Backtests (EQUITIES/INDICES/FX) |
| 2 | [BP-02 Technical-Analyst](PROMPT-BP-02-technical-analyst-berechnete-daten.md) | konsumiert BP-01-Snapshot-Felder (danach ausführen) |
| 2 | [BP-06 Kosten + Benchmark](PROMPT-BP-06-backtest-kosten-und-benchmark.md) | belastbare Zahlen für BP-03/BP-05 |
| 2 | [BP-05 Exit-Konsistenz](PROMPT-BP-05-backtest-live-exit-konsistenz.md) | Replay nutzt `decideExit()`; Ausgabe fließt in BP-03-UI |
| 3 | [BP-07 ATR-Stops](PROMPT-BP-07-atr-stops-in-regeln.md) | `RuleAction`/`RULE_CEILINGS` im selben Modul wie BP-01 |
| 3 | [BP-03 Workshop-Backtest](PROMPT-BP-03-workshop-backtest-bruecke.md) | TOP-Gate; konsumiert BP-06- und BP-08-Ergebnisse |
| 3 | [BP-04 Workshop-Lernpfad](PROMPT-BP-04-workshop-baseline-prompt-preview.md) | UI-Erweiterung; unabhängig, gemeinsam mit BP-03 released |
| 4 | [BP-09 FRED-Makro](PROMPT-BP-09-fred-makro-feed.md) | eigenständiges vertikales Slice |
| 4 | [BP-10 Datenquellen](PROMPT-BP-10-datenquellen-integration.md) | Evaluation + erste env-gated Integration |

## Abhängigkeitsregeln

- Liegt die Voraussetzung eines Folgewerts noch offen, darf der Folgewert eine
  kleine typisierte Schnittstelle vorbereiten, aber **nicht** das
  vorgelagerte Finding im selben PR abschließen.
- BP-03 ist das fachliche TOP-Gate, aber fachlich **nach** BP-06/BP-08
  sinnvoll: Ein Regel-Backtest ohne Kostenmodell und ohne Datenbasis wäre nur
  eine Metrik-Fassade.
- BP-02 soll nach BP-01 laufen; eine umgekehrte Reihenfolge verhindert nicht
  den Prompt, verschenkt aber die neuen Snapshot-Felder.
- BP-05 ist bewusst schmaler als RMA-P1-01 (Event-Replay); es darf keine
  zweite Exit-Entscheidungslogik erzeugen — einzige Quelle bleibt
  `decideExit()`.