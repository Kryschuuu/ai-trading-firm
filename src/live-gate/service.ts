/**
 * Live-Gate-Service (Task 11) — DIE API der Live-Trading-State-Machine.
 *
 * Zustandsänderungen gibt es AUSSERHALB dieses Services NICHT (Kein UI-/Prompt-
 * Bypass): API-Routen und CLI rufen genau diese Methoden, jede Mutation läuft
 * über Store (atomar) + Audit (Hash-Kette).
 *
 * Aktionen:
 *   transition() — die 8 legalen Matrix-Übergänge (Checks + Human-Gate-Policy:
 *                  Begründungspflicht, Cooldown LIVE_GATE_COOLDOWN_MS,
 *                  Confirm, optionaler 4-Augen-Modus)
 *   disable()    — expliziter Admin-Downgrade → DISCONNECTED (auditiert)
 *   kill()       — Kill-Switch aus JEDEM Zustand: Memory → Failsafe-Datei →
 *                  State-Reset → Audit; wirkt auch bei DB-/Store-Ausfall
 *   clearKill()  — entfernt die Sperre (auditiert); der Zustand bleibt
 *                  DISCONNECTED → kompletter Neudurchlauf erforderlich
 */
import { BROKER_VENUE_IDS, type BrokerVenueId } from "@/contracts/broker";
import { VENUE_CAPABILITIES } from "@/brokers/capabilities";
import {
  LIVE_GATE_POLICY_VERSION,
  liveGateConfig,
  type LiveGateEnv,
} from "./config";
import {
  LiveGateError,
  isLegalAdvance,
  isLiveGateState,
  liveGateStateRank,
  transitionDef,
  type LiveGateCheckId,
  type LiveGateErrorCode,
  type LiveGateState,
} from "./states";
import { TRANSITION_CHECKS, resolveGatePort, type TransitionCheckOutcome } from "./checks";
import { getLiveGateRuntime, type LiveGateRuntime } from "./runtime";
import { appendKillEntry, clearKillEntries, readKillFile, type KillFileEntry } from "./killFile";
import { verifyAuditChain, type LiveGateAuditEntry } from "./audit";
import { readSuiteStamp, validateSuiteStamp } from "./suite";
import { evaluateLiveOrder } from "./enforcer";
import type { LiveGateKillMarker, LiveGateVenueRecord } from "./store";

export interface LiveGateTransitionInput {
  venue: string;
  to: string;
  actor: string;
  reason?: string;
  confirm?: boolean;
  /** Benannter Approver (Pflicht im Human-Gate; 4-Augen vergleicht Namen). */
  approvedBy?: string;
}

export interface LiveGateCheckReport {
  id: LiveGateCheckId;
  label: string;
  ok: boolean;
  detail: string;
}

export interface LiveGateTransitionResult {
  ok: true;
  venue: BrokerVenueId;
  from: LiveGateState;
  to: LiveGateState;
  checks: LiveGateCheckReport[];
  at: string;
}

export interface LiveGateKillResult {
  ok: true;
  scope: string;
  venues: { venue: string; from: LiveGateState; stateReset: boolean }[];
  failsafeFileWritten: boolean;
  at: string;
}

export interface LiveGateVenueSnapshot {
  venue: string;
  liveAvailable: boolean;
  state: LiveGateState;
  updatedAt: string | null;
  updatedBy: string | null;
  livePendingAt: string | null;
  cooldownMs: number;
  cooldownRemainingMs: number;
  cooldownElapsed: boolean;
  fourEyesRequired: boolean;
  pendingApproval: { approvedBy: string; at: string } | null;
  killed: LiveGateKillMarker | null;
  killSwitchActive: boolean;
  flags: {
    venueEnabled: boolean;
    platformLive: boolean;
    venueLiveFlag: boolean;
    requireHumanApproval: boolean;
  };
  suite: { valid: boolean; runId: string | null; source: string | null };
  controlPlaneActive: boolean | null;
  liveOrderAllowed: boolean;
  denyCodeIfAny: string | null;
  history: LiveGateVenueRecord["history"];
}

export interface LiveGateOverview {
  ok: true;
  policyVersion: string;
  config: {
    dir: string;
    cooldownMs: number;
    fourEyes: boolean;
    paperMinOrders: number;
    suiteMaxAgeMs: number;
  };
  killSwitch: {
    active: boolean;
    scopes: string[];
    entries: KillFileEntry[];
  };
  suite: { valid: boolean; runId: string | null; source: string | null; reason: string };
  venues: LiveGateVenueSnapshot[];
  audit: {
    head: { seq: number; hash: string } | null;
    integrity: { ok: boolean; entries: number; firstBrokenSeq: number | null; problem: string | null };
    recent: Array<
      Pick<LiveGateAuditEntry, "seq" | "ts" | "actor" | "venue" | "from" | "to" | "action" | "result" | "reason"> & {
        /** Gekürzt (12 Zeichen) — volle Hashes nur in der NDJSON-Datei. */
        hash: string;
      }
    >;
  };
}

const REASON_MIN_CHARS = 8;
const APPROVER_MIN_CHARS = 3;
export const KILL_CONFIRM_PHRASE = "KILL";
export const KILL_CLEAR_CONFIRM_PHRASE = "CLEAR_KILL";

function requireReason(reason: string | undefined): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < REASON_MIN_CHARS) {
    throw new LiveGateError(
      "REASON_REQUIRED",
      `Begründung/Pflichtfeld fehlt oder zu kurz (min ${REASON_MIN_CHARS} Zeichen).`
    );
  }
  return trimmed;
}

export class LiveGateService {
  constructor(
    private readonly runtime: LiveGateRuntime = getLiveGateRuntime(),
    private readonly env: LiveGateEnv = process.env
  ) {}

  private nowIso(): string {
    return new Date().toISOString();
  }

  private normalizeVenue(raw: string): BrokerVenueId {
    const v = raw.trim().toUpperCase();
    if ((BROKER_VENUE_IDS as readonly string[]).includes(v)) return v as BrokerVenueId;
    throw new LiveGateError("UNKNOWN_VENUE", `Unbekanntes Venue "${String(raw).slice(0, 40)}".`);
  }

  private auditDeny(input: {
    actor: string;
    venue: string;
    from: string | null;
    to: string | null;
    code: string;
    detail: string;
  }): void {
    this.runtime.audit.append({
      actor: input.actor,
      venue: input.venue,
      from: input.from,
      to: input.to,
      action: "advance",
      result: "DENIED",
      reason: `${input.code}: ${input.detail}`,
    });
    // Denial-Zähler best-effort persistieren (darf Deny nicht verhindern).
    try {
      const rec = this.runtime.store.read(input.venue);
      rec.history.denials += 1;
      rec.auditHead = this.runtime.audit.chainHead();
      this.runtime.store.write(input.venue, rec);
    } catch {
      /* Store-Fehler: Audit-Eintrag ist bereits geschrieben. */
    }
  }

  /**
   * Führt einen Matrix-Übergang aus: Policy → Intent (persistiert) → Checks →
   * Commit (atomar). Jeder Schritt auditiert; halboffene Intents gelten nach
   * Crash als fehlgeschlagen (Store-Recovery).
   */
  async transition(input: LiveGateTransitionInput): Promise<LiveGateTransitionResult> {
    const config = liveGateConfig(this.env);
    const venue = this.normalizeVenue(input.venue);
    const actor = input.actor || "unknown";

    if (!isLiveGateState(input.to)) {
      this.auditDeny({
        actor,
        venue,
        from: null,
        to: String(input.to).slice(0, 40),
        code: "UNKNOWN_STATE",
        detail: `Zielzustand "${String(input.to).slice(0, 40)}" ist kein Gate-Zustand.`,
      });
      throw new LiveGateError("UNKNOWN_STATE", `Unbekannter Zielzustand "${String(input.to).slice(0, 40)}".`);
    }
    const to = input.to;

    const rec = this.runtime.store.read(venue);
    const from = rec.state;

    // Kill blockiert jede Transition (auch aus DISCONNECTED heraus).
    const kill = this.runtime.isKilled(venue);
    if (kill) {
      this.auditDeny({
        actor,
        venue,
        from,
        to,
        code: "KILL_SWITCH_ACTIVE",
        detail: `Kill-Switch aktiv (scope ${kill.scope}) — Transition verweigert.`,
      });
      throw new LiveGateError(
        "KILL_SWITCH_ACTIVE",
        `Kill-Switch aktiv (scope ${kill.scope}) — erst clearKill, dann kompletter Neudurchlauf.`
      );
    }

    // ── Matrix-Enforcement: nur die 8 legalen Übergänge ──────────────────────
    const legality = isLegalAdvance(from, to);
    if (!legality.legal) {
      this.auditDeny({
        actor,
        venue,
        from,
        to,
        code: "ILLEGAL_TRANSITION",
        detail: `Übergang ${legality.key} ist nicht in der Matrix (8 legale Übergänge, docs/LIVE_TRADING.md).`,
      });
      throw new LiveGateError(
        "ILLEGAL_TRANSITION",
        `Übergang ${legality.key} ist illegal — die Matrix erlaubt nur die 8 definierten Vorwärts-Übergänge; Sprünge/Rückwärts nur via disable/kill.`
      );
    }

    // ── Policy je Übergang (Human-Gate & Co.) ────────────────────────────────
    if (to === "LIVE_PENDING") {
      requireReason(input.reason);
    }

    if (to === "HUMAN_APPROVED") {
      if (input.confirm !== true) {
        this.auditDeny({ actor, venue, from, to, code: "CONFIRM_REQUIRED", detail: "Human-Gate verlangt explizite Bestätigung (confirm:true + Begründung)." });
        throw new LiveGateError("CONFIRM_REQUIRED", "Human-Gate: confirm:true ist Pflicht (Bestätigungsdialog).");
      }
      const reason = requireReason(input.reason);
      const approvedBy = (input.approvedBy ?? "").trim();
      if (approvedBy.length < APPROVER_MIN_CHARS) {
        this.auditDeny({ actor, venue, from, to, code: "APPROVER_REQUIRED", detail: "Approver-Name fehlt." });
        throw new LiveGateError("APPROVER_REQUIRED", `Approver-Name ist Pflicht (min ${APPROVER_MIN_CHARS} Zeichen).`);
      }
      // Cooldown zwischen LIVE_PENDING und Freigabe (Default 24 h).
      const nowMs = Date.now();
      if (!rec.livePendingAt) {
        this.auditDeny({ actor, venue, from, to, code: "COOLDOWN_ACTIVE", detail: "livePendingAt fehlt — Cooldown nicht nachweisbar, daher nicht abgelaufen." });
        throw new LiveGateError("COOLDOWN_ACTIVE", "Cooldown-Basis (livePendingAt) fehlt — Freigabe verweigert.");
      }
      const elapsed = nowMs - Date.parse(rec.livePendingAt);
      if (config.cooldownMs > 0 && elapsed < config.cooldownMs) {
        const retryAt = new Date(Date.parse(rec.livePendingAt) + config.cooldownMs).toISOString();
        this.auditDeny({ actor, venue, from, to, code: "COOLDOWN_ACTIVE", detail: `Cooldown aktiv: ${Math.max(0, config.cooldownMs - elapsed)} ms verbleibend (retryAt ${retryAt}).` });
        throw new LiveGateError(
          "COOLDOWN_ACTIVE",
          `Cooldown zwischen LIVE_PENDING und HUMAN_APPROVED noch nicht abgelaufen (retryAt ${retryAt}).`
        );
      }
      // Optionaler 4-Augen-Modus: zwei unterschiedliche Approver.
      if (config.fourEyes) {
        if (!rec.pendingApproval) {
          rec.pendingApproval = { approvedBy, at: this.nowIso() };
          try {
            rec.auditHead = this.runtime.audit.chainHead();
            this.runtime.store.write(venue, rec);
          } catch {
            /* Store-Fehler: erste Bestätigung nicht persistierbar → verweigern. */
            throw new LiveGateError("STATE_WRITE_FAILED", "Erste 4-Augen-Bestätigung konnte nicht persistiert werden — verweigert (fail-safe).");
          }
          this.runtime.audit.append({
            actor,
            venue,
            from,
            to,
            action: "four-eyes-first",
            result: "OK",
            reason: `Erste 4-Augen-Bestätigung durch ${approvedBy} — zweite, unterschiedliche Bestätigung erforderlich.`,
          });
          throw new LiveGateError(
            "FOUR_EYES_PENDING",
            `4-Augen-Modus: erste Bestätigung (${approvedBy}) recorded — zweite Bestätigung durch einen ANDEREN Approver erforderlich.`
          );
        }
        if (rec.pendingApproval.approvedBy === approvedBy) {
          this.auditDeny({ actor, venue, from, to, code: "FOUR_EYES_SAME_APPROVER", detail: `Gleicher Approver (${approvedBy}) wie die erste Bestätigung.` });
          throw new LiveGateError("FOUR_EYES_SAME_APPROVER", `4-Augen-Modus verlangt zwei unterschiedliche Approver (${approvedBy} hat bereits bestätigt).`);
        }
      }
      void reason;
    }

    if (to === "LIVE_ENABLED") {
      if (input.confirm !== true) {
        this.auditDeny({ actor, venue, from, to, code: "CONFIRM_REQUIRED", detail: "LIVE_ENABLED verlangt explizite Bestätigung (confirm:true + Begründung)." });
        throw new LiveGateError("CONFIRM_REQUIRED", "LIVE_ENABLED: confirm:true ist Pflicht (Bestätigungsdialog).");
      }
      requireReason(input.reason);
      // Enablement-Voraussetzungen (Flags, Capability, Suite, Control Plane)
      // — State-Check übersprungen (wir sind bei HUMAN_APPROVED).
      const prereq = evaluateLiveOrder(venue, {
        env: this.env,
        dir: this.runtime.dir,
        skipStateCheck: true,
        actor,
      });
      if (!prereq.allowed) {
        const code: LiveGateErrorCode = prereq.code === "ALLOWED" ? "FLAGS_MISSING" : prereq.code;
        this.auditDeny({ actor, venue, from, to, code: prereq.code, detail: prereq.reason });
        throw new LiveGateError(code, `LIVE_ENABLED verweigert: ${prereq.reason}`);
      }
    }

    // ── Automatische Checks (Intent persistieren → prüfen → committen) ──────
    const def = transitionDef(from, to);
    const checks: LiveGateCheckReport[] = [];
    const transitionId = `${venue}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (def?.check) {
      const fresh = this.runtime.store.read(venue); // aktueller Stand nach Policy
      fresh.pendingTransition = {
        id: transitionId,
        from,
        to,
        startedAt: this.nowIso(),
        actor,
      };
      try {
        fresh.auditHead = this.runtime.audit.chainHead();
        this.runtime.store.write(venue, fresh);
      } catch (err) {
        this.auditDeny({ actor, venue, from, to, code: "STATE_WRITE_FAILED", detail: `Intent nicht persistierbar: ${(err as Error).message}` });
        throw new LiveGateError("STATE_WRITE_FAILED", "Transition-Intent konnte nicht persistiert werden — Transition verweigert (fail-safe).");
      }

      const check = TRANSITION_CHECKS[def.check];
      const outcome: TransitionCheckOutcome = await check.run({
        venue,
        env: this.env,
        config,
        port: resolveGatePort(venue),
      });
      checks.push({ id: check.id, label: check.label, ok: outcome.ok, detail: outcome.detail });

      if (!outcome.ok) {
        const aborted = this.runtime.store.read(venue);
        aborted.pendingTransition = null;
        aborted.history.denials += 1;
        try {
          aborted.auditHead = this.runtime.audit.chainHead();
          this.runtime.store.write(venue, aborted);
        } catch {
          /* Best-effort; Intent wird zusätzlich unten auditiert. */
        }
        this.runtime.audit.append({
          actor,
          venue,
          from,
          to: null,
          action: "advance",
          result: "ABORTED",
          reason: `Check ${def.check} nicht bestanden: ${outcome.detail}`,
        });
        throw new LiveGateError("CHECK_FAILED", `Übergang ${from}->${to} verweigert: ${outcome.detail}`);
      }
    }

    // ── Commit (atomar; IO-Fehler → Transition zählt als fehlgeschlagen) ─────
    const commit = this.runtime.store.read(venue);
    commit.state = to;
    commit.updatedAt = this.nowIso();
    commit.updatedBy = actor;
    commit.pendingTransition = null;
    commit.pendingApproval = null;
    if (to === "LIVE_PENDING") commit.livePendingAt = commit.updatedAt;
    if (from === "LIVE_PENDING" && to !== "LIVE_PENDING") commit.livePendingAt = null;
    commit.history.transitions += 1;
    commit.history.lastTransitionAt = commit.updatedAt;
    // Audit-VOR-Commit (besser ein verwaistes OK als eine unaudierte
    // Zustandsänderung); der Kettenkopf inkl. des OK-Eintrags wird im
    // State-File dokumentiert (Truncation-Erkennung des Audits).
    this.runtime.audit.append({
      actor,
      venue,
      from,
      to,
      action: "advance",
      result: "OK",
      reason:
        checks.length > 0
          ? `Checks bestanden: ${checks.map((c) => `${c.id}=ok`).join(", ")}`
          : (input.reason ?? "").trim().slice(0, 200) || "Admin-Aktion (Policy-Übergang).",
    });
    commit.auditHead = this.runtime.audit.chainHead();
    try {
      this.runtime.store.write(venue, commit);
    } catch (err) {
      this.auditDeny({ actor, venue, from, to, code: "STATE_WRITE_FAILED", detail: `Commit nicht persistierbar: ${(err as Error).message}` });
      throw new LiveGateError("STATE_WRITE_FAILED", "Transition-Commit konnte nicht persistiert werden — Transition gilt als fehlgeschlagen (fail-safe).");
    }

    return { ok: true, venue, from, to, checks, at: commit.updatedAt as string };
  }

  /** Expliziter Admin-Downgrade → DISCONNECTED (kein Matrix-Übergang). */
  async disable(input: {
    venue: string;
    actor: string;
    reason?: string;
  }): Promise<{ ok: true; venue: BrokerVenueId; from: LiveGateState; to: "DISCONNECTED" }> {
    const venue = this.normalizeVenue(input.venue);
    const reason = requireReason(input.reason);
    const rec = this.runtime.store.read(venue);
    const from = rec.state;
    if (from === "DISCONNECTED") {
      this.auditDeny({ actor: input.actor, venue, from, to: "DISCONNECTED", code: "ILLEGAL_TRANSITION", detail: "Venue ist bereits DISCONNECTED — disable ist ein No-Op." });
      throw new LiveGateError("ILLEGAL_TRANSITION", "Venue ist bereits DISCONNECTED — nichts zu deaktivieren.");
    }
    rec.state = "DISCONNECTED";
    rec.updatedAt = this.nowIso();
    rec.updatedBy = input.actor;
    rec.pendingTransition = null;
    rec.livePendingAt = null;
    rec.pendingApproval = null;
    rec.auditHead = this.runtime.audit.chainHead();
    try {
      this.runtime.store.write(venue, rec);
    } catch (err) {
      this.auditDeny({ actor: input.actor, venue, from, to: "DISCONNECTED", code: "STATE_WRITE_FAILED", detail: (err as Error).message });
      throw new LiveGateError("STATE_WRITE_FAILED", "Disable konnte nicht persistiert werden.");
    }
    this.runtime.audit.append({
      actor: input.actor,
      venue,
      from,
      to: "DISCONNECTED",
      action: "disable",
      result: "OK",
      reason: `Expliziter Downgrade durch Admin: ${reason}`,
    });
    return { ok: true, venue, from, to: "DISCONNECTED" };
  }

  /**
   * KILL-SWITCH — aus JEDEM Zustand, sofort wirksam.
   * Reihenfolge (Failsafe-Kaskade): 1) prozesslokale Memory-Sperre,
   * 2) persistente Sperrdatei (wirkt über Neustarts + bei DB-Ausfall),
   * 3) State-Reset auf DISCONNECTED (best-effort), 4) Audit (best-effort).
   * Rückgängig NUR via clearKill + kompletten Neudurchlauf der Machine.
   */
  async kill(input: {
    venue?: string;
    scope?: string;
    actor: string;
    reason?: string;
    confirm?: string;
  }): Promise<LiveGateKillResult> {
    const scopeRaw = (input.scope ?? input.venue ?? "*").trim().toUpperCase();
    const scope = scopeRaw === "ALL" || scopeRaw === "*" ? "*" : this.normalizeVenue(scopeRaw);
    const reason = requireReason(input.reason);
    if (input.confirm !== KILL_CONFIRM_PHRASE) {
      throw new LiveGateError(
        "CONFIRM_REQUIRED",
        `Kill verlangt die serverseitige Bestätigungs-Phrase "${KILL_CONFIRM_PHRASE}" (Confirm-Dialog/CLI --confirm).`
      );
    }
    const at = this.nowIso();
    const actor = input.actor || "unknown";

    // 1) Memory (sofort, unwiderruflich bis clearKill/Restart+Clear)
    this.runtime.killedMemory.add(scope);
    // 2) Persistente Failsafe-Datei (vor dem State-Reset!).
    let failsafeFileWritten = true;
    try {
      appendKillEntry(this.runtime.dir, { scope, at, actor, reason });
    } catch {
      failsafeFileWritten = false; // Memory-Sperre bleibt wirksam (dieser Prozess)
    }

    // 3) State-Reset je betroffener Venue (best-effort).
    const venues: BrokerVenueId[] =
      scope === "*" ? ([...BROKER_VENUE_IDS] as BrokerVenueId[]) : [scope as BrokerVenueId];
    const results: LiveGateKillResult["venues"] = [];
    for (const venue of venues) {
      const rec = this.runtime.store.read(venue);
      const from = rec.state;
      rec.state = "DISCONNECTED";
      rec.updatedAt = at;
      rec.updatedBy = actor;
      rec.pendingTransition = null;
      rec.livePendingAt = null;
      rec.pendingApproval = null;
      rec.killed = { scope, at, actor, reason };
      rec.history.kills += 1;
      rec.auditHead = this.runtime.audit.chainHead();
      let stateReset = true;
      try {
        this.runtime.store.write(venue, rec);
      } catch {
        stateReset = false; // Memory + Datei sperren trotzdem.
      }
      results.push({ venue, from, stateReset });
    }

    // 4) Audit (immer; Ring hält den Eintrag auch bei Datei-/DB-Fehler).
    this.runtime.audit.append({
      actor,
      venue: scope,
      from: null,
      to: "DISCONNECTED",
      action: "kill",
      result: "KILLED",
      reason: `Kill-Switch (scope ${scope}): ${reason} — State-Reset ${results.every((r) => r.stateReset) ? "ok" : "teilweise fehlgeschlagen (Memory/Datei wirken weiterhin)"}, Failsafe-Datei ${failsafeFileWritten ? "gesetzt" : "NICHT gesetzt (nur Memory)"}.`,
    });

    return { ok: true, scope, venues: results, failsafeFileWritten, at };
  }

  /** Entfernt die Kill-Sperre (auditiert) — Zustand bleibt DISCONNECTED. */
  async clearKill(input: {
    scope?: string;
    actor: string;
    reason?: string;
    confirm?: string;
  }): Promise<{ ok: true; scope: string; removed: number; note: string }> {
    const scope = (input.scope ?? "*").trim().toUpperCase() === "*" ||
      (input.scope ?? "*").trim().toUpperCase() === "ALL"
      ? "*"
      : this.normalizeVenue((input.scope ?? "*") as string);
    const reason = requireReason(input.reason);
    if (input.confirm !== KILL_CLEAR_CONFIRM_PHRASE) {
      throw new LiveGateError(
        "CONFIRM_REQUIRED",
        `Kill-Clear verlangt die Bestätigungs-Phrase "${KILL_CLEAR_CONFIRM_PHRASE}".`
      );
    }
    const removedFile = clearKillEntries(this.runtime.dir, scope);
    this.runtime.killedMemory.delete(scope);
    // State-Dateien bleiben DISCONNECTED — kompletter Neudurchlauf erforderlich.
    this.runtime.audit.append({
      actor: input.actor || "unknown",
      venue: scope,
      from: "DISCONNECTED",
      to: null,
      action: "kill-clear",
      result: "OK",
      reason: `Kill-Sperre entfernt (${removedFile} Datei-Eintrag/e): ${reason}. Zustand bleibt DISCONNECTED — kompletter Neudurchlauf der State-Machine erforderlich.`,
    });
    return {
      ok: true,
      scope,
      removed: removedFile,
      note: "Kill-Clear öffnet KEIN Live: Zustand bleibt DISCONNECTED; kompletter Neudurchlauf (8 Übergänge inkl. Human-Gate) erforderlich.",
    };
  }

  /** Snapshot einer Venue (read-only, kein Audit-Spam). */
  snapshot(venueRaw: string): LiveGateVenueSnapshot {
    const venue = this.normalizeVenue(venueRaw);
    const config = liveGateConfig(this.env);
    const rec = this.runtime.store.read(venue);
    const decision = evaluateLiveOrder(venue, {
      env: this.env,
      dir: this.runtime.dir,
      audit: false,
    });
    const kill = this.runtime.isKilled(venue);
    const pendingMs = rec.livePendingAt ? Date.now() - Date.parse(rec.livePendingAt) : 0;
    const suite = validateSuiteStamp(readSuiteStamp(this.runtime.dir), {
      maxAgeMs: config.suiteMaxAgeMs,
    });
    return {
      venue,
      liveAvailable: VENUE_CAPABILITIES[venue]?.live === true,
      state: rec.state,
      updatedAt: rec.updatedAt,
      updatedBy: rec.updatedBy,
      livePendingAt: rec.livePendingAt,
      cooldownMs: config.cooldownMs,
      cooldownRemainingMs: rec.livePendingAt
        ? Math.max(0, config.cooldownMs - pendingMs)
        : 0,
      cooldownElapsed: !rec.livePendingAt || config.cooldownMs === 0 || pendingMs >= config.cooldownMs,
      fourEyesRequired: config.fourEyes,
      pendingApproval: rec.pendingApproval,
      killed: rec.killed,
      killSwitchActive: kill !== null,
      flags: decision.flags,
      suite: {
        valid: suite.valid,
        runId: suite.stamp?.runId ?? null,
        source: suite.stamp?.source ?? null,
      },
      controlPlaneActive: decision.controlPlaneActive,
      liveOrderAllowed: decision.allowed,
      denyCodeIfAny: decision.allowed ? null : decision.code,
      history: { ...rec.history },
    };
  }

  /** Aggregierte Übersicht (GET /api/live/state). */
  overview(): LiveGateOverview {
    const config = liveGateConfig(this.env);
    const killEntries = readKillFile(this.runtime.dir);
    const suite = validateSuiteStamp(readSuiteStamp(this.runtime.dir), {
      maxAgeMs: config.suiteMaxAgeMs,
    });
    const verification = this.verifyAudit();
    return {
      ok: true,
      policyVersion: LIVE_GATE_POLICY_VERSION,
      config: {
        dir: config.dir,
        cooldownMs: config.cooldownMs,
        fourEyes: config.fourEyes,
        paperMinOrders: config.paperMinOrders,
        suiteMaxAgeMs: config.suiteMaxAgeMs,
      },
      killSwitch: {
        active: killEntries.length > 0 || this.runtime.killedMemory.size > 0,
        scopes: [...new Set([...killEntries.map((e) => e.scope), ...this.runtime.killedMemory])],
        entries: killEntries,
      },
      suite: {
        valid: suite.valid,
        runId: suite.stamp?.runId ?? null,
        source: suite.stamp?.source ?? null,
        reason: suite.reason,
      },
      venues: [...BROKER_VENUE_IDS].map((v) => this.snapshot(v)),
      audit: {
        head: (() => {
          const head = this.runtime.audit.chainHead();
          // Gekürzter Hash in der API (Secret-Scanner-freundlich, schlanke
          // Antwort); die volle Kette steht in der NDJSON-Datei.
          return head ? { seq: head.seq, hash: `${head.hash.slice(0, 12)}…` } : null;
        })(),
        integrity: {
          ok: verification.ok,
          entries: verification.entries,
          firstBrokenSeq: verification.firstBrokenSeq,
          problem: verification.problem,
        },
        recent: this.runtime.audit.recent(20).map((e) => ({
          seq: e.seq,
          ts: e.ts,
          actor: e.actor,
          venue: e.venue,
          from: e.from,
          to: e.to,
          action: e.action,
          result: e.result,
          reason: e.reason,
          hash: `${e.hash.slice(0, 12)}…`,
        })),
      },
    };
  }

  /** Integrität der Audit-Hash-Kette (Manipulationserkennung). */
  verifyAudit(): ReturnType<typeof verifyAuditChain> {
    return verifyAuditChain(this.runtime.dir);
  }

  /** Historie (Ring; neueste zuerst). */
  history(limit = 50): LiveGateAuditEntry[] {
    return this.runtime.audit.recent(limit);
  }
}
