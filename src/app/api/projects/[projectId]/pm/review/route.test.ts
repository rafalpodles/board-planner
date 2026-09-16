import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const startBoardReview = vi.fn();
const after = vi.fn();
let user: Record<string, unknown> = {};

vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/project", () => ({ Project: { findById } }));
vi.mock("@/lib/pm/pm-user", () => ({ getPmUser: async () => ({ _id: "pm-user" }) }));
vi.mock("@/lib/pm/scheduler", () => ({ startBoardReview }));
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: object) =>
      handler(req, { ...ctx, user }),
}));

const { POST } = await import("./route");

const run = () =>
  POST(new Request("https://app.example.com/x", { method: "POST" }), { params: Promise.resolve({ projectId: "p1" }) } as never);

beforeEach(() => {
  vi.clearAllMocks();
  user = { _id: "owner", viaMachineCredential: false };
  findById.mockReturnValue({ lean: async () => ({ _id: "p1", key: "BP", pm: { enabled: true } }) });
  startBoardReview.mockResolvedValue({ status: "started", done: Promise.resolve() });
});

// BP-471
describe("POST /api/projects/:projectId/pm/review", () => {
  it("starts a review and lets it finish after the answer", async () => {
    const res = await run();

    expect(res.status).toBe(202);
    expect(startBoardReview).toHaveBeenCalledWith("p1", "BP", { enabled: true }, "pm-user");
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("refuses a machine credential, which should not spend the project's budget on its own", async () => {
    user = { _id: "owner", viaMachineCredential: true };

    expect((await run()).status).toBe(403);
    expect(startBoardReview).not.toHaveBeenCalled();
  });

  it("says why when the PM is off or locked for the project", async () => {
    findById.mockReturnValue({ lean: async () => ({ _id: "p1", key: "BP", pm: { enabled: true, lockedByInstance: true } }) });

    const res = await run();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("disabled for this project by an instance admin");
    expect(startBoardReview).not.toHaveBeenCalled();
  });

  it("names the cap or the running turn that stops it", async () => {
    startBoardReview.mockResolvedValue({ status: "skipped", reason: "the daily turn cap (3) is reached" });

    const res = await run();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("The review cannot run: the daily turn cap (3) is reached.");
    expect(after).not.toHaveBeenCalled();
  });
});
