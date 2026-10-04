import mongoose, { Schema, Model } from "mongoose";
import { Plan } from "@/lib/entitlements";

export type EntitlementSource = "none" | "env" | "service";

export interface ITenantEntitlements {
  plan: Plan;
  features: string[];
  customer?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  source: EntitlementSource;
}

export interface ITenant {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug?: string;
  entitlements: ITenantEntitlements;
}

const entitlementsSchema = new Schema<ITenantEntitlements>(
  {
    plan: { type: String, enum: ["free", "pro"], default: "free" },
    features: { type: [String], default: [] },
    customer: { type: String },
    issuedAt: { type: Date },
    expiresAt: { type: Date },
    source: { type: String, enum: ["none", "env", "service"], default: "none" },
  },
  { _id: false }
);

const tenantSchema = new Schema<ITenant>({
  name: { type: String, default: "default", trim: true },
  slug: { type: String, trim: true, lowercase: true },
  entitlements: {
    type: entitlementsSchema,
    default: () => ({ plan: "free", features: [], source: "none" }),
  },
});

tenantSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string" } } });

export const Tenant: Model<ITenant> =
  mongoose.models.Tenant || mongoose.model<ITenant>("Tenant", tenantSchema);
