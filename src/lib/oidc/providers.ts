export type OidcProviderId = "oidc" | "google";

export interface OidcProvider {
  id: OidcProviderId;
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
      label: "Google",
      issuer: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    });
  }
  return providers;
}

export function providerById(id: string): OidcProvider | null {
  return configuredProviders().find((p) => p.id === id) ?? null;
}

export function publicProviders(): { id: OidcProviderId; label: string }[] {
  return configuredProviders().map(({ id, label }) => ({ id, label }));
}
