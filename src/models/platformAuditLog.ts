import mongoose, { Schema, Model } from "mongoose";

export const PLATFORM_AUDIT_ACTIONS = [
  "licence_stored",
  "organisations_listed",
  "organisation_suspended",
  "organisation_resumed",
  "organisation_ai_locked",
  "organisation_ai_unlocked",
  "organisation_delete_started",
  "organisation_deleted",
  "organisation_exported",
  "organisation_dead_noticed",
  "organisation_dead_reminded",
  "organisation_dead_cleared",
  "ai_allowance_set",
  "ai_allowance_cleared",
] as const;
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export interface IPlatformAuditLog {
  _id: mongoose.Types.ObjectId;
  action: PlatformAuditAction;
  keyId: string;
  subject: mongoose.Types.ObjectId | null;
  detail: string;
  createdAt: Date;
}

const platformAuditLogSchema = new Schema<IPlatformAuditLog>(
  {
    action: { type: String, enum: PLATFORM_AUDIT_ACTIONS, required: true },
    keyId: { type: String, required: true },
    subject: { type: Schema.Types.ObjectId, default: null },
    detail: { type: String, default: "" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const PlatformAuditLog: Model<IPlatformAuditLog> =
  mongoose.models.PlatformAuditLog || mongoose.model<IPlatformAuditLog>("PlatformAuditLog", platformAuditLogSchema);
