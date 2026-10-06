import { describe, it, expect, vi, beforeEach } from "vitest";

const { create, deleteOne, userCreate, seedAgents, purgeOrganisationRows, logInstanceAudit, forgetOrganisationSlugs } = vi.hoisted(() => ({
  create: vi.fn(),
  deleteOne: vi.fn(),
  userCreate: vi.fn(),
  seedAgents: vi.fn(),
  purgeOrganisationRows: vi.fn(),
  logInstanceAudit: vi.fn(),
  forgetOrganisationSlugs: vi.fn(),
}));

vi.mock("./db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/organisation", () => ({ Organisation: { create, deleteOne } }));
vi.mock("./db-scope", () => ({ scoped: (organisation: unknown) => ({ organisation, User: { create: userCreate } }) }));
vi.mock("./agent-seed", () => ({ seedAgents }));
vi.mock("./organisation-life-cycle", () => ({ purgeOrganisationRows }));
vi.mock("./instanceAudit", () => ({ logInstanceAudit }));
vi.mock("./organisation-host", async (original) => ({
  ...(await original<typeof import("./organisation-host")>()),
  forgetOrganisationSlugs,
}));

const { checkSlug, createOrganisation, SLUG_UNAVAILABLE } = await import("./organisation-sign-up");

const INPUT = { name: " Initech ", slug: "Initech", username: "bill", fullName: "Bill", password: "long-enough-1" };

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({});
  deleteOne.mockResolvedValue({});
  userCreate.mockImplementation(async (row) => ({ _id: "user-1", ...row }));
  seedAgents.mockResolvedValue(undefined);
  purgeOrganisationRows.mockResolvedValue({});
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
});
