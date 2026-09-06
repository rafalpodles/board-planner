import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("mcp-handler", () => ({ metadataCorsOptionsRequestHandler: () => () => new Response(null) }));

let headerStore = new Headers();
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(headerStore) }));

const { GET } = await import("./route");

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PUBLIC_ORIGIN;
  headerStore = new Headers();
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("builds every endpoint from the configured origin", async () => {
    process.env.APP_ORIGIN = "https://board.example.com";

    const body = await (await GET()).json();

    expect(body.issuer).toBe("https://board.example.com");
    expect(body.token_endpoint).toBe("https://board.example.com/oauth/token");
    expect(body.authorization_endpoint).toBe("https://board.example.com/oauth/authorize");
  });

  it("emits the same endpoints while a forged host header is in scope", async () => {
    process.env.APP_ORIGIN = "https://board.example.com";
    headerStore = new Headers({ "x-forwarded-host": "evil.example", host: "evil.example" });

    const body = await (await GET()).json();

    expect(body.issuer).toBe("https://board.example.com");
    expect(JSON.stringify(body)).not.toContain("evil.example");
  });

  it("fails closed when no origin is configured", async () => {
    const res = await GET();

    expect(res.status).toBe(500);
  });
});
