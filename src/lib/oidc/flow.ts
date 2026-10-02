import * as client from "openid-client";
import { connectDB } from "@/lib/db";
import { normaliseEmail } from "@/lib/email";
import { randomToken, sha256 } from "@/lib/oauth";
import { OidcFlow } from "@/models/oidcFlow";
import { OidcProvider } from "./providers";

export const FLOW_COOKIE = "bp_oidc";
export const ACCEPT_COOKIE = "bp_oidc_accept";
export const FLOW_TTL_MS = 10 * 60 * 1000;
export const ACCEPT_TTL_MS = 15 * 60 * 1000;

const configs = new Map<string, Promise<client.Configuration>>();

// Plain http is accepted only from an issuer on this machine: a local identity provider in
// development and the e2e rig's stub. Anything reachable over a network has to be https.
function isLoopback(issuer: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
}

function configFor(provider: OidcProvider): Promise<client.Configuration> {
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
  intent: "signin" | "invite";
  invitationToken?: string;
}): Promise<{ url: string; binder: string }> {
  const config = await configFor(input.provider);
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
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
    expiresAt: new Date(Date.now() + FLOW_TTL_MS),
  });

  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(input.provider, input.origin),
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url: url.href, binder };
}

export interface VerifiedClaims {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export type FlowOutcome =
  | { ok: true; intent: "signin" | "invite"; invitationTokenHash: string | null; claims: VerifiedClaims }
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
    const tokens = await client.authorizationCodeGrant(
      config,
      new URL(`${redirectUri(input.provider, input.origin)}${input.query}`),
      {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      }
    );
    const claims = tokens.claims();
    if (!claims?.sub) return { ok: false, reason: "rejected" };
    return {
      ok: true,
      intent: flow.intent,
      invitationTokenHash: flow.invitationTokenHash,
      claims: {
        subject: String(claims.sub),
        email: typeof claims.email === "string" ? normaliseEmail(claims.email) : "",
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === "string" ? claims.name : "",
      },
    };
  } catch (err) {
    console.error(`OIDC callback from ${input.provider.id} refused:`, err);
    return { ok: false, reason: "rejected" };
  }
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
    claims: { subject: input.claims.subject, email: input.claims.email },
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
