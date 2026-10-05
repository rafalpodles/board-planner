import mongoose, { Schema, Model } from "mongoose";

export const PLATFORM_AUDIT_ACTIONS = ["licence_stored", "organisations_listed"] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export interface IPlatformAuditLog {
  _id: mongoose.Types.ObjectId;
  action: PlatformAuditAction;
  // The platform request key that signed the call: the operator, who has no account here
  keyId: string;
  // The organisation acted on, when there is one. Not `organisation`: this log belongs to none
  subject: mongoose.Types.ObjectId | null;
  detail: string;
  createdAt: Date;
}

// Outside every organisation, like Organisation itself: the operator's actions on the platform
const platformAuditLogSchema = new Schema<IPlatformAuditLog>(
  {
    action: { type: String, enum: PLATFORM_AUDIT_ACTIONS, required: true },
    keyId: { type: String, required: true },
    subject: { type: Schema.Types.ObjectId, default: null },
    detail: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

platformAuditLogSchema.index({ subject: 1, _id: -1 });

export const PlatformAuditLog: Model<IPlatformAuditLog> =
  mongoose.models.PlatformAuditLog || mongoose.model<IPlatformAuditLog>("PlatformAuditLog", platformAuditLogSchema);
