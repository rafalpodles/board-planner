import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
const clientDeleteOne = vi.fn();
const tokenDeleteMany = vi.fn();
const codeDeleteMany = vi.fn();
const consentDeleteMany = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/oauthClient", () => ({
  OAuthClient: { findById, deleteOne: clientDeleteOne, find: vi.fn() },
}));
vi.mock("@/models/oauthToken", () => ({
  OAuthToken: { deleteMany: tokenDeleteMany, aggregate: vi.fn() },
}));
vi.mock("@/models/oauthCode", () => ({ OAuthCode: { deleteMany: codeDeleteMany } }));
vi.mock("@/models/oauthConsent", () => ({ OAuthConsent: { deleteMany: consentDeleteMany } }));
vi.mock("@/lib/middleware", () => ({
  withAdmin:
    (handler: (req: Request, ctx: unknown) => Promise<Response>) =>
    (req: Request, ctx: unknown) =>
      handler(req, { ...(ctx as object), user: { _id: "a1", role: "admin" } }),
}));

const { DELETE } = await import("./route");

const VALID_ID = "507f1f77bcf86cd799439011";

function request(body: unknown) {
  return new Request("https://app.example.com/api/oauth/clients", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue({ _id: VALID_ID, clientId: "client-abc" });
});

describe("DELETE /api/oauth/clients", () => {
  it("cascades the deletion of the client named by a valid id", async () => {
    const res = await DELETE(request({ id: VALID_ID }), ctx());

    expect(res.status).toBe(200);
    expect(tokenDeleteMany).toHaveBeenCalledWith({ clientId: "client-abc" });
    expect(clientDeleteOne).toHaveBeenCalledWith({ _id: VALID_ID });
  });

  // BP-304: admin-only, so lower severity — but findById({"$ne": null}) still picks an
  // arbitrary client and cascade-deletes its tokens, codes and consents.
  it("refuses a Mongo operator in place of an id", async () => {
    const res = await DELETE(request({ id: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findById).not.toHaveBeenCalled();
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(clientDeleteOne).not.toHaveBeenCalled();
  });

  // BP-444: `request.json()` throws on a body it cannot parse, and an uncaught throw is a 500 for
  // what the caller should be told is a 400.
  it("refuses a body that is not JSON instead of throwing", async () => {
    const res = await DELETE(
      new Request("https://app.example.com/api/oauth/clients", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      ctx()
    );

    expect(res.status).toBe(400);
    expect(findById).not.toHaveBeenCalled();
    expect(clientDeleteOne).not.toHaveBeenCalled();
  });
});
