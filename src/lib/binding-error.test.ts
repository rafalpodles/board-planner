import { describe, expect, it } from "vitest";
import { bindingErrorFor, describeBindingError } from "./binding-error";

const P1 = "6ab294ae60cb176ff84c443e";
const P2 = "6ab2986860cb176ff84c4fc4";

describe("bindingErrorFor", () => {
  it("finds this project's entry among the others", () => {
    const line = `could not read repos.json: EACCES; ${P2}: no checkout of git@github.com:a/b.git on this machine; ${P1}: /private/tmp/recurro is under the sensitive directory /private/tmp`;

    expect(bindingErrorFor(line, P1)).toBe("/private/tmp/recurro is under the sensitive directory /private/tmp");
    expect(bindingErrorFor(line, P2)).toBe("no checkout of git@github.com:a/b.git on this machine");
  });

  it("keeps a reason that has a semicolon of its own", () => {
    expect(bindingErrorFor(`${P1}: first; second`, P1)).toBe("first; second");
  });

  it("says nothing about a project the line does not name", () => {
    expect(bindingErrorFor(`${P2}: refused`, P1)).toBe("");
    expect(bindingErrorFor("could not read repos.json: ENOENT", P1)).toBe("");
    expect(bindingErrorFor("", P1)).toBe("");
    expect(bindingErrorFor(undefined, P1)).toBe("");
  });

  it("does not take a project id quoted inside another entry's reason", () => {
    expect(bindingErrorFor(`${P2}: /x/${P1}: odd`, P1)).toBe("");
  });
});

describe("describeBindingError", () => {
  it("says a refused directory in the words of what to do", () => {
    expect(
      describeBindingError("/private/tmp/recurro is under the sensitive directory /private/tmp")
    ).toBe(
      "its checkout is in /private/tmp, a directory the worker refuses to work in. Move the checkout somewhere else, such as your home folder, and update repos.json on that machine."
    );
  });

  it("names repos.json for a checkout the machine never granted", () => {
    expect(describeBindingError("/Users/a/x is not approved on this machine — add it to repos.json")).toMatch(
      /not listed in repos\.json/
    );
    expect(describeBindingError("no checkout of https://github.com/a/b on this machine")).toMatch(
      /no checkout of this board's repository/
    );
  });

  it("passes a reason it does not recognise through whole", () => {
    expect(describeBindingError("/x is not its own git toplevel")).toBe(
      "the worker refused its checkout: /x is not its own git toplevel"
    );
  });
});
