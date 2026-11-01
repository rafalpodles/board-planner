import { describe, expect, it, vi, beforeEach } from "vitest";

const snapshotFor = vi.fn();
vi.mock("./agent-snapshot", () => ({ snapshotFor }));

const { agentsStillHeld, heldAgentsFrom } = await import("./held-agents");

const AGENT = "69a52e3b399b27d3cbb2c5a5";
const OTHER = "69a52e3b399b27d3cbb2c5b7";
const db = {} as never;

const gate = (gateKind: string) => ({ key: `our-${gateKind}`, kind: "gate", name: gateKind, gateKind });
const step = { key: "implement", kind: "step", name: "Implement" };

describe("heldAgentsFrom", () => {
  it("reads a worker that sends none as holding nothing", () => {
    expect(heldAgentsFrom(undefined)).toEqual([]);
  });

  it("keeps what it can use, and nothing else a worker put on the entry", () => {
    expect(heldAgentsFrom([{ agentId: AGENT, gates: ["build"], extra: true }])).toEqual([{ agentId: AGENT, gates: ["build"] }]);
  });

  // Each of these reaches a Mongo filter on a cast field, or a comparison that could never match
  it.each([
    ["a string", "nope"],
    ["null", null],
    ["a null entry", [null]],
    ["no agent", [{ gates: [] }]],
    ["an agent that is not an id", [{ agentId: "x", gates: [] }]],
    ["an agent that is an operator", [{ agentId: { $ne: null }, gates: [] }]],
    ["gates that are not a list", [{ agentId: AGENT, gates: "build" }]],
    ["a gate that is not a string", [{ agentId: AGENT, gates: [1] }]],
  ])("refuses %s", (_what, value) => {
    expect(heldAgentsFrom(value)).toBeNull();
  });

  it("reads no more than a claim should pay for", () => {
    const many = Array.from({ length: 51 }, () => ({ agentId: AGENT, gates: [] }));

    expect(heldAgentsFrom(many)).toHaveLength(50);
  });
});

describe("agentsStillHeld", () => {
  beforeEach(() => snapshotFor.mockReset());

  const held = [{ agentId: AGENT, gates: ["build", "test-run"] }];

  it("steps over an agent whose gates are what the machine saw fail, whatever its steps became", async () => {
    snapshotFor.mockResolvedValue({ sequence: [step, gate("build"), gate("test-run")] });

    expect(await agentsStillHeld(db, "p1", held, "owner")).toEqual([AGENT]);
    expect(snapshotFor).toHaveBeenCalledWith(db, "p1", AGENT, "owner");
  });

  it.each([
    ["the gate was taken out", [step, gate("build")]],
    ["the gates swapped places", [gate("test-run"), gate("build")]],
    ["a gate was added", [gate("build"), gate("test-run"), gate("review")]],
  ])("offers it again once %s", async (_what, sequence) => {
    snapshotFor.mockResolvedValue({ sequence });

    expect(await agentsStillHeld(db, "p1", held, "owner")).toEqual([]);
  });

  it("offers an agent that resolves to nothing, for the claim's own handling of one", async () => {
    snapshotFor.mockResolvedValue(null);

    expect(await agentsStillHeld(db, "p1", held, "owner")).toEqual([]);
  });

  it("judges each agent on its own", async () => {
    snapshotFor.mockImplementation(async (_db, _project, agentId) => ({ sequence: agentId === AGENT ? [gate("build"), gate("test-run")] : [] }));

    expect(await agentsStillHeld(db, "p1", [...held, { agentId: OTHER, gates: ["build"] }], "owner")).toEqual([AGENT]);
  });
});
