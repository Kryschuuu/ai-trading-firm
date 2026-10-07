# Beta-Status — was diese Phase beendet und was nicht

> **Kanonische Zusage des Projekts.** Diese Datei ist verbindlich. Kein Audit,
> keine Roadmap und kein Release beendet die Beta-Phase durch sich selbst.

**Status:** **BETA — nicht produktionsreif**
**Gilt ab:** `v0.1.0` (2026-09-23), unverändert für alle `v0.x.x`
**Nächste Review:** siehe [§5](#6-review-kadenz)

---

## 1. Die Zusage in einem Satz

> **Selbst nach vollständiger Umsetzung der Strategie-Roadmap
> (`docs/audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`, 32 Prompts,
> Phasen 0–7) bleibt dieses Projekt in der Beta-Phase.**

Das ist keine Höflichkeitsfloskel, sondern eine **technische** Aussage: Die Roadmap
liefert die **Werkzeuge**, um Produktionsreife zu *prüfen*. Sie liefert keinen der
**Nachweise**, die für Produktionsreife nötig sind. Wer die Roadmap abgeschlossen
hat, hat das Messgerät gebaut — nicht die Messung.

## 2. Was die Roadmap liefert — und was nicht

| Die Roadmap liefert | Die Roadmap liefert **nicht** |
| --- | --- |
| `StrategyTemplate` als versioniertes Artefakt | Einen Nachweis, dass eine dieser Strategien Geld verdient |
| Candidate Matrix (Strategie × Markt × Timeframe) | Eine Aussage über Robustheit **über** Marktregimen und **über** Jahre |
| `StrategyValidationReport` mit deterministischen Gates | Ein gültiges `PASS` — die Gates sind **Filter**, kein Orakel |
| Walk-Forward, Monte-Carlo, Cost-Stress (bestehende + neue Auswertung) | Entropy gegen Mehrfach-Testung über viele Läufe hinweg |
| Validator-Agent (erklärt, entscheidet **nicht**) | Eine Live-Tauglichkeit |
| Copy-Trading, **ausschließlich** `SIMULATE_ONLY` | Einen Live-Pfad, ein Broker-Mandat, eine Rechtsprüfung |
| O(n)-Backtestpfad, strukturierte Screening-Jobs | Beweislast für historische Performance |

**Kern:** Jedes dieser Werkzeuge erzeugt entweder ein `FAIL`, ein `INCONCLUSIVE` oder
eine **begründete Ablehnung** einer Strategie. Das ist der Normalfall. Eine Pipeline,
die ausschließlich `PASS` produziert, ist kaputt — nicht erfolgreich.

## 3. Beta-Exit-Kriterien

Produktionsreife wird **nicht** durch eine Roadmap, sondern durch acht Kriterien
erklärt. Jedes verlangt **externe Evidenz**, nicht interne Werkzeuge.

| # | Kriterium | Was es verlangt | Status |
| --- | --- | --- | --- |
| **B1** | **Out-of-Sample-Performance** | Mindestens eine Strategie, die über ≥ 12 Monate **Live-Paper** (nicht Backtest) nach Kosten, Slippage und Partial Fills positive Netto-Rendite mit dokumentierter Maximal-Drawdown-Historie zeigt | offen |
| **B2** | **Regime-Abdeckung** | Dieselbe Strategie in ≥ 3 von 5 `MarketRegime`-Klassen profitable OOS-Segmente, nicht nur im Durchschnitt | offen |
| **B3** | **Live-Readiness-Audit** | Ein **eigenständiges** Audit nach `docs/peer-reviews/2026-08-26-live-trading-readiness/`-Schema, gegen realen Venue-Verkehr, mit echten Fills und Reconciliation über ≥ 8 Wochen | offen |
| **B4** | **Security** | Kein offenes `CRITICAL`/`HIGH`-Finding über zwei aufeinanderfolgende vollständige Audits; kein offener Auth-/Secret-Befund | offen |
| **B5** | **Compliance** | Schriftliche Rechtsprüfung des konkreten Betriebs (Verwaltung fremder Vermögen, Vermarktung von Handelssignalen, Steuer). **Für das Copy-Trading-Modul zwingend vor jedem Live-Betrieb** — das ist nicht Teil dieses Repos | offen |
| **B6** | **Betriebsreife** | Backup/Restore **nachweislich** getestet, Monitoring-Alarme mit Response-Zeit, Incident-Runbook, Kill-Switch im Produktivbetrieb verifiziert | offen |
| **B7** | **Unabhängige Drittprüfung** | Review der Strategie-, Risk- und Execution-Logik durch eine Person, die sie **nicht** geschrieben hat. Modelle derselben Pipeline zählen ausdrücklich **nicht** als unabhängig | offen |
| **B8** | **Haftungsrahmen** | Bewusste Entscheidung des Betreibers, mit eigenem Kapital und erkanntem Risiko zu handeln — dokumentiert, nicht unterstellt | offen |

### 3.1 Was ausdrücklich **nicht** als Ersatz gilt

| Nicht ausreichend | Warum nicht |
| --- | --- |
| Ein grüner `StrategyValidationReport` | Gates filtern, sie widerlegen nicht. `PASS` heißt „keine bekannte Schwäche im geprüften Fenster" |
| Ein `PASS` über sechs Templates | Sechs geprüfte Strategien sind sechs Stichproben, kein Portfolio-Nachweis |
| Ein Monte-Carlo mit 1 000 Pfaden | Sim-Präzision auf einer Trade-Folge, die möglicherweise nicht repräsentativ ist |
| Ein Agent, der „robust" sagt | Der Agent darf per Architektur **kein** `result` setzen — siehe `STX-05` und `STX-17` |
| Ein bestandener Live-Gate-Test | Das Gate beweist, dass Schalter **funktionieren**, nicht, dass die Strategie **trägt** |
| Ein Security-Audit ohne offene Findings | Sicherheit ist eine Voraussetzung, kein Ersatz für B1/B2 |

### 3.2 Die Reihenfolge ist bindend

```
B4 Security  ──┐
B6 Betrieb    ─┼──▶ ALLE VORAUSSETZUNGEN ──▶ B7 Drittprüfung
B5 Compliance ─┘                                   │
                                                    ▼
                                    B1 OOS ──▶ B2 Regime ──▶ B3 Live
                                                    │
                                                    ▼
                                                 B8 Haftung
```

Ein Beta-Exit **ohne** B7 gilt nicht. Die Prüfung, die das System selbst über sich
ausführt, ist per Konstruktion kein unabhängiges Urteil — das ist kein Versehen,
sondern die Grenze jedes selbst-prüfenden Systems.

## 4. Was in der Beta erlaubt ist

| Erlaubt | Bedingung |
| --- | --- |
| Paper-Trading des eigenen Kontos | unveränderter Auslieferungszustand |
| Backtesting, Screening, Forschung | Datenqualität dokumentiert |
| Lernen, Lehren, Evaluierung | keine Gewinnzusage |
| Eigene Code-Änderungen und Forks | GPL-3.0-only beachten |

## 5. Was in der Beta **verboten** ist

| Verboten | Begründung |
| --- | --- |
| Verwaltung fremder Vermögen | `B5` nicht erfüllt |
| Entgeltliches Vermarkten von Signalen | `B5` nicht erfüllt |
| Betrieb mit Fremdkapital | `B8` nicht erfüllt |
| Copy-Trading außerhalb `SIMULATE_ONLY` | `B5` nicht erfüllt, `STX-16` |
| Behauptung einer Profitabilität | `B1`/`B2` nicht erfüllt |
| Entfernen des Beta-Disclaimers ohne `B1…B8` | Positionsänderung, keine Codeänderung |

## 6. Review-Kadenz

| Trigger | Aktion |
| --- | --- |
| Jeder `v0.x.x`-Release | `BETA_STATUS.md` auf Aktualität prüfen; Kriterienstatus fortschreiben |
| Jedes abgeschlossene Audit | Prüfen, ob es ein Kriterium berührt — **nur belegen, nie automatisch erfüllen** |
| Jeder Roadmap-Meilenstein | Bestätigen, dass die Phase **kein** Kriterium erfüllt hat — sonst ist sie falsch gebaut |
| Halbjährlich | Vollständige Neubewertung `B1…B8` |

**Regel gegen Selbsttäuschung:** Ein Kriterium gilt nur als erfüllt, wenn ein
**externes** Artefakt es belegt (Bericht, Protokoll, Laufprotokoll eines Dritten).
Ein internes Dokument, ein Testlauf oder ein LLM-Urteil belegt es **nicht**.

## 7. Bezug zur Roadmap

| Roadmap-Phase | Berührt welches Kriterium | Kriterium erfüllt? |
| --- | --- | --- |
| 0 — Messung & ADRs | — | nein |
| 1 — Timeframe-Abdeckung | — | nein |
| 2 — Indikator-Grundlage | — | nein |
| 3 — Template-Kern | Instrument für `B2` | **nein** |
| 4 — Versionierte Persistenz | Instrument für `B1` (Reproduzierbarkeit) | **nein** |
| 5 — Candidate Matrix | Instrument für `B1`/`B2` | **nein** |
| 6 — Validator | Instrument für `B1`/`B2` | **nein** |
| 7 — Copy-Trading (Paper) | Instrument für `B5` (Fragestellung sichtbar machen) | **nein** |

**Alle acht Phasen (0–7) erfüllen kein einziges Kriterium.** Das ist die beabsichtigte
Lesart des Ausbaudokuments: Es liefert die Infrastruktur, um die Frage
„Ist das handelbar?" sauber zu stellen — die Antwort darauf ist eine andere
Art von Arbeit.

## 8. Grenzen dieser Datei

Diese Datei sagt **nicht**, wann die Beta endet. Sie sagt, was dafür **nötig** ist.
Die Entscheidung, ob die Kriterien erfüllt sind, trifft der Betreiber — nicht dieses
Repository, nicht ein Audit und nicht ein Modell.

---

## Verwandte Dokumente

- [`../README.md`](../README.md) — Projekt-README mit Beta-Disclaimer
- [`../VERSION.md`](../VERSION.md) — Versions-Metadaten
- [`../CHANGELOG.md`](../CHANGELOG.md) — Changelog (Keep a Changelog)
- [`audits/2026-09-29-strategy-template-ausbau/ROADMAP.md`](audits/2026-09-29-strategy-template-ausbau/ROADMAP.md) — die Roadmap, die **kein** Exit ist
- [`audits/2026-09-29-strategy-template-ausbau/report.md`](audits/2026-09-29-strategy-template-ausbau/report.md) — Audit-Bericht
- [`audits/2026-09-29-strategy-template-ausbau/findings/STX-16-copy-trading-compliance.md`](audits/2026-09-29-strategy-template-ausbau/findings/STX-16-copy-trading-compliance.md) — Copy-Trading & Haftung
- [`LIVE_TRADING.md`](LIVE_TRADING.md) — Live-Gate
- [`security/README.md`](security/README.md) — Security-Übersicht
