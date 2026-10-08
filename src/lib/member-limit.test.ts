import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getOrganisation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/organisation", () => ({ getOrganisation }));

const { FREE_MEMBER_LIMIT, memberCounts, memberLimitOf, memberLimitRefusal } = await import("./member-limit");

type Counts = { users: number; invitations: number; pendingFor?: string };

function fakeDb({ users, invitations, pendingFor }: Counts) {
  const userCount = vi.fn().mockResolvedValue(users);
  const invitationCount = vi.fn().mockResolvedValue(invitations);
  const exists = vi.fn().mockImplementation(async (filter: { email: string }) => (filter.email === pendingFor ? { _id: "i" } : null));
  return {
    db: { organisation: "org-1", User: { countDocuments: userCount }, Invitation: { countDocuments: invitationCount, exists } } as never,
    userCount,
    invitationCount,
    exists,
  };
}

beforeEach(() => {
  vi.stubEnv("ORGANISATION_DOMAIN", "board-planner.test");
  getOrganisation.mockResolvedValue({ entitlements: { plan: "free", features: [] } });
});
afterEach(() => vi.unstubAllEnvs());

// BP-948
describe("memberCounts", () => {
  it("counts people with access and invitations that can still be accepted, and nothing else", async () => {
    const { db, userCount, invitationCount } = fakeDb({ users: 4, invitations: 2 });

    expect(await memberCounts(db, Date.parse("2026-10-08T00:00:00Z"))).toEqual({ active: 4, pending: 2 });
    expect(userCount).toHaveBeenCalledWith({ kind: { $ne: "machine" }, deactivatedAt: null });
    expect(invitationCount).toHaveBeenCalledWith({ status: "pending", expiresAt: { $gt: new Date("2026-10-08T00:00:00Z") } });
  });
});

describe("memberLimitOf", () => {
  it("is ten on a Free cloud organisation, and none on Pro, on the trial and on a self-hosted instance", async () => {
    const { db } = fakeDb({ users: 0, invitations: 0 });
    expect(await memberLimitOf(db)).toBe(FREE_MEMBER_LIMIT);

    getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [] } });
    expect(await memberLimitOf(db)).toBeNull();

    getOrganisation.mockResolvedValue({ entitlements: { plan: "free", features: [] } });
    vi.unstubAllEnvs();
    expect(await memberLimitOf(db)).toBeNull();
  });
});

describe("memberLimitRefusal", () => {
  it("lets the tenth member in and refuses the eleventh with 402, naming the count and the limit", async () => {
    expect(await memberLimitRefusal(fakeDb({ users: 8, invitations: 1 }).db)).toBeNull();

    const refused = await memberLimitRefusal(fakeDb({ users: 8, invitations: 2 }).db);
    expect(refused?.status).toBe(402);
    expect(await refused!.json()).toMatchObject({ feature: "members.limit", plan: "free", members: 10, limit: 10 });
  });

  it("counts a pending invitation as a seat, so one cannot invite fifty and let them accept later", async () => {
    const refused = await memberLimitRefusal(fakeDb({ users: 3, invitations: 7 }).db);

    expect(refused?.status).toBe(402);
    expect((await refused!.json()).error).toMatch(/\(7 invited\)/);
  });

  it("does not take a second seat for an address that is already invited: that invitation is replaced", async () => {
    const full = fakeDb({ users: 6, invitations: 4, pendingFor: "pat@example.test" });

    expect(await memberLimitRefusal(full.db, { email: "pat@example.test" })).toBeNull();
    // Only a live invitation is that seat: a lapsed one holds none
    expect(full.exists).toHaveBeenCalledWith({ email: "pat@example.test", status: "pending", expiresAt: { $gt: expect.any(Date) } });
    expect((await memberLimitRefusal(full.db, { email: "new@example.test" }))?.status).toBe(402);
  });

  it("refuses nobody on Pro, on the trial or self-hosted, however many there are", async () => {
    const crowded = fakeDb({ users: 40, invitations: 20 }).db;
    getOrganisation.mockResolvedValue({ entitlements: { plan: "pro", features: [] } });
    expect(await memberLimitRefusal(crowded)).toBeNull();

    getOrganisation.mockResolvedValue({ entitlements: { plan: "free", features: [] } });
    vi.unstubAllEnvs();
    expect(await memberLimitRefusal(crowded)).toBeNull();
  });
});
