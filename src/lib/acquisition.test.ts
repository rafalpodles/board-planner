import { describe, it, expect } from "vitest";
import { acquisitionFromLanding, readAcquisition } from "./acquisition";

describe("readAcquisition (BP-1135)", () => {
  it("keeps the campaign tags and a referrer host", () => {
    expect(readAcquisition({ source: "reddit", medium: "cpc", campaign: "launch-2026q4", referrerHost: "News.YCombinator.com" })).toEqual({
      source: "reddit",
      medium: "cpc",
      campaign: "launch-2026q4",
      referrerHost: "news.ycombinator.com",
    });
  });

  it("drops what is odd rather than refusing, and answers null when nothing is left", () => {
    expect(readAcquisition({ source: "<script>", medium: 7, campaign: " spring ", referrerHost: "https://x.example/path" })).toEqual({ campaign: "spring" });
    expect(readAcquisition({ source: "a b", referrerHost: "localhost" })).toBeNull();
    expect(readAcquisition({ source: { $ne: null } })).toBeNull();
    for (const value of [undefined, null, "reddit", ["reddit"], 1]) expect(readAcquisition(value)).toBeNull();
  });

  it("cuts an over-long tag to 100 characters and drops an over-long host", () => {
    expect(readAcquisition({ source: "a".repeat(500) })).toEqual({ source: "a".repeat(100) });
    expect(readAcquisition({ referrerHost: `${"a".repeat(60)}.`.repeat(5) + "com" })).toBeNull();
  });

  it("stores only the four fields it names", () => {
    expect(readAcquisition({ source: "reddit", email: "bill@initech.example", at: "2020-01-01" })).toEqual({ source: "reddit" });
  });
});

describe("acquisitionFromLanding (BP-1135)", () => {
  const OWN = "login.board-planner.com";

  it("reads the utm tags and the site's ref", () => {
    expect(acquisitionFromLanding("?start&utm_source=reddit&utm_medium=cpc&utm_campaign=launch&ref=www.reddit.com", "https://board-planner.com/", OWN)).toEqual({
      source: "reddit",
      medium: "cpc",
      campaign: "launch",
      referrerHost: "www.reddit.com",
    });
  });

  it("takes the referrer's host when no ref came, but never one of our own hosts", () => {
    expect(acquisitionFromLanding("?start", "https://news.ycombinator.com/item?id=1", OWN)).toEqual({ referrerHost: "news.ycombinator.com" });
    for (const own of ["https://board-planner.com/pricing/", "https://acme.board-planner.com/", "https://login.board-planner.com/?start"]) {
      expect(acquisitionFromLanding("?start", own, OWN)).toBeNull();
    }
    expect(acquisitionFromLanding("?ref=board-planner.com", "", OWN)).toBeNull();
  });

  it("answers null for a plain visit", () => {
    expect(acquisitionFromLanding("", "", OWN)).toBeNull();
    expect(acquisitionFromLanding("?start", "not a url", OWN)).toBeNull();
  });

  it("reads a two-label host as its own domain", () => {
    expect(acquisitionFromLanding("", "https://sub.localtest.me/", "localtest.me")).toBeNull();
  });
});
