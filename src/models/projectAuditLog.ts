import mongoose, { Schema, Model } from "mongoose";
import { IProjectAuditLog } from "@/types";

const ACTIONS = [
  "settings_updated",
  "component_added",
  "component_removed",
  "label_added",
  "label_removed",
  "template_added",
  "template_removed",
  "template_updated",
  "member_added",
  "member_removed",
  "task_created",
  "task_deleted",
  "bulk_delete",
  "bulk_move",
];

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
      enum: ACTIONS,
      required: true,
    },
    detail: {
      type: String,
      default: "",
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

projectAuditLogSchema.index({ project: 1, createdAt: -1 });

export const ProjectAuditLog: Model<IProjectAuditLog> =
  mongoose.models.ProjectAuditLog ||
  mongoose.model<IProjectAuditLog>("ProjectAuditLog", projectAuditLogSchema);
