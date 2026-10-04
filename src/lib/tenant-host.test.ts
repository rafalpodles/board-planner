import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const findOne = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/tenant", () => ({ Tenant: { findOne, findById } }));

const { assertTenantDomainConfig, classifyHost, tenantOfRequest, forgetTenantSlugs, tenantOrigin } = await import("./tenant-host");
const { scopedForRequest } = await import("./db-scope");
const { DEFAULT_TENANT_ID } = await import("./tenant-field");

const ACME = new Types.ObjectId("0000000000000000000000a1");
const UNNAMED = new Types.ObjectId("0000000000000000000000a2");
const RESERVED = new Types.ObjectId("0000000000000000000000a3");
const SLUGS: Record<string, string | undefined> = { [ACME.toHexString()]: "acme", [RESERVED.toHexString()]: "www" };
const on = (host: string) => new Request("https://whatever/api/x", { headers: { host } });

beforeEach(() => {
  forgetTenantSlugs();
  findOne.mockReset().mockImplementation((filter: { slug: string }) => ({
    select: () => ({ lean: async () => (filter.slug === "acme" ? { _id: ACME } : null) }),
  }));
  findById.mockReset().mockImplementation((id: Types.ObjectId) => ({
    select: () => ({ lean: async () => ({ _id: id, slug: SLUGS[id.toHexString()] }) }),
  }));
});

afterEach(() => {
  delete process.env.TENANT_DOMAIN;
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.APP_ORIGIN;
});

describe("TENANT_DOMAIN unset: one tenant, as before (BP-666)", () => {
  it("puts every request in the default tenant without reading anything, whatever the host", async () => {
    for (const host of ["app.board-planner.com", "evil.example", ""]) {
      expect(await tenantOfRequest(on(host))).toEqual({ kind: "tenant", tenant: DEFAULT_TENANT_ID });
    }
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("TENANT_DOMAIN set: the host names the tenant", () => {
  beforeEach(() => {
    process.env.TENANT_DOMAIN = "Board-Planner.com";
  });

  it("finds the tenant whose slug is the host's first label", async () => {
    expect(await tenantOfRequest(on("acme.board-planner.com"))).toEqual({ kind: "tenant", tenant: ACME });
    expect(await tenantOfRequest(on("ACME.Board-Planner.com:443"))).toEqual({ kind: "tenant", tenant: ACME });
    expect(findOne).toHaveBeenCalledWith({ slug: "acme" });
  });

  it("names no tenant for a slug nobody has, another domain, a deeper host or a malformed label", async () => {
    for (const host of ["nobody.board-planner.com", "acme.example.com", "x.acme.board-planner.com", "-x-.board-planner.com", "ab.board-planner.com", "board-planner.com.evil.com", "acme-board-planner.com", "acmeboard-planner.com"]) {
      expect(await tenantOfRequest(on(host)), host).toEqual({ kind: "none" });
    }
  });

  it("treats the bare domain and reserved names as the platform, never as a tenant", async () => {
    for (const host of ["board-planner.com", "app.board-planner.com", "login.board-planner.com", "www.board-planner.com"]) {
      expect(await tenantOfRequest(on(host)), host).toEqual({ kind: "platform" });
    }
    expect(findOne).not.toHaveBeenCalled();
  });

  it("remembers a slug briefly, so a page's requests do not each read the tenant", async () => {
    await tenantOfRequest(on("acme.board-planner.com"));
    await tenantOfRequest(on("acme.board-planner.com"));
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it("hands a request on a tenant's host that tenant's db, and nothing anywhere else", async () => {
    expect((await scopedForRequest(on("acme.board-planner.com")))?.tenant.equals(ACME)).toBe(true);
    expect(await scopedForRequest(on("nobody.board-planner.com"))).toBeNull();
    expect(await scopedForRequest(on("app.board-planner.com"))).toBeNull();
  });
});

describe("classifyHost", () => {
  it("ignores the port and a trailing dot", () => {
    expect(classifyHost("acme.board.test:3000", "board.test")).toEqual({ kind: "tenant", slug: "acme" });
    expect(classifyHost("acme.board.test.", "board.test")).toEqual({ kind: "tenant", slug: "acme" });
  });
});

describe("assertTenantDomainConfig", () => {
  it("accepts no value and a bare domain", () => {
    expect(() => assertTenantDomainConfig()).not.toThrow();
    process.env.TENANT_DOMAIN = "board-planner.com";
    expect(() => assertTenantDomainConfig()).not.toThrow();
  });

  it("refuses a scheme, a port, a path or a wildcard", () => {
    for (const value of ["https://board-planner.com", "board-planner.com:443", "board-planner.com/x", "*.board-planner.com"]) {
      process.env.TENANT_DOMAIN = value;
      expect(() => assertTenantDomainConfig(), value).toThrow(/TENANT_DOMAIN/);
    }
  });
});

describe("tenantOrigin: the address a link to a tenant is built on", () => {
  it("is this instance's configured origin while TENANT_DOMAIN is unset, read from no tenant", async () => {
    process.env.PUBLIC_ORIGIN = "https://board.example.com";

    expect(await tenantOrigin(ACME)).toBe("https://board.example.com");
    expect(await tenantOrigin(DEFAULT_TENANT_ID)).toBe("https://board.example.com");
    expect(findById).not.toHaveBeenCalled();
  });

  it("is null while TENANT_DOMAIN is unset and no origin is configured", async () => {
    expect(await tenantOrigin(DEFAULT_TENANT_ID)).toBeNull();
  });

  describe("with TENANT_DOMAIN set", () => {
    beforeEach(() => {
      process.env.TENANT_DOMAIN = "Board-Planner.com";
      process.env.PUBLIC_ORIGIN = "https://app.board-planner.com";
    });

    it("is the tenant's own subdomain, from its record, never the configured origin", async () => {
      expect(await tenantOrigin(ACME)).toBe("https://acme.board-planner.com");
      expect(findById).toHaveBeenCalledWith(ACME);
    });

    it("takes the tenant alone, so no request can name the address", () => {
      expect(tenantOrigin.length).toBe(1);
    });

    it("remembers the slug briefly, and forgets it with the other slugs", async () => {
      await tenantOrigin(ACME);
      await tenantOrigin(ACME);
      expect(findById).toHaveBeenCalledTimes(1);

      forgetTenantSlugs();
      await tenantOrigin(ACME);
      expect(findById).toHaveBeenCalledTimes(2);
    });

    it("is null for a tenant with no slug, or one whose slug would not route back to it", async () => {
      expect(await tenantOrigin(UNNAMED)).toBeNull();
      expect(await tenantOrigin(RESERVED)).toBeNull();
    });
  });
});
