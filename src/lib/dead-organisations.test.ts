import { describe, it, expect, vi, afterEach } from "vitest";
import { DEAD_NOTICE_DAYS, deadOrganisationDays, deadStep, type DeadFacts } from "./dead-organisations";
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

  it("tells it first, and waits the fortnight before doing anything else", () => {
    expect(deadStep(facts())).toBe("notice");
    expect(deadStep(facts({ noticeAt: ago(DEAD_NOTICE_DAYS - 1) }))).toBe("wait");
  });

  it("suspends once the fortnight has gone, and deletes only what the sweep itself suspended and that has settled", () => {
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
});

describe("deadOrganisationDays", () => {
  it("is off unless somebody sets it, and says once when what they set is not a number of days", () => {
    expect(deadOrganisationDays({})).toBe(0);
    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "60" })).toBe(60);
    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "0" })).toBe(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "sixty" })).toBe(0);
    expect(deadOrganisationDays({ DEAD_ORGANISATION_DAYS: "-5" })).toBe(0);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
