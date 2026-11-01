import { describe, expect, it, vi } from "vitest";
import { claimedTask } from "./__fixtures__/task.js";
import { createSettingsHolds } from "./settings-hold.js";
import type { ClaimedTask } from "./types.js";

const SETTINGS = { baseBranch: "main", testCommand: "./bin/tst" };

const onAgent = (agentId: string, projectId = "P1"): ClaimedTask => ({
  ...claimedTask(),
  projectId,
  agent: {
    agentId,
    name: "An agent",
    sequence: [
      { key: "implement", kind: "step", name: "Implement", prompt: "", capability: "edit", model: "", fallbackModel: "", deterministic: false, gateKind: "", params: {} },
      { key: "our-build", kind: "gate", name: "Builds", prompt: "", capability: "read-only", model: "", fallbackModel: "", deterministic: false, gateKind: "build", params: {} },
      { key: "security-review", kind: "gate", name: "Security review", prompt: "", capability: "read-only", model: "", fallbackModel: "", deterministic: false, gateKind: "review", params: {} },
      { key: "test-run", kind: "gate", name: "Tests pass", prompt: "", capability: "read-only", model: "", fallbackModel: "", deterministic: false, gateKind: "test-run", params: {} },
    ],
  },
});

describe("what a settings fault holds", () => {
  it("is nothing until a run faults", () => {
    expect(createSettingsHolds(vi.fn()).heldAgents("P1", SETTINGS)).toEqual([]);
  });

  it("is the agent, with its gates in order and no step, for as long as the settings stand", () => {
    const holds = createSettingsHolds(vi.fn());
    holds.hold(onAgent("a1"), SETTINGS);

    const held = [{ agentId: "a1", gates: ["build", "review", "test-run"] }];
    expect(holds.heldAgents("P1", { ...SETTINGS })).toEqual(held);
    expect(holds.heldAgents("P1", SETTINGS)).toEqual(held);
  });

  it.each([
    ["a command", { testCommand: "./bin/test" }],
    ["a command that was empty", { installCommand: "npm ci" }],
    ["the working directory", { workingDirectory: "apps/web" }],
    ["the base branch", { baseBranch: "develop" }],
    ["the list of repositories", { remotes: ["git@github.com:acme/new.git"] }],
  ])("lets go once %s changes, and stays gone if it is changed back", (_what, change) => {
    const log = vi.fn();
    const holds = createSettingsHolds(log);
    holds.hold(onAgent("a1"), SETTINGS);

    expect(holds.heldAgents("P1", { ...SETTINGS, ...change })).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("claiming for agent a1 again"));
    expect(holds.heldAgents("P1", SETTINGS)).toEqual([]);
  });

  it("lasts a day and no longer, for a fix that lands in the repository and changes no setting", () => {
    let clock = 1_000;
    const holds = createSettingsHolds(vi.fn(), () => clock);
    holds.hold(onAgent("a1"), SETTINGS);

    clock += 24 * 60 * 60_000 - 1;
    expect(holds.heldAgents("P1", SETTINGS)).toHaveLength(1);

    clock += 1;
    expect(holds.heldAgents("P1", SETTINGS)).toEqual([]);
  });

  it("does not reach another project, or an agent the fault did not touch", () => {
    const holds = createSettingsHolds(vi.fn());
    holds.hold(onAgent("a1"), SETTINGS);
    holds.hold(onAgent("a2", "P2"), SETTINGS);

    expect(holds.heldAgents("P1", SETTINGS).map((entry) => entry.agentId)).toEqual(["a1"]);
    expect(holds.heldAgents("P2", SETTINGS).map((entry) => entry.agentId)).toEqual(["a2"]);
  });

  it("names each agent once, with what its latest fault saw", () => {
    const holds = createSettingsHolds(vi.fn());
    holds.hold(onAgent("a1"), SETTINGS);
    const later = onAgent("a1");
    holds.hold({ ...later, agent: { ...later.agent, sequence: later.agent.sequence.slice(0, 2) } }, { ...SETTINGS, testCommand: "./bin/other" });

    expect(holds.heldAgents("P1", { ...SETTINGS, testCommand: "./bin/other" })).toEqual([{ agentId: "a1", gates: ["build"] }]);
  });

  // The server refuses a claim naming a malformed id, so one such entry would stop the project
  it("holds nothing for an agent with no id", () => {
    const holds = createSettingsHolds(vi.fn());
    holds.hold(onAgent(""), SETTINGS);

    expect(holds.heldAgents("P1", SETTINGS)).toEqual([]);
  });
});
