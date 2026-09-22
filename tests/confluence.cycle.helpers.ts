/**
 * Test-Hilfen der Konfluenz-Zyklus-Tests (RMA-P2-03): Ports mit
 * Spec-Mitschnitt (trustedData-Nachweis), sonst identisch zu `createTestPorts`.
 */
import {
  FakeAnalysisAgentPort,
  MemoryCycleAuditPort,
  StubAnalyticsPort,
  StubScannerPort,
} from "../src/cycle/ports";
import type { AgentInvocationResult, AgentInvocationSpec } from "../src/cycle/types";

/** Fake-Agent mit Mitschnitt der letzten Spec je Rolle (trustedData-Nachweis). */
export class CapturingAgentPort extends FakeAnalysisAgentPort {
  private lastSpecs = new Map<string, AgentInvocationSpec<unknown>>();

  override async invokeAgent<T>(spec: AgentInvocationSpec<T>): Promise<AgentInvocationResult<T>> {
    this.lastSpecs.set(spec.role, spec as AgentInvocationSpec<unknown>);
    return super.invokeAgent(spec);
  }

  lastSpecFor(role: string): AgentInvocationSpec<unknown> | undefined {
    return this.lastSpecs.get(role);
  }
}

export interface CyclePortsForTest {
  scanner: StubScannerPort;
  analytics: StubAnalyticsPort;
  agent: CapturingAgentPort;
  audit: MemoryCycleAuditPort;
}

/** Ports wie `createTestPorts`, aber mit Spec-Mitschnitt am Agenten-Port. */
export function createTestPorts(): CyclePortsForTest {
  return {
    scanner: new StubScannerPort(),
    analytics: new StubAnalyticsPort(),
    agent: new CapturingAgentPort(),
    audit: new MemoryCycleAuditPort(),
  };
}
