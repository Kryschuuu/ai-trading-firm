---
id: PATCH-002
title: DB-Locks im Legacy-Pfad
related_findings:
  - H2-atomicity
audit: 2026-09-03-peer-review
status: IMPLEMENTED
version: v1.36.19
---

# PATCH-002 — DB-Locks im Legacy-Pfad

**Related Finding:** [H2](../../../audits/2026-09-03-peer-review/findings/H2-atomicity.md)  
**Status:** IMPLEMENTED (v1.36.19)

## Problem

Legacy-Engine ohne DB-Advisory-Lock — doppelte Orders bei parallelen Requests.

## Lösung

- Tabelle `order_intents` mit partiellem UNIQUE-Index
- `submitAtomic()` mit `pg_advisory_xact_lock`
- DB als Quelle der Wahrheit
