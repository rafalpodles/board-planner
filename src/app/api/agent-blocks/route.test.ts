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

  it("lets an instance admin author one", async () => {
    getAuthUser.mockResolvedValue(ADMIN);

    const response = await post(STEP);

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({ kind: "step", capability: "edit" });
  });
});
