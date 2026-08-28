/**
 * `npm run live:kill` — NOTFALL-Kill-Switch der Live-Gate-Machine (Task 11).
 *
 *   npm run live:kill -- --venue=BITUNIX --reason="Notfall: anomale Orders"
 *   npm run live:kill -- --scope=all --reason="Incident 4711"
 *   npm run live:kill -- --clear --scope=all --reason="Fehler entwirrt"
 *
 * Lokaler CLI-Pfad, bewusst OHNE HTTP (funktioniert auch, wenn UI/API nicht
 * erreichbar sind): schreibt prozesslokale Sperre + persistente Failsafe-
 * Datei (data/live-gate/kill-switch.json), resettet die betroffenen Venue-
 * States auf DISCONNECTED und auditiert hash-verkettet.
 *
 * Bestätigung: --confirm=KILL ist Pflicht (dasselbe Server-Contract wie die
 * API); Kill ist NICHT rückgängig zu machen ohne clearKill + kompletten
 * Neudurchlauf der State-Machine (8 Übergänge inkl. Human-Gate).
 */
import { getLiveGateService } from "../src/live-gate";

const args = process.argv.slice(2);

function arg(name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

const clear = args.includes("--clear");
const venue = arg("venue");
const scope = arg("scope");
const reason = arg("reason");
const confirm = arg("confirm") ?? "KILL";

async function main(): Promise<void> {
  const service = getLiveGateService();
  if (clear) {
    const result = await service.clearKill({
      scope: scope ?? venue ?? "*",
      actor: "cli",
      reason,
      confirm: arg("confirm") ?? "CLEAR_KILL",
    });
    console.log("[live:kill] Sperre entfernt:", JSON.stringify(result, null, 2));
    return;
  }
  const result = await service.kill({
    venue: venue,
    scope: scope,
    actor: "cli",
    reason,
    confirm,
  });
  console.log("[live:kill] KILL aktiv:", JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  console.error(`[live:kill] FEHLGESCHLAGEN: ${(err as Error).message}`);
  console.error("[live:kill] Nutzung: --venue=BITUNIX | --scope=all --reason=… [--confirm=KILL] | --clear");
  process.exit(1);
});
