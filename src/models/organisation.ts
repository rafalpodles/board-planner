import mongoose, { Schema, Model } from "mongoose";
import { Plan } from "@/lib/entitlements";

export type EntitlementSource = "none" | "env" | "service";

export interface IOrganisationEntitlements {
  plan: Plan;
  features: string[];
  customer?: string;
  issuedAt?: Date;
  expiresAt?: Date;
  trial?: boolean;
  subscription?: "renewing" | "ending";
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
  suspendedAt?: Date | null;
  suspendedReason?: string;
  // The operator switched off what this organisation may spend of the operator's AI key; its own key is not touched (BP-680)
  aiLockedAt?: Date | null;
  aiLockedReason?: string;
  deletedAt?: Date | null;
  deletingAt?: Date | null;
  // When the admins were told the organisation will be deleted for want of anybody signing in (BP-674)
  deadNoticeAt?: Date | null;
  // Held while a process is sending the notice, so two do not; it never counts as the notice having gone out
  deadNoticeClaimedAt?: Date | null;
  // When the admins were reminded, a week before the deletion; once per notice (BP-999)
  deadReminderAt?: Date | null;
  // The people count last told to the licence service, so only a change is told again (BP-949)
  memberSync?: { members: number; at: Date } | null;
  // The operator's own figure for what this organisation may spend of the operator's key, in place of its plan's, for the
  // counter it was set on (a trial's, or the month's); tokens null is no limit at all (BP-678)
  aiAllowance?: { tokens: number | null; scope: "trial" | "month" } | null;
}

const entitlementsSchema = new Schema<IOrganisationEntitlements>(
  {
    plan: { type: String, enum: ["free", "pro"], default: "free" },
    features: { type: [String], default: [] },
    customer: { type: String },
    issuedAt: { type: Date },
    expiresAt: { type: Date },
    trial: { type: Boolean },
    subscription: { type: String, enum: ["renewing", "ending"] },
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
  suspendedAt: { type: Date, default: null },
  suspendedReason: { type: String, default: "" },
  aiLockedAt: { type: Date, default: null },
  aiLockedReason: { type: String, default: "" },
  deletedAt: { type: Date, default: null },
  deletingAt: { type: Date, default: null },
  deadNoticeAt: { type: Date, default: null },
  deadNoticeClaimedAt: { type: Date, default: null },
  deadReminderAt: { type: Date, default: null },
  aiAllowance: {
    type: new Schema({ tokens: { type: Number, min: 1, default: null }, scope: { type: String, enum: ["trial", "month"], required: true } }, { _id: false }),
    default: null,
  },
  memberSync: { type: new Schema({ members: { type: Number, required: true, min: 0 }, at: { type: Date, required: true } }, { _id: false }), default: null },
  entitlements: {
    type: entitlementsSchema,
    default: () => ({ plan: "free", features: [], source: "none" }),
  },
});

organisationSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string" } } });

export const Organisation: Model<IOrganisation> =
  mongoose.models.Organisation || mongoose.model<IOrganisation>("Organisation", organisationSchema);
