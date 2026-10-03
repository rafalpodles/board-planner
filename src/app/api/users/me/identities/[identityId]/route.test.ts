import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const identityFindOne = vi.fn();
const identityCount = vi.fn();
const identityDelete = vi.fn();
const identityInsert = vi.fn();
const isEmailConfigured = vi.fn();
const userFindById = vi.fn();
const logInstanceAudit = vi.fn();
const signedInRecently = vi.fn();
let caller: Record<string, unknown>;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/middleware", () => ({
  withAuth:
    (handler: (r: Request, c: unknown) => unknown) =>
    (request: Request, ctx: { params: Promise<Record<string, string>> }) =>
      handler(request, { params: ctx.params, user: caller }),
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
const LIVE = { $or: [{ provider: "oidc", issuer: { $in: ["https://id.example.com", "https://id.example.com/"] } }] };
vi.mock("@/lib/oidc/providers", () => ({ providerById: () => ({ label: "Acme" }), liveIdentityFilter: () => LIVE }));
const identityExists = vi.fn();
vi.mock("@/lib/email", () => ({ isEmailConfigured }));
vi.mock("@/lib/session", () => ({ signedInRecently, RECENT_SIGN_IN_REQUIRED: "sign in again" }));
vi.mock("@/models/identity", () => ({
  Identity: {
    findOne: identityFindOne,
    countDocuments: identityCount,
    exists: identityExists,
    deleteOne: identityDelete,
    collection: { insertOne: identityInsert },
  },
}));
vi.mock("@/models/user", () => ({ User: { findById: userFindById } }));

const { DELETE } = await import("./route");

const ID = "64b0000000000000000000aa";
const unlink = () =>
  DELETE(new Request(`http://x/api/users/me/identities/${ID}`, { method: "DELETE" }), {
    params: Promise.resolve({ identityId: ID }),
  });
const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });
const passwordIs = (password?: string) =>
  userFindById.mockReturnValue({ select: () => lean(password ? { password } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  caller = { _id: "u1", username: "ada" };
  identityFindOne.mockReturnValue(lean({ _id: ID, provider: "oidc" }));
  identityCount.mockResolvedValue(0);
  identityExists.mockResolvedValue({ _id: ID });
  isEmailConfigured.mockReturnValue(true);
  passwordIs("$2a$10$hash");
  signedInRecently.mockResolvedValue(true);
});

describe("DELETE /api/users/me/identities/:id", () => {
  // BP-842. A link from a provider's former issuer is no way in, so removing it removes none
  it("unlinks a former issuer's link from an account with no other way in, without asking for a recent sign-in", async () => {
    passwordIs();
    identityExists.mockResolvedValue(null);
    signedInRecently.mockResolvedValue(false);

    const res = await unlink();

    expect(res.status).toBe(200);
    expect(identityExists).toHaveBeenCalledWith({ _id: ID, ...LIVE });
    expect(identityDelete).toHaveBeenCalled();
    expect(identityInsert).not.toHaveBeenCalled();
  });

  it("unlinks a provider from an account that also has a password", async () => {
    const res = await unlink();

    expect(res.status).toBe(200);
    expect(identityFindOne).toHaveBeenCalledWith({ _id: ID, user: "u1" });
    expect(identityDelete).toHaveBeenCalledWith({ _id: ID, user: "u1" });
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "identity_unlinked" }));
  });

  it("refuses to unlink the only way in, and says how to make another", async () => {
    passwordIs(undefined);

    const res = await unlink();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Forgot your password");
    expect(identityCount).toHaveBeenCalledWith({ user: "u1", _id: { $ne: ID }, ...LIVE });
    expect(identityDelete).not.toHaveBeenCalled();
  });

  it("points at an administrator where no mail can be sent", async () => {
    passwordIs(undefined);
    isEmailConfigured.mockReturnValue(false);

    expect((await (await unlink()).json()).error).toContain("Ask an administrator");
  });

  it("lets a password-less account drop one of two providers", async () => {
    passwordIs(undefined);
    identityCount.mockResolvedValueOnce(1).mockResolvedValueOnce(1);

    expect((await unlink()).status).toBe(200);
    expect(identityInsert).not.toHaveBeenCalled();
  });

  // Two tabs, each unlinking one of two providers, each counting the other as the way that remains
  it("puts the provider back when another unlink took the last way in meanwhile", async () => {
    passwordIs(undefined);
    identityCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const res = await unlink();

    expect(res.status).toBe(409);
    expect(identityCount).toHaveBeenLastCalledWith({ user: "u1", ...LIVE });
    expect(identityInsert).toHaveBeenCalledWith(expect.objectContaining({ _id: ID, provider: "oidc" }));
  });

  it("asks an account with a password for no recent sign-in: the password stays a way in", async () => {
    signedInRecently.mockResolvedValue(false);

    expect((await unlink()).status).toBe(200);
  });

  // Unlinking with no password behind it, from a session that is not fresh, could leave an
  // intruder's own provider as the account's only way in
  it("refuses a password-less account whose sign-in is not recent", async () => {
    passwordIs(undefined);
    identityCount.mockResolvedValue(1);
    signedInRecently.mockResolvedValue(false);

    const res = await unlink();

    expect(res.status).toBe(403);
    expect(identityDelete).not.toHaveBeenCalled();
  });

  it("answers 404 for an identity that is somebody else's", async () => {
    identityFindOne.mockReturnValue(lean(null));

    expect((await unlink()).status).toBe(404);
    expect(identityDelete).not.toHaveBeenCalled();
  });

  it("refuses a machine credential", async () => {
    caller = { ...caller, viaMachineCredential: true };

    expect((await unlink()).status).toBe(403);
    expect(identityFindOne).not.toHaveBeenCalled();
  });
});

describe("with password sign-in off (BP-830)", () => {
  afterEach(() => {
    delete process.env.PASSWORD_SIGN_IN;
  });

  // The password is still on the account, but it signs nobody in: unlinking the last provider
  // would leave the account no way in at all
  it("counts a password as no way in", async () => {
    process.env.PASSWORD_SIGN_IN = "off";

    const res = await unlink();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Link another provider first");
    expect(identityDelete).not.toHaveBeenCalled();
  });
});
