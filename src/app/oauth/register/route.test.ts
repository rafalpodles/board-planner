import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const create = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

const countDocuments = vi.fn();
const find = vi.fn();
const deleteMany = vi.fn();
vi.mock("@/models/oauthClient", () => ({ OAuthClient: { create, countDocuments, find, deleteMany } }));
// Partial: `isValidRedirectUri` is the rule these tests are about, so it stays real.
vi.mock("@/lib/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/oauth")>()),
  newClientId: () => "cpc_generated",
}));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

function request(body: unknown, ip = "203.0.113.7") {
  return new Request("https://app.example.com/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetRateLimits();
  // X-Forwarded-For counts only where the operator says a proxy writes it (BP-318)
  process.env.TRUSTED_PROXY_HOPS = "1";
  create.mockResolvedValue({});
  countDocuments.mockResolvedValue(0);
});

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
});

describe("POST /oauth/register", () => {
  it("registers a client with an https redirect", async () => {
    const res = await POST(request({ redirect_uris: ["https://claude.ai/api/mcp/callback"] }));

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUris: ["https://claude.ai/api/mcp/callback"] })
    );
  });

  // BP-1030. Unused until a person approves it: the TTL reaps it and a flood evicts oldest first
  it("registers a client that expires unless somebody approves it", async () => {
    await POST(request({ redirect_uris: ["https://claude.ai/api/mcp/callback"] }));

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: expect.any(Date) }));
    expect(create.mock.calls[0][0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  // BP-1030. Past the ceiling with nothing old enough to drop, registration is refused rather than
  // evicting a client somebody may be approving right now
  it("refuses when a thousand clients are waiting and none is old enough to drop", async () => {
    countDocuments.mockResolvedValue(1000);
    find.mockReturnValue({ sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }) });

    const res = await POST(request({ redirect_uris: ["https://claude.ai/api/mcp/callback"] }));

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("900");
    expect(create).not.toHaveBeenCalled();
  });

  // RFC 8252 permits http only for loopback, which is what a local MCP client needs
  it.each([
    "http://127.0.0.1:6274/callback",
    "http://localhost:8080/callback",
    "http://[::1]:6274/callback",
  ])("accepts loopback http: %s", async (uri) => {
    const res = await POST(request({ redirect_uris: [uri] }));

    expect(res.status).toBe(201);
  });

  // BP-302: plain http to any host was accepted, so the authorization code travelled
  // in cleartext to a host the user never saw
  it.each([
    "http://attacker.example/callback",
    "http://127.0.0.1.attacker.example/callback",
    "http://192.168.1.10/callback",
  ])("refuses non-loopback http: %s", async (uri) => {
    const res = await POST(request({ redirect_uris: [uri] }));

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a redirect that is not a URL at all", async () => {
    const res = await POST(request({ redirect_uris: ["not a uri"] }));

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an unbounded list of redirects", async () => {
    const uris = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`);

    const res = await POST(request({ redirect_uris: uris }));

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("caps the free-text client name shown on the consent screen", async () => {
    const res = await POST(
      request({ redirect_uris: ["https://example.com/cb"], client_name: "x".repeat(500) })
    );

    expect(res.status).toBe(201);
    expect(create.mock.calls[0][0].clientName).toHaveLength(80);
  });

  // Unauthenticated and advertised publicly, so nothing else bounds how far the
  // client collection can be grown
  it("throttles registrations from one address", async () => {
    const body = { redirect_uris: ["https://example.com/cb"] };
    for (let i = 0; i < 10; i++) {
      expect((await POST(request(body))).status).toBe(201);
    }

    const res = await POST(request(body));

    expect(res.status).toBe(429);
    expect(create).toHaveBeenCalledTimes(10);
  });

  it("throttles per address, not globally", async () => {
    const body = { redirect_uris: ["https://example.com/cb"] };
    for (let i = 0; i < 11; i++) await POST(request(body, "203.0.113.7"));

    const res = await POST(request(body, "203.0.113.8"));

    expect(res.status).toBe(201);
  });

  // With no proxy configured there is no address, and a bucket every caller shared would let one of
  // them close registration for the whole instance — and with it the documented MCP onboarding
  // (BP-318 review). A bigger shared bucket only moved the lever: 400 is past the 200 it held (BP-1030)
  it("does not let one anonymous caller close registration for everybody", async () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    const body = { redirect_uris: ["https://example.com/cb"] };

    for (let i = 0; i < 400; i++) await POST(request(body, "203.0.113.7"));

    expect((await POST(request(body, "198.51.100.4"))).status).toBe(201);
  });

  // A rejected registration still costs the collection nothing, but it must still count:
  // otherwise the throttle is skipped by sending a body that fails validation
  it("counts a refused registration against the throttle", async () => {
    const bad = { redirect_uris: ["http://attacker.example/cb"] };
    for (let i = 0; i < 10; i++) await POST(request(bad));

    const res = await POST(request({ redirect_uris: ["https://example.com/cb"] }));

    expect(res.status).toBe(429);
  });
});
