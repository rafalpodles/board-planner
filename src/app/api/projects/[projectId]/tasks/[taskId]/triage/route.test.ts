import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ applyOne: vi.fn(), exists: vi.fn(), entitled: { value: true } }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/ee/ai/triage", () => ({ applyOne: m.applyOne }));
vi.mock("@/lib/middleware", () => ({
  entitlementRefusal: async (_db: unknown, feature: string) => (m.entitled.value ? null : Response.json({ feature }, { status: 402 })),
  withProjectAccess:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: Record<string, unknown>) =>
      handler(req, {
        ...ctx,
        user: { _id: "u1" },
        db: { Task: { exists: m.exists, findById: () => ({ lean: async () => ({ triage: { state: "ready", suggestions: [] } }) }), findOne: () => ({ lean: async () => ({ triage: { state: "pending" } }) }) } },
      }),
}));

const { GET, POST } = await import("./route");

const SUGGESTION = "507f1f77bcf86cd799439011";
const ctx = () => ({ params: Promise.resolve({ projectId: "p1", taskId: "t1" }) }) as never;
const post = (body: unknown) => POST(new Request("https://app.example.com/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx());

beforeEach(() => {
  vi.clearAllMocks();
  m.entitled.value = true;
  m.exists.mockResolvedValue({ _id: "t1" });
  m.applyOne.mockResolvedValue({ ok: true });
});

describe("the triage route", () => {
  it("acts as the person asking, on a task of this board, and answers the suggestions as they now are", async () => {
    const res = await post({ suggestionId: SUGGESTION, action: "undo" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ triage: { state: "ready", suggestions: [] } });
    expect(m.exists).toHaveBeenCalledWith({ _id: "t1", project: "p1" });
    expect(m.applyOne).toHaveBeenCalledWith(expect.anything(), "t1", SUGGESTION, "u1", "undo");
  });

  it.each([[{ suggestionId: SUGGESTION, action: "rewrite" }], [{ suggestionId: "x", action: "apply" }], [{ action: "apply" }]])("refuses %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(m.applyOne).not.toHaveBeenCalled();
  });

  it("answers 404 for a task of another board, and passes on what applying refused", async () => {
    m.exists.mockResolvedValueOnce(null);
    expect((await post({ suggestionId: SUGGESTION, action: "apply" })).status).toBe(404);
    expect(m.applyOne).not.toHaveBeenCalled();
    m.applyOne.mockResolvedValue({ ok: false, error: "changed", status: 409 });
    expect((await post({ suggestionId: SUGGESTION, action: "apply" })).status).toBe(409);
  });

  it("is a Pro feature to apply or undo, while dismissing and reading stay open after a downgrade", async () => {
    m.entitled.value = false;
    expect((await post({ suggestionId: SUGGESTION, action: "apply" })).status).toBe(402);
    expect((await post({ suggestionId: SUGGESTION, action: "undo" })).status).toBe(402);
    expect((await post({ suggestionId: SUGGESTION, action: "dismiss" })).status).toBe(200);
    expect(await (await GET(new Request("https://app.example.com/x"), ctx())).json()).toEqual({ triage: { state: "pending" } });
  });
});
