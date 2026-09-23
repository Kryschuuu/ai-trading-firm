/**
 * API-Route `GET`, `POST /api/firm/risk/signal-decay` — Signal-Decay-Exits (Status/Policy).
 *
 * Teil der Firm-API (Next.js App Router). Zusätzlich guardWrite (API-Guard). Auth-Modell und RBAC: docs/security/README.md.
 */

import { NextResponse } from "next/server";
import { guardWrite } from "@/lib/apiAuth";
import { publicErrorMessage } from "@/lib/secrets";
import { setConfigValue } from "@/lib/riskConfigService";
import {
  SIGNAL_DECAY_BOUNDS,
  STRATEGY_CLASS_KEYS,
  policyVersionOf,
} from "@/lib/signalDecay";
import {
  loadRuntimeSignalDecayConfig,
  readSignalDecayRollup,
  resetSignalDecayRuntimeForTests,
} from "@/lib/signalDecayRuntime";

export const dynamic = "force-dynamic";

/**
 * Signal-Decay-Exits (RMA-P5-05, v1.69.0).
 *
 * GET liefert die geklemmte Policy (Env × `sdc.*`), die Policyversion und den
 * Monitor-only-Counterfactual-Rollup. `triggerCoverage` ist null, wenn noch
 * nichts bewertet wurde (nicht 0). `additionalPnl` / `avoidedPnl` sind null,
 * solange kein Would-Exit mit bekanntem Close vorliegt.
 *
 * POST `{ key, value }` schreibt einen bounded `sdc.<klasse>.<feld>`-Wert
 * (0/1 für enabled und reversalEnabled). Der Modus selbst bleibt
 * `SIGNAL_DECAY_MODE` (off | monitor | active) — ein API-Write kann die
 * Klasse nicht an `active` koppeln, ohne dass der Operator den Modus setzt.
 * Safety-Exits bleiben vorrangig; fehlende Signale schließen nichts.
 *
 * Migration: `drizzle/2026-09-22_signal_decay.sql` vor dem Deploy.
 * Rollback: `SIGNAL_DECAY_MODE=off` (keine Writes, keine Exits) oder die
 * Klassen-Flags auf false. Die Tabelle bleibt append-only.
 */
export async function GET() {
  try {
    const config = await loadRuntimeSignalDecayConfig();
    const rollup = await readSignalDecayRollup().catch(() => null);
    return NextResponse.json({
      ok: true,
      signalDecay: {
        mode: config.mode,
        active: config.mode === "active",
        policyVersion: policyVersionOf(config),
        acceptedMigrations: config.acceptedMigrations,
        classes: STRATEGY_CLASS_KEYS.map((key) => ({
          strategyClass: key,
          ...config.classes[key],
        })),
        bounds: SIGNAL_DECAY_BOUNDS,
        rollup,
        priority: ["KILL_SWITCH", "STOP_LOSS", "TAKE_PROFIT", "TRAILING_STOP", "TIME_STOP", "SIGNAL_DECAY"],
        timeBasis: {
          live: "open",
          liveInterval: "15m",
          backtestDefault: "close",
        },
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const denied = guardWrite(req);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
    if (typeof body.key !== "string" || !body.key.startsWith("sdc.")) {
      return NextResponse.json({ ok: false, error: "key muss sdc.<klasse>.<feld> sein" }, { status: 400 });
    }
    const value = Number(body.value);
    if (!Number.isFinite(value)) {
      return NextResponse.json({ ok: false, error: "value muss eine Zahl sein" }, { status: 400 });
    }
    resetSignalDecayRuntimeForTests();
    const written = await setConfigValue(body.key, value);
    if (!written.ok) {
      return NextResponse.json({ ok: false, error: written.error ?? "abgelehnt" }, { status: 400 });
    }
    const config = await loadRuntimeSignalDecayConfig();
    return NextResponse.json({
      ok: true,
      effective: written.effective,
      mode: config.mode,
      policyVersion: policyVersionOf(config),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: publicErrorMessage(e) }, { status: 500 });
  }
}
