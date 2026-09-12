import { describe, expect, it } from "vitest";
import { unstuff } from "./smtp-stub.mjs";

/**
 * BP-465. The stub keeps what it is handed, and a spec asserts on the task title inside it. Every
 * message this suite sends happens to be free of dot-stuffing, so this transform has no other
 * witness.
 */
describe("the mail stub's dot un-stuffing", () => {
  it("restores a body line the client had to double", () => {
    expect(unstuff("Subject: s\r\n\r\n..leading dot line\r\nordinary\r\n")).toBe(
      "Subject: s\r\n\r\n.leading dot line\r\nordinary\r\n"
    );
  });

  it("leaves a dot that is not at the start of a line alone", () => {
    expect(unstuff("version 1..2 of the thing\r\n")).toBe("version 1..2 of the thing\r\n");
  });

  it("takes one dot off, not every dot", () => {
    expect(unstuff("...three\r\n")).toBe("..three\r\n");
  });

  it("does the same to the first line as to the rest", () => {
    expect(unstuff("..first")).toBe(".first");
  });
});
