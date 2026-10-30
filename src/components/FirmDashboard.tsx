"use client";

/**
 * Firm-Dashboard — Hauptansicht der Paper-Trading-Firma.
 *
 * Zweck: aggregiert die Zustände (Firm-Load, Positionen, Equity, Risk-Limits,
 * adaptives Risk-System, Kill-Switch) in einer ansichtsweisen Oberfläche und
 * stellt die Betriebsaktionen bereit (Pipeline starten, Tick, Seed/Reset,
 * Not-Halt). Sämtliche Schreibaktionen laufen über die autorisierte API
 * (csrfHeaderValue aus @/lib/browserSession); Token/Secrets bleiben im
 * HttpOnly-Cookie bzw. auf dem Server (kein localStorage).
 *
 * Layout seit v0.15.0: volle Bildschirmbreite (`PageShell`) statt
 * `max-w-7xl`, eine Reiterleiste mit Rollen/Tastatursteuerung (`TabBar`),
 * Kennzahlen als `MetricTile` und alle Tabellen als `DataTable`
 * (Mobile: gestapelte Karten, Desktop: sticky Spaltenköpfe).
 * Seit v0.16.1 zeigt ein Klick genau den gewählten Bereich — die übrigen
 * `TabPanel`s sind ausgeblendet, nicht untereinander gestapelt.
 *
 * Abhängigkeiten: @/lib/apiClient, @/lib/browserSession, @/lib/firmSession,
 * @/lib/types, @/components/ui/*.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiClient";
import { clearLegacyFirmToken, csrfHeaderValue, logoutSession } from "@/lib/browserSession";
import {
  diagnosePostLogin,
  fetchFirmSnapshot,
  fetchSessionStatus,
  renewSession,
  sessionNeedsLogin,
  sessionRenewDelayMs,
  submitSessionToken,
  type FirmIssue,
  type SessionSnapshot,
} from "@/lib/firmSession";
import WorkshopTab from "./workshop/WorkshopTab";
import BrokersPanel from "./control-plane/BrokersPanel";
import OperationsCenterPanel from "./ops/OperationsCenterPanel";
import MetricTile from "./ui/MetricTile";
import Chip from "./ui/Chip";
import Button from "./ui/Button";
import { selectDashboardTab, type DashboardTab } from "./dashboardTabs";
import TabBar, { TabPanel, type TabDef } from "./ui/Tabs";
import { PageShell } from "./ui/PageShell";
import { PANEL_PADDED } from "./ui/layout";
import ThemeSwitcher from "./ThemeSwitcher";
import { FirmIssueBox } from "./common/FirmIssueBox";
import { SessionNoticeBar } from "./common/SessionNoticeBar";
import { defaultData, type FirmData } from "./firm/types";
import OverviewTab from "./firm/OverviewTab";
import ReportsTab from "./firm/ReportsTab";
import ProtocolTab from "./firm/ProtocolTab";
import AgentsTab from "./firm/AgentsTab";
import RiskTab from "./firm/RiskTab";
import ArchitectureTab from "./firm/ArchitectureTab";
import { useFirmPolling } from "./firm/useFirmPolling";

export default function FirmDashboard() {
  const [data, setData] = useState<FirmData>(defaultData);
  const [tab, setTab] = useState<DashboardTab>("overview");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  /**
   * Klassifizierter Ladefehler von `GET /api/firm` (v1.36.41) — `null` heißt
   * „letzter Load erfolgreich". Die Klassifikation unterscheidet Session (401),
   * Permission (403) und Datenquelle (5xx); Titel und Anleitung kommen aus
   * `src/lib/firmSession.ts`, nicht mehr aus diesem Template.
   */
  const [firmIssue, setFirmIssue] = useState<FirmIssue | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  /**
   * Anmelde-/Sitzungsstatus von `GET /api/auth/status` (v1.39.0) — beantwortet
   * sichtbar, ob die Firm-API eingetragen ist und ob die eigene Sitzung laeuft.
   * `sessionNow` ist nur der Anker fuer das Runterzaehlen der Restzeit.
   */
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [sessionNow, setSessionNow] = useState(() => Date.now());
  const [sessionBusy, setSessionBusy] = useState(false);
  /** `true`, sobald der Statusabruf selbst fehlschlug (Netzwerk/Deploy-Fehler). */
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  /** Pipeline-Statusleiste: läuft / fertig / fehlgeschlagen (optisch hervorgehoben). */
  const [pipeline, setPipeline] = useState<{
    phase: "running" | "done" | "failed";
    detail?: string;
  } | null>(null);

  /**
   * Lädt den Firm-Zustand und klassifiziert Fehler zentral
   * (`src/lib/firmSession.ts`, v1.36.41):
   *
   * - `401`/`403` → `issue.needsLogin`; das Token-Feld ist damit **sofort**
   *   sichtbar (auch beim allerersten Load nach einem Neustart) und der Titel
   *   beschuldigt nicht mehr die Datenbank,
   * - `5xx` → Datenbank-Hinweis inklusive `fix`-Anleitung des Servers,
   * - ein Fehler ersetzt nie den letzten gültigen Zustand (FIX v1.23.0) — die
   *   modulbasierten Tabs (Operations Center, Brokers) bleiben nutzbar.
   */
  /**
   * Reiterwechsel. Unbekannte IDs (z. B. ein veralteter „Tab öffnen“-Sprung)
   * werden verworfen, statt einen Zustand zu setzen, für den kein Panel
   * `active` ist — dann wäre die Fläche leer.
   */
  const selectTab = useCallback((next: string) => {
    setTab((current) => selectDashboardTab(current, next));
  }, []);

  const load = useCallback(async () => {
    const result = await fetchFirmSnapshot();
    if (result.ok) {
      setFirmIssue(null);
      setData(result.data as FirmData);
    } else {
      setFirmIssue(result.issue);
    }
    setLoading(false);
  }, []);

  /**
   * Holt den Anmeldestatus (`GET /api/auth/status`, v1.39.0) und beantwortet
   * damit zwei Fragen, die das Dashboard vorher nie gezeigt hat: Ist die
   * Firm-API serverseitig ueberhaupt eingetragen, und laeuft meine Session?
   * Wirft nie — `fetchSessionStatus` fangt Netzwerk- und Formatfehler.
   */
  const refreshSessionStatus = useCallback(async () => {
    const result = await fetchSessionStatus();
    setSession(result.ok ? result.snapshot : null);
    setSessionUnavailable(!result.ok);
    setSessionNow(Date.now());
    if (result.ok) setNeedToken(sessionNeedsLogin(result.snapshot));
    return result;
  }, []);

  /**
   * v1.39.0: die Sitzung haelt, bis das Browserfenster geschlossen wird.
   *
   * Der Server setzt die Idle-Frist (Default 15 min) und nennt die Restzeit;
   * dieser Takt erneuert sie rechtzeitig ueber `POST /api/auth/refresh`.
   * Scheitert die Verlaengung (Nachfrist abgelaufen, Logout, Secret-/Token-
   * Rotation), wird der Status neu geholt — das Token-Feld erscheint, ohne
   * dass erst eine Aktion mit 401 zurueckkommen muss.
   */
  const renew = useCallback(async () => {
    const csrf = csrfHeaderValue();
    setSessionBusy(true);
    // Kein CSRF-Wert im Cookie == keine (verlaengerbare) Session: Status
    // nachziehen, damit der Balken den wahren Grund zeigt.
    const result = csrf ? await renewSession(csrf) : null;
    setSessionBusy(false);
    if (result && result.ok && !result.renewed) return; // Frist laeuft noch
    await refreshSessionStatus();
  }, [refreshSessionStatus]);

  /**
   * Der „Anmelden“-Knopf im Balken blendet nur das Feld ein — der Token wird
   * erst mit dem Absenden an `POST /api/auth/login` geschickt und dort
   * serverseitig geprueft (W1: nie ein Store, nie ein Header durch den Nutzer).
   */
  function showLoginField() {
    setNeedToken(true);
    setNotice(
      session?.firmApi.sessionsAvailable
        ? "Token aus `.env` eintragen (FIRM_API_TOKEN oder FIRM_ADMIN_TOKEN) — der Browser behaelt danach nur die HttpOnly-Sitzung."
        : "Es ist kein Firm-API-Token eingerichtet und kein Session-Schluessel konfiguriert — Anmeldung ist auf dem Server nicht moeglich (siehe CONFIGURATION.md, Abschnitt Session-Sicherheit)."
    );
  }

  /** Ausdruecklicher Klick auf „Verlaengern“ — gleiche Bahn wie der Takt. */
  async function manualRenew() {
    setSessionBusy(true);
    await renew();
    setSessionBusy(false);
    setNotice("Sitzungstaetigkeit gemeldet — Restzeit wird oben neu angezeigt.");
  }

  /** Zeigt nach einer 401 die Token-Eingabe und bricht die Aktion ab. */
  async function ensureAuth(res: Response): Promise<boolean> {
    if (res.status === 401) {
      setNeedToken(true);
      setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN).");
      return false;
    }
    return true;
  }

  /**
   * W1 (v1.36.23): Der Token wird NUR einmal serverseitig verifiziert —
   * `POST /api/auth/login` setzt die HttpOnly+Secure+SameSite-Session-Cookie.
   * v1.39.0: die Cookie ist eine Browser-Session-Cookie (kein `Max-Age`), die
   * Idle-Frist (Default 15 min) wird vom Takt automatisch erneuert. Der
   * Browser-Token wird verworfen, es gibt KEIN localStorage mehr.
   *
   * v1.36.41: Nach erfolgreicher Anmeldung lädt `load()` automatisch neu —
   * das manuelle `F5` aus dem LAN-Howto entfällt.
   */
  async function saveToken() {
    const token = tokenDraft.trim();
    if (!token) return;
    setTokenDraft("");
    const authenticated = await submitSessionToken(token, {
      onNotice: setNotice,
      reload: load,
    });
    if (authenticated) clearLegacyFirmToken(); // Altbestand aus Pre-W1-Installationen
    setNeedToken(!authenticated);
    // v1.39.0: nach erfolgreichem Login steht die Restzeit fest — anzeigen,
    // statt sie zu raten, und den Verlaengerungstakt damit neu stellen.
    if (authenticated) {
      const status = await refreshSessionStatus();
      const diagnosis = status.ok ? diagnosePostLogin(status.snapshot) : "";
      if (diagnosis) setNotice(diagnosis);
    }
  }

  /**
   * SEC-08 (v1.36.35): Session serverseitig widerrufen und Cookies entfernen.
   */
  async function handleLogout() {
    const ok = await logoutSession();
    clearLegacyFirmToken();
    setNeedToken(true);
    setSession(null);
    setNotice(
      ok
        ? "Abgemeldet — Session serverseitig widerrufen, Cookies entfernt. Die Anmeldung gilt wieder, sobald ein Token eingetragen wird."
        : "Abmelden nicht bestaetigt (Netzwerk?) — die Sitzung laeuft moeglicherweise weiter."
    );
    // Status neu holen: zeigt, ob die Session wirklich weg ist (200) oder der
    // Dienst nicht antwortet — und stellt den Verlaengerungstakt ab.
    await refreshSessionStatus();
    load();
  }

  // Kein synchrones setState im Effekt (react-hooks/set-state-in-effect):
  // Das initiale Laden wird um einen Tick verschoben, der Effekt selbst ruft
  // keine Setter auf.
  useEffect(() => {
    const id = window.setTimeout(() => {
      void load();
      void refreshSessionStatus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [load, refreshSessionStatus]);

  /**
   * Nach einem Reiterwechsel den gewählten Bereich in den Sichtbereich holen.
   * Vor v0.16.1 standen alle Panels untereinander; ein Klick weiter unten auf
   * der Seite landete sonst im Leerraum, sobald die übrigen Bereiche aus dem
   * Fluss genommen werden. Der erste Lauf (Mount) scrollt nicht.
   */
  const skipInitialTabScroll = useRef(true);
  useEffect(() => {
    if (skipInitialTabScroll.current) {
      skipInitialTabScroll.current = false;
      return;
    }
    document.getElementById(`tab-panel-${tab}`)?.scrollIntoView({ block: "nearest" });
  }, [tab]);

  // v1.39.0: ein einziger Timer pro Zustand — der Server nennt die Restzeit,
  // der Client erneuert genau davor. Kein Dauerintervall: ein gedrosselter
  // Hintergrund-Tab verlaesst sich auf die serverseitige Nachfrist.
  useEffect(() => {
    const delay = sessionRenewDelayMs(session, Date.now());
    if (delay === null) return;
    const id = window.setTimeout(() => void renew(), delay);
    return () => window.clearTimeout(id);
  }, [session, renew]);

  // Fenster zurueck (Tab-Wechsel, aufgewecktes Notebook): Status sofort
  // nachziehen, statt auf den naechsten Takt zu warten. Genau hier heilt die
  // Nachfrist eine inaktiv abgelaufene Sitzung ohne erneute Token-Eingabe.
  useEffect(() => {
    const onActive = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void renew();
    };
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  }, [renew]);

  // Restzeit-Anzeige alle 20 s nachziehen (kein 1-s-Ticker: das Dashboard
  // rendert ohnehin im 8-/15-s-Takt, und die Anzeige braucht keine Sekunden-
  // scharfe Uhr). Laeuft nur, waehrend eine Session aktiv ist.
  useEffect(() => {
    if (!session?.session.active) return;
    const id = window.setInterval(() => setSessionNow(Date.now()), 20_000);
    return () => window.clearInterval(id);
  }, [session]);

  // W1 (v1.36.23): Altbestand eines alten Token-Schlüssels aus dem
  // Client-Speicher entfernen (Migration, nur removeItem — nie ein Schreiben).
  useEffect(() => {
    clearLegacyFirmToken();
  }, []);

  // Ein neuer Missions-Array bedeutet noch keinen geänderten Polling-Takt.
  const hasActiveMission = useMemo(() => data.missions.some((m) => m.status === "ACTIVE"), [data.missions]);
  useFirmPolling(load, hasActiveMission);

  // „Pipeline fertig“ löst sich nach 20 s von selbst — „fehlgeschlagen“
  // bleibt sichtbar, bis die nächste Aktion kommt (Fehler nicht übersehen).
  useEffect(() => {
    if (pipeline?.phase !== "done") return;
    const id = window.setTimeout(() => setPipeline(null), 20_000);
    return () => window.clearTimeout(id);
  }, [pipeline]);

  async function seed() {
    await apiFetch("/api/seed", { method: "POST" });
    setNotice("Firm seeded with default team + mission.");
    load();
  }

  async function runAgent(agentId: string) {
    const mission = data.missions.find((m) => m.status === "ACTIVE" || m.status === "PENDING");
    if (!mission) {
      setNotice("Create/activate a mission first.");
      return;
    }
    setRunning(agentId);
    setNotice("");
    const res = await apiFetch("/api/firm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, missionId: mission.id }),
    });
    if (!(await ensureAuth(res))) { setRunning(null); return; }
    const json = await res.json();
    setRunning(null);
    if (json.ok) {
      setNotice(`Agent executed → ${json.result.status}.`);
    } else {
      setNotice(`Run failed: ${json.error ?? "unknown"}`);
    }
    load();
  }

  async function runPipeline() {
    const mission = data.missions.find((m) => m.status === "ACTIVE" || m.status === "PENDING");
    if (!mission) {
      setNotice("Keine aktive Mission. Zuerst „Seed / Reset“ klicken.");
      return;
    }
    setRunning("pipeline");
    setNotice("");
    // Statusleiste: „Pipeline gestartet“ — pulsierend hervorgehoben,
    // auch bei Neustart (setzt den Zustand zurück auf running).
    setPipeline({ phase: "running" });
    const res = await apiFetch("/api/firm/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ missionId: mission.id, pipeline: true }),
    });
    if (!(await ensureAuth(res))) { setRunning(null); setPipeline(null); return; }
    const json = await res.json();
    setRunning(null);
    if (json.ok) {
      const steps = (json.pipeline ?? [])
        .map((s: any) => `${s.role}:${s.result.status}`)
        .join(" → ");
      setPipeline({ phase: "done", detail: steps || "keine Schritte" });
    } else {
      setPipeline({ phase: "failed", detail: json.error ?? "unbekannt" });
    }
    load();
  }

  async function kill(arm: boolean) {
    // Arm (Not-Halt ziehen) bleibt Operator-tauglich (guardWrite) via apiFetch.
    if (arm) {
      const res = await apiFetch("/api/firm/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arm: true, reason: "OPERATOR_DASHBOARD", flatten: true }),
      });
      if (!(await ensureAuth(res))) return;
      setNotice("🔴 NOT-HALT AKTIV — alle Orders blockiert, offene Positionen glattgestellt.");
      load();
      return;
    }

    // Disarm (Befund C3, v1.36.15 + W1 v1.36.23): ein Operator-Token reicht
    // NICHT mehr. Erst eine Challenge holen (ADMIN `live.gate` + CSRF), dann den
    // single-use Nonce (<= 60 s) im Disarm-Body zurückgeben. Auth läuft seit W1
    // über die Session-Cookie (wird same-origin automatisch mitgesendet), der
    // CSRF-Header per Double-Submit aus `firm_csrf`.
    const authHeaders = new Headers({ "Content-Type": "application/json" });
    authHeaders.set("x-csrf-token", csrfHeaderValue());
    try {
      const chRes = await apiFetch("/api/firm/kill/challenge", {
        method: "GET",
        headers: authHeaders,
        credentials: "same-origin",
      });
      const ch = await chRes.json().catch(() => ({}));
      if (chRes.status === 401 || chRes.status === 403 || !ch?.ok || !ch?.nonce) {
        setNeedToken(true);
        setNotice("🔒 Disarm braucht Admin-Zugriff (live.gate) + gültigen Token. Operator-Token allein reicht nicht.");
        return;
      }
      const res = await apiFetch("/api/firm/kill", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ arm: false, nonce: ch.nonce, reason: "OPERATOR_DASHBOARD" }),
        credentials: "same-origin",
      });
      if (!(await ensureAuth(res))) return;
      const json = await res.json().catch(() => ({}));
      if (json?.ok) {
        setNotice("Kill-Switch entschärft (Admin + Nonce). Missionen stehen wieder auf PENDING.");
      } else {
        setNotice(`Disarm abgelehnt: ${json?.error ?? json?.hint ?? `HTTP ${res.status}`}`);
      }
    } catch {
      setNotice("Netzwerkfehler — Disarm-Challenge nicht erreichbar.");
    }
    load();
  }

  async function runTick() {
    setRunning("tick");
    const res = await apiFetch("/api/firm/tick", { method: "POST" });
    if (!(await ensureAuth(res))) { setRunning(null); return; }
    const json = await res.json();
    setRunning(null);
    if (json.ok) {
      const stops = json.stopsTriggered?.length ?? 0;
      setNotice(
        `Tick fertig — ${json.quotesRefreshed} Kurse aktualisiert, ${stops} SL/TP-Auslösungen${json.marketScan ? ", Marktscan geschrieben" : ""}${json.dailyLossKill ? ", ⚠️ Tagesverlust-Limit → Kill-Switch!" : ""}`
      );
    } else {
      setNotice(`Tick fehlgeschlagen: ${json.error ?? "unbekannt"}`);
    }
    load();
  }

  /**
   * Gemeinsamer Pfad fuer untergeordnete Lese-APIs: Auch wenn der Haupt-
   * Snapshot noch gueltig war, kann die Session zwischen zwei Requests
   * ablaufen. In diesem Fall soll der Login-Hinweis im Kopf erscheinen und
   * nicht nur ein lokaler Panel-Fehler.
   */
  const handleUnauthorized = useCallback(() => {
    setNeedToken(true);
    setNotice("🔒 Die Sitzung ist abgelaufen — bitte oben erneut anmelden.");
  }, []);

  /**
   * v1.36.41: Ein `401`/`403` beim Laden blendet das Token-Feld sofort ein —
   * auch ohne vorherige Aktion. `needToken` bleibt der manuelle Pfad
   * (Aktion abgelehnt, Logout, Anmeldung abgelehnt).
   */
  const sessionExpired = firmIssue?.needsLogin ?? false;
  /**
   * Das Token-Feld erscheint, wenn eine Aktion/Load abgelehnt wurde ODER der
   * Status eine Anmeldung verlangt (`sessionNeedsLogin`) — z. B. direkt nach
   * einem Dienst-Neustart, ohne dass erst jemand klicken muss.
   */
  const showTokenField = needToken || sessionExpired || sessionNeedsLogin(session);

  /**
   * Reiter mit Zählern: Die Zahl am Reiter beantwortet die Frage „wo passiert
   * gerade etwas?“ ohne Klick (offene Positionen, Agenten, registrierte
   * Venues). Die Beschreibungen landen als `title` am Reiter.
   */
  const tabDefs: TabDef<DashboardTab>[] = TAB_DEFS.map((def) => ({
    ...def,
    badge:
      def.id === "overview"
        ? data.account.openPositions
        : def.id === "agents"
          ? data.agents.length
          : def.id === "protocol"
            ? data.auditLog.length
            : def.id === "brokers"
              ? Object.keys(data.brokers).length
              : undefined,
  }));

  return (
    <PageShell
      eyebrow="Open-Source · Local-First · No Cloud"
      title="Autonomous AI Trading Firm"
      subtitle="Referenz-Implementierung für Ollama · PostgreSQL · Drizzle auf eigener Hardware — ausschließlich Paper-Trading."
      actions={
        <>
          <ThemeSwitcher />
          <Link href="/docs" className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-600/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">
            📖 Doku &amp; Installation
          </Link>
          <Button variant="info" onClick={() => runTick()} busy={running === "tick"} disabled={running !== null}>
            {running === "tick" ? "Tick läuft…" : "⟳ Markt-Tick"}
          </Button>
          <Button
            variant="primary"
            onClick={() => runPipeline()}
            busy={running === "pipeline"}
            disabled={running !== null}
            className={running === "pipeline" ? "animate-pulse" : undefined}
          >
            {running === "pipeline" ? "Pipeline läuft…" : "▶▶ Ganze Pipeline"}
          </Button>
          <Button variant="subtle" onClick={() => seed()}>
            Seed / Reset
          </Button>
          {data.killSwitchArmed ? (
            <Button variant="subtle" onClick={() => kill(false)} title="Not-Halt nach Admin-Challenge entschärfen">
              Disarm Kill Switch
            </Button>
          ) : (
            <Button variant="danger" onClick={() => kill(true)} title="Blockiert sofort alle neuen Orders und stellt offene Positionen glatt">
              🛑 Pull Kill Switch
            </Button>
          )}
        </>
      }
    >
      {/* Betriebsstatus in einer Zeile — die drei Aussagen, die man im
          Betrieb immer sehen will, ohne in einen Tab zu wechseln. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip tone="good" title="Es ist zu keinem Zeitpunkt echtes Kapital im Spiel">
          Paper-Trading
        </Chip>
        <Chip tone="bad" title="Live-Gate ist gesperrt — kein UI-Pfad kann das ändern (docs/LIVE_TRADING.md)">
          Live gesperrt
        </Chip>
        <Chip
          tone={data.killSwitchArmed ? "bad" : "neutral"}
          title="Kill-Switch: blockiert neue Einstiege, lässt Stop-Loss/Take-Profit und Schließen weiterlaufen"
        >
          {data.killSwitchArmed ? "Not-Halt aktiv" : "Not-Halt bereit"}
        </Chip>
        <Chip
          tone={data.scheduler.enabled ? "good" : "warn"}
          title="Hintergrund-Takt (60 s): Kurse, SL/TP, Equity-Snapshot"
        >
          {data.scheduler.enabled ? "Monitor aktiv" : "Monitor aus"}
        </Chip>
        {data.timestamp && (
          <span className="ml-auto text-xs text-slate-500">
            Stand {new Date(data.timestamp).toLocaleTimeString("de-DE")}
          </span>
        )}
      </div>

      {/* Pipeline-Statusleiste — bei laufender/neu gestarteter Pipeline
          pulsierender Emerald-Block mit Glow; nach Abschluss grün (20 s),
          bei Fehler rot und bleibend. */}
      {pipeline && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 flex items-center gap-3 rounded-xl border-2 px-4 py-3 ${
            pipeline.phase === "failed"
              ? "border-red-500/70 bg-red-500/15 shadow-[0_0_20px_-6px_var(--color-red-500)]"
              : pipeline.phase === "running"
                ? "pipeline-glow border-emerald-500/70 bg-emerald-500/10"
                : "border-emerald-500/70 bg-emerald-500/15 shadow-[0_0_20px_-6px_var(--color-emerald-500)]"
          }`}
        >
          {pipeline.phase === "running" ? (
            <span className="inline-block h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
          ) : pipeline.phase === "done" ? (
            <span className="shrink-0 text-lg leading-none text-emerald-400">✓</span>
          ) : (
            <span className="shrink-0 text-lg leading-none text-red-400">✗</span>
          )}
          <div className="min-w-0">
            <p
              className={`text-sm font-bold tracking-wide ${
                pipeline.phase === "failed" ? "text-red-300" : "text-emerald-300"
              }`}
            >
              {pipeline.phase === "running" && "⚡ Pipeline gestartet — läuft"}
              {pipeline.phase === "done" && "Pipeline fertig"}
              {pipeline.phase === "failed" && "Pipeline fehlgeschlagen"}
            </p>
            <p
              className={`mt-0.5 text-xs ${
                pipeline.phase === "failed" ? "text-red-200/80" : "text-emerald-200/70"
              }`}
            >
              {pipeline.phase === "running"
                ? "CEO → Research → Backtest → Risk → Approver → Executor …"
                : pipeline.detail}
            </p>
          </div>
        </div>
      )}

      <SessionNoticeBar
        notice={notice}
        showTokenField={showTokenField}
        tokenDraft={tokenDraft}
        onTokenDraftChange={setTokenDraft}
        onSubmit={saveToken}
        onLogout={handleLogout}
        onRenew={manualRenew}
        onShowLogin={showLoginField}
        session={session}
        statusUnavailable={sessionUnavailable}
        busy={sessionBusy}
        now={sessionNow}
      />

      {firmIssue && (
        <div className="mt-4">
          <FirmIssueBox issue={firmIssue} />
        </div>
      )}

      {/* Status strip — Raster nach Inhaltsbreite: mobil zwei Spalten,
          auf Ultrawide alle sieben nebeneinander (statt fester Stufen).
          Während des ersten Loads stehen hier Platzhalter statt Nullen: eine
          „0“ in Paper-Equity oder Drawdown wäre schlicht falsch und würde
          beim Blick auf den Bildschirm Fehlalarm auslösen. */}
      <section
        className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 3xl:grid-cols-7"
        aria-label="Betriebskennzahlen"
        aria-busy={loading}
      >
        <MetricTile
          label="Paper-Equity"
          value={`$${data.account.equity.toLocaleString()}`}
          hint="Kontostand des Paper-Depots: freies Cash + Marktwert aller offenen Positionen. Basis der Kurve im Tab „Reports“."
          loading={loading}
        />
        <MetricTile
          label="Freies Cash"
          value={`$${data.account.freeCash.toLocaleString()}`}
          hint="Nicht investiertes Guthaben. Neue Positionen können nur aus diesem Betrag finanziert werden."
          loading={loading}
        />
        <MetricTile
          label="Drawdown"
          value={`${data.account.drawdownPct.toFixed(2)} %`}
          tone={
            data.account.drawdownPct >= Number(data.riskLimits.maxEquityDrawdownPct ?? 0.15) * 100
              ? "bad"
              : "neutral"
          }
          hint={`Abstand zum Startkapital ($${Number(data.account.startingEquity).toLocaleString()}) — die Grenze für den Circuit-Breaker ist ${(Number(data.riskLimits.maxEquityDrawdownPct ?? 0.15) * 100).toFixed(0)} %. Der Drawdown vom Höchststand (Peak-to-Trough) steht im Report.`}
          loading={loading}
        />
        <MetricTile
          label="Offene Positionen"
          value={`${data.account.openPositions}`}
          hint="Aktuell gehaltene Positionen. Sie zählen mit ihrem Marktwert in die Equity."
          loading={loading}
        />
        <MetricTile
          label="Not-Halt"
          value={data.killSwitchArmed ? "AKTIV" : "sicher"}
          alarm={data.killSwitchArmed}
          hint="Kill-Switch: blockiert neue Einstiege, lässt aber Stop-Loss/Take-Profit und das Schließen offener Positionen weiterlaufen."
          loading={loading}
        />
        <MetricTile
          label="Monitor"
          value={
            !data.scheduler.enabled
              ? "aus"
              : data.scheduler.lastTickAt
                ? `Tick ${new Date(data.scheduler.lastTickAt).toLocaleTimeString("de-DE")}`
                : "wartet"
          }
          tone={data.scheduler.enabled ? "neutral" : "warn"}
          hint="Hintergrund-Takt (60 s): Kurse aktualisieren, SL/TP prüfen, Equity-Snapshot schreiben. Ohne Takt steht die Kurve still."
          loading={loading}
        />
        <MetricTile
          label="Lokales LLM"
          value={data.ollama.available ? `Ollama (${data.ollama.models.length})` : "Regel-Engine"}
          tone={data.ollama.available ? "neutral" : "warn"}
          hint="Ob ein lokales Modell über Ollama erreichbar ist. Ohne Modell entscheidet die deterministische Regel-Engine — das ist ein gültiger, nur weniger kreativer Betrieb."
          loading={loading}
        />
      </section>

      {/* Reiter — sticky, mit Pfeiltasten bedienbar, auf Mobile scrollbar. */}
      <div className="mt-5">
        <TabBar tabs={tabDefs} active={tab} onChange={selectTab} ariaLabel="Dashboard-Bereiche" />
      </div>

      {loading ? (
        // Der aktive Reiter existiert schon (sonst zeigte `aria-controls` ins
        // Leere) und trägt das Skelett; so bleibt die Reiterleiste während des
        // Ladens bedienbar statt auf einen leeren Bereich zu zeigen.
        <TabPanel id={tab} idPrefix="tab" active>
          <div className="grid gap-4 lg:grid-cols-2" aria-busy="true" role="status" aria-label="Firmenzustand wird geladen">
            <div className={`${PANEL_PADDED} h-40`}>
              <div className="h-3 w-32 rounded bg-slate-800" />
              <div className="mt-3 h-2.5 w-full rounded bg-slate-800/70" />
              <div className="mt-2 h-2.5 w-4/5 rounded bg-slate-800/70" />
            </div>
            <div className={`${PANEL_PADDED} h-40`}>
              <div className="h-3 w-24 rounded bg-slate-800" />
              <div className="mt-3 h-2.5 w-full rounded bg-slate-800/70" />
              <div className="mt-2 h-2.5 w-3/5 rounded bg-slate-800/70" />
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">Firmenzustand wird geladen …</p>
        </TabPanel>
      ) : (
        <>
          <TabPanel id="overview" active={tab === "overview"}>
            <OverviewTab data={data} />
          </TabPanel>
          <TabPanel id="reports" active={tab === "reports"}>
            <ReportsTab onUnauthorized={handleUnauthorized} />
          </TabPanel>
          <TabPanel id="protocol" active={tab === "protocol"}>
            <ProtocolTab />
          </TabPanel>
          <TabPanel id="agents" active={tab === "agents"}>
            <AgentsTab data={data} running={running} onRun={runAgent} />
          </TabPanel>
          <TabPanel id="ops" active={tab === "ops"}>
            <OperationsCenterPanel onOpenTab={selectTab} />
          </TabPanel>
          <TabPanel id="workshop" active={tab === "workshop"}>
            <WorkshopTab
              agents={data.agents}
              missions={data.missions}
              onChanged={load}
              onUnauthorized={() => {
                setNeedToken(true);
                setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN).");
              }}
              onOpenProtocol={() => selectTab("protocol")}
            />
          </TabPanel>
          <TabPanel id="brokers" active={tab === "brokers"}>
            <BrokersPanel
              onUnauthorized={() => {
                setNeedToken(true);
                setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN/FIRM_ADMIN_TOKEN).");
              }}
            />
          </TabPanel>
          <TabPanel id="risk" active={tab === "risk"}>
            <RiskTab data={data} onChanged={load} />
          </TabPanel>
          <TabPanel id="architecture" active={tab === "architecture"}>
            <ArchitectureTab />
          </TabPanel>
        </>
      )}
    </PageShell>
  );
}

/**
 * Reiter-Definitionen des Dashboards — Reihenfolge = Arbeitsablauf der Firma
 * (Überblick → Auswertung → Protokoll → Agenten → Werkstatt → Betrieb →
 * Broker → Risiko → Design). `title` erklärt den Bereich beim Überfahren.
 */
const TAB_DEFS: readonly TabDef<DashboardTab>[] = [
  { id: "overview", label: "Firm Overview", icon: "🏛", title: "Missionen, Positionen, Approval-Queue und Audit-Trail" },
  { id: "reports", label: "Reports", icon: "📊", title: "Kennzahlen je Zeitraum, Equity-Kurve, Empfehlungen" },
  { id: "protocol", label: "Protokoll", icon: "📋", title: "Agenten-Turns, Analysen und revisionssicheres Audit-Log" },
  { id: "agents", label: "Agents & Orchestrator", icon: "🤖", title: "Team, Rollen und einzelne Agenten-Turns starten" },
  { id: "workshop", label: "Workshop", icon: "🛠", title: "Missionen, Prompts, Regel-Backtests und Hit-Rate" },
  { id: "ops", label: "Operations Center", icon: "🧭", title: "Zehn Sektionen: Universum, Scanner, Portfolio, Broker, LLM, Risiko …" },
  { id: "brokers", label: "Brokers & Venues", icon: "🌐", title: "Verbindungsstatus, Berechtigungen, Coverage je Venue" },
  { id: "risk", label: "Risk & Guardrails", icon: "🛡", title: "Risikolimits, Volatilitäts-Schwellen und Kill-Switch-Historie" },
  { id: "architecture", label: "Design & Guide", icon: "📐", title: "Grundprinzip, Sicherheitsschichten, Hardware und Broker-Stand" },
];
