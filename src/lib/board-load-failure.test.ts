import { describe, it, expect } from "vitest";
import { boardRefusal } from "./board-load-failure";

describe("boardRefusal", () => {
  it("names a refusal", () => {
    expect(boardRefusal({ status: 403, message: "Forbidden" })).toBe("You do not have access to this board.");
  });

  it("names a board that is not there", () => {
    expect(boardRefusal({ status: 404, message: "Project not found" })).toBe(
      "There is no board here — the link may be stale."
    );
  });

  it.each([[{ status: 500, message: "boom" }], [new Error("network")], [null], [undefined]])(
    "has nothing to say about an outage: %o",
    (reason) => {
      expect(boardRefusal(reason)).toBeNull();
    }
  );
});
