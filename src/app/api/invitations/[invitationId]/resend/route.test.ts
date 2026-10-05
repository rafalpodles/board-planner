import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@/lib/organisation-field";

const reissueInvitation = vi.fn();
const recordDelivery = vi.fn();
const deliverTo = vi.fn();
const invitationFindOne = vi.fn();
const userExists = vi.fn();
const projectFind = vi.fn();
const logInstanceAudit = vi.fn();
const selfOrigin = vi.fn();
let caller: Record<string, unknown>;

vi.mock("@/lib/middleware", async () => {
  const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");
  return {
    withAdmin:
      (handler: (r: Request, c: unknown) => unknown) =>
      (request: Request, ctx: { params: Promise<Record<string, string>> }) =>
        handler(request, { params: ctx.params, user: caller, db: scopedToDefaultOrganisation() }),
  };
});
vi.mock("@/lib/session", () => ({ selfOrigin }));
vi.mock("@/lib/invitations", () => ({ reissueInvitation, recordDelivery }));
vi.mock("@/lib/invitation-mail", async () => {
  const actual = await vi.importActual<typeof import("@/lib/invitation-mail")>("@/lib/invitation-mail");
  return { ...actual, deliverTo };
});
vi.mock("@/lib/invitation-view", () => ({
  toApiInvitations: async (_db: unknown, rows: { email: string }[]) => rows.map((r) => ({ email: r.email })),
  describeInvitation: () => "described",
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/models/invitation", () => ({ Invitation: { findOne: invitationFindOne } }));
vi.mock("@/models/user", () => ({ User: { exists: userExists } }));
vi.mock("@/models/project", () => ({ Project: { find: projectFind } }));

const { POST } = await import("./route");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const ID = "64b0000000000000000000aa";
const resend = (body?: unknown) =>
  POST(
    new Request(`http://x/api/invitations/${ID}/resend`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ invitationId: ID }) }
  );

beforeEach(() => {
  vi.clearAllMocks();
  caller = { _id: "admin-2", username: "second", fullName: "Second Admin", role: "admin" };
  selfOrigin.mockReturnValue("https://planner.example");
  invitationFindOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve({ email: "ada@example.com" }) }),
  });
  userExists.mockResolvedValue(null);
  projectFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  reissueInvitation.mockResolvedValue({
    invitation: { _id: ID, email: "ada@example.com", role: "member", boards: [] },
    token: "cpi_new",
    dropped: [],
  });
  deliverTo.mockResolvedValue({ delivery: "email" });
});

describe("POST /api/invitations/:id/resend", () => {
  it("issues a new link endorsed by whoever resends it, and mails it in their name", async () => {
    const res = await resend();

    expect(res.status).toBe(200);
    expect(reissueInvitation).toHaveBeenCalledWith(scopedToDefaultOrganisation(), ID, "admin-2");
    expect(recordDelivery).toHaveBeenCalledWith(scopedToDefaultOrganisation(), ID, "cpi_new", "email");
    expect(deliverTo.mock.calls[0][1]).toBe("cpi_new");
    expect(deliverTo.mock.calls[0][3]).toBe(caller);
    expect(JSON.stringify(await res.json())).not.toContain("cpi_new");
    expect(logInstanceAudit.mock.calls[0][1]).toMatchObject({ action: "invitation_resent" });
  });

  // BP-843. Nobody chose to drop them, so the answer names them
  it("names the boards the resend left out", async () => {
    reissueInvitation.mockResolvedValue({
      invitation: { _id: ID, email: "ada@example.com", role: "member", boards: [] },
      token: "cpi_new",
      dropped: [{ project: "p-b", relation: "member", addedBy: "owner-b" }],
    });
    projectFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: "p-b", key: "BB", name: "Beta" }]) }) });

    expect((await (await resend()).json()).dropped).toEqual(["Beta"]);
  });

  it("hands the link back when no mail went out", async () => {
    deliverTo.mockResolvedValue({
      delivery: "link",
      link: "https://planner.example/invite?token=cpi_new",
      reason: "no_mail_server",
    });

    expect(await (await resend()).json()).toMatchObject({ delivery: "link", reason: "no_mail_server" });
  });

  it("issues a link without mailing it when asked for one", async () => {
    const res = await resend({ delivery: "link" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      delivery: "link",
      link: "https://planner.example/invite?token=cpi_new",
      reason: "requested",
    });
    expect(deliverTo).not.toHaveBeenCalled();
    expect(recordDelivery).toHaveBeenCalledWith(scopedToDefaultOrganisation(), ID, "cpi_new", "link");
    expect(logInstanceAudit.mock.calls[0][1]).toMatchObject({ action: "invitation_link_issued" });
  });

  it("refuses an unknown delivery before touching the invitation", async () => {
    expect((await resend({ delivery: "carrier-pigeon" })).status).toBe(400);
    expect(reissueInvitation).not.toHaveBeenCalled();
  });

  // The same escalation POST refuses: an admin API token reading a working admin link back
  it("refuses a machine credential", async () => {
    caller = { ...caller, viaMachineCredential: true };

    expect((await resend()).status).toBe(403);
    expect(reissueInvitation).not.toHaveBeenCalled();
  });

  it("refuses an address that has gained an account", async () => {
    userExists.mockResolvedValue({ _id: "u2" });

    expect((await resend()).status).toBe(409);
    expect(userExists).toHaveBeenCalledWith({ email: "ada@example.com", organisation: DEFAULT_ORGANISATION_ID });
    expect(reissueInvitation).not.toHaveBeenCalled();
  });

  it("answers 404 for an invitation that is no longer pending", async () => {
    reissueInvitation.mockResolvedValue(null);

    expect((await resend()).status).toBe(404);
    expect(deliverTo).not.toHaveBeenCalled();
  });
});
