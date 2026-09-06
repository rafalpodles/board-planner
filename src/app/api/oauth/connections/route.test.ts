import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndDelete = vi.fn();
const getAuthUser = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/oauthToken", () => ({ OAuthToken: { find: vi.fn(), findOneAndDelete } }));
vi.mock("@/lib/auth", () => ({ getAuthUser }));

const { DELETE } = await import("./route");

function request(body: unknown) {
  return new Request("https://app.example.com/api/oauth/connections", {
    method: "DELETE",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

const ctx = () => ({ params: Promise.resolve({}) });

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ _id: "u1", username: "owner", role: "member" });
  findOneAndDelete.mockResolvedValue({ _id: "c1" });
});

describe("DELETE /api/oauth/connections", () => {
  it("deletes the connection named by a valid id", async () => {
    const res = await DELETE(request({ id: "507f1f77bcf86cd799439011" }), ctx());

    expect(res.status).toBe(200);
    expect(findOneAndDelete).toHaveBeenCalledWith({
      _id: "507f1f77bcf86cd799439011",
      user: "u1",
    });
  });

  it("refuses a Mongo operator in place of an id, which would delete an arbitrary row", async () => {
    const res = await DELETE(request({ id: { $ne: null } }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });

  it("refuses a string that is not an object id", async () => {
    const res = await DELETE(request({ id: "not-an-object-id" }), ctx());

    expect(res.status).toBe(400);
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });

  // BP-444: the same family as the token endpoint's. `request.json()` throws on a body it cannot
  // parse, and an uncaught throw here is a 500 for what is a 400.
  it("refuses a body that is not JSON instead of throwing", async () => {
    const res = await DELETE(
      new Request("https://app.example.com/api/oauth/connections", {
        method: "DELETE",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: "{not json",
      }),
      ctx()
    );

    expect(res.status).toBe(400);
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });
});
