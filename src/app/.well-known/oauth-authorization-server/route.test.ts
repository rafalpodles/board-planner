import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Types } from "mongoose";

vi.mock("mcp-handler", () => ({ metadataCorsOptionsRequestHandler: () => () => new Response(null) }));

// The zero-arity handler could still reach a forged header this way, which is why the signature
// assertion it used to carry proved nothing
let headerStore = new Headers();
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(headerStore) }));

const tenantFindOne = vi.fn();
const tenantFindById = vi.fn();
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/tenant", () => ({ Tenant: { findOne: tenantFindOne, findById: tenantFindById } }));

const { GET } = await import("./route");
const { forgetTenantSlugs } = await import("@/lib/tenant-host");

const ACME = new Types.ObjectId();
const on = (host = "board.example.com") => new Request(`https://${host}/.well-known/oauth-authorization-server`, { headers: { host } });

const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.TENANT_DOMAIN;
  headerStore = new Headers();
  forgetTenantSlugs();
  tenantFindOne.mockImplementation((filter: { slug: string }) => ({
    select: () => ({ lean: async () => (filter.slug === "acme" ? { _id: ACME } : null) }),
  }));
  tenantFindById.mockImplementation((id: Types.ObjectId) => ({
    select: () => ({ lean: async () => (id.equals(ACME) ? { _id: ACME, slug: "acme" } : null) }),
  }));
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

    const body = await (await GET(on())).json();

    expect(body.issuer).toBe("https://board.example.com");
    expect(body.token_endpoint).toBe("https://board.example.com/oauth/token");
    expect(body.authorization_endpoint).toBe("https://board.example.com/oauth/authorize");
  });

  // Was `expect(GET.length).toBe(0)` — an assertion about the signature, which a rewrite reading
  // headers() from next/headers keeps green while restoring the vulnerability (BP-316 review)
  it("emits the same endpoints while a forged host header is in scope", async () => {
    process.env.APP_ORIGIN = "https://board.example.com";
    headerStore = new Headers({ "x-forwarded-host": "evil.example", host: "evil.example" });

    const body = await (await GET(on())).json();

    expect(body.issuer).toBe("https://board.example.com");
    expect(JSON.stringify(body)).not.toContain("evil.example");
  });

  it("fails closed when no origin is configured", async () => {
    const res = await GET(on());

    expect(res.status).toBe(500);
  });
});

describe("GET /.well-known/oauth-authorization-server with TENANT_DOMAIN set (BP-666)", () => {
  beforeEach(() => {
    process.env.TENANT_DOMAIN = "board-planner.com";
    process.env.PUBLIC_ORIGIN = "https://app.board-planner.com";
  });

  it("names the tenant's own endpoints on the tenant's host", async () => {
    const body = await (await GET(on("acme.board-planner.com"))).json();

    expect(body.issuer).toBe("https://acme.board-planner.com");
    expect(body.token_endpoint).toBe("https://acme.board-planner.com/oauth/token");
  });

  it("answers 404 on a host that names no tenant, and on the platform host", async () => {
    expect((await GET(on("nobody.board-planner.com"))).status).toBe(404);
    expect((await GET(on("app.board-planner.com"))).status).toBe(404);
  });
});
