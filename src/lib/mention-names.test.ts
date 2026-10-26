import { describe, it, expect } from "vitest";
import { nameMentions } from "./mention-names";

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
