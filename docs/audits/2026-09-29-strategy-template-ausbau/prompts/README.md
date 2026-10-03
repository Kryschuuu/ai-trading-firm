# Prompts — Audit 2026-09-29

32 Umsetzungs-Prompts in 8 Phasen (0–7) — **alle umgesetzt** — plus 5 Folge-Prompts in
**Phase 8** aus dem Abgleich 2026-10-03. Reihenfolge, Abhängigkeiten und Gates:
[`../ROADMAP.md`](../ROADMAP.md) · Abgleich:
[`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md).

| Phase | Prompts | Status |
|---|---|---|
| 0 — Messung | [00-01](PROMPT-STX-00-01-backtest-perf-baseline.md) [00-02](PROMPT-STX-00-02-strategy-stack-ssot.md) [00-03](PROMPT-STX-00-03-vokabular-adr.md) | ☑ (`v0.6.0` `5646a88`, `v0.6.1` `c1d0cf5`/`5e78500`) — Gate G0 erfüllt |
| 1 — Blocker | [01-01](PROMPT-STX-01-01-rule-timeframes.md) | ☑ (`v0.6.2` `a6f0d75`) — Gate G1, STX-01 behoben |
| 2 — Indikatoren | [02-01](PROMPT-STX-02-01-indikatoren.md) [02-02](PROMPT-STX-02-02-bollinger-felder.md) [02-03](PROMPT-STX-02-03-donchian-feld.md) [02-04](PROMPT-STX-02-04-featurestore-rule-slice.md) | 02-01 ☑ (`v0.6.3` `ab40863`), 02-02 ☑ (`v0.6.4` `e1768b4`), 02-03 ☑ (`v0.6.5` `36b2829`), 02-04 ☑ (optional, `7995822` `rule.*@1` — `rule.bb_zscore`/`price_vs_upper_bb_pct`/`donchian_breakout_pct`, `docs/FEATURE_STORE.md` §3.2, `tests/ruleFeatureStoreParity.test.ts`) — Phase 2 vollständig, STX-10 umgesetzt |
| 3 — Templates | [03-01](PROMPT-STX-03-01-template-types.md) [03-02](PROMPT-STX-03-02-catalog.md) [03-03](PROMPT-STX-03-03-template-ema-adx.md) [03-04](PROMPT-STX-03-04-template-macd.md) [03-05](PROMPT-STX-03-05-template-rsi.md) [03-06](PROMPT-STX-03-06-template-bollinger.md) [03-07](PROMPT-STX-03-07-template-vwap.md) [03-08](PROMPT-STX-03-08-template-donchian.md) [03-09](PROMPT-STX-03-09-compiler.md) [03-10](PROMPT-STX-03-10-template-tests.md) | 03-01/03-02 ☑ (`v0.7.0` `f34e917`/`67ab7a1`), 03-03 ☑ (`v0.7.1` `d8025b8`), 03-04 ☑ (`v0.7.2` `1024c81`), 03-05 ☑ (`v0.7.3` `7f92d3c`), 03-06/03-07/03-08 ☑ (`v0.7.4` `b263858`/`b57cd94`/`9e5e4f3`), 03-09 ☑ (`v0.7.5` `be683b3` — STX-05 behoben), 03-10 ☑ (`v0.7.6` `82d00ae` — 60 Tests, `docs/STRATEGY_TEMPLATES.md`, Gate G3) — Phase 3 abgeschlossen |
| 4 — Persistenz | [04-01](PROMPT-STX-04-01-strategy-persistenz-migration.md) [04-02](PROMPT-STX-04-02-strategy-service.md) | 04-01 ☑ (`v0.8.0` `7f28e82` PR #201 — `strategy_definitions`/`strategy_versions`), 04-02 ☑ (`v0.10.4` `66be0c6` PR #202, Fix `9d73aeb` PR #203 — Service + Lifecycle-Bridging, `stv1:`/`stc1:`, `STRATEGY_CLASSES` aus SSoT) — STX-06 behoben, Gate G4 erfüllt |
| 5 — Screening | [05-01](PROMPT-STX-05-01-screening-types.md) [05-02](PROMPT-STX-05-02-matrix-builder.md) [05-03](PROMPT-STX-05-03-screening-persistenz.md) [05-04](PROMPT-STX-05-04-screening-cli.md) | 05-01 ☑ (`v0.9.0`-Vorstufe `a90fa62` PR #204), 05-02 ☑ (`4267715` PR #205), 05-03 ☑ (Unreleased auf `v0.8.0` / `v0.9.0`-Vorstufe `211e022` PR #206 — `ssr1:`/`ssm1:`), 05-04 ☑ (`v0.9.0` `c797ae7` PR #207 — `runScreening()`, `runMultiAssetBacktest()`, `npm run screening`) — Phase 5 abgeschlossen, Gate G5 erfüllt, G6 Pilot offen (`remediation/SCREENING-PILOT.md`) |
| 6 — Validator | [06-01](PROMPT-STX-06-01-assumptions-audit.md) [06-02](PROMPT-STX-06-02-overfit.md) [06-03](PROMPT-STX-06-03-cost-stress.md) [06-04](PROMPT-STX-06-04-validation-report.md) [06-05](PROMPT-STX-06-05-validator-agent.md) | ☑ (`v0.10.0` `0915c20` — Annahmen-Audit, `v0.10.1` `a2de401` — Overfit, `v0.10.2` `a34744b` — Cost-Stress STX-11, `v0.10.3` `0ab0d0a` — Report/Gate-Kette STX-17/STX-03, `v0.10.4` `4812f21` — Validator-Agent STX-13) — Phase 6 abgeschlossen, Gate G7 erfüllt |
| 7 — Copy | [07-01](PROMPT-STX-07-01-copy-domain.md) [07-02](PROMPT-STX-07-02-copy-policy.md) [07-03](PROMPT-STX-07-03-copy-leader-bitunix.md) | 07-01 ☑ (`v0.10.5` `b0bfcce` PR #213 — Domänenmodell `SIMULATE_ONLY`), 07-02 ☑ (`v0.10.6` `f5af325` PR #214 — Policy `cpl1:` + Order-Links), 07-03 ☑ (`5f437d8` PR #215 Unreleased auf `v0.10.6` — Bitunix-Leader + Simulate-only-Follower + Engine + `npm run copy:paper`, `NO_BASELINE`) — Phase 7 abgeschlossen, Gate G8 erfüllt |
| 8 — Folge-Prompts (Abgleich 2026-10-03) | [08-01](PROMPT-STX-08-01-changelog-nachtrag-copy-engine.md) [08-02](PROMPT-STX-08-02-docscatalog-suchpfade.md) [08-03](PROMPT-STX-08-03-signaldecay-klasse-ssot.md) [08-04](PROMPT-STX-08-04-backtestrule-indicatorcache.md) [08-05](PROMPT-STX-08-05-localfree-endpoint-haertung.md) | 08-01 ☑ (Changelog-Nachtrag zu PR #215; nun in `v0.11.0` enthalten), 08-02 ☑ (`v0.10.8` — Doku-Suchpfade/Traversal-Schutz), 08-03 ☑ (`v0.10.9` — Klassen-SSoT/Wächter), 08-04 ☑ (`v0.11.0` — einmaliger Indicator-Cache, unveränderte Goldens, volle `RULE_FIELDS`-Parität; 144 fokussierte Tests; PR [#221](https://github.com/Kryschuuu/ai-trading-firm/pull/221)), 08-05 ☐ offen (`LOCAL_FREE`-Endpunkt/STX-21). 08-04 benötigt 00-01/02-02/02-03; sonst unabhängig |

Jeder Prompt ist kopierfertig und enthält Zweck, Kontext, Auftrag, Akzeptanzkriterien
und die **Gesperrt-Klauseln**.

**Stand 2026-10-03** (Audit `v1.2.4`, Code-Version `0.11.0`; historischer
Vollabgleich `main` @ `3d13161` plus Abschluss 08-04): alle **32** Ursprungs-
Prompts umgesetzt; in Phase 8 sind 08-01…08-04 erledigt und 08-05 bleibt offen.
Von 21 Findings sind 18 FIXED, 1 PARTIAL (STX-14) und 2 OPEN (STX-08, STX-21);
STX-12 ist durch 08-04 geschlossen. Vollabgleich als historische Zeitaufnahme:
[`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md).
