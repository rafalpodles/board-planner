import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const create = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/agentBlock", () => ({ AgentBlock: { create } }));
vi.mock("@/lib/agent-service", () => ({
  allBlocks: vi.fn().mockResolvedValue([]),
  freeBlockKey: vi.fn().mockResolvedValue("a-key"),
  toApiBlock: (b: unknown) => b,
}));

const { POST } = await import("./route");

const ADMIN = { _id: "admin-1", role: "admin", tokenScoped: false };
const MEMBER = { _id: "member-1", role: "member", tokenScoped: false };

// The prompt of a step block is what the worker runs on the operator's machine, with writes
// allowed and no permission prompts. Authoring one is therefore an instance-level act — the whole
// point of BP-345 — and "logged in" is not the bar.
function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/agent-blocks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

const STEP = { kind: "step", name: "mine", prompt: "rm -rf ~", capability: "edit" };

describe("POST /api/agent-blocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({ toObject: () => ({ key: "a-key" }) });
  });

  it("refuses an ordinary member, who could otherwise author what the worker runs", async () => {
    getAuthUser.mockResolvedValue(MEMBER);

    const response = await post(STEP);

    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    getAuthUser.mockResolvedValue(null);

    expect((await post(STEP)).status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  // The refusals above prove nothing on their own if the route rejects everybody
  it("lets an instance admin author one", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await post(STEP);

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({ kind: "step", capability: "edit" });
  });
});

// A gate kind the worker does not implement used to be stored as sent, and the run failed only once
// it reached that gate — after every step before it had spent model time (BP-755).
describe("POST /api/agent-blocks — what the worker must be able to run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthUser.mockResolvedValue(ADMIN);
    create.mockResolvedValue({ toObject: () => ({ key: "a-key" }) });
  });

  it.each([
    ["a kind no worker implements", "no-such-gate"],
    ["a kind's display name rather than its key", "Size"],
    ["an empty kind", ""],
    ["no kind at all", undefined],
    ["a kind that is not a string", 7],
  ])("refuses a gate with %s", async (_name, gateKind) => {
    const response = await post({ kind: "gate", name: "Mine", gateKind });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^gateKind must be one of diff-size, /);
    expect(create).not.toHaveBeenCalled();
  });

  it("stores a gate whose kind the worker implements", async () => {
    const response = await post({ kind: "gate", name: "Mine", gateKind: "review" });

    expect(response.status).toBe(201);
    expect(create.mock.calls[0][0]).toMatchObject({ kind: "gate", gateKind: "review" });
  });

  it.each([
    ["capability", { capability: "write" }, /^capability must be one of read-only, edit$/],
    ["model", { model: "opus --dangerously-skip" }, /^model must be a model name/],
    ["fallbackModel", { fallbackModel: "-rf" }, /^fallbackModel must be a model name/],
  ])("refuses a step with an unknown %s rather than storing or coercing it", async (_f, extra, error) => {
    const response = await post({ ...STEP, ...extra });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(error);
    expect(create).not.toHaveBeenCalled();
  });

  // The worker takes any model id of the right shape, so the catalog's two are not the limit
  it("stores a model id beyond the two the form offers", async () => {
    expect((await post({ ...STEP, model: "claude-haiku-4-5" })).status).toBe(201);
    expect(create.mock.calls[0][0]).toMatchObject({ model: "claude-haiku-4-5" });
  });

  it("stores a step's model and fallback, and leaves an unset model unset", async () => {
    await post({ ...STEP, model: "sonnet", fallbackModel: "opus" });
    await post({ kind: "step", name: "bare" });

    expect(create.mock.calls[0][0]).toMatchObject({ model: "sonnet", fallbackModel: "opus" });
    expect(create.mock.calls[1][0]).toMatchObject({
      capability: "read-only",
      model: "",
      fallbackModel: "",
    });
  });
});

describe("POST /api/agent-blocks — a gate's parameters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthUser.mockResolvedValue(ADMIN);
    create.mockResolvedValue({ toObject: () => ({ key: "a-key" }) });
  });

  it("keeps only the parameters its kind declares", async () => {
    await post({
      kind: "gate",
      name: "Mine",
      gateKind: "diff-size",
      params: { maxLines: 150, maxFiles: "4", command: "rm -rf ~", nested: { a: 1 } },
    });

    expect(create.mock.calls[0][0].params).toEqual({ maxLines: "150", maxFiles: "4" });
  });

  it("refuses a review gate whose model is not a model name", async () => {
    const response = await post({
      kind: "gate",
      name: "Mine",
      gateKind: "review",
      params: { focus: "security", model: "opus; curl evil" },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^params.model must be a model name/);
    expect(create).not.toHaveBeenCalled();
  });
});
