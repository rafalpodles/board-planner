import { describe, it, expect } from "vitest";
import { pmThreadFilter } from "./thread";

function matches(filter: Record<string, unknown>, doc: Record<string, unknown>): boolean {
  if (filter.project !== doc.project) return false;
  const branches = filter.$or as Record<string, unknown>[];
  return branches.some((b) => {
    if ("triggeredBy" in b) return b.triggeredBy === doc.triggeredBy;
    const t = b["trigger.type"] as { $ne?: string };
    return doc.triggerType !== t.$ne;
  });
}

const PROJECT = "project-1";
const ALICE = "user-alice";
const BOB = "user-bob";
const PM = "user-pm";

const filter = pmThreadFilter(PROJECT, ALICE);

describe("pmThreadFilter", () => {
  it("scopes to one project", () => {
    expect(filter.project).toBe(PROJECT);
  });

  it("keeps the caller's own chat", () => {
    expect(
      matches(filter, { project: PROJECT, triggeredBy: ALICE, triggerType: "chat" })
    ).toBe(true);
  });

  it("excludes another user's chat", () => {
    expect(
      matches(filter, { project: PROJECT, triggeredBy: BOB, triggerType: "chat" })
    ).toBe(false);
  });

  it("keeps autonomous turns whoever they are attributed to", () => {
    expect(
      matches(filter, { project: PROJECT, triggeredBy: PM, triggerType: "daily_review" })
    ).toBe(true);
    expect(
      matches(filter, {
        project: PROJECT,
        triggeredBy: PM,
        triggerType: "needs_human_review",
      })
    ).toBe(true);
  });

  it("excludes another project entirely", () => {
    expect(
      matches(filter, { project: "other", triggeredBy: ALICE, triggerType: "chat" })
    ).toBe(false);
  });

  it("gives each user a different filter", () => {
    expect(pmThreadFilter(PROJECT, BOB)).not.toEqual(filter);
  });
});
