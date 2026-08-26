import { describe, it, expect, vi, beforeEach } from "vitest";

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

/**
 * Mongoose casts a query value against the schema path it names. `composition.<bucket>` is an
 * array of subdocuments, so a bare string there is a CastError thrown while the query is being
 * built — before it reads anything.
 *
 * A mock that accepts any object cannot see that, which is why six passing tests sat on top of a
 * route that answered 500 for every delete (BP-460). This reproduces the one casting rule that
 * bit us, so reintroducing the bare string turns these tests red instead of green.
 */
function castLikeMongoose(query: Record<string, unknown>): void {
  const arms = (query.$or ?? []) as Record<string, unknown>[];
  for (const arm of arms) {
    for (const [path, value] of Object.entries(arm)) {
      const isBucketItself = /^composition\.[a-z]+$/.test(path);
      if (isBucketItself && typeof value === "string") {
        throw new Error(
          `Cast to embedded failed for value "${value}" (type string) at path "${path}"`
        );
      }
    }
  }
}

describe("deleting a block", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentFind.mockImplementation((query: Record<string, unknown>) => {
      castLikeMongoose(query);
      return { lean: () => Promise.resolve([]) };
    });
  });

  // Named for the bug rather than for the query: what matters is that no delete can 500 on the way
  // to its in-use check, whatever shape that check ends up being written in.
  it("builds an in-use query a real Mongoose would not throw on", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    blockFindById.mockResolvedValue(block());

    await del();

    expect(agentFind).toHaveBeenCalledOnce();
    expect(() =>
      castLikeMongoose(agentFind.mock.calls[0][0] as Record<string, unknown>)
    ).not.toThrow();
  });

  // The legacy arm is not decoration: normaliseComposition coerces the pre-object shape on read and
  // rewrites it on save, so an agent nobody has saved since still holds bare keys in the database.
  // Dropping the arm would leave those agents unprotected, and every other test here would stay green.
  it("still searches the pre-object shape, through an operator rather than a bare string", async () => {
    getAuthUser.mockResolvedValue(ADMIN);
    blockFindById.mockResolvedValue(block());

    await del();

    const arms = (agentFind.mock.calls[0][0] as { $or: Record<string, unknown>[] }).$or;
    const legacy = arms.filter((arm) =>
      Object.keys(arm).some((path) => /^composition\.[a-z]+$/.test(path))
    );
    expect(legacy.length, "the legacy arm is gone — pre-object compositions are unprotected").toBe(
      4
    );
    for (const arm of legacy) {
      expect(Object.values(arm)[0]).toEqual({ $elemMatch: { $eq: "a-key" } });
    }
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
