# STX-19 — INFO: Der Kafka-Einwand des Dokuments trägt

- **ID:** STX-19
- **Severity:** INFO
- **Bereich:** Infrastruktur
- **Quelle:** Ausbaudokument §4.6
- **Status:** OPEN (bestätigend)

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
