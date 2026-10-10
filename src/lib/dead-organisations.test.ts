import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { DEAD_NOTICE_DAYS, DEAD_STALE_DAYS, DEFAULT_DEAD_DAYS, MIN_DEAD_DAYS, deadOrganisationDays, deadStep, type DeadFacts } from "./dead-organisations";
import { SUSPENSION_SETTLE_MS } from "./organisation-life-cycle";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-12-01T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY);

const facts = (over: Partial<DeadFacts> = {}): DeadFacts => ({
  now: NOW,
  days: 60,
  planIsPro: false,
  endedAt: ago(90),
  lastActiveAt: ago(90),
  noticeAt: null,
  suspendedAt: null,
  suspendedByTheSweep: false,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

// BP-674: nothing is deleted that nobody was told about, and anything that shows life stops it
describe("deadStep", () => {
  it("leaves an organisation alone while its plan is live, or it ended less than a period ago", () => {
    expect(deadStep(facts({ planIsPro: true }))).toBe("alive");
    expect(deadStep(facts({ endedAt: ago(59) }))).toBe("alive");
  });

  it("leaves it alone while somebody has signed in within the period, even long after the plan ended", () => {
    expect(deadStep(facts({ lastActiveAt: ago(59) }))).toBe("alive");
    expect(deadStep(facts({ lastActiveAt: ago(60) }))).toBe("notice");
  });

  it("tells it first, and waits the 30 days before doing anything else", () => {
    expect(deadStep(facts())).toBe("notice");
    expect(deadStep(facts({ noticeAt: ago(DEAD_NOTICE_DAYS - 1) }))).toBe("wait");
  });

  it("suspends once the 30 days have gone, and deletes only what the sweep itself suspended and that has settled", () => {
    const noticed = facts({ noticeAt: ago(DEAD_NOTICE_DAYS) });
    expect(deadStep(noticed)).toBe("suspend");
    const suspended = new Date(NOW - SUSPENSION_SETTLE_MS - 1000);
    expect(deadStep({ ...noticed, suspendedAt: suspended, suspendedByTheSweep: true })).toBe("delete");
    expect(deadStep({ ...noticed, suspendedAt: new Date(NOW - 1000), suspendedByTheSweep: true })).toBe("wait");
    expect(deadStep({ ...noticed, suspendedAt: suspended, suspendedByTheSweep: false })).toBe("wait");
  });

  it("calls the notice off, and the suspension with it, when somebody signs in or a plan arrives", () => {
    expect(deadStep(facts({ noticeAt: ago(5), lastActiveAt: ago(1) }))).toBe("clear");
    expect(deadStep(facts({ noticeAt: ago(20), planIsPro: true, suspendedAt: ago(1), suspendedByTheSweep: true }))).toBe("clear");
    expect(deadStep(facts({ suspendedAt: ago(1), suspendedByTheSweep: true, lastActiveAt: ago(1) }))).toBe("clear");
  });

  it("tells a notice again that nothing followed, but not one still inside its 30 days and a few days over, nor one that already led to a suspension, which goes on to its deletion", () => {
    const limit = DEAD_NOTICE_DAYS + DEAD_STALE_DAYS;
    expect(deadStep(facts({ noticeAt: ago(limit - 1) }))).toBe("suspend");
    expect(deadStep(facts({ noticeAt: ago(limit) }))).toBe("notice");
    expect(deadStep(facts({ noticeAt: ago(limit), suspendedAt: ago(1), suspendedByTheSweep: true }))).toBe("delete");
  });
});

describe("deadOrganisationDays", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is 60 in the cloud and nothing elsewhere, until somebody sets it; 0 is off", async () => {
    vi.stubEnv("ORGANISATION_DOMAIN", "board-planner.test");
    const cloud = await import("./dead-organisations");
    expect(cloud.deadOrganisationDays({})).toBe(DEFAULT_DEAD_DAYS);
    expect(cloud.deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "90" })).toBe(90);
    expect(cloud.deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "0" })).toBe(0);

    vi.unstubAllEnvs();
    vi.resetModules();
    const selfHosted = await import("./dead-organisations");
    expect(selfHosted.deadOrganisationDays({})).toBe(0);
  });

  it("refuses anything under a month, or that is not a number, and says so once", async () => {
    vi.stubEnv("ORGANISATION_DOMAIN", "board-planner.test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deadOrganisationDays } = await import("./dead-organisations");

    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: String(MIN_DEAD_DAYS - 1) })).toBe(0);
    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "6" })).toBe(0);
    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "sixty" })).toBe(0);
    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: String(MIN_DEAD_DAYS) })).toBe(MIN_DEAD_DAYS);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
