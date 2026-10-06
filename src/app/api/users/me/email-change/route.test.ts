import { describe, it, expect, vi, beforeEach } from "vitest";

const { getAuthUser, pendingEmailChange, cancelEmailChange, issueEmailChange, sendAddressConfirmation, isEmailConfigured, originFor, countAttempt } = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  pendingEmailChange: vi.fn(),
  cancelEmailChange: vi.fn(),
  issueEmailChange: vi.fn(),
  sendAddressConfirmation: vi.fn(),
  isEmailConfigured: vi.fn(),
  originFor: vi.fn(),
  countAttempt: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getAuthUser, RateLimitError: class extends Error {} }));
vi.mock("@/lib/email-change", () => ({ pendingEmailChange, cancelEmailChange, issueEmailChange, CONFIRMATIONS_PER_WINDOW: 3 }));
vi.mock("@/lib/security-mail", () => ({ sendAddressConfirmation }));
vi.mock("@/lib/email", () => ({ isEmailConfigured }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), countAttempt }));
vi.mock("@/lib/organisation-host", async (original) => ({ ...(await original<typeof import("@/lib/organisation-host")>()), originFor }));

const { GET, DELETE, POST } = await import("./route");
const { User } = await import("@/models/user");
const { scopedToDefaultOrganisation } = await import("@/lib/db-scope");

const request = (method: string) =>
  new Request("https://app.example.com/api/users/me/email-change", {
    method,
    headers: { "sec-fetch-site": "same-origin" },
  });
const ctx = { params: Promise.resolve({}) };
const PERSON = { _id: "u1", username: "pat", email: "pat@example.com", viaMachineCredential: false };
const stored = (row: object | null) => vi.spyOn(User, "findOne").mockReturnValue({ select: () => ({ lean: async () => row }) } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  pendingEmailChange.mockResolvedValue({ email: "new@example.com", expiresAt: new Date(0) });
  isEmailConfigured.mockReturnValue(true);
  originFor.mockResolvedValue("https://app.example.com");
  countAttempt.mockResolvedValue(1);
  issueEmailChange.mockResolvedValue("cpe_token");
});

// BP-359 review: like PUT /api/users/me, the recovery address is not a machine credential's business
describe("/api/users/me/email-change", () => {
  it("shows and cancels a pending change for a person, and says whether the address is confirmed", async () => {
    getAuthUser.mockResolvedValue(PERSON);
    stored({ emailVerifiedAt: new Date() });

    expect(await (await GET(request("GET"), ctx)).json()).toMatchObject({ pending: { email: "new@example.com" }, confirmed: true });
    expect((await DELETE(request("DELETE"), ctx)).status).toBe(200);
    expect(cancelEmailChange).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "u1");
  });

  it("calls an address with no proof, or one only an administrator vouched for, not confirmed", async () => {
    getAuthUser.mockResolvedValue(PERSON);

    stored({ emailVerifiedAt: null });
    expect((await (await GET(request("GET"), ctx)).json()).confirmed).toBe(false);
    stored({ emailVerifiedAt: new Date(), emailVouchedByAdmin: true });
    expect((await (await GET(request("GET"), ctx)).json()).confirmed).toBe(false);
  });

  it("refuses a machine credential every way", async () => {
    getAuthUser.mockResolvedValue({ ...PERSON, viaMachineCredential: true });

    expect((await GET(request("GET"), ctx)).status).toBe(403);
    expect((await DELETE(request("DELETE"), ctx)).status).toBe(403);
    expect((await POST(request("POST"), ctx)).status).toBe(403);
    expect(pendingEmailChange).not.toHaveBeenCalled();
    expect(cancelEmailChange).not.toHaveBeenCalled();
    expect(issueEmailChange).not.toHaveBeenCalled();
  });
});

describe("POST /api/users/me/email-change (BP-928)", () => {
  beforeEach(() => {
    pendingEmailChange.mockResolvedValue(null);
    stored({ emailVerifiedAt: null });
  });

  it("mails a confirmation link to the address already on the account, with no password asked", async () => {
    getAuthUser.mockResolvedValue(PERSON);

    const res = await POST(request("POST"), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: "pat@example.com" });
    expect(issueEmailChange).toHaveBeenCalledWith(scopedToDefaultOrganisation(), "u1", "pat@example.com", { ofCurrentAddress: true });
    expect(sendAddressConfirmation).toHaveBeenCalledWith({
      email: "pat@example.com",
      username: "pat",
      confirmUrl: "https://app.example.com/confirm-email#token=cpe_token",
      alreadyOnTheAccount: true,
    });
  });

  it("sends nothing for an address already confirmed by its owner, and sends again over an administrator's word", async () => {
    getAuthUser.mockResolvedValue(PERSON);

    stored({ emailVerifiedAt: new Date(), emailVouchedByAdmin: false });
    expect(await (await POST(request("POST"), ctx)).json()).toEqual({ confirmed: true });
    expect(sendAddressConfirmation).not.toHaveBeenCalled();

    stored({ emailVerifiedAt: new Date(), emailVouchedByAdmin: true });
    expect((await POST(request("POST"), ctx)).status).toBe(200);
    expect(sendAddressConfirmation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an account with no address", { ...PERSON, email: "" }, 409],
    ["a machine account", { ...PERSON, kind: "machine" }, 403],
  ])("refuses %s", async (_name, person, status) => {
    getAuthUser.mockResolvedValue(person);

    expect((await POST(request("POST"), ctx)).status).toBe(status);
    expect(sendAddressConfirmation).not.toHaveBeenCalled();
  });

  it("refuses while a change of address waits for its own link, rather than replacing it", async () => {
    getAuthUser.mockResolvedValue(PERSON);
    pendingEmailChange.mockResolvedValue({ email: "new@example.com", expiresAt: new Date(0) });

    expect((await POST(request("POST"), ctx)).status).toBe(409);
    expect(issueEmailChange).not.toHaveBeenCalled();
  });

  it("says so when the instance cannot send mail, and does not issue a link nobody will receive", async () => {
    getAuthUser.mockResolvedValue(PERSON);
    isEmailConfigured.mockReturnValue(false);

    expect((await POST(request("POST"), ctx)).status).toBe(503);
    expect(issueEmailChange).not.toHaveBeenCalled();
  });

  it("is held to the same three confirmations a window as a change of address", async () => {
    getAuthUser.mockResolvedValue(PERSON);
    countAttempt.mockResolvedValue(4);

    expect((await POST(request("POST"), ctx)).status).toBe(429);
    expect(sendAddressConfirmation).not.toHaveBeenCalled();
  });
});
