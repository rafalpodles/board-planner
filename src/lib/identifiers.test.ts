import { describe, it, expect } from "vitest";
import { isValidProjectKey, isValidUsername } from "@/lib/identifiers";

/**
 * These two strings reach a task URL and a notification title, and from there the markup of a
 * Slack or Discord message. The payloads below are the ones that worked: `>` closes a Slack link
 * and opens an attacker's, `#` and `[](…)` forge a Discord heading and a masked link.
 */
describe("a project key", () => {
  it("accepts the shapes a board actually uses", () => {
    for (const key of ["BP", "TP", "MOB", "ORB", "A1", "LONG-NAME_9"]) {
      expect(isValidProjectKey(key), key).toBe(true);
    }
  });

  it("refuses the characters that give a chat message its structure", () => {
    for (const key of [
      "A><HTTPS://PHISH.EXAMPLE|RESET YOUR PASSWORD",
      "A)[OPEN](HTTPS://PHISH.EXAMPLE)",
      "A#HEADING",
      "A|B",
      "A\nB",
      "A B",
    ]) {
      expect(isValidProjectKey(key), key).toBe(false);
    }
  });

  it("refuses the empty string, a leading digit and anything too long", () => {
    expect(isValidProjectKey("")).toBe(false);
    expect(isValidProjectKey("1BP")).toBe(false);
    expect(isValidProjectKey("A".repeat(21))).toBe(false);
    expect(isValidProjectKey("A".repeat(20))).toBe(true);
  });
});

describe("a username", () => {
  it("accepts the accounts this instance already has, including the ones it mints itself", () => {
    for (const name of [
      "admin",
      "pm",
      "rafal",
      "plain.user",
      "some-one_2",
      // worker-<24 hex>, from src/lib/worker-user.ts — 31 characters
      "worker-6a7309535eb49af333b85a04",
    ]) {
      expect(isValidUsername(name), name).toBe(true);
    }
  });

  it("refuses markup, whitespace and upper case", () => {
    for (const name of ["a>b", "a b", "a\nb", "@everyone", "Admin", "a".repeat(33), "a"]) {
      expect(isValidUsername(name), name).toBe(false);
    }
  });
});
