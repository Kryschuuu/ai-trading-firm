# Implementierungs-Fahrplan — Audit „Verbesserungen“ (O1–O6, W1–W5, Datenquellen)

- **Datum der Prüfung:** 2026-09-23
- **Quelle:** Big-Pickle-Audit „verbesserungen“ (2026-09-20, im Auftrag als Text geliefert; die Datei `docs/audits/2026-09-20-big-pickle-verbesserungen/AUDIT.md` liegt in diesem Checkout nicht)
- **Prüfer:** Arena-Agent; Prüfung gegen `ba772cc`, Umsetzung in `v0.2.0`
- **Code-Stand der Prüfung:** `ba772cc` (`main`-Merge #173). Produktversion danach `v0.2.0`
- **Scope:** Strategie O1–O6, Workshop W1–W5, Datenquellen-Adapter, Arena-Prompts, die drei offenen AGENTS.md-Edits aus Abschnitt 7 des Audits
- **Status:** CLOSED in `v0.2.0` — 8 FIXED, 4 VERIFIED, Rest WONTFIX, 0 OPEN
- **SSoT des Status:** [`remediation/TRACKING.md`](remediation/TRACKING.md)
- **Befunde:** [`findings/README.md`](findings/README.md)
- **Umsetzungs-Prompts (nur FIXED):** [`prompts/README.md`](prompts/README.md)
- **Historische Empfehlung:** [`ROADMAP.md`](ROADMAP.md)

## Kurzfazit

Der Audit beschreibt den Stand vor den abgeschlossenen Zyklen
[GAP-01…10](../2026-09-18-feature-gap/README.md) und
[Roadmap-Audit](../2026-09-20-roadmap-audit/README.md). Von 18 geprüften
Vorschlägen sind **7 bereits erfüllt oder durch eine bessere Architektur
ersetzt**, **6 teilweise**, **5 offen und nur teilweise sinnvoll**. Die
Behauptung „O1 blockiert O2, O3 und O4“ ist im heutigen Code falsch.

Der nächste Schnitt war Kostenwahrheit im Quick-Backtest und danach
Workshop-Schritt 5 (nur `DRAFT`). Beides ist in `v0.2.0` umgesetzt.
`backtestRule` und der Engine-Default `"legacy"` sind unverändert.
