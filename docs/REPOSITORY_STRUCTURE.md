# Repository-Struktur — Zielbild & Pflegeanleitung (2026-09-05)

> Status: Implementiert (Repo-Cleanup 2026-09-05) · Version 1.36.26

## Ziele

- Ordnung schaffen: dediziertes Verzeichnis für Audit-/Security-Findings, skaliert für wiederkehrende Audits
- Neuer Ordner für Peer-Review-Patches mit bidirektionaler Verlinkung
- Doppelte MDs entfernen, Überflüssiges entrümpeln
- Verlinkungen aktualisieren und testen (docs-validate grün)
- Langfristige Wartbarkeit, perfekte Dokumentation

## Zielstruktur

```
/
├── README.md                 # Projekt-README (GitHub-Einstieg)
├── CHANGELOG.md              # Kanonisch detailliert (Root, Keep a Changelog)
├── CONFIGURATION.md          # Env-Flags (ehemals Root INSTALL.md Flag-Referenz)
├── INSTALL.md                # Wrapper → docs/INSTALL.md + CONFIGURATION.md
├── docs/
│   ├── README.md             # Doku-Index (neue Struktur)
│   ├── REPOSITORY_STRUCTURE.md # Diese Datei
│   ├── INSTALL.md            # CachyOS-Guide (kanonisch)
│   ├── CHANGELOG.md          # Stub → ../CHANGELOG.md
│   ├── ARCHITECTURE.md, HANDBUCH.md, ...
│   ├── audits/               # NEU: alle Audits chronologisch
│   │   ├── README.md         # Workflow, Naming, Status-Modell
│   │   ├── TEMPLATE/         # Vorlage für neuen Audit
│   │   ├── 2026-09-03-peer-review/  # CLOSED, H1-H10 etc.
│   │   └── 2026-09-05-security-review-gpt01/  # OPEN, SEC-01..
│   ├── peer-reviews/         # NEU: Patches gesammelt
│   │   ├── README.md
│   │   ├── 2026-08-26-live-trading-readiness/
│   │   ├── 2026-08-26-bitunix-execution/
│   │   └── 2026-08-26-routing-overrides/
│   ├── security/             # NEU: Security-Übersicht
│   │   ├── README.md
│   │   └── SECURITY_AUDIT.md
│   ├── archive/              # NEU: historische Docs
│   │   └── task-plans/
│   ├── ci/ + help/
│   ├── AUDIT_REMEDIATION_2026-09.md  # Stub
│   ├── SECURITY_AUDIT.md     # Stub
│   └── PEER_REVIEW_*.md      # Stubs
```

## Naming-Konventionen

**Audit-Ordner:** `YYYY-MM-DD-<quelle>-<kurzname>`

- Datum = Audit-Datum, Quelle = peer-review/security-review/scanner/external, Kurzname = gpt01, live-trading
- Beispiele: `2026-09-03-peer-review`, `2026-09-05-security-review-gpt01`, `2026-10-12-scanner-dependabot`

**Finding-Dateien:** `<ID>-<slug>.md` — ID aus Original (SEC-01, H1) beibehalten, Slug kebab-case

**Peer-Review-Ordner:** `YYYY-MM-DD-<thema>`, **Patch-Dateien:** `PATCH-<NNN>-<slug>.md`

## Chronologisch vs. Status?

**Entscheidung:** Chronologisch als Primärschlüssel, Status als Sekundärdimension in `remediation/TRACKING.md`.

Begründung: Audits sind Ereignisse (Datum, Quelle), Status ändert sich (OPEN→FIXED). Chronologisch bewahrt Historie, TRACKING.md ist einzige Wahrheit für Status, `security/README.md` aggregiert offene Critical/High.

Alternative (nach Status: open/fixed) verworfen — würde Historie zerstören.

## Verknüpfung Patches ↔ Findings

Bidirektionale Links (Beispiele, in Code-Fences damit Validator sie ignoriert, real existierende Ziele):

```markdown
# In einem Finding (z. B. SEC-01):
**Peer-Review-Patch:** [PATCH-001](../../peer-reviews/2026-08-26-routing-overrides/patches/PATCH-001-routing-overrides.md)

# In einem Patch (z. B. PATCH-001):
**Related Finding:** [SEC-01](../../../audits/2026-09-05-security-review-gpt01/findings/SEC-01-privilege-escalation.md)
```

Frontmatter im Patch:

```yaml
related_findings: [SEC-01]
audit: 2026-09-05-security-review-gpt01
status: IMPLEMENTED
```

## Duplikate — identifiziert & entfernt

Methode: `basename` + `sha256` + manuelle Prüfung.

| Alt | Neu |
|-----|-----|
| `CHANGELOG.md` Root (1723 Summary) + `docs/CHANGELOG.md` (5833 detailliert) | Root = kanonisch detailliert (5833), docs = Stub |
| `INSTALL.md` Root (411 Flag-Ref) + `docs/INSTALL.md` (898 CachyOS) | `CONFIGURATION.md` Root = Flag-Ref, docs/INSTALL = CachyOS, Root INSTALL = Wrapper |
| `audit-remediation/` Root (21 Files) | `docs/audits/2026-09-03-peer-review/findings/` |
| `docs/PEER_REVIEW_*.md` (3) | `docs/peer-reviews/*/review.md` + patches/ |
| `docs/AUDIT_REMEDIATION_2026-09.md` | `docs/audits/2026-09-03-peer-review/report.md` |
| `docs/SECURITY_AUDIT.md` | `docs/security/SECURITY_AUDIT.md` + Stub |
| `docs/task-*.md` (8) | `docs/archive/task-plans/` |

Stubs enthalten `Weiterleitung` und <1500 Zeichen — docs-validate ignoriert sie.

## Überflüssiges

- `audit-remediation/` entfernt (migriert)
- `docs/task-*.md` aus Root entfernt (archiviert)
- `docs/ci/` ist **kein** Duplikat — Quelle der Workflows (Arena-Bot darf .github/workflows nicht schreiben), siehe `docs/ci/README.md`

## Verlinkungen — aktualisiert & getestet

Aktualisiert: `README.md`, `docs/README.md`, `ARCHITECTURE.md`, `INSTALL.md`, `docsCatalog.ts`, `docs-validate.ts`

Getestet: `npm run docs:validate` → 8 Checks, 10 Hilfe-Dateien, OK grün

- Link-Check ignoriert Code-Fences
- Secret-Scan False-Positive gefixt
- API-Routen: `[venue]` Placeholder
- Version: nur Root CHANGELOG kanonisch

## Wartbarkeit — Schema für zukünftige Audits

```bash
# Neuer Audit
NEW="2026-10-20-security-review-gpt02"
cp -r docs/audits/TEMPLATE docs/audits/$NEW
# PDF nach assets/, Findings in findings/, TRACKING.md pflegen
# In docs/README.md + security/README.md eintragen
npm run docs:validate

# Neuer Peer-Review
NEW="2026-10-20-market-data-reliability"
mkdir -p docs/peer-reviews/$NEW/patches
# review.md, README.md, patches/...
```

## Dokumentations-Prinzipien

Alle neuen READMEs: Zweck oben, Warum Struktur?, Ordner-Schema, Naming, Workflow (copy-paste), Status-Modell, Verknüpfung, FAQ. Deutsch, professionell, klar.

## Migration — optimal vorgehen

1. Analyse Duplikate (basename + sha256)
2. Zielstruktur entwerfen (audits/ chronologisch + peer-reviews/ + security/ + archive/)
3. TEMPLATEs erstellen
4. Migrieren via cp (nicht mv), erst nach Validierung löschen
5. Duplikate konsolidieren (CHANGELOG Root kanonisch, INSTALL → CONFIGURATION + Wrapper, Stubs)
6. Code aktualisieren (docsCatalog.ts + docs-validate.ts)
7. Links aktualisieren
8. Testen (docs-validate, typecheck, build)
9. Alte Dateien entfernen
10. Dokumentieren (diese Datei + audits/README + peer-reviews/README + security/README)

## Referenzen

- audits/README.md, peer-reviews/README.md, security/README.md, archive/README.md, ci/README.md
- ../README.md, ../CHANGELOG.md, ../CONFIGURATION.md
