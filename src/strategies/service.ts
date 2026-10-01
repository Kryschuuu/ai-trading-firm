/**
 * STX-04-02 — Strategy-Catalog-Service + Lifecycle-Bridging (Phase 4, Paket 04-01/00-02).
 *
 * Überführt Templates aus dem Code in unveränderliche, referenzierbare
 * Versionen in `strategy_definitions` und `strategy_versions` und verbindet sie
 * mit dem Lifecycle (`strategy_lifecycle_states`), sodass z. B. BACKTEST_PENDING
 * eine auflösbare (strategy_key, strategy_version) bekommt.
 *
 * Sicherheits-/Architekturregeln:
 * - Kein Update / kein Delete auf `strategy_versions` (immutable).
 * - Keine automatische Promotion / kein `requestTransition` hier.
 * - Live-Ausführung bleibt beim `trade_rules`-Pfad (dieser Service ist Registry, nicht Executor).
 * - Keine Änderung an `src/strategyLifecycle/**`.
 * - Bounded Audit & Telemetrie (keine Parameterinhalte im Label).
 */

import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  strategyDefinitions,
  strategyVersions,
  strategyLifecycleStates,
} from "@/db/schema";
import { writeAuditRecord, type AuditWriteOutcome } from "@/lib/auditSink";
import { APP_VERSION } from "@/lib/version";
import { telemetry } from "@/lib/telemetry";
import { DEFAULT_PROMOTION_POLICY } from "@/strategyLifecycle/policies";
import {
  canonicalJson,
  normalizeStrategyKey,
  normalizeStrategyVersion,
} from "@/strategyLifecycle/evidence";
import {
  compileTemplate,
  type CompileTemplateInput,
} from "./compiler";
import { getTemplate, isStrategyTemplateId } from "./catalog";
import type { StrategyTemplateId } from "./catalog";
import type { SupportedTimeframe } from "@/lib/marketdata/historicalStore";
import type { StrategyClassKey } from "@/lib/signalDecay";

export type StrategyDefinitionRow = typeof strategyDefinitions.$inferSelect;
export type StrategyVersionRow = typeof strategyVersions.$inferSelect;

export interface EnsureDefinitionInput {
  templateId: string;
  strategyClass?: string;
  name: string;
  description?: string;
  createdBy?: string;
}

export interface CreateVersionInput {
  definitionId: string;
  templateId: string;
  symbol: string;
  timeframe: SupportedTimeframe;
  params?: Readonly<Record<string, number>>;
  codeVersion?: string;
  createdBy?: string;
}

export interface CreateVersionResult {
  versionId: string;
  version: number;
  fingerprint: string;
  created: boolean;
}

export type TemplateDriftStatus = "CURRENT" | "TEMPLATE_ADVANCED" | "CODE_ADVANCED";

export interface TemplateDriftResult {
  status: TemplateDriftStatus;
  storedTemplateVersion: number;
  currentTemplateVersion: number | null;
  storedCodeVersion: string;
  currentCodeVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit & Hash-Helfer
// ─────────────────────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Berechnet den Content-Hash nach Schema `stv1:<sha256>` für ein
 * kompiliertes Versions-Artefakt (Idempotenzanker).
 */
export function calculateVersionContentHash(input: {
  definitionId: string;
  templateId: string;
  timeframe: string;
  params: Readonly<Record<string, number>>;
  ruleSpec: unknown;
  templateVersion: number;
  codeVersion: string;
}): string {
  const canonical = canonicalJson({
    definitionId: input.definitionId,
    templateId: input.templateId,
    timeframe: input.timeframe,
    params: input.params,
    ruleSpec: input.ruleSpec,
    templateVersion: input.templateVersion,
    codeVersion: input.codeVersion,
  });
  return `stv1:${sha256(canonical)}`;
}

/**
 * Audit-Protokollierung mit bounded Labels — keine Parameter-Inhalte im Log.
 */
async function auditStrategyVersionCreated(params: {
  versionId: string;
  fingerprint: string;
  templateId: string;
  createdBy: string;
}): Promise<AuditWriteOutcome> {
  return writeAuditRecord({
    event: "STRATEGY_VERSION_CREATED",
    level: "INFO",
    detail: {
      action: "strategy_version_created",
      versionId: params.versionId,
      fingerprint: params.fingerprint,
      templateId: params.templateId,
      actor: params.createdBy,
    },
    auditClass: "security",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) ensureDefinition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legt eine `strategy_definitions`-Zeile an oder gibt die bestehende zurück.
 * Idempotenz über (template_id, name).
 */
export async function ensureDefinition(
  input: EnsureDefinitionInput
): Promise<StrategyDefinitionRow> {
  if (!input.templateId || typeof input.templateId !== "string") {
    throw new Error("ensureDefinition: templateId ist erforderlich.");
  }
  if (!input.name || typeof input.name !== "string" || input.name.trim().length === 0) {
    throw new Error("ensureDefinition: name ist erforderlich.");
  }

  const templateId = input.templateId.trim();
  const name = input.name.trim();

  // Bestehende Definition suchen
  const existing = await db
    .select()
    .from(strategyDefinitions)
    .where(
      and(
        eq(strategyDefinitions.templateId, templateId),
        eq(strategyDefinitions.name, name)
      )
    )
    .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  // Bestimme strategyClass (aus Template im Katalog oder aus Input)
  let strategyClass: StrategyClassKey | string = input.strategyClass ?? "";
  if (!strategyClass) {
    if (isStrategyTemplateId(templateId)) {
      const tmpl = getTemplate(templateId as StrategyTemplateId);
      if (tmpl && tmpl.class !== "unclassified") {
        strategyClass = tmpl.class;
      }
    }
  }

  if (!strategyClass || !["mean-reversion", "trend", "breakout"].includes(strategyClass)) {
    throw new Error(
      `ensureDefinition: Ungültige oder fehlende strategyClass „${strategyClass}“ für Template ${templateId}.`
    );
  }

  const description = input.description?.trim() || `Strategy definition for ${name} (${templateId})`;
  const createdBy = input.createdBy?.trim() || "system";

  const [row] = await db
    .insert(strategyDefinitions)
    .values({
      templateId,
      strategyClass,
      name,
      description,
      createdBy,
    })
    .onConflictDoNothing({
      target: [strategyDefinitions.templateId, strategyDefinitions.name],
    })
    .returning();

  if (row) {
    return row;
  }

  // Bei Race-Condition Zeile erneut laden
  const raced = await db
    .select()
    .from(strategyDefinitions)
    .where(
      and(
        eq(strategyDefinitions.templateId, templateId),
        eq(strategyDefinitions.name, name)
      )
    )
    .limit(1);

  if (!raced[0]) {
    throw new Error(`ensureDefinition: Anlegen der Definition fehlgeschlagen (${templateId}, ${name}).`);
  }
  return raced[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) strategyKeyFor & resolveStrategyKey
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministische Brücke zum Lifecycle: `<template_id>@v<version>`
 * über `normalizeStrategyKey` normalisiert. Kein Freitext vom Aufrufer.
 */
export function strategyKeyFor(versionRow: {
  templateId?: string;
  version: number;
}): string {
  if (!versionRow.templateId) {
    throw new Error("strategyKeyFor: templateId fehlt.");
  }
  const rawKey = `${versionRow.templateId}@v${versionRow.version}`;
  const normalized = normalizeStrategyKey(rawKey);
  if (!normalized) {
    throw new Error(`strategyKeyFor: Normalisierung fehlgeschlagen für „${rawKey}“.`);
  }
  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) getVersionByFingerprint, listVersions, resolveStrategyKey
// ─────────────────────────────────────────────────────────────────────────────

export async function getVersionByFingerprint(
  fingerprint: string
): Promise<StrategyVersionRow | null> {
  if (!fingerprint) return null;
  const rows = await db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.fingerprint, fingerprint))
    .limit(1);
  return rows[0] ?? null;
}

export async function listVersions(
  definitionId: string
): Promise<StrategyVersionRow[]> {
  if (!definitionId) return [];
  return db
    .select()
    .from(strategyVersions)
    .where(eq(strategyVersions.definitionId, definitionId))
    .orderBy(desc(strategyVersions.createdAt));
}

export async function resolveStrategyKey(
  versionId: string
): Promise<{ strategyKey: string; strategyVersion: number; versionRow: StrategyVersionRow } | null> {
  if (!versionId) return null;
  const rows = await db
    .select({
      versionRow: strategyVersions,
      templateId: strategyDefinitions.templateId,
    })
    .from(strategyVersions)
    .innerJoin(strategyDefinitions, eq(strategyVersions.definitionId, strategyDefinitions.id))
    .where(eq(strategyVersions.id, versionId))
    .limit(1);

  if (!rows[0]) return null;

  const key = strategyKeyFor({
    templateId: rows[0].templateId,
    version: rows[0].versionRow.version,
  });

  return {
    strategyKey: key,
    strategyVersion: rows[0].versionRow.version,
    versionRow: rows[0].versionRow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) createVersion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Erzeugt eine neue unveränderliche Version einer Strategie oder gibt die bestehende
 * zurück, falls der Fingerprint bereits existiert.
 *
 * Schritte:
 * 1. Template + Params + Timeframe ⇒ compileTemplate()
 *    bei { ok: false } ⇒ wirf Error
 * 2. Fingerprint prüfen: existiert ⇒ bestehende Zeile zurückgeben (Idempotenz)
 * 3. Sonst INSERT in `strategy_versions` und INSERT in `strategy_lifecycle_states`
 *    in EINER DB-Transaktion.
 * 4. Audit-Eintrag schreiben (ohne Params-Inhalte).
 * 5. Telemetrie inkrementieren: `strategy_versions_total{result="created"|"duplicate"}`.
 */
export async function createVersion(
  input: CreateVersionInput
): Promise<CreateVersionResult> {
  const codeVersion = input.codeVersion ?? APP_VERSION;
  const createdBy = input.createdBy ?? "system";

  // 1) Kompilieren
  const compileInput: CompileTemplateInput = {
    templateId: input.templateId,
    symbol: input.symbol,
    timeframe: input.timeframe,
    params: input.params,
    codeVersion,
  };

  const compiled = compileTemplate(compileInput);
  if (!compiled.ok) {
    telemetry.strategyLifecycle.versions.inc({ result: "compile_error" });
    throw new Error(
      `createVersion: Template-Kompilierung fehlgeschlagen für ${input.templateId}: ${compiled.errors.join("; ")}`
    );
  }

  // 2) Idempotenzprüfung per Fingerprint
  const existingByFp = await getVersionByFingerprint(compiled.fingerprint);
  if (existingByFp) {
    telemetry.strategyLifecycle.versions.inc({ result: "duplicate" });
    return {
      versionId: existingByFp.id,
      version: existingByFp.version,
      fingerprint: existingByFp.fingerprint,
      created: false,
    };
  }

  // Template-Version aus Katalog
  let tmplVer = 1;
  if (isStrategyTemplateId(input.templateId)) {
    const tmpl = getTemplate(input.templateId as StrategyTemplateId);
    if (tmpl) tmplVer = tmpl.version;
  }

  const contentHash = calculateVersionContentHash({
    definitionId: input.definitionId,
    templateId: input.templateId,
    timeframe: input.timeframe,
    params: (compiled.spec.condition ? input.params ?? {} : {}),
    ruleSpec: compiled.spec,
    templateVersion: tmplVer,
    codeVersion,
  });

  // 3) INSERT strategy_versions + strategy_lifecycle_states in einer Transaktion
  const txResult = await db.transaction(async (tx) => {
    // Doppelprüfung innerhalb der Transaktion (Race-Conditions abfangen)
    const racedFp = await tx
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.fingerprint, compiled.fingerprint))
      .limit(1);

    if (racedFp[0]) {
      return { row: racedFp[0], created: false };
    }

    // Nächste Versionsnummer für die definitionId ermitteln
    const latestRows = await tx
      .select({ version: strategyVersions.version })
      .from(strategyVersions)
      .where(eq(strategyVersions.definitionId, input.definitionId))
      .orderBy(desc(strategyVersions.version))
      .limit(1);

    const nextVersion = (latestRows[0]?.version ?? 0) + 1;

    // INSERT strategy_versions
    const [newVersionRow] = await tx
      .insert(strategyVersions)
      .values({
        definitionId: input.definitionId,
        version: nextVersion,
        paramsJson: input.params ?? {},
        ruleSpecJson: compiled.spec,
        timeframe: input.timeframe,
        fingerprint: compiled.fingerprint,
        contentHash,
        codeVersion,
        templateVersion: tmplVer,
        createdBy,
      })
      .returning();

    // strategy_key für Lifecycle ableiten: <template_id>@v<version>
    const stratKey = strategyKeyFor({
      templateId: input.templateId,
      version: nextVersion,
    });

    const normKey = normalizeStrategyKey(stratKey);
    const normVer = normalizeStrategyVersion(nextVersion);
    if (!normKey || normVer === null) {
      throw new Error(`createVersion: Ungültige Lifecycle-Identität für ${stratKey}`);
    }

    // INSERT in strategy_lifecycle_states (ensureLifecycleDraft-Äquivalent in tx)
    await tx
      .insert(strategyLifecycleStates)
      .values({
        strategyKey: normKey,
        strategyVersion: normVer,
        state: "DRAFT",
        stateSeq: 0,
        policyVersion: DEFAULT_PROMOTION_POLICY.version,
        riskScale: "1",
        cooldownUntil: null,
        lastEvidenceId: null,
        ruleKey: null,
        updatedBy: createdBy,
      })
      .onConflictDoNothing({
        target: [strategyLifecycleStates.strategyKey, strategyLifecycleStates.strategyVersion],
      });

    return { row: newVersionRow, created: true };
  });

  if (txResult.created) {
    // 4) Audit
    await auditStrategyVersionCreated({
      versionId: txResult.row.id,
      fingerprint: txResult.row.fingerprint,
      templateId: input.templateId,
      createdBy,
    });

    // 5) Telemetrie
    telemetry.strategyLifecycle.versions.inc({ result: "created" });
  } else {
    telemetry.strategyLifecycle.versions.inc({ result: "duplicate" });
  }

  return {
    versionId: txResult.row.id,
    version: txResult.row.version,
    fingerprint: txResult.row.fingerprint,
    created: txResult.created,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) checkTemplateDrift (Drift-Wächter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vergleicht template_version + code_version der gespeicherten Version mit dem
 * aktuellen Katalog.
 *
 * Ergebnis:
 * - `CURRENT`
 * - `TEMPLATE_ADVANCED` (Katalog-Template hat eine höhere Versionsnummer)
 * - `CODE_ADVANCED` (APP_VERSION weicht von der Erzeugungs-Version ab)
 *
 * Ändert nichts — nur melden!
 */
export async function checkTemplateDrift(
  versionId: string
): Promise<TemplateDriftResult> {
  const resolved = await resolveStrategyKey(versionId);
  if (!resolved) {
    throw new Error(`checkTemplateDrift: Version „${versionId}“ wurde nicht gefunden.`);
  }

  const { versionRow } = resolved;
  const defRows = await db
    .select()
    .from(strategyDefinitions)
    .where(eq(strategyDefinitions.id, versionRow.definitionId))
    .limit(1);

  const templateId = defRows[0]?.templateId;
  let currentTmplVersion: number | null = null;

  if (templateId && isStrategyTemplateId(templateId)) {
    const currentTmpl = getTemplate(templateId as StrategyTemplateId);
    if (currentTmpl) {
      currentTmplVersion = currentTmpl.version;
    }
  }

  let status: TemplateDriftStatus = "CURRENT";

  if (currentTmplVersion !== null && currentTmplVersion > versionRow.templateVersion) {
    status = "TEMPLATE_ADVANCED";
  } else if (versionRow.codeVersion !== APP_VERSION) {
    status = "CODE_ADVANCED";
  }

  return {
    status,
    storedTemplateVersion: versionRow.templateVersion,
    currentTemplateVersion: currentTmplVersion,
    storedCodeVersion: versionRow.codeVersion,
    currentCodeVersion: APP_VERSION,
  };
}
