import { Types } from "mongoose";
import { connectDB } from "./db";
import { DEFAULT_ORGANISATION_ID } from "./organisation-field";
import { Organisation } from "@/models/organisation";
import { selfOrigin } from "./session";
import type { ScopedDb } from "./db-scope";

export const RESERVED_SLUGS = [
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "cdn",
  "docs",
  "help",
  "login",
  "mail",
  "smtp",
  "static",
  "status",
  "support",
  "www",
];

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

export const isSlug = (label: string): boolean => SLUG_PATTERN.test(label) && label.slice(2, 4) !== "--";

export const SLUG_CACHE_LIMIT = 1_000;

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > SLUG_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function organisationDomain(): string | null {
  const value = process.env.ORGANISATION_DOMAIN?.trim().toLowerCase();
  return value ? value : null;
}

export function assertOrganisationDomainConfig(): void {
  const domain = organisationDomain();
  if (domain !== null && !DOMAIN_PATTERN.test(domain)) {
    throw new Error(
      `ORGANISATION_DOMAIN must be a bare domain such as board-planner.com, with no scheme, port or path; got "${process.env.ORGANISATION_DOMAIN}"`
    );
  }
  if (domain !== null && process.env.OIDC_ADMIN_GROUP?.trim()) {
    throw new Error(
      "OIDC_ADMIN_GROUP cannot be set with ORGANISATION_DOMAIN: one identity provider's group would make its members administrators of every organisation on the instance"
    );
  }
}

export type HostKind = { kind: "organisation"; slug: string } | { kind: "platform" } | { kind: "unknown" };

export function classifyHost(host: string | null, domain: string): HostKind {
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (name === domain) return { kind: "platform" };
  if (!name.endsWith(`.${domain}`)) return { kind: "unknown" };
  const label = name.slice(0, -domain.length - 1);
  if (RESERVED_SLUGS.includes(label)) return { kind: "platform" };
  return isSlug(label) ? { kind: "organisation", slug: label } : { kind: "unknown" };
}

const SLUG_CACHE_MS = 30_000;
const slugCache = new Map<string, { organisation: Types.ObjectId | null; at: number }>();

async function organisationWithSlug(slug: string): Promise<Types.ObjectId | null> {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.at < SLUG_CACHE_MS) return cached.organisation;
  await connectDB();
  const found = await Organisation.findOne({ slug }).select("_id").lean();
  const organisation = found ? found._id : null;
  remember(slugCache, slug, { organisation, at: Date.now() });
  return organisation;
}

const slugOfOrganisationCache = new Map<string, { slug: string | null; at: number }>();

async function slugOfOrganisation(organisation: Types.ObjectId): Promise<string | null> {
  const key = organisation.toHexString();
  const cached = slugOfOrganisationCache.get(key);
  if (cached && Date.now() - cached.at < SLUG_CACHE_MS) return cached.slug;
  await connectDB();
  const found = await Organisation.findById(organisation).select("slug").lean();
  const slug = found?.slug ?? null;
  remember(slugOfOrganisationCache, key, { slug, at: Date.now() });
  return slug;
}

export function forgetOrganisationSlugs(): void {
  slugCache.clear();
  slugOfOrganisationCache.clear();
}

export async function organisationOrigin(organisation: Types.ObjectId): Promise<string | null> {
  const domain = organisationDomain();
  if (!domain) return selfOrigin();
  const slug = await slugOfOrganisation(organisation);
  if (!slug) return null;
  const host = `${slug}.${domain}`;
  const routesBack = classifyHost(host, domain);
  if (routesBack.kind !== "organisation" || routesBack.slug !== slug) return null;
  return `${platformScheme(domain)}//${host}${platformPort(domain)}`;
}

function platformUrl(domain: string): URL | null {
  const platform = selfOrigin();
  if (!platform) return null;
  const url = new URL(platform);
  return url.hostname === domain || url.hostname.endsWith(`.${domain}`) ? url : null;
}

const platformScheme = (domain: string) => platformUrl(domain)?.protocol ?? "https:";
const platformPort = (domain: string) => {
  const port = platformUrl(domain)?.port;
  return port ? `:${port}` : "";
};

export const originFor = (db: ScopedDb): Promise<string | null> => organisationOrigin(db.organisation);

export type RequestOrganisation = { kind: "organisation"; organisation: Types.ObjectId } | { kind: "platform" } | { kind: "none" };

export async function organisationOfRequest(request: Request): Promise<RequestOrganisation> {
  const domain = organisationDomain();
  if (!domain) return { kind: "organisation", organisation: DEFAULT_ORGANISATION_ID };
  const host = classifyHost(request.headers.get("host"), domain);
  if (host.kind === "platform") return { kind: "platform" };
  if (host.kind === "unknown") return { kind: "none" };
  const organisation = await organisationWithSlug(host.slug);
  return organisation ? { kind: "organisation", organisation } : { kind: "none" };
}
