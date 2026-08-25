/**
 * Next.js-Instrumentation: startet beim Server-Boot alle Hintergrundleufwerke.
 *
 * 1) Markt-Tick (Standard 60 s):
 *    Kurse aktualisieren → SL/TP prüfen → Tageslimit bewachen → Equity-Snapshot
 *
 * 2) Analystenzyklus (ANALYST_INTERVAL_MIN, Standard 30 Min):
 *    Technical-, Macro- und News-Analyst, sequenziell (CPU-Schonung)
 *
 * 3) Tägliche Tiefenforschung nach US-Börsenschluss (PENNY_RUN_HOUR_BERLIN,
 *    Standard 23 Uhr Berliner Zeit): Penny-Team (Scout+Diligence) und danach
 *    der Swing-Researcher — genau einmal pro Tag.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SCHEDULER_ENABLED === "false") return;

  const G = globalThis as typeof globalThis & { __firmSchedulerStarted?: boolean };
  if (G.__firmSchedulerStarted) return;
  G.__firmSchedulerStarted = true;

  const { envInt } = await import("@/lib/env");
  const intervalMs = envInt("TICK_INTERVAL_MS", 60_000, 15_000, 600_000);
  // KORRIGIERT (v1.4.0): ANALYST_INTERVAL_MIN wurde nur geloggt, Analysten
  // liefen tatsächlich jede Minute (Slot-Key = HH:MM). Jetzt echter Abstand.
  const analystIntervalMs = envInt("ANALYST_INTERVAL_MIN", 30, 10, 24 * 60) * 60_000;
  const pennyHour = envInt("PENNY_RUN_HOUR_BERLIN", 23, 0, 23);

  setTimeout(async () => {
    try {
      const monitorMod = await import("@/lib/monitor");
      const analystsMod = await import("@/lib/analysts");
      const { berlinDayKey } = await import("@/lib/time");

      // ── 1) Markt-Tick ──
      const runTick = async () => {
        try {
          const r = await monitorMod.tick();
          if (r.stopsTriggered.length > 0 || r.errors.length > 0) {
            console.log(`[scheduler] tick: ${r.stopsTriggered.length} SL/TP-Auslösungen, ${r.errors.length} Fehler`);
          }
        } catch (e) {
          console.warn("[scheduler] Tick fehlgeschlagen:", e instanceof Error ? e.message : e);
        }
      };
      await runTick();
      setInterval(runTick, intervalMs);

      // ── 2) Analystenzyklus ──
      let lastAnalystKey = "";
      const runAnalysts = async () => {
        try {
          await analystsMod.runTechnicalAnalyst("BTC");
          await analystsMod.runMacroAnalyst();
          await analystsMod.runNewsAnalyst(["BTC", "SPY"]);
        } catch (e) {
          console.warn("[scheduler] Analystenzyklus fehlgeschlagen:", e instanceof Error ? e.message : e);
        }
      };
      // KORRIGIERT (v1.1.0): Slot-Key in Berliner Zeit statt Server-Localtime —
      // auf UTC-Servern (systemd) griff der Doppelstart-Schutz sonst nie richtig.
      setInterval(() => {
        const nowBerlin = new Intl.DateTimeFormat("de-DE", {
          timeZone: "Europe/Berlin",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(new Date());
        const key = `${berlinDayKey()}:${nowBerlin}`;
        if (key === lastAnalystKey) return; // Doppelstart-Schutz über Slotted-Key
        lastAnalystKey = key;
        void runAnalysts();
      }, 60_000);

      // ── 3) Täglich nach US-Schluss: Penny-Team + Swing-Research ──
      let lastDeepRunDay = "";
      setInterval(async () => {
        try {
          const nowBerlin = new Intl.DateTimeFormat("de-DE", {
            timeZone: "Europe/Berlin", hour: "numeric", hour12: false,
          }).format(new Date());
          const day = berlinDayKey();
          if (Number(nowBerlin) === pennyHour && lastDeepRunDay !== day) {
            lastDeepRunDay = day;
            console.log("[scheduler] Tägliche Tiefenforschung läuft (Penny-Team + Swing) …");
            await analystsMod.runPennyTeam();
            await analystsMod.runSwingResearch();
            console.log("[scheduler] Tiefenforschung abgeschlossen.");
          }
        } catch (e) {
          console.warn("[scheduler] Tiefenforschung fehlgeschlagen:", e instanceof Error ? e.message : e);
        }
      }, 60_000);

      console.log(
        `[scheduler] Aktiv — Tick ${(intervalMs / 1000) | 0}s · Analysten ${analystIntervalMs / 60000 | 0}min · Penny/Swing ab ${pennyHour}:00 Berlin`
      );
    } catch (e) {
      console.warn("[scheduler] Start fehlgeschlagen:", e instanceof Error ? e.message : e);
    }
  }, 3000);
}
