import { describe, expect, it } from "vitest";
import robots from "./robots";
import { metadata as loginMetadata } from "./login/layout";

describe("robots.txt", () => {
  it("keeps every crawler out of every path", () => {
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
  });
});

describe("the login page's metadata", () => {
  it("names the page and describes it in its own words", () => {
    expect(loginMetadata.title).toBe("Sign in — Board Planner");
    expect(String(loginMetadata.description)).toContain("Sign in to Board Planner");
  });
});
