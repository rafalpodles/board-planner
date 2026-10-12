import { describe, it, expect } from "vitest";
import { boardRefusal } from "./board-load-failure";

describe("boardRefusal", () => {
  it("names a refusal", () => {
    expect(boardRefusal({ status: 403, message: "Forbidden" })).toBe("We couldn’t find this page. The link may have changed, or this page may not be available to you.");
  });

  it("names a board that is not there", () => {
    expect(boardRefusal({ status: 404, message: "Project not found" })).toBe(
      "We couldn’t find this page. The link may have changed, or this page may not be available to you."
    );
  });

  it.each([[{ status: 500, message: "boom" }], [new Error("network")], [null], [undefined]])(
    "has nothing to say about an outage: %o",
    (reason) => {
      expect(boardRefusal(reason)).toBeNull();
    }
  );
});
