import { cache } from "react";
import { connectDB } from "./db";
import { Tenant, ITenant } from "@/models/tenant";

// Same idea as connectDB's cache, one layer up: within a single request, every caller shares
// one read instead of each paying its own round trip. React's cache() only dedupes inside a
// request's render/handler lifecycle — a fresh request (or a plain function call outside one,
// as in a unit test) always reads through.
export const getTenant = cache(async (): Promise<ITenant> => {
  await connectDB();
  return Tenant.findOneAndUpdate(
    {},
    { $setOnInsert: { entitlements: { plan: "free", features: [], source: "none" } } },
    { upsert: true, returnDocument: "after" }
  ) as Promise<ITenant>;
});
