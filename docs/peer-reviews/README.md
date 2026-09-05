# Peer-Review-Patches — Zentrale Sammlung

> **Zweck:** Patch-Vorschläge aus Peer-Reviews werden hier gesammelt und nachvollziehbar zugeordnet. Jeder Patch verlinkt auf das zugehörige Audit-Finding in `docs/audits/` und umgekehrt.

## Warum diese Struktur?

Peer-Reviews produzieren oft konkrete Patch-Vorschläge (z. B. "trenne Paper- und Live-Engine", "härte RBAC"). Ohne Struktur landen sie als lose Markdown-Files im `docs/`-Root (`PEER_REVIEW_*.md`) und sind schwer auffindbar. Mit dieser Struktur ist jeder Review **chronologisch** organisiert und enthält seine Patches.

## Ordner-Schema

```
docs/peer-reviews/
├── README.md
├── 2026-08-26-live-trading-readiness/
│   ├── README.md                # Metadaten + Zusammenfassung
│   ├── review.md                # Original-Review (aus PEER_REVIEW_LIVE_TRADING.md)
│   └── patches/
│       ├── PATCH-001-macro-micro-separation.md
│       └── PATCH-002-db-locks-legacy-path.md
├── 2026-08-26-bitunix-execution/
│   ├── README.md
│   ├── review.md                # aus PEER_REVIEW_BITUNIX_EXECUTION.md
│   └── patches/
│       └── PATCH-001-execution-port.md
└── 2026-08-26-routing-overrides/
    ├── README.md
    ├── review.md
    └── patches/
```

### Naming-Konvention

**Review-Ordner:** `YYYY-MM-DD-<thema>` (z. B. `2026-08-26-live-trading-readiness`)

**Patch-Dateien:** `PATCH-<NNN>-<slug>.md` (z. B. `PATCH-001-execution-port.md`)

**Frontmatter (empfohlen):**

```yaml
---
id: PATCH-001
title: ExecutionPort — Paper und Broker getrennt
related_findings:
  - B1-sl-tp-geometry
  - H8-bitunix-equity
audit: 2026-09-03-peer-review
status: IMPLEMENTED
version: v1.20.0
---
```

## Workflow für neuen Peer-Review

### 1. Ordner anlegen

```bash
NEW="2026-10-20-market-data-reliability"
mkdir -p docs/peer-reviews/$NEW/patches
```

### 2. Original-Review ablegen

Kopiere das Review-Dokument nach `review.md` und fülle `README.md` aus:

- Datum, Reviewer-Rolle, Scope, Branch
- Executive Summary
- Liste der Patch-Vorschläge mit Status

### 3. Patches extrahieren

Für jeden Vorschlag aus dem Review ein File in `patches/`:

- **Problem:** Was ist das Problem?
- **Lösung:** Konkreter Patch (Code-Skizze, Dateien)
- **Verknüpfung:** Link auf Finding in `docs/audits/<audit>/findings/<ID>-*.md`
- **Status:** PROPOSED | IMPLEMENTED | REJECTED
- **PR/Version:** Wo wurde es umgesetzt?

### 4. Bidirektionale Verlinkung

Im Finding in `docs/audits/` verlinken:

```markdown
**Peer-Review-Patch:** [PATCH-001](../../peer-reviews/2026-08-26-bitunix-execution/patches/PATCH-001-execution-port.md)
```

Und im Patch zurück (aus `patches/`-Ordner):

```markdown
**Related Finding:** [B1](../../../audits/2026-09-03-peer-review/findings/B1-sl-tp-geometry.md)
```

### 5. Doku-Index aktualisieren

In `docs/README.md` neuen Review eintragen.

## Status-Modell für Patches

- **PROPOSED** — Vorgeschlagen, noch nicht umgesetzt
- **IMPLEMENTED** — Umgesetzt, mit Version/PR belegt
- **REJECTED** — Bewusst nicht umgesetzt, mit Begründung
- **SUPERSEDED** — Durch anderen Patch ersetzt

## Verknüpfung mit Audits

- `docs/audits/<audit>/findings/<ID>.md` → `../../peer-reviews/<review>/patches/PATCH-*.md`
- `docs/peer-reviews/<review>/patches/PATCH-*.md` → `../../../audits/<audit>/findings/<ID>.md`

So bleibt nachvollziehbar, welcher Patch welches Finding behebt.

## Archivierung

Abgeschlossene Reviews bleiben — sie sind historisch wertvoll. Status `CLOSED` in `README.md`.
