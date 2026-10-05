import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Types } from "mongoose";

vi.mock("@/lib/db", () => ({ connectDB: vi.fn() }));
vi.mock("@/models/rateLimit", async () => {
  const { inMemoryRateLimitModel } = await import("@/lib/rate-limit-test-store");
  return { RateLimit: inMemoryRateLimitModel() };
});

import { resetRateLimits } from "./rate-limit";
import {
  CLOUD_REQUESTS_PER_MINUTE,
  CLOUD_STORAGE_MB,
  requestLimitRefusal,
  requestsPerMinute,
  storageLimitBytes,
  storageLimitRefusal,
} from "./organisation-limits";

const ACME = new Types.ObjectId("0000000000000000000000a1");
const GLOBEX = new Types.ObjectId("0000000000000000000000b2");
const MB = 1024 * 1024;

beforeEach(async () => {
  delete process.env.ORGANISATION_DOMAIN;
  delete process.env.ORGANISATION_REQUESTS_PER_MINUTE;
  delete process.env.ORGANISATION_STORAGE_MB;
  await resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("organisation limits (BP-894)", () => {
  it("are off on a self-hosted instance until set, and on by default with organisations on subdomains", () => {
    expect(requestsPerMinute()).toBe(0);
    expect(storageLimitBytes()).toBe(0);

    process.env.ORGANISATION_DOMAIN = "board-planner.com";
    expect(requestsPerMinute()).toBe(CLOUD_REQUESTS_PER_MINUTE);
    expect(storageLimitBytes()).toBe(CLOUD_STORAGE_MB * MB);

    process.env.ORGANISATION_REQUESTS_PER_MINUTE = "0";
    expect(requestsPerMinute()).toBe(0);

    delete process.env.ORGANISATION_DOMAIN;
    process.env.ORGANISATION_STORAGE_MB = "10";
    expect(storageLimitBytes()).toBe(10 * MB);
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

    expect(storageLimitRefusal(9 * MB, MB)).toBeNull();
    const refused = storageLimitRefusal(9 * MB, MB + 1);
    expect(refused?.status).toBe(413);
    expect((await refused!.json()).error).toBe(
      "This organisation has used 9 MB of its 10 MB of file storage, so no more files can be uploaded."
    );
  });
});
