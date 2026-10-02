import { describe, it, expect, vi, beforeEach } from "vitest";

const revokeInvitation = vi.fn();
const logInstanceAudit = vi.fn();
let caller: Record<string, unknown>;

vi.mock("@/lib/middleware", () => ({
  withAdmin:
    (handler: (r: Request, c: unknown) => unknown) =>
    (request: Request, ctx: { params: Promise<Record<string, string>> }) =>
      handler(request, { params: ctx.params, user: caller }),
}));
vi.mock("@/lib/invitations", () => ({ revokeInvitation }));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));

const { DELETE } = await import("./route");

const ID = "64b0000000000000000000aa";
const del = (id = ID) =>
  DELETE(new Request(`http://x/api/invitations/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ invitationId: id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  caller = { _id: "admin-1", username: "owner", role: "admin" };
  revokeInvitation.mockResolvedValue({ _id: ID, email: "ada@example.com" });
});

describe("DELETE /api/invitations/:id", () => {
  it("revokes and records it", async () => {
    const res = await del();

    expect(res.status).toBe(200);
    expect(revokeInvitation).toHaveBeenCalledWith(ID);
    expect(logInstanceAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "invitation_revoked", target: "ada@example.com" })
    );
  });

  it("answers 404 for one that is no longer revocable", async () => {
    revokeInvitation.mockResolvedValue(null);

    expect((await del()).status).toBe(404);
    expect(logInstanceAudit).not.toHaveBeenCalled();
  });

  it("answers 404 for an id that is not one", async () => {
    expect((await del("nope")).status).toBe(404);
    expect(revokeInvitation).not.toHaveBeenCalled();
  });

  it("refuses a machine credential", async () => {
    caller = { ...caller, viaMachineCredential: true };

    expect((await del()).status).toBe(403);
    expect(revokeInvitation).not.toHaveBeenCalled();
  });
});
