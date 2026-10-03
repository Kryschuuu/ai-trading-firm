# STX-19 — INFO: Der Kafka-Einwand des Dokuments trägt

- **ID:** STX-19
- **Severity:** INFO
- **Bereich:** Infrastruktur
- **Quelle:** Ausbaudokument §4.6
- **Status:** VERIFIED — Abgleich 2026-10-03: Einwand trägt, kein Kafka/NATS/Redis/DuckDB im Baum

## Abgleich 2026-10-03

- **Geprüfter Stand:** `main` @ `3d13161` · Code-Version `0.10.6` (Beta)
- **Eingestuft:** `☑` **VERIFIED** — von `OPEN` umgestuft (bestätigender Befund, nichts umzusetzen)
- **Abgleich-Bericht:** [`../remediation/RECONCILE-2026-10-03.md`](../remediation/RECONCILE-2026-10-03.md)

**Nachweise**

- `package.json` `dependencies`: `@tailwindcss/typography`, `dotenv`, `drizzle-orm`, `next`, `pg`, `react`, `react-dom`, `react-markdown`, `remark-gfm`, `ws` — **kein** Kafka, NATS, Redis, DuckDB, Parquet-Reader
- `grep -rniE "\bkafka\b|\bnats\b|\bredis\b|\bduckdb\b" src/` → **0 Treffer**
- `ws` bleibt die einzige zusätzliche Laufzeitabhängigkeit; `src/brokers/bitunix/ws.ts` der einzige WS-Pfad
- **Korrektur am Befund:** die ursprüngliche Beweisliste nannte `react`, nicht `react-dom` — beide sind vorhanden; für die Aussage ohne Belang
- Umstufung begründet: Der Befund bestätigt den Einwand des Dokuments und verlangt, **nichts** zu bauen. Die globale Sperre steht in [`../ROADMAP.md`](../ROADMAP.md) §0. Damit ist er erfüllt, nicht offen.

## Befund

*„Ich würde **nicht sofort Kafka einbauen**. … Kafka würde ich aktuell nicht priorisieren."*

**Bestätigt.** Belege im Repo:

- `ws` ist die **einzige** Laufzeitabhängigkeit über Next/React hinaus
  (`dependencies`: `drizzle-orm`, `next`, `pg`, `react`, `ws`, `dotenv`,
  `react-markdown`, `remark-gfm`, `@tailwindcss/typography`) — **kein** Redis, kein NATS,
  kein Kafka, kein ORM-Cache, kein DuckDB, kein Parquet-Reader
- `src/marketdata/manager.ts` + `failover.ts` sind bereits die venueübergreifende
  Abstraktionsstelle
- `src/brokers/bitunix/ws.ts` ist der einzige WS-Pfad

Der „local-first, keine externen Dienste"-Charakter ist ein bewusstes Produktmerkmal
(siehe `README.md`, `INSTALL.md`, `docs/HOWTO_LAN_SESSION.md`).

## Ergänzung

Auch **Parquet/DuckDB** ist in dieser Roadmap **nicht** enthalten. Begründung: Vor dem
Formatwechsel ist der Leseweg zu messen (Prompt 00-01). Der NDJSON-Store lädt die ganze
Datei pro Query (`historicalStore.ts:353`) — das ist der Engpass, aber die erste
Gegenmaßnahme ist ein Index/Partition-Split, kein Formatwechsel mit zusätzlicher Runtime.

Phase 3 der Roadmap enthält bewusst nur: **messen, dann entscheiden.**
