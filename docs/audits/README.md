# Audits & Security Findings — Zentrale Verwaltung

> **Zweck:** Alle wiederkehrenden Code-Reviews, Audits und Security-Audits haben hier einen festen, wiederauffindbaren Platz. Das Schema skaliert — nicht nur für ein einzelnes PDF, sondern als wiederverwendbares System für zukünftige Audit-Zyklen.

## Warum diese Struktur?

Das Repository unterliegt **wiederkehrenden, aber unregelmäßigen** Reviews:
- Senior Peer-Reviews (Handelslogik, Control Plane, Broker)
- Security-Audits (Privilege Escalation, ungeschützte APIs, Dependencies)
- Scanner-Reports, Bug-Bounties, externe Audits

Ohne Struktur landen PDFs und Markdown-Reports im Root und erzeugen mehrere Wahrheiten. Mit dieser Struktur ist jeder Audit-Zyklus **chronologisch**, **nach Status** und **nach Finding** organisiert.

## Ordner-Schema

```
docs/audits/
├── README.md                    # Diese Datei — erklärt Workflow & Naming
├── TEMPLATE/                    # Kopiervorlage für neuen Audit
│   ├── README.md                # Audit-Metadaten (Datum, Scope, Severity-Übersicht)
│   ├── report.md                # Zusammenfassung / Executive Summary
│   ├── findings/                # Ein File pro Finding
│   │   └── FINDING-TEMPLATE.md
│   ├── remediation/
│   │   └── TRACKING.md          # Remediation-Status-Tabelle
│   └── assets/                  # Original-PDFs, Screenshots, Scanner-Logs
├── 2026-09-03-peer-review/      # Beispiel: Peer-Review-Audit Sep 2026
│   ├── README.md
│   ├── report.md
│   ├── findings/                # H1-H10, C1-C4, B1-B2, S1-S2, W1-W2
│   └── remediation/
│       └── SUMMARY.md
└── 2026-09-05-security-review-gpt01/  # Beispiel: Security-Audit Sep 2026
    ├── README.md
    ├── findings/                # SEC-01 … SEC-10 (siehe Audit-README)
    ├── remediation/
    │   └── TRACKING.md
    └── assets/
        └── Security-Review-GPT_01.pdf  # Original-PDF (falls vorhanden)
```

### Naming-Konvention

**Audit-Ordner:** `YYYY-MM-DD-<quelle>-<kurzname>`

- Datum = Audit-Datum (nicht Remediation-Datum)
- Quelle = `peer-review`, `security-review`, `scanner`, `external`, `internal`
- Kurzname = `gpt01`, `bitunix-execution`, `live-trading`, etc.

Beispiele:
- `2026-09-03-peer-review` — Senior Peer-Review (H1-H10 etc.)
- `2026-09-05-security-review-gpt01` — Security-Audit GPT_01 (SEC-01..SEC-10)
- `2026-10-12-scanner-dependabot` — Dependabot-Scan
- `2027-01-15-external-trailofbits` — Externer Audit

**Finding-Dateien:** `<ID>-<slug>.md`

- ID = Original-ID aus dem Audit (z. B. `H1`, `C2`, `SEC-01`)
- Slug = kurzer kebab-case Titel (`privilege-escalation`, `risk-notional`)

**Warum chronologisch, nicht nach Status?**

- **Chronologisch** als Primärschlüssel: Audits sind Ereignisse — sie haben ein Datum und eine Quelle. Das macht sie eindeutig und sortierbar.
- **Status** als Sekundärdimension: Innerhalb eines Audit-Ordners gibt es `remediation/TRACKING.md` mit einer Tabelle `ID | Severity | Status | Fix-Version | PR`.
- So kann man sowohl "Was wurde im September 2026 gefunden?" als auch "Welche Findings sind noch offen?" beantworten.

## Workflow für neuen Audit

### 1. Template kopieren

```bash
NEW="2026-10-20-security-review-gpt02"
cp -r docs/audits/TEMPLATE docs/audits/$NEW
```

### 2. Metadaten ausfüllen

In `docs/audits/$NEW/README.md`:
- Datum, Reviewer, Scope, Branch
- Severity-Übersicht (Critical/High/Medium/Low)
- Link auf Original-PDF in `assets/`

### 3. Findings extrahieren

Für jedes Finding aus dem PDF ein File in `findings/`:

```markdown
# SEC-05 — Titel

- **Severity:** CRITICAL | HIGH | MEDIUM | LOW
- **Bereich:** Auth / API / Dependencies / Handelslogik / ...
- **Quelle:** Security Review GPT_01, Seite 12
- **Status:** OPEN | IN_PROGRESS | FIXED | WONTFIX | FALSE_POSITIVE
- **Fix-Version:** v1.36.xx (falls gefixt)
- **Datei(en):** src/...
```

Inhalt:
- **Beschreibung** (aus PDF)
- **Beweis** (Code-Auszug, PoC)
- **Remediation** (aus PDF + eigene Bewertung)
- **Akzeptanzkriterien / Tests**

### 4. Tracking-Tabelle pflegen

In `remediation/TRACKING.md`:

| ID | Severity | Status | Fix-Version | PR | Notizen |
|----|----------|--------|-------------|----|---------|
| SEC-01 | CRITICAL | FIXED | v1.36.26 | #106 | Privilege Escalation in ... |

### 5. Verknüpfung mit Peer-Review-Patches

Wenn ein Finding einen Patch-Vorschlag aus einem Peer-Review hat, verlinke in `findings/SEC-01-...md`:

```markdown
**Peer-Review-Patch:** [PATCH-001](../peer-reviews/2026-08-26-live-trading-readiness/patches/PATCH-001-macro-micro-separation.md)
```

Und umgekehrt im Patch-File zurück auf das Finding.

### 6. Doku-Index aktualisieren

In `docs/README.md` den neuen Audit in die Tabelle eintragen.

## Verknüpfung mit anderen Bereichen

- **Peer-Review-Patches:** `docs/peer-reviews/<datum>-<thema>/patches/` enthält Patch-Vorschläge, die auf Findings in `docs/audits/` verweisen.
- **Security-Übersicht:** `docs/security/README.md` aggregiert alle offenen Critical/High Findings über alle Audits.
- **CHANGELOG:** Jeder Fix referenziert die Finding-ID (z. B. `SEC-01`) und die Audit-Quelle.
- **CI:** `scripts/docs-validate.ts` prüft, dass alle Links in `docs/audits/` auf existierende Dateien zeigen und dass `remediation/TRACKING.md` konsistent ist.

## Status-Modell

Jedes Finding hat einen Status:

- **OPEN** — Gefunden, noch nicht bearbeitet
- **IN_PROGRESS** — Fix in Arbeit (Branch `arena/...`)
- **FIXED** — Gefixt, mit Version und PR belegt
- **WONTFIX** — Bewusst nicht gefixt, mit Begründung
- **FALSE_POSITIVE** — Kein echtes Problem, mit Begründung

Die `remediation/TRACKING.md` ist die **einzige Wahrheit** für den Status — nicht verstreute Kommentare in PDFs.

## Archivierung

Abgeschlossene Audits (alle Findings FIXED/WONTFIX/FALSE_POSITIVE) bleiben im Ordner — sie sind historisch wertvoll. Ein Audit wird nie gelöscht, nur als `Status: CLOSED` in `README.md` markiert.

## Fragen & Antworten

**Chronologisch oder nach Status organisieren?**
Chronologisch als Primärschlüssel, Status als Sekundärdimension in `TRACKING.md`. So bleibt die Historie erhalten und man kann trotzdem nach offen/geschlossen filtern.

**Naming-Konvention für Findings?**
Original-ID aus dem Audit beibehalten (z. B. `SEC-01`), plus slug. Keine Umbenennung in eigenes Schema — das erschwert das Mapping zurück zum PDF.

**Wie Peer-Review-Patches mit Audit-Finding verknüpfen?**
Bidirektionale Links: Finding → Patch und Patch → Finding. Patch-Dateien liegen in `docs/peer-reviews/<audit>/patches/` und enthalten Frontmatter mit `related_findings: [SEC-01]`.

**Was mit PDFs?**
Original-PDFs in `assets/` ablegen, nie im Root. In `README.md` und `report.md` darauf verlinken. PDFs sind Binärdateien — sie werden nicht im Git diff angezeigt, deshalb immer zusätzlich eine `report.md` mit extrahierten Findings pflegen.
