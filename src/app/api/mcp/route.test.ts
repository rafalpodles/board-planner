import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectDB = vi.fn();
const getAuthUser = vi.fn();

// The real module, so DatabaseUnavailableError is the class the route checks against
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
// Only the transport is stubbed. withMcpAuth stays real, because the thing under test is what it
// puts in the 401 and what it hands the handler — a mock of it would assert my own arrangement.
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

// BP-303 left `getPublicOrigin(req)` as a `??` fallback here, so a token holder sending
// X-Forwarded-Host had the server fetch that address and hand back the body. BP-316 removed it —
// and the review then showed the whole fix could be reverted with a green suite, because this
// route had no test at all.
describe("POST /api/mcp", () => {
  const forged = { "x-forwarded-host": "evil.example", forwarded: "host=evil.example" };

  it("gives the tools a base URL from configuration, not from the request", async () => {
    const body = await (
      await POST(request({ ...forged, authorization: "Bearer cpat_x" }))
    ).json();

    expect(body.auth.extra.baseUrl).toBe("https://board.example.com");
  });

  // This 401 is the first thing an MCP client sees and is what it follows to find the two
  // discovery documents, so a header-derived pointer routes around the documents themselves
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

  // withMcpAuth turns any throw out of verifyToken into `invalid_token`, which reads as an expired
  // credential; the message naming the variable to set never leaves the server log
  it("says the origin is unconfigured instead of blaming the client's token", async () => {
    delete process.env.PUBLIC_ORIGIN;

    const res = await POST(request({ ...forged, authorization: "Bearer cpat_x" }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error_description).toMatch(/PUBLIC_ORIGIN/);
    // Not "unconfigured, so fall back to what the caller says" — that was the shape of the bug
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

  // The shape a real restart takes. For the first seconds mongoose still reports the connection as
  // live, so nothing can be checked beforehand — the query inside verifyToken is what fails, and
  // withMcpAuth's catch-all called that `invalid_token`: a client then discards a working OAuth
  // token and walks the whole flow again for one that fails the same way (BP-362 review).
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

    // withMcpAuth owns whatever this is; what matters is that it is not reported as a 503
    expect(response.status).not.toBe(503);
  });

  it("still serves a healthy request", async () => {
    const body = await (await POST(request({ authorization: "Bearer cpat_x" }))).json();

    expect(body.auth.clientId).toBe("rpo");
  });
});
