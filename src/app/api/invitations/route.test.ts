import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const issueInvitation = vi.fn();
const recordDelivery = vi.fn();
const deliverTo = vi.fn();
const userExists = vi.fn();
const userFind = vi.fn();
const invitationFind = vi.fn();
const projectFind = vi.fn();
const logInstanceAudit = vi.fn();
const selfOrigin = vi.fn();
const memberLimitRefusal = vi.fn();
let caller: Record<string, unknown>;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});
vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
  return {
    withAdmin:
      (handler: (r: Request, c: unknown) => unknown) =>
      (request: Request) =>
        handler(request, { params: Promise.resolve({}), user: caller, db: scopedToDefaultOrganisation() }),
  };
});
vi.mock("@/lib/session", () => ({ selfOrigin }));
vi.mock("@/lib/member-limit", () => ({ memberLimitRefusal }));
vi.mock("@/lib/invitations", () => ({ issueInvitation, recordDelivery }));
vi.mock("@/lib/invitation-mail", async () => {
  const actual = await vi.importActual<typeof import("@/lib/invitation-mail")>("@/lib/invitation-mail");
  return { ...actual, deliverTo };
});
vi.mock("@/lib/invitation-view", () => ({
  toApiInvitations: async (_db: unknown, rows: { email: string }[]) => rows.map((r) => ({ email: r.email })),
  describeInvitation: () => "described",
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/models/user", () => ({ User: { exists: userExists, find: userFind } }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));
vi.mock("@/models/invitation", () => ({ Invitation: { find: invitationFind } }));

const { GET, POST } = await import("./route");
const { resetRateLimits, recordFailedAttempt } = await import("@/lib/rate-limit");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const P1 = "64b000000000000000000001";
const CTX = { params: Promise.resolve({}) };

function post(body: unknown) {
  return new Request("http://x/api/invitations", { method: "POST", body: JSON.stringify(body) });
}

function boardsExist(ids: string[]) {
  projectFind.mockImplementation((filter: { _id: { $in: string[] } }) => ({
    select: () => ({
      lean: () =>
        Promise.resolve(
          filter._id.$in.filter((id) => ids.includes(id)).map((_id) => ({ _id, key: "TP", name: "Test" }))
        ),
    }),
  }));
}

beforeEach(async () => {
  await resetRateLimits();
  vi.clearAllMocks();
  caller = { _id: "admin-1", username: "owner", fullName: "Owner", role: "admin" };
  selfOrigin.mockReturnValue("https://planner.example");
  userExists.mockResolvedValue(null);
  memberLimitRefusal.mockResolvedValue(null);
  boardsExist([P1]);
  issueInvitation.mockResolvedValue({
    invitation: { _id: "inv-1", email: "ada@example.com" },
    token: "cpi_secret",
  });
  deliverTo.mockResolvedValue({ delivery: "email" });
});

const OTHER_ORGANISATION = "0000000000000000000000b2";
const ORGANISATION = DEFAULT_ORGANISATION_ID.toHexString();

// BP-923. The route sent mail to any address, as often as it was asked
describe("POST /api/invitations: what it may send", () => {
  it("holds an administrator to a budget of their own, an address that has an account included", async () => {
    userExists.mockResolvedValue({ _id: "u2" });
    for (let i = 0; i < 30; i++) await POST(post({ email: `probe${i}@example.com` }), CTX);
    userExists.mockResolvedValue(null);

    const res = await POST(post({ email: "ada@example.com" }), CTX);

    expect(res.status).toBe(429);
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it("does not hold another administrator to it — the control", async () => {
    for (let i = 0; i < 30; i++) await recordFailedAttempt("invite:admin-9");

    expect((await POST(post({ email: "ada@example.com" }), CTX)).status).toBe(201);
  });

  it("holds the organisation to a sending budget of its own", async () => {
    for (let i = 0; i < 100; i++) await recordFailedAttempt(`invite-send:${ORGANISATION}`);

    const res = await POST(post({ email: "ada@example.com" }), CTX);

    expect(res.status).toBe(429);
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it("holds one address to five invitations a window in this organisation", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(post({ email: "ada@example.com" }), CTX)).status).toBe(201);

    expect((await POST(post({ email: "ada@example.com" }), CTX)).status).toBe(429);
    expect((await POST(post({ email: "someone-else@example.com" }), CTX)).status).toBe(201);
  });

  it("is not held up by another organisation's invitations to the address, nor told of them", async () => {
    for (let i = 0; i < 5; i++) await recordFailedAttempt(`board-invite-to:${OTHER_ORGANISATION}:ada@example.com`);
    for (let i = 0; i < 20; i++) await recordFailedAttempt("board-invite-to:ada@example.com");

    const res = await POST(post({ email: "ada@example.com" }), CTX);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ delivery: "link", reason: "mail_failed" });
    expect(deliverTo).not.toHaveBeenCalled();
  });
});

describe("POST /api/invitations", () => {
  it("invites an address to boards and says it was mailed", async () => {
    const res = await POST(post({ email: " Ada@Example.com ", boards: [{ project: P1, relation: "owner" }] }), CTX);

    expect(res.status).toBe(201);
    expect(issueInvitation).toHaveBeenCalledWith(scopedToDefaultOrganisation(), {
      email: "ada@example.com",
      role: "member",
      boards: [{ project: P1, relation: "owner" }],
      invitedBy: "admin-1",
    });
    const body = await res.json();
    expect(body.delivery).toBe("email");
    expect(recordDelivery).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "inv-1", "cpi_secret", "email");
    expect(JSON.stringify(body)).not.toContain("cpi_secret");
    expect(logInstanceAudit).toHaveBeenCalledWith(
      scopedToDefaultOrganisation(),
      expect.objectContaining({ action: "invitation_sent", target: "ada@example.com" })
    );
  });

  it("returns the link when no mail went out", async () => {
    deliverTo.mockResolvedValue({ delivery: "link", link: "https://planner.example/invite?token=cpi_secret", reason: "no_mail_server" });

    const body = await (await POST(post({ email: "ada@example.com" }), CTX)).json();

    expect(body).toMatchObject({ delivery: "link", reason: "no_mail_server" });
    expect(body.link).toContain("cpi_secret");
  });

  it("refuses an address that already belongs to an account, compared as stored", async () => {
    userExists.mockImplementation(async (filter: { email: string }) =>
      filter.email === "ada@example.com" ? { _id: "u2" } : null
    );

    const res = await POST(post({ email: "  ADA@example.com" }), CTX);

    expect(res.status).toBe(409);
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  // A machine credential minting an admin invitation would be a way to make an account and sign
  // in as it — the same escalation POST /api/users refuses
  // BP-948
  it("refuses with the member limit's own answer when the organisation is full, issuing nothing", async () => {
    memberLimitRefusal.mockResolvedValue(Response.json({ feature: "members.limit", members: 10, limit: 10 }, { status: 402 }));

    const res = await POST(post({ email: "ada@example.com", boards: [{ project: P1, relation: "member" }] }), CTX);

    expect(res.status).toBe(402);
    expect(memberLimitRefusal).toHaveBeenCalledWith(scopedToDefaultOrganisation(), { email: "ada@example.com" });
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it("refuses a machine credential", async () => {
    caller = { ...caller, viaMachineCredential: true };

    const res = await POST(post({ email: "ada@example.com", role: "admin" }), CTX);

    expect(res.status).toBe(403);
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it("refuses a board that does not exist", async () => {
    boardsExist([]);

    const res = await POST(post({ email: "ada@example.com", boards: [{ project: P1, relation: "member" }] }), CTX);

    expect(res.status).toBe(400);
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it.each([
    [{ email: "not-an-address" }],
    [{ email: "ada@example.com", role: "superuser" }],
    [{ email: "ada@example.com", boards: [{ project: "nope", relation: "member" }] }],
    [{ email: "ada@example.com", boards: [{ project: P1, relation: "viewer" }] }],
  ])("refuses %j", async (body) => {
    const res = await POST(post(body), CTX);

    expect(res.status).toBe(400);
    expect(issueInvitation).not.toHaveBeenCalled();
  });

  it("refuses to build a link with no PUBLIC_ORIGIN", async () => {
    selfOrigin.mockReturnValue(null);

    const res = await POST(post({ email: "ada@example.com" }), CTX);

    expect(res.status).toBe(500);
    expect(issueInvitation).not.toHaveBeenCalled();
  });
});

describe("GET /api/invitations", () => {
  function pending(rows: { email: string }[]) {
    invitationFind.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(rows) }) });
  }

  it("lists pending invitations, leaving out an address that has gained an account", async () => {
    pending([{ email: "ada@example.com" }, { email: "grace@example.com" }]);
    userFind.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve([{ email: "grace@example.com" }]) }),
    });

    const res = await GET(new Request("http://x/api/invitations"), CTX);

    expect(invitationFind).toHaveBeenCalledWith({ status: "pending", organisation: DEFAULT_ORGANISATION_ID });
    expect(userFind).toHaveBeenCalledWith({
      email: { $in: ["ada@example.com", "grace@example.com"] },
      organisation: DEFAULT_ORGANISATION_ID,
    });
    expect(await res.json()).toEqual([{ email: "ada@example.com" }]);
  });

  it("refuses a machine credential", async () => {
    caller = { ...caller, viaMachineCredential: true };

    const res = await GET(new Request("http://x/api/invitations"), CTX);

    expect(res.status).toBe(403);
    expect(invitationFind).not.toHaveBeenCalled();
  });
});
