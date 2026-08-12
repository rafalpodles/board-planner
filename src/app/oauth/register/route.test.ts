import { describe, it, expect, vi, beforeEach } from "vitest";

const create = vi.fn();

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/oauthClient", () => ({ OAuthClient: { create } }));
vi.mock("@/lib/oauth", () => ({ newClientId: () => "cpc_generated" }));

const { POST } = await import("./route");
const { resetRateLimits } = await import("@/lib/rate-limit");

function request(body: unknown, ip = "203.0.113.7") {
  return new Request("https://app.example.com/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  create.mockResolvedValue({});
});

describe("POST /oauth/register", () => {
  it("registers a client with an https redirect", async () => {
    const res = await POST(request({ redirect_uris: ["https://claude.ai/api/mcp/callback"] }));

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUris: ["https://claude.ai/api/mcp/callback"] })
    );
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

  // A rejected registration still costs the collection nothing, but it must still count:
  // otherwise the throttle is skipped by sending a body that fails validation
  it("counts a refused registration against the throttle", async () => {
    const bad = { redirect_uris: ["http://attacker.example/cb"] };
    for (let i = 0; i < 10; i++) await POST(request(bad));

    const res = await POST(request({ redirect_uris: ["https://example.com/cb"] }));

    expect(res.status).toBe(429);
  });
});
