# Audit-Template — Vorlage für neuen Audit-Zyklus

> Diese Vorlage kopieren für jeden neuen Audit: `cp -r docs/audits/TEMPLATE docs/audits/YYYY-MM-DD-<quelle>-<name>`

## Metadaten

- **Datum:** YYYY-MM-DD
- **Quelle:** Security-Review / Peer-Review / Scanner / External / Internal
- **Reviewer:** Name / Tool / Firma
- **Scope:** Welche Bereiche wurden geprüft? (z. B. `src/lib/auth`, `src/app/api/*`, Dependencies)
- **Branch/Commit:** Auf welchem Stand basiert der Audit?
- **Original-Dokument:** `assets/<original>.pdf` (falls vorhanden)
- **Status:** OPEN | IN_PROGRESS | CLOSED

## Severity-Übersicht

| Severity | Anzahl | Offen | In Arbeit | Gefixt |
|----------|--------|-------|-----------|--------|
| CRITICAL | 0 | 0 | 0 | 0 |
| HIGH | 0 | 0 | 0 | 0 |
| MEDIUM | 0 | 0 | 0 | 0 |
| LOW | 0 | 0 | 0 | 0 |
| INFO | 0 | 0 | 0 | 0 |

## Findings-Index

| ID | Titel | Severity | Status | Fix-Version |
|----|-------|----------|--------|-------------|
| SEC-01 | Beispiel: Privilege Escalation | CRITICAL | OPEN | - |

Siehe `findings/` für Details und `remediation/TRACKING.md` für Status-Tracking.

## Executive Summary

Hier die Zusammenfassung aus dem Original-Audit einfügen (1-2 Absätze). Was wurde geprüft, was ist das Fazit?

## Remediation-Plan

Grober Plan in welcher Reihenfolge Findings behoben werden sollten (z. B. Critical zuerst, dann High).

## Referenzen

- Original-PDF: `assets/`
- Verwandte Peer-Reviews: `../../peer-reviews/...`
- Security-Übersicht: `../../security/README.md`
