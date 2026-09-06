import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectDB = vi.fn();
const getAuthUser = vi.fn();

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  connectDB,
}));
vi.mock("@/models/session", () => ({ Session: {} }));
vi.mock("@/lib/auth", () => ({
  getAuthUser,
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/mcp/tools", () => ({ registerPlannerTools: vi.fn() }));
vi.mock("mcp-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mcp-handler")>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMcpHandler: () => (req: any) => Response.json({ auth: req.auth ?? null }),
  };
});

const { POST } = await import("./route");
const { DatabaseUnavailableError } = await import("@/lib/db");

const ORIGINAL = { ...process.env };

function request(headers: Record<string, string> = {}) {
  return new Request("https://board.example.com/api/mcp", { method: "POST", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://board.example.com";
  connectDB.mockResolvedValue(undefined);
  getAuthUser.mockResolvedValue({ username: "rpo" });
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("POST /api/mcp", () => {
  const forged = { "x-forwarded-host": "evil.example", forwarded: "host=evil.example" };

  it("gives the tools a base URL from configuration, not from the request", async () => {
    const body = await (
      await POST(request({ ...forged, authorization: "Bearer cpat_x" }))
    ).json();

    expect(body.auth.extra.baseUrl).toBe("https://board.example.com");
  });

  it("points the discovery hint in its 401 at the configured origin", async () => {
    const res = await POST(request(forged));

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://board.example.com/.well-known/oauth-protected-resource"'
    );
    expect(res.headers.get("www-authenticate")).not.toContain("evil.example");
  });

  it("refuses a bearer that resolves to nobody", async () => {
    getAuthUser.mockResolvedValue(null);

    expect((await POST(request({ authorization: "Bearer cpat_x" }))).status).toBe(401);
  });

  it("says the origin is unconfigured instead of blaming the client's token", async () => {
    delete process.env.PUBLIC_ORIGIN;

    const res = await POST(request({ ...forged, authorization: "Bearer cpat_x" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error_description).toMatch(/PUBLIC_ORIGIN/);
    expect(JSON.stringify(body)).not.toContain("evil.example");
  });
});

describe("POST /api/mcp when the database is unreachable", () => {
  function failsWith(error: unknown) {
    getAuthUser.mockImplementation(async () => {
      throw error;
    });
  }

  function driverError(name: string, message = "connect ECONNREFUSED 127.0.0.1:27017"): Error {
    const error = new Error(message);
    error.name = name;
    return error;
  }

  it("answers 503, not invalid_token, when the query fails mid-request", async () => {
    failsWith(driverError("MongoServerSelectionError"));

    const response = await POST(request({ authorization: "Bearer cpat_x" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("temporarily_unavailable");
    expect(JSON.stringify(body)).not.toContain("invalid_token");
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("answers 503 for a connection that could not be established either", async () => {
    const { DatabaseUnavailableError } = await import("@/lib/db");
    failsWith(new DatabaseUnavailableError(driverError("MongooseServerSelectionError")));

    expect((await POST(request({ authorization: "Bearer cpat_x" }))).status).toBe(503);
  });

  it("answers 503 for a query that timed out against the command buffer", async () => {
    failsWith(
      driverError("MongooseError", "Operation `sessions.findOne()` buffering timed out after 10000ms")
    );

    expect((await POST(request({ authorization: "Bearer cpat_x" }))).status).toBe(503);
  });

  it("says the credential was not the problem", async () => {
    failsWith(driverError("MongoNetworkError"));

    const body = await (await POST(request({ authorization: "Bearer cpat_x" }))).json();

    expect(body.error_description).toMatch(/credential was not the problem/i);
  });

  it("still answers 401 to a missing credential, and asks the database nothing", async () => {
    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(getAuthUser).not.toHaveBeenCalled();
  });

  it("still answers 401 to a credential that genuinely resolved to nobody", async () => {
    getAuthUser.mockImplementation(async () => null);

    expect((await POST(request({ authorization: "Bearer cpat_x" }))).status).toBe(401);
  });

  it("does not dress an unrelated failure up as an outage", async () => {
    failsWith(new TypeError("something else entirely"));

    const response = await POST(request({ authorization: "Bearer cpat_x" }));

    expect(response.status).not.toBe(503);
  });

  it("still serves a healthy request", async () => {
    const body = await (await POST(request({ authorization: "Bearer cpat_x" }))).json();

    expect(body.auth.clientId).toBe("rpo");
  });
});
