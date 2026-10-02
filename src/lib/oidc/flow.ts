import * as client from "openid-client";
import { connectDB } from "@/lib/db";
import { normaliseEmail } from "@/lib/email";
import { randomToken, sha256 } from "@/lib/oauth";
import { githubApiBase } from "@/lib/github-host";
import { OidcFlow } from "@/models/oidcFlow";
import { OidcProvider } from "./providers";

export const FLOW_COOKIE = "bp_oidc";
export const ACCEPT_COOKIE = "bp_oidc_accept";
export const FLOW_TTL_MS = 10 * 60 * 1000;
export const ACCEPT_TTL_MS = 15 * 60 * 1000;

const configs = new Map<string, Promise<client.Configuration>>();

// Plain http is accepted only from an issuer on this machine: a local identity provider in
// development and the e2e rig's stub. Addresses, not names, so no resolver decides it.
function isLoopback(issuer: URL): boolean {
  return ["127.0.0.1", "[::1]"].includes(issuer.hostname);
}

function githubConfig(provider: OidcProvider): client.Configuration {
  const site = new URL(provider.issuer);
  const config = new client.Configuration(
    {
      issuer: provider.issuer,
      authorization_endpoint: `${provider.issuer}/login/oauth/authorize`,
      token_endpoint: `${provider.issuer}/login/oauth/access_token`,
    },
    provider.clientId,
    undefined,
    client.ClientSecretPost(provider.clientSecret)
  );
  if (site.protocol === "http:" && isLoopback(site)) client.allowInsecureRequests(config);
  return config;
}

function configFor(provider: OidcProvider): Promise<client.Configuration> {
  if (provider.kind === "github") return Promise.resolve(githubConfig(provider));
  const key = `${provider.id}:${provider.issuer}:${provider.clientId}`;
  let config = configs.get(key);
  if (!config) {
    const issuer = new URL(provider.issuer);
    config = client
      .discovery(issuer, provider.clientId, provider.clientSecret, undefined, {
        execute: issuer.protocol === "http:" && isLoopback(issuer) ? [client.allowInsecureRequests] : [],
      })
      .catch((err) => {
        configs.delete(key);
        throw err;
      });
    configs.set(key, config);
  }
  return config;
}

export function redirectUri(provider: OidcProvider, origin: string): string {
  return `${origin}/api/auth/oidc/${provider.id}/callback`;
}

export async function beginFlow(input: {
  provider: OidcProvider;
  origin: string;
  intent: "signin" | "invite" | "link";
  invitationToken?: string;
  userId?: string;
}): Promise<{ url: string; binder: string }> {
  const config = await configFor(input.provider);
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const github = input.provider.kind === "github";
  const nonce = github ? "-" : client.randomNonce();
  const binder = randomToken("cpo_");

  await connectDB();
  await OidcFlow.create({
    binderHash: sha256(binder),
    provider: input.provider.id,
    state,
    nonce,
    codeVerifier,
    intent: input.intent,
    invitationTokenHash: input.invitationToken ? sha256(input.invitationToken) : null,
    user: input.userId ?? null,
    expiresAt: new Date(Date.now() + FLOW_TTL_MS),
  });

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(input.provider, input.origin),
    scope: github ? "read:user user:email" : "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    ...(github ? {} : { nonce }),
  });
  return { url: url.href, binder };
}

export interface VerifiedClaims {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export type FlowOutcome =
  | {
      ok: true;
      intent: "signin" | "invite" | "link";
      invitationTokenHash: string | null;
      userId: string | null;
      claims: VerifiedClaims;
    }
  | { ok: false; reason: "no_flow" | "rejected" };

/**
 * Spends the flow the browser's cookie names — once, whatever happens next — and has the library
 * check the code, the state, the nonce and the PKCE verifier against what this server issued.
 */
export async function finishFlow(input: {
  provider: OidcProvider;
  binder: string | null;
  origin: string;
  query: string;
}): Promise<FlowOutcome> {
  if (!input.binder) return { ok: false, reason: "no_flow" };
  await connectDB();
  const flow = await OidcFlow.findOneAndDelete({
    binderHash: sha256(input.binder),
    provider: input.provider.id,
    expiresAt: { $gt: new Date() },
    claims: null,
  });
  if (!flow) return { ok: false, reason: "no_flow" };

  try {
    const config = await configFor(input.provider);
    const callbackUrl = new URL(`${redirectUri(input.provider, input.origin)}${input.query}`);
    let verified: VerifiedClaims | null;
    if (input.provider.kind === "github") {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
      });
      verified = await githubPerson(input.provider, tokens.access_token);
    } else {
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      verified = idTokenPerson(input.provider, tokens.claims());
    }
    if (!verified) return { ok: false, reason: "rejected" };
    return {
      ok: true,
      intent: flow.intent,
      invitationTokenHash: flow.invitationTokenHash,
      userId: flow.user ? String(flow.user) : null,
      claims: verified,
    };
  } catch (err) {
    console.error(`OIDC callback from ${input.provider.id} refused:`, err);
    return { ok: false, reason: "rejected" };
  }
}

function idTokenPerson(
  provider: OidcProvider,
  claims: client.IDToken | undefined
): VerifiedClaims | null {
  if (!claims?.sub || !claims.iss) return null;
  const email = typeof claims.email === "string" ? normaliseEmail(claims.email) : "";
  return {
    issuer: String(claims.iss),
    subject: String(claims.sub),
    email,
    emailVerified: claims.email_verified === true && ownsTheAddress(provider, email, claims),
    name: typeof claims.name === "string" ? claims.name : "",
  };
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * GitHub has no ID token: the person is its numeric user id, and the address is the one
 * `/user/emails` marks verified, the primary first. The issuer is the site, so an Enterprise
 * Server's ids never meet github.com's.
 */
async function githubPerson(provider: OidcProvider, accessToken: string): Promise<VerifiedClaims | null> {
  const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}` };
  const get = async (path: string) => {
    const res = await fetch(`${githubApiBase()}${path}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
    return res.json();
  };
  const [person, emails] = (await Promise.all([get("/user"), get("/user/emails")])) as [
    { id?: unknown; login?: unknown; name?: unknown },
    GitHubEmail[],
  ];
  if (typeof person.id !== "number" && typeof person.id !== "string") return null;
  const listed = Array.isArray(emails) ? emails.filter((e) => typeof e?.email === "string") : [];
  const chosen =
    listed.find((e) => e.primary && e.verified === true) ??
    listed.find((e) => e.verified === true) ??
    listed.find((e) => e.primary) ??
    null;
  return {
    issuer: provider.issuer,
    subject: String(person.id),
    email: chosen ? normaliseEmail(chosen.email) : "",
    emailVerified: chosen?.verified === true,
    name: typeof person.name === "string" && person.name ? person.name : typeof person.login === "string" ? person.login : "",
  };
}

/**
 * Google marks any address verified once it has seen one mail arrive there, including a consumer
 * account opened on a company address years ago. It only speaks for the mailbox for its own
 * domain, or for one a Workspace (`hd`) manages (Google's own guidance).
 */
function ownsTheAddress(provider: OidcProvider, email: string, claims: Record<string, unknown>): boolean {
  if (provider.id !== "google") return true;
  return (
    email.endsWith("@gmail.com") ||
    email.endsWith("@googlemail.com") ||
    (typeof claims.hd === "string" && claims.hd.length > 0)
  );
}

/** A verified identity waiting for its owner to choose a username, held for one invitation. */
export async function holdForAcceptance(input: {
  provider: OidcProvider;
  invitationTokenHash: string;
  claims: VerifiedClaims;
}): Promise<string> {
  const binder = randomToken("cpo_");
  await connectDB();
  await OidcFlow.create({
    binderHash: sha256(binder),
    provider: input.provider.id,
    state: "-",
    nonce: "-",
    codeVerifier: "-",
    intent: "invite",
    invitationTokenHash: input.invitationTokenHash,
    claims: { issuer: input.claims.issuer, subject: input.claims.subject, email: input.claims.email },
    expiresAt: new Date(Date.now() + ACCEPT_TTL_MS),
  });
  return binder;
}

export async function heldAcceptance(binder: string | null) {
  if (!binder) return null;
  await connectDB();
  return OidcFlow.findOne({
    binderHash: sha256(binder),
    intent: "invite",
    claims: { $ne: null },
    expiresAt: { $gt: new Date() },
  }).lean();
}

export async function spendAcceptance(binder: string): Promise<void> {
  await connectDB();
  await OidcFlow.deleteOne({ binderHash: sha256(binder), claims: { $ne: null } });
}
