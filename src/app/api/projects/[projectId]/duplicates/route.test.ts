import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ findDuplicates: vi.fn(), findOne: vi.fn(), find: vi.fn() }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/ee/ai/duplicates", () => ({ findDuplicates: m.findDuplicates }));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: { user?: unknown }) =>
      handler(req, { ...ctx, user: ctx.user ?? { _id: "u1" }, db: { Task: { findOne: (...a: unknown[]) => ({ lean: async () => m.findOne(...a) }), find: (...a: unknown[]) => ({ lean: async () => m.find(...a) }) } } }),
  requireEntitlement: (_feature: string, handler: unknown) => handler,
}));

const { POST, CHECKS_PER_USER_WINDOW } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const TASK = "507f1f77bcf86cd799439011";
const ask = (body: unknown, userId = "u1") =>
  POST(new Request("https://app.example.com/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ projectId: "p1" }),
    user: { _id: userId },
  } as never);

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  m.findOne.mockResolvedValue({ _id: TASK, relations: [{ task: "rel1", type: "parent_of" }], blockedBy: ["blk1"] });
  m.find.mockResolvedValue([{ _id: "back1" }]);
  m.findDuplicates.mockResolvedValue({ ok: true, duplicates: [{ key: "TP-1" }], shortlisted: 2 });
});

describe("POST duplicates", () => {
  it("checks a draft, and a task of this board without itself or anything already linked to it either way", async () => {
    const res = await ask({ title: " Export invoices ", description: "csv" });
    expect(await res.json()).toEqual({ duplicates: [{ key: "TP-1" }], shortlisted: 2 });
    expect(m.findDuplicates).toHaveBeenCalledWith(expect.anything(), { projectId: "p1", userId: "u1" }, { title: "Export invoices", description: "csv" }, []);
    await ask({ title: "x", taskId: TASK });
    expect(m.findOne.mock.calls[0][0]).toEqual({ _id: TASK, project: "p1" });
    expect(m.find.mock.calls[0][0]).toEqual({ project: "p1", $or: [{ "relations.task": TASK }, { blockedBy: TASK }] });
    expect(m.findDuplicates.mock.calls[1][3]).toEqual([TASK, "rel1", "blk1", "back1"]);
  });

  it.each([[{}], [{ title: "  " }], [{ title: "x".repeat(201) }], [{ title: "x", description: 5 }], [{ title: "x", taskId: "nope" }]])("refuses %j", async (body) => {
    expect((await ask(body)).status).toBe(400);
    expect(m.findDuplicates).not.toHaveBeenCalled();
  });

  it("answers 404 for a task of another board", async () => {
    m.findOne.mockResolvedValue(null);
    expect((await ask({ title: "x", taskId: TASK })).status).toBe(404);
    expect(m.findDuplicates).not.toHaveBeenCalled();
  });

  it("holds each person to so many checks, and one at a time", async () => {
    for (let i = 0; i < CHECKS_PER_USER_WINDOW; i++) expect((await ask({ title: "x" })).status).toBe(200);
    expect((await ask({ title: "x" })).status).toBe(429);
    expect((await ask({ title: "x" }, "u2")).status).toBe(200);

    let release: () => void = () => {};
    m.findDuplicates.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ ok: true, duplicates: [], shortlisted: 0 }))));
    const first = ask({ title: "x" }, "u3");
    await vi.waitFor(() => expect(m.findDuplicates).toHaveBeenCalledTimes(CHECKS_PER_USER_WINDOW + 2));
    expect((await ask({ title: "x" }, "u3")).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
  });

  it("passes on what the gateway refused", async () => {
    m.findDuplicates.mockResolvedValue({ ok: false, status: 429, body: { reason: "ai_budget" } });
    const res = await ask({ title: "x" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ reason: "ai_budget" });
  });
});
