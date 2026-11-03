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

const {
  seedAgents,
  MERGING_AGENT_NAME,
  SEEDED_DEFAULT_NAME,
  BUILT_IN_BLOCKS,
  SECURITY_REVIEW_BLOCK,
  DEFAULT_COMPOSITION,
  MERGING_COMPOSITION,
  CAREFUL_COMPOSITION,
} = await import("./agent-seed");
const { agentProblems } = await import("./agent-rules");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

beforeEach(() => {
  vi.clearAllMocks();
  agentUpdateOne.mockResolvedValue({});
  blockUpdateOne.mockResolvedValue({});
  projectUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  agentFindOne.mockReturnValue({ lean: async () => ({ _id: "merging-id" }) });
});

describe("seedAgents", () => {
  it("creates without overwriting, so an edited description survives a restart", async () => {
    await seedAgents(scopedToDefaultOrganisation());

    for (const call of [...agentUpdateOne.mock.calls, ...blockUpdateOne.mock.calls]) {
      expect(Object.keys(call[1])).toEqual(["$setOnInsert"]);
      expect(call[2]).toEqual({ upsert: true });
    }
  });

  it("seeds all three shipped agents", async () => {
    await seedAgents(scopedToDefaultOrganisation());

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
    await seedAgents(scopedToDefaultOrganisation());

    expect(projectUpdateMany).not.toHaveBeenCalled();
  });
});

const STRICT_VERIFICATION = [
  { key: "protected-paths" },
  { key: "diff-size" },
  { key: "test-presence" },
  { key: "build" },
  { key: "test-run" },
  { key: "review" },
];

const EDITED_AT = new Date("2026-10-01T00:00:00Z");

function storedAgent(name: string, composition: unknown) {
  agentFindOne.mockImplementation((filter: { name: string }) => ({
    lean: async () => (filter.name === name ? { _id: `${name}-id`, composition, updatedAt: EDITED_AT } : null),
  }));
}

function compositionWrites() {
  return agentUpdateOne.mock.calls.filter((call) => "$set" in call[1]);
}

// BP-1127: the two gates refused work the machine's owner wanted, on the owner's own machine
describe("the shipped agents", () => {
  const lookup = (key: string) =>
    [...BUILT_IN_BLOCKS, SECURITY_REVIEW_BLOCK].find((block) => block.key === key) as never;

  it("leave test-presence and protected-paths to the security-reviewed agent", () => {
    const keys = (composition: typeof DEFAULT_COMPOSITION) => composition.verification.map((entry) => entry.key);

    for (const composition of [DEFAULT_COMPOSITION, MERGING_COMPOSITION]) {
      expect(keys(composition)).not.toContain("test-presence");
      expect(keys(composition)).not.toContain("protected-paths");
    }
    expect(keys(CAREFUL_COMPOSITION)).toEqual(expect.arrayContaining(["test-presence", "protected-paths"]));
  });

  it("break none of the composition rules", () => {
    for (const composition of [DEFAULT_COMPOSITION, MERGING_COMPOSITION, CAREFUL_COMPOSITION]) {
      expect(agentProblems(composition, lookup).filter((p) => p.severity === "broken")).toEqual([]);
    }
  });
});

describe("moving the shipped agents off the composition they were seeded with", () => {
  it("moves an untouched Merges its own work to the new composition", async () => {
    storedAgent(MERGING_AGENT_NAME, {
      analysis: [],
      implementation: [{ key: "implement" }],
      verification: STRICT_VERIFICATION,
      delivery: [{ key: "push" }, { key: "pull-request" }, { key: "merge" }],
    });

    await seedAgents(scopedToDefaultOrganisation());

    const writes = compositionWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toMatchObject({ _id: `${MERGING_AGENT_NAME}-id`, updatedAt: EDITED_AT });
    expect(writes[0][1]).toEqual({ $set: { composition: MERGING_COMPOSITION } });
  });

  it("reads a row stored as bare keys the same as one stored as entries", async () => {
    storedAgent(SEEDED_DEFAULT_NAME, {
      analysis: [],
      implementation: ["implement"],
      verification: STRICT_VERIFICATION.map((entry) => entry.key),
      delivery: ["push", "pull-request"],
    });

    await seedAgents(scopedToDefaultOrganisation());

    expect(compositionWrites().map((call) => call[1])).toEqual([{ $set: { composition: DEFAULT_COMPOSITION } }]);
  });

  it("leaves a shipped agent somebody edited exactly as they left it", async () => {
    storedAgent(MERGING_AGENT_NAME, {
      analysis: [],
      implementation: [{ key: "implement" }],
      verification: [...STRICT_VERIFICATION, { key: "security-review" }],
      delivery: [{ key: "push" }, { key: "pull-request" }, { key: "merge" }],
    });

    await seedAgents(scopedToDefaultOrganisation());

    expect(compositionWrites()).toEqual([]);
  });

  it("leaves a shipped agent whose gate somebody re-tuned", async () => {
    storedAgent(SEEDED_DEFAULT_NAME, {
      analysis: [],
      implementation: [{ key: "implement" }],
      verification: STRICT_VERIFICATION.map((entry) =>
        entry.key === "diff-size" ? { key: "diff-size", params: { maxLines: 2000 } } : entry,
      ),
      delivery: [{ key: "push" }, { key: "pull-request" }],
    });

    await seedAgents(scopedToDefaultOrganisation());

    expect(compositionWrites()).toEqual([]);
  });
});
