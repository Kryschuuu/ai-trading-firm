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
      // KORRIGIERT (v1.5.3): ANALYST_INTERVAL_MIN wurde nur geloggt, der
      // Zyklus lief tatsächlich jede Minute (Slot-Key = HH:MM) — der
      // v1.4.0-Kommentar versprach „echter Abstand“, der Code hielt es nicht.
      // Jetzt: genau ein Zyklus pro Intervallfenster (Berliner Tag + Slotschlüssel
      // aus dem Intervall), plus Overlap-Schutz, falls ein Lauf länger dauert.
      let lastAnalystKey = "";
      let analystRunning = false;
      const runAnalysts = async () => {
        if (analystRunning) return;
        analystRunning = true;
        try {
          await analystsMod.runTechnicalAnalyst("BTC");
          await analystsMod.runMacroAnalyst();
          await analystsMod.runNewsAnalyst(["BTC", "SPY"]);
        } catch (e) {
          console.warn("[scheduler] Analystenzyklus fehlgeschlagen:", e instanceof Error ? e.message : e);
        } finally {
          analystRunning = false;
        }
      };
      setInterval(() => {
        // Berliner Tag + Index des Intervallfensters (epoch-basiert) → der
        // Key wechselt genau alle ANALYST_INTERVAL_MIN Minuten, nie öfter.
        const key = `${berlinDayKey()}:${Math.floor(Date.now() / analystIntervalMs)}`;
        if (key === lastAnalystKey) return; // Doppelstart-Schutz über Slotted-Key
        lastAnalystKey = key;
        void runAnalysts();
      }, Math.min(60_000, analystIntervalMs));

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

      // ── 4) MAKRO-ZYKLUS: CEO + Research erzeugen das Regelwerk ──
      // Bewusst im Takt von MACRO_CYCLE_INTERVAL_MIN (Standard 1 h), niemals
      // pro Tick. Die Ausführung macht der separate Mikro-Executor-Prozess
      // (`npm run micro`) — hier entsteht nur die Strategie.
      const macroIntervalMs =
        envInt("MACRO_CYCLE_INTERVAL_MIN", 60, 10, 24 * 60) * 60_000;
      let macroBusy = false;
      const runMacro = async () => {
        if (macroBusy) return;
        macroBusy = true;
        try {
          const macroMod = await import("@/lib/macroCycle");
          const result = await macroMod.runMacroCycle();
          console.log(
            `[scheduler] Makro-Zyklus: ${result.ok ? "OK" : "FEHLER"} → ${
              result.rule ? `${result.rule.name} (v${result.rule.version}, ${result.rule.status})` : result.error ?? "ohne Ergebnis"
            }`
          );
        } catch (e) {
          console.warn("[scheduler] Makro-Zyklus fehlgeschlagen:", e instanceof Error ? e.message : e);
        } finally {
          macroBusy = false;
        }
      };
      setTimeout(() => void runMacro(), 15_000);
      setInterval(() => void runMacro(), macroIntervalMs);

      console.log(
        `[scheduler] Aktiv — Tick ${(intervalMs / 1000) | 0}s · Analysten ${analystIntervalMs / 60000 | 0}min · Penny/Swing ab ${pennyHour}:00 Berlin · Makro-Zyklus ${macroIntervalMs / 60000 | 0}min`
      );
    } catch (e) {
      console.warn("[scheduler] Start fehlgeschlagen:", e instanceof Error ? e.message : e);
    }
  }, 3000);
}
