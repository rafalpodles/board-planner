import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const findOne = vi.hoisted(() => vi.fn());
const findById = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({ Organisation: { findOne, findById } }));

const { assertOrganisationDomainConfig, classifyHost, organisationOfRequest, forgetOrganisationSlugs, organisationOrigin, SLUG_CACHE_LIMIT } = await import("./organisation-host");
const { scopedForRequest } = await import("./db-scope");
const { DEFAULT_ORGANISATION_ID } = await import("./organisation-field");

const ACME = new Types.ObjectId("0000000000000000000000a1");
const UNNAMED = new Types.ObjectId("0000000000000000000000a2");
const RESERVED = new Types.ObjectId("0000000000000000000000a3");
const SLUGS: Record<string, string | undefined> = { [ACME.toHexString()]: "acme", [RESERVED.toHexString()]: "www" };
const on = (host: string) => new Request("https://whatever/api/x", { headers: { host } });

beforeEach(() => {
  forgetOrganisationSlugs();
  findOne.mockReset().mockImplementation((filter: { slug: string }) => ({
    select: () => ({ lean: async () => (filter.slug === "acme" ? { _id: ACME } : null) }),
  }));
  findById.mockReset().mockImplementation((id: Types.ObjectId) => ({
    select: () => ({ lean: async () => ({ _id: id, slug: SLUGS[id.toHexString()] }) }),
  }));
});

afterEach(() => {
  delete process.env.ORGANISATION_DOMAIN;
  delete process.env.PUBLIC_ORIGIN;
  delete process.env.APP_ORIGIN;
});

describe("ORGANISATION_DOMAIN unset: one organisation, as before (BP-666)", () => {
  it("puts every request in the default organisation without reading anything, whatever the host", async () => {
    for (const host of ["app.board-planner.com", "evil.example", ""]) {
      expect(await organisationOfRequest(on(host))).toEqual({ kind: "organisation", organisation: DEFAULT_ORGANISATION_ID });
    }
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("ORGANISATION_DOMAIN set: the host names the organisation", () => {
  beforeEach(() => {
    process.env.ORGANISATION_DOMAIN = "Board-Planner.com";
  });

  it("finds the organisation whose slug is the host's first label", async () => {
    expect(await organisationOfRequest(on("acme.board-planner.com"))).toEqual({ kind: "organisation", organisation: ACME });
    expect(await organisationOfRequest(on("ACME.Board-Planner.com:443"))).toEqual({ kind: "organisation", organisation: ACME });
    expect(findOne).toHaveBeenCalledWith({ slug: "acme" });
  });

  it("names no organisation for a slug nobody has, another domain, a deeper host or a malformed label", async () => {
    for (const host of ["nobody.board-planner.com", "acme.example.com", "x.acme.board-planner.com", "-x-.board-planner.com", "ab.board-planner.com", "board-planner.com.evil.com", "acme-board-planner.com", "acmeboard-planner.com"]) {
      expect(await organisationOfRequest(on(host)), host).toEqual({ kind: "none" });
    }
  });

  it("treats the bare domain and reserved names as the platform, never as an organisation", async () => {
    for (const host of ["board-planner.com", "app.board-planner.com", "login.board-planner.com", "www.board-planner.com"]) {
      expect(await organisationOfRequest(on(host)), host).toEqual({ kind: "platform" });
    }
    expect(findOne).not.toHaveBeenCalled();
  });

  it("refuses a punycode label, so no slug can impersonate another in another script", async () => {
    expect(await organisationOfRequest(on("xn--acme-1qa.board-planner.com"))).toEqual({ kind: "none" });
    expect(findOne).not.toHaveBeenCalled();
  });

  it("keeps at most SLUG_CACHE_LIMIT names, so random hosts cannot grow it without bound", async () => {
    for (let i = 0; i <= SLUG_CACHE_LIMIT; i++) await organisationOfRequest(on(`r${i}x.board-planner.com`));
    findOne.mockClear();

    await organisationOfRequest(on("r0x.board-planner.com"));
    await organisationOfRequest(on(`r${SLUG_CACHE_LIMIT}x.board-planner.com`));

    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findOne).toHaveBeenCalledWith({ slug: "r0x" });
  });

  it("remembers a slug briefly, so a page's requests do not each read the organisation", async () => {
    await organisationOfRequest(on("acme.board-planner.com"));
    await organisationOfRequest(on("acme.board-planner.com"));
    expect(findOne).toHaveBeenCalledTimes(1);
  });

  it("hands a request on an organisation's host that organisation's db, and nothing anywhere else", async () => {
    expect((await scopedForRequest(on("acme.board-planner.com")))?.organisation.equals(ACME)).toBe(true);
    expect(await scopedForRequest(on("nobody.board-planner.com"))).toBeNull();
    expect(await scopedForRequest(on("app.board-planner.com"))).toBeNull();
  });
});

describe("classifyHost", () => {
  it("ignores the port and a trailing dot", () => {
    expect(classifyHost("acme.board.test:3000", "board.test")).toEqual({ kind: "organisation", slug: "acme" });
    expect(classifyHost("acme.board.test.", "board.test")).toEqual({ kind: "organisation", slug: "acme" });
  });
});

describe("assertOrganisationDomainConfig", () => {
  it("accepts no value and a bare domain", () => {
    expect(() => assertOrganisationDomainConfig()).not.toThrow();
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    expect(() => assertOrganisationDomainConfig()).not.toThrow();
  });

  it("refuses a scheme, a port, a path or a wildcard", () => {
    for (const value of ["https://board-planner.com", "board-planner.com:443", "board-planner.com/x", "*.board-planner.com"]) {
      process.env.ORGANISATION_DOMAIN = value;
      expect(() => assertOrganisationDomainConfig(), value).toThrow(/ORGANISATION_DOMAIN/);
    }
  });
});

describe("organisationOrigin: the address a link to an organisation is built on", () => {
  it("is this instance's configured origin while ORGANISATION_DOMAIN is unset, read from no organisation", async () => {
    process.env.PUBLIC_ORIGIN = "https://board.example.com";

    expect(await organisationOrigin(ACME)).toBe("https://board.example.com");
    expect(await organisationOrigin(DEFAULT_ORGANISATION_ID)).toBe("https://board.example.com");
    expect(findById).not.toHaveBeenCalled();
  });

  it("is null while ORGANISATION_DOMAIN is unset and no origin is configured", async () => {
    expect(await organisationOrigin(DEFAULT_ORGANISATION_ID)).toBeNull();
  });

  describe("with ORGANISATION_DOMAIN set", () => {
    beforeEach(() => {
      process.env.ORGANISATION_DOMAIN = "Board-Planner.com";
      process.env.PUBLIC_ORIGIN = "https://app.board-planner.com";
    });

    it("is the organisation's own subdomain, from its record, never the configured origin", async () => {
      expect(await organisationOrigin(ACME)).toBe("https://acme.board-planner.com");
      expect(findById).toHaveBeenCalledWith(ACME);
    });

    it("takes the organisation alone, so no request can name the address", () => {
      expect(organisationOrigin.length).toBe(1);
    });

    it("remembers the slug briefly, and forgets it with the other slugs", async () => {
      await organisationOrigin(ACME);
      await organisationOrigin(ACME);
      expect(findById).toHaveBeenCalledTimes(1);

      forgetOrganisationSlugs();
      await organisationOrigin(ACME);
      expect(findById).toHaveBeenCalledTimes(2);
    });

    it("is null for an organisation with no slug, or one whose slug would not route back to it", async () => {
      expect(await organisationOrigin(UNNAMED)).toBeNull();
      expect(await organisationOrigin(RESERVED)).toBeNull();
    });
  });
});

describe("organisationOrigin on a platform served over another scheme or port (BP-670)", () => {
  afterEach(() => {
    delete process.env.ORGANISATION_DOMAIN;
    delete process.env.PUBLIC_ORIGIN;
  });

  it("keeps the platform's scheme and port, so a local or test deployment links to itself", async () => {
    process.env.ORGANISATION_DOMAIN = "organisations.localhost";
    process.env.PUBLIC_ORIGIN = "http://organisations.localhost:46625";
    forgetOrganisationSlugs();
    findById.mockReturnValue({ select: () => ({ lean: async () => ({ _id: ACME, slug: "acme" }) }) });

    expect(await organisationOrigin(ACME)).toBe("http://acme.organisations.localhost:46625");
  });

  it("uses https and no port when PUBLIC_ORIGIN is some other host", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    process.env.PUBLIC_ORIGIN = "http://elsewhere.example:8080";
    forgetOrganisationSlugs();
    findById.mockReturnValue({ select: () => ({ lean: async () => ({ _id: ACME, slug: "acme" }) }) });

    expect(await organisationOrigin(ACME)).toBe("https://acme.board-planner.com");
  });
});

