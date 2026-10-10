import { describe, expect, it } from "vitest";
import { APP_NAME } from "@/lib/brand";
import { metadata } from "./layout";

describe("the login page's metadata", () => {
  it("names the page and describes it in its own words", () => {
    expect(metadata.title).toBe(`Sign in — ${APP_NAME}`);
    expect(String(metadata.description)).toMatch(new RegExp(`^Sign in to ${APP_NAME}`));
  });
});
