import mongoose, { Schema, Model } from "mongoose";
import { Plan } from "@/lib/entitlements";

export type EntitlementSource = "none" | "env" | "service";

export interface IOrganisationEntitlements {
  plan: Plan;
  features: string[];
  customer?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  source: EntitlementSource;
}

export interface IOrganisation {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug?: string;
  digestHour?: number;
  timezone?: string;
  licenceKey?: string;
  entitlements: IOrganisationEntitlements;
}

const entitlementsSchema = new Schema<IOrganisationEntitlements>(
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

const organisationSchema = new Schema<IOrganisation>({
  name: { type: String, default: "default", trim: true },
  slug: { type: String, trim: true, lowercase: true },
  digestHour: { type: Number, min: 0, max: 23 },
  timezone: { type: String, trim: true },
  licenceKey: { type: String },
  entitlements: {
    type: entitlementsSchema,
    default: () => ({ plan: "free", features: [], source: "none" }),
  },
});

organisationSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string" } } });

export const Organisation: Model<IOrganisation> =
  mongoose.models.Organisation || mongoose.model<IOrganisation>("Organisation", organisationSchema);
