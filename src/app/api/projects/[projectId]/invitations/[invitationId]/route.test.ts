import { describe, it, expect, vi, beforeEach } from "vitest";

const removeBoardFromInvitation = vi.fn();
const revokeIfEmpty = vi.fn();
const userFindById = vi.fn();
const logProjectAudit = vi.fn();

vi.mock("@/lib/middleware", () => ({
  withProjectOwner:
    (handler: (r: Request, c: unknown) => unknown) =>
    (request: Request, ctx: { params: Promise<Record<string, string>> }) =>
      handler(request, { params: ctx.params, user: { _id: "o1", username: "owner" } }),
}));
vi.mock("@/lib/invitations", () => ({ removeBoardFromInvitation, revokeIfEmpty }));
vi.mock("@/lib/projectAudit", () => ({ logProjectAudit }));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));

const { DELETE } = await import("./route");

const ID = "64b0000000000000000000aa";
const del = (invitationId = ID) =>
  DELETE(new Request(`http://x/api/projects/p1/invitations/${invitationId}`, { method: "DELETE" }), {
    params: Promise.resolve({ projectId: "p1", invitationId }),
  });

function inviter(user: unknown) {
  userFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(user) }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  inviter({ role: "member", kind: "human" });
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

  it("revokes an owner's invitation left with no boards", async () => {
    removeBoardFromInvitation.mockResolvedValue({ _id: ID, email: "ada@example.com", boards: [], invitedBy: "o1" });

    await del();

    expect(revokeIfEmpty).toHaveBeenCalledWith(ID);
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
