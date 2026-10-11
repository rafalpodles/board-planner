import { githubWebBase } from "@/lib/github-host";
import { can } from "@/lib/entitlements";
import { decryptSecret } from "@/lib/encryption";
import { getOrganisation } from "@/lib/organisation";
import { organisationDomain } from "@/lib/organisation-host";
import type { ScopedDb } from "@/lib/db-scope";
import type { ISettings } from "@/models/settings";

export type OidcProviderId = "oidc" | "google" | "github";

export interface OidcProvider {
  id: OidcProviderId;
  /** GitHub speaks OAuth 2 without OpenID Connect: no discovery, no ID token, the person from its API. */
  kind: "oidc" | "github";
  /**
   * Whether a first sign-in may link to the account holding the address the provider verified.
   * GitHub's `verified` is a click on a link, once, years ago, by whoever held the mailbox then —
   * it speaks for no domain, so a GitHub identity is linked from Settings or by an invitation only.
   */
  linksByAddress: boolean;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Set by an organisation's admin, so every request to it goes through the guard against internal addresses (BP-951). */
  own?: true;
  /** An organisation's own provider: the group that makes its members administrators at sign-in, and the ID token claim that names groups. */
  adminGroup?: string;
  groupsClaim?: string;
}

/**
 * Links a configured provider can still sign in through: its id, and the issuer it signs as now.
 * Repointing a provider orphans the old issuer's links, so they are no way in and must not count
 * as one. Matches nothing when no provider is configured.
 */
export function liveIdentityFilter(providers: OidcProvider[] = configuredProviders()): Record<string, unknown> {
  const live = providers.map((p) => ({ provider: p.id, issuer: { $in: issuerSpellings(p.issuer) } }));
  // An `$or` either way, so spreading it never overwrites a caller's own `_id`
  return { $or: live.length > 0 ? live : [{ _id: null }] };
}

/** As configured, and as a URL parser writes it (host case, a default port), each with and without a trailing slash. */
function issuerSpellings(issuer: string): string[] {
  const forms = new Set<string>();
  for (const form of [issuer, canonical(issuer)]) {
    const bare = form.replace(/\/+$/, "");
    forms.add(bare).add(`${bare}/`);
  }
  return [...forms];
}

function canonical(issuer: string): string {
  try {
    return new URL(issuer).href;
  } catch {
    return issuer;
  }
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
      linksByAddress: true,
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
      linksByAddress: true,
      label: "Google",
      issuer: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
    });
  }
  const { GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET } = process.env;
  const site = GITHUB_OAUTH_CLIENT_ID && GITHUB_OAUTH_CLIENT_SECRET ? githubSignInSite() : null;
  if (site) {
    providers.push({
      id: "github",
      kind: "github",
      linksByAddress: false,
      label: "GitHub",
      issuer: site,
      clientId: GITHUB_OAUTH_CLIENT_ID!,
      clientSecret: GITHUB_OAUTH_CLIENT_SECRET!,
    });
  }
  return providers;
}

/**
 * Where GitHub's sign-in pages are: derived from `GITHUB_API_BASE_URL` as pull-request links are,
 * unless `GITHUB_OAUTH_BASE_URL` names it — an Enterprise Server whose API is reached through a
 * proxy, from which no site address can be derived. A value that is not a bare https origin (or
 * http on this machine) turns GitHub sign-in off rather than quietly sending it somewhere else.
 */
let warnedAbout: string | null = null;

function githubSignInSite(): string | null {
  const named = process.env.GITHUB_OAUTH_BASE_URL?.trim() || githubWebBase();
  let url: URL | null = null;
  try {
    url = new URL(named);
  } catch {}
  const loopback = url && ["127.0.0.1", "[::1]"].includes(url.hostname);
  const bare = url && url.pathname.replace(/\/+$/, "") === "" && !url.search;
  if (url && bare && (url.protocol === "https:" || (url.protocol === "http:" && loopback))) return url.origin;
  if (warnedAbout !== named) {
    warnedAbout = named;
    console.warn(`GitHub's site ${url ? url.origin : "(not a URL)"} is not a bare https origin; signing in with GitHub is off`);
  }
  return null;
}

export function providerById(id: string): OidcProvider | null {
  return configuredProviders().find((p) => p.id === id) ?? null;
}

/** Google or GitHub, which the operator set up but this organisation is not offered: its administrators switched it off, or it requires its own sign-in. */
export function setUpButNotOffered(id: string): boolean {
  return SWITCHABLE_PROVIDERS.includes(id as OidcProviderId) && providerById(id) !== null;
}

export function publicProviders(): { id: OidcProviderId; label: string }[] {
  return configuredProviders().map(({ id, label }) => ({ id, label }));
}

/**
 * The organisation's own provider, while its plan includes one: the configuration is kept when the plan ends and
 * comes back with the next one, so nothing is lost to a lapse. Null when none is stored, the plan does not include
 * it, or the secret is sealed under a key this server no longer has.
 */
const warnedUnreadable = new Set<string>();

async function organisationSso(db: ScopedDb, stored?: Pick<ISettings, "sso"> | null): Promise<{ provider: OidcProvider; enforced: boolean } | null> {
  const sso = (stored === undefined ? await db.Settings.findOne({}, "sso").lean() : stored)?.sso;
  if (!sso) return null;
  if (!can(await getOrganisation(db.organisation), "identity.sso")) return null;
  let clientSecret: string;
  try {
    clientSecret = decryptSecret(sso.clientSecret, db.organisation);
  } catch {
    if (!warnedUnreadable.has(String(db.organisation))) {
      warnedUnreadable.add(String(db.organisation));
      console.warn(`An organisation's sign-in provider secret cannot be read, so it is not offered (${db.organisation})`);
    }
    return null;
  }
  const provider: OidcProvider = { id: "oidc", kind: "oidc", linksByAddress: true, label: sso.label || "Single sign-on", issuer: sso.issuer, clientId: sso.clientId, clientSecret, own: true, adminGroup: sso.adminGroup || undefined, groupsClaim: sso.groupsClaim || undefined };
  return { provider, enforced: sso.enforced === true };
}

async function organisationProvider(db: ScopedDb): Promise<OidcProvider | null> {
  return (await organisationSso(db))?.provider ?? null;
}

/**
 * Whether this organisation has closed every other way in. Only while its own provider is offered, so a plan that
 * ends or a secret that cannot be read never leaves a requirement nobody can meet.
 */
export async function ssoEnforced(db: ScopedDb): Promise<boolean> {
  if (organisationDomain() === null) return false;
  return (await organisationSso(db))?.enforced === true;
}

/**
 * What the host a request arrived on offers. Where one organisation is the whole instance that is the
 * operator's environment. In the cloud the environment's generic provider is every organisation's at once and so
 * nobody's: only Google and GitHub are shared, and the generic one is the organisation's own.
 */
export async function providersFor(db: ScopedDb): Promise<OidcProvider[]> {
  if (organisationDomain() === null) return sharedProviders();
  const stored = await db.Settings.findOne({}, "sso disabledProviders").lean();
  const sso = await organisationSso(db, stored);
  if (sso?.enforced) return [sso.provider];
  const off = new Set(stored?.disabledProviders ?? []);
  const shared = sharedProviders().filter((p) => !off.has(p.id));
  return sso ? [...shared, sso.provider] : shared;
}

/** The shared providers an organisation's administrators may switch off for it: the operator's, never the organisation's own. */
export const SWITCHABLE_PROVIDERS: readonly OidcProviderId[] = ["google", "github"];

/** What every organisation of the instance is offered: the environment's providers, less the generic one in the cloud, where it would be nobody's in particular. */
export function sharedProviders(): OidcProvider[] {
  return organisationDomain() === null ? configuredProviders() : configuredProviders().filter((p) => p.id !== "oidc");
}

export async function providerFor(db: ScopedDb, id: string): Promise<OidcProvider | null> {
  return (await providersFor(db)).find((p) => p.id === id) ?? null;
}

export async function publicProvidersFor(db: ScopedDb): Promise<{ id: OidcProviderId; label: string }[]> {
  return (await providersFor(db)).map(({ id, label }) => ({ id, label }));
}

export async function liveIdentityFilterFor(db: ScopedDb): Promise<Record<string, unknown>> {
  return liveIdentityFilter(await providersFor(db));
}
