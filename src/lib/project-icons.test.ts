import { describe, it, expect } from "vitest";
import { ICON_GROUPS, iconGroupsCoverWhitelist, searchIcons } from "./project-icons";
import { PROJECT_ICONS } from "@/types";

describe("project icon groups", () => {
  // The server rejects anything outside PROJECT_ICONS, so a grouped icon that is not on
  // the whitelist would offer a choice that fails on save
  it("covers the whitelist exactly, with no duplicates", () => {
    expect(iconGroupsCoverWhitelist()).toBe(true);
    const grouped = ICON_GROUPS.flatMap((g) => g.icons.map((i) => i.icon));
    expect(grouped).toHaveLength(PROJECT_ICONS.length);
  });

  it("finds an icon by keyword and by group", () => {
    expect(searchIcons("bug").flatMap((g) => g.icons.map((i) => i.icon))).toContain("🐛");
    expect(searchIcons("database").flatMap((g) => g.icons.map((i) => i.icon))).toContain("🗄️");
    expect(searchIcons("planning").flatMap((g) => g.icons.map((i) => i.icon))).toContain("📋");
  });

  it("returns everything for an empty query and nothing for nonsense", () => {
    expect(searchIcons("  ")).toEqual(ICON_GROUPS);
    expect(searchIcons("zzzz")).toEqual([]);
  });
});
