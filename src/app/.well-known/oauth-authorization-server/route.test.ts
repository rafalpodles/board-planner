import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("mcp-handler", () => ({ metadataCorsOptionsRequestHandler: () => () => new Response(null) }));

const { GET } = await import("./route");

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

// BP-316: this document names the authorization and token endpoints an MCP client will trust. It
// carries no Cache-Control, so a forged x-forwarded-host stored by any shared cache would point
// other clients at somebody else's endpoints.
describe("GET /.well-known/oauth-authorization-server", () => {
  it("builds every endpoint from the configured origin", async () => {
    process.env.APP_ORIGIN = "https://board.example.com";

    const body = await (await GET()).json();

    expect(body.issuer).toBe("https://board.example.com");
    expect(body.token_endpoint).toBe("https://board.example.com/oauth/token");
    expect(body.authorization_endpoint).toBe("https://board.example.com/oauth/authorize");
  });

  it("takes no request, so no header can reach it", () => {
    expect(GET.length).toBe(0);
  });

  it("fails closed when no origin is configured", async () => {
    const res = await GET();

    expect(res.status).toBe(500);
  });
});
