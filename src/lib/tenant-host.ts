import { Types } from "mongoose";
import { connectDB } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant-field";
import { Tenant } from "@/models/tenant";
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

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function tenantDomain(): string | null {
  const value = process.env.TENANT_DOMAIN?.trim().toLowerCase();
  return value ? value : null;
}

export function assertTenantDomainConfig(): void {
  const domain = tenantDomain();
  if (domain !== null && !DOMAIN_PATTERN.test(domain)) {
    throw new Error(
      `TENANT_DOMAIN must be a bare domain such as board-planner.com, with no scheme, port or path; got "${process.env.TENANT_DOMAIN}"`
    );
  }
}

export type HostKind = { kind: "tenant"; slug: string } | { kind: "platform" } | { kind: "unknown" };

export function classifyHost(host: string | null, domain: string): HostKind {
  const name = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (name === domain) return { kind: "platform" };
  if (!name.endsWith(`.${domain}`)) return { kind: "unknown" };
  const label = name.slice(0, -domain.length - 1);
  if (RESERVED_SLUGS.includes(label)) return { kind: "platform" };
  return SLUG_PATTERN.test(label) ? { kind: "tenant", slug: label } : { kind: "unknown" };
}

const SLUG_CACHE_MS = 30_000;
const slugCache = new Map<string, { tenant: Types.ObjectId | null; at: number }>();

async function tenantWithSlug(slug: string): Promise<Types.ObjectId | null> {
  const cached = slugCache.get(slug);
  if (cached && Date.now() - cached.at < SLUG_CACHE_MS) return cached.tenant;
  await connectDB();
  const found = await Tenant.findOne({ slug }).select("_id").lean();
  const tenant = found ? found._id : null;
  slugCache.set(slug, { tenant, at: Date.now() });
  return tenant;
}

const slugOfTenantCache = new Map<string, { slug: string | null; at: number }>();

async function slugOfTenant(tenant: Types.ObjectId): Promise<string | null> {
  const key = tenant.toHexString();
  const cached = slugOfTenantCache.get(key);
  if (cached && Date.now() - cached.at < SLUG_CACHE_MS) return cached.slug;
  await connectDB();
  const found = await Tenant.findById(tenant).select("slug").lean();
  const slug = found?.slug ?? null;
  slugOfTenantCache.set(key, { slug, at: Date.now() });
  return slug;
}

export function forgetTenantSlugs(): void {
  slugCache.clear();
  slugOfTenantCache.clear();
}

export async function tenantOrigin(tenant: Types.ObjectId): Promise<string | null> {
  const domain = tenantDomain();
  if (!domain) return selfOrigin();
  const slug = await slugOfTenant(tenant);
  if (!slug) return null;
  const host = `${slug}.${domain}`;
  const routesBack = classifyHost(host, domain);
  return routesBack.kind === "tenant" && routesBack.slug === slug ? `https://${host}` : null;
}

export const originFor = (db: ScopedDb): Promise<string | null> => tenantOrigin(db.tenant);

export type RequestTenant = { kind: "tenant"; tenant: Types.ObjectId } | { kind: "platform" } | { kind: "none" };

export async function tenantOfRequest(request: Request): Promise<RequestTenant> {
  const domain = tenantDomain();
  if (!domain) return { kind: "tenant", tenant: DEFAULT_TENANT_ID };
  const host = classifyHost(request.headers.get("host"), domain);
  if (host.kind === "platform") return { kind: "platform" };
  if (host.kind === "unknown") return { kind: "none" };
  const tenant = await tenantWithSlug(host.slug);
  return tenant ? { kind: "tenant", tenant } : { kind: "none" };
}
