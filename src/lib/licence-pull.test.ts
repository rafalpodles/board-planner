import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const m = vi.hoisted(() => ({ storeOrganisationLicence: vi.fn(), counts: vi.fn(), row: { _id: { toHexString: () => "0123456789abcdef01234567" }, name: "Acme", slug: "acme" } }));
const { storeOrganisationLicence } = m;
vi.mock("./organisation-licence", () => ({ storeOrganisationLicence: m.storeOrganisationLicence }));
vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("./member-limit", () => ({ memberCounts: m.counts }));
vi.mock("./organisation-jobs", () => ({ forEachServedOrganisation: async (_label: string, each: (db: { organisation: unknown }) => Promise<void>) => each({ organisation: m.row._id }) }));
vi.mock("@/models/organisation", () => ({ Organisation: { findById: () => ({ select: () => ({ lean: async () => m.row }) }) } }));

const { licencePullConfig, licencePullTickMs, pullEveryLicence, pullLicence, pullNewOrganisationLicence, LICENCE_PULL_PATH } = await import("./licence-pull");
const { platformSigningString, PLATFORM_HEADERS } = await import("./platform-request");
const { createPublicKey, generateKeyPairSync, verify } = await import("node:crypto");

const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
const KEY = { keyId: "pull-1", d: jwk.d!, x: jwk.x! };
const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

describe("licencePullConfig (BP-897)", () => {
  it("is off when neither is set, and refuses one without the other", () => {
    expect(licencePullConfig(env({}))).toBeNull();
    expect(() => licencePullConfig(env({ LICENCE_SERVICE_URL: "https://licence.example" }))).toThrow(/go together/);
    expect(() => licencePullConfig(env({ LICENCE_PULL_KEY: JSON.stringify(KEY) }))).toThrow(/go together/);
  });

  it.each(["http://licence.example", "https://licence.example/api", "https://user:pw@licence.example", "not a url"])("refuses the address %s", (url) => {
    expect(() => licencePullConfig(env({ LICENCE_SERVICE_URL: url, LICENCE_PULL_KEY: JSON.stringify(KEY) }))).toThrow(/LICENCE_SERVICE_URL/);
  });

  it.each(["{", JSON.stringify({ keyId: "k", d: "a b", x: "c" }), JSON.stringify({ d: "a", x: "b" })])("refuses the key %s", (key) => {
    expect(() => licencePullConfig(env({ LICENCE_SERVICE_URL: "https://licence.example", LICENCE_PULL_KEY: key }))).toThrow(/LICENCE_PULL_KEY/);
  });

  it("refuses a key whose halves do not belong together", () => {
    const other = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const mismatched = JSON.stringify({ keyId: "k", d: KEY.d, x: other.x });
    expect(() => licencePullConfig(env({ LICENCE_SERVICE_URL: "https://licence.example", LICENCE_PULL_KEY: mismatched }))).toThrow(/LICENCE_PULL_KEY/);
  });

  it("refuses localhost over plain http, which need not be this machine", () => {
    expect(() => licencePullConfig(env({ LICENCE_SERVICE_URL: "http://localhost:4000", LICENCE_PULL_KEY: JSON.stringify(KEY) }))).toThrow(/https/);
  });

  it("takes https, and plain http to loopback only", () => {
    expect(licencePullConfig(env({ LICENCE_SERVICE_URL: "https://licence.example", LICENCE_PULL_KEY: JSON.stringify(KEY) }))?.url.host).toBe("licence.example");
    expect(licencePullConfig(env({ LICENCE_SERVICE_URL: "http://127.0.0.1:4000", LICENCE_PULL_KEY: JSON.stringify(KEY) }))?.url.port).toBe("4000");
  });
});

describe("pullLicence (BP-897)", () => {
  const config = { url: new URL("https://licence.example"), key: KEY };
  const organisation = { _id: new Types.ObjectId(), name: "Acme", slug: "acme" };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    storeOrganisationLicence.mockResolvedValue({ status: "stored", plan: "pro", expiresAt: "2027-01-01" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the people count when it has one, so the licence service can put the members right, and says nothing of it when it has not", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ licenceKey: "key-1" }), { status: 200 }));

    await pullLicence(config, organisation, undefined, 14);
    await pullLicence(config, organisation);

    expect(JSON.parse(Buffer.from(fetchMock.mock.calls[0][1].body).toString())).toMatchObject({ members: 14 });
    expect(JSON.parse(Buffer.from(fetchMock.mock.calls[1][1].body).toString())).not.toHaveProperty("members");
  });

  it("asks for this organisation, signed over the service's host and path, and stores what comes back", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ licenceKey: "key-1" }), { status: 200 }));

    expect(await pullLicence(config, organisation)).toEqual({ status: "stored", plan: "pro", expiresAt: "2027-01-01" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://licence.example${LICENCE_PULL_PATH}`);
    expect(init.redirect).toBe("error");
    const body = Buffer.from(init.body);
    expect(JSON.parse(body.toString())).toEqual({ organisation: organisation._id.toHexString(), name: "Acme", slug: "acme" });
    const h = init.headers;
    const signing = platformSigningString("POST", "licence.example", LICENCE_PULL_PATH, h[PLATFORM_HEADERS.timestamp], h[PLATFORM_HEADERS.nonce], body);
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: KEY.x }, format: "jwk" });
    expect(verify(null, Buffer.from(signing), publicKey, Buffer.from(h[PLATFORM_HEADERS.signature], "base64url"))).toBe(true);
    expect(storeOrganisationLicence).toHaveBeenCalledWith(organisation._id.toHexString(), "key-1", "pull:pull-1");
  });

  it("stores nothing when the service has no key, refuses, or cannot be reached", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ licenceKey: null }), { status: 200 }));
    expect(await pullLicence(config, organisation)).toEqual({ status: "none" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    expect(await pullLicence(config, organisation)).toEqual({ status: "refused", httpStatus: 401 });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await pullLicence(config, organisation)).toEqual({ status: "unreachable" });
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(70_000), { status: 200 }));
    expect(await pullLicence(config, organisation)).toEqual({ status: "oversized" });
    expect(storeOrganisationLicence).not.toHaveBeenCalled();
  });
});

describe("licencePullTickMs (BP-897)", () => {
  it("is a day when unset or empty, off at 0, at least a minute, and never past what a timer can hold", () => {
    expect(licencePullTickMs(undefined)).toBe(24 * 60 * 60 * 1000);
    expect(licencePullTickMs("")).toBe(24 * 60 * 60 * 1000);
    expect(licencePullTickMs("0")).toBe(0);
    expect(licencePullTickMs("5")).toBe(60_000);
    expect(licencePullTickMs("3000000000")).toBe(2_147_483_647);
  });

  it("falls back to a day for a value that is not a number, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(licencePullTickMs("abc")).toBe(24 * 60 * 60 * 1000);
    expect(licencePullTickMs("-5")).toBe(24 * 60 * 60 * 1000);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("pullNewOrganisationLicence (BP-929)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does nothing, and asks nobody, on an instance with no licence service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("LICENCE_SERVICE_URL", "");
    vi.stubEnv("LICENCE_PULL_KEY", "");
    await expect(pullNewOrganisationLicence(new Types.ObjectId().toHexString())).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws into a sign-up, even on a half-set configuration", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("LICENCE_SERVICE_URL", "https://licence.example");
    vi.stubEnv("LICENCE_PULL_KEY", "");
    await expect(pullNewOrganisationLicence(new Types.ObjectId().toHexString())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("new organisation"), expect.stringContaining("go together"));
  });
});

// BP-982: two bounds the sign-up and the daily ask depend on
describe("what the daily ask and the sign-up ask put up with", () => {
  const config = { url: new URL("https://licence.example"), key: KEY };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is still sent, without the count, when the people cannot be counted: not being able to count must not cost an organisation its licence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ licenceKey: "key-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    m.counts.mockRejectedValue(new Error("database busy"));
    storeOrganisationLicence.mockResolvedValue({ status: "stored", plan: "pro", expiresAt: "2027-01-01" });

    await pullEveryLicence(config);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(Buffer.from(fetchMock.mock.calls[0][1].body).toString())).not.toHaveProperty("members");
    expect(storeOrganisationLicence).toHaveBeenCalledWith("0123456789abcdef01234567", "key-1", expect.any(String));
  });

  it("gives a licence service four seconds at sign-up, so one that hangs cannot hold a new organisation's first page", async () => {
    vi.stubEnv("LICENCE_SERVICE_URL", "https://licence.example");
    vi.stubEnv("LICENCE_PULL_KEY", JSON.stringify(KEY));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await pullNewOrganisationLicence("0123456789abcdef01234567");

    expect(timeout).toHaveBeenCalledWith(4_000);
  });
});
