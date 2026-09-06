import { describe, it, expect } from "vitest";
import { LIST_REFRESH_FAILED } from "./list-refresh";

/**
 * The constant exists so its two writers cannot drift; spelled out here so it still has a second
 * opinion. Every other assertion compares it against itself, which would hold just as well for an
 * empty string.
 */
describe("the message a failed list refresh shows", () => {
  it("says what failed, what to do, and claims no verb for the write that landed", () => {
    expect(LIST_REFRESH_FAILED).toBe("The list could not be refreshed — reload the page to see it");
    expect(LIST_REFRESH_FAILED.toLowerCase()).not.toContain("saved");
    expect(LIST_REFRESH_FAILED.toLowerCase()).not.toContain("deleted");
  });
});
