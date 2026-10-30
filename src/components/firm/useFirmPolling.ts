"use client";

import { useEffect } from "react";

/** Kleine Browser-Grenze für deterministische Timer-/Sichtbarkeitstests. */
export interface FirmPollingEnvironment {
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setInterval(callback: () => void, delayMs: number): number;
  clearInterval(id: number): void;
}

/** Startet genau einen sichtbaren Polling-Timer und gibt dessen Cleanup zurück. */
export function startFirmPolling(
  load: () => Promise<void>,
  hasActiveMission: boolean,
  env: FirmPollingEnvironment,
): () => void {
  const delay = hasActiveMission ? 8_000 : 15_000;
  let timer: number | null = null;

  const stop = () => {
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  };
  const start = () => {
    if (env.isVisible() && timer === null) {
      timer = env.setInterval(() => { void load(); }, delay);
    }
  };
  const onVisibilityChange = () => {
    if (!env.isVisible()) {
      stop();
      return;
    }
    // Der letzte Snapshot kann während des Hintergrunds veraltet sein.
    void load();
    start();
  };

  const unsubscribe = env.onVisibilityChange(onVisibilityChange);
  start();
  return () => {
    unsubscribe();
    stop();
  };
}

/** Missions-Array-Identität ist bewusst keine Abhängigkeit dieses Effekts. */
export function useFirmPolling(load: () => Promise<void>, hasActiveMission: boolean): void {
  useEffect(() => startFirmPolling(load, hasActiveMission, {
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    clearInterval: (id) => window.clearInterval(id),
  }), [load, hasActiveMission]);
}
