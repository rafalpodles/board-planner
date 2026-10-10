import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ hosted: true }));
vi.mock("@/lib/organisation-host", () => ({ organisationDomain: () => (m.hosted ? "board-planner.com" : null) }));

const { describeAiLock, describeBudgetRefusal } = await import("./refusal");

beforeEach(() => {
  m.hosted = true;
});

// BP-680: "AI is unavailable" with no number cannot be told from an outage
describe("describeBudgetRefusal", () => {
  it("names the counter, the allowance and the day it renews, for a month", () => {
    expect(describeBudgetRefusal({ scope: "month", used: 15_000_000, limit: 15_000_000, resetsAt: new Date("2026-11-01T00:00:00Z") })).toBe(
      "AI is unavailable: this organisation has used 15,000,000 of 15,000,000 AI tokens, its allowance for the month. It renews on 1 November 2026 (UTC). Add your own key in Settings → AI key to keep going."
    );
  });

  it("names the trial's allowance, which does not renew", () => {
    const text = describeBudgetRefusal({ scope: "trial", used: 3_000_000, limit: 3_000_000, resetsAt: new Date("2026-11-08T23:59:59Z") });

    expect(text).toBe("AI is unavailable: this organisation has used 3,000,000 of 3,000,000 AI tokens, the allowance of its trial. Add your own key in Settings → AI key to keep going.");
    expect(text).not.toMatch(/renews/);
  });

  it("says a day's ceiling is for today and when it ends", () => {
    expect(describeBudgetRefusal({ scope: "day", used: 3_000_000, limit: 3_000_000, resetsAt: new Date("2026-10-10T00:00:00Z") })).toBe(
      "AI is paused for today: this organisation has used 3,000,000 of 3,000,000 AI tokens of its daily ceiling. It starts again at 00:00 UTC, 10 October 2026. Add your own key in Settings → AI key to keep going."
    );
  });

  it("does not send the owner of a self-hosted instance to a key it can set in its environment", () => {
    m.hosted = false;

    expect(describeBudgetRefusal({ scope: "month", used: 5, limit: 5, resetsAt: new Date("2026-11-01T00:00:00Z") })).not.toMatch(/own key/);
  });
});

describe("describeAiLock", () => {
  it("says the operator switched the key off, why, and what keeps AI going on the cloud", () => {
    expect(describeAiLock("abuse report 17")).toBe("AI is switched off for this organisation by the operator: abuse report 17. Add your own key in Settings → AI key to keep going.");
  });

  it("ends the reason with one full stop whether it brought one or not, and says nothing of a reason when there is none", () => {
    expect(describeAiLock("abuse report 17.  ")).toBe(describeAiLock("abuse report 17"));
    expect(describeAiLock("")).toBe("AI is switched off for this organisation by the operator. Add your own key in Settings → AI key to keep going.");
  });

  it("does not send a self-hosted owner to a key it sets in its environment", () => {
    m.hosted = false;

    expect(describeAiLock("")).toBe("AI is switched off for this organisation by the operator.");
  });
});
