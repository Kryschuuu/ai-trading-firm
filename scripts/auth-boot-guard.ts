/**
 * `npm run start` / `npm run dev` — Startwächter für die Authentifizierung
 * (Befund C1, v1.36.13).
 *
 * Aufgabe: vor `next start`/`next dev` prüfen, ob der Auth-Modus überhaupt
 * startfähig konfiguriert ist, und bei Verstößen **mit Exit-Code 1 abbrechen**.
 *
 * Warum ein eigenes Skript und nicht nur der Wurf in `src/instrumentation.ts`:
 * Next.js protokolliert einen Fehler im Instrumentation-Hook zwar
 * („Failed to prepare server“), lässt den Serverprozess aber weiterlaufen —
 * danach antwortet jede Route mit 500. Für `systemd` (`Restart=always`) wäre das
 * ein „aktiver“ Dienst mit toter App, kein fehlgeschlagener Start. Der Wächter
 * beendet den Prozess sauber, bevor der Server überhaupt lauscht; der Wurf in
 * `instrumentation.ts` bleibt als Verteidigungslinie für alle Starts, die an
 * diesem Skript vorbeilaufen (`npx next start`, Container-Entrypoints).
 *
 * Der Log-Zweck ist identisch, die Quelle ist dieselbe:
 * `src/auth/authMode.ts` (Modus) + `assertAuthConfigured()` (Entscheidung).
 *
 * Nutzung:
 *   node --import tsx scripts/auth-boot-guard.ts   (von npm run start/dev aufgerufen)
 *   npm run boot:guard                            (manuelle Prüfung, z. B. im Deploy)
 */
import { assertAuthConfigured, authModeWarnings, describeAuthMode } from "../src/auth/authMode";
import { clientIpPolicyWarnings, describeClientIpPolicy } from "../src/lib/clientIp";

function main(): void {
  try {
    const decision = assertAuthConfigured();
    for (const line of authModeWarnings(decision)) console.warn(line);
    console.log(`[auth] ${describeAuthMode(decision)} — Start erlaubt`);
    // C2/v1.36.14: sichtbar machen, woraus die Rate-Limit-Identität kommt.
    for (const line of clientIpPolicyWarnings()) console.warn(line);
    console.log(`[client-ip] ${describeClientIpPolicy()}`);
  } catch (e) {
    const err = e as { name?: string; code?: string; message?: string; hint?: string };
    const fatal =
      err && typeof err === "object" && err.name === "ConfigurationError"
        ? err
        : { code: "CONFIGURATION", message: String(e), hint: "" };
    console.error(`[auth] Start verweigert (${fatal.code ?? "CONFIGURATION"}): ${fatal.message}`);
    if (fatal.hint) console.error(`[auth] Behebung: ${fatal.hint}`);
    console.error(
      "[auth] Bewusster Lokalbetrieb ohne Token: AUTH_MODE=local-open in .env " +
        "(nur Entwicklung/Loopback empfohlen). Token erzeugen: openssl rand -hex 32"
    );
    process.exit(1);
  }
}

main();
