import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();
const check = vi.fn();
const resolveProjectId = vi.fn();
const isPmAvailable = vi.fn();
const runPmTurn = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/grants", () => ({ check, accessibleProjectIds: vi.fn() }));
vi.mock("@/lib/middleware", () => ({ resolveProjectId }));
vi.mock("@/lib/pm/config", () => ({ isPmAvailable }));
vi.mock("@/lib/pm/agent", () => ({ runPmTurn }));

const { POST } = await import("./route");

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
  isPmAvailable.mockReturnValue(false);
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

    expect(check).toHaveBeenCalledWith(USER, PROJECT_ID, "access");
  });

  it("lets an allowed user past the gate", async () => {
    const response = await POST(request(), ctx());

    expect(response.status).toBe(503);
  });

  it("rejects a project reference that resolves to nothing", async () => {
    resolveProjectId.mockResolvedValue(null);

    const response = await POST(request(), ctx("nope"));

    expect(response.status).toBe(400);
    expect(check).not.toHaveBeenCalled();
  });
});
