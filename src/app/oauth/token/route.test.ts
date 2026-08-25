import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneAndDelete = vi.fn();
const create = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/oauthCode", () => ({ OAuthCode: { findOne: vi.fn() } }));
vi.mock("@/models/oauthToken", () => ({ OAuthToken: { findOneAndDelete, create } }));

const { POST } = await import("./route");
const { sha256 } = await import("@/lib/oauth");

const REFRESH = "cprt_" + "a".repeat(64);

function refreshRequest(token = REFRESH) {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token });
  return new Request("https://app.example.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
});

describe("POST /oauth/token — refresh rotation", () => {
  it("consumes the token in one atomic operation, not find-then-delete", async () => {
    findOneAndDelete.mockResolvedValue({
      clientId: "c1",
      user: "u1",
      scope: "mcp",
      allowedProjects: [],
    });

    const res = await POST(refreshRequest());

    expect(res.status).toBe(200);
    const filter = findOneAndDelete.mock.calls[0][0];
    expect(filter.refreshTokenHash).toBe(sha256(REFRESH));
    // The checks the old find-then-validate path made must survive inside the atomic filter
    expect(filter.refreshExpiresAt).toEqual({ $gt: expect.any(Date) });
  });

  it("lets exactly one of two concurrent refreshes win", async () => {
    // Mongo hands the row to one caller; the loser matches nothing
    let remaining = 1;
    findOneAndDelete.mockImplementation(async () => {
      if (remaining === 0) return null;
      remaining -= 1;
      return { clientId: "c1", user: "u1", scope: "mcp", allowedProjects: [] };
    });

    const [a, b] = await Promise.all([POST(refreshRequest()), POST(refreshRequest())]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 400]);
    // One pair issued, never two — the defect was that both callers were served
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses a token that matched nothing", async () => {
    findOneAndDelete.mockResolvedValue(null);

    const res = await POST(refreshRequest());

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
    expect(create).not.toHaveBeenCalled();
  });

  it("scopes the filter to the client when one is supplied", async () => {
    findOneAndDelete.mockResolvedValue(null);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      client_id: "c9",
    });
    await POST(
      new Request("https://app.example.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      })
    );

    expect(findOneAndDelete.mock.calls[0][0].clientId).toBe("c9");
  });
});

/**
 * BP-444. This endpoint is the one a client reaches by itself the moment its access token lapses,
 * and `Request.formData()` throws a TypeError on any body that is not a form — which left an empty
 * 500 where RFC 6749 §5.2 has a 400 naming `invalid_request`. A client acts on the second and not
 * on the first, so the lapse became a person's problem rather than the client's.
 */
describe("POST /oauth/token — a body it cannot parse", () => {
  const unparseable: [string, RequestInit][] = [
    [
      "a JSON body",
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: REFRESH }),
      },
    ],
    ["a text/plain body", { headers: { "content-type": "text/plain" }, body: "grant_type=x" }],
    ["no content-type at all", { body: "grant_type=refresh_token" }],
  ];

  it.each(unparseable)("answers 400 invalid_request for %s", async (_label, init) => {
    const res = await POST(
      new Request("https://app.example.com/oauth/token", { method: "POST", ...init })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    // Refused before anything was consumed: a body nobody could read must not spend a grant
    expect(findOneAndDelete).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("still issues a pair for a form body — the refusal is about the encoding, not the grant", async () => {
    findOneAndDelete.mockResolvedValue({
      clientId: "c1",
      user: "u1",
      scope: "mcp",
      allowedProjects: [],
    });

    const res = await POST(refreshRequest());

    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
