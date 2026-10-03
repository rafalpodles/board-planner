import { cache } from "react";
import { connectDB } from "./db";
import { Tenant, ITenant } from "@/models/tenant";
import { upsertSingleton } from "./singleton";
import { DEFAULT_TENANT_ID } from "./tenant-field";
import { currentLicence, entitlementsFromLicence } from "./licence";

// React's cache() only dedupes calls made during a Server Component render — confirmed against
// this app's own Next config (Route Handlers run the handler as a plain function, with no render
// dispatcher active), so every call from here today — Route Handlers only — still pays its own
// query; a future Server Component reading tenant/plan data would share one.
// Kept anyway: it costs nothing where it doesn't apply, and is correct where it does.
export const getTenant = cache(async (): Promise<ITenant> => {
  await connectDB();
  const stored = await upsertSingleton(
    Tenant,
    { $setOnInsert: { entitlements: { plan: "free", features: [], source: "none" } } },
    { _id: DEFAULT_TENANT_ID }
  );
  // Derived on every read and never written back, so removing the key is all it takes to undo it
  const fromLicence = entitlementsFromLicence(currentLicence());
  return fromLicence ? { _id: stored._id, entitlements: fromLicence } : stored;
});
