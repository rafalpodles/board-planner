import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  ask: vi.fn(),
  getOrganisation: vi.fn(),
  record: vi.fn(),
  counts: vi.fn(),
  served: [] as { organisation: string }[],
  domain: vi.fn(),
  pullConfig: vi.fn(),
}));

vi.mock("./billing-client", () => ({ askBilling: m.ask }));
vi.mock("./organisation", () => ({ getOrganisation: m.getOrganisation, recordMemberSync: m.record }));
vi.mock("./member-limit", () => ({ memberCounts: m.counts }));
vi.mock("./organisation-host", () => ({ organisationDomain: m.domain }));
vi.mock("./licence-pull", () => ({ licencePullConfig: m.pullConfig }));
vi.mock("./organisation-jobs", () => ({
  forEachServedOrganisation: async (_job: string, work: (db: unknown) => Promise<void>) => {
    for (const organisation of m.served) await work({ organisation: { toHexString: () => organisation.organisation } });
  },
}));

const { forgetMemberSyncFailures, memberSyncTickMs, runMemberSync, startMemberSync, syncMembersOf } = await import("./member-sync");

const ORG = "0123456789abcdef01234567";
const db = { organisation: { toHexString: () => ORG } } as never;
const pro = (over: Record<string, unknown> = {}) => ({ entitlements: { plan: "pro", trial: false }, memberSync: null, ...over });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  forgetMemberSyncFailures();
  m.ask.mockReset().mockResolvedValue({ status: "ok", body: { status: "updated", extraMembers: 4 } });
  m.getOrganisation.mockReset().mockResolvedValue(pro());
  m.record.mockReset().mockResolvedValue(undefined);
  m.counts.mockReset().mockResolvedValue({ active: 14, pending: 3 });
  m.served.length = 0;
  m.domain.mockReset().mockReturnValue("board-planner.test");
  m.pullConfig.mockReset().mockReturnValue({ url: new URL("https://licence.example") });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

// BP-949
describe("syncMembersOf", () => {
  it("tells the licence service the people with access, not the invitations, and remembers what it told", async () => {
    expect(await syncMembersOf(db)).toBe("sent");

    expect(m.ask).toHaveBeenCalledWith("members", { organisation: ORG, members: 14 });
    expect(m.record).toHaveBeenCalledWith(expect.anything(), 14);
  });

  it.each([
    ["a Free organisation, which never has more than ten", { entitlements: { plan: "free", trial: false } }],
    ["a trial, which has no subscription", { entitlements: { plan: "pro", trial: true } }],
  ])("tells nobody about %s", async (_why, organisation) => {
    m.getOrganisation.mockResolvedValue(pro(organisation));

    expect(await syncMembersOf(db)).toBe("skipped");
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("says nothing again while the count is what it last told", async () => {
    m.getOrganisation.mockResolvedValue(pro({ memberSync: { members: 14, at: new Date() } }));

    expect(await syncMembersOf(db)).toBe("unchanged");
    expect(m.ask).not.toHaveBeenCalled();
  });

  it("tells it again when the count has moved, in either direction", async () => {
    m.getOrganisation.mockResolvedValue(pro({ memberSync: { members: 20, at: new Date() } }));

    expect(await syncMembersOf(db)).toBe("sent");
  });

  it.each(["updated", "unchanged", "no_subscription"])("counts %s as told", async (status) => {
    m.ask.mockResolvedValue({ status: "ok", body: { status } });

    expect(await syncMembersOf(db)).toBe("sent");
    expect(m.record).toHaveBeenCalled();
  });

  it.each([
    ["a service that cannot be reached", { status: "unreachable" }],
    ["a service that takes no payments", { status: "off" }],
    ["one that refuses the request", { status: "refused", httpStatus: 401, body: {} }],
    ["one that cannot set the members", { status: "ok", body: { status: "unavailable" } }],
    ["an answer that is not one", { status: "ok", body: { licenceKey: "k" } }],
  ])("does not count %s as told, so the next tick tries again", async (_why, answer) => {
    m.ask.mockResolvedValue(answer);

    expect(await syncMembersOf(db)).toBe("failed");
    expect(m.record).not.toHaveBeenCalled();
  });
});

describe("a service that does not answer", () => {
  const MINUTE = 60_000;
  const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

  it("is asked again a minute later, then two, then four, and no more often than every half hour", async () => {
    m.ask.mockResolvedValue({ status: "unreachable" });
    const at = (minutes: number) => syncMembersOf(db, T0 + minutes * MINUTE);

    expect(await at(0)).toBe("failed");
    expect(await at(0.5)).toBe("waiting");
    expect(await at(1)).toBe("failed");
    expect(await at(2)).toBe("waiting");
    expect(await at(3)).toBe("failed");
    expect(await at(6)).toBe("waiting");
    expect(await at(7)).toBe("failed");
    expect(m.ask).toHaveBeenCalledTimes(4);

    for (let minute = 8; minute < 200; minute += 1) await at(minute);
    const late = m.ask.mock.calls.length;
    await at(300);
    await at(301);
    await at(331);
    expect(m.ask.mock.calls.length - late).toBeLessThanOrEqual(3);
  });

  it("says so the first time and then every eighth, and says nothing of a service that takes no payments", async () => {
    m.ask.mockResolvedValue({ status: "unreachable" });
    for (let i = 0; i < 17; i++) await syncMembersOf(db, T0 + i * 31 * MINUTE);
    expect(warn).toHaveBeenCalledTimes(3);

    warn.mockClear();
    forgetMemberSyncFailures();
    m.ask.mockResolvedValue({ status: "off" });
    for (let i = 0; i < 17; i++) await syncMembersOf(db, T0 + i * 31 * MINUTE);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is forgotten once it answers, so the next failure starts the pauses again", async () => {
    m.ask.mockResolvedValue({ status: "unreachable" });
    await syncMembersOf(db, T0);
    await syncMembersOf(db, T0 + MINUTE);
    m.ask.mockResolvedValue({ status: "ok", body: { status: "updated" } });
    expect(await syncMembersOf(db, T0 + 3 * MINUTE)).toBe("sent");

    m.getOrganisation.mockResolvedValue(pro({ memberSync: { members: 20, at: new Date() } }));
    m.ask.mockResolvedValue({ status: "unreachable" });
    expect(await syncMembersOf(db, T0 + 4 * MINUTE)).toBe("failed");
    expect(await syncMembersOf(db, T0 + 5 * MINUTE)).toBe("failed");
  });
});

describe("runMemberSync", () => {
  it("goes through every organisation served and says how it went", async () => {
    m.served.push({ organisation: ORG }, { organisation: "76543210fedcba9876543210" }, { organisation: "00000000000000000000000a" });
    m.getOrganisation.mockResolvedValueOnce(pro()).mockResolvedValueOnce(pro({ entitlements: { plan: "free" } })).mockResolvedValueOnce(pro({ memberSync: { members: 14, at: new Date() } }));

    expect(await runMemberSync()).toEqual({ skipped: 1, unchanged: 1, sent: 1, failed: 0, waiting: 0 });
  });
});

describe("memberSyncTickMs", () => {
  it("is a minute unless told otherwise, 0 is off, and a number that is not one is a minute and says so", () => {
    expect(memberSyncTickMs(undefined)).toBe(60_000);
    expect(memberSyncTickMs("0")).toBe(0);
    expect(memberSyncTickMs("5000")).toBe(5000);
    expect(memberSyncTickMs("1")).toBe(1000);
    expect(memberSyncTickMs("soon")).toBe(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("startMemberSync", () => {
  it("does not start where organisations are not on subdomains, or no licence service is set", () => {
    m.domain.mockReturnValue(null);
    expect(startMemberSync()).toEqual({ started: false, reason: "organisations are not on subdomains" });
    m.domain.mockReturnValue("board-planner.test");
    m.pullConfig.mockReturnValue(null);
    expect(startMemberSync()).toEqual({ started: false, reason: "LICENCE_SERVICE_URL and LICENCE_PULL_KEY are not set" });
  });
});
