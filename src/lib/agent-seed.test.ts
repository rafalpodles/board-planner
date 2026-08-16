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
describe("the projects that used to merge automatically", () => {
  it("adopts the merging agent for them", async () => {
    await seedAgents();

    expect(projectUpdateMany).toHaveBeenCalledWith(
      { "worker.policy.autoMerge": true, "worker.agent": { $in: [null, undefined] } },
      { $set: { "worker.agent": "merging-id" } }
    );
  });

  // Somebody may have chosen an agent since; the migration must not undo that
  it("leaves a project that has already chosen one alone", async () => {
    await seedAgents();

    expect(projectUpdateMany.mock.calls[0][0]["worker.agent"]).toEqual({ $in: [null, undefined] });
  });

  it("does nothing at all when the merging agent is not there to adopt", async () => {
    agentFindOne.mockReturnValue({ lean: async () => null });

    await seedAgents();

    expect(projectUpdateMany).not.toHaveBeenCalled();
  });
});
