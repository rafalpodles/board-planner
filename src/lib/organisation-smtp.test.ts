import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const getOrganisation = vi.fn();
const lookup = vi.fn();
const createTransport = vi.fn((options: unknown) => ({ options }));
let row: Record<string, unknown> | null = null;

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/organisation", () => ({ getOrganisation }));
vi.mock("node:dns/promises", () => ({ lookup, default: { lookup } }));
vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("@/models/settings", () => ({ Settings: { findOne: () => ({ lean: async () => row }) } }));

const { ownMailServerFor, ownMailTransport, forgetMailRoute, ownMailFrom } = await import("./organisation-smtp");
const { encryptSecret } = await import("./encryption");
const { BlockedDestinationError, UnresolvedDestinationError } = await import("./safe-fetch");

const ORGANISATION = new Types.ObjectId();
const SERVER = { host: "smtp.acme.example", port: 587, user: "mailer", password: "smtp-pass", fromAddress: "boards@acme.example", fromName: "Acme" };
const plan = (over: Record<string, unknown> = {}) => getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [], source: "service", ...over } });

beforeEach(() => {
  vi.clearAllMocks();
  forgetMailRoute();
  process.env.ENCRYPTION_KEY = "cd".repeat(32);
  process.env.ORGANISATION_DOMAIN = "board.example";
  row = { smtp: { ...SERVER, password: encryptSecret(SERVER.password, ORGANISATION) } };
  plan();
});
afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.ORGANISATION_DOMAIN;
});

describe("ownMailServerFor (BP-899)", () => {
  it("is the stored server, password opened, while the plan includes it", async () => {
    expect(await ownMailServerFor(ORGANISATION)).toEqual(SERVER);
  });

  it("is a trial's too", async () => {
    plan({ trial: true, expiresAt: new Date(Date.now() + 86_400_000) });

    expect(await ownMailServerFor(ORGANISATION)).toEqual(SERVER);
  });

  it("is nobody's once the plan no longer includes it, so mail goes through the platform's", async () => {
    plan({ plan: "free" });

    expect(await ownMailServerFor(ORGANISATION)).toBeNull();
  });

  it("is nobody's when the password cannot be read", async () => {
    row = { smtp: { ...SERVER, password: "enc:v3:garbage" } };

    expect(await ownMailServerFor(ORGANISATION)).toBeNull();
  });

  it("is nobody's when none is stored", async () => {
    row = null;

    expect(await ownMailServerFor(ORGANISATION)).toBeNull();
  });

  it("does not exist on a self-hosted instance, whatever is stored", async () => {
    delete process.env.ORGANISATION_DOMAIN;

    expect(await ownMailServerFor(ORGANISATION)).toBeNull();
    expect(getOrganisation).not.toHaveBeenCalled();
  });

  it("is read again after ten seconds, so a lapsed plan moves mail back to the platform's server in every process", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect(await ownMailServerFor(ORGANISATION)).toEqual(SERVER);
      plan({ plan: "free" });

      vi.advanceTimersByTime(9_000);
      expect(await ownMailServerFor(ORGANISATION)).toEqual(SERVER);
      vi.advanceTimersByTime(2_000);
      expect(await ownMailServerFor(ORGANISATION)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is read once for a burst of mail, and again once forgotten", async () => {
    await ownMailServerFor(ORGANISATION);
    await ownMailServerFor(ORGANISATION);
    expect(getOrganisation).toHaveBeenCalledTimes(1);

    row = null;
    forgetMailRoute(ORGANISATION);
    expect(await ownMailServerFor(ORGANISATION)).toBeNull();
  });
});

describe("ownMailTransport", () => {
  it("connects to the address the name was vetted at, and checks the certificate against the name", async () => {
    lookup.mockResolvedValue([{ address: "52.95.110.1", family: 4 }]);

    const transport = (await ownMailTransport(SERVER)) as unknown as { options: Record<string, unknown> };

    expect(transport.options).toMatchObject({ host: "52.95.110.1", servername: "smtp.acme.example", port: 587, requireTLS: true, auth: { user: "mailer", pass: "smtp-pass" } });
  });

  it.each([
    ["a name that resolves inward", "smtp.acme.example", [{ address: "10.0.0.5", family: 4 }]],
    ["a private address", "192.168.1.10", []],
    ["the metadata address", "169.254.169.254", []],
    ["an internal name", "mail.internal", []],
    ["localhost", "localhost", []],
    // The check would read 012 as 12; getaddrinfo reads it as octal 10, and so does this lookup's answer
    ["a leading-zero literal the resolver reads as octal", "012.0.0.5", [{ address: "10.0.0.5", family: 4 }]],
  ])("refuses %s and connects to nothing", async (_case, host, answer) => {
    lookup.mockResolvedValue(answer);

    await expect(ownMailTransport({ ...SERVER, host })).rejects.toBeInstanceOf(BlockedDestinationError);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("says a name that does not resolve is unresolved, not internal", async () => {
    lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND smtp.acme.exmaple"), { code: "ENOTFOUND" }));

    await expect(ownMailTransport({ ...SERVER, host: "smtp.acme.exmaple" })).rejects.toBeInstanceOf(UnresolvedDestinationError);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("takes a public address as it is, with no name to check a certificate against", async () => {
    const transport = (await ownMailTransport({ ...SERVER, host: "52.95.110.1" })) as unknown as { options: Record<string, unknown> };

    expect(transport.options.host).toBe("52.95.110.1");
    expect(transport.options).not.toHaveProperty("servername");
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("ownMailFrom", () => {
  it("names the sender only when a name was given", () => {
    expect(ownMailFrom(SERVER)).toEqual({ name: "Acme", address: "boards@acme.example" });
    expect(ownMailFrom({ ...SERVER, fromName: "" })).toBe("boards@acme.example");
  });
});
