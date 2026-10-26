import { describe, it, expect } from "vitest";
import { withUsernames } from "./mention-copy";

describe("withUsernames", () => {
  it("puts back the username of each pill, two pills of the same name included", () => {
    const pills = [
      { shown: "@Mia Member", username: "member", before: 0 },
      { shown: "@Mia Member", username: "mia2", before: 1 },
    ];
    expect(withUsernames("@Mia Member and @Mia Member", pills)).toBe("@member and @mia2");
  });

  it("leaves the same name written as plain text before the pill alone", () => {
    expect(
      withUsernames("I typed @Mia Member, the pill says @Mia Member", [
        { shown: "@Mia Member", username: "member", before: 1 },
      ])
    ).toBe("I typed @Mia Member, the pill says @member");
  });

  it("does not take a longer word that starts with the name for the pill", () => {
    expect(withUsernames("@Annabel asked @Anna", [{ shown: "@Anna", username: "anna", before: 1 }])).toBe(
      "@Annabel asked @anna"
    );
  });

  it("finds a name whose spaces the selection collapsed", () => {
    expect(withUsernames("ask @Ann Lee", [{ shown: "@Ann  Lee", username: "ann", before: 0 }])).toBe("ask @ann");
  });

  it("skips a pill whose text is not in the selection", () => {
    expect(withUsernames("just text", [{ shown: "@Mia Member", username: "member", before: 0 }])).toBe("just text");
  });
});
