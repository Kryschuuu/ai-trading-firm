/**
 * Step-Engine für den Agenten-Zyklus (Task 06).
 *
 * Führt Schritte sequenziell aus und garantiert:
 *   - Entkopplung: Schritte mit llmAllowed = false dürfen kein LLM anrufen (Laufzeit-Gate).
 *   - Input- und Output-Schema-Validierung je Schritt.
 *   - Konfigurierbare Retry-Policy je Schritt (Backoff + MaxAttempts).
 *   - Kontrollierter Abbruch bei Fehlern (Zyklusstatus FAILED, Audit-Log, bisherige Artefakte intakt).
 *   - Erfassung und Logging von MODEL_ESCALATION_REQUEST-Events.
 */

import {
  type Clock,
  type CyclePorts,
  type CycleRunRecord,
  type CycleStatus,
  type ModelEscalationRequest,
  type StepDefinition,
  type StepExecutionContext,
  type StepRunRecord,
  type AnalysisAgentPort,
} from "./types";

export interface CycleExecutionOptions {
  cycleId: string;
  type: "daily" | "weekly";
  date: string; // YYYY-MM-DD
  week?: string;
  steps: StepDefinition[];
  ports: CyclePorts;
  clock: Clock;
  initialInput?: unknown;
}

/**
 * Erzeugt einen Proxy für den Agenten-Port, der Aufrufe blockiert,
 * falls llmAllowed = false konfiguriert ist.
 */
function createGuardedAgentPort(baseAgentPort: AnalysisAgentPort, llmAllowed: boolean, stepId: string): AnalysisAgentPort {
  if (llmAllowed) {
    return baseAgentPort;
  }
  return {
    async invokeAgent() {
      throw new Error(`Architektur-Verletzung: Schritt "${stepId}" hat llmAllowed=false, darf kein LLM aufrufen!`);
    },
  };
}

/**
 * Wartet asynchron für Backoff-Verzögerungen.
 */
async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Führt einen vollständigen Zyklus (Daily oder Weekly) über die Step-Engine aus.
 */
export async function executeCycle(options: CycleExecutionOptions): Promise<CycleRunRecord> {
  const { cycleId, type, date, week, steps, ports, clock, initialInput } = options;
  const startedAt = clock.toISOString();
  const startTimeMs = clock.nowMs();

  const stepRecords: StepRunRecord[] = [];
  const escalations: ModelEscalationRequest[] = [];
  const stepOutputs: Record<string, unknown> = {};

  // Zyklusstart auditieren
  await ports.audit.logEvent({
    event: "CYCLE_STARTED",
    level: "INFO",
    cycleId,
    timestamp: clock.toISOString(),
    detail: { type, date, week, stepCount: steps.length },
  });

  let cycleStatus: CycleStatus = "RUNNING";
  let failureError: { stepId: string; message: string; code?: string } | undefined;
  let currentInput: unknown = initialInput;

  for (const step of steps) {
    const stepRecord: StepRunRecord = {
      stepId: step.stepId,
      role: step.role,
      status: "PENDING",
      attempts: 0,
      startedAt: clock.toISOString(),
    };
    stepRecords.push(stepRecord);

    const retryPolicy = step.retryPolicy ?? { maxAttempts: 1, backoffMs: 0 };
    const maxAttempts = Math.max(1, retryPolicy.maxAttempts);
    let stepSuccess = false;
    let lastStepError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      stepRecord.attempts = attempt;

      if (attempt > 1) {
        await ports.audit.logEvent({
          event: "CYCLE_STEP_RETRY",
          level: "WARN",
          cycleId,
          stepId: step.stepId,
          role: step.role,
          timestamp: clock.toISOString(),
          detail: { attempt, maxAttempts, lastError: String(lastStepError) },
        });

        const multiplier = retryPolicy.backoffMultiplier ?? 2;
        const delayMs = retryPolicy.backoffMs * Math.pow(multiplier, attempt - 2);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      } else {
        stepRecord.status = "RUNNING";
        await ports.audit.logEvent({
          event: "CYCLE_STEP_STARTED",
          level: "INFO",
          cycleId,
          stepId: step.stepId,
          role: step.role,
          timestamp: clock.toISOString(),
          detail: { timeWindow: step.timeWindow, llmAllowed: step.llmAllowed },
        });
      }

      try {
        // 1. Input-Validierung
        const validatedInput = step.validateInput ? step.validateInput(currentInput) : currentInput;

        // 2. Guarded Ports (LLM-Sperre bei llmAllowed = false)
        const guardedAgentPort = createGuardedAgentPort(ports.agent, step.llmAllowed, step.stepId);
        const guardedPorts: CyclePorts = {
          ...ports,
          agent: guardedAgentPort,
        };

        // 3. Execution Context
        const context: StepExecutionContext = {
          cycleId,
          date,
          asOf: clock.now(),
          clock,
          input: validatedInput,
          previousStepOutputs: Object.freeze({ ...stepOutputs }),
          ports: guardedPorts,
          emitEscalation(esc) {
            const fullEsc: ModelEscalationRequest = {
              ...esc,
              timestamp: clock.toISOString(),
            };
            escalations.push(fullEsc);
            void ports.audit.logEvent({
              event: "MODEL_ESCALATION_REQUEST",
              level: "WARN",
              cycleId,
              stepId: step.stepId,
              role: step.role,
              timestamp: clock.toISOString(),
              detail: fullEsc as unknown as Record<string, unknown>,
            });
          },
          log(msg, level = "INFO") {
            void ports.audit.logEvent({
              event: "CYCLE_STEP_STARTED", // Audit logging
              level,
              cycleId,
              stepId: step.stepId,
              role: step.role,
              timestamp: clock.toISOString(),
              detail: { message: msg },
            });
          },
        };

        const rawOutput = await step.execute(context);

        // 4. Output-Validierung
        const validatedOutput = step.validateOutput ? step.validateOutput(rawOutput) : rawOutput;

        // 5. Erfolg verbuchen
        stepRecord.status = "COMPLETED";
        stepRecord.completedAt = clock.toISOString();
        stepRecord.durationMs = clock.nowMs() - startTimeMs;
        stepOutputs[step.stepId] = validatedOutput;
        currentInput = validatedOutput;
        stepSuccess = true;

        await ports.audit.logEvent({
          event: "CYCLE_STEP_COMPLETED",
          level: "INFO",
          cycleId,
          stepId: step.stepId,
          role: step.role,
          timestamp: clock.toISOString(),
          detail: { attempts: attempt },
        });

        break; // Retry-Schleife verlassen
      } catch (err) {
        lastStepError = err;
        stepRecord.error = err instanceof Error ? err.message : String(err);
      }
    }

    if (!stepSuccess) {
      // Kontrollierter Abbruch bei Fehlschlag des Schritts
      stepRecord.status = "FAILED";
      stepRecord.completedAt = clock.toISOString();
      stepRecord.durationMs = clock.nowMs() - startTimeMs;
      cycleStatus = "FAILED";
      failureError = {
        stepId: step.stepId,
        message: stepRecord.error ?? "Unbekannter Fehler bei Schrittausführung",
      };

      await ports.audit.logEvent({
        event: "CYCLE_STEP_FAILED",
        level: "CRITICAL",
        cycleId,
        stepId: step.stepId,
        role: step.role,
        timestamp: clock.toISOString(),
        detail: { attempts: stepRecord.attempts, error: failureError.message },
      });

      await ports.audit.logEvent({
        event: "CYCLE_FAILED",
        level: "CRITICAL",
        cycleId,
        timestamp: clock.toISOString(),
        detail: { failedAtStep: step.stepId, error: failureError.message },
      });

      break; // Pipeline abbrechen
    }
  }

  if (cycleStatus === "RUNNING") {
    cycleStatus = "COMPLETED";
    await ports.audit.logEvent({
      event: "CYCLE_COMPLETED",
      level: "INFO",
      cycleId,
      timestamp: clock.toISOString(),
      detail: { durationMs: clock.nowMs() - startTimeMs, stepCount: stepRecords.length },
    });
  }

  return {
    id: cycleId,
    type,
    date,
    week,
    status: cycleStatus,
    startedAt,
    completedAt: clock.toISOString(),
    durationMs: clock.nowMs() - startTimeMs,
    steps: stepRecords,
    escalations,
    artifacts: [],
    error: failureError,
  };
}
