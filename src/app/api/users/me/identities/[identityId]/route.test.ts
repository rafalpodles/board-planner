import { describe, it, expect, vi, beforeEach } from "vitest";

const identityFindOne = vi.fn();
const identityCount = vi.fn();
const identityDelete = vi.fn();
const userFindById = vi.fn();
const logInstanceAudit = vi.fn();
let caller: Record<string, unknown>;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/middleware", () => ({
  withAuth:
    (handler: (r: Request, c: unknown) => unknown) =>
    (request: Request, ctx: { params: Promise<Record<string, string>> }) =>
      handler(request, { params: ctx.params, user: caller }),
}));
vi.mock("@/lib/instanceAudit", () => ({ logInstanceAudit }));
vi.mock("@/lib/oidc/providers", () => ({ providerById: () => ({ label: "Acme" }) }));
vi.mock("@/models/identity", () => ({
  Identity: { findOne: identityFindOne, countDocuments: identityCount, deleteOne: identityDelete },
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
  passwordIs("$2a$10$hash");
});

describe("DELETE /api/users/me/identities/:id", () => {
  it("unlinks a provider from an account that also has a password", async () => {
    const res = await unlink();

    expect(res.status).toBe(200);
    expect(identityFindOne).toHaveBeenCalledWith({ _id: ID, user: "u1" });
    expect(identityDelete).toHaveBeenCalledWith({ _id: ID, user: "u1" });
    expect(logInstanceAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "identity_unlinked" }));
  });

  it("refuses to unlink the only way in", async () => {
    passwordIs(undefined);

    const res = await unlink();

    expect(res.status).toBe(409);
    expect(identityDelete).not.toHaveBeenCalled();
  });

  it("lets a password-less account drop one of two providers", async () => {
    passwordIs(undefined);
    identityCount.mockResolvedValue(1);

    expect((await unlink()).status).toBe(200);
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
