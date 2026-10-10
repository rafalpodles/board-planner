import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getOrganisation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/organisation", () => ({ getOrganisation }));

const { FREE_MACHINE_LIMIT, claimingMachineIds, isHeldByPlan, machineLimitOf, machineLimitRefusal, ownsConnectedMachine } =
  await import("./machine-limit");

const FREE = { entitlements: { plan: "free", features: [] } };
const PRO = { entitlements: { plan: "pro", features: [], expiresAt: new Date(Date.now() + 86_400_000) } };
const TRIAL = { entitlements: { plan: "pro", features: [], trial: true, expiresAt: new Date(Date.now() + 86_400_000) } };
const CONNECTED = { enabled: true, owner: { $ne: null } };

function fakeDb({
  connected = 0,
  existing = [] as Record<string, unknown>[],
  first = [] as string[],
  undated = [] as string[],
} = {}) {
  const countDocuments = vi.fn().mockResolvedValue(connected);
  const exists = vi.fn().mockImplementation(async (filter: Record<string, unknown>) =>
    existing.some((row) => Object.entries(filter).every(([k, v]) => JSON.stringify(row[k]) === JSON.stringify(v)))
      ? { _id: "w" }
      : null
  );
  const limit = vi.fn((n: number) => ({ select: () => ({ lean: async () => rows.slice(0, n).map((_id) => ({ _id })) }) }));
  let rows: string[] = [];
  const sort = vi.fn(() => ({ limit }));
  const find = vi.fn((filter: { createdAt: unknown }) => {
    rows = filter.createdAt === null ? undated : first;
    return { sort };
  });
  return {
    db: { organisation: "org-1", Worker: { countDocuments, exists, find } } as never,
    countDocuments,
    exists,
    find,
    sort,
    limit,
  };
}

beforeEach(() => {
  vi.stubEnv("ORGANISATION_DOMAIN", "board-planner.test");
  getOrganisation.mockResolvedValue(FREE);
});
afterEach(() => vi.unstubAllEnvs());

// BP-989
describe("machineLimitOf", () => {
  it("is one on a Free cloud organisation, and none on Pro, on the trial and on a self-hosted instance", async () => {
    const { db } = fakeDb();
    expect(await machineLimitOf(db)).toBe(FREE_MACHINE_LIMIT);
    expect(FREE_MACHINE_LIMIT).toBe(1);

    getOrganisation.mockResolvedValue(PRO);
    expect(await machineLimitOf(db)).toBeNull();
    getOrganisation.mockResolvedValue(TRIAL);
    expect(await machineLimitOf(db)).toBeNull();

    getOrganisation.mockResolvedValue(FREE);
    vi.unstubAllEnvs();
    expect(await machineLimitOf(db)).toBeNull();
  });

  it("comes back the day a trial ends, with no grace", async () => {
    getOrganisation.mockResolvedValue({
      entitlements: { plan: "pro", features: [], trial: true, expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await machineLimitOf(fakeDb().db)).toBe(1);
  });
});

describe("claimingMachineIds", () => {
  it("is the first connected machine on Free, read in the order machines were connected", async () => {
    const { db, find, sort, limit } = fakeDb({ first: ["a", "b"], undated: ["legacy"] });

    expect(await claimingMachineIds(db)).toEqual(new Set(["a"]));
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ ...CONNECTED, createdAt: { $ne: null } });
    expect(sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(limit).toHaveBeenCalledWith(1);
  });

  // lostCheckouts puts an undated record last for the same reason: it must never win by accident
  it("falls back to a record with no createdAt only when no dated one is connected", async () => {
    const { db, find } = fakeDb({ undated: ["legacy"] });

    expect(await claimingMachineIds(db)).toEqual(new Set(["legacy"]));
    expect(find).toHaveBeenLastCalledWith({ ...CONNECTED, createdAt: null });
  });

  it("is null, every machine claiming, where there is no limit, and asks nothing of the database", async () => {
    getOrganisation.mockResolvedValue(PRO);
    const { db, find } = fakeDb({ first: ["a"] });

    expect(await claimingMachineIds(db)).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });
});

describe("isHeldByPlan", () => {
  const claiming = new Set(["a"]);
  it("holds an enabled, owned machine the limit leaves out, and nothing else", () => {
    expect(isHeldByPlan({ _id: "b", enabled: true, owner: "u" }, claiming)).toBe(true);
    expect(isHeldByPlan({ _id: "a", enabled: true, owner: "u" }, claiming)).toBe(false);
    expect(isHeldByPlan({ _id: "b", enabled: false, owner: "u" }, claiming)).toBe(false);
    expect(isHeldByPlan({ _id: "b", enabled: true, owner: null }, claiming)).toBe(false);
    expect(isHeldByPlan({ _id: "b", enabled: true, owner: "u" }, null)).toBe(false);
  });
});

describe("machineLimitRefusal", () => {
  it("lets the first machine in and refuses the second with 402, naming the limit and the count", async () => {
    expect(await machineLimitRefusal(fakeDb({ connected: 0 }).db)).toBeNull();

    const { db, countDocuments } = fakeDb({ connected: 1 });
    const refused = await machineLimitRefusal(db);
    expect(refused?.status).toBe(402);
    expect(await refused!.json()).toEqual({
      error:
        "This organisation is on the Free plan, which connects one machine for workers and agents, and one is already connected. Pro connects any number.",
      feature: "workers.multiple",
      plan: "free",
      limit: 1,
    });
    expect(countDocuments).toHaveBeenCalledWith(CONNECTED);
  });

  it("never refuses on Pro, on the trial or self-hosted", async () => {
    getOrganisation.mockResolvedValue(PRO);
    expect(await machineLimitRefusal(fakeDb({ connected: 5 }).db)).toBeNull();
    getOrganisation.mockResolvedValue(TRIAL);
    expect(await machineLimitRefusal(fakeDb({ connected: 5 }).db)).toBeNull();
    getOrganisation.mockResolvedValue(FREE);
    vi.unstubAllEnvs();
    expect(await machineLimitRefusal(fakeDb({ connected: 5 }).db)).toBeNull();
  });

  it("lets a person register their own machine again: that connects nothing new", async () => {
    const existing = [{ name: "mac", host: "mac.local", owner: "ada" }];
    const again = (machine: { name: string; host: string; owner: string }) =>
      machineLimitRefusal(fakeDb({ connected: 1, existing }).db, { machine });

    expect(await again({ name: "mac", host: "mac.local", owner: "ada" })).toBeNull();
    expect((await again({ name: "other", host: "mac.local", owner: "ada" }))?.status).toBe(402);
  });

  // Adopting a record nobody owns connects a machine, whatever the record's age: otherwise a released
  // machine enrolled again would pass as a re-registration and take the claiming slot from the one in use
  it("counts adopting a machine nobody owns, or somebody else's, as connecting a new one", async () => {
    const released = [{ name: "mac", host: "mac.local", owner: null }];
    expect(
      (await machineLimitRefusal(fakeDb({ connected: 1, existing: released }).db, { machine: { name: "mac", host: "mac.local", owner: "ada" } }))
        ?.status
    ).toBe(402);
    const theirs = [{ name: "mac", host: "mac.local", owner: "bob" }];
    expect(
      (await machineLimitRefusal(fakeDb({ connected: 1, existing: theirs }).db, { machine: { name: "mac", host: "mac.local", owner: "ada" } }))
        ?.status
    ).toBe(402);
  });

  it("does not count the machine being switched back on against itself", async () => {
    const { db, countDocuments } = fakeDb({ connected: 0 });
    expect(await machineLimitRefusal(db, { workerId: "w2" })).toBeNull();
    expect(countDocuments).toHaveBeenCalledWith({ ...CONNECTED, _id: { $ne: "w2" } });
  });
});

describe("ownsConnectedMachine", () => {
  it("is whether the person owns an enabled machine", async () => {
    const existing = [{ ...CONNECTED, owner: "ada" }];
    expect(await ownsConnectedMachine(fakeDb({ existing }).db, "ada")).toBe(true);
    expect(await ownsConnectedMachine(fakeDb({ existing }).db, "bob")).toBe(false);
  });
});
