import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Types } from "mongoose";

const { connectDB, findOneAndUpdate, findById, updateOne } = vi.hoisted(() => ({
  connectDB: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findById: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB }));
vi.mock("@/models/organisation", () => ({ Organisation: { findOneAndUpdate, findById, updateOne } }));

const { getOrganisation, licenceOf, checkOrganisationName, nameOrganisation, renameOrganisation, organisationIsNamed, ORGANISATION_NAME_MAX } = await import("./organisation");
const { DEFAULT_ORGANISATION_ID } = await import("./organisation-field");
const { signLicence } = await import("./licence");

const OTHER = new Types.ObjectId("0000000000000000000000b2");
const FREE = { plan: "free", features: [], source: "none" };
const resolves = (value: unknown) => ({ lean: () => Promise.resolve(value) });

const ORIGINAL = { ...process.env };
const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
const signing = { keyId: "e2e", d: jwk.d!, x: jwk.x! };
const DAY = 24 * 60 * 60 * 1000;

function key({ expiresAt = new Date(Date.now() + 30 * DAY), organisation }: { expiresAt?: Date; organisation?: string } = {}) {
  return signLicence(
    { customer: "Acme Ltd", plan: "pro", features: [], issuedAt: new Date().toISOString(), expiresAt: expiresAt.toISOString(), organisation },
    signing
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The suite's own key, accepted outside a production build — the same door e2e uses
  process.env.E2E = "1";
  process.env.E2E_LICENCE_PUBLIC_KEY = signing.x;
  delete process.env.LICENCE_KEY;
  delete process.env.ORGANISATION_DOMAIN;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("getOrganisation", () => {
  it("reads the default organisation by its own id, creating it free on first read", async () => {
    findOneAndUpdate.mockReturnValue(resolves({ _id: DEFAULT_ORGANISATION_ID, entitlements: FREE }));

    const organisation = await getOrganisation(DEFAULT_ORGANISATION_ID);

    expect(connectDB).toHaveBeenCalled();
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: DEFAULT_ORGANISATION_ID },
      { $setOnInsert: { entitlements: FREE } },
      { upsert: true, returnDocument: "after" }
    );
    expect(organisation.entitlements).toEqual(FREE);
  });

  it("reads any other organisation by its id and never creates one", async () => {
    findById.mockReturnValue(resolves({ _id: OTHER, name: "Globex", entitlements: FREE }));

    expect((await getOrganisation(OTHER)).name).toBe("Globex");
    expect(findById).toHaveBeenCalledWith(String(OTHER));
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("answers free for an organisation with no row", async () => {
    findById.mockReturnValue(resolves(null));

    expect((await getOrganisation(OTHER)).entitlements).toEqual(FREE);
  });
});

describe("the default organisation's first write (BP-995)", () => {
  const duplicateOn = (field: string) => Object.assign(new Error("E11000"), { code: 11000, keyPattern: { [field]: 1 } });
  const rejects = (err: unknown) => ({ lean: () => Promise.reject(err) });

  it("retries once when a concurrent first read inserted the row first, and answers with that row", async () => {
    findOneAndUpdate
      .mockReturnValueOnce(rejects(duplicateOn("_id")))
      .mockReturnValueOnce(resolves({ _id: DEFAULT_ORGANISATION_ID, entitlements: FREE }));

    const row = await getOrganisation(DEFAULT_ORGANISATION_ID);

    expect(row.entitlements).toMatchObject(FREE);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("retries a rename the same way, keeping the name it was asked for", async () => {
    findOneAndUpdate.mockReturnValueOnce(rejects(duplicateOn("_id"))).mockReturnValueOnce(resolves({}));

    await renameOrganisation(DEFAULT_ORGANISATION_ID, "Acme");

    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(findOneAndUpdate.mock.calls[1][1]).toMatchObject({ $set: { name: "Acme" } });
  });

  it("does not retry a failure that is not a collision on the row's id", async () => {
    findOneAndUpdate.mockReturnValueOnce(rejects(duplicateOn("slug")));

    await expect(getOrganisation(DEFAULT_ORGANISATION_ID)).rejects.toThrow("E11000");
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("gives up after the one retry rather than looping", async () => {
    findOneAndUpdate.mockReturnValue(rejects(duplicateOn("_id")));

    await expect(getOrganisation(DEFAULT_ORGANISATION_ID)).rejects.toThrow("E11000");
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("getOrganisation on a single-organisation instance: LICENCE_KEY", () => {
  const stored = { _id: DEFAULT_ORGANISATION_ID, entitlements: FREE };
  beforeEach(() => findOneAndUpdate.mockReturnValue(resolves(stored)));

  it("derives pro from a valid key without writing it to the stored organisation", async () => {
    const expiresAt = new Date(Date.now() + 30 * DAY);
    process.env.LICENCE_KEY = key({ expiresAt });

    const organisation = await getOrganisation(DEFAULT_ORGANISATION_ID);

    expect(organisation.entitlements).toMatchObject({ plan: "pro", customer: "Acme Ltd", expiresAt, source: "env" });
    expect(findOneAndUpdate.mock.calls[0][1]).toEqual({ $setOnInsert: { entitlements: FREE } });
  });

  it("reports free for a key past its grace period", async () => {
    process.env.LICENCE_KEY = key({ expiresAt: new Date(Date.now() - 15 * DAY) });

    expect((await getOrganisation(DEFAULT_ORGANISATION_ID)).entitlements).toEqual({ plan: "free", features: [], source: "env" });
  });

  it("leaves the stored entitlements for a key that does not verify", async () => {
    process.env.LICENCE_KEY = "garbage";

    expect((await getOrganisation(DEFAULT_ORGANISATION_ID)).entitlements).toEqual(FREE);
  });

  it("refuses a key issued for another organisation", async () => {
    process.env.LICENCE_KEY = key({ organisation: OTHER.toHexString() });

    expect((await getOrganisation(DEFAULT_ORGANISATION_ID)).entitlements).toEqual(FREE);
  });

  it("refuses even a key naming this organisation: the default one has the same id on every instance", async () => {
    process.env.LICENCE_KEY = key({ organisation: DEFAULT_ORGANISATION_ID.toHexString() });

    expect((await getOrganisation(DEFAULT_ORGANISATION_ID)).entitlements).toEqual(FREE);
  });
});

describe("getOrganisation with organisations on subdomains", () => {
  beforeEach(() => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
  });

  it("ignores LICENCE_KEY, so one key never makes every organisation Pro", async () => {
    process.env.LICENCE_KEY = key();
    findOneAndUpdate.mockReturnValue(resolves({ _id: DEFAULT_ORGANISATION_ID, entitlements: FREE }));
    findById.mockReturnValue(resolves({ _id: OTHER, entitlements: FREE }));

    expect((await getOrganisation(DEFAULT_ORGANISATION_ID)).entitlements.plan).toBe("free");
    expect((await getOrganisation(OTHER)).entitlements.plan).toBe("free");
  });

  it("derives the plan from the key stored on the organisation, when it names that organisation", async () => {
    findById.mockReturnValue(resolves({ _id: OTHER, licenceKey: key({ organisation: OTHER.toHexString() }), entitlements: FREE }));

    expect((await getOrganisation(OTHER)).entitlements).toMatchObject({ plan: "pro", source: "service" });
  });

  it("refuses a stored key that names another organisation, or none", async () => {
    findById.mockReturnValueOnce(resolves({ _id: OTHER, licenceKey: key({ organisation: DEFAULT_ORGANISATION_ID.toHexString() }), entitlements: FREE }));
    expect((await getOrganisation(OTHER)).entitlements.plan).toBe("free");

    findById.mockReturnValueOnce(resolves({ _id: OTHER, licenceKey: key(), entitlements: FREE }));
    expect((await getOrganisation(OTHER)).entitlements.plan).toBe("free");
  });

  it("reports, for Settings → Licence, the stored key's verdict and never LICENCE_KEY", () => {
    process.env.LICENCE_KEY = key();
    expect(licenceOf({ _id: OTHER })).toBeNull();
    expect(licenceOf({ _id: OTHER, licenceKey: key({ organisation: OTHER.toHexString() }) })?.verdict).toBe("valid");
    expect(licenceOf({ _id: OTHER, licenceKey: key({ organisation: DEFAULT_ORGANISATION_ID.toHexString() }) })?.verdict).toBe("wrong_organisation");
  });

  it("never takes a plan written straight into the row", async () => {
    findById.mockReturnValue(resolves({ _id: OTHER, entitlements: { plan: "pro", features: [], source: "service" } }));

    expect((await getOrganisation(OTHER)).entitlements.plan).toBe("free");
  });
});

describe("checkOrganisationName", () => {
  it("takes no name, and a blank one, as no name", () => {
    expect(checkOrganisationName(undefined)).toEqual({ ok: true, value: null });
    expect(checkOrganisationName(null)).toEqual({ ok: true, value: null });
    expect(checkOrganisationName("   ")).toEqual({ ok: true, value: null });
  });

  it("trims a name", () => {
    expect(checkOrganisationName("  Rafał-org ")).toEqual({ ok: true, value: "Rafał-org" });
  });

  it("refuses anything but a string, and a name over the limit", () => {
    expect(checkOrganisationName(42)).toMatchObject({ ok: false });
    expect(checkOrganisationName("x".repeat(ORGANISATION_NAME_MAX))).toMatchObject({ ok: true });
    expect(checkOrganisationName("x".repeat(ORGANISATION_NAME_MAX + 1))).toMatchObject({ ok: false });
  });
});

describe("nameOrganisation", () => {
  it("sets the name on the default organisation's row", async () => {
    findOneAndUpdate.mockReturnValue(resolves({ _id: DEFAULT_ORGANISATION_ID }));

    await nameOrganisation("Rafał-org");

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: DEFAULT_ORGANISATION_ID },
      { $set: { name: "Rafał-org" }, $setOnInsert: { entitlements: FREE } },
      { upsert: true, returnDocument: "after" }
    );
  });
});

describe("renameOrganisation (BP-920)", () => {
  it("renames another organisation's row by its id alone, creating nothing", async () => {
    await renameOrganisation(OTHER, "Globex");

    expect(updateOne).toHaveBeenCalledWith({ _id: OTHER }, { $set: { name: "Globex" } });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("renames the default organisation through the row it is sure to have", async () => {
    findOneAndUpdate.mockReturnValue(resolves({ _id: DEFAULT_ORGANISATION_ID }));

    await renameOrganisation(DEFAULT_ORGANISATION_ID, "Acme");

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: DEFAULT_ORGANISATION_ID },
      { $set: { name: "Acme" }, $setOnInsert: { entitlements: FREE } },
      { upsert: true, returnDocument: "after" }
    );
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe("organisationIsNamed (BP-920)", () => {
  it("names a self-hosted organisation only when its first run gave it a name", () => {
    expect(organisationIsNamed({ name: "default" })).toBe(false);
    expect(organisationIsNamed({ name: "" })).toBe(false);
    expect(organisationIsNamed({ name: "Acme" })).toBe(true);
  });

  it("names every organisation on subdomains, \"default\" included", () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.test";
    expect(organisationIsNamed({ name: "default" })).toBe(true);
  });
});
