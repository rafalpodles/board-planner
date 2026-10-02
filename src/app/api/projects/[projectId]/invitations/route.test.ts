import { describe, it, expect, vi, beforeEach } from "vitest";

const inviteToBoard = vi.fn();
const deliverTo = vi.fn();
const userExists = vi.fn();
const userFind = vi.fn();
const projectFindById = vi.fn();
const invitationFind = vi.fn();
const logInstanceAudit = vi.fn();
const logProjectAudit = vi.fn();
const selfOrigin = vi.fn();
let caller: Record<string, unknown>;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (r: Request, c: unknown) => unknown) =>
    (request: Request) =>
      handler(request, { params: Promise.resolve({ projectId: "p1" }), user: caller }),
}));
vi.mock("@/lib/session", () => ({ selfOrigin }));
vi.mock("@/lib/invitations", () => ({ inviteToBoard }));
vi.mock("@/lib/invitation-mail", async () => {
  const actual = await vi.importActual<typeof import("@/lib/invitation-mail")>("@/lib/invitation-mail");
  return { ...actual, deliverTo };
});
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/models/user", () => ({ User: { exists: userExists, find: userFind } }));
vi.mock("@/models/project", () => ({ Project: { findById: projectFindById } }));
vi.mock("@/models/invitation", () => ({ Invitation: { find: invitationFind } }));

const { GET, POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

const CTX = { params: Promise.resolve({ projectId: "p1" }) };
const post = (body: unknown) =>
  POST(new Request("http://x/api/projects/p1/invitations", { method: "POST", body: JSON.stringify(body) }), CTX);

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  caller = { _id: "o1", username: "owner", fullName: "Board Owner", role: "member" };
  selfOrigin.mockReturnValue("https://planner.example");
  userExists.mockResolvedValue(null);
  projectFindById.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ _id: "p1", key: "TP", name: "Test" }) }),
  });
  inviteToBoard.mockResolvedValue({ kind: "created", invitation: { _id: "inv-1" }, token: "cpi_secret" });
  deliverTo.mockResolvedValue({ delivery: "email" });
});

describe("POST /api/projects/:id/invitations", () => {
  it("invites the address to this board as a member of the instance, and mails it", async () => {
    const res = await post({ email: " Ada@Example.com ", relation: "owner" });

    expect(res.status).toBe(201);
    expect(inviteToBoard).toHaveBeenCalledWith({
      email: "ada@example.com",
      project: "p1",
      relation: "owner",
      invitedBy: "o1",
    });
    const [, token, , inviter, role, boards] = deliverTo.mock.calls[0];
    expect([token, inviter, role, boards]).toEqual([
      "cpi_secret",
      caller,
      "member",
      [{ project: "p1", relation: "owner" }],
    ]);
    expect(JSON.stringify(await res.json())).not.toContain("cpi_secret");
    expect(logProjectAudit).toHaveBeenCalledWith("p1", "o1", "member_invited", "ada@example.com: invited as owner");
  });

  // The invitation already sent is somebody else's: no new link, no mail, nothing to hand back
  it("adds the board to an invitation already pending without sending or returning a link", async () => {
    inviteToBoard.mockResolvedValue({ kind: "added", invitation: { _id: "inv-admin" } });

    const res = await post({ email: "ada@example.com" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "added" });
    expect(deliverTo).not.toHaveBeenCalled();
  });

  it("refuses an address that already has an account", async () => {
    userExists.mockImplementation(async (f: { email: string }) => (f.email === "ada@example.com" ? { _id: "u2" } : null));

    const res = await post({ email: "ADA@example.com" });

    expect(res.status).toBe(409);
    expect(inviteToBoard).not.toHaveBeenCalled();
  });

  it("refuses a machine credential", async () => {
    caller = { ...caller, viaMachineCredential: true };

    expect((await post({ email: "ada@example.com" })).status).toBe(403);
    expect(inviteToBoard).not.toHaveBeenCalled();
  });

  it.each([[{ email: "nope" }], [{ email: "ada@example.com", relation: "admin" }], [{}]])("refuses %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(inviteToBoard).not.toHaveBeenCalled();
  });

  it("holds an owner to thirty invitations a window", async () => {
    for (let i = 0; i < 29; i++) await post({ email: `n${i}@example.com` });
    expect((await post({ email: "last@example.com" })).status).toBe(201);

    expect((await post({ email: "over@example.com" })).status).toBe(429);
  });

  it("does not spend the budget on a refused request", async () => {
    for (let i = 0; i < 40; i++) await post({ email: "nope" });

    expect((await post({ email: "ada@example.com" })).status).toBe(201);
  });
});

describe("GET /api/projects/:id/invitations", () => {
  it("lists this board's entry on each pending invitation, leaving out addresses that have an account", async () => {
    invitationFind.mockReturnValue({
      sort: () => ({
        lean: () =>
          Promise.resolve([
            {
              _id: "inv-1",
              email: "ada@example.com",
              expiresAt: new Date(Date.now() + 86_400_000),
              boards: [
                { project: "p9", relation: "owner", addedBy: "a1" },
                { project: "p1", relation: "member", addedBy: "o1" },
              ],
            },
            {
              _id: "inv-2",
              email: "held@example.com",
              expiresAt: new Date(Date.now() + 86_400_000),
              boards: [{ project: "p1", relation: "member", addedBy: "o1" }],
            },
          ]),
      }),
    });
    userFind.mockImplementation((filter: Record<string, unknown>) => ({
      select: () => ({
        lean: () =>
          Promise.resolve(
            "email" in filter ? [{ email: "held@example.com" }] : [{ _id: "o1", username: "owner" }]
          ),
      }),
    }));

    const res = await GET(new Request("http://x/api/projects/p1/invitations"), CTX);

    expect(invitationFind).toHaveBeenCalledWith({ status: "pending", "boards.project": "p1" });
    expect(await res.json()).toEqual([
      expect.objectContaining({ _id: "inv-1", email: "ada@example.com", relation: "member", addedBy: "owner", expired: false }),
    ]);
  });
});
