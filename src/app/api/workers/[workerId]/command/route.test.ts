import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const workerFindByIdAndUpdate = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/models/worker", () => ({ Worker: { findByIdAndUpdate: workerFindByIdAndUpdate } }));

const { POST } = await import("./route");

const WORKER_ID = "69a52e3b399b27d3cbb2c5a5";
const ADMIN = { _id: "admin-1", role: "admin", tokenScoped: false, allowedProjects: [] };
const MEMBER = { _id: "member-1", role: "member", tokenScoped: false, allowedProjects: [] };

function request(body: unknown, workerId = WORKER_ID) {
  return {
    req: new Request(`http://localhost/api/workers/${workerId}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ workerId }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(ADMIN);
  workerFindByIdAndUpdate.mockResolvedValue({
    command: "pause",
    commandIssuedAt: new Date("2026-08-01T12:00:00.000Z"),
  });
});

describe("POST /api/workers/:workerId/command", () => {
  it("refuses a non-admin", async () => {
    getAuthUser.mockResolvedValue(MEMBER);
    const { req, ctx } = request({ command: "pause" });

    const response = await POST(req, ctx);

    expect(response.status).toBe(403);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("400s an invalid command value", async () => {
    const { req, ctx } = request({ command: "reboot" });

    const response = await POST(req, ctx);

    expect(response.status).toBe(400);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("400s the JSON literal null body instead of throwing on the destructure", async () => {
    const { req, ctx } = request("null");

    const response = await POST(req, ctx);

    expect(response.status).toBe(400);
  });

  it("404s a syntactically invalid worker id without a Mongoose cast error", async () => {
    const { req, ctx } = request({ command: "pause" }, "not-an-object-id");

    const response = await POST(req, ctx);

    expect(response.status).toBe(404);
    expect(workerFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("404s a well-formed but unknown worker id", async () => {
    workerFindByIdAndUpdate.mockResolvedValue(null);
    const { req, ctx } = request({ command: "stop" });

    const response = await POST(req, ctx);

    expect(response.status).toBe(404);
  });

  it("issues a valid command, clearing commandAckedAt so an ack can be told apart from a request", async () => {
    const { req, ctx } = request({ command: "pause" });

    const response = await POST(req, ctx);

    expect(response.status).toBe(200);
    expect(workerFindByIdAndUpdate).toHaveBeenCalledWith(
      WORKER_ID,
      { $set: { command: "pause", commandIssuedAt: expect.any(Date), commandAckedAt: null } },
      { new: true }
    );
    const json = await response.json();
    expect(json).toEqual({ command: "pause", issuedAt: "2026-08-01T12:00:00.000Z" });
  });
});
