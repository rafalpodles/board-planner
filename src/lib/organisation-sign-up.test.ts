import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { hash, create, deleteOne, userCreate, seedAgents, purgeOrganisationRows, logInstanceAudit, forgetOrganisationSlugs } = vi.hoisted(() => ({
  hash: vi.fn(),
  create: vi.fn(),
  deleteOne: vi.fn(),
  userCreate: vi.fn(),
  seedAgents: vi.fn(),
  purgeOrganisationRows: vi.fn(),
  logInstanceAudit: vi.fn(),
  forgetOrganisationSlugs: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("bcryptjs", async (original) => {
  const real = (await original<{ default: object }>()).default;
  return { default: { ...real, hash } };
});
vi.mock("@/models/organisation", () => ({ Organisation: { create, deleteOne } }));
vi.mock("./db-scope", () => ({ scoped: (organisation: unknown) => ({ organisation, User: { create: userCreate } }) }));
vi.mock("./agent-seed", () => ({ seedAgents }));
vi.mock("./organisation-life-cycle", () => ({ purgeOrganisationRows }));
vi.mock("./instanceAudit", () => ({ logInstanceAudit }));
vi.mock("./organisation-host", async (original) => ({
  ...(await original<typeof import("./organisation-host")>()),
  forgetOrganisationSlugs,
}));

const { checkSignUp, checkSlug, createOrganisation: create_, SLUG_UNAVAILABLE } = await import("./organisation-sign-up");
const { TERMS_REFUSAL } = await import("./legal-terms");

async function createOrganisation(email: string, input: Parameters<typeof checkSignUp>[1]) {
  const checked = checkSignUp(email, input);
  return checked.ok ? create_(checked.value) : checked;
}

afterEach(() => vi.unstubAllEnvs());

const INPUT = { name: " Initech ", slug: "Initech", username: "bill", fullName: "Bill", password: "long-enough-1" };

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
  deleteOne.mockResolvedValue({});
  userCreate.mockImplementation(async (row) => ({ ...row, _id: "user-1" }));
  hash.mockResolvedValue("$2a$10$hashed");
  seedAgents.mockResolvedValue(undefined);
  purgeOrganisationRows.mockResolvedValue({});
});

describe("checkSignUp's name (BP-1010)", () => {
  it.each(["login", "Login", "App", "Board Planner", "Łogin"])("calls %s unavailable: it reads as a reserved address", (name) => {
    expect(checkSignUp("bill@initech.example", { ...INPUT, name })).toEqual({ ok: false, error: "That name is not available. Try another." });
  });

  it("takes a name that only contains a reserved word", () => {
    expect(checkSignUp("bill@initech.example", { ...INPUT, name: "Login Ltd" })).toMatchObject({ ok: true });
  });
});

describe("checkSlug (BP-673)", () => {
  it.each(["login", "app", "www", "admin"])("calls the reserved %s unavailable, in the words a taken one gets", (slug) => {
    expect(checkSlug(slug)).toEqual({ ok: false, error: SLUG_UNAVAILABLE });
  });

  it.each(["ab", "-acme", "acme-", "ac me", "xn--acme", "a".repeat(41), 7, undefined])("states the rule for %s", (slug) => {
    expect(checkSlug(slug)).toMatchObject({ ok: false, error: expect.stringMatching(/3 to 40/) });
  });

  it("takes a well-formed address lowercased", () => {
    expect(checkSlug(" Acme-Rockets ")).toEqual({ ok: true, slug: "acme-rockets" });
  });
});

describe("createOrganisation (BP-673)", () => {
  it("creates the organisation, then its first administrator with the proven address, and seeds the catalog", async () => {
    const outcome = await createOrganisation("Bill@Initech.example", INPUT);

    expect(outcome).toMatchObject({ ok: true, user: "user-1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Initech", slug: "initech" }));
    const row = userCreate.mock.calls[0][0];
    expect(row).toMatchObject({ username: "bill", email: "bill@initech.example", role: "admin", kind: "human" });
    expect(row.emailVerifiedAt).toBeInstanceOf(Date);
    expect(row.password).not.toBe(INPUT.password);
    expect(seedAgents).toHaveBeenCalledTimes(1);
    expect(forgetOrganisationSlugs).toHaveBeenCalled();
  });

  it("answers a taken address as unavailable and writes nothing more", async () => {
    create.mockRejectedValue(Object.assign(new Error("E11000"), { code: 11000, keyPattern: { slug: 1 } }));

    expect(await createOrganisation("bill@initech.example", INPUT)).toEqual({ ok: false, error: SLUG_UNAVAILABLE });
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("checks every field before it creates anything", async () => {
    for (const input of [{ ...INPUT, name: "" }, { ...INPUT, password: "short" }, { ...INPUT, username: "Bad Name!" }, { ...INPUT, slug: "x" }]) {
      expect((await createOrganisation("bill@initech.example", input)).ok).toBe(false);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("removes the organisation and whatever was written under it when a later step fails", async () => {
    seedAgents.mockRejectedValue(new Error("catalog down"));

    await expect(createOrganisation("bill@initech.example", INPUT)).rejects.toThrow("catalog down");
    const organisation = create.mock.calls[0][0]._id;
    expect(purgeOrganisationRows).toHaveBeenCalledWith(organisation);
    expect(deleteOne).toHaveBeenCalledWith({ _id: organisation });
  });

  it("removes the organisation when its administrator cannot be written either", async () => {
    userCreate.mockRejectedValue(new Error("users down"));

    await expect(createOrganisation("bill@initech.example", INPUT)).rejects.toThrow("users down");
    expect(deleteOne).toHaveBeenCalledWith({ _id: create.mock.calls[0][0]._id });
  });

  it("hashes the password before the organisation exists, so the row waits on nothing slow", async () => {
    const order: string[] = [];
    hash.mockImplementation(async () => (order.push("hash"), "$2a$10$hashed"));
    create.mockImplementation(async () => order.push("organisation"));
    userCreate.mockImplementation(async (row) => (order.push(`user:${row.password}`), { _id: "user-1", ...row }));

    await createOrganisation("bill@initech.example", INPUT);
    expect(order).toEqual(["hash", "organisation", "user:$2a$10$hashed"]);
  });
});

describe("terms at sign-up (BP-939)", () => {
  const VERSION = "2026-10-15";
  const cloud = () => {
    vi.stubEnv("ORGANISATION_DOMAIN", "board-planner.example");
    vi.stubEnv("LEGAL_TERMS_VERSION", VERSION);
  };

  it.each([undefined, false, "true", 1])("refuses acceptTerms %j on the cloud and creates nothing", async (acceptTerms) => {
    cloud();
    const outcome = await createOrganisation("bill@initech.example", { ...INPUT, acceptTerms });

    expect(outcome).toEqual({ ok: false, error: TERMS_REFUSAL });
    expect(create).not.toHaveBeenCalled();
    expect(userCreate).not.toHaveBeenCalled();
  });

  it("stores the accepted version on the creator and on the organisation, naming the creator", async () => {
    cloud();
    expect(await createOrganisation("bill@initech.example", { ...INPUT, acceptTerms: true })).toMatchObject({ ok: true });

    const organisation = create.mock.calls[0][0];
    const user = userCreate.mock.calls[0][0];
    expect(user).toMatchObject({ termsAcceptedVersion: VERSION, termsAcceptedAt: expect.any(Date) });
    expect(organisation).toMatchObject({ termsAcceptedVersion: VERSION, termsAcceptedAt: user.termsAcceptedAt });
    expect(String(organisation.termsAcceptedBy)).toBe(String(user._id));
  });

  it.each([
    ["self-hosted, with a version set", { LEGAL_TERMS_VERSION: VERSION }],
    ["the cloud, before the terms are published", { ORGANISATION_DOMAIN: "board-planner.example" }],
  ])("asks nothing and stores nothing on %s", async (_, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(await createOrganisation("bill@initech.example", INPUT)).toMatchObject({ ok: true });

    expect(create.mock.calls[0][0]).not.toHaveProperty("termsAcceptedVersion");
    expect(userCreate.mock.calls[0][0]).not.toHaveProperty("termsAcceptedVersion");
  });
});
