import { NextResponse } from "next/server";
import { getActiveRules, listRuleExecutions } from "@/lib/ruleService";
import { publicErrorMessage } from "@/lib/secrets";

export const dynamic = "force-dynamic";

/**
 * Status des Mikro-Zyklus (Ausführungsebene).
 *
 * Der Mikro-Executor läuft als eigener Prozess (`npm run micro`, systemd-Unit
 * deploy/micro-executor.service) und stellt seinen Health-Endpunkt auf
 * MICRO_HEALTH_PORT (Standard 3380) bereit. Diese Route bündelt:
 *   - Live-Status des Executor-Prozesses (falls erreichbar)
 *   - Aktive Regeln (aus der DB, das, was der Cache lädt)
 *   - Letzte Ausführungs-Ereignisse (Trigger/Blöcke/Fehler)
 */
export async function GET() {
  try {
    const healthPort = Number(process.env.MICRO_HEALTH_PORT ?? 3380);
    let microProcess: unknown = { reachable: false, reason: "nicht erreichbar" };
    try {
      const res = await fetch(`http://127.0.0.1:${healthPort}/health`, {
        signal: AbortSignal.timeout(600),
      });
      if (res.ok) microProcess = await res.json();
    } catch {
      /* Executor läuft nicht in diesem Deployment oder Port nicht offen */
    }

    const [active, executions] = await Promise.all([
      getActiveRules(),
      listRuleExecutions(undefined, 20),
    ]);

    return NextResponse.json({
      ok: true,
      microProcess,
      activeRules: active.map((r) => ({
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        version: r.version,
        condition: r.condition,
        action: r.action,
        window: r.window,
      })),
      executions,
      note:
        "Hot-Path ohne LLM: WebSocket-Tick → Rolling-Snapshot → kompilierte Regelauswertung → " +
        "Paper-Fill. Latenzwerte (µs) des Prozesses siehe microProcess / rule_executions.latency_micros.",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
