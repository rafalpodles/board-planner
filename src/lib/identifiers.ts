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
