import { PROJECT_KEY_MAX_LENGTH, PROJECT_KEY_PATTERN } from "@/lib/urls";

export { PROJECT_KEY_MAX_LENGTH, PROJECT_KEY_PATTERN };

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export const PROJECT_KEY_RULE =
  `A project key starts with a letter and may hold up to ${PROJECT_KEY_MAX_LENGTH} letters, digits, hyphens or underscores`;
export const USERNAME_RULE =
  "A username is lower-case, starts with a letter or digit, and may hold up to 32 letters, digits, dots, hyphens or underscores";

export function isValidProjectKey(key: string): boolean {
  return PROJECT_KEY_PATTERN.test(key);
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export const FULL_NAME_MAX_LENGTH = 80;

export const FULL_NAME_RULE = `A name cannot be blank, must be at most ${FULL_NAME_MAX_LENGTH} characters, and cannot contain line breaks or other control characters`;

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

export function stripControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    if (!isControlCodePoint(character.codePointAt(0) ?? 0)) out += character;
  }
  return out;
}

export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    if (isControlCodePoint(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

export function normaliseFullName(fullName: string): string {
  return fullName.trim();
}

export function isValidFullName(fullName: string): boolean {
  if (fullName.length === 0 || fullName.length > FULL_NAME_MAX_LENGTH) return false;
  return !hasControlCharacters(fullName);
}

const INVISIBLE_CATEGORIES = /[\s\p{Cc}\p{Cf}\p{Zs}]/u;
const HANGUL_FILLERS = new Set([0x3164, 0xffa0]);

export function rendersBlank(value: string): boolean {
  for (const character of value) {
    if (HANGUL_FILLERS.has(character.codePointAt(0) ?? 0)) continue;
    if (!INVISIBLE_CATEGORIES.test(character)) return false;
  }
  return true;
}

export const TASK_TITLE_MAX_LENGTH = 200;
export const CRITERION_TEXT_MAX_LENGTH = 500;

export const TASK_TITLE_RULE = `A title must be at most ${TASK_TITLE_MAX_LENGTH} characters and cannot contain zero-width, bidi or other control characters`;
export const CRITERION_TEXT_RULE = `An acceptance criterion must be at most ${CRITERION_TEXT_MAX_LENGTH} characters and cannot contain zero-width, bidi or other control characters`;

export function isValidTaskTitle(title: string): boolean {
  if (rendersBlank(title) || title.length > TASK_TITLE_MAX_LENGTH) return false;
  return !hasControlCharacters(title);
}

export function isValidCriterionText(text: string): boolean {
  if (rendersBlank(text) || text.length > CRITERION_TEXT_MAX_LENGTH) return false;
  return !hasControlCharacters(text);
}
