import { describe, it, expect } from "vitest";
import {
  isObjectIdSegment,
  isTaskPath,
  taskRefFromPathname,
  projectPath,
  projectRefFromPathname,
  taskPath,
} from "./urls";

describe("projectRefFromPathname", () => {
  // The CP-159 regression: links moved to project keys while the widget still matched a
  // 24-hex ObjectId, so the PM chat button vanished from every project page
  it("resolves a project key", () => {
    expect(projectRefFromPathname("/projects/TP")).toBe("TP");
  });

  it("resolves a key on a nested route", () => {
    expect(projectRefFromPathname("/projects/CP/tasks/CP-12")).toBe("CP");
    expect(projectRefFromPathname("/projects/CP/settings")).toBe("CP");
  });

  it("still resolves a raw ObjectId", () => {
    const id = "6a69903ec4c79d7d07a5eda8";
    expect(projectRefFromPathname(`/projects/${id}`)).toBe(id);
    expect(projectRefFromPathname(`/projects/${id}/tasks/4`)).toBe(id);
  });

  it("tolerates a trailing slash", () => {
    expect(projectRefFromPathname("/projects/TP/")).toBe("TP");
  });

  it("accepts a lowercase key, which the API uppercases before lookup", () => {
    expect(projectRefFromPathname("/projects/tp")).toBe("tp");
  });

  it("has no ref on the projects index", () => {
    expect(projectRefFromPathname("/projects")).toBeUndefined();
    expect(projectRefFromPathname("/projects/")).toBeUndefined();
  });

  // /projects/new is a page in its own right; treating it as a project fires a doomed
  // API call and would show project chrome on the create form
  it("does not treat reserved segments as a project", () => {
    expect(projectRefFromPathname("/projects/new")).toBeUndefined();
  });

  it("ignores paths outside /projects", () => {
    expect(projectRefFromPathname("/settings/users")).toBeUndefined();
    expect(projectRefFromPathname("/my-tasks")).toBeUndefined();
    expect(projectRefFromPathname("/")).toBeUndefined();
  });

  it("handles a missing pathname", () => {
    expect(projectRefFromPathname(null)).toBeUndefined();
    expect(projectRefFromPathname(undefined)).toBeUndefined();
  });

  it("rejects a segment that is neither a key nor an id", () => {
    // leading digit, and longer than the 20-char key limit
    expect(projectRefFromPathname("/projects/1abc")).toBeUndefined();
    expect(projectRefFromPathname(`/projects/${"a".repeat(21)}`)).toBeUndefined();
  });
});

describe("isObjectIdSegment", () => {
  it("accepts 24 hex characters in either case", () => {
    expect(isObjectIdSegment("6a69903ec4c79d7d07a5eda8")).toBe(true);
    expect(isObjectIdSegment("6A69903EC4C79D7D07A5EDA8")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isObjectIdSegment("TP")).toBe(false);
    expect(isObjectIdSegment("6a69903ec4c79d7d07a5eda")).toBe(false);
    expect(isObjectIdSegment("zzz9903ec4c79d7d07a5eda8")).toBe(false);
  });
});

describe("path builders", () => {
  it("builds project and task paths from a ref", () => {
    expect(projectPath("TP")).toBe("/projects/TP");
    expect(taskPath("TP", "TP-4")).toBe("/projects/TP/tasks/TP-4");
    expect(taskPath("TP", 4)).toBe("/projects/TP/tasks/4");
  });

  // The round trip is the invariant the widget depends on
  it("round-trips through projectRefFromPathname", () => {
    expect(projectRefFromPathname(projectPath("CP"))).toBe("CP");
    expect(projectRefFromPathname(taskPath("CP", "CP-9"))).toBe("CP");
  });
});

describe("isTaskPath", () => {
  it("is a task page, and only with a task on the end of it", () => {
    expect(isTaskPath("/projects/TP/tasks/4")).toBe(true);
    expect(isTaskPath("/projects/TP/tasks/TP-4")).toBe(true);
    expect(isTaskPath("/projects/69a52e3b399b27d3cbb2c5a5/tasks/4")).toBe(true);

    expect(isTaskPath("/projects/TP/tasks")).toBe(false);
    expect(isTaskPath("/projects/TP")).toBe(false);
    expect(isTaskPath("/projects/TP/sprints")).toBe(false);
    expect(isTaskPath("/projects/new/tasks/4")).toBe(false);
    expect(isTaskPath("/my-tasks")).toBe(false);
    expect(isTaskPath("")).toBe(false);
    expect(isTaskPath(null)).toBe(false);
  });
});

describe("taskRefFromPathname", () => {
  it("reads the task off a task URL, and nothing off anything else", () => {
    expect(taskRefFromPathname("/projects/TP/tasks/4")).toBe("4");
    expect(taskRefFromPathname("/projects/TP/tasks/TP-4")).toBe("TP-4");

    expect(taskRefFromPathname("/projects/TP")).toBeUndefined();
    expect(taskRefFromPathname("/projects/TP/tasks")).toBeUndefined();
    expect(taskRefFromPathname("/my-tasks")).toBeUndefined();
    expect(taskRefFromPathname(null)).toBeUndefined();
  });
});
