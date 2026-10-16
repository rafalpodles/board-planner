import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { Types } from "mongoose";

const m = vi.hoisted(() => ({ summaryFacts: vi.fn(), writeSummary: vi.fn(), channels: [] as { enabled: boolean }[], postToTeamChannels: vi.fn() }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/ee/ai/summaries", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/ee/ai/summaries")>()), summaryFacts: m.summaryFacts, writeSummary: m.writeSummary }));
vi.mock("@/lib/notifications", () => ({ postToTeamChannels: m.postToTeamChannels }));
const ORG = new Types.ObjectId();
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: { user?: unknown }) =>
      handler(req, { ...ctx, user: ctx.user ?? { _id: "u1" }, db: { organisation: ORG, Project: { findById: () => ({ lean: async () => ({ notificationChannels: m.channels }) }) } } }),
  requireEntitlement: (_feature: string, handler: unknown) => handler,
}));

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

const { POST, SUMMARIES_PER_USER_WINDOW, sealSummary } = await import("./route");
const post = await import("./post/route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const request = (body: unknown) => new Request("https://app.example.com/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ask = (body: unknown, userId = "u1", projectId = "p1") => POST(request(body), { params: Promise.resolve({ projectId }), user: { _id: userId } } as never);
const send = (body: unknown, projectId = "p1") => post.POST(request(body), { params: Promise.resolve({ projectId }) } as never);

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  m.channels = [];
  m.summaryFacts.mockResolvedValue({ kind: "standup", title: "Standup", figures: [], lists: [] });
  m.writeSummary.mockResolvedValue({ ok: true, markdown: "## Standup", noteDropped: false });
  m.postToTeamChannels.mockResolvedValue({ channels: 1, delivered: 1 });
});

describe("POST summaries", () => {
  it.each([[{ kind: "weekly" }], [{ kind: "sprint" }], [{ kind: "sprint", sprintId: "x" }]])("refuses %j", async (body) => {
    expect((await ask(body)).status).toBe(400);
    expect(m.summaryFacts).not.toHaveBeenCalled();
  });

  it("writes a summary, offering no post when the project has no team channel", async () => {
    const body = await (await ask({ kind: "standup" })).json();
    expect(body).toEqual({ markdown: "## Standup", noteDropped: false, channels: 0, sealed: null });
    expect(m.summaryFacts).toHaveBeenCalledWith(expect.anything(), "p1", "standup", null);
  });

  it("seals what it wrote for posting when there is an enabled channel", async () => {
    m.channels = [{ enabled: false }, { enabled: true }];
    const body = await (await ask({ kind: "sprint", sprintId: "507f1f77bcf86cd799439011" })).json();
    expect(body.channels).toBe(1);
    expect(body.sealed).toEqual(expect.any(String));
    expect(body.sealed).not.toContain("Standup");
  });

  it("answers 404 for a sprint not on the board", async () => {
    m.summaryFacts.mockResolvedValue(null);
    expect((await ask({ kind: "sprint", sprintId: "507f1f77bcf86cd799439011" })).status).toBe(404);
  });

  it("counts every request before any work", async () => {
    for (let i = 0; i < SUMMARIES_PER_USER_WINDOW; i++) await ask({ kind: "standup" });
    m.summaryFacts.mockClear();
    expect((await ask({ kind: "standup" })).status).toBe(429);
    expect(m.summaryFacts).not.toHaveBeenCalled();
  });
});

describe("POST summaries/post", () => {
  it("posts only a summary this board wrote, within the hour", async () => {
    const sealed = sealSummary("p1", "## Standup", ORG);
    const res = await send({ sealed });
    expect(res.status).toBe(200);
    expect(m.postToTeamChannels).toHaveBeenCalledWith(expect.anything(), "p1", "## Standup");
  });

  it("refuses text that was not sealed, a summary of another board, and an old one", async () => {
    expect((await send({ sealed: "## anything at all" })).status).toBe(400);
    expect((await send({ sealed: sealSummary("p2", "x", ORG) })).status).toBe(400);
    expect((await send({ sealed: sealSummary("p1", "x", new Types.ObjectId()) })).status).toBe(400);
    vi.useFakeTimers({ now: Date.now() + post.SEALED_SUMMARY_MS + 1, toFake: ["Date"] });
    try {
      const old = sealSummary("p1", "x", ORG);
      vi.setSystemTime(Date.now() + 2 * post.SEALED_SUMMARY_MS);
      expect((await send({ sealed: old })).status).toBe(410);
    } finally {
      vi.useRealTimers();
    }
    expect(m.postToTeamChannels).not.toHaveBeenCalled();
  });

  it("says when the project has no team channel left", async () => {
    m.postToTeamChannels.mockResolvedValue({ channels: 0, delivered: 0 });
    expect((await send({ sealed: sealSummary("p1", "x", ORG) })).status).toBe(409);
  });
});
