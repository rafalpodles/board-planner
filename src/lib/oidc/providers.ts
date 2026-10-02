import { githubWebBase } from "@/lib/github-host";

export type OidcProviderId = "oidc" | "google" | "github";

export interface OidcProvider {
  id: OidcProviderId;
  /** GitHub speaks OAuth 2 without OpenID Connect: no discovery, no ID token, the person from its API. */
  kind: "oidc" | "github";
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

const GOOGLE_ISSUER = "https://accounts.google.com";

/** Read on every call, so the operator's environment is the only source and tests can set it. */
export function configuredProviders(): OidcProvider[] {
  const providers: OidcProvider[] = [];
  const { OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_LABEL } = process.env;
  if (OIDC_ISSUER && OIDC_CLIENT_ID && OIDC_CLIENT_SECRET) {
    providers.push({
      id: "oidc",
      kind: "oidc",
      label: OIDC_LABEL?.trim() || "Single sign-on",
      issuer: OIDC_ISSUER.trim(),
      clientId: OIDC_CLIENT_ID,
      clientSecret: OIDC_CLIENT_SECRET,
    });
  }
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    providers.push({
      id: "google",
      kind: "oidc",
      label: "Google",
      issuer: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    });
  }
  const { GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET } = process.env;
  if (GITHUB_OAUTH_CLIENT_ID && GITHUB_OAUTH_CLIENT_SECRET) {
    providers.push({
      id: "github",
      kind: "github",
      label: "GitHub",
      issuer: githubSignInBase(),
      clientId: GITHUB_OAUTH_CLIENT_ID,
      clientSecret: GITHUB_OAUTH_CLIENT_SECRET,
    });
  }
  return providers;
}

/**
 * Where GitHub's sign-in pages are: derived from `GITHUB_API_BASE_URL` as pull-request links are,
 * unless `GITHUB_OAUTH_BASE_URL` names it — an Enterprise Server whose API is reached through a
 * proxy, from which no site address can be derived.
 */
function githubSignInBase(): string {
  const named = process.env.GITHUB_OAUTH_BASE_URL?.trim();
  if (named) {
    try {
      return new URL(named).origin;
    } catch {
      console.warn("GITHUB_OAUTH_BASE_URL is not a URL; signing in with GitHub uses the derived address");
    }
  }
  return githubWebBase();
}

export function providerById(id: string): OidcProvider | null {
  return configuredProviders().find((p) => p.id === id) ?? null;
}

export function publicProviders(): { id: OidcProviderId; label: string }[] {
  return configuredProviders().map(({ id, label }) => ({ id, label }));
}
