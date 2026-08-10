import mongoose, { Schema, Model } from "mongoose";
import { IInstanceAuditLog, INSTANCE_AUDIT_ACTIONS } from "@/types";

// The layer above projectAuditLog, for the actions that belong to no project. BP-232 removed
// stored worker assignments, and the audit call that hung off them went too — so stopping a machine
// became a thing nobody could prove had happened.
const instanceAuditLogSchema = new Schema<IInstanceAuditLog>(
  {
    // Optional, unlike the project log's: a worker spends its enrolment token during registration,
    // where the caller is a machine with no session. An entry nobody can attribute is still worth
    // more than no entry, and `target` names what was acted on either way.
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    action: {
      type: String,
      enum: INSTANCE_AUDIT_ACTIONS,
      required: true,
    },
    // Denormalised on purpose. A worker deleted a month later must not turn its own history into
    // rows naming nothing, and this log outliving its subjects is the whole point of keeping it.
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
