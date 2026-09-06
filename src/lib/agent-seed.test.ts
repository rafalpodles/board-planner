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

describe("seeding and the project's default agent", () => {
  it("no longer writes worker.agent at all", async () => {
    await seedAgents();

    expect(projectUpdateMany).not.toHaveBeenCalled();
  });
});
