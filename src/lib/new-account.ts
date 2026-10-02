import {
  FULL_NAME_RULE,
  isReservedUsername,
  isValidFullName,
  isValidUsername,
  normaliseFullName,
  USERNAME_RULE,
} from "@/lib/identifiers";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth";
import { isValidEmail, normaliseEmail } from "@/lib/email";

export interface NewAccountFields {
  username: string;
  fullName: string;
  email: string;
  password: string;
}

export type NewAccountCheck = { ok: true; value: NewAccountFields } | { ok: false; error: string };

export type ProfileCheck =
  | { ok: true; value: { username: string; fullName: string } }
  | { ok: false; error: string };

/** The two fields every account has, password or not. */
export function checkProfile(body: { username?: unknown; fullName?: unknown }): ProfileCheck {
  const { username, fullName } = body;
  if (!username || !fullName) return { ok: false, error: "username and fullName are required" };
  // Validate what will be stored, trim included — the schema trims, so checking the untrimmed
  // string refused names that would have been stored perfectly well. A username reaches a
  // notification title and from there a chat message, where its characters stop being
  // decoration (BP-401).
  const storedUsername = String(username).trim().toLowerCase();
  if (!isValidUsername(storedUsername)) return { ok: false, error: USERNAME_RULE };
  if (isReservedUsername(storedUsername)) return { ok: false, error: "That username is reserved" };
  // A name of nothing but spaces passes the truthiness check above, and the schema then trims it
  // to "" and refuses it as `required` — a 400 arriving as a 500 (BP-410).
  const storedFullName = normaliseFullName(String(fullName));
  if (!isValidFullName(storedFullName)) return { ok: false, error: FULL_NAME_RULE };
  return { ok: true, value: { username: storedUsername, fullName: storedFullName } };
}

export function checkNewAccount(body: {
  username?: unknown;
  fullName?: unknown;
  email?: unknown;
  password?: unknown;
}): NewAccountCheck {
  const { username, password, fullName } = body;
  if (!username || !password || !fullName) {
    return { ok: false, error: "username, password, and fullName are required" };
  }
  const profile = checkProfile(body);
  if (!profile.ok) return profile;
  const { username: storedUsername, fullName: storedFullName } = profile.value;

  if (body.email !== undefined && typeof body.email !== "string") {
    return { ok: false, error: "Invalid email" };
  }
  const email = typeof body.email === "string" ? normaliseEmail(body.email) : "";
  if (email && !isValidEmail(email)) {
    return { ok: false, error: "That does not look like an email address" };
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return {
    ok: true,
    value: { username: storedUsername, fullName: storedFullName, email, password },
  };
}
