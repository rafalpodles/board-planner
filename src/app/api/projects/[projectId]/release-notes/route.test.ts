import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  releaseMaterial: vi.fn(),
  writeReleaseNotes: vi.fn(),
  sprintFindOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/ee/ai/release-notes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ee/ai/release-notes")>()),
  releaseMaterial: m.releaseMaterial,
  writeReleaseNotes: m.writeReleaseNotes,
}));
vi.mock("@/lib/middleware", () => ({
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: { user?: unknown }) =>
      handler(req, { ...ctx, user: ctx.user ?? { _id: "u1" }, db: { Sprint: { findOne: () => ({ lean: m.sprintFindOne }) } } }),
  requireEntitlement: (_feature: string, handler: unknown) => handler,
}));

const { POST, NOTES_PER_USER_WINDOW } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const SPRINT = "507f1f77bcf86cd799439011";
const MATERIAL = { window: {}, tasks: [{ key: "TP-1" }], pullRequestsWithoutTask: [], tasksLeftOut: 0, pullRequestsIncomplete: false, repositoryUnread: false };

function ask(body: unknown, userId = "u1") {
  return POST(
    new Request("https://app.example.com/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ projectId: "p1" }), user: { _id: userId } } as never
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  m.releaseMaterial.mockResolvedValue(MATERIAL);
  m.writeReleaseNotes.mockResolvedValue({ ok: true, text: "## Notes" });
  m.sprintFindOne.mockResolvedValue({ name: "Sprint 7", startDate: new Date("2026-10-01T00:00:00Z"), endDate: new Date("2026-10-15T00:00:00Z") });
});

describe("POST release-notes", () => {
  it("covers a sprint from its start to just before its end, where the next one may begin, by the sprint's own tasks", async () => {
    const res = await ask({ sprintId: SPRINT });
    expect(res.status).toBe(200);
    expect(m.releaseMaterial).toHaveBeenCalledWith(expect.anything(), "p1", {
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-10-14T23:59:59.999Z"),
      label: "Sprint 7",
      sprintId: SPRINT,
    });
  });

  it("covers two days whole", async () => {
    await ask({ from: "2026-10-01", to: "2026-10-03" });
    expect(m.releaseMaterial.mock.calls[0][2]).toMatchObject({ from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-03T23:59:59.999Z") });
  });

  it.each([
    [{ from: "2026-02-30", to: "2026-03-01" }, 400],
    [{ from: "2026-03-02", to: "2026-03-01" }, 400],
    [{ from: "2025-01-01", to: "2026-03-01" }, 400],
    [{ sprintId: "nope" }, 400],
    [{ sprintId: SPRINT, tone: "poem" }, 400],
    [{}, 400],
  ])("refuses %j", async (body, status) => {
    expect((await ask(body)).status).toBe(status);
    expect(m.releaseMaterial).not.toHaveBeenCalled();
  });

  it("answers 404 for a sprint of another board", async () => {
    m.sprintFindOne.mockResolvedValue(null);
    expect((await ask({ sprintId: SPRINT })).status).toBe(404);
  });

  it("says an empty window plainly, with no model call", async () => {
    m.releaseMaterial.mockResolvedValue({ ...MATERIAL, tasks: [] });
    const body = await (await ask({ sprintId: SPRINT })).json();
    expect(body).toMatchObject({ empty: true, markdown: "Nothing reached a done column, and no pull request was merged, in Sprint 7." });
    expect(m.writeReleaseNotes).not.toHaveBeenCalled();
  });

  it("counts every request before reading anything, empty ones included", async () => {
    m.releaseMaterial.mockResolvedValue({ ...MATERIAL, tasks: [] });
    for (let i = 0; i < NOTES_PER_USER_WINDOW; i++) expect((await ask({ sprintId: SPRINT })).status).toBe(200);
    m.releaseMaterial.mockClear();
    expect((await ask({ sprintId: SPRINT })).status).toBe(429);
    expect(m.releaseMaterial).not.toHaveBeenCalled();
    expect((await ask({ sprintId: SPRINT }, "u2")).status).toBe(200);
  });

  it("writes one set of notes at a time per person", async () => {
    let release: () => void = () => {};
    m.releaseMaterial.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(MATERIAL))));
    const first = ask({ sprintId: SPRINT });
    await vi.waitFor(() => expect(m.releaseMaterial).toHaveBeenCalledTimes(1));
    expect((await ask({ sprintId: SPRINT })).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await ask({ sprintId: SPRINT })).status).toBe(200);
  });

  it("passes on what the gateway refused", async () => {
    m.writeReleaseNotes.mockResolvedValue({ ok: false, status: 429, body: { reason: "ai_budget" } });
    const res = await ask({ sprintId: SPRINT });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ reason: "ai_budget" });
  });
});
