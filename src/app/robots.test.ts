import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots.txt", () => {
  it("lets crawlers read the pages, so the noindex on them is seen, and keeps them off the API", () => {
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/api/" });
  });
});
