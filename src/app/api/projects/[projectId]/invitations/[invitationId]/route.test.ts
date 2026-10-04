import { describe, it, expect, vi, beforeEach } from "vitest";

const removeBoardFromInvitation = vi.fn();
const revokeIfEmpty = vi.fn();
const userFindOne = vi.fn();
const logProjectAudit = vi.fn();
const logInstanceAudit = vi.fn();
let caller: Record<string, unknown> = {};

vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultTenant } = await import("@/lib/db-scope");
  return {
    withProjectOwner:
      (handler: (r: Request, c: unknown) => unknown) =>
      (request: Request, ctx: { params: Promise<Record<string, string>> }) =>
        handler(request, { params: ctx.params, user: caller, db: scopedToDefaultTenant() }),
  };
});
vi.mock("@/lib/invitations", () => ({ removeBoardFromInvitation, revokeIfEmpty }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/models/user", () => ({ User: { findOne: userFindOne } }));

const { DELETE } = await import("./route");

const ID = "64b0000000000000000000aa";
const del = (invitationId = ID) =>
  DELETE(new Request(`http://x/api/projects/p1/invitations/${invitationId}`, { method: "DELETE" }), {
    params: Promise.resolve({ projectId: "p1", invitationId }),
  });

function inviter(user: unknown) {
  userFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(user) }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  caller = { _id: "o1", username: "owner" };
  inviter({ role: "member", kind: "human" });
  revokeIfEmpty.mockResolvedValue(true);
});

describe("DELETE /api/projects/:id/invitations/:invitationId", () => {
  it("withdraws this board, and leaves the rest of the invitation alone", async () => {
    removeBoardFromInvitation.mockResolvedValue({ _id: ID, email: "ada@example.com", boards: [{ project: "p2" }] });

    const res = await del();

    expect(res.status).toBe(200);
    expect(removeBoardFromInvitation).toHaveBeenCalledWith(ID, "p1");
    expect(revokeIfEmpty).not.toHaveBeenCalled();
    expect(logProjectAudit).toHaveBeenCalledWith(
      "p1",
      "o1",
      "member_invitation_removed",
      "ada@example.com: invitation to this board withdrawn"
    );
  });

  it("revokes the owner's invitation it read once it has no boards, and says so in the instance log", async () => {
    const row = { _id: ID, email: "ada@example.com", boards: [], invitedBy: "o1", tokenHash: "h1" };
    removeBoardFromInvitation.mockResolvedValue(row);

    await del();

    expect(revokeIfEmpty).toHaveBeenCalledWith(row);
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invitation_revoked", target: "ada@example.com" })
    );
  });

  it("logs no revocation the empty-check did not make", async () => {
    removeBoardFromInvitation.mockResolvedValue({ _id: ID, email: "ada@example.com", boards: [], invitedBy: "o1" });
    revokeIfEmpty.mockResolvedValue(false);

    await del();

    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["a deleted inviter", null],
    ["a machine account", { role: "admin", kind: "machine" }],
  ])("revokes an empty invitation from %s", async (_label, who) => {
    removeBoardFromInvitation.mockResolvedValue({ _id: ID, email: "ada@example.com", boards: [], invitedBy: "x1" });
    inviter(who);

    await del();

    expect(revokeIfEmpty).toHaveBeenCalled();
  });

  it("refuses a machine credential", async () => {
    caller = { ...caller, viaMachineCredential: true };

    expect((await del()).status).toBe(403);
    expect(removeBoardFromInvitation).not.toHaveBeenCalled();
  });

  // An administrator's invitation still gives a role on its own
  it("keeps an administrator's invitation that has no boards left", async () => {
    removeBoardFromInvitation.mockResolvedValue({ _id: ID, email: "ada@example.com", boards: [], invitedBy: "a1" });
    inviter({ role: "admin", kind: "human" });

    await del();

    expect(revokeIfEmpty).not.toHaveBeenCalled();
  });

  it("answers 404 for an invitation this board is not on", async () => {
    removeBoardFromInvitation.mockResolvedValue(null);

    expect((await del()).status).toBe(404);
    expect(logProjectAudit).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not one", async () => {
    expect((await del("nope")).status).toBe(404);
    expect(removeBoardFromInvitation).not.toHaveBeenCalled();
  });
});
