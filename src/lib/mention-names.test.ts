import { describe, it, expect } from "vitest";
import { nameMentions } from "./mention-names";
import { withUsernames } from "./mention-copy";

const PEOPLE = [
  { username: "member", fullName: "Mia Member" },
  { username: "jan.kowalski", fullName: "Jan Kowalski" },
  { username: "bot", fullName: "  " },
];

describe("nameMentions", () => {
  it("writes each person of the board by name and leaves anybody else as written", () => {
    expect(nameMentions("TP-5 → @member, cc @Jan.Kowalski. Ask @stranger", PEOPLE)).toBe(
      "TP-5 → @Mia Member, cc @Jan Kowalski. Ask @stranger"
    );
  });

  it("keeps the username of a person with no name, and leaves an e-mail address alone", () => {
    expect(nameMentions("@bot wrote to ops@member.example", PEOPLE)).toBe("@bot wrote to ops@member.example");
  });

  it("returns the text as it was when nobody is known", () => {
    expect(nameMentions("@member", [])).toBe("@member");
  });
});

describe("withUsernames", () => {
  it("puts back the username of each pill in order, even when a name repeats in plain text", () => {
    const pills = [
      { shown: "@Mia Member", username: "member" },
      { shown: "@Mia Member", username: "mia2" },
    ];
    expect(withUsernames("@Mia Member and @Mia Member", pills)).toBe("@member and @mia2");
  });

  it("skips a pill whose text is not in the selection", () => {
    expect(withUsernames("just text", [{ shown: "@Mia Member", username: "member" }])).toBe("just text");
  });
});
