import { describe, it, expect } from "vitest";
import { boardLoadFailure } from "./board-load-failure";

describe("boardLoadFailure", () => {
  it("names a refusal as a refusal, with nothing to retry", () => {
    expect(boardLoadFailure({ status: 403, message: "Forbidden" }, "This board")).toEqual({
      message: "You do not have access to this board.",
      retryable: false,
    });
  });

  it("names a missing board differently from a refused one", () => {
    const missing = boardLoadFailure({ status: 404, message: "Project not found" }, "This board");
    expect(missing.message).toBe("There is no board here — the link may be stale.");
    expect(missing.retryable).toBe(false);
  });

  // The server's words for these two are deliberately unhelpful, and must not reach the reader
  it("does not echo the server's text for a refusal", () => {
    expect(boardLoadFailure({ status: 403, message: "Forbidden" }, "This board").message).not.toContain(
      "Forbidden"
    );
  });

  it("passes any other failure through in the server's own words, and offers a retry", () => {
    expect(boardLoadFailure({ status: 500, message: "the database went away" }, "The dashboard")).toEqual({
      message: "The dashboard could not be loaded: the database went away",
      retryable: true,
    });
  });

  it("still says something for a failure that carries no message at all", () => {
    expect(boardLoadFailure(undefined, "This board")).toEqual({
      message: "This board could not be loaded.",
      retryable: true,
    });
  });
});
