import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

const { getOrganisation } = vi.hoisted(() => ({ getOrganisation: vi.fn() }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("./organisation", () => ({ getOrganisation }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

import { resetRateLimits } from "./rate-limit";
import type { ScopedDb } from "./db-scope";
import {
  CLOUD_REQUESTS_PER_MINUTE,
  machinePrincipal,
  organisationUsage,
  requestLimitRefusal,
  requestsPerMinute,
  storageLimitFor,
  storageLimitRefusal,
} from "./organisation-limits";
import { FREE_STORAGE_MB, PAID_STORAGE_MB } from "./storage-size";

const ACME = new Types.ObjectId("0000000000000000000000a1");
const GLOBEX = new Types.ObjectId("0000000000000000000000b2");
const MB = 1024 * 1024;

beforeEach(async () => {
  delete process.env.ORGANISATION_DOMAIN;
  delete process.env.ORGANISATION_REQUESTS_PER_MINUTE;
  delete process.env.ORGANISATION_STORAGE_MB;
  getOrganisation.mockImplementation(async (id: Types.ObjectId) => ({ entitlements: { plan: id.equals(GLOBEX) ? "pro" : "free" } }));
  await resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("organisation limits (BP-894)", () => {
  it("are off on a self-hosted instance until set, and on by default with organisations on subdomains", () => {
    expect(requestsPerMinute()).toBe(0);
    expect(storageLimitFor("free").bytes).toBe(0);

    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    expect(requestsPerMinute()).toBe(CLOUD_REQUESTS_PER_MINUTE);

    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
    expect(requestsPerMinute()).toBe(0);

    delete process.env.ORGANISATION_DOMAIN;
    process.env.ORGANISATION_STORAGE_MB = "10";
    expect(storageLimitFor("free").bytes).toBe(10 * MB);
  });

  describe("storage follows the plan (BP-967)", () => {
    it("is 1 GB on Free and 20 GB on Pro or its trial, and only the Free one says an upgrade lifts it", () => {
      process.env.ORGANISATION_DOMAIN = "board-planner.com";

      expect(storageLimitFor("free")).toEqual({ bytes: FREE_STORAGE_MB * MB, upgradeLifts: true });
      expect(storageLimitFor("pro")).toEqual({ bytes: PAID_STORAGE_MB * MB, upgradeLifts: false });
      expect([FREE_STORAGE_MB, PAID_STORAGE_MB]).toEqual([1024, 20480]);
    });

    it("lets an operator's value hold for every plan, and 0 switch it off, with no upgrade offered", () => {
      process.env.ORGANISATION_DOMAIN = "board-planner.com";
      process.env.ORGANISATION_STORAGE_MB = "300";
      expect(storageLimitFor("free")).toEqual({ bytes: 300 * MB, upgradeLifts: false });
      expect(storageLimitFor("pro")).toEqual({ bytes: 300 * MB, upgradeLifts: false });

      process.env.ORGANISATION_STORAGE_MB = "0";
      expect(storageLimitFor("free")).toEqual({ bytes: 0, upgradeLifts: false });
    });

    it("is no limit for any plan on a self-hosted instance until set, and never offers an upgrade", () => {
      expect(storageLimitFor("free")).toEqual({ bytes: 0, upgradeLifts: false });
      expect(storageLimitFor("pro")).toEqual({ bytes: 0, upgradeLifts: false });
    });
  });

  it("falls back to the default for a value that is not a whole number, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "lots";

    expect(requestsPerMinute()).toBe(CLOUD_REQUESTS_PER_MINUTE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ORGANISATION_REQUESTS_PER_MINUTE"));
  });

  it("refuses an organisation past its requests for the minute, naming the limit and when it resets, and not another", async () => {
    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "4";

    for (const principal of ["p1", "p1", "p2", "p2"]) expect(await requestLimitRefusal(ACME, { id: principal })).toBeNull();
    const refused = await requestLimitRefusal(ACME, { id: "p3" });

    expect(refused?.status).toBe(429);
    expect(refused!.headers.get("x-organisation-limit")).toBe("organisation");
    const seconds = Number(refused!.headers.get("Retry-After"));
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60);
    const body = await refused!.json();
    expect(body.error).toBe(`This organisation has made more than 4 requests in a minute. Try again in ${seconds} s.`);
    expect(body.limit).toBe(4);
    expect(new Date(body.resetAt).getTime()).toBeGreaterThan(Date.now());

    expect(await requestLimitRefusal(GLOBEX, { id: "g1" })).toBeNull();
  });

  it("cuts one account off at its share before it can spend everybody's minute", async () => {
    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "4";

    const answers = [];
    for (let i = 0; i < 10; i++) answers.push(await requestLimitRefusal(ACME, { id: "runaway" }));
    expect(answers.filter((answer) => answer === null)).toHaveLength(2);
    const refused = answers.at(-1)!;
    expect(refused.headers.get("x-organisation-limit")).toBe("principal");
    expect((await refused.json()).error).toMatch(/^You have made more than 2 requests in a minute\. Try again in \d+ s\.$/);

    expect(await requestLimitRefusal(ACME, { id: "colleague" })).toBeNull();
    expect(await requestLimitRefusal(ACME, { id: "colleague" })).toBeNull();
  });

  it("counts a machine against its owner, and one with no owner on its own", () => {
    const owner = new Types.ObjectId();
    const machine = new Types.ObjectId();

    expect(machinePrincipal({ _id: machine, owner } as never)).toEqual({ id: String(owner) });
    expect(machinePrincipal({ _id: machine, owner: { _id: owner, username: "boss" } } as never)).toEqual({ id: String(owner) });
    expect(machinePrincipal({ _id: machine, owner: null } as never)).toEqual({ id: String(machine) });
  });

  it("lets an administrator at the keyboard in past the organisation's minute, but not past their own share", async () => {
    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "4";
    for (const principal of ["p1", "p1", "p2", "p2"]) await requestLimitRefusal(ACME, { id: principal });
    expect((await requestLimitRefusal(ACME, { id: "p3" }))?.status).toBe(429);

    const admin = { id: "admin", interactiveAdmin: true };
    expect(await requestLimitRefusal(ACME, admin)).toBeNull();
    expect(await requestLimitRefusal(ACME, admin)).toBeNull();
    expect((await requestLimitRefusal(ACME, admin))?.headers.get("x-organisation-limit")).toBe("principal");
  });

  it("lets the organisation in again once the minute is over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "2";
    expect(await requestLimitRefusal(ACME, { id: "p1" })).toBeNull();
    expect(await requestLimitRefusal(ACME, { id: "p2" })).toBeNull();
    expect((await requestLimitRefusal(ACME, { id: "p3" }))?.status).toBe(429);

    vi.setSystemTime(Date.now() + 61_000);
    expect(await requestLimitRefusal(ACME, { id: "p3" })).toBeNull();
  });

  it("lets through an upload that fills the storage exactly, and refuses one byte more", async () => {
    process.env.ORGANISATION_STORAGE_MB = "10";
    const limit = storageLimitFor("free");

    expect(storageLimitRefusal(9 * MB, MB, limit)).toBeNull();
    const refused = storageLimitRefusal(9 * MB, MB + 1, limit);
    expect(refused?.status).toBe(413);
    expect((await refused!.json()).error).toBe(
      "This organisation has used 9 MB of its 10 MB of file storage, so no more files can be uploaded."
    );
  });

  it("names the Free plan and what Pro holds when the Free default is what refuses (BP-967)", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";

    const refused = storageLimitRefusal(1000 * MB, 100 * MB, storageLimitFor("free"));

    expect(refused?.status).toBe(413);
    expect(await refused!.json()).toEqual({
      error: "This organisation has used 1000 MB of its 1 GB of file storage on the Free plan, so no more files can be uploaded. Upgrade to Pro for 20 GB.",
      feature: "storage.limit",
      plan: "free",
      limit: 1024 * MB,
      stored: 1000 * MB,
    });
    expect(storageLimitRefusal(1000 * MB, 24 * MB, storageLimitFor("free"))).toBeNull();
    expect(storageLimitRefusal(1000 * MB, 100 * MB, storageLimitFor("pro"))).toBeNull();
  });
});

describe("organisationUsage (BP-678)", () => {
  const asDb = (organisation: Types.ObjectId) => ({ organisation }) as unknown as ScopedDb;

  it("reads the organisation's own minute without spending it, with the limits it is held to", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    const principal = { id: "u1", interactiveAdmin: false };
    await requestLimitRefusal(ACME, principal);
    await requestLimitRefusal(ACME, principal);
    await requestLimitRefusal(GLOBEX, principal);

    const first = await organisationUsage(asDb(ACME));
    expect(first).toEqual({ requestsThisMinute: 2, requestsPerMinute: CLOUD_REQUESTS_PER_MINUTE, storedBytes: 0, storageLimitBytes: FREE_STORAGE_MB * MB });
    expect((await organisationUsage(asDb(ACME))).requestsThisMinute).toBe(2);
    expect((await organisationUsage(asDb(GLOBEX))).requestsThisMinute).toBe(1);
  });

  it("reports each organisation's storage ceiling by its own plan (BP-967)", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";

    expect((await organisationUsage(asDb(ACME))).storageLimitBytes).toBe(FREE_STORAGE_MB * MB);
    expect((await organisationUsage(asDb(GLOBEX))).storageLimitBytes).toBe(PAID_STORAGE_MB * MB);
  });

  it("counts nothing once the minute has run out", async () => {
    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    vi.useFakeTimers();
    await requestLimitRefusal(ACME, { id: "u1" });
    vi.advanceTimersByTime(61_000);
    expect((await organisationUsage(asDb(ACME))).requestsThisMinute).toBe(0);
  });
});
