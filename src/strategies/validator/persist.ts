/**
 * STX-06-04 — Evidence-Writer des Validators (Phase 6, Finding STX-17).
 *
 * ── Ein einziger Schreibpfad ────────────────────────────────────────────────
 * Dieses Modul schreibt **nicht** selbst in die Datenbank. Es übersetzt den
 * {@link StrategyValidationReport} in einen `EvidenceInput` und übergibt ihn an
 * `recordEvidence()` aus `@/strategyLifecycle` — den bestehenden, idempotenten
 * Schreibpfad der Lifecycle-Evidenz. Damit gelten unverändert:
 *
 * | Zusage | Mechanik |
 * |---|---|
 * | Genau eine Zeile je Inhalt | `content_hash` + `idempotency_key` (UNIQUE) aus `strategyLifecycle/evidence.ts` |
 * | Kein Doppel-Write bei Retry | `recordEvidence()` liest den Idempotency-Key vor dem Insert und fängt `23505` ab |
 * | Zeitsemantik | `available_at ≥ event_time`, `computed_at ≥ available_at` — vom Report garantiert, hier erneut geprüft |
 * | Provenienz | `policy_version`, `code_version`, `data_version`, `backtest_run_id`, Fenster, `sample_size` |
 *
 * ── Was dieses Modul ausdrücklich NICHT tut ────────────────────────────────
 * - **Kein `requestTransition`.** Der Validator liefert Evidenz; über die
 *   Promotion entscheidet der Lifecycle (`evaluatePromotionGate` +
 *   `requestTransition`). Es gibt hier keinen Import dieser Funktion.
 * - **Keine eigene Hashfunktion.** `evidenceHash` kommt aus
 *   `evidenceContentHash()`, `idempotencyKey` aus `evidenceIdempotencyKey()`.
 *   `assertReportHashIntegrity()` weist einen nachträglich veränderten Report
 *   fail-closed ab — es wird nie eine Zeile geschrieben, deren Hash nicht zum
 *   Inhalt passt.
 * - **Keine Uhr.** `eventTime`/`availableAt`/`computedAt` stammen aus dem
 *   Report; `computedAt` ist nie ein Zulässigkeitskriterium, nur Bestandteil
 *   der Zeit-Semantik.
 */
import { recordEvidence } from "@/strategyLifecycle";
import type { EvidenceRow } from "@/strategyLifecycle";

import type { StrategyValidationReport } from "./report";
import { assertReportHashIntegrity, validationEvidenceInput } from "./report";

/** Ergebnis eines Schreibversuchs — `created` unterscheidet Insert von Retry. */
export interface WriteValidationEvidenceResult {
  readonly evidence: EvidenceRow;
  /** `true` = neue Zeile; `false` = identische Evidenz existierte bereits. */
  readonly created: boolean;
}

/**
 * Schreibt die Validierungs-Evidenz über den Lifecycle-Schreibpfad.
 *
 * Idempotent: Ein zweiter Aufruf mit demselben Report liefert dieselbe Zeile
 * (`created: false`) — der UNIQUE-Index auf `idempotency_key` greift, auch bei
 * parallelen Läufen (`recordEvidence` fängt die Unique-Verletzung ab).
 * Ein Report mit falschem `evidenceHash`/`idempotencyKey` wird abgewiesen.
 */
export async function writeValidationEvidenceDetailed(
  report: StrategyValidationReport,
): Promise<WriteValidationEvidenceResult> {
  if (!report || typeof report !== "object") {
    throw new Error("writeValidationEvidence: Report fehlt (0 Felder lesbar).");
  }
  // Fail-closed: Der Report muss seinen eigenen Hash tragen, sonst würde eine
  // Zeile entstehen, deren Inhalt nicht zur behaupteten Evidenz passt.
  assertReportHashIntegrity(report);
  const input = validationEvidenceInput(report);
  const { evidence, created } = await recordEvidence(input);
  return { evidence, created };
}

/** Wie {@link writeValidationEvidenceDetailed}, aber nur die Zeile. */
export async function writeValidationEvidence(
  report: StrategyValidationReport,
): Promise<EvidenceRow> {
  const { evidence } = await writeValidationEvidenceDetailed(report);
  return evidence;
}
