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
    expect(endState(ended("machineFault"))).toBe("Machine fault");
    expect(endState(ended("released"))).toBe("Released");
    expect(endedBadly(ended("machineFault"))).toBe(true);
    expect(endedBadly(ended("released"))).toBe(false);
  });

  // The gate's key still wins over the outcome's label, for the outcome that has one
  it("names the block that refused when there was one", () => {
    expect(endState(ended("refused", "size-strict"))).toBe("Refused: size-strict");
    expect(endState(ended("refused", "size-strict"), "project")).toBe("Refused: size-strict");
  });

  /**
   * BP-614. The project's recent runs has no Machine column and nothing to fill one with, so a
   * label naming a machine names a thing that screen withholds. The fleet's does have one.
   */
  it("tells a project reader what happened to the task, not to a machine it cannot name", () => {
    expect(endState(ended("machineFault"), "project")).toBe("Didn't finish");
    expect(endState(ended("machineFault"), "fleet")).toBe("Machine fault");
  });

  it("still colours it as a bad end for both readers", () => {
    expect(endedBadly(ended("machineFault"))).toBe(true);
  });

  it("says every other outcome the same way to both", () => {
    for (const outcome of AGENT_RUN_OUTCOMES.filter((o) => o !== "machineFault")) {
      expect(endState(ended(outcome), "project"), outcome).toBe(endState(ended(outcome), "fleet"));
    }
  });

  it("has a sentence for every outcome on the project's view too", () => {
    for (const outcome of AGENT_RUN_OUTCOMES) {
      expect(endState(ended(outcome), "project"), outcome).toBeTruthy();
    }
  });
});
