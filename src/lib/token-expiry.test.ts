import { beforeEach, describe, expect, it, vi } from "vitest";

const createNotifications = vi.hoisted(() => vi.fn());
vi.mock("@/lib/in-app-notifications", () => ({ createNotifications }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/lib/organisation-jobs", () => ({ forEachServedOrganisation: vi.fn() }));

const { notifyExpiringTokens, tokenExpiryTickMs } = await import("./token-expiry");

const now = new Date("2026-10-25T12:00:00Z");
const inThreeDays = new Date("2026-10-28T12:00:00Z");

/**
 * A scoped db for these reads: `Project.find` answers by provider, the claim answers what the store
 * would, and owners come from grants filtered to accounts that are not deactivated.
 */
function fakeDb(opts: {
  github?: Record<string, unknown>[];
  gitlab?: Record<string, unknown>[];
  claimed?: number;
  owners?: string[];
  deactivated?: string[];
}) {
  const find = vi.fn((filter: Record<string, unknown>) => ({
    lean: async () => ("githubToken" in filter ? (opts.github ?? []) : (opts.gitlab ?? [])),
  }));
  const updateOne = vi.fn(async () => ({ modifiedCount: opts.claimed ?? 1 }));
  const owners = opts.owners ?? ["a1"];
  const grants = [
    ...owners.map((subject) => ({ subject, relation: "owner", objectType: "project", object: "p1" })),
    { subject: "member1", relation: "member", objectType: "project", object: "p1" },
  ];
  const users = [...owners, "member1"].map((_id) => ({ _id, deactivatedAt: (opts.deactivated ?? []).includes(_id) ? new Date() : null }));
  const grantFind = vi.fn((filter: Record<string, unknown>) => ({
    select: () => ({
      lean: async () =>
        grants.filter((g) => g.relation === filter.relation && g.objectType === filter.objectType && (g.object === filter.object || filter.object === "p2")),
    }),
  }));
  const userFind = vi.fn((filter: { _id: { $in: string[] }; deactivatedAt?: null }) => ({
    select: () => ({
      lean: async () => users.filter((u) => filter._id.$in.includes(u._id) && (!("deactivatedAt" in filter) || u.deactivatedAt === null)),
    }),
  }));
  const db = { Project: { find, updateOne }, Grant: { find: grantFind }, User: { find: userFind } };
  return { db: db as never, find, updateOne };
}

const project = (connection: Record<string, unknown>) => ({ _id: "p1", key: "ORB", name: "Orbit", githubConnection: connection });

beforeEach(() => createNotifications.mockReset());

describe("telling a board's owners that its token expires (BP-1109)", () => {
  it("asks only for live, unrejected tokens expiring within the week", async () => {
    const { db, find } = fakeDb({});

    await notifyExpiringTokens(db, now);

    expect(find.mock.calls[0][0]).toEqual({
      githubToken: { $nin: [null, ""] },
      "githubConnection.rejectedAt": null,
      "githubConnection.expiresAt": { $gt: now, $lte: new Date("2026-11-01T12:00:00Z") },
    });
    expect(find.mock.calls[1][0]).toMatchObject({ gitlabToken: { $nin: [null, ""] }, "gitlabConnection.rejectedAt": null });
  });

  it("claims the expiry before telling the living owners, and says which token and when", async () => {
    const { db, updateOne } = fakeDb({ github: [project({ expiresAt: inThreeDays })], owners: ["a1", "a2", "gone"], deactivated: ["gone"] });

    expect(await notifyExpiringTokens(db, now)).toBe(1);

    expect(updateOne).toHaveBeenCalledWith(
      { _id: "p1", "githubConnection.expiresAt": inThreeDays, "githubConnection.expiryNotifiedFor": { $ne: inThreeDays } },
      { $set: { "githubConnection.expiryNotifiedFor": inThreeDays } }
    );
    expect(createNotifications).toHaveBeenCalledTimes(1);
    const sent = createNotifications.mock.calls[0][1];
    expect(sent).toMatchObject({ type: "token_expiring", projectId: "p1", recipientIds: ["a1", "a2"] });
    expect(sent.title).toBe("The GitHub token of Orbit expires on 28 Oct");
    expect(sent).not.toHaveProperty("actorId");
  });

  it("tells nobody again once another tick or replica has claimed the same expiry", async () => {
    const { db } = fakeDb({ github: [project({ expiresAt: inThreeDays })], claimed: 0 });

    expect(await notifyExpiringTokens(db, now)).toBe(0);
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("leaves a board with no living owner untold, having claimed it", async () => {
    const { db, updateOne } = fakeDb({ github: [project({ expiresAt: inThreeDays })], owners: ["gone"], deactivated: ["gone"] });

    expect(await notifyExpiringTokens(db, now)).toBe(0);
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("claims before it tells, so a second replica's tick finds the expiry taken", async () => {
    const order: string[] = [];
    const { db, updateOne } = fakeDb({ github: [project({ expiresAt: inThreeDays })] });
    updateOne.mockImplementationOnce(async () => (order.push("claim"), { modifiedCount: 1 }));
    createNotifications.mockImplementationOnce(async () => void order.push("notify"));

    await notifyExpiringTokens(db, now);

    expect(order).toEqual(["claim", "notify"]);
  });

  it("links the mail and the chat message to the board's integration settings", async () => {
    const { db } = fakeDb({ github: [project({ expiresAt: inThreeDays })] });

    await notifyExpiringTokens(db, now);

    expect(createNotifications.mock.calls[0][1].email).toMatchObject({ projectRef: "ORB", section: "integrations" });
  });

  it("names GitLab for a GitLab token", async () => {
    const { db } = fakeDb({ gitlab: [{ _id: "p2", key: "GL", name: "Mirror", gitlabConnection: { expiresAt: inThreeDays } }] });

    await notifyExpiringTokens(db, now);

    expect(createNotifications.mock.calls[0][1].title).toBe("The GitLab token of Mirror expires on 28 Oct");
  });
});

describe("TOKEN_EXPIRY_TICK_MS", () => {
  it("is an hour unless set, 0 turns it off, and a value that is not a number falls back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(tokenExpiryTickMs(undefined)).toBe(3_600_000);
    expect(tokenExpiryTickMs("0")).toBe(0);
    expect(tokenExpiryTickMs("1500")).toBe(1500);
    expect(tokenExpiryTickMs("1h")).toBe(3_600_000);
    expect(tokenExpiryTickMs("5")).toBe(3_600_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
