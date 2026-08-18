import { describe, it, expect, vi, beforeEach } from "vitest";

const getAuthUser = vi.fn();

vi.mock("@/lib/auth", () => ({ getAuthUser }));

const { GET } = await import("./route");
const { DatabaseUnavailableError } = await import("@/lib/db");
const { ProvenanceError } = await import("@/lib/session");

const USER = {
  _id: "u1",
  username: "rpo",
  fullName: "Rafal",
  email: "rpo@example.com",
  role: "admin",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const request = () => new Request("https://app.example.com/api/auth/me");

function failsWith(error: unknown) {
  getAuthUser.mockImplementation(async () => {
    throw error;
  });
}

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    getAuthUser.mockReset();
  });

  it("answers with the signed-in user", async () => {
    getAuthUser.mockImplementation(async () => USER);

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.username).toBe("rpo");
  });

  it("never includes the password hash", async () => {
    getAuthUser.mockImplementation(async () => ({ ...USER, password: "$2b$10$hash" }));

    const body = await (await GET(request())).json();

    expect(JSON.stringify(body)).not.toContain("$2b$");
  });

  it("answers 401 when nothing resolved to a user", async () => {
    getAuthUser.mockImplementation(async () => null);

    expect((await GET(request())).status).toBe(401);
  });

  // This route is what the app asks on every load to decide whether anyone is signed in, so its
  // 401 is the one that sends people to a sign-in page. During an outage that page cannot sign
  // them in either, which is how a database restart read as "your account is gone" (BP-362).
  it("answers 503 when the database is unreachable", async () => {
    failsWith(new DatabaseUnavailableError(new Error("ECONNREFUSED")));

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(body.error).toMatch(/not a problem with your session/i);
  });

  it("still answers 403 to a refused provenance", async () => {
    failsWith(new ProvenanceError("cross-site"));

    expect((await GET(request())).status).toBe(403);
  });

  it("does not swallow an unrelated failure", async () => {
    failsWith(new TypeError("something else entirely"));

    await expect(GET(request())).rejects.toThrow("something else entirely");
  });
});
