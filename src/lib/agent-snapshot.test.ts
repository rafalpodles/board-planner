import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

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

const COMPOSER = "69a52e3b399b27d3cbb2c5f1";
const MACHINE_OWNER = "69a52e3b399b27d3cbb2c5f2";

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
    const snapshot = await snapshotFor("p1", "a1", MACHINE_OWNER);
    expect(snapshot?.sequence.map((e) => e.key)).toEqual(["implement", "diff-size", "push"]);
  });

  it("carries a step's prompt and a gate's parameters, and never a tool list", async () => {
    agentFindById.mockReturnValue(lean(AGENT));
    const snapshot = await snapshotFor("p1", "a1", MACHINE_OWNER);
    const step = snapshot!.sequence[0];
    expect(step.prompt).toBe("do it");
    expect(step.capability).toBe("edit");
    expect(step).not.toHaveProperty("allowedTools");
    expect(snapshot!.sequence[1].params).toEqual({ maxLines: "400" });
  });

  it("returns nothing when the task names no agent", async () => {
    expect(await snapshotFor("p1", null, MACHINE_OWNER)).toBeNull();
  });

  it("still resolves the agent a task does name", async () => {
    agentFindById.mockReturnValue(lean(AGENT));

    const snapshot = await snapshotFor("p1", AGENT_ID, MACHINE_OWNER);

    expect(snapshot?.name).toBe("Default");
  });

  it("refuses the whole run when a key has no block, rather than skipping it", async () => {
    agentFindById.mockReturnValue(lean(AGENT));
    blockFind.mockReturnValue(lean(BLOCKS.filter((b) => b.key !== "diff-size")));
    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).toBeNull();
  });

  it("refuses a project agent borrowed by another project's task", async () => {
    agentFindById.mockReturnValue(lean({ ...AGENT, scope: "project", project: "other" }));
    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).toBeNull();
  });

  it("refuses an agent with nothing in it", async () => {
    agentFindById.mockReturnValue(
      lean({ ...AGENT, composition: { analysis: [], implementation: [], verification: [], delivery: [] } })
    );
    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).toBeNull();
  });
});

describe("snapshotFor and whose machine is asking", () => {
  const EMPTY = { analysis: [], implementation: [], verification: [], delivery: [] };
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logged.mockRestore();
  });

  const MINE = {
    _id: "a1",
    name: "A personal agent",
    scope: "user",
    owner: COMPOSER,
    project: null,
    composition: AGENT.composition,
  };

  it("runs a personal agent on the machine of the person who composed it", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, owner: MACHINE_OWNER }));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).not.toBeNull();
  });

  it("refuses one on a machine belonging to anybody else", async () => {
    agentFindById.mockReturnValue(lean(MINE));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).toBeNull();
  });

  it("refuses one to a machine with no owner at all", async () => {
    agentFindById.mockReturnValue(lean(MINE));

    expect(await snapshotFor("p1", "a1", null)).toBeNull();
  });

  it("refuses an ownerless personal agent rather than matching it to an ownerless machine", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, owner: null }));

    expect(await snapshotFor("p1", "a1", null)).toBeNull();
  });

  it("leaves the project's own agent alone, whoever the machine belongs to", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, scope: "project", owner: null, project: "p1" }));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).not.toBeNull();
  });

  it("leaves a global agent alone, which is shipped rather than anybody's own", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, scope: "global", owner: null }));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).not.toBeNull();
  });

  it("names the agent, whose it is, and whose machine asked", async () => {
    agentFindById.mockReturnValue(lean(MINE));

    await snapshotFor("p1", "a1", MACHINE_OWNER);

    const message = String(logged.mock.calls[0]?.[0]);
    expect(message).toContain("a1");
    expect(message).toContain(COMPOSER);
    expect(message).toContain(MACHINE_OWNER);
  });

  it("reports whose it is even when it is also empty", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, composition: EMPTY }));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).toBeNull();

    expect(String(logged.mock.calls[0]?.[0])).toContain(COMPOSER);
  });
});
