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

// Three ids that must never be allowed to stand for one another. COMPOSER is whose personal agent
// it is, MACHINE_OWNER is who the claiming machine belongs to, and the project is "p1" — a fixture
// sharing an id between any two of them cannot tell "composed it" from "the machine is theirs".
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

  // Choosing an agent is how work is handed to a machine, so no agent means a person is doing it.
  // The old chain — task agent, then the project default, then the seeded "Default" — meant an empty
  // field still ran something, and there was no way to say "not this one".
  it("returns nothing when the task names no agent", async () => {
    expect(await snapshotFor("p1", null, MACHINE_OWNER)).toBeNull();
  });

  it("still resolves the agent a task does name", async () => {
    agentFindById.mockReturnValue(lean(AGENT));

    const snapshot = await snapshotFor("p1", AGENT_ID, MACHINE_OWNER);

    expect(snapshot?.name).toBe("Default");
  });

  // A shorter agent than the one somebody composed is worse than a refusal: it runs, and the
  // missing check looks like a check that passed
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

/**
 * Defence in depth, at the one point the work is actually picked up.
 *
 * Every writer of `agent` judges this same pairing, and three consecutive rounds of BP-358 each
 * closed one writer and were each followed by another hole of the same shape. So the question is
 * asked again here, where a document's history no longer matters: whatever wrote it, and whichever
 * commit was deployed at the time, a composition nobody vetted runs only on its author's own
 * machine.
 */
describe("snapshotFor and whose machine is asking", () => {
  const EMPTY = { analysis: [], implementation: [], verification: [], delivery: [] };
  // Silenced for the whole block rather than per test: a refusal writes to stderr by design, and
  // half these tests trigger one without being about it. Braces on both hooks — returning the mock
  // would hand vitest the mock itself as the teardown function.
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

  // The machine whose owner was released while it still held work: nobody's machine is not the
  // composer's machine
  it("refuses one to a machine with no owner at all", async () => {
    agentFindById.mockReturnValue(lean(MINE));

    expect(await snapshotFor("p1", "a1", null)).toBeNull();
  });

  // Both sides absent is the case equality alone gets wrong: "" === "" would read two absences as
  // one person, and an ownerless personal agent would run anywhere
  it("refuses an ownerless personal agent rather than matching it to an ownerless machine", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, owner: null }));

    expect(await snapshotFor("p1", "a1", null)).toBeNull();
  });

  // The other half of the decision, and the reason the rule is asked of `user` scope alone: a
  // project admin authored this one on the project's behalf, so it goes wherever the project's work
  // goes — clearing it here would refuse every machine but its author's
  it("leaves the project's own agent alone, whoever the machine belongs to", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, scope: "project", owner: null, project: "p1" }));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).not.toBeNull();
  });

  it("leaves a global agent alone, which is shipped rather than anybody's own", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, scope: "global", owner: null }));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).not.toBeNull();
  });

  // The task moves back a column with no comment and no activity row, and the route's own line
  // says the agent resolved to nothing runnable — which is untrue here and sends a reader hunting
  // through a perfectly good agent. This is the line that says what really happened.
  it("names the agent, whose it is, and whose machine asked", async () => {
    agentFindById.mockReturnValue(lean(MINE));

    await snapshotFor("p1", "a1", MACHINE_OWNER);

    const message = String(logged.mock.calls[0]?.[0]);
    expect(message).toContain("a1");
    expect(message).toContain(COMPOSER);
    expect(message).toContain(MACHINE_OWNER);
  });

  // Diagnosis order, not behaviour: an agent that is somebody else's AND empty is reported as
  // somebody else's. Asking about the composition first would answer null with nothing said at all.
  it("reports whose it is even when it is also empty", async () => {
    agentFindById.mockReturnValue(lean({ ...MINE, composition: EMPTY }));

    expect(await snapshotFor("p1", "a1", MACHINE_OWNER)).toBeNull();

    expect(String(logged.mock.calls[0]?.[0])).toContain(COMPOSER);
  });
});
