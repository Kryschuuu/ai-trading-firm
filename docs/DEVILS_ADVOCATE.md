# Devil’s Advocate (Strukturierte Falsifikationsrolle)

> **Status:** Produktionsreif · **Version:** `1.66.0` (`da1`) · **Audit-Referenz:** [`RMA-P3-03`](audits/2026-09-20-roadmap-audit/findings/RMA-P3-03-devils-advocate.md)

---

## 1. Übersicht & Zielsetzung

Der **Devil’s-Advocate-Agent** fungiert vor dem finalen Risikocommit als unabhängige, adversariale Kontrollinstanz. Seine explizite Aufgabe ist die **systematische Falsifikation** vorgeschlagener Investitionsthesen.

Während der reguläre Risk-Manager harte Ceilings prüft (Max Exposure, Correlation Clusters, Hebel, Stop-Loss Vorhandensein), untersucht der Devil’s Advocate die inhaltliche Plausibilität der Thesen:
- Identifikation blinder Flecken und fehlender Bestätigungsevidenz
- Formulierung konkreter, falsifizierbarer Marktbedingungen (Falsifikatoren)
- Explizite Modellierung von Verlustszenarien (Failure Modes wie Bulltraps, Liquidationskaskaden, Squeeze-Risiken)
- Deterministische Ableitung eines Disagreement-Scores und defensiver Aktionen

---

## 2. Sicherheitsmandat & Prompt-Härtung

1. **Untrusted Data Isolation:** Alle Eingaben (Trade Proposals, technische Indikatoren, News-Headlines, Makro-Scores) werden als untrusted data in geschützten Datenblöcken übergeben. Direkte Befehle oder Anweisungen innerhalb dieser Texte werden ignoriert.
2. **Keine autonome Orderausführung:** Der Devil’s Advocate kann niemals eigene Trades initiieren oder Orders am Broker platzieren.
3. **Rein defensive Aktionen:** Hoher Dissens kann das Risiko ausschließlich **reduzieren** (`SCALE_DOWN`), einen menschlichen Review erzwingen (`REQUIRE_HUMAN_REVIEW`) oder die Ausführung abbrechen (`REJECT`). Eine automatische Vergrößerung des Risikobudgets ist architektonisch unmöglich (Faktor $\le 1.0$).
4. **Fail-Closed bei Unsicherheit:** Fehlt belastbare Evidenz zur Entkräftung oder ist die Datenlage dünn, enthält sich der Agent explizit (`abstain: true`). Die Enthaltung wird dokumentiert, verändert das bestehende Risikomaß jedoch nicht stillschweigend.

---

## 3. Deterministisches Scoring (`da1`)

Der Disagreement-Score $S \in [0, 1]$ wird rein deterministisch auf Code-Ebene berechnet:

$$S = 0.6 \cdot \text{confidence} + 0.4 \cdot \text{severity} + \text{Bonus}_{\text{spezifisch}}$$

- $\text{confidence} \in [0, 1]$: Konfidenz des Agenten in seine Gegenargumente
- $\text{severity} \in [0, 1]$: Erwartetes Schadensausmaß bei Eintritt des Scheiterns
- $\text{Bonus}_{\text{spezifisch}}$: Bis zu $+0.10$ für konkrete, mehrfache Falsifikatoren und Failure Modes
- Bei Enthaltung (`abstain: true`) gilt strikt: $S = 0$

### Schwellenwerte und Aktionen:

| Disagreement $S$ | Aktion | Risikofaktor | Wirkung |
| :--- | :--- | :--- | :--- |
| $< 0.40$ | `NO_OP` | $1.0$ | Primärthese wird unverändert weitergegeben |
| $\ge 0.40$ | `SCALE_DOWN` | $0.50$ (konfig.) | Positionsgröße bzw. Risikobudget wird halbiert |
| $\ge 0.70$ | `REQUIRE_HUMAN_REVIEW` | $0.00$ | Freigabe gesperrt, manuelle Prüfung erforderlich |

Im **Shadow Mode** (`DEVILS_ADVOCATE_SHADOW=true`) werden alle Berechnungen und Loggings vollständig durchgeführt, die effektive Aktion bleibt jedoch `NO_OP` ($1.0$), um neue Modelle gefahrlos evaluieren zu können.

---

## 4. Konfiguration & Rollout

| Umgebungsvariable | Standard | Beschreibung |
| :--- | :--- | :--- |
| `DEVILS_ADVOCATE_ENABLED` | `true` | Schaltet den Step und die Falsifikation an/aus. |
| `DEVILS_ADVOCATE_SHADOW` | `false` | Aktiviert den Shadow Mode (Evaluation ohne Risikoeingriff). |
| `DEVILS_ADVOCATE_SCALE_DOWN_THRESHOLD` | `0.40` | Schwellenwert für Risikoskalierung (0.1..0.9). |
| `DEVILS_ADVOCATE_HUMAN_REVIEW_THRESHOLD` | `0.70` | Schwellenwert für Stop/Review (0.4..1.0). |
| `DEVILS_ADVOCATE_SCALE_DOWN_FACTOR` | `0.50` | Risikomultiplikator bei moderatem Dissens (0.1..0.9). |

---

## 5. API-Endpunkte & Artefakte

- **API:** `GET /api/firm/devils-advocate` — Liefert Konfiguration und die jüngste Falsifikationsanalyse.
- **Tages-Artefakt:** `data/cycles/daily-YYYY-MM-DD/07b-devils-advocate.json` — Enthält den maschinenlesbaren Output nach Schema `da1`.
- **Journal-Persistenz:** Im Decision Snapshot der Positionseröffnung wird das Ergebnis unter `versions.devilsAdvocate` revisionssicher abgelegt.
