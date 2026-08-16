import { describe, it, expect, vi, beforeEach } from "vitest";

const agentFindById = vi.fn();
const agentFindOne = vi.fn();
const blockFind = vi.fn();
const projectFindById = vi.fn();

vi.mock("@/models/agent", () => ({
  Agent: {
    findById: (...a: unknown[]) => agentFindById(...a),
    findOne: (...a: unknown[]) => agentFindOne(...a),
  },
}));
vi.mock("@/models/agentBlock", () => ({
  AgentBlock: { find: (...a: unknown[]) => blockFind(...a) },
}));
vi.mock("@/models/project", () => ({
  Project: { findById: (...a: unknown[]) => projectFindById(...a) },
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

const BLOCKS = [
  { key: "implement", kind: "step", name: "Implement", prompt: "do it", capability: "edit", model: "opus", fallbackModel: "sonnet", deterministic: false },
  { key: "diff-size", kind: "gate", name: "Size", gateKind: "diff-size", params: { maxLines: "400" } },
  { key: "push", kind: "step", name: "Push", prompt: "", capability: "read-only", model: "", fallbackModel: "", deterministic: true },
];

beforeEach(() => {
  agentFindById.mockReset();
  agentFindOne.mockReset();
  // Nothing seeded unless a test says so, so the old "neither names one" case still means nothing
  agentFindOne.mockReturnValue(lean(null));
  blockFind.mockReset();
  projectFindById.mockReset();
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

  it("falls back to the project's default when the task names no agent", async () => {
    projectFindById.mockReturnValue(lean({ worker: { agent: "a1" } }));
    agentFindById.mockReturnValue(lean(AGENT));
    const snapshot = await snapshotFor("p1", null);
    expect(snapshot?.name).toBe("Default");
  });

  // Every project that had a worker before the catalog existed names no agent. Without this each
  // of them would stop dead on the first claim after the deploy.
  it("falls back to the seeded Default when neither the task nor the project names one", async () => {
    projectFindById.mockReturnValue(lean({ worker: {} }));
    agentFindOne.mockReturnValue(lean(AGENT));

    const snapshot = await snapshotFor("p1", null);

    expect(snapshot?.name).toBe("Default");
    expect(agentFindOne).toHaveBeenCalledWith({ scope: "global", name: "Default" });
  });

  it("has nothing to run when not even the seeded Default is there", async () => {
    projectFindById.mockReturnValue(lean({ worker: {} }));
    agentFindOne.mockReturnValue(lean(null));

    expect(await snapshotFor("p1", null)).toBeNull();
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
