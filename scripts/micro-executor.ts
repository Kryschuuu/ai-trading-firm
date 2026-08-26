/**
 * MIKRO-ZYKLUS — eigenständiger Executor-Prozess (keine LLM-Imports).
 *
 * Start:          npm run micro          (oder systemd, siehe deploy/micro-executor.service)
 * Konfiguration:  .env (MICRO_SYMBOLS, MICRO_FEED, MICRO_RULE_REFRESH_MS, …)
 * Health:         GET http://127.0.0.1:MICRO_HEALTH_PORT/health (Standard 3380)
 *
 * Der Prozess enthält bewusst NUR: Feed → Rolling-Snapshot → kompilierte
 * Regelauswertung → Paper-Broker. Es wird kein Modell geladen, kein LLM-Call
 * gemacht und keine Pipeline gestartet — Intelligenz und Latenz sind getrennt.
 */
import "dotenv/config";
import http from "node:http";
import {
  MicroExecutor,
  BinanceTradeFeed,
  SimulatedFeed,
  RuleCache,
  createPaperRuleAdapter,
} from "../src/lib/microExecutor";

function envInt(key: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

async function main(): Promise<void> {
  const symbols = (process.env.MICRO_SYMBOLS || "BTC")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const feedName = (process.env.MICRO_FEED || "binance").toLowerCase();
  const refreshMs = envInt("MICRO_RULE_REFRESH_MS", 30_000, 5_000, 600_000);
  const healthPort = envInt("MICRO_HEALTH_PORT", 3380, 1024, 65535);

  console.log(
    `[micro] Start — Symbole=${symbols.join(",")} Feed=${feedName} Rule-Refresh=${refreshMs / 1000}s`
  );

  const cache = new RuleCache(refreshMs);
  const executor = new MicroExecutor({
    cache,
    adapter: createPaperRuleAdapter({ onFired: (id) => cache.noteFired(id) }),
    options: { refreshMs, seedCandles: process.env.MICRO_SEED_CANDLES !== "false" },
  });

  const feed =
    feedName === "sim"
      ? new SimulatedFeed(symbols, {
          intervalMs: envInt("MICRO_SIM_INTERVAL_MS", 250, 50, 5_000),
        })
      : new BinanceTradeFeed(symbols);
  executor.registerFeed(feed);
  for (const symbol of symbols) {
    executor.addSymbol(symbol, "5m");
    executor.addSymbol(symbol, "15m");
  }

  await executor.start();

  // Health-HTTP-Server fürs Dashboard/Monitoring (nur lokale Bindung).
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, name: "micro-executor", ...executor.status() }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  server.listen(healthPort, "127.0.0.1", () => {
    console.log(`[micro] Health-Endpunkt: http://127.0.0.1:${healthPort}/health`);
  });

  // Periodische Kurzdiagnose auf stdout (journald/systemd).
  setInterval(() => {
    const s = executor.status();
    console.log(
      `[micro] ticks=${s.ticksProcessed} evals=${s.evaluations} matches=${s.matches} ` +
        `exec=${s.executions} blocked=${s.blocked} errors=${s.errors} ` +
        `lastEval=${s.lastEvalMicros ?? "–"}µs avg=${s.avgEvalMicros ?? "–"}µs p95=${s.p95EvalMicros ?? "–"}µs ` +
        `rules=${s.cache.activeRules}`
    );
  }, 60_000);

  const shutdown = async (sig: string) => {
    console.log(`[micro] ${sig} empfangen — sauberer Shutdown …`);
    await executor.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await import("../src/lib/ruleService")
      .then((m) => m.listRules())
      .then((rules) => {
        const active = rules.filter((r) => r.status === "ACTIVE");
        console.log(
          `[micro] Regeln im Cache geladen: ${active.length} ACTIVE (${active.map((r) => r.symbol).join(", ") || "keine — Makro-Zyklus starten: POST /api/firm/macro"})`
        );
      })
      .catch((e) => {
        console.warn("[micro] Regel-Übersicht nicht lesbar (DB?), Cache lädt selbst weiter:", e instanceof Error ? e.message : e);
      });
  } catch {
    /* Regel-Liste ist nur Logging; der Cache lädt selbst */
  }
}

main().catch((e) => {
  console.error("[micro] Fataler Fehler:", e instanceof Error ? e.message : e);
  process.exit(1);
});
