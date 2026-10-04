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
 *
 * Abhängigkeiten: @/lib/apiClient, @/lib/browserSession, @/lib/firmSession,
 * @/lib/types, @/components/ui/*.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
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
import type { AgentRow, MissionRow } from "@/lib/types";
import { isReportData, type ReportData } from "@/lib/reportResponse";
import { describeAuditEntry, firstSentence } from "@/lib/auditView";
import { missionScopeLabel } from "@/lib/missionTemplates";
import WorkshopTab from "./workshop/WorkshopTab";
import BrokersPanel from "./control-plane/BrokersPanel";
import OperationsCenterPanel from "./ops/OperationsCenterPanel";
import EquityPanel from "./report/EquityPanel";
import InfoTip from "./ui/InfoTip";
import DataTable from "./ui/DataTable";
import MetricTile from "./ui/MetricTile";
import Chip from "./ui/Chip";
import Button from "./ui/Button";
import TabBar, { TabPanel, type TabDef } from "./ui/Tabs";
import { PageShell } from "./ui/PageShell";
import { AUTO_FIT_CARDS, PANEL, PANEL_LARGE, PANEL_PADDED, SECTION_TITLE } from "./ui/layout";
import ThemeSwitcher from "./ThemeSwitcher";
import AuditTrailPanel from "./common/AuditTrailPanel";
import { FirmIssueBox } from "./common/FirmIssueBox";
import ProtocolPanel from "./common/ProtocolPanel";
import { SessionNoticeBar } from "./common/SessionNoticeBar";

type ConfigEntry = {
  key: string;
  label: string;
  unit: "%" | "x" | "count" | "bool" | "rr" | "idx";
  description: string;
  value: number | boolean;
  min: number;
  max: number;
  locked: boolean;
  defaultValue: number | boolean;
};

/** Zustand des adaptiven Risk-Limit-Systems (GET /api/firm/risk/volatility). */
type AdaptiveRiskStatus = {
  regime: "NORMAL" | "ELEVATED" | "EXTREME";
  enabled: boolean;
  factor: number;
  baseMaxRiskPerTrade: number;
  effectiveMaxRiskPerTrade: number;
  lastUpdate: string | null;
  lastChange: string | null;
  lastError: string | null;
  stale: boolean;
  reason: string;
  indicators: {
    name: string;
    label: string;
    value: number | null;
    threshold: number;
    available: boolean;
    triggered: boolean;
  }[];
  events: {
    at: string;
    prevRegime: string;
    regime: string;
    factor: number;
    baseMaxRiskPerTrade: number;
    effectiveMaxRiskPerTrade: number;
    triggered: string[];
    reason: string;
  }[];
  config: Record<string, number | boolean>;
  bounds: Record<string, [number, number]>;
};

type FirmData = {
  agents: AgentRow[];
  missions: MissionRow[];
  positions: any[];
  proposals: any[];
  /**
   * Letzten Audit-Zeilen aus GET /api/firm. Die Übersicht rendert inzwischen
   * den gepagten Audit-Trail über GET /api/firm/log (AuditTrailPanel) — das
   * Feld bleibt Teil des API-Vertrags für andere Clients.
   */
  auditLog: any[];
  riskLimits: Record<string, any>;
  riskDefaults: Record<string, any>;
  riskCeilings: Record<string, [number, number]>;
  riskConfig: ConfigEntry[];
  volatilityConfig: ConfigEntry[];
  adaptiveRisk: AdaptiveRiskStatus | null;
  killSwitchArmed: boolean;
  killSwitches: any[];
  messages: any[];
  ollama: { available: boolean; baseUrl: string; models: string[]; error?: string };
  scheduler: { enabled: boolean; lastTickAt: string | null };
  account: {
    equity: number;
    startingEquity: number;
    freeCash: number;
    drawdownPct: number;
    openPositions: number;
    broker: string;
    paperMode: boolean;
    livePositions: any[];
  };
  brokers: Record<string, { label: string; assets: string; paperApi: boolean; openSource: boolean; note: string }>;
  requireHumanApproval: boolean;
  timestamp: string;
};

const defaultData: FirmData = {
  agents: [], missions: [], positions: [], proposals: [],
  auditLog: [], riskLimits: {}, riskDefaults: {}, riskCeilings: {}, riskConfig: [],
  volatilityConfig: [], adaptiveRisk: null,
  killSwitchArmed: false,
  killSwitches: [], messages: [], ollama: { available: false, baseUrl: "", models: [] },
  scheduler: { enabled: false, lastTickAt: null },
  account: {
    equity: 0, startingEquity: 0, freeCash: 0, drawdownPct: 0,
    openPositions: 0, broker: "PAPER", paperMode: true, livePositions: [],
  },
  brokers: {},
  requireHumanApproval: false,
  timestamp: "",
};

type Tab = "overview" | "reports" | "protocol" | "agents" | "workshop" | "ops" | "brokers" | "risk" | "architecture";


export default function FirmDashboard() {
  const [data, setData] = useState<FirmData>(defaultData);
  const [tab, setTab] = useState<Tab>("overview");
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

  // auto-refresh every 8s while running, else 15s
  useEffect(() => {
    const id = setInterval(load, data.missions.some((m) => m.status === "ACTIVE") ? 8000 : 15000);
    return () => clearInterval(id);
  }, [load, data.missions]);

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
      const chRes = await fetch("/api/firm/kill/challenge", {
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
      const res = await fetch("/api/firm/kill", {
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
  const tabDefs: TabDef<Tab>[] = TAB_DEFS.map((def) => ({
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
        <TabBar tabs={tabDefs} active={tab} onChange={setTab} ariaLabel="Dashboard-Bereiche" />
      </div>

      {loading ? (
        // Der aktive Reiter existiert schon (sonst zeigte `aria-controls` ins
        // Leere) und trägt das Skelett; so bleibt die Reiterleiste während des
        // Ladens bedienbar statt auf einen leeren Bereich zu zeigen.
        <TabPanel id={tab} idPrefix="tab">
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
          <TabPanel id="overview">
            <OverviewTab data={data} />
          </TabPanel>
          <TabPanel id="reports">
            <ReportsTab onUnauthorized={handleUnauthorized} />
          </TabPanel>
          <TabPanel id="protocol">
            <ProtocolTab />
          </TabPanel>
          <TabPanel id="agents">
            <AgentsTab data={data} running={running} onRun={runAgent} />
          </TabPanel>
          <TabPanel id="ops">
            <OperationsCenterPanel onOpenTab={(target) => setTab(target as Tab)} />
          </TabPanel>
          <TabPanel id="workshop">
            <WorkshopTab
              agents={data.agents}
              missions={data.missions}
              onChanged={load}
              onUnauthorized={() => {
                setNeedToken(true);
                setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN).");
              }}
              onOpenProtocol={() => setTab("protocol")}
            />
          </TabPanel>
          <TabPanel id="brokers">
            <BrokersPanel
              onUnauthorized={() => {
                setNeedToken(true);
                setNotice("🔒 Diese Aktion braucht den API-Token (FIRM_API_TOKEN/FIRM_ADMIN_TOKEN).");
              }}
            />
          </TabPanel>
          <TabPanel id="risk">
            <RiskTab data={data} onChanged={load} />
          </TabPanel>
          <TabPanel id="architecture">
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
const TAB_DEFS: readonly TabDef<Tab>[] = [
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

/**
 * Überblick: Missionen, Positionen, Approval-Queue, Audit-Trail.
 *
 * Anordnung seit v0.15.0 nach Informationswert statt nach Eingangsreihenfolge:
 * Die **Positionen** stehen zuerst und über die volle Breite (10 Spalten,
 * auf Ultrawide ohne Umbruch lesbar), darunter **Missionen** und
 * **Approval-Queue** nebeneinander — das sind die beiden Listen, die man
 * beim Durchsehen vergleicht. Der Audit-Trail bleibt am Ende (Detailtiefe).
 */
function OverviewTab({ data }: { data: FirmData }) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className={SECTION_TITLE}>
          Positionen
          <InfoTip
            label="Positionen"
            text="Alle vom Executor eröffneten Positionen inklusive Marktwert, Stop-Loss, Take-Profit und schwebendem P&L. Gezeigt werden die ersten 15 Datensätze."
          />
        </h2>
        <DataTable
          label="Positionen"
          maxHeight="70vh"
          stickyHead
          head={["Status", "Symbol", "Side", "Menge", "Einstieg", "SL", "TP", "Kurs", "PnL", "Exit-Grund"]}
          empty="Keine Positionen. Pipeline oder Executor gegen eine aktive Mission laufen lassen."
          rows={data.positions.slice(0, 15).map((p) => [
            p.status,
            <span key={`${p.id}-symbol`} className="font-semibold text-slate-200">{p.symbol}</span>,
            p.side,
            p.qty,
            p.entryPrice,
            p.stopLoss ?? "—",
            p.takeProfit ?? "—",
            p.lastPrice ?? "—",
            <span
              key={p.id}
              className={(Number(p.unrealizedPnl) >= 0 ? "text-emerald-400" : "text-red-400") + " font-semibold tabular-nums"}
            >
              {(Number(p.unrealizedPnl) >= 0 ? "+" : "") + Number(p.unrealizedPnl).toFixed(2)}
            </span>,
            p.exitReason ?? "—",
          ])}
        />
      </section>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section>
          <h2 className={SECTION_TITLE}>Missionen</h2>
          <DataTable
            label="Missionen"
            head={["Titel", "Ziel", "Symbol / Segment", "Risikobudget", "Status"]}
            empty="Keine Mission angelegt — „Seed / Reset“ im Kopfbereich legt das Standard-Team an."
            rows={data.missions.map((m) => [
              <span key={m.id} className="font-semibold text-slate-200">{m.title}</span>,
              // Auf Wortgrenze gekürzt, vollständiger Text im Tooltip — kein harter Schnitt mitten im Wort.
              <span key={`${m.id}-objective`} title={m.objective} className="block">
                {firstSentence(m.objective, 120)}
              </span>,
              // Missions-Typ (v1.35.0): Einzel-Symbol oder „Markt-Scan: <Segment>“.
              <span key={`${m.id}-scope`} title={m.symbol ?? missionScopeLabel(m)}>
                {missionScopeLabel(m)}
              </span>,
              `${(Number(m.riskBudget) * 100).toFixed(0)} %`,
              <Chip key={`${m.id}-status`} tone={m.status === "ACTIVE" ? "good" : "neutral"}>
                {m.status}
              </Chip>,
            ])}
          />
        </section>

        <section>
          <h2 className={SECTION_TITLE}>Approval Queue</h2>
          <DataTable
            label="Approval Queue"
            head={["Aktion", "Vorgeschlagene Order", "Risiko-Score", "Status"]}
            empty="Keine offenen Vorschläge."
            rows={data.proposals.map((p) => {
              const detail = p.proposedDetail ?? {};
              const summary = [
                detail.symbol ? String(detail.symbol) : null,
                detail.side ? String(detail.side).toUpperCase() : null,
                detail.reason ? String(detail.reason) : null,
              ]
                .filter((part): part is string => Boolean(part))
                .join(" · ");
              return [
                p.action,
                <details key={p.id}>
                  <summary className="cursor-pointer text-slate-300">
                    {summary || "Details anzeigen"}
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-xs text-slate-300">
                    {JSON.stringify(detail, null, 2)}
                  </pre>
                </details>,
                p.riskScore,
                <Chip key={`${p.id}-status`} tone="info">{p.status}</Chip>,
              ];
            })}
          />
        </section>
      </div>

      {/* Audit-Trail: aufklappbar, vollständig geparst, mit Paging (20/50/100/200). */}
      <AuditTrailPanel
        title="Audit Trail"
        hint="Alle revisionssicheren Ereignisse — aufklappbar mit lesbaren Details, logischer Bewertung und Rohdaten."
      />
    </div>
  );
}

// ───────────────────────── Reports (Boss-Sicht) ─────────────────────────────

/** Zeiträume der Report-Kennzahlen (Berliner Kalendergrenzen, siehe @/lib/time). */
type PeriodId = "day" | "week" | "month" | "quarter" | "halfyear" | "year";

const PERIOD_OPTIONS: { id: PeriodId; label: string; title: string }[] = [
  { id: "day", label: "Heute", title: "Heutiger Berliner Kalendertag ab 00:00" },
  { id: "week", label: "Woche", title: "Diese Woche ab Montag 00:00 (Berliner Zeit)" },
  { id: "month", label: "Monat", title: "Dieser Monat ab dem 1. um 00:00 (Berliner Zeit)" },
  { id: "quarter", label: "Quartal", title: "Dieses Quartal ab 1. Jan/Apr/Jul/Okt" },
  { id: "halfyear", label: "Halbjahr", title: "Dieses Halbjahr ab 1. Januar bzw. 1. Juli" },
  { id: "year", label: "Jahr", title: "Dieses Kalenderjahr ab 1. Januar" },
];

/**
 * Reports-Tab (Führungssicht). Links die Kennzahlen des Zeitraums (aus
 * `GET /api/firm/report`), darunter das eigenständige Kurven-Panel
 * (`EquityPanel`) mit eigenem Zeitraum-Schalter, Drawdown-Verlauf,
 * Trade-Markern und Export.
 */
function ReportsTab({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [period, setPeriod] = useState<PeriodId>("day");
  const [report, setReport] = useState<ReportData | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [loadingRep, setLoadingRep] = useState(true);

  useEffect(() => {
    let alive = true;
    // async booten (kein synchrones setState im Effect)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/firm/report?period=${period}`, { cache: "no-store" });
        const json: unknown = await res.json().catch(() => null);
        if (!alive) return;

        if (res.status === 401) {
          onUnauthorized?.();
        }
        if (!res.ok) {
          const body = json && typeof json === "object" ? (json as { error?: unknown }) : null;
          const detail = typeof body?.error === "string" && body.error.trim().length > 0
            ? body.error.trim()
            : `HTTP ${res.status}`;
          setReport(null);
          setReportError(
            res.status === 401
              ? "Nicht angemeldet — bitte die Sitzung im Kopfbereich des Dashboards erneuern."
              : `Report konnte nicht geladen werden (${detail}).`
          );
          return;
        }
        if (!isReportData(json)) {
          // Fehlerantworten duerfen nie in den Report-State gelangen: Die
          // Darstellung mappt mehrere Listen und wuerde sonst z. B. mit
          // `undefined.length` abbrechen.
          setReport(null);
          setReportError("Unerwartete Antwort von GET /api/firm/report.");
          return;
        }
        setReport(json);
        setReportError(null);
      } catch {
        if (alive) {
          setReport(null);
          setReportError("Report konnte wegen eines Netzwerkfehlers nicht geladen werden.");
        }
      } finally {
        if (alive) setLoadingRep(false);
      }
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [onUnauthorized, period]);

  const k = report?.kpis;
  const pct = (v: number | null | undefined, digits = 2) =>
    v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)} %`;
  const money = (v: number | null | undefined) =>
    v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
  // "fresh" kommt serverseitig aus der Report-API (kein Date.now() im Render).

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Kennzahlen-Zeitraum</span>
        {PERIOD_OPTIONS.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.title}
            aria-pressed={period === p.id}
            onClick={() => setPeriod(p.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              period === p.id ? "bg-emerald-500 text-slate-950" : "border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
            }`}
          >
            {p.label}
          </button>
        ))}
        {report && (
          <span className="ml-auto self-center text-xs text-slate-500">
            ab {new Date(report.since).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} (Europe/Berlin)
          </span>
        )}
      </div>

      {reportError && (
        <p role="alert" className="rounded-xl border border-amber-700/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
          {reportError}
        </p>
      )}

      {/* Boss-Zusammenfassung */}
      {report && report.summary.length > 0 && (
        <section className="rounded-xl border border-emerald-700/40 bg-emerald-950/20 p-5">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-emerald-300">📌 Lagebild für die Führung</h2>
          <ul className="ml-4 list-disc space-y-1 text-sm text-emerald-50/90">
            {report.summary.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </section>
      )}

      {/* KPI-Kacheln: Ergebnis */}
      {k && (
        <section>
          <h2 className={`mb-2 ${SECTION_TITLE}`}>
            Ergebnis (abgeschlossene Trades)
            <InfoTip
              label="Ergebnis"
              text="Alle Kacheln dieser Zeile beziehen sich auf Trades, die im gewählten Zeitraum geschlossen wurden. Schwebende Positionen zählen erst nach dem Schließen."
            />
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 3xl:grid-cols-6">
            <MetricTile
              label="Trades"
              value={String(k.trades)}
              hint="Anzahl geschlossener Positionen im Zeitraum (nicht die offenen)."
              sub={k.avgHoldHours != null ? `Ø Haltedauer ${k.avgHoldHours.toFixed(1)} h` : undefined}
            />
            <MetricTile
              label="Realisiertes P&L"
              value={money(k.realizedPnl)}
              tone={k.realizedPnl > 0 ? "good" : k.realizedPnl < 0 ? "bad" : undefined}
              hint="Summe des realisierten Gewinns/Verlusts aller geschlossenen Trades im Zeitraum (Kontowährung, ohne schwebende Positionen)."
              sub={
                k.grossProfit != null && k.grossLoss != null
                  ? `Gewinne +${k.grossProfit.toFixed(2)} · Verluste −${k.grossLoss.toFixed(2)}`
                  : undefined
              }
            />
            <MetricTile
              label="Trefferquote"
              value={k.winRate != null ? `${k.winRate} %` : "—"}
              tone={k.winRate != null && k.winRate >= 50 ? "good" : k.winRate != null ? "bad" : undefined}
              hint="Anteil der Trades mit positivem realisiertem P&L. Eine hohe Trefferquote allein sagt nichts über die Profitabilität — dafür sind Profit-Faktor und Erwartungswert da."
              sub={k.trades > 0 ? `${Math.round((k.winRate ?? 0) / 100 * k.trades)} von ${k.trades} gewonnen` : undefined}
            />
            <MetricTile
              label="Profit-Faktor"
              value={k.profitFactor != null ? (k.profitFactor === Infinity ? "∞" : k.profitFactor.toFixed(2)) : "—"}
              tone={k.profitFactor != null && k.profitFactor >= 1.5 ? "good" : k.profitFactor != null && k.profitFactor < 1 ? "bad" : undefined}
              hint="Bruttogewinne ÷ Bruttoverluste. > 1 ist profitabel, < 1 verliert Geld; ∞ heißt: es gab keinen Verlusttrade."
            />
            <MetricTile
              label="Erwartungswert / Trade"
              value={money(k.expectancy ?? null)}
              tone={k.expectancy != null && k.expectancy > 0 ? "good" : k.expectancy != null && k.expectancy < 0 ? "bad" : undefined}
              hint="Durchschnittlicher Gewinn/Verlust je Trade. Die pragmatischste Kennzahl: positiv heißt, das System verdient pro Trade Geld."
              sub={k.payoffRatio != null ? `Gewinn/Verlust-Verhältnis ${k.payoffRatio.toFixed(2)}` : undefined}
            />
            <MetricTile
              label="Max. Drawdown"
              value={k.maxDrawdownPct != null ? `−${k.maxDrawdownPct.toFixed(2)} %` : "—"}
              tone={k.maxDrawdownPct > 10 ? "bad" : undefined}
              hint="Größter Rückgang des Kontostands vom bisherigen Höchststand (Peak-to-Trough) im Zeitraum — aus den Equity-Snapshots, nicht aus der P&L-Summe. Der Höchststand vor dem Zeitraum zählt mit."
              sub={
                k.maxDrawdownFrom && k.maxDrawdownTo
                  ? `${new Date(k.maxDrawdownFrom).toLocaleDateString("de-DE")} → ${new Date(k.maxDrawdownTo).toLocaleDateString("de-DE")}`
                  : "kein Rückgang im Zeitraum"
              }
            />
            <MetricTile
              label="Aktueller Drawdown"
              value={pct(-(k.currentDrawdownPct ?? 0))}
              tone={(k.currentDrawdownPct ?? 0) > 0 ? "bad" : "good"}
              hint="Abstand zum laufenden Höchststand (High-Water-Mark) am Ende des Zeitraums. 0 % = das Konto steht auf oder über seinem Hoch."
              sub={k.recoveredAt ? `erholt am ${new Date(k.recoveredAt).toLocaleDateString("de-DE")}` : (k.maxDrawdownPct ?? 0) > 0 ? "noch nicht erholt" : undefined}
            />
            <MetricTile
              label="Serien"
              value={`${k.maxWinStreak ?? 0} / ${k.maxLossStreak ?? 0}`}
              hint="Längste Gewinnserie / längste Verlustserie in Trades. Verlustserien sind der Realitätstest für die Nerven — und für den Circuit-Breaker."
              sub="Gewinne / Verluste in Folge"
            />
            <MetricTile
              label="Stops ausgelöst"
              value={String(k.stopLossHits)}
              tone={k.stopLossHits > 0 ? "bad" : undefined}
              hint="Trades, die über den Stop-Loss beendet wurden. Viele Stops ohne Take-Profits deuten auf zu enge Stops oder ein unpassendes Regime."
            />
            <MetricTile
              label="TPs erreicht"
              value={String(k.takeProfitHits)}
              tone={k.takeProfitHits > 0 ? "good" : undefined}
              hint="Trades, die über das Take-Profit-Ziel beendet wurden."
            />
            <MetricTile
              label="Bester / schwächster Trade"
              value={
                k.bestTrade && k.worstTrade
                  ? `${money(k.bestTrade.pnl)} / ${money(k.worstTrade.pnl)}`
                  : "—"
              }
              hint="Größter Einzelgewinn und größter Einzelverlust im Zeitraum (Symbol in der Unterzeile)."
              sub={
                k.bestTrade && k.worstTrade
                  ? `${k.bestTrade.symbol} · ${k.worstTrade.symbol}`
                  : undefined
              }
            />
          </div>
        </section>
      )}

      {/* Equity-Kurve: eigenes Panel mit Zeiträumen, Drawdown, Markern, Export */}
      <EquityPanel />

      {loadingRep && !report && (
        <p className="text-sm text-slate-400">Lade Report-Kennzahlen…</p>
      )}

      {/* Empfehlungen des Hauses */}
      {report && report.recommendations.length > 0 && (
        <section>
          <h2 className={`mb-2 ${SECTION_TITLE}`}>
            💡 Empfehlungen des Hauses
          </h2>
          <div className={AUTO_FIT_CARDS}>
            {(report?.recommendations ?? []).map((r, i) => {
              return (
                <div key={i} className={`${PANEL} p-4`}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-100">{r.symbol}</span>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                      r.side === "LONG" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                    }`}>
                      {r.side}
                    </span>
                    {r.horizon && <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[11px] text-sky-300">{r.horizon}</span>}
                    {!r.fresh && <span className="text-[11px] text-amber-400">⚠️ älter als 24 h</span>}
                    <span className="ml-auto text-xs text-slate-500">{r.role}</span>
                  </div>
                  {r.thesis && <p className="mt-1 text-xs text-slate-300">{r.thesis}</p>}
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-400">
                    {r.entryZone && <span>Einstieg: <b className="text-slate-200">{r.entryZone}</b></span>}
                    {r.stopLoss && <span>Stop: <b className="text-red-300">{r.stopLoss}</b></span>}
                    {r.target && <span>Ziel: <b className="text-emerald-300">{r.target}</b></span>}
                    {typeof r.confidence === "number" && <span>Konfidenz: {(r.confidence * 100).toFixed(0)} %</span>}
                  </div>
                  {r.riskFlags && r.riskFlags.length > 0 && (
                    <p className="mt-1 text-xs text-amber-400">⚠️ Risiken: {r.riskFlags.join(", ")}</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Symbol-Breakdown + Blocks */}
      {report && (
        <section className="grid gap-6 xl:grid-cols-2">
          <div>
            <h2 className={`mb-2 ${SECTION_TITLE}`}>Pro Symbol</h2>
            <DataTable
              label="Ergebnis pro Symbol"
              head={["Symbol", "Trades", "Gewinner", "P&L"]}
              empty="Keine geschlossenen Trades im Zeitraum."
              rows={report.symbols.map((s) => [
                s.symbol,
                s.trades,
                `${s.wins}/${s.trades}`,
                <span key={s.symbol} className={(s.pnl >= 0 ? "text-emerald-400" : "text-red-400") + " font-semibold tabular-nums"}>
                  {(s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2)}
                </span>,
              ])}
            />
          </div>
          <div>
            <h2 className={`mb-2 ${SECTION_TITLE}`}>Blöcke & Gründe</h2>
            <DataTable
              label="Blockierte Orders und Gründe"
              head={["Grund", "Anzahl", "Bedeutung"]}
              empty="Keine blockierten Orders im Zeitraum."
              rows={report.blocks.map((b) => [
                <code key={b.reason} className="font-mono text-xs text-amber-300">{b.reason}</code>,
                b.count,
                b.explanation ?? "—",
              ])}
            />
          </div>
        </section>
      )}

      {/* Bemerkenswerte Ereignisse */}
      {report && report.notableEvents.length > 0 && (
        <section>
          <h2 className={`mb-2 ${SECTION_TITLE}`}>
            Wichtige Ereignisse (SL/TP, Kill-Switch, Konfiguration)
          </h2>
          <DataTable
            label="Wichtige Ereignisse im Zeitraum"
            head={["Zeit", "Ereignis", "Stufe", "Was ist passiert?"]}
            rows={report.notableEvents.map((e) => {
              // Derselbe Aufbereiter wie im Audit-Trail — keine abgeschnittene JSON.
              const view = describeAuditEntry({
                id: `${e.event}-${e.at}`,
                createdAt: e.at,
                event: e.event,
                level: e.level,
                detail: e.detail,
              });
              return [
                <span key={`${e.event}-${e.at}-at`} className="whitespace-nowrap tabular-nums">
                  {view.atLabel}
                </span>,
                <span key={`${e.event}-${e.at}-event`}>
                  <span className="block font-semibold text-slate-200">{view.eventLabel}</span>
                  <code className="text-xs text-slate-500">{e.event}</code>
                </span>,
                <span
                  key={`${e.event}-${e.at}-level`}
                  className={
                    view.tone === "critical"
                      ? "font-bold text-red-400"
                      : view.tone === "warn"
                        ? "text-amber-300"
                        : "text-emerald-300"
                  }
                >
                  {view.levelLabel}
                </span>,
                <details key={`${e.event}-${e.at}-detail`} className="max-w-xl">
                  <summary className="cursor-pointer text-slate-300">{view.headline}</summary>
                  <p className="mt-1 text-xs text-slate-400">{view.explanation}</p>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 p-2 font-mono text-xs text-slate-300">
                    {view.raw}
                  </pre>
                </details>,
              ];
            })}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Protokoll-Tab: Zwei unabhängige, aber identisch aufgebaute Bereiche.
 *
 * Beide nutzen dasselbe Paging-System (20/50/100/200 pro Seite, Default 20),
 * dieselbe aufklappbare Kartenstruktur und denselben „Rohdaten"-Reiter.
 * Die komplette Aufbereitung (deutsche Titel, Feldlabels, Plausibilitätsprüfung)
 * liegt in src/lib/auditView.ts — server- und clientseitig identisch.
 */
function ProtocolTab() {
  return (
    <div className="space-y-6">
      <ProtocolPanel />
      <AuditTrailPanel
        title="Audit-Trail"
        hint="Revisionssichere Ereignisse: jede Order, jede Entscheidung, jede Risiko- und Regeländerung."
      />
    </div>
  );
}

function AgentsTab({
  data,
  running,
  onRun,
}: {
  data: FirmData;
  running: string | null;
  onRun: (id: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4">
      {data.agents.map((a) => (
        <div key={a.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-100">{a.name}</h3>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${
                a.status === "RUNNING"
                  ? "bg-amber-500/20 text-amber-300"
                  : a.status === "BLOCKED"
                  ? "bg-red-500/20 text-red-300"
                  : "bg-emerald-500/20 text-emerald-300"
              }`}
            >
              {a.status}
            </span>
          </div>
          <p className="mb-1 text-xs font-semibold text-emerald-400">{a.role}</p>
          <p className="mb-1 text-xs text-slate-500">Model: {a.model}</p>
          <p className="mb-3 line-clamp-3 text-xs text-slate-400">{a.systemPrompt}</p>
          <button
            onClick={() => onRun(a.id)}
            disabled={running === a.id}
            className="w-full rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-600 disabled:opacity-50"
          >
            {running === a.id ? "Thinking…" : "▶ Run one turn"}
          </button>
        </div>
      ))}
    </div>
  );
}

function AdaptiveRiskPanel({ data }: { data: FirmData }) {
  const a = data.adaptiveRisk;
  const regimeStyle: Record<string, string> = {
    NORMAL: "bg-emerald-500/20 text-emerald-300 border-emerald-700/50",
    ELEVATED: "bg-amber-500/20 text-amber-300 border-amber-700/50",
    EXTREME: "bg-red-500/20 text-red-300 border-red-700/50",
  };
  const regimeLabel: Record<string, string> = {
    NORMAL: "Normal",
    ELEVATED: "Erhöhte Volatilität",
    EXTREME: "Extreme Volatilität",
  };

  return (
    <section>
      <h2 className={`mb-2 ${SECTION_TITLE}`}>
        Adaptives Risiko — volatilitätsgetriebene Limit-Anpassung
      </h2>
      {!a ? (
        <div className={`${PANEL} p-4`}>
          <p className="text-sm text-slate-400">
            Noch keine Bewertung. Der nächste Monitor-Tick (≈60 s) startet das adaptive
            System automatisch — oder löse manuell aus via{" "}
            <code className="rounded bg-slate-800 px-1 py-0.5 text-xs text-slate-200">
              POST /api/firm/risk/volatility
            </code>
            .
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 3xl:grid-cols-3">
          {/* Regime + wirksames Limit */}
          <div className={`${PANEL} p-4`}>
            <div className="mb-3 flex items-center justify-between">
              <span className={`rounded-full border px-3 py-1 text-xs font-bold uppercase tracking-wide ${regimeStyle[a.regime] ?? regimeStyle.NORMAL}`}>
                {regimeLabel[a.regime] ?? a.regime}
              </span>
              {a.stale && (
                <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">stale</span>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <p className="text-slate-400">
                maxRiskPerTrade:{" "}
                <span className="font-mono text-slate-500 line-through">
                  {(a.baseMaxRiskPerTrade * 100).toFixed(2)} %
                </span>{" "}
                → <span className="font-mono font-bold text-emerald-300">{(a.effectiveMaxRiskPerTrade * 100).toFixed(2)} %</span>
              </p>
              <p className="text-xs text-slate-500">Faktor {a.factor} · Basis {a.baseMaxRiskPerTrade}</p>
              <p className="text-xs text-slate-400">{a.reason}</p>
              {a.lastUpdate && (
                <p className="pt-1 text-xs text-slate-500">
                  Aktualisiert {new Date(a.lastUpdate).toLocaleTimeString()}
                  {a.lastChange && a.lastChange !== a.lastUpdate ? ` · letzte Änderung ${new Date(a.lastChange).toLocaleTimeString()}` : ""}
                </p>
              )}
              {a.lastError && <p className="text-xs text-amber-400">Quelle: {a.lastError}</p>}
            </div>
          </div>

          {/* Indikatoren */}
          <div className={`${PANEL} p-4`}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Indikatoren</h3>
            <DataTable
              label="Volatilitäts-Indikatoren und Schwellen"
              className="-mx-1"
              stack={false}
              head={["Indikator", "Wert", "Schwelle", "Status"]}
              align={["left", "right", "right", "right"]}
              empty="Keine Indikatoren gemeldet."
              rows={a.indicators.map((ind) => [
                <span key={`${ind.name}-name`} className="font-medium text-slate-300">{ind.name}</span>,
                <span key={`${ind.name}-value`} className="font-mono tabular-nums text-slate-400">
                  {ind.value != null
                    ? ind.name === "VIX" ? ind.value.toFixed(1) : `${(ind.value * 100).toFixed(2)} %`
                    : "n/v"}
                </span>,
                <span key={`${ind.name}-threshold`} className="font-mono text-slate-500">
                  {ind.name === "VIX" ? ind.threshold : `${(ind.threshold * 100).toFixed(2)} %`}
                </span>,
                !ind.available ? (
                  <span key={`${ind.name}-state`} className="text-slate-600">nicht verfügbar</span>
                ) : ind.triggered ? (
                  <span key={`${ind.name}-state`} className="font-bold text-amber-300">⚠ ausgelöst</span>
                ) : (
                  <span key={`${ind.name}-state`} className="text-emerald-400">✓ unter Schwelle</span>
                ),
              ])}
            />
          </div>

          {/* Letztes Event */}
          <div className={`${PANEL} p-4`}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Letztes Trigger-Event</h3>
            {a.events.length === 0 ? (
              <p className="text-xs text-slate-500">Keine Ereignisse seit Prozessstart.</p>
            ) : (
              (() => {
                const e = a.events[0];
                return (
                  <div className="space-y-1 text-xs text-slate-400">
                    <p>
                      <span className="font-mono text-slate-500">{e.prevRegime}</span> →{" "}
                      <span className="font-bold text-slate-200">{e.regime}</span>{" "}
                      <span className="font-mono">
                        ({(e.baseMaxRiskPerTrade * 100).toFixed(2)} % → {(e.effectiveMaxRiskPerTrade * 100).toFixed(2)} %)
                      </span>
                    </p>
                    <p className="text-slate-300">{e.reason}</p>
                    <p className="text-slate-600">
                      {new Date(e.at).toLocaleString()}
                      {e.triggered.length > 0 && ` · Trigger: ${e.triggered.join(", ")}`}
                    </p>
                  </div>
                );
              })()
            )}
            <p className="mt-3 text-xs text-slate-600">
              Vollständige Historie: <code className="text-slate-500">GET /api/firm/risk/volatility</code> und
              Audit-Log <code className="text-slate-500">RISK_ADAPTIVE</code>.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

type VolSectionProps = {
  data: FirmData;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saving: string | null;
  save: (key: string, raw: string) => void;
};

/**
 * Volatilitäts-Schwellen & Faktoren (Runtime-Konfiguration).
 *
 * Wie die Risikotabelle: viele Spalten mit Eingabefeldern, deshalb `stack={false}`
 * — auf schmalen Bildschirmen scrollt die Tabelle horizontal, statt Zeilen in
 * Karten zu verwandeln, in denen Eingabefeld und Bedeutung auseinanderfallen.
 */
function VolatilityConfigSection(props: VolSectionProps) {
  const { data, drafts, setDrafts, saving, save } = props;
  const rows = data.volatilityConfig ?? [];
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className={`mb-2 ${SECTION_TITLE}`}>
        Volatilitäts-Schwellwerte &amp; Faktoren — zur Laufzeit änderbar
      </h2>
      <DataTable
        label="Volatilitäts-Konfiguration"
        stack={false}
        stickyHead
        maxHeight="70vh"
        head={["Parameter", "Wirksam", "Fenster", "Ändern", "Bedeutung"]}
        rows={rows.map((c) => {
          const isPct = c.unit === "%";
          const isBool = c.unit === "bool";
          const fmtVal = isBool
            ? (c.value ? "an" : "aus")
            : isPct
              ? `${(Number(c.value) * 100).toFixed(2)} %`
              : String(c.value);
          const fmtBound = (v: number) => (isPct ? `${v * 100}%` : String(v));
          const draft = drafts[c.key] ?? "";
          return [
            <span key={`${c.key}-label`} className="font-medium text-slate-200">{c.label}</span>,
            <span key={`${c.key}-value`} className="font-bold tabular-nums text-emerald-300">{fmtVal}</span>,
            <span key={`${c.key}-bounds`} className="text-xs tabular-nums text-slate-500">
              {fmtBound(c.min)} – {fmtBound(c.max)}
            </span>,
            c.locked ? (
              <span key={`${c.key}-locked`} className="text-xs text-slate-500">🔒 gesperrt</span>
            ) : (
              <div key={`${c.key}-editor`} className="flex items-center gap-1">
                <input
                  type="number"
                  step="any"
                  aria-label={`${c.label} neuer Wert`}
                  placeholder={String(typeof c.value === "number" && isPct ? (Number(c.value) * 100).toFixed(2) : c.value)}
                  value={draft}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && draft !== "" && save(c.key, draft)}
                  className={`w-28 rounded border bg-slate-800 px-2 py-1 text-xs text-slate-200 ${
                    draft !== "" && Number(draft.replace(",", ".")) > (isPct ? c.max * 100 : c.max)
                      ? "border-red-600"
                      : "border-slate-700"
                  }`}
                />
                {isPct && <span className="text-xs text-slate-500">%</span>}
                <Button
                  variant="primary"
                  size="sm"
                  aria-label={`${c.label} speichern`}
                  onClick={() => draft !== "" && save(c.key, draft)}
                  disabled={saving === c.key || draft === ""}
                >
                  ✓
                </Button>
              </div>
            ),
            <span key={`${c.key}-description`} className="text-xs text-slate-400">{c.description}</span>,
          ];
        })}
      />
      <p className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
        Werte wirken ab dem nächsten Turn/Tick ohne Neustart. Jede Änderung landet revisionssicher
        im Audit-Log (<code className="font-mono">CONFIG_CHANGED</code>). Die absoluten Grenzen
        (<code className="font-mono">LIMIT_CEILINGS</code> in <code className="font-mono">riskGuard.ts</code>)
        bleiben im kompilierten Code — auch eine kompromittierte Datenbank kann sie nicht aufweichen.
        Prozentwerte werden als Zahl eingegeben (z. B. 30 für 30 %).
      </p>
    </section>
  );
}

function RiskTab({ data, onChanged }: { data: FirmData; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const allConfig = [...data.riskConfig, ...(data.volatilityConfig ?? [])];

  async function save(key: string, rawValue: string) {
    setSaving(key);
    setMsg("");
    const entry = allConfig.find((c) => c.key === key);
    const num =
      entry?.unit === "bool" ? (rawValue === "true" || rawValue === "1" ? 1 : 0) : Number(rawValue.replace(",", "."));
    const res = await apiFetch("/api/firm/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value: num }),
    });
    if (res.status === 401) {
      setMsg("🔒 Aktion blockiert: FIRM_API_TOKEN ist aktiv und der Browser hat keinen gültigen Token (erst im Haupt-Tab oben hinterlegen).");
      setSaving(null);
      return;
    }
    const json = await res.json();
    setSaving(null);
    if (json.ok) {
      setMsg(`${key} gesetzt auf ${json.effective}${json.effective !== num ? ` (Eingabe ${num} wurde vom Code-Fenster geklemmt)` : ""}`);
      setDrafts((d) => ({ ...d, [key]: "" }));
      onChanged();
    } else {
      setMsg(`Fehler bei ${key}: ${json.error}`);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className={`mb-2 ${SECTION_TITLE}`}>
          Risikokonfiguration — zur Laufzeit änderbar, im Code begrenzt
        </h2>
        <DataTable
          label="Risikokonfiguration"
          stack={false}
          stickyHead
          maxHeight="70vh"
          head={["Limit", "Wirksam", "Erlaubtes Fenster", "Ändern", "Bedeutung"]}
          rows={data.riskConfig.map((c) => {
            const isPct = c.unit === "%";
            const fmtVal = typeof c.value === "boolean"
              ? (c.value ? "ja" : "nein")
              : isPct
                ? `${(Number(c.value) * 100).toFixed(1)} %`
                : String(c.value);
            const fmtBound = (v: number) => (isPct ? `${v * 100}%` : v);
            const draft = drafts[c.key] ?? "";
            return [
              <span key={`${c.key}-label`} className="font-medium text-slate-200">{c.label}</span>,
              <span key={`${c.key}-value`} className="font-bold tabular-nums text-emerald-300">{fmtVal}</span>,
              <span key={`${c.key}-bounds`} className="text-xs tabular-nums text-slate-500">
                {fmtBound(c.min)} – {fmtBound(c.max)}
              </span>,
              c.locked ? (
                <span key={`${c.key}-locked`} className="text-xs text-slate-500">🔒 gesperrt</span>
              ) : (
                <div key={`${c.key}-editor`} className="flex items-center gap-1">
                  {c.unit === "bool" ? (
                    <select
                      aria-label={`${c.label} umschalten`}
                      value={String(c.value)}
                      onChange={(e) => save(c.key, e.target.value)}
                      disabled={saving === c.key}
                      className="w-24 rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-xs text-slate-200"
                    >
                      <option value={typeof c.value === "boolean" ? String(c.value) : String(Number(c.value) >= 0.5)}>
                        aktuell
                      </option>
                      <option value="1">an</option>
                      <option value="0">aus</option>
                    </select>
                  ) : (
                    <>
                      <input
                        type="number"
                        step="any"
                        aria-label={`${c.label} neuer Wert`}
                        placeholder={String(typeof c.value === "number" && isPct ? (Number(c.value) * 100).toFixed(1) : c.value)}
                        value={draft}
                        onChange={(e) => setDrafts((d) => ({ ...d, [c.key]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && draft !== "" && save(c.key, draft)}
                        className={`w-28 rounded border bg-slate-800 px-2 py-1 text-xs text-slate-200 ${
                          draft !== "" && Number(draft.replace(",", ".")) > (isPct ? c.max * 100 : c.max)
                            ? "border-red-600"
                            : "border-slate-700"
                        }`}
                      />
                      {isPct && <span className="text-xs text-slate-500">%</span>}
                      <Button
                        variant="primary"
                        size="sm"
                        aria-label={`${c.label} speichern`}
                        onClick={() => draft !== "" && save(c.key, draft)}
                        disabled={saving === c.key || draft === ""}
                      >
                        ✓
                      </Button>
                    </>
                  )}
                </div>
              ),
              <span key={`${c.key}-description`} className="text-xs text-slate-400">{c.description}</span>,
            ];
          })}
        />
        {msg && (
          <p role="status" className="mt-2 rounded-lg border border-sky-700/50 bg-sky-950/30 px-3 py-2 text-xs text-sky-300">{msg}</p>
        )}
        <p className="mt-3 rounded-lg border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-300">
          Werte wirken ab dem nächsten Turn/Tick ohne Neustart. Jede Änderung landet revisionssicher
          im Audit-Log (<code className="font-mono">CONFIG_CHANGED</code>). Die absoluten Grenzen
          (<code className="font-mono">LIMIT_CEILINGS</code> in <code className="font-mono">riskGuard.ts</code>)
          bleiben im kompilierten Code — auch eine kompromittierte Datenbank kann sie nicht aufweichen.
          Prozentwerte werden als Zahl eingegeben (z. B. 30 für 30 %).
        </p>
      </section>

      <AdaptiveRiskPanel data={data} />

      <VolatilityConfigSection data={data} drafts={drafts} setDrafts={setDrafts} saving={saving} save={save} />

      <section>
        <h2 className={`mb-2 ${SECTION_TITLE}`}>
          Ollama-Status
          <InfoTip
            label="Ollama-Status"
            text="Lokaler LLM-Server für die Agenten-Rollen. Ist er nicht erreichbar, entscheidet die deterministische Regel-Engine weiter — Betrieb bleibt möglich, nur ohne Modell-Freiheitsgrade."
          />
        </h2>
        <div className={PANEL_PADDED}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex items-baseline gap-2">
              <dt className="text-slate-400">Erreichbar:</dt>
              <dd className={data.ollama.available ? "text-emerald-400" : "text-red-400"}>
                {data.ollama.available ? "ja" : "nein"}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-slate-400">Endpunkt:</dt>
              <dd className="font-mono text-xs text-slate-300">{data.ollama.baseUrl || "http://127.0.0.1:11434"}</dd>
            </div>
            {data.ollama.error && (
              <div className="flex items-baseline gap-2 sm:col-span-2">
                <dt className="text-slate-400">Fehler:</dt>
                <dd className="text-red-400">{data.ollama.error}</dd>
              </div>
            )}
            {data.ollama.models.length > 0 && (
              <div className="flex items-baseline gap-2 sm:col-span-2">
                <dt className="text-slate-400">Modelle:</dt>
                <dd className="text-slate-300">{data.ollama.models.join(", ")}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Ohne erreichbares Ollama fällt die Firma auf die deterministische Regel-Engine zurück —
            Orchestrierung und Guardrail-Pipeline bleiben damit vollständig vorführbar.
          </p>
        </div>
      </section>

      <section>
        <h2 className={`mb-2 ${SECTION_TITLE}`}>
          Kill-Switch-Historie
          <InfoTip
            label="Kill-Switch-Historie"
            text="Jede Auslösung und Entschärfung des Not-Halts mit Auslöser und Begründung — revisionssicher im Audit-Log gespiegelt."
          />
        </h2>
        <DataTable
          label="Kill-Switch-Historie"
          head={["Ausgelöst von", "Grund", "Scharf"]}
          empty="Noch keine Kill-Switch-Ereignisse — der Not-Halt wurde nie gezogen."
          rows={data.killSwitches.map((k) => [
            k.triggeredBy,
            k.reason,
            <Chip key={`${k.triggeredBy}-${k.reason}`} tone={k.armed ? "bad" : "neutral"}>
              {k.armed ? "ja" : "nein"}
            </Chip>,
          ])}
        />
      </section>
    </div>
  );
}

/**
 * Design-/Guide-Tab: Der Inhalt ist Lesetext, kein Datenraster. Auf großen
 * Monitoren läuft er deshalb in **zwei Spalten** (ab `3xl`), statt als eine
 * 3000 px breite Zeile auseinanderzufallen; die Karten bleiben dabei
 * ungeteilt (`break-inside-avoid`).
 */
function ArchitectureTab() {
  return (
    <div className="prose prose-invert max-w-none">
      <Guide />
    </div>
  );
}

function Guide() {
  return (
    <div className="columns-1 gap-6 text-slate-300 3xl:columns-2 [&>section]:mb-6 [&>section]:break-inside-avoid [&>section]:not-prose">
      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">1 · Grundprinzip (Ist-Stand)</h2>
        <p className="mb-3 text-sm text-slate-400">
          Die KI schlägt vor — der Code entscheidet. Orchestrierung ist ein
          eigener Engine-Layer (`src/lib/engine.ts`, `src/cycle/`) mit harten
          Grenzen in kompiliertem TypeScript — keine fremde Agenten-Runtime.
        </p>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b className="text-emerald-400">Makro-Zyklus</b> — CEO + Research, LLM im Hintergrund, erzeugt versionierte Regeln (`trade_rules`).</li>
          <li><b className="text-emerald-400">Mikro-Zyklus</b> — eigener Prozess (`npm run micro`), kein LLM, WebSocket-Tick → kompilierte Regel → Paper-Fill.</li>
          <li><b className="text-emerald-400">Workshop-Pipeline</b> — sequenziell CEO → Research → Backtest → Risk → Approver → Executor; Race-Conditions an der Brokerschicht werden so vermieden.</li>
          <li><b className="text-emerald-400">MODEL_ROUTER</b> — kein Agent wählt sein Modell selbst (Task 09). Eskalationen nur als Antrag.</li>
        </ul>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">2 · 12-Aufgaben-Programm</h2>
        <p className="mb-3 text-sm text-slate-400">Was bereits im Code liegt — nicht was irgendwann geplant war:</p>
        <DataTable
          label="12-Aufgaben-Programm"
          stack={false}
          head={["Task", "Thema", "Status"]}
          rows={[
            ["01–06", "Universum, Broker-Contract, Paper-Market-Data, Scanner, Portfolio, Zyklus", "geliefert"],
            ["07–09", "Bitunix, Control Plane, MODEL_ROUTER", "geliefert"],
            ["10", "Operations Center + RBAC (dieser Stand: Kern + leerer Tab)", "in Arbeit"],
            ["11", "Live-Trading-Gate", <span key="gate">gesperrt — <code>LiveTradingGateError</code></span>],
          ]}
        />
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">3 · Sicherheit &amp; Risikokontrolle</h2>
        <p className="mb-3 text-sm text-slate-400">Defense-in-Depth — mehrschichtig, in Code verankert:</p>
        <ol className="ml-5 list-decimal space-y-2 text-sm">
          <li><b>Guardrails:</b> Engine validiert, dann <code className="font-mono">riskGuard.ts</code> (hart), dann Broker-Schleuse nochmal. Ein Agent-Output kann keine Schicht ändern.</li>
          <li><b>RBAC (Task 10):</b> Rollen viewer / operator / admin. Credentials und Routing-Modi nur Admin. Permission <code className="font-mono">live.gate</code> hat niemand.</li>
          <li><b>Kill-Switch:</b> Circuit-Breaker, DB-persistent. Jede Order in <code className="font-mono">submit</code> wird abgelehnt, sobald er scharf ist.</li>
          <li><b>Secrets:</b> Control Plane AES-256-GCM (AAD = Venue-ID). Das Frontend sieht nur Status, nie Keys.</li>
        </ol>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">4 · Paper-Trading (Ist)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Default-Modus B</b> (<code className="font-mono">broker-market-data</code>): echte Kurse (Broker-Feed → Binance/Yahoo), Fills lokal im Simulator. Kein statisches Kursbuch — das ist nur noch <code className="font-mono">PAPER_STATIC_FALLBACK=true</code>.</li>
          <li><b>Modus A</b> (<code className="font-mono">synthetic</code>): seeded, deterministisch, für Tests.</li>
          <li><b>Modus C</b> (Broker-Paper-API): nur mit Venue-Capability + Flag; heute nicht wählbar (klarer Fehler, kein stiller Fallback).</li>
          <li><b>Live</b> bleibt unabhängig von Flags <code className="font-mono">LiveTradingGateError</code> (Task 11).</li>
        </ul>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">5 · Hardware (Variante A / B)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>Variante A — Solo-Node:</b> N150, 16 GB, alles lokal. 3B-Q4, Pipeline 2–6 min. Empfohlener Start.</li>
          <li><b>Variante B — Split-Node:</b> N150 24/7 + Desktop als Inferenz. 7B–14B, Pipeline 20–60 s.</li>
          <li><b>Quantisierung:</b> Q4_K_M ist der Standard — die Agenten füllen JSON, die Rechenarbeit liegt im Code. Q5 nur für den CEO, wenn Latenz es hergibt.</li>
          <li>Messen: <code className="font-mono">ollama ps</code> (RAM, tok/s). Zwei Modelle gleichzeitig auf 16 GB sind die harte Grenze — deshalb bleibt die Pipeline sequenziell.</li>
        </ul>
      </section>

      <section className={PANEL_LARGE}>
        <h2 className="mb-1 text-lg font-bold text-slate-50">6 · Broker (Ist)</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm">
          <li><b>7 Venues registriert</b> hinter <code className="font-mono">BrokerAdapter</code>: PAPER (interner Simulator, vollständig), BITUNIX (Public REST/WS + Paper-Modus B), ALPACA/IBKR/BINANCE/KRAKEN/DYDX als ehrliche Stubs. <b>Registriert ≠ abgedeckt:</b> das Operations Center trennt registrierte Venues von tatsächlicher Discovery-/Market-Data-/Paper-/Testnet-/Live-Coverage (<code className="font-mono">GET /api/brokers/coverage</code>).</li>
          <li><b>Coverage (extern):</b> 1 Venue mit vollständiger Discovery, 1 Venue mit Paper-Market-Data, 0 Venues mit aktiviertem Live-Trading — differenziert im Coverage-Dashboard des Brokers-Tabs.</li>
          <li><b>Control Plane:</b> Credentials einmal Form → AES-256-GCM-Store. Frontend erhält nur Status (configured / connected / permissions / liveEnabled:false).</li>
          <li><b>Factory:</b> <code className="font-mono">getBroker(venue, &quot;live&quot;)</code> wirft immer <code className="font-mono">LiveTradingGateError</code>. Kein stiller Fallback auf Paper.</li>
          <li><b>Paper vereinheitlicht:</b> Der Bitunix-Paper-Ledger nutzt denselben zentralen <code className="font-mono">FillSimulator</code> wie die generische Paper-Execution (Spread, Slippage, Gebühren, Latenz, Partial Fills) — keine separate Simulationslogik mehr.</li>
        </ul>
      </section>

      {/* Questions to ask */}
      <section className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-6">
        <h2 className="mb-2 text-lg font-bold text-emerald-300">Fragen, die du dir vor dem Start stellen solltest</h2>
        <ul className="ml-5 list-disc space-y-2 text-sm text-emerald-100/90">
          <li>Welche maximale Drawdown-Toleranz hast du, bevor der Kill-Switch automatisch zieht? (Wert in % setzen)</li>
          <li>Wie viel Zeit kannst du realistisch pro Woche für Prompt-/Template-Wartung aufwenden? (beeinflusst Komplexität des Orchestrators)</li>
          <li>Welche Genauigkeit brauchst du bei Backtests, bevor du einem Setup vertraust? (das hier ist bewusst nur minimal)</li>
          <li>Stimmst du dem &quot;small round-trips, no shorts, no leverage&quot;-Start zu, oder willst du schon early Trades mit Margin?</li>
          <li>Welche Assets willst du wirklich handeln — Equities (→ Alpaca) oder Crypto (→ ccxt/Binance)?</li>
          <li>Hältst du einen hybriden Fallback sicher genug, um in Produktion je eine Cloud-API zu erlauben? (für Paper-Trading unnötig)</li>
        </ul>
      </section>
    </div>
  );
}
