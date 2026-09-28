import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";
import { AGENT_BUCKETS } from "@/types";

const getAuthUser = vi.fn();
const blockFindById = vi.fn();
const agentFind = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/agentBlock", () => ({ AgentBlock: { findById: blockFindById } }));
vi.mock("@/models/agent", () => ({ Agent: { find: agentFind } }));
vi.mock("@/lib/agent-service", () => ({ toApiBlock: (b: unknown) => b }));

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
    toObject: () => ({ key: "a-key" }),
    ...overrides,
  };
}

const params = { params: Promise.resolve({ blockId: ID }) };

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
    agentFind.mockReturnValue({ lean: () => Promise.resolve([]) });
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
  });

  const step = () => block({ capability: "read-only", model: "opus" });
  const gate = () => block({ kind: "gate", gateKind: "diff-size", params: {} });

  it("sets a step's model and what it may touch", async () => {
    const doc = step();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ model: "sonnet", capability: "edit" });

    expect(response.status).toBe(200);
    expect(doc).toMatchObject({ model: "sonnet", capability: "edit" });
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it("leaves both alone when the edit does not name them", async () => {
    const doc = step();
    blockFindById.mockResolvedValue(doc);

    expect((await put({ name: "Renamed" })).status).toBe(200);
    expect(doc).toMatchObject({ name: "Renamed", model: "opus", capability: "read-only" });
  });

  it.each([
    ["capability", { capability: "write" }],
    ["model", { model: "gpt-4" }],
  ])("refuses an unknown %s and writes nothing else either", async (_f, extra) => {
    const doc = step();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ name: "Renamed", ...extra });

    expect(response.status).toBe(400);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc).toMatchObject({ model: "opus", capability: "read-only" });
    expect(doc).not.toHaveProperty("name");
  });

  it("gives a step the worker performs itself no model to take", async () => {
    const doc = block({ deterministic: true, capability: "read-only", model: "" });
    blockFindById.mockResolvedValue(doc);

    expect((await put({ model: "opus", capability: "edit" })).status).toBe(200);
    expect(doc).toMatchObject({ model: "", capability: "read-only" });
  });

  it.each([
    ["a kind no worker implements", "no-such-gate"],
    ["an empty kind", ""],
    ["a kind that is not a string", 7],
  ])("refuses a gate changed to %s", async (_name, gateKind) => {
    const doc = gate();
    blockFindById.mockResolvedValue(doc);

    const response = await put({ gateKind });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^gateKind must be one of diff-size, /);
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc).toMatchObject({ gateKind: "diff-size" });
  });

  it("changes a gate to a kind the worker implements", async () => {
    const doc = gate();
    blockFindById.mockResolvedValue(doc);

    expect((await put({ gateKind: "test-run" })).status).toBe(200);
    expect(doc).toMatchObject({ gateKind: "test-run" });
    expect(doc.save).toHaveBeenCalledOnce();
  });

  it("keeps a gate's kind when the edit does not name one", async () => {
    const doc = gate();
    blockFindById.mockResolvedValue(doc);

    expect((await put({ params: { maxLines: "150" } })).status).toBe(200);
    expect(doc).toMatchObject({ gateKind: "diff-size", params: { maxLines: "150" } });
  });
});

// Mongoose's own caster, over the real schema. It needs no connection, and it is the only thing
// that answers "would this query have 500ed" without guessing which shapes are illegal (BP-460).
const { agentSchema } = await vi.importActual<typeof import("@/models/agent")>("@/models/agent");
const CastProbe = mongoose.model("AgentCastProbe", agentSchema);

function castThroughMongoose(query: Record<string, unknown>): void {
  CastProbe.find(query).cast(CastProbe);
}

describe("deleting a block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFind.mockImplementation((query: Record<string, unknown>) => {
      castThroughMongoose(query);
      return { lean: () => Promise.resolve([]) };
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
});
