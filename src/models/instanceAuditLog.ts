import mongoose, { Schema, Model } from "mongoose";
import { IInstanceAuditLog, INSTANCE_AUDIT_ACTIONS } from "@/types";

const instanceAuditLogSchema = new Schema<IInstanceAuditLog>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    actorUsername: {
      type: String,
      default: "",
    },
    action: {
      type: String,
      enum: INSTANCE_AUDIT_ACTIONS,
      required: true,
    },
    target: {
      type: String,
      default: "",
    },
    detail: {
      type: String,
      default: "",
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

instanceAuditLogSchema.index({ createdAt: -1 });

export const InstanceAuditLog: Model<IInstanceAuditLog> =
  mongoose.models.InstanceAuditLog ||
  mongoose.model<IInstanceAuditLog>("InstanceAuditLog", instanceAuditLogSchema);
