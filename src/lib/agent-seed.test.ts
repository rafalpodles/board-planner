import { describe, it, expect, vi, beforeEach } from "vitest";

const agentUpdateOne = vi.fn();
const agentFindOne = vi.fn();
const blockUpdateOne = vi.fn();
const projectUpdateMany = vi.fn();

vi.mock("@/models/agent", () => ({
  Agent: {
    updateOne: (...a: unknown[]) => agentUpdateOne(...a),
    findOne: (...a: unknown[]) => agentFindOne(...a),
  },
}));
vi.mock("@/models/agentBlock", () => ({
  AgentBlock: { updateOne: (...a: unknown[]) => blockUpdateOne(...a) },
}));
vi.mock("@/models/project", () => ({
  Project: { updateMany: (...a: unknown[]) => projectUpdateMany(...a) },
}));

const { seedAgents, MERGING_AGENT_NAME } = await import("./agent-seed");

beforeEach(() => {
  vi.clearAllMocks();
  agentUpdateOne.mockResolvedValue({});
  blockUpdateOne.mockResolvedValue({});
  projectUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  agentFindOne.mockReturnValue({ lean: async () => ({ _id: "merging-id" }) });
});

describe("seedAgents", () => {
  it("creates without overwriting, so an edited description survives a restart", async () => {
    await seedAgents();

    for (const call of [...agentUpdateOne.mock.calls, ...blockUpdateOne.mock.calls]) {
      expect(Object.keys(call[1])).toEqual(["$setOnInsert"]);
      expect(call[2]).toEqual({ upsert: true });
    }
  });

  it("seeds all three shipped agents", async () => {
    await seedAgents();

    const names = agentUpdateOne.mock.calls.map((call) => call[0].name);
    expect(names).toEqual(["Default", MERGING_AGENT_NAME, "With security review"]);
  });
});

// autoMerge was a flag beside the composition and is gone. A project that had it on falls back to
// the Default agent, which stops at the pull request — so without this the worker keeps running and
// quietly stops doing the last thing the project asked of it.
/**
 * `adoptTheMergingAgent` was removed by BP-458, and its own second test said why it had to be.
 * It pointed every project carrying the retired `worker.policy.autoMerge` at the Merging agent
 * wherever `worker.agent` was null, guarded on exactly that so it would "not undo a decision
 * somebody has since made".
 *
 * BP-458 made clearing the default such a decision — and the schema defaults the field to null,
 * so a cleared project is indistinguishable from one that never had a default. The guard meant to
 * protect intent had become the thing destroying it, on every boot, because seeding runs at every
 * start rather than once.
 *
 * Dropping it rather than narrowing it is safe because since BP-358 `worker.agent` is not a
 * claim-time fallback: `snapshotFor` resolves the task's own agent and nothing else, so this only
 * ever moved a suggestion in the picker. Projects it already reached keep what it wrote.
 */
describe("seeding and the project's default agent", () => {
  it("no longer writes worker.agent at all", async () => {
    await seedAgents();

    expect(projectUpdateMany).not.toHaveBeenCalled();
  });
});
