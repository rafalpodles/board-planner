import { describe, it, expect, vi, beforeEach } from "vitest";

const agentFindById = vi.fn();
const blockFind = vi.fn();

vi.mock("@/models/agent", () => ({
  Agent: { findById: (...a: unknown[]) => agentFindById(...a) },
}));
vi.mock("@/models/agentBlock", () => ({
  AgentBlock: { find: (...a: unknown[]) => blockFind(...a) },
}));

const { snapshotFor } = await import("./agent-snapshot");

const lean = <T,>(value: T) => ({ lean: () => Promise.resolve(value) });

const AGENT = {
  _id: "a1",
  name: "Default",
  scope: "global",
  project: null,
  composition: {
    analysis: [],
    implementation: ["implement"],
    verification: ["diff-size"],
    delivery: ["push"],
  },
};
const AGENT_ID = AGENT._id;

const BLOCKS = [
  { key: "implement", kind: "step", name: "Implement", prompt: "do it", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false },
  { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size", params: { maxLines: "400" } },
  { key: "push", kind: "step", name: "Push", prompt: "", capability: "read-only", model: "", fallbackModel: "", deterministic: true },
];

beforeEach(() => {
  agentFindById.mockReset();
  blockFind.mockReset();
  blockFind.mockReturnValue(lean(BLOCKS));
});

describe("snapshotFor", () => {
  it("reads the buckets in order, so the worker gets one list", async () => {
    agentFindById.mockReturnValue(lean(AGENT));
    const snapshot = await snapshotFor("p1", "a1");
    expect(snapshot?.sequence.map((e) => e.key)).toEqual(["implement", "diff-size", "push"]);
  });

  it("carries a step's prompt and a gate's parameters, and never a tool list", async () => {
    agentFindById.mockReturnValue(lean(AGENT));
    const snapshot = await snapshotFor("p1", "a1");
    const step = snapshot!.sequence[0];
    expect(step.prompt).toBe("do it");
    expect(step.capability).toBe("edit");
    expect(step).not.toHaveProperty("allowedTools");
    expect(snapshot!.sequence[1].params).toEqual({ maxLines: "400" });
  });

  // Choosing an agent is how work is handed to a machine, so no agent means a person is doing it.
  // The old chain — task agent, then the project default, then the seeded "Default" — meant an empty
  // field still ran something, and there was no way to say "not this one".
  it("returns nothing when the task names no agent", async () => {
    expect(await snapshotFor("p1", null)).toBeNull();
  });

  it("still resolves the agent a task does name", async () => {
    agentFindById.mockReturnValue(lean(AGENT));

    const snapshot = await snapshotFor("p1", AGENT_ID);

    expect(snapshot?.name).toBe("Default");
  });

  // A shorter agent than the one somebody composed is worse than a refusal: it runs, and the
  // missing check looks like a check that passed
  it("refuses the whole run when a key has no block, rather than skipping it", async () => {
    agentFindById.mockReturnValue(lean(AGENT));
    blockFind.mockReturnValue(lean(BLOCKS.filter((b) => b.key !== "diff-size")));
    expect(await snapshotFor("p1", "a1")).toBeNull();
  });

  it("refuses a project agent borrowed by another project's task", async () => {
    agentFindById.mockReturnValue(lean({ ...AGENT, scope: "project", project: "other" }));
    expect(await snapshotFor("p1", "a1")).toBeNull();
  });

  it("refuses an agent with nothing in it", async () => {
    agentFindById.mockReturnValue(
      lean({ ...AGENT, composition: { analysis: [], implementation: [], verification: [], delivery: [] } })
    );
    expect(await snapshotFor("p1", "a1")).toBeNull();
  });
});
