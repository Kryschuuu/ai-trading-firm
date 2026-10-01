# Prompts — Audit 2026-09-29

32 Prompts in 8 Phasen. Reihenfolge, Abhängigkeiten und Gates: [`../ROADMAP.md`](../ROADMAP.md).

| Phase | Prompts | Status |
|---|---|---|
| 0 — Messung | [00-01](PROMPT-STX-00-01-backtest-perf-baseline.md) [00-02](PROMPT-STX-00-02-strategy-stack-ssot.md) [00-03](PROMPT-STX-00-03-vokabular-adr.md) | ☑ (`v0.6.0`, `v0.6.1`) |
| 1 — Blocker | [01-01](PROMPT-STX-01-01-rule-timeframes.md) | ☑ (`v0.6.2`) |
| 2 — Indikatoren | [02-01](PROMPT-STX-02-01-indikatoren.md) [02-02](PROMPT-STX-02-02-bollinger-felder.md) [02-03](PROMPT-STX-02-03-donchian-feld.md) [02-04](PROMPT-STX-02-04-featurestore-rule-slice.md) | 02-01 ☑ (`v0.6.3`), 02-02 ☑ (`v0.6.4`), Rest ☐ |
| 3 — Templates | [03-01](PROMPT-STX-03-01-template-types.md) [03-02](PROMPT-STX-03-02-catalog.md) [03-03](PROMPT-STX-03-03-template-ema-adx.md) [03-04](PROMPT-STX-03-04-template-macd.md) [03-05](PROMPT-STX-03-05-template-rsi.md) [03-06](PROMPT-STX-03-06-template-bollinger.md) [03-07](PROMPT-STX-03-07-template-vwap.md) [03-08](PROMPT-STX-03-08-template-donchian.md) [03-09](PROMPT-STX-03-09-compiler.md) [03-10](PROMPT-STX-03-10-template-tests.md) | 03-01/03-02 ☑ (`v0.7.0`), 03-03 ☑ (`v0.7.1`), 03-04 ☑ (`v0.7.2`), 03-05 ☑ (`v0.7.3`), 03-06/03-07/03-08 ☑ (`v0.7.4`), 03-09 ☑ (`v0.7.5`); offen 03-10 |
| 4 — Persistenz | [04-01](PROMPT-STX-04-01-strategy-persistenz-migration.md) [04-02](PROMPT-STX-04-02-strategy-service.md) | ☐ |
| 5 — Screening | [05-01](PROMPT-STX-05-01-screening-types.md) [05-02](PROMPT-STX-05-02-matrix-builder.md) [05-03](PROMPT-STX-05-03-screening-persistenz.md) [05-04](PROMPT-STX-05-04-screening-cli.md) | ☐ |
| 6 — Validator | [06-01](PROMPT-STX-06-01-assumptions-audit.md) [06-02](PROMPT-STX-06-02-overfit.md) [06-03](PROMPT-STX-06-03-cost-stress.md) [06-04](PROMPT-STX-06-04-validation-report.md) [06-05](PROMPT-STX-06-05-validator-agent.md) | ☐ |
| 7 — Copy | [07-01](PROMPT-STX-07-01-copy-domain.md) [07-02](PROMPT-STX-07-02-copy-policy.md) [07-03](PROMPT-STX-07-03-copy-leader-bitunix.md) | ☐ |

Jeder Prompt ist kopierfertig und enthält Zweck, Kontext, Auftrag, Akzeptanzkriterien
und die **Gesperrt-Klauseln**.
