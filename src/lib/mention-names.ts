import { MENTION } from "@/lib/mentions";

export interface MentionablePerson {
  username: string;
  fullName: string;
}

export function nameOf(person: MentionablePerson): string {
  return (typeof person.fullName === "string" && person.fullName.trim()) || person.username;
}

export function peopleByUsername(people: readonly MentionablePerson[]): Map<string, MentionablePerson> {
  return new Map(
    people.filter((p) => typeof p.username === "string").map((p) => [p.username.toLowerCase(), p])
  );
}

/** Plain text with every `@username` of these people written as `@Full Name`, and anyone else left as written. */
export function nameMentions(text: string, people: readonly MentionablePerson[]): string {
  if (!text || people.length === 0) return text;
  const byUsername = peopleByUsername(people);
  return text.replace(new RegExp(MENTION, "g"), (whole, username: string) => {
    const person = byUsername.get(username.toLowerCase());
    return person ? `@${nameOf(person)}` : whole;
  });
}
