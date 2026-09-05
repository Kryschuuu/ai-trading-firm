---
id: PATCH-001
title: Makro/Mikro-Zyklus-Trennung
related_findings:
  - H2-atomicity
  - H7-live-kill
audit: 2026-09-03-peer-review
status: IMPLEMENTED
version: v1.6
---

# PATCH-001 — Makro/Mikro-Zyklus-Trennung

**Related Findings:** [H2](../../../audits/2026-09-03-peer-review/findings/H2-atomicity.md), [H7](../../../audits/2026-09-03-peer-review/findings/H7-live-kill.md)  
**Review:** [Live-Trading-Readiness](../review.md)  
**Status:** IMPLEMENTED (v1.6)

## Problem

Lineare 6-Agenten-Pipeline hat 2–6 Minuten Latenz — Marktpreise veraltet beim Executor.

## Lösung

- `macroCycle.ts`: CEO + Research → Regeln, 1×/h
- `microExecutor.ts`: WebSocket-Tick → kompilierte Regel → Paper-Fill, ~20–100 µs
- Verbunden nur über versioniertes Regelwerk in `trade_rules`

## Umsetzung

- `src/lib/macroCycle.ts`, `microExecutor.ts`, `ruleEngine.ts` neu
- `scripts/micro-executor.ts` eigener Prozess

## Tests

- `tests/microExecutor.test.ts`
