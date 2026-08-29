/**
 * Operations Center — Kollektoren (Task 10, vollständige Integration).
 *
 * Jede Sektion liest ihre Daten aus einem **bereits bestehenden** Modul oder
 * einer bestehenden API. Hier entsteht keine neue Fachlogik, kein zweiter
 * Zustand und keine zweite Datenhaltung — nur Aggregation und Projektion in
 * das Anzeigeformat aus `./types.ts`.
 *
 * Fehlerverhalten: Ein Kollektor darf das Operations Center nie sprengen.
 * Schlägt eine Quelle fehl, wird die Sektion `unavailable` mit einer
 * redigierten Meldung (`publicErrorMessage`) — alle anderen Sektionen bleiben
 * lesbar. Das ist bewusst fail-soft, aber nie fail-open: fehlende Daten werden
 * als Fehlerzustand gezeigt, nicht als „grün“.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { availableExecutionModes } from "@/brokers/capabilities";
import { createAdapter } from "@/brokers/factory";
import { REMOTE_HEALTHCHECK_FLAG, remoteHealthCheckEnabled } from "@/brokers/health";
import { BROKER_VENUE_IDS } from "@/contracts/broker";
import { getCycleService } from "@/cycle/service";
import { db } from "@/db";
import { agentMessages, agents, auditLog, equitySnapshots, missions, positions } from "@/db/schema";
import { formatDuration, formatNumber, formatRelative, formatTimestampUtc } from "@/lib/auditView";
import { BROKER_REGISTRY } from "@/lib/broker";
import { listDocs } from "@/lib/docsCatalog";
import { getOllamaStatus } from "@/lib/ollama";
import { publicErrorMessage } from "@/lib/secrets";
import { getLimits, killSwitch } from "@/lib/riskGuard";
import { getAdaptiveRiskStatus } from "@/lib/adaptiveRisk";
import { verifyAuditChain } from "@/live-gate/audit";
import { liveGateConfig } from "@/live-gate/config";
import { PORTFOLIO_CONFIG_VERSION } from "@/portfolio/config";
import { getModelRouter } from "@/routing";
import { getScannerService } from "@/scanner/service";
import { getRegistry } from "@/universe";
import { eq, desc, sql } from "drizzle-orm";

import {
  OPS_SECTION_IDS,
  type OpsItem,
  type OpsMetric,
  type OpsSectionData,
  type OpsSectionId,
  type OpsSectionStatus,
  type OpsTone,
} from "./types";

/** Maximale Anzahl Detailzeilen je Sektion (Antwort bleibt klein). */
export const MAX_SECTION_ITEMS = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Formatierung (de-DE, konsistent mit src/lib/auditView)
// ─────────────────────────────────────────────────────────────────────────────

function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return formatNumber(value, digits);
}

function pct(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${formatNumber(value * 100, digits)} %`;
}

function countLabel(value: number, singular: string, plural = `${singular}n`): string {
  return `${num(value, 0)} ${value === 1 ? singular : plural}`;
}

function toneForHealth(status: string): OpsTone {
  if (status === "online" || status === "healthy") return "good";
  if (status === "degraded") return "warn";
  if (status === "offline") return "bad";
  return "neutral";
}

// ─────────────────────────────────────────────────────────────────────────────
// Kollektor-Rahmen
// ─────────────────────────────────────────────────────────────────────────────

type Draft = {
  status?: OpsSectionStatus;
  asOf?: string | null;
  metrics?: OpsMetric[];
  items?: OpsItem[];
  note?: string | null;
};

function finish(id: OpsSectionId, draft: Draft): OpsSectionData {
  return {
    id,
    status: draft.status ?? "ready",
    asOf: draft.asOf ?? null,
    metrics: draft.metrics ?? [],
    items: (draft.items ?? []).slice(0, MAX_SECTION_ITEMS),
    note: draft.note ?? null,
    error: null,
  };
}

function failed(id: OpsSectionId, err: unknown): OpsSectionData {
  return {
    id,
    status: "unavailable",
    asOf: null,
    metrics: [],
    items: [],
    note: null,
    error: publicErrorMessage(err, "Quelle nicht lesbar"),
  };
}

/** Führt einen Kollektor aus und fängt jeden Fehler fail-soft ab. */
async function guard(id: OpsSectionId, run: (firm: FirmResult) => Promise<Draft> | Draft, firm: FirmResult): Promise<OpsSectionData> {
  try {
    return finish(id, await run(firm));
  } catch (err) {
    return failed(id, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Datenbank-Snapshot (eine Runde für Portfolio / Agenten / Audit)
// ─────────────────────────────────────────────────────────────────────────────

type FirmSnapshot = {
  agents: { id: string; name: string; role: string; status: string; model: string }[];
  activeMissions: number;
  messageCount: number;
  lastMessageAt: string | null;
  openPositions: {
    symbol: string;
    side: string;
    qty: number;
    entryPrice: number;
    stopLoss: number | null;
    createdAt: string | null;
  }[];
  audit: {
    total: number;
    warn: number;
    critical: number;
    recent: { event: string; level: string; createdAt: string | null }[];
  };
  equity: { ts: string; equity: number; cash: number; realizedPnlToday: number } | null;
};

type FirmResult = { ok: true; data: FirmSnapshot } | { ok: false; error: string };

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value) return value;
  return null;
}

/**
 * Liest den Datenbank-Zustand in **einem** Durchlauf.
 * Ohne `DATABASE_URL` wird gar nicht erst verbunden (schneller, klare Meldung).
 */
async function loadFirmSnapshot(): Promise<FirmResult> {
  if (!process.env.DATABASE_URL) {
    return { ok: false, error: "DATABASE_URL ist nicht gesetzt — Datenbank-Sektionen ohne Daten." };
  }
  try {
    const [agentRows, missionRows, lastMessageRows, messageCountRows, openRows, auditCountRows, auditRows, equityRows] =
      await Promise.all([
        db.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status, model: agents.model }).from(agents),
        db.select({ total: sql<number>`count(*)::int` }).from(missions).where(eq(missions.status, "ACTIVE")),
        db.select({ createdAt: agentMessages.createdAt }).from(agentMessages).orderBy(desc(agentMessages.createdAt)).limit(1),
        db.select({ total: sql<number>`count(*)::int` }).from(agentMessages),
        db
          .select({
            symbol: positions.symbol,
            side: positions.side,
            qty: positions.qty,
            entryPrice: positions.entryPrice,
            stopLoss: positions.stopLoss,
            createdAt: positions.createdAt,
          })
          .from(positions)
          .where(eq(positions.status, "OPEN"))
          .orderBy(desc(positions.createdAt))
          .limit(50),
        db
          .select({
            total: sql<number>`count(*)::int`,
            warn: sql<number>`count(*) filter (where ${auditLog.level} = 'WARN')::int`,
            critical: sql<number>`count(*) filter (where ${auditLog.level} = 'CRITICAL')::int`,
          })
          .from(auditLog),
        db
          .select({ event: auditLog.event, level: auditLog.level, createdAt: auditLog.createdAt })
          .from(auditLog)
          .orderBy(desc(auditLog.createdAt))
          .limit(MAX_SECTION_ITEMS),
        db.select().from(equitySnapshots).orderBy(desc(equitySnapshots.ts)).limit(1),
      ]);

    const equityRow = equityRows[0];
    return {
      ok: true,
      data: {
        agents: agentRows,
        activeMissions: Number(missionRows[0]?.total ?? 0),
        messageCount: Number(messageCountRows[0]?.total ?? 0),
        lastMessageAt: iso(lastMessageRows[0]?.createdAt),
        openPositions: openRows.map((r) => ({
          symbol: r.symbol,
          side: r.side,
          qty: Number(r.qty),
          entryPrice: Number(r.entryPrice),
          stopLoss: r.stopLoss === null ? null : Number(r.stopLoss),
          createdAt: iso(r.createdAt),
        })),
        audit: {
          total: Number(auditCountRows[0]?.total ?? 0),
          warn: Number(auditCountRows[0]?.warn ?? 0),
          critical: Number(auditCountRows[0]?.critical ?? 0),
          recent: auditRows.map((r) => ({ event: r.event, level: r.level, createdAt: iso(r.createdAt) })),
        },
        equity: equityRow
          ? {
              ts: iso(equityRow.ts) ?? "",
              equity: Number(equityRow.equity),
              cash: Number(equityRow.cash),
              realizedPnlToday: Number(equityRow.realizedPnlToday),
            }
          : null,
      },
    };
  } catch (err) {
    return { ok: false, error: publicErrorMessage(err, "Datenbank nicht erreichbar") };
  }
}

/** Wirft die Sammelfehlermeldung, damit der Sektions-Guard sie anzeigt. */
function requireFirm(firm: FirmResult): FirmSnapshot {
  if (!firm.ok) throw new Error(firm.error);
  return firm.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Market Universe — src/universe (Registry)
// ─────────────────────────────────────────────────────────────────────────────

function collectMarketUniverse(): Draft {
  const registry = getRegistry();
  const byVenue = registry.countByVenue();
  const venues = Object.entries(byVenue).sort((a, b) => b[1] - a[1]);
  const skipped = registry.skippedLines;
  return {
    status: registry.size > 0 ? "ready" : "empty",
    asOf: registry.lastSync,
    metrics: [
      { label: "Instrumente", value: num(registry.size, 0) },
      { label: "Venues", value: num(venues.length, 0) },
      { label: "Stand", value: registry.lastSync ? formatTimestampUtc(registry.lastSync) : "unbekannt" },
      { label: "Policy", value: `v${registry.policy.version}` },
    ],
    items: venues.map(([venue, count]) => ({ label: venue, value: num(count, 0) })),
    note:
      skipped > 0
        ? `${countLabel(skipped, "Zeile")} beim Laden übersprungen (beschädigt) — Registry-Audit prüfen.`
        : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Scanner — src/scanner (deterministischer Markt-Scanner)
// ─────────────────────────────────────────────────────────────────────────────

function collectScanner(): Draft {
  const scan = getScannerService().getScan();
  const { funnel, readiness } = scan;
  const top = funnel.daily.slice(0, MAX_SECTION_ITEMS);

  // Readiness explizit ausweisen (OPS-009): trennt Infrastruktur (Warmup/Fehler)
  // von Fachlogik. Der Sollwert wird aus der Faktor-Konfiguration abgeleitet.
  const warmed = readiness.status === "ERROR" ? 0 : readiness.warmed;
  const readinessTone: OpsTone =
    readiness.status === "READY" ? "good" : readiness.status === "WARMING" ? "warn" : "bad";
  const candlesValue =
    readiness.status === "ERROR"
      ? "Datenfehler"
      : `${warmed} / ${readiness.instruments} · ${readiness.requiredCandles} Kerzen`;

  return {
    status: funnel.scanned > 0 ? (funnel.daily.length > 0 ? "ready" : "empty") : "empty",
    asOf: scan.asOf,
    metrics: [
      { label: "Gescannt", value: num(funnel.scanned, 0) },
      { label: "Readiness", value: readiness.status, tone: readinessTone },
      {
        label: "Warmup (gewärmt / benötigt)",
        value: candlesValue,
        tone: readinessTone,
        hint:
          "Geladene vs. benoetigte Kerzen je Instrument. Der Sollwert wird aus der " +
          "Faktor-Konfiguration abgeleitet und aendert sich automatisch mit ihr.",
      },
      { label: "Eligible", value: num(funnel.eligible.length, 0) },
      { label: "Interesting", value: num(funnel.interesting.length, 0) },
      { label: "Daily-Rotation", value: num(funnel.daily.length, 0) },
      { label: "Deep-Dive", value: num(funnel.deep.length, 0) },
      { label: "Konfiguration", value: `v${scan.config.version}` },
      { label: "Scan-Stand", value: formatTimestampUtc(scan.asOf) },
    ],
    items: top.map((s) => ({
      label: s.instrumentId,
      value: num(s.score, 2),
      meta: `${s.assetClass} · ${s.regime}`,
      tone: s.regime === "EXTREME" ? "bad" : s.regime === "HIGH" ? "warn" : "good",
    })),
    note:
      readiness.status === "ERROR"
        ? `Marktdaten-Fehler: ${readiness.error} (Infrastruktur, kein Marktausschluss).`
        : readiness.status === "WARMING"
          ? `Warmup unvollständig: ${readiness.missing} Instrument(e) < ${readiness.requiredCandles} Kerzen — ` +
            "Behebung: npm run market-sync (Datenverfügbarkeit, kein Marktausschluss)."
          : funnel.diversificationRelaxed
            ? "Diversifikationsregel gelockert — zu wenige Anlageklassen im Trichter."
            : funnel.scanned > 0 && funnel.eligible.length === 0
              ? "Trichter leer: die Eignungsfilter greifen (Markt/Kosten), Historie ist vollständig geladen."
              : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Portfolio Analytics — Positionen/Equity + src/portfolio
// ─────────────────────────────────────────────────────────────────────────────

function collectPortfolioAnalytics(firm: FirmResult): Draft {
  const data = requireFirm(firm);
  const open = data.openPositions;
  const exposure = open.reduce((sum, p) => sum + Math.abs(p.qty * p.entryPrice), 0);
  const equity = data.equity?.equity ?? null;
  const cash = data.equity?.cash ?? null;
  const realized = data.equity?.realizedPnlToday ?? null;
  const hasPositions = open.length > 0;
  return {
    status: hasPositions || data.equity ? "ready" : "empty",
    asOf: data.equity?.ts || null,
    metrics: [
      { label: "Offene Positionen", value: num(open.length, 0) },
      { label: "Exposure (Einstieg)", value: num(exposure) },
      { label: "Eigenkapital", value: equity === null ? "—" : num(equity) },
      { label: "Freie Liquidität", value: cash === null ? "—" : num(cash) },
      {
        label: "Realisiert heute",
        value: realized === null ? "—" : num(realized),
        tone: realized === null ? "neutral" : realized > 0 ? "good" : realized < 0 ? "bad" : "neutral",
      },
      { label: "Kennzahlen-Modul", value: `v${PORTFOLIO_CONFIG_VERSION}` },
    ],
    items: open.slice(0, MAX_SECTION_ITEMS).map((p) => ({
      label: p.symbol,
      value: p.side,
      meta: `${num(p.qty, 4)} @ ${num(p.entryPrice)}`,
      tone: p.stopLoss === null ? "warn" : "neutral",
    })),
    note:
      hasPositions && open.some((p) => p.stopLoss === null)
        ? "Mindestens eine Position hat keinen Stop-Loss hinterlegt."
        : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Research Operations — src/cycle (Tages-/Wochenläufe)
// ─────────────────────────────────────────────────────────────────────────────

function collectResearchOperations(): Draft {
  const service = getCycleService();
  const runs = service.getRuns({ pageSize: MAX_SECTION_ITEMS });
  const weekly = service.getWeeklyLatest();
  const daily = service.getDailyLatest();
  const dailyDate = typeof daily?.date === "string" ? daily.date : null;
  const lastRun = runs.items[0];
  return {
    status: runs.total > 0 ? "ready" : "empty",
    asOf: lastRun?.startedAt ?? null,
    metrics: [
      { label: "Zyklus-Läufe", value: num(runs.total, 0) },
      {
        label: "Letzter Lauf",
        value: lastRun ? String(lastRun.status) : "—",
        tone: lastRun?.status === "COMPLETED" ? "good" : lastRun?.status === "FAILED" ? "bad" : "neutral",
      },
      { label: "Tageslauf", value: dailyDate ?? "—" },
      { label: "Wochen-Review", value: weekly ? formatTimestampUtc(weekly.asOf) : "—" },
      ...(["CORE", "ROTATION", "DISCOVERY"] as const).map((cls) => ({
        label: `Klasse ${cls}`,
        value: weekly ? num(weekly.summary[cls] ?? 0, 0) : "—",
      })),
    ],
    items: runs.items.map((run) => ({
      // Weekly-Einträge tragen `week`, Daily-Einträge nur `date`.
      label: "week" in run ? `Woche ${String(run.week)}` : `Tag ${String(run.date)}`,
      value: String(run.status),
      meta: formatDuration(run.durationMs ?? null) ?? "ohne Dauer",
      tone: run.status === "COMPLETED" ? "good" : run.status === "FAILED" ? "bad" : "neutral",
    })),
    note: weekly ? null : "Noch kein Wochen-Review — der Weekly-Zyklus wurde nicht ausgeführt.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Broker Operations — src/brokers (Registry, Capabilities, Health)
// ─────────────────────────────────────────────────────────────────────────────

async function collectBrokerOperations(): Promise<Draft> {
  const remote = remoteHealthCheckEnabled();
  const venues = await Promise.all(
    BROKER_VENUE_IDS.map(async (id) => {
      const entry = BROKER_REGISTRY[id];
      let health: { status: string; latencyMs: number };
      try {
        const checked = await createAdapter(id, "paper").healthCheck();
        health = { status: checked.status, latencyMs: checked.latencyMs };
      } catch {
        health = { status: "offline", latencyMs: 0 };
      }
      const modes = Object.values(availableExecutionModes(id)).filter((m) => m.available).length;
      return {
        id,
        label: entry.label,
        assets: entry.assets,
        health,
        modes,
        paperAvailable: entry.paperAvailable,
        liveAvailable: entry.liveAvailable,
      };
    })
  );
  const online = venues.filter((v) => v.health.status === "online").length;
  const liveCapable = venues.filter((v) => v.liveAvailable).length;
  const paperCapable = venues.filter((v) => v.paperAvailable).length;
  return {
    // Der lokale Health-Status ist vollständig — „Remote-Check aus“ ist der
    // dokumentierte Default, kein Defekt. Er steht daher im Hinweis, nicht
    // im Zustand.
    status: "ready",
    asOf: new Date().toISOString(),
    metrics: [
      { label: "Venues", value: num(venues.length, 0) },
      { label: "Health online", value: `${num(online, 0)} / ${num(venues.length, 0)}` },
      { label: "Paper-fähig", value: `${num(paperCapable, 0)} / ${num(venues.length, 0)}` },
      {
        label: "Live-Capability",
        value: `${num(liveCapable, 0)} / ${num(venues.length, 0)}`,
        hint: "Adapter-Fähigkeit des Venues — keine Freigabe. Der Live-Pfad bleibt über das Live-Gate gesperrt.",
      },
      {
        label: "Remote-Check",
        value: remote ? "aktiv" : "aus (Default)",
        tone: remote ? "neutral" : "warn",
        hint: `Env-Flag ${REMOTE_HEALTHCHECK_FLAG}`,
      },
    ],
    items: venues.map((v) => ({
      label: v.id,
      value: v.health.status,
      meta: `${v.label} · ${num(v.modes, 0)} Modi · ${num(v.health.latencyMs, 0)} ms`,
      tone: toneForHealth(v.health.status),
    })),
    note:
      liveCapable > 0
        ? `Live-Capability ist eine Adapter-Eigenschaft, keine Freigabe: der Live-Pfad bleibt über das Live-Gate gesperrt.${
            remote ? "" : ` Lokaler Health-Status ohne Remote-Prüfung (${REMOTE_HEALTHCHECK_FLAG} ist Default aus).`
          }`
        : remote
          ? null
          : `Lokaler Health-Status ohne Remote-Prüfung (${REMOTE_HEALTHCHECK_FLAG} ist Default aus).`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. LLM Operations — src/routing (MODEL_ROUTER) + lokaler Provider
// ─────────────────────────────────────────────────────────────────────────────

async function collectLlmOperations(): Promise<Draft> {
  const snapshot = getModelRouter().snapshot(MAX_SECTION_ITEMS);
  const ollama = await getOllamaStatus();
  const providers = snapshot.providers;
  const online = providers.filter((p) => p.healthStatus === "online").length;
  const budget = snapshot.budget.global;
  const decisions = Object.values(snapshot.lastDecisions);
  const budgetPct = budget.tokensPerDay > 0 ? budget.tokens / budget.tokensPerDay : 0;
  return {
    status: online > 0 || ollama.available ? "ready" : "degraded",
    asOf: snapshot.generatedAt,
    metrics: [
      { label: "Routing-Policy", value: snapshot.policyVersion },
      { label: "Modus", value: snapshot.policy.defaultMode },
      { label: "Provider online", value: `${num(online, 0)} / ${num(providers.length, 0)}` },
      {
        label: "Lokales LLM",
        value: ollama.available ? `${countLabel(ollama.models.length, "Modell")}` : "nicht erreichbar",
        tone: ollama.available ? "good" : "warn",
      },
      {
        label: "Tagesbudget",
        value: pct(budgetPct),
        tone: budgetPct >= 0.9 ? "bad" : budgetPct >= 0.7 ? "warn" : "good",
      },
      { label: "Entscheidungen", value: num(decisions.length, 0) },
    ],
    items: decisions.slice(0, MAX_SECTION_ITEMS).map((d) => ({
      label: d.agent,
      value: `${d.provider}:${d.model}`,
      meta: `${d.modelClass} · ${d.trigger}`,
      tone: d.budgetBlocked ? "warn" : d.escalated ? "neutral" : "good",
    })),
    note: ollama.available ? null : "Kein lokaler Provider erreichbar — Routing fällt auf die Regel-Engine zurück.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Agent Operations — Agenten, Missionen, Nachrichten (DB)
// ─────────────────────────────────────────────────────────────────────────────

function collectAgentOperations(firm: FirmResult): Draft {
  const data = requireFirm(firm);
  const byRole = new Map<string, number>();
  for (const agent of data.agents) byRole.set(agent.role, (byRole.get(agent.role) ?? 0) + 1);
  return {
    status: data.agents.length > 0 ? "ready" : "empty",
    asOf: data.lastMessageAt,
    metrics: [
      { label: "Agenten", value: num(data.agents.length, 0) },
      { label: "Rollen", value: num(byRole.size, 0) },
      { label: "Aktive Missionen", value: num(data.activeMissions, 0) },
      { label: "Nachrichten", value: num(data.messageCount, 0) },
      { label: "Letzte Nachricht", value: formatRelative(data.lastMessageAt) },
    ],
    items: data.agents.slice(0, MAX_SECTION_ITEMS).map((a) => ({
      label: a.name,
      value: a.role,
      meta: `Status ${a.status}`,
      tone: a.status === "BLOCKED" || a.status === "STOPPED" ? "warn" : "neutral",
    })),
    note: data.agents.length === 0 ? "Keine Agenten angelegt — `npm run dev` → „Firm seeden“." : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Risk — Risk Guard, adaptives Risiko, Live-Gate
// ─────────────────────────────────────────────────────────────────────────────

function collectRisk(firm: FirmResult): Draft {
  const limits = getLimits();
  const adaptive = getAdaptiveRiskStatus();
  const armed = killSwitch.isArmed();
  const openPositions = firm.ok ? firm.data.openPositions.length : null;
  const gate = liveGateConfig(process.env);
  return {
    // Kill-Switch scharf == Handel gesperrt: das ist ein bewusster Zustand,
    // kein Fehler der Aggregation — daher `locked`, nicht `unavailable`.
    status: armed ? "locked" : "ready",
    asOf: adaptive?.lastUpdate ?? null,
    metrics: [
      {
        label: "Kill-Switch",
        value: armed ? "scharf" : "entschärft",
        tone: armed ? "bad" : "good",
      },
      { label: "Risiko je Trade", value: pct(limits.maxRiskPerTrade, 2) },
      { label: "Position max.", value: pct(limits.maxPositionPct) },
      { label: "Tagesverlust-Limit", value: pct(limits.dailyLossLimitPct) },
      { label: "Drawdown-Limit", value: pct(limits.maxEquityDrawdownPct) },
      {
        label: "Offene Positionen",
        value: openPositions === null ? "—" : `${num(openPositions, 0)} / ${num(limits.maxConcurrentPositions, 0)}`,
        tone:
          openPositions !== null && openPositions >= limits.maxConcurrentPositions ? "warn" : "neutral",
      },
      {
        label: "Volatilitäts-Regime",
        value: adaptive ? adaptive.regime : "—",
        tone: adaptive?.regime === "EXTREME" ? "bad" : adaptive?.regime === "ELEVATED" ? "warn" : "neutral",
      },
    ],
    items: [
      { label: "Stop-Loss Pflicht", value: limits.requireStopLoss ? "ja" : "nein", tone: limits.requireStopLoss ? "good" : "warn" },
      { label: "Short erlaubt", value: limits.allowShort ? "ja" : "nein" },
      { label: "Max. Hebel", value: `${num(limits.maxLeverage, 1)}×` },
      { label: "Standard-Stop", value: pct(limits.defaultStopLossPct) },
      {
        label: "Wirksames Risiko",
        value: adaptive ? pct(adaptive.effectiveMaxRiskPerTrade, 2) : pct(limits.maxRiskPerTrade, 2),
        meta: adaptive ? `Faktor ${num(adaptive.factor, 2)}` : "keine adaptive Bewertung",
      },
      { label: "Live-Gate-Datenpfad", value: gate.dir },
    ],
    note: adaptive?.stale
      ? "Adaptive Risikobewertung ist veraltet (kein Update im Erwartungsfenster)."
      : adaptive?.lastError
        ? `Adaptive Risikobewertung meldet: ${publicErrorMessage(adaptive.lastError)}`
        : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Audit — Datenbank-Audit-Trail + Live-Gate-Hash-Kette
// ─────────────────────────────────────────────────────────────────────────────

function collectAudit(firm: FirmResult): Draft {
  const data = requireFirm(firm);
  const { audit } = data;
  const chain = verifyAuditChain(liveGateConfig(process.env).dir);
  const criticals = audit.critical;
  const levelTone = (level: string): OpsTone =>
    level === "CRITICAL" ? "bad" : level === "WARN" ? "warn" : "neutral";
  return {
    status: audit.total > 0 ? "ready" : "empty",
    asOf: audit.recent[0]?.createdAt ?? null,
    metrics: [
      { label: "Ereignisse", value: num(audit.total, 0) },
      { label: "Warnungen", value: num(audit.warn, 0), tone: audit.warn > 0 ? "warn" : "good" },
      { label: "Kritisch", value: num(criticals, 0), tone: criticals > 0 ? "bad" : "good" },
      {
        label: "Live-Gate-Kette",
        value: chain.ok ? `intakt (${num(chain.entries, 0)})` : "gebrochen",
        tone: chain.ok ? "good" : "bad",
      },
      {
        label: "Letztes Ereignis",
        value: audit.recent[0] ? formatRelative(audit.recent[0].createdAt) : "—",
      },
    ],
    items: audit.recent.map((e) => ({
      label: e.event,
      value: e.level,
      meta: e.createdAt ? formatTimestampUtc(e.createdAt) : "ohne Zeitangabe",
      tone: levelTone(e.level),
    })),
    note: chain.ok ? null : `Hash-Kette ab Sequenz ${chain.firstBrokenSeq ?? "?"}: ${chain.problem ?? "unbekannt"}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Help — docs/help/*.help.json + Dokumentationskatalog
// ─────────────────────────────────────────────────────────────────────────────

const HELP_DIR = path.join("docs", "help");
/** Pfad des Dokumentationskatalogs (nur für den Quellhinweis der Sektion). */
const DOCS_CATALOG_SOURCE = "src/lib/docsCatalog.ts (GET /api/docs)";

async function collectHelp(): Promise<Draft> {
  const dir = path.join(process.cwd(), HELP_DIR);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".help.json")).sort();
  let fields = 0;
  const topics: OpsItem[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, file), "utf8")) as {
        id?: string;
        title?: string;
        fields?: Record<string, unknown>;
      };
      const fieldCount = Object.keys(parsed.fields ?? {}).length;
      fields += fieldCount;
      topics.push({
        label: parsed.id ?? file.replace(/\.help\.json$/, ""),
        value: countLabel(fieldCount, "Begriff", "Begriffe"),
        meta: parsed.title ?? file,
      });
    } catch {
      topics.push({ label: file, value: "unlesbar", tone: "warn" });
    }
  }
  const docs = listDocs();
  return {
    status: files.length > 0 ? "ready" : "empty",
    asOf: null,
    metrics: [
      { label: "Hilfe-Dateien", value: num(files.length, 0) },
      { label: "Fachbegriffe", value: num(fields, 0) },
      { label: "Dokumente", value: num(docs.length, 0) },
      { label: "Ebenen je Begriff", value: "3 (kurz/technisch/Risiko)" },
    ],
    items: [
      ...topics.slice(0, 4),
      ...docs.slice(0, MAX_SECTION_ITEMS - Math.min(4, topics.length)).map((d) => ({
        label: d.title,
        value: `/docs?name=${d.slug}`,
        meta: d.subtitle,
      })),
    ],
    note: `Quellen: ${HELP_DIR}/*.help.json · ${DOCS_CATALOG_SOURCE}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fassade
// ─────────────────────────────────────────────────────────────────────────────

type Collector = (firm: FirmResult) => Promise<OpsSectionData>;

const COLLECTORS: Record<OpsSectionId, Collector> = {
  "market-universe": (firm) => guard("market-universe", () => collectMarketUniverse(), firm),
  scanner: (firm) => guard("scanner", () => collectScanner(), firm),
  "portfolio-analytics": (firm) => guard("portfolio-analytics", () => collectPortfolioAnalytics(firm), firm),
  "research-operations": (firm) => guard("research-operations", () => collectResearchOperations(), firm),
  "broker-operations": (firm) => guard("broker-operations", () => collectBrokerOperations(), firm),
  "llm-operations": (firm) => guard("llm-operations", () => collectLlmOperations(), firm),
  "agent-operations": (firm) => guard("agent-operations", () => collectAgentOperations(firm), firm),
  risk: (firm) => guard("risk", () => collectRisk(firm), firm),
  audit: (firm) => guard("audit", () => collectAudit(firm), firm),
  help: (firm) => guard("help", () => collectHelp(), firm),
};

/**
 * Liest alle Sektionen parallel. Der Datenbank-Snapshot wird **einmal**
 * geladen und an die datenbankgestützten Sektionen weitergereicht — ein
 * Verbindungsfehler erscheint dadurch einmalig in der Meldung jeder
 * betroffenen Sektion, statt mehrfach Abfragen auszulösen.
 */
export async function collectSectionData(): Promise<Record<OpsSectionId, OpsSectionData>> {
  const firm = await loadFirmSnapshot();
  const entries = await Promise.all(
    OPS_SECTION_IDS.map(async (id) => [id, await COLLECTORS[id](firm)] as const)
  );
  return Object.fromEntries(entries) as Record<OpsSectionId, OpsSectionData>;
}
