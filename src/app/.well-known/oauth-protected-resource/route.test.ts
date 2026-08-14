import { describe, it, expect, beforeEach, afterEach } from "vitest";

const { GET } = await import("./route");

const ORIGINAL = { ...process.env };

function request(headers: Record<string, string> = {}) {
  return new Request("https://board.example.com/.well-known/oauth-protected-resource", { headers });
}

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PUBLIC_ORIGIN;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

// BP-316 moved authorization_servers to configuration and left `resource` derived from
// x-forwarded-host — on the one of the two documents that asks to be cached for an hour. MCP
// clients use that value as the RFC 8707 audience when they request a token.
describe("GET /.well-known/oauth-protected-resource", () => {
  it("names the configured origin as the resource, whatever host the request claims", async () => {
    process.env.APP_ORIGIN = "https://board.example.com";

    const body = await (await GET(request({ "x-forwarded-host": "evil.example" }))).json();

    expect(body.resource).toBe("https://board.example.com");
    expect(body.authorization_servers).toEqual(["https://board.example.com"]);
  });

  it("is not moved by a forwarded header on the authorization server either", async () => {
    process.env.APP_ORIGIN = "https://board.example.com";

    const res = await GET(
      request({ forwarded: "host=evil.example", "x-forwarded-host": "evil.example" })
    );

    expect(JSON.stringify(await res.json())).not.toContain("evil.example");
  });

  // The finding turned on this header: a poisoned entry is served to every client for the hour
  it("is still cacheable, which is why the body must not depend on the request", async () => {
    process.env.APP_ORIGIN = "https://board.example.com";

    const res = await GET(request());

    expect(res.headers.get("cache-control")).toMatch(/max-age/);
  });

  it("fails closed when no origin is configured", async () => {
    expect((await GET(request())).status).toBe(500);
  });

  // Without it a browser MCP client sees an opaque CORS error rather than the message that names
  // the variable — and the message is there for exactly that operator
  it("keeps the cross-origin header on the failure it added", async () => {
    const res = await GET(request());

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json()).error_description).toMatch(/PUBLIC_ORIGIN/);
  });
});
