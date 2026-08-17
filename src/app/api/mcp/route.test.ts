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
  function databaseIsDown() {
    connectDB.mockImplementation(async () => {
      throw new DatabaseUnavailableError(new Error("connect ECONNREFUSED"));
    });
  }

  // withMcpAuth's catch-all turns any throw from verifyToken into `invalid_token`, and a client that
  // reads that discards a perfectly good OAuth token and walks the whole flow again for another one
  // that fails the same way — so this has to be answered before it gets there (BP-362)
  it("answers 503 rather than letting it read as invalid_token", async () => {
    databaseIsDown();

    const response = await POST(request({ authorization: "Bearer cpat_x" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("temporarily_unavailable");
    expect(JSON.stringify(body)).not.toContain("invalid_token");
    expect(response.headers.get("Retry-After")).toBe("5");
  });

  it("says the credential was not the problem", async () => {
    databaseIsDown();

    const body = await (await POST(request({ authorization: "Bearer cpat_x" }))).json();

    expect(body.error_description).toMatch(/credential was not the problem/i);
  });

  it("never reaches the tools", async () => {
    databaseIsDown();

    const body = await (await POST(request({ authorization: "Bearer cpat_x" }))).json();

    expect(body.auth).toBeUndefined();
    expect(getAuthUser).not.toHaveBeenCalled();
  });

  it("still answers 401 to a missing credential while the database is up", async () => {
    const response = await POST(request());

    expect(response.status).toBe(401);
  });
});
