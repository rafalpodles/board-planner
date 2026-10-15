import mongoose, { Schema, Model } from "mongoose";
import { IProjectAuditLog, PROJECT_AUDIT_ACTIONS } from "@/types";
import { withOrganisation } from "@/lib/organisation-field";

const projectAuditLogSchema = new Schema<IProjectAuditLog>(
  {
    project: {
      type: Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    action: {
      type: String,
      enum: PROJECT_AUDIT_ACTIONS,
      required: true,
    },
    detail: {
      type: String,
      default: "",
    },
    lines: {
      type: [String],
      default: undefined,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

projectAuditLogSchema.index({ project: 1, createdAt: -1, _id: -1 });
projectAuditLogSchema.index({ project: 1, action: 1, createdAt: -1, _id: -1 });

withOrganisation(projectAuditLogSchema);

export const ProjectAuditLog: Model<IProjectAuditLog> =
  mongoose.models.ProjectAuditLog ||
  mongoose.model<IProjectAuditLog>("ProjectAuditLog", projectAuditLogSchema);
