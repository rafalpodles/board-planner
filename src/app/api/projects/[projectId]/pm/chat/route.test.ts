import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const resolveProjectId = vi.fn();
const resolveModelKey = vi.hoisted(() => vi.fn());
const runPmTurn = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
const refusedOnThisHost = vi.hoisted(() => vi.fn(async () => null as Response | null));
vi.mock("@/lib/middleware", () => ({ resolveProjectId, refusedOnThisHost }));
vi.mock("@/lib/model-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/model-keys")>()),
  resolveModelKey,
}));
vi.mock("@/lib/pm/agent", () => ({ runPmTurn }));

const { POST } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const PROJECT_ID = "69a52e3b399b27d3cbb2c5a5";
const USER = { _id: "u1", role: "member" };

function request() {
  return new Request(`http://localhost/api/projects/CP/pm/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
}

const ctx = (projectId = "CP") => ({ params: Promise.resolve({ projectId }) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue(USER);
  resolveProjectId.mockResolvedValue(PROJECT_ID);
  check.mockResolvedValue(true);
  // Nothing past the gate is under test, and an unconfigured PM is the first thing beyond it
  resolveModelKey.mockResolvedValue({ ok: false, reason: "not_configured", plan: "free" });
});

// This route streams SSE, so it authenticates by hand and sits behind no middleware — the one
// project gate in the codebase that a change to withProjectAccess would not carry with it
describe("POST /api/projects/:projectId/pm/chat", () => {
  it("refuses a project the grant layer does not allow", async () => {
    check.mockResolvedValue(false);

    const response = await POST(request(), ctx());

    expect(response.status).toBe(403);
    expect(runPmTurn).not.toHaveBeenCalled();
  });

  it("authorises the resolved project id, not the key in the path", async () => {
    await POST(request(), ctx());

    expect(check).toHaveBeenCalledWith(scopedToDefaultOrganisation(), USER, PROJECT_ID, "access");
  });

  it("lets an allowed user past the gate", async () => {
    const response = await POST(request(), ctx());

    expect(response.status).toBe(503);
  });

  // BP-652
  it("answers 402 for an organisation whose plan has no managed AI and that has no key of its own", async () => {
    resolveModelKey.mockResolvedValue({ ok: false, reason: "needs_plan", plan: "free" });

    const response = await POST(request(), ctx());

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ feature: "ai.managed", plan: "free" });
    expect(runPmTurn).not.toHaveBeenCalled();
  });

  it("says so, and stops, when the organisation's own key can no longer be read", async () => {
    resolveModelKey.mockResolvedValue({ ok: false, reason: "own_key_unreadable", plan: "pro" });

    const response = await POST(request(), ctx());

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Enter it again/);
  });

  it("rejects a project reference that resolves to nothing", async () => {
    resolveProjectId.mockResolvedValue(null);

    const response = await POST(request(), ctx("nope"));

    expect(response.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/:id/pm/chat on another organisation's host (BP-666)", () => {
  it("answers whatever the host check answers and runs no turn", async () => {
    refusedOnThisHost.mockResolvedValueOnce(new Response(null, { status: 401 }));
    getAuthUser.mockResolvedValue({ _id: "u1", role: "member" });

    const res = await POST(new Request("http://localhost/api/projects/p1/pm/chat", { method: "POST", body: "{}" }), {
      params: Promise.resolve({ projectId: "p1" }),
    });

    expect(res.status).toBe(401);
    expect(runPmTurn).not.toHaveBeenCalled();
  });
});
