import type { Types } from "mongoose";
import { connectDB } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant-field";
import { scoped, type ScopedDb } from "./db-scope";
import { tenantDomain } from "./tenant-host";
import { Tenant } from "@/models/tenant";

export type ServedTenant = { _id: Types.ObjectId; digestHour?: number; timezone?: string };

export async function servedTenants(): Promise<ServedTenant[]> {
  await connectDB();
  const single = !tenantDomain();
  const rows = await Tenant.find(single ? { _id: DEFAULT_TENANT_ID } : {})
    .select("digestHour timezone")
    .lean<ServedTenant[]>();
  return single && rows.length === 0 ? [{ _id: DEFAULT_TENANT_ID }] : rows;
}

export async function forEachServedTenant(
  job: string,
  work: (db: ScopedDb, tenant: ServedTenant) => Promise<void>
): Promise<void> {
  for (const tenant of await servedTenants()) {
    try {
      await work(scoped(tenant._id), tenant);
    } catch (err) {
      console.error(`${job} failed for tenant ${tenant._id.toHexString()}:`, err);
    }
  }
}

