import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  DEAD_NOTICE_DAYS,
  DEAD_REMINDER_DAYS,
  DEAD_STALE_DAYS,
  DEFAULT_DEAD_DAYS,
  MIN_DEAD_DAYS,
  deadOrganisationDays,
  deadOrganisationEmail,
  deadStep,
  type DeadFacts,
} from "./dead-organisations";
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
  reminderAt: null,
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

  it("tells it first, and gives it 30 days before suspending it", () => {
    expect(DEAD_NOTICE_DAYS).toBe(30);
    expect(deadStep(facts())).toBe("notice");
    expect(deadStep(facts({ noticeAt: ago(14), reminderAt: ago(1) }))).toBe("wait");
    expect(deadStep(facts({ noticeAt: new Date(NOW - 30 * DAY + 1000), reminderAt: ago(1) }))).toBe("wait");
    expect(deadStep(facts({ noticeAt: ago(30), reminderAt: ago(1) }))).toBe("suspend");
  });

  // BP-999
  it("reminds it once, a week before the end, and not before", () => {
    expect(DEAD_NOTICE_DAYS - DEAD_REMINDER_DAYS).toBe(23);
    expect(deadStep(facts({ noticeAt: ago(1) }))).toBe("wait");
    expect(deadStep(facts({ noticeAt: new Date(NOW - 23 * DAY + 1000) }))).toBe("wait");
    expect(deadStep(facts({ noticeAt: ago(23) }))).toBe("remind");
    expect(deadStep(facts({ noticeAt: ago(29) }))).toBe("remind");
    expect(deadStep(facts({ noticeAt: ago(23), reminderAt: ago(0) }))).toBe("wait");
    expect(deadStep(facts({ noticeAt: ago(29), reminderAt: ago(6) }))).toBe("wait");
  });

  it("does not hold the suspension for a reminder that never went out", () => {
    expect(deadStep(facts({ noticeAt: ago(30) }))).toBe("suspend");
    const suspended = { noticeAt: ago(25), suspendedAt: ago(1), suspendedByTheSweep: true };
    expect(deadStep(facts(suspended))).toBe("wait");
  });

  it("calls the reminder off with the notice when somebody signs in or a plan arrives", () => {
    expect(deadStep(facts({ noticeAt: ago(25), reminderAt: ago(2), lastActiveAt: ago(1) }))).toBe("clear");
    expect(deadStep(facts({ noticeAt: ago(25), reminderAt: ago(2), planIsPro: true }))).toBe("clear");
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

describe("deadOrganisationEmail", () => {
  const deleteOn = new Date(Date.UTC(2026, 11, 31, 12));
  const sentAt = (daysBefore: number, hour = 12) => Date.UTC(2026, 11, 31 - daysBefore, hour);
  const deadline = "Signing in, or choosing a plan, before 31 December 2026 at 12:00 UTC cancels the deletion.";

  it.each(["notice", "reminder"] as const)("the %s names the exact moment, what cancels it, and links to the organisation's export", (kind) => {
    const { subject, html, text } = deadOrganisationEmail(kind, "Acme", "https://acme.board-planner.com", deleteOn, sentAt(kind === "notice" ? 30 : 7));
    expect(subject).toContain("31 December 2026");
    expect(html).toContain("unless somebody signs in or chooses a plan before 31 December 2026 at 12:00 UTC.");
    for (const body of [html, text]) {
      expect(body).toContain(deadline);
      expect(body).toContain("https://acme.board-planner.com/settings/export");
      expect(body).toContain("https://acme.board-planner.com/login");
    }
  });

  it("gives the suspension's own minute, whatever the time of day", () => {
    const morning = new Date(Date.UTC(2026, 11, 31, 6, 7));
    const { html, text } = deadOrganisationEmail("notice", "Acme", null, morning, Date.UTC(2026, 11, 1, 6, 7));
    for (const body of [html, text]) expect(body).toContain("before 31 December 2026 at 06:07 UTC cancels the deletion.");
  });

  it("states the same moment in a reminder sent less than 36 hours before the end", () => {
    const morning = new Date(Date.UTC(2026, 11, 31, 6));
    const late = deadOrganisationEmail("reminder", "Acme", null, morning, Date.UTC(2026, 11, 30, 20));
    for (const body of [late.html, late.text]) {
      expect(body).toContain("Signing in, or choosing a plan, before 31 December 2026 at 06:00 UTC cancels the deletion.");
      expect(body).not.toMatch(/December 2026 cancels|by \d+ December|now, before/);
    }
    expect(late.html).toContain("Reminder: less than a day left");
    expect(late.text).toContain("Time left: less than a day.");
  });

  it("counts the time a reminder has left from when it goes out, however late, in both versions", () => {
    const mail = (now: number) => deadOrganisationEmail("reminder", "Acme", null, deleteOn, now);
    expect(mail(sentAt(7)).html).toContain("Reminder: 7 days left");
    expect(mail(sentAt(4, 18)).html).toContain("Reminder: 4 days left");
    expect(mail(sentAt(1, 12)).html).toContain("Reminder: 1 day left");
    expect(mail(sentAt(1, 13)).html).toContain("Reminder: less than a day left");
    expect(mail(sentAt(0, 1)).html).toContain("Reminder: less than a day left");
    expect(mail(sentAt(4, 18)).html).not.toMatch(/week/);
    expect(mail(sentAt(4, 18)).text).toContain("Time left: 4 days.");
    expect(mail(sentAt(1, 13)).text).toContain("Time left: less than a day.");
  });

  it("tells a reminder from the notice", () => {
    expect(deadOrganisationEmail("reminder", "Acme", null, deleteOn, sentAt(7)).subject).toMatch(/^Reminder: /);
    expect(deadOrganisationEmail("notice", "Acme", null, deleteOn, sentAt(30)).subject).not.toMatch(/Reminder/);
    expect(deadOrganisationEmail("notice", "Acme", null, deleteOn, sentAt(30)).html).not.toMatch(/days? left|Reminder/);
  });

  it("names the export page without a link when the organisation has no address", () => {
    const { text } = deadOrganisationEmail("notice", "Acme", null, deleteOn, sentAt(30));
    expect(text).toContain("Settings → Export");
    expect(text).not.toMatch(/https?:\/\//);
  });
});
