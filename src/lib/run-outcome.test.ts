import { describe, it, expect } from "vitest";
import { endState, endedBadly } from "./run-outcome";
import { AGENT_RUN_OUTCOMES, AgentRunOutcome } from "@/types";

const ended = (outcome: AgentRunOutcome, refusedBy = "") => ({ outcome, refusedBy });

describe("how a finished run reads", () => {
  // Both views read this one definition, so a missing label is a blank cell on the fleet history
  // and on the project's recent runs at once.
  it("has a sentence for every outcome the server records", () => {
    for (const outcome of AGENT_RUN_OUTCOMES) {
      expect(endState(ended(outcome)), outcome).toBeTruthy();
    }
  });

  /**
   * BP-609. A machine fault and a usage-limit release are the same board action — the task goes
   * back to the queue, attempt refunded — and the outcome is the only thing that separates them.
   * Read as "Released", an operator is never told which of their machines has stopped working.
   */
  it("says a machine fault apart from a release, and colours it as a bad end", () => {
    expect(endState(ended("faulted"))).toBe("Machine fault");
    expect(endState(ended("released"))).toBe("Released");
    expect(endedBadly(ended("faulted"))).toBe(true);
    expect(endedBadly(ended("released"))).toBe(false);
  });

  // The gate's key still wins over the outcome's label, for the outcome that has one
  it("names the block that refused when there was one", () => {
    expect(endState(ended("refused", "size-strict"))).toBe("Refused: size-strict");
  });
});
