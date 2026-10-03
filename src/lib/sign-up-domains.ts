import { connectDB } from "@/lib/db";
import { getSettings } from "@/models/settings";

export const MAX_SIGN_UP_DOMAINS = 50;

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

export type DomainsCheck = { ok: true; value: string[] } | { ok: false; error: string };

export function parseSignUpDomains(input: unknown): DomainsCheck {
  if (!Array.isArray(input) || input.some((d) => typeof d !== "string")) {
    return { ok: false, error: "domains must be a list of domain names" };
  }
  const domains = [...new Set(input.map((d: string) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  const invalid = domains.find((d) => !DOMAIN.test(d));
  if (invalid) return { ok: false, error: `"${invalid}" is not a domain name` };
  if (domains.length > MAX_SIGN_UP_DOMAINS) {
    return { ok: false, error: `At most ${MAX_SIGN_UP_DOMAINS} domains` };
  }
  return { ok: true, value: domains };
}

/** Exactly the domain after the @: a listed domain opens none of its subdomains. */
export async function signUpOpenTo(email: string): Promise<boolean> {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  await connectDB();
  const { signUpDomains } = await getSettings();
  return (signUpDomains ?? []).includes(email.slice(at + 1).toLowerCase());
}
