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
  entitlements: {
    type: entitlementsSchema,
    default: () => ({ plan: "free", features: [], source: "none" }),
  },
});

export const Tenant: Model<ITenant> =
  mongoose.models.Tenant || mongoose.model<ITenant>("Tenant", tenantSchema);
