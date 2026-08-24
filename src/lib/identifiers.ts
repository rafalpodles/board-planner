import { PROJECT_KEY_PATTERN } from "@/lib/urls";

/**
 * A project key and a username are not free text. Both are interpolated into places that give
 * their characters meaning — a task URL, a notification title, and from there the markup of a
 * Slack or Discord message, where `>` closes a link and `#` opens a heading. Escaping at each of
 * those sinks has been tried and keeps missing one: the character sets differ per service, and a
 * new sink arrives without one. Constraining the source is the version that stays fixed (BP-401).
 *
 * `PROJECT_KEY_PATTERN` is reused rather than restated: it is what the router already accepts as a
 * project segment, so a key it would refuse to route was never usable anyway.
 */
export { PROJECT_KEY_PATTERN };

/**
 * Lower-case, and long enough for the machine accounts this instance mints itself
 * (`worker-<24 hex>` is 31 characters — see `src/lib/worker-user.ts`).
 */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export const PROJECT_KEY_RULE =
  "A project key starts with a letter and may hold up to 20 letters, digits, hyphens or underscores";
export const USERNAME_RULE =
  "A username is lower-case, starts with a letter or digit, and may hold up to 32 letters, digits, dots, hyphens or underscores";

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_PATTERN.test(key);
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

/**
 * A display name is free text — it has to hold anybody's name, in any script, so a pattern that
 * enumerated the allowed characters would refuse somebody theirs. What it may not hold is a
 * control character. The sinks BP-401 constrained a username for read this field too: a
 * notification title on its way into a Slack or Discord message, and the PM agent's system prompt
 * (`src/lib/pm/agent.ts`), where a newline ends the line the instruction was written on.
 *
 * A source constraint, not an escaping layer: these characters never reach a sink because they are
 * never stored. It says nothing about the characters that are — a name is still text somebody
 * chose, and every renderer still has to treat it as text.
 */
export const FULL_NAME_MAX_LENGTH = 80;

export const FULL_NAME_RULE = `A name cannot be blank, must be at most ${FULL_NAME_MAX_LENGTH} characters, and cannot contain line breaks or other control characters`;

// C0, DEL and C1; the two Unicode separators that break a line in a renderer without being matched
// by \s in a JavaScript regex; and the bidi-override, bidi-isolate and zero-width family — the
// characters a "Trojan Source"-style payload uses to make a name RENDER as something other than
// what it is, which control-character stripping alone does not stop (BP-413 review). That distinct
// risk is why this range is wider than "characters that break layout": U+202E (RTL override) does
// not break a line or reach any script sink, it just lies to whoever reads the string with their
// own eyes — which for an unauthenticated machine's name is the entire trust boundary a person's
// approval click depends on.
//
// Exported so a writer that cannot refuse a name outright — a machine's own display name has
// nobody to hand a 400 to and ask to retype (BP-413) — can strip the same characters this refuses,
// rather than restating the set.
export function isControlCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) || // zero-width space/joiners, and the LTR/RTL marks
    (code >= 0x202a && code <= 0x202e) || // bidi embeds and overrides
    (code >= 0x2066 && code <= 0x2069) || // bidi isolates
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff // BOM / zero-width no-break space
  );
}

// Dropped rather than refused: the writers that need this (a machine's own name, BP-413) have
// nobody to hand a 400 to and ask to retype.
export function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    if (!isControlCodePoint(character.codePointAt(0) ?? 0)) out += character;
  }
  return out;
}

// The schema trims, so validate what will be stored — checking the untrimmed string is what let a
// name of nothing but spaces past the admin form's `!fullName` check and into a 500 (BP-410).
export function normaliseFullName(fullName: string): string {
  return fullName.trim();
}

export function isValidFullName(fullName: string): boolean {
  if (fullName.length === 0 || fullName.length > FULL_NAME_MAX_LENGTH) return false;
  for (const character of fullName) {
    if (isControlCodePoint(character.codePointAt(0) ?? 0)) return false;
  }
  return true;
}
