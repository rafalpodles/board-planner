import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import { AGENT_BUCKETS } from "@/types";

const getAuthUser = vi.fn();
const blockFindById = vi.fn();
const agentFind = vi.fn();
const allBlocks = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/agentBlock", () => ({ AgentBlock: { findById: blockFindById } }));
vi.mock("@/models/agent", () => ({ Agent: { find: agentFind } }));
vi.mock("@/lib/agent-service", () => ({ toApiBlock: (b: unknown) => b, allBlocks }));

const { PUT, DELETE } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin", tokenScoped: false };
const MEMBER = { _id: "member-1", role: "member", tokenScoped: false };
const ID = "69a52e3b399b27d3cbb2c5a5";

function block(overrides: Record<string, unknown> = {}) {
  return {
    _id: ID,
    key: "a-key",
    kind: "step",
    builtIn: false,
    createdBy: "member-1",
    prompt: "the original",
    save: vi.fn().mockResolvedValue(undefined),
    deleteOne: vi.fn().mockResolvedValue(undefined),
    toObject(this: Record<string, unknown>) {
      const { save: _s, deleteOne: _d, toObject: _t, ...fields } = this;
      return fields;
    },
    ...overrides,
  };
}

const params = { params: Promise.resolve({ blockId: ID }) };

const sortedBy = vi.fn();
function found(rows: Record<string, unknown>[]) {
  const query = {
    sort: (order: unknown) => (sortedBy(order), query),
    populate: () => query,
    lean: () => Promise.resolve(rows),
  };
  return query;
}

function put(body: Record<string, unknown>) {
  return PUT(
    new Request(`http://localhost/api/agent-blocks/${ID}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    params as never
  );
}

/**
 * Authoring a block became instance-admin in BP-345, and editing one is authoring its prompt again
 * — the field a worker executes on somebody's machine. Ownership was the old bar, which left two
 * ways past it: blocks a member created before that change still name them as createdBy, and a
 * block whose createdBy is empty was editable by anyone at all.
 */
describe("changing a block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFind.mockReturnValue(found([]));
  });

  it("refuses the member who created it", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    const doc = block();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ prompt: "rm -rf ~" });

    expect(response.status).toBe(403);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.prompt).toBe("the original");
  });

  it("refuses a member on a block with no author recorded", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    const doc = block({ createdBy: null });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ prompt: "rm -rf ~" })).status).toBe(403);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("lets an instance admin change the prompt", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    const doc = block();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ prompt: "a considered instruction" });

    expect(response.status).toBe(200);
    expect(doc.prompt).toBe("a considered instruction");
    expect(doc.save).toHaveBeenCalledOnce();
  });
});

describe("changing what a block runs as (BP-743, BP-755)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthUser.mockResolvedValue(ADMIN);
    agentFind.mockReturnValue(found([]));
    allBlocks.mockResolvedValue([]);
  });

  const step = () => block({ capability: "read-only", model: "opus" });
  const gate = (overrides: Record<string, unknown> = {}) =>
    block({ kind: "gate", gateKind: "diff-size", params: {}, ...overrides });

  it("sets a step's model and what it may touch", async () => {
    const doc = step();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ model: "sonnet", capability: "edit" });

    expect(response.status).toBe(200);
    expect(doc).toMatchObject({ model: "sonnet", capability: "edit" });
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it("takes a model id beyond the two the form offers", async () => {
    const doc = step();
    blockFindById.mockResolvedValue(doc);

    expect((await put({ model: "claude-haiku-4-5" })).status).toBe(200);
    expect(doc).toMatchObject({ model: "claude-haiku-4-5" });
  });

  it("leaves both alone when the edit does not name them", async () => {
    const doc = step();
    blockFindById.mockResolvedValue(doc);

    expect((await put({ name: "Renamed" })).status).toBe(200);
    expect(doc).toMatchObject({ name: "Renamed", model: "opus", capability: "read-only" });
  });

  it.each([
    ["capability", { capability: "write" }],
    ["model", { model: "opus --dangerously-skip" }],
  ])("refuses an unknown %s and writes nothing else either", async (_f, extra) => {
    const doc = step();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ name: "Renamed", ...extra });

    expect(response.status).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc).toMatchObject({ model: "opus", capability: "read-only" });
    expect(doc).not.toHaveProperty("name");
  });

  // A 200 for a field that was dropped tells the client it set something it did not
  it.each([
    [
      "a model on a step the worker performs itself",
      block({ deterministic: true }),
      { model: "opus" },
    ],
    [
      "a capability on a step the worker performs itself",
      block({ deterministic: true }),
      { capability: "edit" },
    ],
    ["a model on a gate", gate(), { model: "opus" }],
    ["a capability on a gate", gate(), { capability: "edit" }],
    ["a prompt on a gate", gate(), { prompt: "do it" }],
    ["a gate kind on a step", step(), { gateKind: "build" }],
    ["parameters on a step", step(), { params: { maxLines: "1" } }],
  ])("refuses %s rather than ignoring it", async (_name, doc, body) => {
    blockFindById.mockResolvedValue(doc);

    expect((await put(body)).status).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("still takes a name and description on a step the worker performs itself", async () => {
    const doc = block({ deterministic: true, prompt: "" });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ name: "Push it", description: "d", prompt: "" })).status).toBe(200);
    expect(doc).toMatchObject({ name: "Push it", description: "d" });
  });

  it.each([
    ["a kind no worker implements", "no-such-gate", /^gateKind must be one of diff-size, /],
    ["an empty kind", "", /^gateKind must be one of diff-size, /],
    ["a kind that is not a string", 7, /^gateKind must be one of diff-size, /],
    // Turning Protected files into Size would pass every rule an agent was saved under
    ["another kind the worker does implement", "test-run", /^A gate's kind is fixed/],
  ])("refuses a gate changed to %s", async (_name, gateKind, error) => {
    const doc = gate();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ gateKind });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(error);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc).toMatchObject({ gateKind: "diff-size" });
  });

  it("takes the kind it already has, as a no-op", async () => {
    const doc = gate();
    blockFindById.mockResolvedValue(doc);

    expect((await put({ gateKind: "diff-size", name: "Small" })).status).toBe(200);
    expect(doc).toMatchObject({ gateKind: "diff-size", name: "Small" });
  });

  it("keeps a gate's kind when the edit does not name one, and only the parameters it declares", async () => {
    const doc = gate();
    blockFindById.mockResolvedValue(doc);

    expect((await put({ params: { maxLines: "150", command: "rm -rf ~" } })).status).toBe(200);
    expect(doc).toMatchObject({ gateKind: "diff-size" });
    expect((doc as { params?: unknown }).params).toEqual({ maxLines: "150" });
  });

  it("refuses a review gate's model that is not a model name", async () => {
    const doc = gate({ gateKind: "review", params: { focus: "general", model: "opus" } });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ params: { focus: "general", model: "opus && curl" } })).status).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
  });
});

// Agent rules run when an agent is saved; a block edited under an agent never passed through them.
describe("changing what a step may touch, under agents that already use it (BP-743)", () => {
  const investigate = { key: "a-key", kind: "step", name: "Investigate", capability: "read-only" };
  const build = { key: "build", kind: "gate", name: "Builds", gateKind: "build" };
  const guard = {
    key: "protected-paths",
    kind: "gate",
    name: "Protected files",
    gateKind: "protected-paths",
  };
  const push = { key: "push", kind: "step", name: "Push", deterministic: true };
  const implement = { key: "implement", kind: "step", name: "Implement", capability: "edit" };

  function agentsUsingIt(...agents: Record<string, unknown>[]) {
    agentFind.mockReturnValue(found(agents));
  }

  // Investigate starts writing, and nothing after it pushes
  const breaksOnWrite = { analysis: [{ key: "a-key" }], verification: [{ key: "build" }] };

  async function refusal() {
    blockFindById.mockResolvedValue(block({ ...investigate }));
    const response = await put({ capability: "edit" });
    expect(response.status).toBe(409);
    return ((await response.json()) as { error: string }).error;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getAuthUser.mockResolvedValue(ADMIN);
    allBlocks.mockResolvedValue([investigate, build, guard, push, implement]);
  });

  it("refuses a change that would leave an agent broken, and names it", async () => {
    agentsUsingIt({
      name: "Careful",
      composition: { analysis: [{ key: "a-key" }], verification: [{ key: "build" }] },
    });
    const doc = block({ ...investigate });
    blockFindById.mockResolvedValue(doc);

    const response = await put({ capability: "edit" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/^This would break Careful: /);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("goes through when every agent using it stays sound", async () => {
    agentsUsingIt({
      name: "Careful",
      composition: {
        analysis: [{ key: "a-key" }],
        verification: [{ key: "protected-paths" }, { key: "build" }],
        delivery: [{ key: "push" }],
      },
    });
    const doc = block({ ...investigate });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ capability: "edit" })).status).toBe(200);
    expect(doc.save).toHaveBeenCalledOnce();
  });

  // Nothing pushed Implement's work before the edit either; that is not this edit's doing
  it("does not blame the change for what was broken already", async () => {
    agentsUsingIt({
      name: "Already",
      composition: { analysis: [{ key: "a-key" }], implementation: [{ key: "implement" }] },
    });
    const doc = block({ ...investigate });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ capability: "edit" })).status).toBe(200);
  });

  // /api/agents sends a personal agent only to its owner, so its name is not the admin's to read
  it("does not name another person's personal agent, only whose it is", async () => {
    agentsUsingIt({
      name: "Bob's scratch",
      scope: "user",
      owner: { _id: "bob-1", username: "bob" },
      composition: breaksOnWrite,
    });

    const error = await refusal();

    expect(error).not.toContain("Bob's scratch");
    expect(error).toMatch(/^This would break a personal agent of bob: /);
  });

  it("names the admin's own personal agent, and a project's", async () => {
    agentsUsingIt(
      {
        name: "My scratch",
        scope: "user",
        owner: { _id: "admin-1", username: "admin" },
        composition: breaksOnWrite,
      },
      { name: "Triage", scope: "project", owner: null, composition: breaksOnWrite }
    );

    const error = await refusal();

    expect(error).toMatch(/^This would break My scratch: .+ This would break Triage: /);
  });

  it("says whose it was when the owner's account is gone", async () => {
    agentsUsingIt({ name: "Orphan", scope: "user", owner: null, composition: breaksOnWrite });

    const error = await refusal();

    expect(error).not.toContain("Orphan");
    expect(error).toMatch(/^This would break a personal agent of a deleted account: /);
  });

  it("says why for each agent, and counts the ones past the third", async () => {
    agentsUsingIt(
      ...["One", "Two", "Three", "Four", "Five"].map((name) => ({
        name,
        scope: "global",
        owner: null,
        composition: breaksOnWrite,
      }))
    );

    const error = await refusal();

    expect(sortedBy).toHaveBeenCalledWith({ name: 1 });
    expect(error.match(/This would break /g)).toHaveLength(3);
    expect(error).not.toContain("Four");
    expect(error).toMatch(/ And 2 more\.$/);
  });

  // "Merge is not last" names the blocks after it, so a rename alone changed that message's text
  it("does not read a rename in the same save as breaking an agent that was broken already", async () => {
    agentsUsingIt({
      name: "Merges early",
      scope: "global",
      owner: null,
      composition: {
        delivery: [
          { key: "push" },
          { key: "pull-request" },
          { key: "merge" },
          { key: "a-key" },
          { key: "push" },
        ],
      },
    });
    const doc = block({ ...investigate });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ name: "Look around", capability: "edit" })).status).toBe(200);
  });

  it("does not look at agents when what it may touch is resent unchanged", async () => {
    const doc = block({ ...investigate });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ capability: "read-only", name: "Look" })).status).toBe(200);
    expect(agentFind).not.toHaveBeenCalled();
  });
});

// Mongoose's own caster, over the real schema. It needs no connection, and it is the only thing
// that answers "would this query have 500ed" without guessing which shapes are illegal (BP-460).
const { agentSchema } = await vi.importActual<typeof import("@/models/agent")>("@/models/agent");
const CastProbe = mongoose.model("AgentCastProbe", agentSchema);

function castThroughMongoose(query: Record<string, unknown>): void {
  CastProbe.find(query).cast();
}

describe("deleting a block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFind.mockImplementation((query: Record<string, unknown>) => {
      castThroughMongoose(query);
      return found([]);
    });
  });

  it("builds an in-use query Mongoose can cast", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    blockFindById.mockResolvedValue(block());

    await del();

    expect(agentFind).toHaveBeenCalledOnce();
    expect(() =>
      castThroughMongoose(agentFind.mock.calls[0][0] as Record<string, unknown>)
    ).not.toThrow();
  });

  // Not decoration: nothing migrates the pre-object shape, so agents stored that way are live.
  it("searches every bucket for the pre-object shape as well", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    blockFindById.mockResolvedValue(block());

    await del();

    const arms = (agentFind.mock.calls[0][0] as { $or: Record<string, unknown>[] }).$or;
    const buckets = new Set(
      arms
        .flatMap((arm) => Object.keys(arm))
        .filter((path) => /^composition\.[a-z]+$/.test(path))
    );
    expect(
      [...buckets].sort(),
      "a bucket lost its pre-object arm, so agents stored that way are unprotected there"
    ).toEqual([...AGENT_BUCKETS].sort().map((b) => `composition.${b}`));
  });

  function del() {
    return DELETE(
      new Request(`http://localhost/api/agent-blocks/${ID}`, { method: "DELETE" }),
      params as never
    );
  }

  it("refuses the member who created it", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    const doc = block();
    blockFindById.mockResolvedValue(doc);

    expect((await del()).status).toBe(403);
    expect(doc.deleteOne).not.toHaveBeenCalled();
  });

  // A built-in block is implemented by the worker, so removing it would leave every agent naming it
  // referring to nothing — refused for everyone, admin included
  it("refuses a built-in even for an admin", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    blockFindById.mockResolvedValue(block({ builtIn: true }));

    expect((await del()).status).toBe(400);
  });

  it("lets an instance admin delete one nothing uses", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    const doc = block();
    blockFindById.mockResolvedValue(doc);

    expect((await del()).status).toBe(200);
    expect(doc.deleteOne).toHaveBeenCalledOnce();
  });
  // The same labelling as the refused edit: another person's personal agent is never named
  it("refuses one in use, naming what the admin may see and saying whose the rest are", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    const doc = block();
    blockFindById.mockResolvedValue(doc);
    agentFind.mockReturnValue(
      found([
        { name: "Bob's scratch", scope: "user", owner: { _id: "bob-1", username: "bob" } },
        { name: "My scratch", scope: "user", owner: { _id: "admin-1", username: "admin" } },
        { name: "Orphan", scope: "user", owner: null },
        { name: "Triage", scope: "project", owner: null },
      ])
    );

    const response = await del();

    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      "Still used by a personal agent of bob, My scratch, a personal agent of a deleted account, " +
        "Triage. Take it out of those agents first."
    );
    expect(sortedBy).toHaveBeenCalledWith({ name: 1 });
    expect(doc.deleteOne).not.toHaveBeenCalled();
  });
});
