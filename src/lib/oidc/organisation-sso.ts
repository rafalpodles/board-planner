import { allowLoopbackIn } from "@/lib/github";

export const SSO_LABEL_DEFAULT = "Single sign-on";
const MAX_FIELD = 300;
const MAX_LABEL = 40;
const MIN_SECRET = 12;
const MAX_SECRET = 500;
const MAX_GROUP = 200;
const MAX_CLAIM = 100;

export interface SsoInput {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  label: string;
  adminGroup: string | null;
  groupsClaim: string | null;
}

// Printable ASCII with no space: what travels in a header or a form field without surprises
const token = (value: string) => /^[\x21-\x7e]+$/.test(value);

function checkIssuer(raw: string): string | null {
  const issuer = raw.trim();
  if (!issuer || issuer.length > MAX_FIELD) return null;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return null;
  }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  const schemeOk = url.protocol === "https:" || (url.protocol === "http:" && loopback && allowLoopbackIn());
  if (!schemeOk || url.username || url.password || url.search || url.hash) return null;
  // The identifier is what the provider's document names, not the address of that document; and Google's is
  // offered already, with its own rule about whose addresses it vouches for
  if (url.pathname.includes("/.well-known/") || url.hostname === "accounts.google.com") return null;
  return issuer;
}

/** What an administrator typed, or the one thing wrong with it. The secret is null when it was left blank. */
export function parseSsoInput(body: unknown): { ok: true; value: SsoInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "Expected an object" };
  const { issuer, clientId, clientSecret, label, adminGroup, groupsClaim } = body as Record<string, unknown>;

  const checkedIssuer = typeof issuer === "string" ? checkIssuer(issuer) : null;
  if (!checkedIssuer) return { ok: false, error: "The issuer must be your provider's https address with no query, fragment or credentials, and not its /.well-known/ document or Google, which is offered already" };
  if (typeof clientId !== "string" || !clientId.trim() || clientId.length > MAX_FIELD || !token(clientId.trim())) {
    return { ok: false, error: "The client ID must be 1 to 300 printable characters with no spaces" };
  }
  let secret: string | null = null;
  if (clientSecret !== undefined && clientSecret !== null && clientSecret !== "") {
    if (typeof clientSecret !== "string" || clientSecret.length < MIN_SECRET || clientSecret.length > MAX_SECRET || !token(clientSecret)) {
      return { ok: false, error: `The client secret must be ${MIN_SECRET} to ${MAX_SECRET} printable characters with no spaces` };
    }
    secret = clientSecret;
  }
  const name = label === undefined || label === null || label === "" ? SSO_LABEL_DEFAULT : label;
  if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_LABEL || /[\x00-\x1f<>]/.test(name)) {
    return { ok: false, error: `The button name must be 1 to ${MAX_LABEL} characters` };
  }
  const group = typeof adminGroup === "string" ? adminGroup.trim() : adminGroup;
  if (group !== undefined && group !== null && (typeof group !== "string" || group.length > MAX_GROUP || /[\x00-\x1f]/.test(group))) {
    return { ok: false, error: `The admin group must be at most ${MAX_GROUP} characters` };
  }
  const claim = typeof groupsClaim === "string" ? groupsClaim.trim() : groupsClaim;
  if (claim !== undefined && claim !== null && (typeof claim !== "string" || claim.length > MAX_CLAIM || (claim !== "" && !token(claim)))) {
    return { ok: false, error: `The groups claim must be at most ${MAX_CLAIM} printable characters with no spaces` };
  }
  return {
    ok: true,
    value: { issuer: checkedIssuer, clientId: clientId.trim(), clientSecret: secret, label: name.trim(), adminGroup: group || null, groupsClaim: claim || null },
  };
}
