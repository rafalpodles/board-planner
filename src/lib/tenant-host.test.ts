import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const findOne = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/tenant", () => ({ Tenant: { findOne } }));

const { assertTenantDomainConfig, classifyHost, tenantOfRequest, forgetTenantSlugs } = await import("./tenant-host");
const { scopedForRequest } = await import("./db-scope");
const { DEFAULT_TENANT_ID } = await import("./tenant-field");

const ACME = new Types.ObjectId("0000000000000000000000a1");
const on = (host: string) => new Request("https://whatever/api/x", { headers: { host } });

beforeEach(() => {
  forgetTenantSlugs();
  findOne.mockReset().mockImplementation((filter: { slug: string }) => ({
    select: () => ({ lean: async () => (filter.slug === "acme" ? { _id: ACME } : null) }),
  }));
});

afterEach(() => {
  delete process.env.TENANT_DOMAIN;
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
    for (const host of ["nobody.board-planner.com", "acme.example.com", "x.acme.board-planner.com", "-x-.board-planner.com", "ab.board-planner.com", "board-planner.com.evil.com"]) {
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
