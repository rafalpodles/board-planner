import { describe, it, expect } from "vitest";
import { isNavItemActive } from "./nav-active";

describe("isNavItemActive", () => {
  it("matches the exact route", () => {
    expect(isNavItemActive("/projects", "/projects")).toBe(true);
    expect(isNavItemActive("/settings", "/settings")).toBe(true);
  });

  it("keeps the parent active on a nested route", () => {
    expect(isNavItemActive("/projects/TP", "/projects")).toBe(true);
    expect(isNavItemActive("/projects/TP/tasks/1", "/projects")).toBe(true);
    expect(isNavItemActive("/settings/users", "/settings")).toBe(true);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    expect(isNavItemActive("/my-tasksomething", "/my-tasks")).toBe(false);
    expect(isNavItemActive("/projectsettings", "/projects")).toBe(false);
    expect(isNavItemActive("/settings-old", "/settings")).toBe(false);
  });

  it("does not match an unrelated route", () => {
    expect(isNavItemActive("/notifications", "/projects")).toBe(false);
    expect(isNavItemActive("/", "/projects")).toBe(false);
  });

  it("treats a trailing slash as the same route", () => {
    expect(isNavItemActive("/projects/", "/projects")).toBe(true);
  });
});
